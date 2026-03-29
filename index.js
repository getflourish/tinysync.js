/**
 * SyncClient — minimal client for sync.php
 *
 * Usage (wrapped mode, default):
 *   const sync = new SyncClient('https://you.com/sync.php', 'your-token');
 *   const unsub = sync.subscribe('notes', (records) => render(records));
 *   await sync.push('notes', { id: 'abc', data: { text: 'hello' } });
 *   await sync.delete('notes', 'abc');
 *   unsub();
 *
 * Usage with IndexedDB persistence (survives page reloads, only syncs deltas):
 *   const sync = new SyncClient('https://you.com/sync.php', 'your-token', { persist: true });
 *   // Default IDB name is tinysync_<hostname>, e.g. tinysync_sync.getflourish.com
 *   // Override: { persist: true, idbName: 'tinysync_custom' }
 *
 * Usage (flat mode — for apps with a flat SQL schema):
 *   const unsub = sync.subscribe('todos', (records) => render(records), { flat: true });
 *   await sync.push('todos', { id: 'abc', content: 'Buy milk', completed: 0, ... }, { flat: true });
 *
 *   In flat mode:
 *   - push() accepts plain objects; fields are stored as-is (no `data` wrapper needed)
 *   - Records with a non-empty `deleted_at` field are automatically marked as deleted
 *   - Subscription callbacks receive flat objects: { id, content, completed, ... }
 *   - Soft-deleted records (deleted_at set) are kept in the store so the app can
 *     process the deletion locally; hard-deleted records are removed from the store
 */

export class SyncClient {
  #url;
  #token;
  #authUrl;
  #persist;
  #revisions      = {};  // collection → last known rev
  #sources        = {};  // collection → EventSource
  #handlers       = {};  // collection → Set of callbacks
  #store          = {};  // collection → Map of id → record (in-memory cache)
  #collectionOpts = {};  // collection → { flat: bool }
  #db             = null;
  #initPromises   = {};  // collection → Promise (IDB load in progress)
  /** Record IDs currently being edited — incoming SSE deltas for these IDs are skipped. */
  #editing        = new Set();
  /** Short-lived session token used in SSE URLs. */
  #session        = null;  // { token, expiresAt }
  #refreshTimer   = null;
  /** IndexedDB name — one per sync host (or explicit idbName) so backends stay isolated. */
  #idbName;

  constructor(url, token, { persist = false, authUrl = null, idbName = null } = {}) {
    this.#url     = url.replace(/\/$/, '');
    this.#token   = token;
    this.#persist = persist;
    this.#authUrl = authUrl ?? (new URL(this.#url).pathname.length > 1
      ? this.#url.replace(/\/[^/]+$/, '/auth')  // has path: swap last segment
      : this.#url + '/auth');                   // bare domain: append /auth
    let host = 'local';
    try {
      host = new URL(this.#url).hostname || host;
    } catch {
      /* invalid URL — #idbName still valid for explicit idbName */
    }
    this.#idbName = idbName ?? `tinysync_${host}`;
  }

  // ── Subscribe ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to live updates for a collection.
   * Callback receives the full current record map (id → record).
   * Options: { flat: true } — enable flat record mode for this collection.
   * Returns an unsubscribe function.
   */
  subscribe(collection, callback, options = {}) {
    if (options.flat !== undefined) this.#collectionOpts[collection] = options;

    if (!this.#handlers[collection]) this.#handlers[collection] = new Set();
    if (!this.#store[collection])    this.#store[collection]    = new Map();

    this.#handlers[collection].add(callback);

    if (this.#persist) {
      // Load IDB cache first, then open SSE with the persisted rev.
      // SSE is NOT opened here — #initCollection opens it after IDB is ready.
      this.#initCollection(collection);
    } else if (!this.#sources[collection]) {
      this.#openSSE(collection);
    }

    // Immediately emit current cache (may be empty before IDB loads)
    callback(Object.fromEntries(this.#store[collection]));

    return () => {
      this.#handlers[collection].delete(callback);
      if (this.#handlers[collection].size === 0) this.#closeSSE(collection);
    };
  }

  // ── Push / Delete ─────────────────────────────────────────────────────────

  /**
   * Push one or more records to a collection.
   * Options: { flat: true } — records are flat objects (no `data` wrapper).
   * If options.flat is omitted, falls back to the flat setting registered via subscribe().
   */
  async push(collection, record, options = {}) {
    const flat    = options.flat ?? this.#collectionOpts[collection]?.flat ?? false;
    const records = Array.isArray(record) ? record : [record];
    const payload = flat ? records.map(r => this.#wrapRecord(r)) : records;
    // Optimistic update: merge into local cache and emit before server round-trip.
    this.#mergePushIntoStore(collection, payload, flat, null);
    const res = await this.#fetch('POST', collection, payload);
    // Update revision cursor from server response so SSE delta tracking stays accurate.
    if (res?.rev) this.#revisions[collection] = Math.max(this.#revisions[collection] ?? 0, res.rev);
    return res;
  }

  async listCollections() {
    const res = await fetch(`${this.#url}?collections`, {
      headers: { 'Authorization': `Bearer ${this.#token}` },
    });
    if (!res.ok) throw new Error(`Sync error ${res.status}`);
    const { collections } = await res.json();
    return collections;
  }

  async delete(collection, id) {
    // Optimistic: remove from local cache and emit before server round-trip.
    this.#store[collection]?.delete(id);
    if (this.#persist) this.#idbPersist(collection, [], [id], this.#revisions[collection]);
    this.#emit(collection);
    return this.#fetch('DELETE', `${collection}&id=${encodeURIComponent(id)}`);
  }

  /**
   * Mark a record as being edited locally so SSE deltas do not overwrite in-progress edits.
   * Call unlockRecord when the user leaves the field or after save.
   */
  lockRecord(id) {
    this.#editing.add(id);
  }

  unlockRecord(id) {
    this.#editing.delete(id);
  }

  isRecordLocked(id) {
    return this.#editing.has(id);
  }

  /**
   * Apply successful POST payload to the in-memory store (and IDB when persist is on).
   * @param {object} res — server JSON, e.g. `{ saved, rev }`
   */
  #mergePushIntoStore(collection, payload, flat, res) {
    const serverRev = res && typeof res.rev === 'number' ? res.rev : null;
    const store     = this.#store[collection] ??= new Map();
    const rev       = serverRev ?? Date.now();

    if (serverRev !== null) {
      this.#revisions[collection] = Math.max(this.#revisions[collection] ?? 0, serverRev);
    }

    const toUpsert = [];
    for (const rec of payload) {
      if (!rec?.id) continue;
      if (flat) {
        const existing = store.get(rec.id);
        const row = {
          ...existing,
          id: rec.id,
          ...(typeof rec.data === 'object' && rec.data ? rec.data : {}),
          deleted: rec.deleted ? 1 : (existing?.deleted ?? 0),
          rev,
        };
        store.set(rec.id, row);
        toUpsert.push(row);
      } else {
        const existing = store.get(rec.id);
        const merged = {
          ...existing,
          ...rec,
          data: { ...(existing?.data || {}), ...(rec.data || {}) },
          deleted: rec.deleted ? 1 : 0,
          rev,
        };
        store.set(rec.id, merged);
        toUpsert.push(merged);
      }
    }

    if (this.#persist && toUpsert.length) {
      this.#idbPersist(collection, toUpsert, [], this.#revisions[collection]);
    }

    this.#emit(collection);
  }

  // ── IDB init ──────────────────────────────────────────────────────────────

  #initCollection(collection) {
    if (this.#initPromises[collection]) return this.#initPromises[collection];

    this.#initPromises[collection] = (async () => {
      try {
        const db = await this.#openDB();

        // Restore persisted revision cursor
        const revEntry = await this.#idbGet(db, 'revisions', collection);
        if (revEntry) this.#revisions[collection] = revEntry.rev;

        // Restore persisted record cache
        const store   = this.#store[collection] ??= new Map();
        const entries = await this.#idbGetByCollection(db, collection);
        for (const { id, record } of entries) store.set(id, record);

        // Emit cached data before SSE opens
        this.#emit(collection);
      } catch (e) {
        console.warn('SyncClient: IndexedDB unavailable, falling back to in-memory', e);
      }

      // Open SSE regardless of whether IDB succeeded — with whatever rev we have
      if (!this.#sources[collection] && this.#handlers[collection]?.size > 0) {
        this.#openSSE(collection);
      }
    })();

    return this.#initPromises[collection];
  }

  // ── Session token ─────────────────────────────────────────────────────────

  async #getSessionToken() {
    const buffer = 60_000; // refresh 1 min before expiry
    if (this.#session && this.#session.expiresAt - Date.now() > buffer) {
      return this.#session.token;
    }
    const res = await fetch(this.#authUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.#token}` },
    });
    if (!res.ok) throw new Error(`Auth error ${res.status}`);
    const { session_token, expires_at } = await res.json();
    this.#session = { token: session_token, expiresAt: expires_at };
    this.#scheduleRefresh();
    return this.#session.token;
  }

  #scheduleRefresh() {
    clearTimeout(this.#refreshTimer);
    const buffer = 60_000;
    const delay  = this.#session.expiresAt - Date.now() - buffer;
    this.#refreshTimer = setTimeout(async () => {
      await this.#getSessionToken();
      // Reopen active SSE connections with the new session token
      for (const collection of Object.keys(this.#sources)) {
        this.#closeSSE(collection);
        if (this.#handlers[collection]?.size > 0) this.#openSSE(collection);
      }
    }, Math.max(delay, 0));
  }

  // ── SSE ───────────────────────────────────────────────────────────────────

  async #openSSE(collection) {
    const flat  = this.#collectionOpts[collection]?.flat ?? false;
    const rev   = this.#revisions[collection] ?? 0;
    const token = await this.#getSessionToken();
    const url   = `${this.#url}?collection=${collection}&sse=1&since=${rev}&token=${token}`
                + (flat ? '&flat=1' : '');
    const es    = new EventSource(url);

    es.addEventListener('connected', (e) => {
      const { rev } = JSON.parse(e.data);
      this.#revisions[collection] = rev;
    });

    es.addEventListener('delta', (e) => {
      const { rev, records } = JSON.parse(e.data);
      this.#revisions[collection] = rev;
      this.#applyRecords(collection, records);
    });

    es.addEventListener('reconnect', (e) => {
      const { rev } = JSON.parse(e.data);
      this.#revisions[collection] = rev;
      es.close();
      this.#sources[collection] = null;
      if (this.#handlers[collection]?.size > 0) this.#openSSE(collection);
    });

    es.onerror = () => {
      // Browser will auto-reconnect after the retry interval set by server
    };

    this.#sources[collection] = es;
  }

  #closeSSE(collection) {
    this.#sources[collection]?.close();
    delete this.#sources[collection];
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  #applyRecords(collection, records) {
    const flat     = this.#collectionOpts[collection]?.flat ?? false;
    const store    = this.#store[collection] ??= new Map();
    const toUpsert = [];
    const toDelete = [];

    for (const record of records) {
      if (this.#editing.has(record.id)) continue;

      if (flat) {
        // Soft-deleted records (deleted_at set) stay in store — app processes them.
        // Hard-deleted records (deleted=1, no deleted_at) are removed.
        if (record.deleted && !record.deleted_at) {
          store.delete(record.id);
          toDelete.push(record.id);
        } else {
          store.set(record.id, record);
          toUpsert.push(record);
        }
      } else {
        if (record.deleted) {
          store.delete(record.id);
          toDelete.push(record.id);
        } else {
          store.set(record.id, record);
          toUpsert.push(record);
        }
      }
    }

    if (this.#persist) {
      this.#idbPersist(collection, toUpsert, toDelete, this.#revisions[collection]);
    }

    this.#emit(collection);
  }

  /**
   * Wrap a flat record into the server envelope: { id, data: {...}, deleted }.
   * A non-empty deleted_at signals deletion to the server.
   */
  #wrapRecord(record) {
    const { id, deleted, rev, ...data } = record;
    const isDeleted = !!(data.deleted_at) || !!deleted;
    return { id, data, deleted: isDeleted };
  }

  #emit(collection) {
    const snapshot = Object.fromEntries(this.#store[collection]);
    for (const cb of this.#handlers[collection] ?? []) cb(snapshot);
  }

  async #fetch(method, collectionOrPath, body = null) {
    const res = await fetch(`${this.#url}?collection=${collectionOrPath}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.#token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : null,
    });
    if (!res.ok) throw new Error(`Sync error ${res.status}`);
    return res.json();
  }

  // ── IndexedDB ─────────────────────────────────────────────────────────────
  //
  // Schema (DB name: tinysync_<hostname> by default, or constructor idbName; version 1):
  //   records   — keyPath: ['collection', 'id'], index: by_collection → collection
  //   revisions — keyPath: 'collection'

  async #openDB() {
    if (this.#db) return this.#db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.#idbName, 1);
      req.onupgradeneeded = ({ target: { result: db } }) => {
        if (!db.objectStoreNames.contains('records')) {
          const s = db.createObjectStore('records', { keyPath: ['collection', 'id'] });
          s.createIndex('by_collection', 'collection');
        }
        if (!db.objectStoreNames.contains('revisions')) {
          db.createObjectStore('revisions', { keyPath: 'collection' });
        }
      };
      req.onsuccess = ({ target: { result } }) => { this.#db = result; resolve(result); };
      req.onerror   = () => reject(req.error);
    });
  }

  // Write upserts + deletes + updated rev in a single transaction
  async #idbPersist(collection, toUpsert, toDelete, rev) {
    if (!toUpsert.length && !toDelete.length) return;
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx        = db.transaction(['records', 'revisions'], 'readwrite');
      const records   = tx.objectStore('records');
      const revisions = tx.objectStore('revisions');
      for (const record of toUpsert) records.put({ collection, id: record.id, record });
      for (const id of toDelete)     records.delete([collection, id]);
      revisions.put({ collection, rev });
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }

  async #idbGet(db, storeName, key) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName).objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(req.error);
    });
  }

  async #idbGetByCollection(db, collection) {
    return new Promise((resolve, reject) => {
      const req = db.transaction('records')
        .objectStore('records')
        .index('by_collection')
        .getAll(collection);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
}
