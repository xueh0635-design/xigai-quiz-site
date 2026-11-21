const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { IDBFactory } = require("fake-indexeddb");
const modules = Promise.all([import("../quiz-store.mjs"), import("../study-state.mjs")]);
const attempt = (question_id, event_id = randomUUID()) => ({ event_id, question_id, selected: ["A"],
  occurred_at: 1800000000000, mode: "practice", catalog_version: "fixture-v1" });

async function environment(t, entries = new Map()) {
  const [{ createQuizStore }, model] = await modules;
  const indexedDB = new IDBFactory();
  const stores = [];
  const open = async (options = {}) => {
    const store = await createQuizStore({ scope: "account:one", legacyKey: "legacy", indexedDB,
      legacyStorage: { getItem: (key) => entries.get(key) || null }, randomId: randomUUID, ...options });
    stores.push(store); return store;
  };
  t.after(() => stores.forEach((store) => store.close()));
  return { open, indexedDB, model };
}

test("two offline tabs commit different answers and survive closing/reopening", async (t) => {
  const { open } = await environment(t);
  const a = await open(), b = await open();
  const ea = attempt("q-A"), eb = attempt("q-B");
  await Promise.all([
    a.commit([["history", "q-A", { wrong: false, selected: ["A"] }, ea]]),
    b.commit([["history", "q-B", { wrong: false, selected: ["A"] }, eb]]),
  ]);
  a.close(); b.close();
  const reopened = await open();
  const saved = await reopened.read();
  assert.deepEqual(Object.keys(saved.pending).sort(), ["history:q-A", "history:q-B"]);
  assert.deepEqual((await reopened.pendingAttempts()).map((e) => e.event_id).sort(), [ea.event_id, eb.event_id].sort());
  const old = saved.pending["history:q-A"].change_id;
  await reopened.commit([["history", "q-A", { wrong: true }]]);
  await reopened.accept({ ackChanges: [old], ackAttempts: [ea.event_id] });
  assert.ok((await reopened.read()).pending["history:q-A"]);
  assert.deepEqual((await reopened.pendingAttempts()).map((e) => e.event_id), [eb.event_id]);
});

test("snapshot and attempt roll back together; retrying an event does not duplicate it", async (t) => {
  const { open } = await environment(t); const store = await open();
  const event = attempt("q1");
  await store.commit([["history", "q1", { wrong: false }, event]]);
  await store.commit([["history", "q1", { wrong: false }, event]]);
  assert.equal((await store.attempts()).length, 1);
  await assert.rejects(store.commit([["history", "q2", { wrong: true }, { ...event, selected: ["B"] }]]), /attempt_id_conflict/);
  assert.equal((await store.read()).records["history:q2"], undefined);
  assert.equal((await store.pendingAttempts()).length, 1);
});

test("migration keeps guest and account scopes separate and never rewrites legacy localStorage", async (t) => {
  const legacy = new Map([
    ["guest", JSON.stringify({ history: { guestQuestion: { wrong: false } } })],
    ["legacy", JSON.stringify({ records: { "history:accountQuestion": { kind: "history", record_key: "accountQuestion",
      revision: 1, change_id: randomUUID(), payload: { wrong: true } } }, pending: {} })],
  ]);
  const { open, model } = await environment(t, legacy);
  const guest = await open({ scope: "guest", guest: true, legacyKey: "guest" });
  const account = await open();
  assert.deepEqual(Object.keys(model.stateFromCache(await guest.read()).history), ["guestQuestion"]);
  assert.deepEqual(Object.keys(model.stateFromCache(await account.read()).history), ["accountQuestion"]);
  await guest.commit([["history", "guest2", { wrong: false }, attempt("guest2")]]);
  assert.equal((await account.attempts()).length, 0);
  assert.equal((await guest.pendingAttempts()).length, 0);
  assert.equal(JSON.parse(legacy.get("guest")).history.guest2, undefined);
});

test("different chapter drafts and scores survive a newer legacy resume", async (t) => {
  const { open, model } = await environment(t); const store = await open();
  const a = { sid: randomUUID(), ids: ["qA"], index: 0, mode: "chapter-test", selected: ["A"], results: {},
    chapterStudy: { tests: { "all:第一章": { correct: 8, total: 10 } } } };
  await store.commit([["session", "resume", a]]);
  const revision = (await store.read()).records["session:resume"].revision;
  const b = { sid: randomUUID(), ids: ["qB"], index: 0, mode: "practice", selected: ["B"], results: {},
    chapterStudy: { tests: { "all:第二章": { correct: 9, total: 10 } } } };
  await store.accept({ rows: [{ kind: "session", record_key: "resume", revision: revision + 1, change_id: randomUUID(), payload: b }] });
  const state = model.stateFromCache(await store.read());
  assert.deepEqual(Object.keys(state.chapterTests).sort(), ["all:第一章", "all:第二章"]);
  assert.deepEqual(state.drafts[a.sid].selected, ["A"]);
  assert.deepEqual(state.drafts[b.sid].selected, ["B"]);
  await store.commit([["draft", a.sid, null]]);
  assert.equal(model.stateFromCache(await store.read()).drafts[a.sid], undefined);
});

test("cursor advancement and acknowledgements are atomic, and database restore can reset the cursor", async (t) => {
  const { open } = await environment(t); const store = await open(); const event = attempt("q1");
  await store.commit([["history", "q1", { wrong: false }, event]]);
  await store.accept({ cursor: 10 });
  await assert.rejects(store.accept({ cursor: -1, ackAttempts: [event.event_id] }), /invalid_sync_cursor/);
  assert.equal((await store.pendingAttempts()).length, 1);
  assert.equal((await store.read()).cursor, 10);
  await store.accept({ cursor: 9, ackAttempts: [event.event_id] });
  assert.equal((await store.read()).cursor, 10);
  assert.equal((await store.pendingAttempts()).length, 0);
  await store.accept({ resetCursor: true });
  assert.equal((await store.read()).cursor, 0);
});

test("denied persistence is explicitly nondurable and does not claim localStorage is a safe replacement", async (t) => {
  const { open } = await environment(t);
  const store = await open({ indexedDB: null, legacyStorage: {
    getItem: () => null, setItem: () => { throw new Error("must not use localStorage as a queue"); },
  } });
  assert.equal(store.durable, false);
  await store.commit([["history", "q1", { wrong: false }, attempt("q1")]]);
  assert.equal((await store.pendingAttempts()).length, 1);
});
