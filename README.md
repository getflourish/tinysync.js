# tinysync.js

Minimal JavaScript client for [tinysync](https://github.com/getflourish/tinysync) — a single-user, multi-device sync backend built on PHP + SQLite.

Live updates via SSE. Optional IndexedDB persistence. No dependencies.

## Usage

```js
import { SyncClient } from 'tinysync.js';

const sync = new SyncClient('https://you.com/sync.php', 'your-token');

// Subscribe to live updates
const unsub = sync.subscribe('notes', (records) => render(records));

// Push a record
await sync.push('notes', { id: 'abc', data: { text: 'hello' } });

// Delete a record
await sync.delete('notes', 'abc');

// Unsubscribe
unsub();
```

## Constructor

```js
new SyncClient(url, token, options?)
```

| Option | Default | Description |
|--------|---------|-------------|
| `persist` | `false` | Cache records in IndexedDB. On reload, emits cached data immediately then fetches only the delta. |

## API

### `subscribe(collection, callback, options?)`

Opens an SSE connection and calls `callback` with the full record map (`{ id → record }`) on every update. Also fires immediately with the current cache.

Returns an unsubscribe function that closes the SSE connection when the last subscriber is removed.

```js
const unsub = sync.subscribe('todos', (records) => {
  console.log(Object.values(records));
});
```

Options: `{ flat: true }` — see [Flat mode](#flat-mode).

---

### `push(collection, record, options?)`

Creates or updates one or more records. Accepts a single record or an array.

```js
// Single record
await sync.push('notes', { id: 'abc', data: { title: 'Hi', body: '...' } });

// Multiple records
await sync.push('notes', [
  { id: 'abc', data: { title: 'Hi' } },
  { id: 'def', data: { title: 'There' } },
]);
```

---

### `delete(collection, id)`

Soft-deletes a record. Deleted records are propagated to other clients and then removed from their local cache.

```js
await sync.delete('notes', 'abc');
```

---

### `lockRecord(id)` / `unlockRecord(id)` / `isRecordLocked(id)`

Prevent incoming SSE deltas from overwriting a record that is currently being edited locally. Call `lockRecord` when the user starts editing and `unlockRecord` after saving or blur.

```js
input.addEventListener('focus', () => sync.lockRecord(note.id));
input.addEventListener('blur',  () => sync.unlockRecord(note.id));
```

## Record format

By default, records are wrapped:

```js
{ id: string, data: { ...fields }, deleted: 0|1, rev: number }
```

## Flat mode

For collections where you want records without a `data` wrapper, enable flat mode per collection:

```js
const unsub = sync.subscribe('todos', render, { flat: true });

await sync.push('todos', { id: 'abc', content: 'Buy milk', completed: 0 }, { flat: true });
```

In flat mode:
- `push()` accepts plain objects; fields are stored as-is
- Callbacks receive plain objects: `{ id, content, completed, ... }`
- Records with a non-empty `deleted_at` field are kept in the local store (so the app can process the deletion); hard-deleted records (`deleted: 1`, no `deleted_at`) are removed

## IndexedDB persistence

```js
const sync = new SyncClient(url, token, { persist: true });
```

On each page load, the client restores the cached records and revision cursor from IndexedDB, emits the cache immediately, then opens SSE requesting only records changed since the last known revision.

Gracefully falls back to in-memory if IndexedDB is unavailable.
