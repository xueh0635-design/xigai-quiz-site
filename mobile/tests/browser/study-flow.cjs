// Run after the repository build, with Playwright Chromium installed:
// node --test mobile/tests/browser/*.cjs
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { createServer } = require("node:http");
const { readFile } = require("node:fs/promises");
const { resolve, sep, extname } = require("node:path");
const { chromium } = require("playwright");
const root = resolve(__dirname, "../../..");
let server, browser, origin;

before(async () => {
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/storage-fixture") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<script type="module">import {createQuizStore} from '/mobile/quiz-store.mjs';
          window.openStore = () => createQuizStore({scope:'account:browser-fixture'}); window.storeReady=true;</script>`);
        return;
      }
      const path = resolve(root, "." + decodeURIComponent(url.pathname));
      if (!path.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
      let bytes = await readFile(path);
      if (url.searchParams.get("fault") === "optional") {
        const html = bytes.toString();
        const marker = html.match(/<script\b[^>]*>\s*"use strict";\s*const allQuestions\b/)?.[0];
        assert.ok(marker, "the built page must retain the study script for the fault injection");
        bytes = Buffer.from(html.replace(marker, `<script>
          window.QuizTutor={connect(){throw Error('fixture tutor failure')},questionContext(){return null}};
          window.QuizDevelopmentRequests={connect(){throw Error('fixture feedback failure')}};
          </script>\n` + marker));
      }
      response.setHeader("Content-Type", ({ ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
        ".json": "application/json", ".svg": "image/svg+xml", ".webp": "image/webp" }[extname(path)] || "application/octet-stream") + "; charset=utf-8");
      response.end(bytes);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function context(t) {
  const value = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await value.route("https://**", (route) => route.abort()); // Never contact the production backend.
  t.after(() => value.close());
  return value;
}
const ready = (page) => page.waitForFunction(() => document.documentElement.dataset.studyReady === "true");

test("two real browser tabs keep both offline outboxes after both pages close", async (t) => {
  const ctx = await context(t);
  const a = await ctx.newPage(), b = await ctx.newPage();
  for (const page of [a, b]) {
    await page.goto(origin + "/storage-fixture");
    await page.waitForFunction(() => window.storeReady);
    await page.evaluate(async () => { window.testStore = await openStore(); });
  }
  await ctx.setOffline(true);
  await Promise.all([a, b].map((page, index) => page.evaluate(async (number) => {
    const id = `q-${number}`;
    await testStore.commit([["history", id, { wrong: false }, {
      event_id: crypto.randomUUID(), question_id: id, selected: ["A"], occurred_at: Date.now(), mode: "practice", catalog_version: "fixture",
    }]]);
  }, index)));
  await a.close(); await b.close();
  // The local test HTTP server must be reachable to load a fresh document;
  // all production HTTPS requests remain blocked throughout this test.
  await ctx.setOffline(false);
  const reopened = await ctx.newPage();
  await reopened.goto(origin + "/storage-fixture");
  await reopened.waitForFunction(() => window.storeReady);
  const result = await reopened.evaluate(async () => {
    const store = await openStore();
    return { pending: Object.keys((await store.read()).pending).sort(), attempts: (await store.pendingAttempts()).length };
  });
  assert.deepEqual(result, { pending: ["history:q-0", "history:q-1"], attempts: 2 });
});

test("an unfinished exam survives other chapters and a page reload", async (t) => {
  const ctx = await context(t); const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/docs/index.html"); await ready(page);
  await page.evaluate(() => startChapterTest("导论", "all"));
  await page.locator("#options .option").first().click();
  const before = await page.evaluate(() => ({ sid: state.session.sid, id: current().id, selected: state.session.selected.slice() }));
  await page.locator("#back").click();
  await page.evaluate(() => startChapterTest("第一章", "all"));
  await page.locator("#options .option").first().click();
  await page.locator("#back").click();
  await page.evaluate(() => openChapter("第二章", { bank: "all" }));
  await page.evaluate(() => guestWrites);
  await page.reload(); await ready(page);
  await page.evaluate(() => startChapterTest("导论", "all"));
  const after = await page.evaluate(() => ({ sid: state.session.sid, id: current().id, selected: state.session.selected.slice(),
    drafts: Object.keys(state.drafts).length }));
  assert.deepEqual({ sid: after.sid, id: after.id, selected: after.selected }, before);
  assert.ok(after.drafts >= 3);
  assert.deepEqual(errors, []);
});

test("the reloaded resume entry respects newer drafts and completed-draft tombstones", async (t) => {
  for (const deleted of [false, true]) {
    const ctx = await context(t); const page = await ctx.newPage();
    await page.goto(origin + "/docs/index.html"); await ready(page);
    const saved = await page.evaluate(async (closed) => {
      const pool = questions.filter((question) => question.chapter === "导论" && question.type === "单选").slice(0, 2);
      const sid = crypto.randomUUID();
      const session = { sid, ids: pool.map((question) => question.id), index: 0, mode: "chapter-test",
        bankScope: "all", routePlan: { chapter: "导论", kind: "test" }, selected: [], results: {}, drafts: {}, updatedAt: 999 };
      const selected = [pool[1].answer[0]];
      await guestStore.accept({ rows: [
        { kind: "draft", record_key: sid, revision: 300, change_id: crypto.randomUUID(),
          payload: closed ? null : { ...session, index: 1, selected, updatedAt: 1 } },
        { kind: "session", record_key: "resume", revision: 200, change_id: crypto.randomUUID(), payload: session },
      ] });
      return { sid, questionId: pool[1].id, selected };
    }, deleted);
    await page.reload(); await ready(page);
    await page.evaluate(() => startChapterTest("导论", "all"));
    const resumed = await page.evaluate(() => ({ sid: state.session.sid, questionId: current().id,
      selected: state.session.selected.slice() }));
    if (deleted) assert.notEqual(resumed.sid, saved.sid, "a closed draft must not reappear through the old resume record");
    else assert.deepEqual(resumed, saved);
  }
});

test("a submitted exam appends one event per answer and retains its result independently", async (t) => {
  const ctx = await context(t); const page = await ctx.newPage();
  await page.goto(origin + "/docs/index.html"); await ready(page);
  await page.evaluate(() => {
    const item = questions.find((question) => question.chapter === "导论" && question.type === "单选");
    start([item.id], "chapter-test", { bankScope: "all", routePlan: { chapter: "导论", kind: "test" } });
    choose(item.answer[0]);
  });
  await page.locator("#submit").click();
  await page.evaluate(() => guestWrites);
  const before = await page.evaluate(async () => ({ test: state.chapterTests["all:导论"], attempts: (await guestStore.attempts()).length }));
  assert.equal(before.test.correct, 1); assert.equal(before.test.total, 1); assert.equal(before.attempts, 1);
  await page.evaluate(() => openChapter("第二章", { bank: "all" }));
  await page.evaluate(() => guestWrites);
  await page.reload(); await ready(page);
  const after = await page.evaluate(async () => ({ test: state.chapterTests["all:导论"], attempts: (await guestStore.attempts()).length }));
  assert.deepEqual(after, before);
});

test("optional assistant and feedback initialization failures do not prevent offline study", async (t) => {
  const ctx = await context(t); const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/docs/index.html?fault=optional"); await ready(page);
  await page.evaluate(() => openChapter("导论", { bank: "all" }));
  await page.locator("#options .option").first().click();
  await page.evaluate(() => guestWrites);
  assert.ok(await page.locator("#question").textContent());
  assert.equal(await page.locator("#quiz-tutor-open").isVisible(), false);
  assert.deepEqual(errors, []);
});

test("wrong-book codes import a separate persistent practice set", async (t) => {
  const sender = await (await context(t)).newPage();
  await sender.goto(origin + "/docs/index.html");
  await ready(sender);
  const ids = await sender.evaluate(() => {
    const items = questions.filter((item) => requiresAnswer(item.id) && sharedQuestionId(item.id) === item.id).slice(0, 2);
    state.history[items[0].id] = { wrong: true };
    state.history[items[1].id] = { wrong: false };
    showTab("wrong");
    return items.map((item) => item.id);
  });
  await sender.locator("#wrong-share").click();
  await sender.locator("#wrong-share-dialog[open]").waitFor();
  const code = await sender.locator("#wrong-share-code").inputValue();
  assert.match(code, /^XQ1-/);
  await sender.locator("#wrong-share-dialog button").last().click();
  await sender.locator(".chapter-review-start").click();
  assert.deepEqual(await sender.evaluate(() => state.session.ids), [ids[0]]);

  const recipient = await (await context(t)).newPage();
  await recipient.goto(origin + "/docs/index.html");
  await ready(recipient);
  await recipient.evaluate(() => showTab("wrong"));
  await recipient.locator("#wrong-import").click();
  await recipient.locator("#wrong-share-code").fill(code);
  await recipient.locator("#wrong-share-save").click();
  await recipient.waitForFunction(() => document.querySelector("#wrong-share-status").textContent.includes("已导入 1 道题"));
  await recipient.reload();
  await ready(recipient);
  await recipient.evaluate(() => showTab("wrong"));
  await recipient.locator("#wrong-imported-list button").click();
  assert.deepEqual(await recipient.evaluate(() => state.session.ids), [ids[0]]);
  assert.deepEqual(await recipient.evaluate(() => Object.keys(state.history)), []);
});

test("every chapter starts its own first round and only its missed questions advance", async (t) => {
  const page = await (await context(t)).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/docs/index.html");
  await ready(page);
  const fixture = await page.evaluate(async () => {
    const chapter = "第一章";
    const bank = "sizheng";
    const pool = chapterQuestions(chapter, bank).filter(({ id }) => requiresAnswer(id));
    const ids = pool.filter(({ type }) => type === "单选").slice(0, 4).map(({ id }) => id);
    const sameBank = chapterQuestions("第二章", bank).find(({ id, type }) => requiresAnswer(id) && type === "单选").id;
    const keys = new Set(pool.map(({ id }) => sharedQuestionId(id)));
    const otherBank = chapterQuestions(chapter, "xuexitong").find(({ id }) => requiresAnswer(id) && !keys.has(sharedQuestionId(id))).id;
    const later = pool.find(({ id, type }) => type === "单选" && !ids.includes(id)).id;
    const oldReview = { sid: "wrong-book:all:", ids: [...ids, sameBank], mode: "practice", index: 1,
      results: {}, selected: [],
      bankScope: "all", wrongBookReview: true, wrongBookRound: 1 };
    await guestStore.commit([
      ...pool.map(({ id, answer }) => ["history", sharedQuestionId(id), { wrong: ids.includes(id), selected: answer }]),
      ["history", sharedQuestionId(otherBank), { wrong: true }],
      ["history", sharedQuestionId(sameBank), { wrong: true }],
      ["star", sameBank, true],
      ["note", sameBank, "保留的笔记"],
      ["draft", oldReview.sid, oldReview],
      ["session", "resume", oldReview],
    ]);
    await restoreGuestState();
    return { chapter, bank, ids, sameBank, otherBank, later };
  });
  const bank = page.locator("#wrong-bank");
  const chapter = page.locator(`[data-review-chapter="${fixture.chapter}"]`);
  const startChapter = chapter.locator(".chapter-review-start");
  const chapterDetails = chapter.locator(".chapter-review-detail");
  const startSecondChapter = page.locator('[data-review-chapter="第二章"] .chapter-review-start');
  const review = page.locator("#library-start");
  const retry = page.locator("#retry");
  const back = page.locator("#back");
  const openWrongBook = async () => {
    await page.locator('#mobile-tabs [data-study-tab="wrong"]').click();
    await bank.selectOption(fixture.bank);
  };
  const roundIds = () => page.evaluate(() => state.session.ids);

  assert.equal(await page.locator("#resume").isVisible(), false, "a legacy whole-book draft does not surface as the route resume");
  await openWrongBook();
  assert.equal(await page.locator("#wrong-book-review").count(), 0);
  assert.match(await startSecondChapter.textContent(), /开始第 1 轮（1 道）/);
  assert.match(await startChapter.textContent(), /开始第 1 轮（4 道）/);
  await startChapter.click();
  assert.deepEqual(await roundIds(), fixture.ids);
  assert.match(await page.locator("#quiz-completion").textContent(), /第 1 轮 · 已答 0 \/ 4/);

  const answer = (correct, advance = true) => page.evaluate(({ right, advance }) => {
    const item = current();
    const letters = right ? item.answer : [Object.keys(item.options).find((letter) => !item.answer.includes(letter))];
    for (const letter of letters) choose(letter);
    if (!questionResult(state.session, item.id)) document.getElementById("submit").click();
    if (advance) moveQuestion(1);
  }, { right: correct, advance });
  await answer(true);
  await back.click();
  assert.match(await review.textContent(), /继续第 1 轮（1\/4）/);
  await page.locator("#library-back").click();
  assert.match(await startChapter.textContent(), /继续第 1 轮（1\/4）/);
  await startSecondChapter.click();
  assert.deepEqual(await roundIds(), [fixture.sameBank]);
  assert.match(await page.locator("#quiz-completion").textContent(), /第 1 轮 · 已答 0 \/ 1/);
  await back.click();
  await page.locator("#library-back").click();
  await bank.selectOption("xuexitong");
  await startChapter.click();
  assert.deepEqual(await roundIds(), [fixture.otherBank]);
  await back.click();
  await page.locator("#library-back").click();
  await bank.selectOption(fixture.bank);
  await startChapter.click();
  assert.equal(await page.evaluate(() => current().id), fixture.ids[1]);
  await answer(false);
  await answer(true);
  await answer(false, false);
  assert.match(await page.locator("#quiz-completion").textContent(), /还错 2 道，即将进入下一轮/);
  await page.evaluate((id) => { state.history[sharedQuestionId(id)].review = false; }, fixture.ids[3]);
  await page.waitForFunction(() => state.session.wrongBookRound === 2);
  assert.deepEqual(await roundIds(), [fixture.ids[1], fixture.ids[3]], "round grading retains every missed question despite a changed library marker");

  // An unrelated answer and reload must not restart the chapter review.
  await back.click();
  await page.evaluate((id) => {
    start([id], "practice");
    const item = current();
    choose(Object.keys(item.options).find((letter) => !item.answer.includes(letter)));
    submit();
    return guestWrites;
  }, fixture.later);
  await page.reload();
  await ready(page);
  await openWrongBook();
  assert.match(await startChapter.textContent(), /继续第 2 轮（0\/2）/);
  await chapterDetails.click();
  assert.match(await review.textContent(), /继续第 2 轮（0\/2）/);
  await review.click();
  assert.deepEqual(await roundIds(), [fixture.ids[1], fixture.ids[3]]);
  await answer(false);
  await answer(true, false);
  await page.waitForFunction(() => state.session.wrongBookRound === 3);
  assert.deepEqual(await roundIds(), [fixture.ids[1]]);
  await answer(true);
  assert.equal(await page.locator("#result-title").textContent(), "本轮错题已清空");
  assert.equal(await retry.isVisible(), false);
  assert.deepEqual(await page.locator("#result-wrong-history li").allTextContents(),
    ["原始错题 4 道", "第 1 轮后剩 2 道", "第 2 轮后剩 1 道", "第 3 轮后剩 0 道"]);
  const snapshots = [fixture.ids, [fixture.ids[1], fixture.ids[3]], [fixture.ids[1]], []];
  const dialog = page.locator("#wrong-round-questions");
  for (const [index, expected] of snapshots.entries()) {
    await page.locator("#result-wrong-history button").nth(index).click();
    assert.equal(await dialog.isVisible(), true);
    assert.deepEqual(await dialog.locator("[data-question-id]").evaluateAll((buttons) => buttons.map((button) => button.dataset.questionId)), expected);
    await dialog.getByRole("button", { name: "返回", exact: true }).click();
  }
  await page.locator("#again").click();
  assert.deepEqual(await page.locator("#chapter-wrong-history li").allTextContents(),
    ["原始错题 4 道", "第 1 轮后剩 2 道", "第 2 轮后剩 1 道", "第 3 轮后剩 0 道"]);
  assert.match(await review.textContent(), /开始第 1 轮（1 道）/);
  await review.click();
  assert.deepEqual(await roundIds(), [fixture.later]);
  await answer(true);
  assert.equal(await page.locator("#result-title").textContent(), `${fixture.chapter} · 已通过`);
  assert.equal(await page.locator("#result").getAttribute("data-review-cleared"), "true");
  await page.locator("#again").click();
  assert.match(await page.locator('#chapter-study-steps [data-status="passed"]').last().textContent(), /错题复练已通过/);
  assert.equal(await review.isVisible(), false);

  const replay = page.getByRole("button", { name: "重刷本章", exact: true });
  await replay.click();
  assert.deepEqual(await roundIds(), fixture.ids, "replay always starts from the original chapter set");
  assert.match(await page.locator("#quiz-completion").textContent(), /第 1 轮 · 已答 0 \/ 4/);
  const replaySid = await page.evaluate(() => state.session.sid);
  await answer(true);
  await back.click();
  await replay.click();
  assert.notEqual(await page.evaluate(() => state.session.sid), replaySid, "two replays have independent drafts");
  assert.deepEqual(await roundIds(), fixture.ids);
  await answer(false);
  for (let i = 1; i < fixture.ids.length; i++) await answer(true);
  assert.deepEqual(await roundIds(), [fixture.ids[0]]);
  await answer(true);
  await page.locator("#again").click();
  await page.evaluate(() => guestWrites);
  await page.reload();
  await ready(page);
  await openWrongBook();
  await chapterDetails.click();
  assert.equal(await page.locator("#chapter-review-run-title").textContent(), "第 4 次复练");
  assert.deepEqual(await page.locator("#chapter-wrong-history li").allTextContents(),
    ["原始错题 4 道", "第 1 轮后剩 1 道", "第 2 轮后剩 0 道"]);
  const originalRun = page.locator("#chapter-review-previous details").nth(0);
  await originalRun.locator("summary").click();
  for (const [index, expected] of snapshots.entries()) {
    await originalRun.locator("ol button").nth(index).click();
    assert.deepEqual(await dialog.locator("[data-question-id]").evaluateAll((buttons) => buttons.map((button) => button.dataset.questionId)), expected);
    await dialog.getByRole("button", { name: "返回", exact: true }).click();
  }
  const pausedRun = page.locator("#chapter-review-previous details").nth(2);
  await pausedRun.locator("summary").click();
  await pausedRun.getByRole("button", { name: "继续第 1 轮（1/4）" }).click();
  assert.equal(await page.evaluate(() => state.session.sid), replaySid);
  assert.equal(await page.evaluate(() => current().id), fixture.ids[1]);
  for (let i = 1; i < fixture.ids.length; i++) await answer(true);
  await page.locator("#again").click();

  await page.locator("#library-back").click();
  assert.equal(await chapter.getAttribute("data-passed"), "true");
  assert.equal(await startChapter.count(), 0);
  assert.match(await startSecondChapter.textContent(), /继续第 1 轮（0\/1）/);
  assert.deepEqual(await page.evaluate(({ sameBank, otherBank }) => ({
    otherWrong: inWrongLibrary(otherBank), otherChapterWrong: inWrongLibrary(sameBank),
    star: isStarred(sameBank), note: state.notes[sameBank],
  }), fixture), { otherWrong: true, otherChapterWrong: true, star: true, note: "保留的笔记" });
  assert.deepEqual(errors, []);
});

test("the original whole-book snapshot restores chapter questions and already graded first-round answers", async (t) => {
  const page = await (await context(t)).newPage();
  await page.goto(origin + "/docs/index.html");
  await ready(page);
  const fixture = await page.evaluate(async () => {
    const chapter = "新增（必刷）";
    const ids = chapterQuestions(chapter, "all").filter(({ type }) => type === "单选").slice(0, 4).map(({ id }) => id);
    const another = chapterQuestions("导论", "all").find(({ id }) => requiresAnswer(id)).id;
    const sid = crypto.randomUUID();
    const [correct, wrong] = ids;
    const draft = { sid, ids: [another, ...ids], mode: "practice", index: 3, selected: [], wrongBookReview: true,
      results: { [correct]: { correct: true, selected: byId.get(correct).answer }, [wrong]: { correct: false, selected: ["B"] } } };
    await guestStore.commit([
      ...[...ids, another].map((id) => ["history", sharedQuestionId(id), { wrong: id !== correct }]),
      ["draft", sid, draft],
    ]);
    await restoreGuestState();
    showTab("wrong");
    return { chapter, ids, correct, wrong };
  });
  const card = page.locator(`[data-review-chapter="${fixture.chapter}"]`);
  assert.match(await page.locator("#library-count").textContent(), /原始 5 道 · 当前 4 道/);
  assert.match(await card.locator(".chapter-review-start").textContent(), /继续第 1 轮（2\/4）/);
  await card.locator(".chapter-review-start").click();
  assert.deepEqual(await page.evaluate(() => state.session.ids), fixture.ids);
  assert.equal(await page.evaluate(() => state.session.ids[state.session.index]), fixture.ids[2]);
  assert.deepEqual(await page.evaluate(({ correct, wrong }) => [state.session.results[correct].correct, state.session.results[wrong].correct], fixture),
    [true, false]);
  await page.locator("#back").click();
  assert.deepEqual(await page.locator("#chapter-wrong-history li").allTextContents(), ["原始错题 4 道"]);
  assert.equal(await page.locator("#wrong-restart-original").count(), 0);
  await page.locator("#chapter-wrong-history button").click();
  const dialog = page.locator("#wrong-round-questions");
  assert.deepEqual(await dialog.locator("[data-question-id]").evaluateAll((buttons) => buttons.map((button) => button.dataset.questionId)), fixture.ids);
  await dialog.locator("[data-question-id]").first().click();
  assert.equal(await page.locator("#history-question").isVisible(), true);
  assert.equal(await page.locator("#history-question-redo").isVisible(), false);
  await page.locator("#history-question-close").click();
  await dialog.getByRole("button", { name: "返回", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => state.session.ids), fixture.ids);
  assert.equal(await page.evaluate(() => Object.keys(state.session.results).length), 2);
  assert.equal(await page.evaluate((id) => historyEntry(id).wrong, fixture.correct), false);
});
