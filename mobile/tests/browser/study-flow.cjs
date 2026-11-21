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
