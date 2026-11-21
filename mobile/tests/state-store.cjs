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

test("advancing legacy resumes refresh their draft even without a current updatedAt", async (t) => {
  for (const updatedAt of [undefined, 10]) {
    const { open, model } = await environment(t);
    const sid = randomUUID();
    const initial = { sid, ids: ["q1", "q2"], index: 0, mode: "chapter-test", selected: [], results: {},
      ...(updatedAt === undefined ? {} : { updatedAt }) };
    const resume = (payload, revision) => ({ kind: "session", record_key: "resume", payload, revision, change_id: randomUUID() });
    const store = await open();
    await store.accept({ rows: [resume(initial, 100)] });
    const progressed = { ...initial, index: 1, drafts: { q1: ["A"] }, selected: ["B"] };
    const newer = resume(progressed, 200);
    await store.accept({ rows: [newer] });
    const saved = (await store.read()).records["draft:" + sid];
    assert.equal(saved.payload.index, 1);
    assert.deepEqual(saved.payload.drafts, { q1: ["A"] });
    assert.deepEqual(saved.payload.selected, ["B"]);
    assert.equal(saved.payload.updatedAt, 200);
    await store.accept({ ackChanges: [saved.change_id] });
    await store.accept({ rows: [newer] });
    assert.equal((await store.read()).records["draft:" + sid].change_id, saved.change_id);
    assert.equal((await store.read()).pending["draft:" + sid], undefined);
    await store.accept({ rows: [resume({ ...initial, sid: randomUUID(), ids: ["q3"] }, 300)] });
    store.close();
    const reopened = await open();
    assert.deepEqual(model.stateFromCache(await reopened.read()).drafts[sid], model.plainSession(saved.payload));
    assert.equal((await reopened.read()).pending["draft:" + sid], undefined);
  }
});

test("a completed legacy exam closes its derived draft and replay cannot reopen it", async (t) => {
  const { open, model } = await environment(t); const store = await open();
  const sid = randomUUID();
  const initial = { sid, ids: ["q1"], index: 0, mode: "chapter-test", selected: ["A"], results: {} };
  const old = { kind: "session", record_key: "resume", payload: initial, revision: 100, change_id: randomUUID() };
  const completed = { ...old, payload: { ...initial, index: 1, testSubmitted: true }, revision: 200, change_id: randomUUID() };
  await store.accept({ rows: [old] });
  await store.accept({ rows: [completed] });
  const tombstone = (await store.read()).records["draft:" + sid];
  assert.equal(tombstone.payload, null);
  assert.equal(tombstone.revision, 200);
  assert.equal(model.stateFromCache(await store.read()).drafts[sid], undefined);
  await store.accept({ ackChanges: [tombstone.change_id], rows: [old, completed] });
  store.close();
  const reopened = await open();
  assert.equal(model.stateFromCache(await reopened.read()).drafts[sid], undefined);
  assert.equal((await reopened.read()).records["draft:" + sid].change_id, tombstone.change_id);
  assert.equal((await reopened.read()).pending["draft:" + sid], undefined);
});

test("equal-timestamp legacy winners advance independently synced drafts across echo and reopen", async (t) => {
  const { open, model } = await environment(t); let store = await open();
  const sid = randomUUID();
  const initial = { sid, ids: ["q1", "q2"], index: 0, mode: "chapter-test", selected: [], results: {} };
  const row = (payload, revision, suffix) => ({ kind: "session", record_key: "resume", payload, revision,
    change_id: "00000000-0000-4000-8000-00000000000" + suffix });
  const first = row(initial, 200, "1");
  const winner = row({ ...initial, index: 1, drafts: { q1: ["A"] }, selected: ["B"] }, 200, "2");
  await store.accept({ rows: [first] });
  const original = (await store.read()).records["draft:" + sid];
  // A server echo carries known columns and payload, not arbitrary local row metadata.
  const echo = ({ kind, record_key, revision, change_id, payload }) => ({ kind, record_key, revision, change_id, payload });
  await store.accept({ rows: [echo(original)], ackChanges: [original.change_id] });
  store.close(); store = await open();
  const projection = await store.read();
  projection.records["session:resume"] = winner;
  assert.equal(model.stateFromCache(projection).session.index, 1);
  await store.accept({ rows: [winner] });
  const advanced = (await store.read()).records["draft:" + sid];
  assert.equal(advanced.revision, 201);
  assert.deepEqual(advanced.payload._resumeSource, { revision: 200, change_id: winner.change_id });
  assert.notEqual(advanced.change_id, original.change_id);
  assert.notEqual(advanced.change_id, winner.change_id);
  await store.accept({ ackChanges: [winner.change_id] });
  assert.equal((await store.read()).pending["draft:" + sid].change_id, advanced.change_id);

  const otherDevice = await open({ scope: "account:other-device" });
  await otherDevice.accept({ rows: [echo(original), echo(advanced)] });
  assert.equal(model.stateFromCache(await otherDevice.read()).drafts[sid].index, 1);
  const following = row({ ...winner.payload, selected: ["A"] }, 201, "3");
  await otherDevice.accept({ rows: [following] });
  const next = (await otherDevice.read()).records["draft:" + sid];
  assert.equal(next.revision, 202);
  assert.deepEqual(next.payload._resumeSource, { revision: 201, change_id: following.change_id });
  await otherDevice.accept({ rows: [following], ackChanges: [next.change_id] });
  assert.equal((await otherDevice.read()).records["draft:" + sid].change_id, next.change_id);
  assert.equal((await otherDevice.read()).pending["draft:" + sid], undefined);
  await otherDevice.accept({ rows: [row({ ...initial, sid: randomUUID(), ids: ["q3"] }, 300, "4")] });
  const projected = model.stateFromCache(await otherDevice.read()).drafts[sid];
  assert.equal(projected.index, 1);
  assert.deepEqual(projected.selected, ["A"]);
  assert.equal(projected._resumeSource, undefined);
});

test("an explicit draft edit drops legacy provenance and wins equal-version resume replay", async (t) => {
  const { open, model } = await environment(t); const store = await open();
  const sid = randomUUID();
  const initial = { sid, ids: ["q1", "q2"], index: 0, mode: "chapter-test", selected: [], results: {} };
  const legacy = { kind: "session", record_key: "resume", payload: initial, revision: 100, change_id: randomUUID() };
  await store.accept({ rows: [legacy] });
  const derived = (await store.read()).records["draft:" + sid];
  assert.ok(derived.payload._resumeSource);
  await store.commit([["draft", sid, { ...derived.payload, index: 1, selected: ["B"] }]]);
  const explicit = (await store.read()).records["draft:" + sid];
  assert.equal(explicit.payload._resumeSource, undefined);
  await store.accept({ rows: [{ ...legacy, revision: explicit.revision, change_id: "ffffffff-ffff-4fff-bfff-ffffffffffff" }] });
  assert.deepEqual((await store.read()).records["draft:" + sid], explicit);
  assert.deepEqual(model.stateFromCache(await store.read()).session.selected, ["B"]);
});

test("newer explicit drafts and both tombstone forms survive older legacy resume replay", async (t) => {
  for (const kind of ["live", "null", "deleted"]) {
    const { open, model } = await environment(t); const store = await open();
    const sid = randomUUID();
    const draft = { sid, ids: ["q1", "q2"], index: 1, mode: "chapter-test", selected: ["B"], results: {}, updatedAt: 1 };
    const explicit = { kind: "draft", record_key: sid, payload: kind === "live" ? draft : null,
      ...(kind === "deleted" ? { deleted: true } : {}), revision: 300, change_id: randomUUID() };
    const legacy = { kind: "session", record_key: "resume", payload: { ...draft, index: 0, selected: ["A"], updatedAt: 999 },
      revision: 200, change_id: randomUUID() };
    await store.accept({ rows: [explicit, legacy] });
    await store.accept({ rows: [legacy] });
    store.close();
    const reopened = await open();
    const cache = await reopened.read();
    assert.deepEqual(cache.records["draft:" + sid], explicit);
    assert.equal(cache.pending["draft:" + sid], undefined);
    assert.deepEqual(model.stateFromCache(cache).drafts[sid], kind === "live" ? draft : undefined);
  }
});

test("legacy paused copies do not overwrite an independently advanced draft", async (t) => {
  const { open, model } = await environment(t); const store = await open();
  const sid = randomUUID();
  const paused = { sid, ids: ["q1", "q2"], index: 0, mode: "practice", selected: [], results: {} };
  const explicit = { kind: "draft", record_key: sid, payload: { ...paused, index: 1, selected: ["B"] },
    revision: 200, change_id: randomUUID() };
  const legacy = { kind: "session", record_key: "resume", payload: { ...paused, sid: randomUUID(), ids: ["q3"],
    chapterStudy: { pausedPractice: paused } }, revision: 300, change_id: randomUUID() };
  await store.accept({ rows: [explicit, legacy] });
  store.close();
  const reopened = await open();
  assert.deepEqual(model.stateFromCache(await reopened.read()).drafts[sid], explicit.payload);
  assert.equal((await reopened.read()).pending["draft:" + sid], undefined);
});

test("a paused child's parent revision does not override newer progress from its own session", async (t) => {
  const { open, model } = await environment(t); const store = await open();
  const sid = randomUUID();
  const paused = { sid, ids: ["q1", "q2"], index: 0, mode: "practice", selected: [], results: {}, updatedAt: 100 };
  await store.accept({ rows: [{ kind: "session", record_key: "resume", revision: 300, change_id: randomUUID(), payload: {
    ...paused, sid: randomUUID(), ids: ["q3"], chapterStudy: { pausedPractice: paused },
  } }] });
  assert.equal((await store.read()).records["draft:" + sid].payload._resumeSource, undefined);
  await store.accept({ rows: [{ kind: "session", record_key: "resume", revision: 250, change_id: randomUUID(), payload: {
    ...paused, index: 1, selected: ["B"],
  } }] });
  const draft = model.stateFromCache(await store.read()).drafts[sid];
  assert.equal(draft.index, 1);
  assert.deepEqual(draft.selected, ["B"]);
});

test("replaying a legacy score after its test tombstone does not abort the sync transaction", async (t) => {
  const { open } = await environment(t); const store = await open();
  const sessionId = randomUUID();
  const deleted = { kind: "test", record_key: sessionId, payload: null, deleted: true,
    revision: 300, change_id: randomUUID() };
  const legacy = { kind: "session", record_key: "resume", revision: 200, change_id: randomUUID(), payload: {
    sid: randomUUID(), ids: ["q1"], index: 0, mode: "practice", selected: [], results: {},
    chapterStudy: { tests: { "all:第一章": { sessionId, correct: 8, total: 10, completedAt: 100 } } },
  } };
  await store.accept({ rows: [deleted, legacy], cursor: 5 });
  const saved = await store.read();
  assert.deepEqual(saved.records["test:" + sessionId], deleted);
  assert.equal(saved.pending["test:" + sessionId], undefined);
  assert.equal(saved.cursor, 5);
  store.close();
  const reopened = await open();
  assert.equal(reopened.durable, true);
  assert.deepEqual((await reopened.read()).records["test:" + sessionId], deleted);
});

test("the pure state projection applies legacy progress and completion by record revision", async (t) => {
  const { model } = await environment(t);
  const sid = randomUUID();
  const draft = { sid, ids: ["q1", "q2"], index: 0, selected: [], results: {} };
  const cache = model.emptyCache();
  cache.records["draft:" + sid] = { kind: "draft", record_key: sid, payload: draft, revision: 100, change_id: randomUUID() };
  cache.records["session:resume"] = { kind: "session", record_key: "resume", payload: { ...draft, index: 1, selected: ["A"] },
    revision: 200, change_id: randomUUID() };
  assert.deepEqual(model.stateFromCache(cache).drafts[sid].selected, ["A"]);
  cache.records["session:resume"].payload.testSubmitted = true;
  assert.equal(model.stateFromCache(cache).drafts[sid], undefined);
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
