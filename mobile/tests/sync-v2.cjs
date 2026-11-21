const assert = require("node:assert/strict");
const test = require("node:test");
const { runInNewContext } = require("node:vm");
const { webcrypto, randomUUID } = require("node:crypto");
const { IDBFactory } = require("fake-indexeddb");
const { accountSource } = require("./helpers/account-source.cjs");

async function fixture(t, rpc, options = {}) {
  const indexedDB = Object.hasOwn(options, "indexedDB") ? options.indexedDB : new IDBFactory();
  const fields = new Map(); const received = []; const requests = [];
  const field = (id) => {
    if (!fields.has(id)) fields.set(id, { value: "", hidden: false, open: false, textContent: "", disabled: false,
      addEventListener() {}, removeAttribute() {}, hasAttribute() { return false; }, reset() {}, focus() {},
      close() { this.open = false; }, showModal() { this.open = true; } });
    return fields.get(id);
  };
  const nativeCalls = [];
  const window = { QuizCloud: { url: "https://fixture.example.test", key: "fixture", passwordRecovery: options.recovery || false },
    webkit: { messageHandlers: { quizNativeUI: { async postMessage(value) {
      nativeCalls.push(value);
      if (value.kind === "capabilities") return options.nativeTimeout ? new Promise(() => {}) : options.capabilities || {};
      return options.recoveryEmail === undefined ? true : { recoveryEmail: options.recoveryEmail };
    } } } } };
  const client = {
    functions: { invoke: options.invokeFunction },
    auth: { onAuthStateChange() {}, async signOut() { return { error: null }; },
      async signInWithPassword() { return { data: { user: { id: "fixture", email: "fixture@example.test" } }, error: null }; } },
    from() { return { select() { return this; }, eq() { return this; }, order() { return this; },
      async maybeSingle() { return { data: { account_id: "fixture" }, error: null }; },
      async range() { return { data: [], error: null }; } }; },
    async rpc(name, payload) { requests.push({ name, payload: structuredClone(payload) }); return rpc(name, payload); },
  };
  runInNewContext(accountSource(), { window, document: { getElementById: field, addEventListener() {}, visibilityState: "visible" },
    createClient: () => client, indexedDB, QuizDurableStorage: options.storageAdapter, localStorage: { getItem() { return null; } },
    structuredClone, crypto: webcrypto, TextEncoder, Response, AbortController, AbortSignal: options.abortSignal || AbortSignal,
    addEventListener() {}, setTimeout(callback, delay) { if (options.nativeTimeout && delay === 1500) queueMicrotask(callback); },
    clearTimeout() {}, setInterval() {},
  });
  const sync = window.QuizAccount.connect({ randomId: randomUUID, receive: (state) => received.push(state),
    guest: options.guest || (() => {}), accountChanged: options.accountChanged });
  if (options.login !== false) await window.QuizNativeAccount.run("login", "fixture@example.test", "fixture-test-password");
  const { createQuizStore } = await import("../quiz-store.mjs");
  const inspection = await createQuizStore({ scope: "account:fixture", indexedDB, legacyStorage: { getItem() { return null; } }, randomId: randomUUID });
  t.after(() => inspection.close());
  return { sync, received, requests, inspection, window, field, nativeCalls,
    refresh: () => field("account-refresh").onclick() };
}
const event = () => ({ event_id: randomUUID(), question_id: "q1", selected: ["A"], occurred_at: 1800000000000,
  mode: "practice", catalog_version: "fixture" });

test("old server fallback uploads compatible state while preserving attempts and independent drafts", async (t) => {
  const app = await fixture(t, async (name) => name === "quiz_sync_v2"
    ? { error: { code: "PGRST202", message: "function missing" } } : { data: null, error: null });
  const answer = event(); const sid = randomUUID();
  await app.sync.queue([["history", "q1", { wrong: false }, answer], ["draft", sid, { sid, ids: ["q1"], index: 0 }]]);
  await app.refresh();
  const sent = app.requests.find((row) => row.name === "merge_account_quiz_state");
  assert.deepEqual(sent.payload.changes.map((row) => row.kind), ["history"]);
  assert.equal((await app.inspection.pendingAttempts()).length, 1);
  const cache = await app.inspection.read();
  assert.equal(cache.pending["history:q1"], undefined);
  assert.ok(cache.pending["draft:" + sid]);
  assert.match(app.field("account-label").textContent, /等待服务升级/);
});

test("lost acknowledgement retries the same event id and clears outbox only after an explicit acknowledgement", async (t) => {
  const events = new Map(); let loseReply = true;
  const app = await fixture(t, async (_name, input) => {
    for (const item of input.attempts) events.set(item.event_id, item);
    if (loseReply) { loseReply = false; return { error: { message: "connection lost after commit" } }; }
    return { error: null, data: { version: 2,
      ack: { changes: input.changes.map((row) => row.change_id), attempts: input.attempts.map((row) => row.event_id) },
      rows: input.changes.map((row) => ({ ...row, sync_cursor: 2 })),
      attemptRows: [...events.values()].map((row) => ({ ...row, correct: true, sync_cursor: 1 })), next_cursor: 2, has_more: false } };
  });
  const answer = event();
  await app.sync.queue([["history", "q1", { wrong: false }, answer]]);
  await app.refresh();
  assert.equal((await app.inspection.pendingAttempts()).length, 1);
  await app.refresh();
  assert.equal(events.size, 1);
  assert.equal((await app.inspection.pendingAttempts()).length, 0);
  assert.equal(Object.keys((await app.inspection.read()).pending).length, 0);
  assert.equal((await app.inspection.read()).cursor, 2);
});

test("cursor ahead after a database restore resets once and resumes from zero", async (t) => {
  const app = await fixture(t, async (_name, input) => input.cursor > 0
    ? { error: { message: "quiz_cursor_ahead" } }
    : { error: null, data: { version: 2, ack: { changes: [], attempts: [] }, rows: [], attemptRows: [], next_cursor: 0, has_more: false } });
  await app.inspection.accept({ cursor: 99 });
  await app.refresh();
  assert.deepEqual(app.requests.map((row) => row.payload.cursor), [99, 0]);
});

test("a catalog awaiting backend deployment keeps its durable outbox and reports the exact cause", async (t) => {
  const app = await fixture(t, async () => ({ error: { message: "quiz_catalog_unavailable" } }));
  const answer = event();
  await app.sync.queue([["history", "q1", { wrong: false }, answer]]);
  const before = await app.inspection.read();
  await app.refresh();
  assert.equal(app.field("account-label").textContent, "题库版本等待云端升级 · 本机作答已保留");
  assert.deepEqual((await app.inspection.read()).pending, before.pending);
  assert.equal((await app.inspection.read()).cursor, 0);
  assert.deepEqual((await app.inspection.pendingAttempts()).map((row) => row.event_id), [answer.event_id]);
  await app.refresh();
  assert.deepEqual(app.requests.map((row) => row.payload.attempts[0].event_id), [answer.event_id, answer.event_id]);
});

test("a catalog error never claims saved data when local persistence is unavailable", async (t) => {
  const app = await fixture(t, async () => ({ error: { message: "quiz_catalog_unavailable" } }), { indexedDB: null });
  assert.equal(await app.sync.queue([["history", "q1", { wrong: false }, event()]]), false);
  await app.refresh();
  assert.match(app.field("account-label").textContent, /未保存.*保持页面打开/);
  assert.doesNotMatch(app.field("account-label").textContent, /已保留/);
});

test("account writes wait for restored scope so a slow store open cannot import guest answers", async (t) => {
  let opened; let release;
  const starting = new Promise((resolve) => { opened = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const app = await fixture(t, async () => ({ error: null }), { login: false,
    storageAdapter: { async open() { opened(); await blocked; } } });
  const loggingIn = app.window.QuizNativeAccount.run("login", "fixture@example.test", "fixture-test-password");
  await starting;
  assert.equal(await app.sync.queue([["history", "guest-only", { wrong: true }, event()]]), false);
  assert.equal(app.received.length, 0);
  assert.equal(Object.keys((await app.inspection.read()).records).length, 0);
  release();
  assert.equal(await loggingIn, null);
  assert.equal(app.received.length, 1);
  assert.equal(await app.sync.queue([["history", "account-answer", { wrong: false }, event()]]), true);
  const restored = await app.inspection.read();
  assert.equal(restored.records["history:guest-only"], undefined);
  assert.ok(restored.records["history:account-answer"]);
});

test("logout resolves only after the guest scope has finished restoring", async (t) => {
  let started; let release;
  const starting = new Promise((resolve) => { started = resolve; });
  const restoring = new Promise((resolve) => { release = resolve; });
  const app = await fixture(t, async () => ({ error: null }), { guest() { started(); return restoring; } });
  let finished = false;
  const loggingOut = app.window.QuizNativeAccount.run("logout").then((result) => { finished = true; return result; });
  await starting;
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(await app.sync.queue([["history", "account-only", { wrong: true }]]), false);
  release();
  assert.equal(await loggingOut, null);
  assert.equal(finished, true);
});

test("old native bridge and missing recovery capability fall back to the Web account form", async (t) => {
  for (const capabilities of [{}, { schemaVersion: 1, account: true, passwordRecovery: false }]) {
    const app = await fixture(t, async () => ({ error: null }), { login: false, recovery: true, capabilities });
    await app.field("account-button").onclick();
    assert.equal(app.field("account-dialog").open, true);
    assert.deepEqual(app.nativeCalls.map((value) => value.kind), ["capabilities"]);
  }
});

test("a native capability timeout releases the account button and shows the Web form", async (t) => {
  const app = await fixture(t, async () => ({ error: null }), { login: false, nativeTimeout: true });
  await app.field("account-button").onclick();
  assert.equal(app.field("account-dialog").open, true);
  assert.deepEqual(app.nativeCalls.map((value) => value.kind), ["capabilities"]);
});

test("a capable native account sheet can hand password recovery back to the isolated Web form", async (t) => {
  const app = await fixture(t, async () => ({ error: null }), { login: false, recovery: true,
    capabilities: { schemaVersion: 1, account: true, passwordRecovery: true }, recoveryEmail: "learner@example.test" });
  await app.field("account-button").onclick();
  assert.equal(app.field("account-dialog").open, true);
  assert.equal(app.field("account-form").hidden, true);
  assert.equal(app.field("account-recovery-form").hidden, false);
  assert.equal(app.field("account-recovery-email").value, "learner@example.test");
  assert.deepEqual(app.nativeCalls.map((value) => value.kind), ["capabilities", "account"]);
  assert.equal(app.requests.length, 0);
});


test("topic assistant status and follow-up work in a WebView without AbortSignal.timeout", async (t) => {
  const requests = [];
  const app = await fixture(t, async () => ({ error: { code: "PGRST202" } }), {
    abortSignal: {},
    async invokeFunction(name, options) {
      assert.equal(name, "quiz-tutor");
      requests.push(options);
      return { error: null, data: options.method === "GET" ? { available: true } : { answer: "B 项解析" } };
    },
  });
  const status = await app.sync.tutor("GET");
  assert.equal(status.data.available, true);
  assert.equal(requests[0].signal.aborted, false);
  const request = new AbortController();
  const reply = await app.sync.tutor("POST", { question: { focus: "B" } }, request.signal);
  assert.equal(reply.data.answer, "B 项解析");
  assert.equal(requests[1].body.question.focus, "B");
  assert.equal(requests[1].signal, request.signal);
});
