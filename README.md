# tinysync.js

Minimal JavaScript client for [tinysync](https://github.com/getflourish/tinysync) — a single-user, multi-device sync backend built on PHP + SQLite.

Live updates via SSE. Optional IndexedDB persistence. No dependencies.

## CDN

```js
import { SyncClient } from "https://cdn.jsdelivr.net/gh/getflourish/tinysync.js@main/index.js";
```

## Usage

```js
import { SyncClient } from "tinysync.js";

const sync = new SyncClient("https://you.com/sync.php", "your-token");

// Subscribe to live updates
const unsub = sync.subscribe("notes", (records) => render(records));

// Push a record
await sync.push("notes", { id: "abc", data: { text: "hello" } });

// Delete a record
await sync.delete("notes", "abc");

// Unsubscribe
unsub();
```

## Constructor

```js
new SyncClient(url, token, options?)
```

| Option    | Default | Description                                                                                       |
| --------- | ------- | ------------------------------------------------------------------------------------------------- |
| `persist` | `false` | Cache records in IndexedDB. On reload, emits cached data immediately then fetches only the delta. |

## API

### `subscribe(collection, callback, options?)`

Opens an SSE connection and calls `callback` with the full record map (`{ id → record }`) on every update. Also fires immediately with the current cache.

Returns an unsubscribe function that closes the SSE connection when the last subscriber is removed.

```js
const unsub = sync.subscribe("todos", (records) => {
  console.log(Object.values(records));
});
```

Options: `{ flat: true }` — see [Flat mode](#flat-mode).

---

### `push(collection, record, options?)`

Creates or updates one or more records. Accepts a single record or an array.

```js
// Single record
await sync.push("notes", { id: "abc", data: { title: "Hi", body: "..." } });

// Multiple records
await sync.push("notes", [
  { id: "abc", data: { title: "Hi" } },
  { id: "def", data: { title: "There" } },
]);
```

---

### `delete(collection, id)`

Soft-deletes a record. Deleted records are propagated to other clients and then removed from their local cache.

```js
await sync.delete("notes", "abc");
```

---

### `lockRecord(id)` / `unlockRecord(id)` / `isRecordLocked(id)`

Prevent incoming SSE deltas from overwriting a record that is currently being edited locally. Call `lockRecord` when the user starts editing and `unlockRecord` after saving or blur.

```js
input.addEventListener("focus", () => sync.lockRecord(note.id));
input.addEventListener("blur", () => sync.unlockRecord(note.id));
```

## Record format

By default, records are wrapped:

```js
{ id: string, data: { ...fields }, deleted: 0|1, rev: number }
```

## Flat mode

For collections where you want records without a `data` wrapper, enable flat mode per collection:

```js
const unsub = sync.subscribe("todos", render, { flat: true });

await sync.push(
  "todos",
  { id: "abc", content: "Buy milk", completed: 0 },
  { flat: true },
);
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

## Vue 2 (view-only)

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="./style.css" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Pen</title>
    <script src="https://cdn.jsdelivr.net/npm/vue@2.7.16/dist/vue.min.js"></script>
  </head>
  <body>
    <div id="app">
      <div class="config">
        Sync
        <input v-model="collection" placeholder="Collection" />
        from
        <input v-model="endpoint" placeholder="Endpoint" />
        with
        <input v-model="token" placeholder="Access Token" type="password" />
        <button @click="connect" :disabled="connected">Connect</button>
      </div>

      <ul v-if="items.length">
        <li v-for="item in items" :key="item.id">
          {{ item.id }} — {{ JSON.stringify(item.data) }}
        </li>
      </ul>
      <p v-else-if="connected">No records yet.</p>
    </div>
    <script src="./script.js"></script>
  </body>
</html>
```

```js
(async () => {
  const { SyncClient } =
    await import("https://cdn.jsdelivr.net/gh/getflourish/tinysync.js@main/index.js");

  new Vue({
    el: "#app",
    data: {
      collection: "notes",
      connected: false,
      endpoint: "",
      records: {},
      token: "",
      unsub: null,
    },
    computed: {
      items() {
        return Object.values(this.records);
      },
    },
    methods: {
      connect() {
        if (this.unsub) this.unsub();
        const sync = new SyncClient(this.endpoint, this.token);
        this.unsub = sync.subscribe(this.collection, (records) => {
          this.records = records;
        });
        this.connected = true;
      },
    },
  });
})();
```

## Vue 2 with CRUD

```html
<div id="app">
  <div class="config">
    Sync
    <input v-model="collection" placeholder="Collection" />
    from
    <input v-model="endpoint" placeholder="Endpoint" />
    with
    <input v-model="token" placeholder="Access Token" type="password" />
    <button @click="connect" :disabled="connected">Connect</button>
  </div>

  <form @submit.prevent="save">
    <input v-model="draft.data.text" placeholder="Text" />
    <button type="submit" :disabled="!connected">Save</button>
  </form>

  <ul v-if="items.length">
    <li v-for="item in items" :key="item.id">
      <span @click="edit(item)">{{ item.id }} — <strong>{{ item.data.title }}</strong> {{ item.data.text }}</span>
      <button @click="remove(item.id)">Delete</button>
    </li>
  </ul>
  <p v-else-if="connected">No records yet.</p>
</div>
```

```js
(async () => {
  const { SyncClient } =
    await import("https://cdn.jsdelivr.net/gh/getflourish/tinysync.js@main/index.js");

  new Vue({
    el: "#app",
    data: {
      collection: "notes",
      connected: false,
      draft: { id: "", data: { title: "", text: "" } },
      endpoint: localStorage.getItem("ts_endpoint") || "",
      records: {},
      sync: null,
      token: localStorage.getItem("ts_token") || "",
      unsub: null,
    },
    computed: {
      items() {
        return Object.values(this.records);
      },
    },
    methods: {
      connect() {
        localStorage.setItem("ts_endpoint", this.endpoint);
        localStorage.setItem("ts_token", this.token);
        if (this.unsub) this.unsub();
        this.sync = new SyncClient(this.endpoint, this.token);
        this.unsub = this.sync.subscribe(this.collection, (records) => {
          this.records = records;
        });
        this.connected = true;
      },
      edit(item) {
        this.draft = JSON.parse(JSON.stringify(item));
      },
      async save() {
        const record = {
          id: this.draft.id || crypto.randomUUID(),
          data: { ...this.draft.data },
        };
        await this.sync.push(this.collection, record);
        this.draft = { id: "", data: { text: "" } };
      },
      async remove(id) {
        await this.sync.delete(this.collection, id);
      },
    },
  });
})();
```
