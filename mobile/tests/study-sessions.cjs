const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const { randomUUID } = require("node:crypto");

const practice = readFileSync(resolve(__dirname, "../../web/scripts/practice.js"), "utf8");
function source(name) {
  const start = practice.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return practice.slice(start, practice.indexOf("\n}", start + 1) + 2);
}

function model() {
  const q = ["A", "B", "C"].map((chapter) => ({ id: "q" + chapter, chapter, type: "单选", answer: ["A"], options: { A: "yes", B: "no" } }));
  const saved = [];
  const fields = new Map();
  const context = {
    structuredClone, console, Date, randomId: randomUUID, byId: new Map(q.map((item) => [item.id, item])),
    chapterPools: new Map(q.map((item) => [item.chapter, [item]])),
    window: { QuizCatalog: { version: "fixture-catalog" } },
    state: { history: {}, stars: {}, notes: {}, session: null, drafts: {}, chapterTests: {} },
    deferredResume: null, clearAnswerStreak() {}, resumeQuestion() {}, cancelAutoAdvance() {},
    accountSwitching: false, accountScopeRevision: 0, activeAccountId: null,
    pageContent: { inert: false }, tabDock: { inert: false },
    guestWrites: Promise.resolve(), guestUnsaved: new Map(), persistenceRevision: 0, sync: null,
    persistence: { stateFromCache: (cache) => structuredClone(cache) },
    selectedBank: "all", selectedTab: "practice", resetLibrary() {}, showTab() {},
    $: (id) => {
      if (!fields.has(id)) fields.set(id, { hidden: true, textContent: "", value: "practice", firstElementChild: { focus() {} } });
      return fields.get(id);
    },
    save(changes) { saved.push(structuredClone(changes)); },
    sharedQuestionId: (id) => id, translateSelection: (selected) => selected.slice(),
    chapterQuestions: (chapter) => q.filter((item) => item.chapter === chapter),
    hasAnswered: () => false,
  };
  const names = ["chapterForSession", "bankForSession", "isChapterPractice", "requiresAnswer", "canResumeSession",
    "draftSnapshot", "rememberSession", "saveSession", "activateDraft", "matchingDrafts", "matchingDraft", "chapterPracticeDraft",
    "chapterRoundDraft", "chapterRoundInProgress", "startChapterTest", "start", "shuffled", "recordAnswer",
    "takingChapterTest", "testSelections", "submitChapterTest", "clearRoundAnswer", "applyQuestionRedos",
    "setAccountSwitching", "restoreGuestState", "receiveStudyState"];
  context.showStartedQuestion = (changes) => context.saveSession(changes);
  context.completeRound = (changes) => { context.state.session.index = context.state.session.ids.length; context.state.session.selected = []; context.saveSession(changes); };
  runInNewContext(names.map(source).join("\n"), context);
  return { context, saved };
}

test("three chapters keep independent drafts and reopening an exam restores its selection", () => {
  const { context: app } = model();
  app.startChapterTest("A", "all"); const a = app.state.session.sid;
  app.state.session.selected = ["B"]; app.saveSession();
  app.startChapterTest("B", "all"); const b = app.state.session.sid;
  app.state.session.selected = ["A"]; app.saveSession();
  app.start(["qC"], "practice", { quickChapter: "C", bankScope: "all" });
  assert.equal(Object.keys(app.state.drafts).length, 3);
  app.startChapterTest("A", "all");
  assert.equal(app.state.session.sid, a);
  assert.deepEqual([...app.state.session.selected], ["B"]);
  app.startChapterTest("B", "all");
  assert.equal(app.state.session.sid, b);
  assert.deepEqual([...app.state.session.selected], ["A"]);
});

test("test submission writes an independent result and one immutable event for each scored answer", () => {
  const { context: app, saved } = model();
  app.startChapterTest("A", "all"); const sid = app.state.session.sid;
  app.state.session.selected = ["A"];
  app.submitChapterTest(app.state.session);
  const changes = saved.at(-1);
  assert.ok(changes.some(([kind, key]) => kind === "test" && key === sid));
  const history = changes.find(([kind]) => kind === "history");
  assert.equal(history[3].question_id, "qA");
  assert.equal(history[3].mode, "chapter-test");
  assert.equal(history[3].catalog_version, "fixture-catalog");
  assert.equal(app.state.drafts[sid], undefined);
  assert.equal(app.state.chapterTests["all:A"].correct, 1);
  app.startChapterTest("B", "all");
  assert.equal(app.state.chapterTests["all:A"].correct, 1);
});

test("two original questions sharing history still retain two distinct exam answer events", () => {
  const { context: app, saved } = model();
  app.sharedQuestionId = () => "canonical";
  app.start(["qA", "qB"], "chapter-test", { bankScope: "all", routePlan: { chapter: "A", kind: "test" } });
  app.state.session.drafts = { qB: ["B"] };
  app.state.session.selected = ["A"];
  app.submitChapterTest(app.state.session);
  const answers = saved.at(-1).filter(([kind]) => kind === "history");
  assert.equal(answers.length, 2);
  assert.deepEqual(answers.map((row) => row[1]), ["canonical", "canonical"]);
  assert.deepEqual(answers.map((row) => row[3].question_id).sort(), ["qA", "qB"]);
  assert.notEqual(answers[0][3].event_id, answers[1][3].event_id);
});

test("chapter resume uses the authoritative draft instead of a stale same-session pointer", async () => {
  const { emptyCache, stateFromCache } = await import("../study-state.mjs");
  for (const kind of ["live", "null", "deleted"]) {
    const { context: app } = model();
    const sid = randomUUID();
    const stale = { sid, ids: ["qA"], index: 0, mode: "chapter-test", selected: ["A"], results: {},
      bankScope: "all", routePlan: { chapter: "A", kind: "test" }, updatedAt: 999,
      chapterStudy: { tests: { "all:B": { correct: 1, total: 1, completedAt: 100 } } } };
    const latest = { ...stale, selected: ["B"], updatedAt: 1 };
    delete latest.chapterStudy;
    const cache = emptyCache();
    cache.records["session:resume"] = { kind: "session", record_key: "resume", payload: stale, revision: 200, change_id: randomUUID() };
    cache.records["draft:" + sid] = { kind: "draft", record_key: sid, payload: kind === "live" ? latest : null,
      ...(kind === "deleted" ? { deleted: true } : {}), revision: 300, change_id: randomUUID() };
    app.state = stateFromCache(cache);
    const resumed = app.chapterRoundDraft("A", "all", "test");
    assert.equal(app.state.chapterTests["all:B"].correct, 1);
    if (kind === "live") {
      assert.deepEqual([...resumed.selected], ["B"]);
      app.startChapterTest("A", "all");
      assert.equal(app.state.session.sid, sid);
      assert.deepEqual([...app.state.session.selected], ["B"]);
      assert.equal(app.state.session.chapterStudy.tests["all:B"].correct, 1);
    } else {
      assert.equal(resumed, undefined);
      assert.equal(app.state.session, null);
      app.startChapterTest("A", "all");
      assert.notEqual(app.state.session.sid, sid);
      assert.deepEqual([...app.state.session.selected], []);
    }
    cache.records["session:resume"].payload = { ...stale, index: 1, testSubmitted: true };
    if (kind !== "live") {
      app.state = stateFromCache(cache);
      assert.equal(app.state.session.testSubmitted, true);
      assert.equal(app.chapterRoundDraft("A", "all", "test"), undefined);
    }
  }
});

test("slow guest restoration keeps study inert and prevents account answers entering the guest store", async () => {
  const { context: app } = model();
  runInNewContext(source("save"), app);
  let release; let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const commits = [];
  app.guestStore = { durable: true, read() { started(); return pending; }, async commit(changes) { commits.push(changes); } };
  app.state.history = { "account-only": { wrong: true } };
  app.accountScopeRevision++;
  app.setAccountSwitching(true);
  const restoring = app.restoreGuestState();
  await reading;
  assert.equal(app.pageContent.inert, true);
  assert.equal(app.tabDock.inert, true);
  assert.equal(await app.save([["history", "account-only", { wrong: true }]]), false);
  app.start(["qA"]);
  assert.equal(app.state.session, null);
  assert.equal(commits.length, 0);
  release({ history: { "guest-only": { wrong: false } }, stars: {}, notes: {}, drafts: {}, chapterTests: {}, session: null });
  await restoring;
  assert.equal(app.pageContent.inert, false);
  assert.equal(app.tabDock.inert, false);
  assert.equal(app.state.history["account-only"], undefined);
  assert.ok(app.state.history["guest-only"]);
  assert.equal(await app.save([["history", "new-guest-answer", { wrong: false }]]), true);
  assert.deepEqual(commits.flat().map((row) => row[1]), ["new-guest-answer"]);
});

test("a late guest read cannot replace a newer account scope or unlock it early", async () => {
  const { context: app } = model();
  let release; let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  app.guestStore = { read() { started(); return pending; } };
  app.accountScopeRevision++;
  app.setAccountSwitching(true);
  const restoring = app.restoreGuestState();
  await reading;
  app.accountScopeRevision++;
  app.activeAccountId = "another-account";
  release({ history: { "guest-only": { wrong: false } }, session: null });
  await restoring;
  assert.equal(app.accountSwitching, true);
  assert.equal(app.pageContent.inert, true);
  assert.equal(app.state.history["guest-only"], undefined);
  app.receiveStudyState({ history: { "account-answer": { wrong: false } }, session: null }, true);
  assert.equal(app.accountSwitching, false);
  assert.equal(app.pageContent.inert, false);
  assert.ok(app.state.history["account-answer"]);
});
