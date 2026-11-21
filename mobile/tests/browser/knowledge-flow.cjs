// Runs against the built APP page. All learning records below are synthetic;
// production requests are blocked for the entire browser context.
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
      const path = resolve(root, "." + decodeURIComponent(url.pathname));
      if (!path.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
      let bytes = await readFile(path);
      if (url.searchParams.has("knowledge-account-fixture")) {
        const html = bytes.toString();
        const marker = html.match(/<script\b[^>]*>\s*"use strict";\s*const allQuestions\b/)?.[0];
        assert.ok(marker, "the built page must retain the practice module for the account fixture");
        bytes = Buffer.from(html.replace(marker, `<script>
          window.QuizAccount = {connect(callbacks) {
            window.knowledgeAccountFixture = callbacks;
            return {enabled: () => false, queue: async () => true,
              deskRpc: async () => ({data: null}),
              deskProgressSubscribe: () => () => {}, arenaSubscribe: () => () => {}};
          }};
          </script>\n` + marker));
      }
      if (url.searchParams.has("knowledge-no-canvas")) {
        const html = bytes.toString();
        const marker = html.match(/<script\b[^>]*>\s*"use strict";\s*const allQuestions\b/)?.[0];
        assert.ok(marker, "the built page must retain the practice module for the canvas fixture");
        bytes = Buffer.from(html.replace(marker, `<script>
          const originalKnowledgeContext = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function(type, ...options) {
            if (this.id === 'knowledge-canvas' && type === '2d') return null;
            return originalKnowledgeContext.call(this, type, ...options);
          };
          </script>\n` + marker));
      }
      response.setHeader("Content-Type", ({ ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
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

async function open(t, suffix = "") {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await context.route("https://**", (route) => route.abort());
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/docs/index.html" + suffix);
  await ready(page);
  return { page, errors };
}

function ready(page) {
  return page.waitForFunction(() => document.documentElement.dataset.studyReady === "true");
}

function enterKnowledge(page) {
  return page.locator('#mobile-tabs [data-study-tab="knowledge"]').click();
}

function summary(page) {
  return page.evaluate(() => {
    const model = window.QuizKnowledgeModel.create({ questions: window.QuizData, catalog: window.QuizKnowledgeCatalog });
    const snapshot = model.snapshot({ historyEntry, inWrongLibrary });
    return {
      reviewIds: snapshot.questions.filter((item) => item.inWrongLibrary).map((item) => item.id).sort(),
      wrongIds: snapshot.questions.filter((item) => item.wrong).map((item) => item.id).sort(),
    };
  });
}

test("the Knowledge tab is a mobile destination with searchable graph, cards and analysis for a new learner", async (t) => {
  const { page, errors } = await open(t);
  assert.deepEqual(await page.locator('#mobile-tabs [data-study-tab]').evaluateAll((buttons) =>
    buttons.map((button) => button.dataset.studyTab)), ["practice", "wrong", "knowledge", "desk", "profile"]);
  await enterKnowledge(page);
  assert.equal(await page.locator("#knowledge").isVisible(), true);
  assert.equal(await page.locator("#setup").isVisible(), false);
  assert.equal(await page.locator('#mobile-tabs [data-study-tab="knowledge"]').getAttribute("aria-current"), "page");
  assert.deepEqual(await summary(page), { reviewIds: [], wrongIds: [] });

  await page.locator("#knowledge-scope").selectOption("all");
  const fixture = await page.evaluate(() => {
    const model = window.QuizKnowledgeModel.create({ questions: window.QuizData, catalog: window.QuizKnowledgeCatalog });
    const node = model.snapshot({ historyEntry, inWrongLibrary }).nodes.find((item) =>
      item.kind === "concept" && item.questionIds.length && item.recall.length);
    if (!node) throw new Error("The generic catalog must expose a concept with recall facts and public questions.");
    return { id: node.id, title: node.title, chapter: node.chapter, fact: node.recall[0] };
  });
  await page.locator("#knowledge-search").fill(fixture.title);
  await page.locator("#knowledge-list-toggle").click();
  const item = page.locator(`#knowledge-list [data-knowledge-concept="${fixture.id}"]`);
  await item.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.knowledgeConcept), fixture.id,
    "keyboard activation must retain focus on the replacement list button");
  assert.ok((await page.locator("#knowledge-detail").textContent()).includes(fixture.title));
  await page.locator('[data-knowledge-view="cards"]').click();
  await page.locator("#knowledge-card-reveal").click();
  assert.equal(await page.locator("#knowledge-cards-view").getByText(fixture.fact, { exact: true }).first().isVisible(), true);
  await page.locator('[data-knowledge-view="graph"]').click();
  await page.locator("#knowledge-list-toggle").click();
  assert.equal(await page.locator("#knowledge-canvas").isVisible(), true);
  await page.locator("#knowledge-canvas").scrollIntoViewIfNeeded();
  const canvas = await page.locator("#knowledge-canvas").boundingBox();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width / 2 + 35, canvas.y + canvas.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  assert.equal(await page.locator("#quiz").isVisible(), false, "dragging a graph must not trigger the question swipe surface");
  await page.locator('[data-knowledge-view="analysis"]').click();
  assert.equal(await page.locator("#knowledge").isVisible(), true);

  await page.setViewportSize({ width: 320, height: 740 });
  await page.locator('[data-knowledge-view="cards"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true,
    "knowledge cards must fit the smallest supported mobile viewport");
  assert.deepEqual(errors, []);
});

test("a missing canvas context falls back to an accessible list and keeps knowledge cards usable", async (t) => {
  const { page, errors } = await open(t, "?knowledge-no-canvas=1");
  await enterKnowledge(page);
  await page.locator("#knowledge-scope").selectOption("all");
  assert.equal(await page.locator("#knowledge-list").isVisible(), true);
  assert.equal(await page.locator("#knowledge-list-toggle").isDisabled(), true);
  assert.equal(await page.locator("#knowledge-canvas").isVisible(), false);
  const first = page.locator("#knowledge-list [data-knowledge-concept]").first();
  const concept = await first.getAttribute("data-knowledge-concept");
  await first.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.knowledgeConcept), concept);
  assert.ok((await page.locator("#knowledge-detail").textContent()).trim());
  await page.locator('[data-knowledge-view="cards"]').click();
  await page.locator("#knowledge-card-reveal").click();
  assert.equal(await page.locator("#knowledge-card-answer").isVisible(), true);
  assert.deepEqual(errors, []);
});

test("concept practice uses the existing account store, clears answered wrongs and preserves an unfinished exam", async (t) => {
  const { page, errors } = await open(t);
  const fixture = await page.evaluate(async () => {
    const model = window.QuizKnowledgeModel.create({ questions: window.QuizData, catalog: window.QuizKnowledgeCatalog });
    const node = model.snapshot({ historyEntry, inWrongLibrary }).nodes.find((item) => item.kind === "concept" &&
      item.questionIds.filter((id) => byId.get(id)?.type === "单选").length >= 2);
    if (!node) throw new Error("The catalog must contain a concept linking at least two single-choice questions.");
    const ids = node.questionIds.filter((id) => byId.get(id)?.type === "单选").slice(0, 2);
    startChapterTest("导论", "all");
    choose(Object.keys(current().options)[0]);
    await guestWrites;
    const exam = { sid: state.session.sid, selected: [...state.session.selected] };
    await guestStore.commit([
      ["history", sharedQuestionId(ids[0]), { wrong: true, last: 10, selected: [] }],
      ["history", sharedQuestionId(ids[1]), { wrong: false, review: true, last: 11, selected: byId.get(ids[1]).answer }],
    ]);
    await restoreGuestState();
    document.getElementById("auto-advance-delay").value = "0";
    return { id: node.id, title: node.title, ids, exam };
  });
  await enterKnowledge(page);
  await page.locator("#knowledge-search").fill(fixture.title);
  await page.locator("#knowledge-list-toggle").click();
  await page.locator(`#knowledge-list [data-knowledge-concept="${fixture.id}"]`).click();
  assert.deepEqual(await summary(page), { reviewIds: [...fixture.ids].sort(), wrongIds: [fixture.ids[0]] });
  await page.locator("#knowledge-practice").click();
  assert.equal(await page.locator("#quiz").isVisible(), true);
  assert.match(await page.locator("#back").textContent(), /知识/);
  const started = await page.evaluate(() => ({
    ids: [...state.session.ids].sort(), knowledgePractice: state.session.knowledgePractice,
    answered: Boolean(questionResult(state.session, current().id)),
    drafts: Object.fromEntries(Object.entries(state.drafts).map(([sid, value]) => [sid, value.selected])),
  }));
  assert.deepEqual(started.ids, [...fixture.ids].sort());
  assert.equal(started.knowledgePractice, true);
  assert.equal(started.answered, false, "reviewing a previously answered question must start a fresh attempt");
  assert.deepEqual(started.drafts[fixture.exam.sid], fixture.exam.selected);

  for (let index = 0; index < fixture.ids.length; index++) {
    const answerIndex = await page.evaluate(() => Object.keys(current().options).indexOf(current().answer[0]));
    await page.locator("#options .option").nth(answerIndex).click();
    if (!await page.evaluate(() => Boolean(questionResult(state.session, current().id)))) await page.locator("#submit").click();
    await page.keyboard.press("ArrowRight");
  }
  assert.equal(await page.locator("#result").isVisible(), true);
  await page.locator("#again").click();
  assert.equal(await page.locator("#knowledge").isVisible(), true);
  await page.evaluate(() => guestWrites);
  assert.deepEqual(await summary(page), { reviewIds: [], wrongIds: [] });
  const attempts = await page.evaluate(async () => (await guestStore.attempts()).map((attempt) => attempt.question_id).sort());
  assert.deepEqual(attempts, [...fixture.ids].sort(), "one real answer event is retained for each practiced question");

  await page.reload(); await ready(page);
  await enterKnowledge(page);
  assert.deepEqual(await summary(page), { reviewIds: [], wrongIds: [] });
  const resumed = await page.evaluate(() => {
    startChapterTest("导论", "all");
    return { sid: state.session.sid, selected: [...state.session.selected] };
  });
  assert.deepEqual(resumed, fixture.exam);
  assert.deepEqual(errors, []);
});

test("switching accounts clears the visible personal graph before another account or guest history arrives", async (t) => {
  const { page, errors } = await open(t, "?knowledge-account-fixture=1");
  await enterKnowledge(page);
  const ids = await page.evaluate(() => {
    const model = window.QuizKnowledgeModel.create({ questions: window.QuizData, catalog: window.QuizKnowledgeCatalog });
    return model.snapshot({ historyEntry, inWrongLibrary }).questions.slice(0, 2).map((item) => item.id);
  });
  assert.equal(ids.length, 2);
  await page.evaluate((id) => {
    knowledgeAccountFixture.accountChanged("knowledge-fixture-a");
    knowledgeAccountFixture.receive({ history: { [id]: { wrong: true, last: 10 } }, stars: {}, notes: {},
      session: null, drafts: {}, chapterTests: {} }, true);
  }, ids[0]);
  assert.deepEqual((await summary(page)).reviewIds, [ids[0]]);
  assert.ok(await page.locator("#knowledge-list [data-knowledge-concept]").count());

  const transition = await page.evaluate(() => {
    knowledgeAccountFixture.accountChanged("knowledge-fixture-b");
    const detail = document.getElementById("knowledge-detail");
    return { inert: document.querySelector("main").inert,
      nodes: document.querySelectorAll("#knowledge-list [data-knowledge-concept]").length,
      detailCleared: detail.hidden || !detail.textContent.trim() };
  });
  assert.equal(transition.inert, true);
  assert.equal(transition.nodes, 0, "old-account concepts must be removed during the switch");
  assert.equal(transition.detailCleared, true, "old-account details must be cleared before new data arrives");
  await page.evaluate((id) => {
    knowledgeAccountFixture.receive({ history: { [id]: { wrong: true, last: 20 } }, stars: {}, notes: {},
      session: null, drafts: {}, chapterTests: {} }, true);
  }, ids[1]);
  assert.deepEqual((await summary(page)).reviewIds, [ids[1]]);
  assert.equal(await page.locator("#knowledge").isVisible(), true);
  await page.evaluate(async () => {
    knowledgeAccountFixture.accountChanged(null);
    await knowledgeAccountFixture.guest();
  });
  assert.deepEqual(await summary(page), { reviewIds: [], wrongIds: [] });
  assert.equal(await page.evaluate(() => document.querySelector("main").inert), false);
  assert.deepEqual(errors, []);
});
