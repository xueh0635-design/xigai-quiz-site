import { emptyCache, guestCache, mergeRecord, normalizeCache, plainSession, recordKey } from "./study-state.mjs";

const databaseName = "xigai-study-v2";
const stateStore = "state";
const eventStore = "attempts";
const clone = (value) => structuredClone(value);
const eventFields = ["event_id", "question_id", "selected", "occurred_at", "mode", "catalog_version"];
export const attemptPayload = (event) => Object.fromEntries(eventFields.filter((key) => event[key] !== undefined).map((key) => [key, event[key]]));

function readLegacy(storage, key, guest) {
  try {
    storage ??= globalThis.localStorage;
    const value = JSON.parse(storage?.getItem(key) || "null");
    return guest ? guestCache(value) : normalizeCache(value);
  } catch { return emptyCache(); }
}

function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    if (!factory) return reject(new Error("storage_unavailable"));
    const request = factory.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(stateStore, { keyPath: "scope" });
      const events = db.createObjectStore(eventStore, { keyPath: ["scope", "event_id"] });
      events.createIndex("scope", "scope");
      events.createIndex("pending", ["scope", "status"]);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("storage_upgrade_blocked"));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

// An IndexedDB read-write transaction serializes the read/modify/write across
// every tab. The snapshot and its immutable answer events commit together.
function databaseDriver(db, scope, legacy) {
  const transact = (mutate) => new Promise((resolve, reject) => {
    const tx = db.transaction([stateStore, eventStore], "readwrite");
    const states = tx.objectStore(stateStore);
    const events = tx.objectStore(eventStore);
    const request = states.get(scope);
    let result;
    let failure;
    request.onsuccess = () => {
      try {
        const cache = normalizeCache(request.result?.cache || legacy);
        const addEvent = (event, status = "pending") => {
          const input = clone(event);
          const lookup = events.get([scope, input.event_id]);
          lookup.onsuccess = () => {
            const existing = lookup.result;
            if (existing && JSON.stringify(attemptPayload(existing.event)) !== JSON.stringify(attemptPayload(input))) {
              failure = new Error("attempt_id_conflict");
              tx.abort();
              return;
            }
            if (!existing || status === "acked") events.put({ scope, event_id: input.event_id, status, event: input });
          };
        };
        const acknowledge = (ids) => {
          for (const event_id of ids) {
            const lookup = events.get([scope, event_id]);
            lookup.onsuccess = () => {
              if (lookup.result) events.put({ ...lookup.result, status: "acked" });
            };
          }
        };
        mutate(cache, { addEvent, acknowledge });
        states.put({ scope, cache });
        result = cache;
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(clone(result));
    tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error("storage_write_failed"));
  });
  const listEvents = (pending) => new Promise((resolve, reject) => {
    const tx = db.transaction(eventStore, "readonly");
    const index = tx.objectStore(eventStore).index(pending ? "pending" : "scope");
    const request = index.getAll(pending ? [scope, "pending"] : scope);
    request.onsuccess = () => resolve(request.result.map((row) => row.event));
    request.onerror = () => reject(request.error);
  });
  return { durable: true, transact, listEvents, close: () => db.close() };
}

// The fallback deliberately does not write an unsafe localStorage snapshot.
// It lets the learner continue, while the UI explicitly says it is unsaved.
function memoryDriver(legacy) {
  let cache = clone(legacy);
  let events = new Map();
  return {
    durable: false,
    async transact(mutate) {
      const next = clone(cache);
      const copy = new Map([...events].map(([id, row]) => [id, clone(row)]));
      mutate(next, {
        addEvent(event, status = "pending") {
          const old = copy.get(event.event_id);
          if (old && JSON.stringify(attemptPayload(old.event)) !== JSON.stringify(attemptPayload(event))) throw new Error("attempt_id_conflict");
          if (!old || status === "acked") copy.set(event.event_id, { status, event: clone(event) });
        },
        acknowledge(ids) { for (const id of ids) if (copy.has(id)) copy.get(id).status = "acked"; },
      });
      cache = next; events = copy;
      return clone(cache);
    },
    async listEvents(pending) { return [...events.values()].filter((row) => !pending || row.status === "pending").map((row) => clone(row.event)); },
    close() {},
  };
}

export async function createQuizStore({ scope, legacyKey, guest = false, legacyStorage,
  indexedDB = globalThis.indexedDB, randomId = () => crypto.randomUUID(), nativeAdapter = globalThis.QuizDurableStorage } = {}) {
  if (!scope) throw new Error("storage_scope_required");
  const legacy = readLegacy(legacyStorage, legacyKey, guest);
  let driver;
  let warning;
  // A native adapter may provide the same atomic scope/event transaction
  // interface. WebView IndexedDB alone is not a native filesystem backup.
  if (nativeAdapter?.open) {
    try { driver = await nativeAdapter.open({ scope, legacy }); }
    catch (error) { warning = error; }
  }
  if (!driver) {
    try { driver = databaseDriver(await openDatabase(indexedDB), scope, legacy); }
    catch (error) { warning = error; driver = memoryDriver(legacy); }
  }
  function preserveSessionChildren(cache, row) {
    if (row?.kind !== "session" || !row.payload) return;
    for (const candidate of [row.payload, row.payload.chapterStudy?.pausedPractice]) {
      const draft = plainSession(candidate);
      if (!draft || draft.testSubmitted || draft.index >= draft.ids.length || cache.records["draft:" + draft.sid]) continue;
      const child = { kind: "draft", record_key: draft.sid, payload: draft,
        revision: Number(draft.updatedAt || row.revision) || 1, change_id: randomId() };
      cache.records[recordKey(child)] = child;
      if (!guest) cache.pending[recordKey(child)] = child;
    }
    for (const [key, test] of Object.entries(row.payload.chapterStudy?.tests || {})) {
      const split = key.indexOf(":");
      if (split < 1 || !test || typeof test !== "object") continue;
      const record_key = test.sessionId || "legacy:" + key;
      const previous = cache.records["test:" + record_key];
      if (previous && previous.payload.correct === test.correct && previous.payload.total === test.total) continue;
      const child = { kind: "test", record_key, payload: { ...test, bank: key.slice(0, split), chapter: key.slice(split + 1),
        completedAt: Number(test.completedAt || row.revision) || 0 },
        revision: Number(test.completedAt || row.revision) || 1, change_id: randomId() };
      if (previous && previous.revision > child.revision) continue;
      cache.records[recordKey(child)] = child;
      if (!guest) cache.pending[recordKey(child)] = child;
    }
  }
  try {
    await driver.transact((cache) => {
      for (const row of Object.values(cache.records)) preserveSessionChildren(cache, row);
    });
  } catch (error) {
    warning = error;
    driver.close();
    driver = memoryDriver(legacy);
    await driver.transact((cache) => {
      for (const row of Object.values(cache.records)) preserveSessionChildren(cache, row);
    });
  }
  const listeners = new Set();
  let channel;
  if (typeof globalThis.BroadcastChannel === "function") {
    channel = new BroadcastChannel(databaseName);
    channel.onmessage = (event) => { if (event.data?.scope === scope) for (const listener of listeners) listener(); };
  }
  const publish = () => channel?.postMessage({ scope });
  const write = async (mutate) => {
    const result = await driver.transact(mutate);
    publish();
    return result;
  };
  return {
    durable: driver.durable === true,
    warning,
    read: () => driver.transact(() => {}),
    pendingAttempts: () => driver.listEvents(true),
    attempts: () => driver.listEvents(false),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async commit(changes = []) {
      return write((cache, events) => {
        for (const [kind, record_key, payload, attempt] of changes) {
          const tag = kind + ":" + record_key;
          const previous = cache.records[tag];
          preserveSessionChildren(cache, previous);
          const row = { kind, record_key, payload: clone(payload),
            revision: Math.max(Date.now(), (previous?.revision || 0) + 1), change_id: randomId() };
          const merged = mergeRecord(row, previous);
          cache.records[tag] = merged;
          if (!guest) cache.pending[tag] = merged;
          if (attempt) events.addEvent(attempt, guest ? "guest" : "pending");
        }
      });
    },
    async accept({ rows = [], attempts = [], ackChanges = [], ackAttempts = [], cursor, resetCursor = false, v2RetryAt } = {}) {
      return write((cache, events) => {
        const acknowledged = new Set(ackChanges);
        for (const [tag, row] of Object.entries(cache.pending)) if (acknowledged.has(row.change_id)) delete cache.pending[tag];
        for (const row of rows) {
          if (!row || typeof row.kind !== "string" || typeof row.record_key !== "string") throw new Error("invalid_sync_row");
          const tag = recordKey(row);
          preserveSessionChildren(cache, cache.records[tag]);
          preserveSessionChildren(cache, row);
          cache.records[tag] = mergeRecord(row, cache.records[tag]);
        }
        events.acknowledge(ackAttempts);
        for (const event of attempts) events.addEvent(event, "acked");
        if (resetCursor) cache.cursor = 0;
        if (cursor !== undefined) {
          if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("invalid_sync_cursor");
          // Another tab may already have durably applied a later page.
          cache.cursor = Math.max(cache.cursor, cursor);
        }
        if (v2RetryAt !== undefined) cache.v2RetryAt = v2RetryAt;
      });
    },
    close() { listeners.clear(); channel?.close(); driver.close(); },
  };
}
