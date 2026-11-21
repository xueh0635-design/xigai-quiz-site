const test = require("node:test");
const assert = require("node:assert/strict");
const { create, questionFingerprint } = require("../web/scripts/knowledge-model.js");
const questions = require("../content/questions.json");
const catalog = require("../content/knowledge-concepts.json");
const questionCatalog = require("../web/scripts/question-catalog.js");

function item(id, stem, options = { A: "正确", B: "错误" }, answer = ["A"], extra = {}) {
  return { id, chapter: "测试章", type: "单选", stem, options, answer,
    review_status: "可练习", ...extra };
}
const smallCatalog = {
  concepts: [{ id: "core", title: "核心概念", chapter: "测试章", keywords: ["核心概念"],
    recall: ["一个事实"], distinctions: ["一个区别"] },
  { id: "other", title: "另一概念", chapter: "其他章", keywords: ["旁支理论"] }],
  relations: [{ source: "core", target: "other", type: "区分", label: "比较" },
    { source: "core", target: "missing", type: "支撑", label: "invalid" }],
};

test("catalog associates every canonical answerable question, with explicit chapter fallback", () => {
  const model = create({ questions, catalog });
  const snapshot = model.snapshot();
  const ids = new Set(snapshot.questions.map((question) => question.id));
  const expectedIds = new Set(questionCatalog.canonicalRows(questions)
    .filter((row) => row.answerable).map((row) => row.canonicalId));
  assert.deepEqual(ids, expectedIds);
  assert.equal(snapshot.stats.totalQuestions, 1585);
  assert.equal(snapshot.stats.reviewQuestions, 0);
  assert.equal(snapshot.stats.activeConceptCount, 0);
  assert(snapshot.stats.mappedQuestions > 0);
  assert(snapshot.stats.unmappedQuestions > 0);
  assert.equal(snapshot.stats.mappedQuestions + snapshot.stats.unmappedQuestions, 1585);
  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
  for (const question of snapshot.questions) {
    assert(question.conceptIds.length > 0);
    assert(question.conceptIds.every((id) => nodeIds.has(id)));
    if (question.mapping.status === "chapter") {
      assert.equal(question.conceptIds.length, 1);
      const fallback = snapshot.nodes.find((node) => node.id === question.conceptIds[0]);
      assert.equal(fallback.needsMapping, true);
      assert.equal(fallback.kind, "chapter");
    }
  }
  assert(snapshot.edges.every((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)));
  // This is a reusable catalog, not a saved account's question or history export.
  for (const concept of catalog.concepts) {
    assert.deepEqual(Object.keys(concept).filter((key) => /questionIds|history|selected|wrong|retained|reviewCount/i.test(key)), []);
    assert(concept.recall.length > 0 && concept.keywords.length > 0);
  }
});

test("account snapshots use current review flags, distinguish retained correct answers, and do not persist a prior account", () => {
  const model = create({ questions: [item("a", "核心概念一"), item("b", "核心概念二"),
    item("c", "核心概念三"), item("d", "未细分内容")], catalog: smallCatalog });
  const history = {
    a: { wrong: true, last: 100 }, b: { wrong: false, review: true, last: 200 },
    c: { wrong: true, review: false, last: 300 }, d: { wrong: true, last: 400 },
  };
  const current = model.snapshot({ historyEntry: (id) => history[id] });
  const node = current.nodes.find((node) => node.id === "core");
  assert.deepEqual(node.wrongIds, ["a"]);
  assert.deepEqual(node.retainedIds, ["b"]);
  assert.deepEqual(node.reviewIds, ["a", "b"]);
  assert.equal(node.attemptedCount, 3);
  assert.equal(node.questionCount, 3);
  assert.equal(current.stats.reviewQuestions, 3);
  assert.equal(current.stats.wrongQuestions, 2);
  assert.equal(current.stats.retainedQuestions, 1);
  assert.equal(current.stats.unmappedReviewQuestions, 1);
  node.reviewIds.push("private"); node.recall[0] = "changed";
  const nextAccount = model.snapshot();
  assert.equal(nextAccount.stats.reviewQuestions, 0);
  assert.equal(nextAccount.stats.activeConceptCount, 0);
  assert.deepEqual(nextAccount.nodes.find((node) => node.id === "core").recall, ["一个事实"]);
  assert(nextAccount.nodes.every((node) => !node.reviewIds.length));
});

test("shared questions resolve one canonical node and latest alias history without duplicate weakness counts", () => {
  const first = item("a", "核心概念", { A: "是", B: "否" }, ["A"], { source: "思政云" });
  const second = item("b", "核心概念", { A: "否", B: "是" }, ["B"], { source: "学习通" });
  const model = create({ questions: [first, second], catalog: smallCatalog });
  const history = { a: { wrong: true, last: 10 }, b: { wrong: false, review: true, last: 20 } };
  const current = model.snapshot({ historyEntry: (id) => history[id] });
  assert.equal(current.stats.totalQuestions, 1);
  assert.equal(current.stats.wrongQuestions, 0);
  assert.equal(current.stats.retainedQuestions, 1);
  assert.equal(model.getQuestion("b").id, "a");
  assert.deepEqual(model.conceptsForQuestion("b"), model.conceptsForQuestion("a"));
  assert.deepEqual(current.nodes.find((node) => node.id === "core").reviewIds, ["a"]);
  const overridden = model.snapshot({ historyEntry: (id) => history[id], inWrongLibrary: () => false });
  assert.equal(overridden.stats.reviewQuestions, 0);
});

test("distractors, explanation mentions, and incidental cross-chapter phrases do not create concept evidence", () => {
  const pool = [item("distractor", "未细分内容", { A: "正确", B: "核心概念" }, ["A"],
    { study: { explanation: "核心概念不适用" } }),
  item("wrong-chapter", "旁支理论出现过", { A: "是", B: "否" }),
  item("answer", "哪一个是关键？", { A: "核心概念", B: "其他" }),
  item("reading", "核心概念", {}, ["词语"], { type: "填空" })];
  const model = create({ questions: pool, catalog: smallCatalog });
  assert.equal(model.getQuestion("distractor").mapping.status, "chapter");
  assert.equal(model.getQuestion("wrong-chapter").mapping.status, "chapter");
  assert.equal(model.getQuestion("answer").mapping.status, "matched");
  assert.equal(model.getQuestion("answer").mapping.evidence[0].field, "answer");
  assert.equal(model.getQuestion("reading"), null);
  assert.equal(model.snapshot().edges.length, 1);
});

test("shipping rules keep superficially similar public questions in their curriculum subject", () => {
  const model = create({ questions, catalog });
  assert(!model.conceptsForQuestion("第十四章-28").includes("c16"), "military personnel are not education-science innovation");
  assert(!model.conceptsForQuestion("章节自测-第七章-单选-1").includes("b24"), "education history is not reform-policy knowledge");
  assert(model.conceptsForQuestion("第九章-50").includes("c33"), "legal-system components are represented");
});

test("editorial cautions stay visible and count in the wrong book, but cannot enter knowledge practice", () => {
  const first = item("a", "核心概念", { A: "是", B: "否" }, ["A"], { source: "思政云" });
  const alias = item("b", "核心概念", { A: "否", B: "是" }, ["B"], { source: "学习通" });
  const clean = item("c", "核心概念的另一问题");
  const fixture = { ...smallCatalog, cautions: [{ questionId: "b", reason: "需要核对题干条件",
    questionFingerprint: questionFingerprint(alias) }] };
  const model = create({ questions: [first, alias, clean], catalog: fixture });
  const snapshot = model.snapshot({ historyEntry: () => ({ wrong: true, last: 10 }) });
  assert.equal(snapshot.stats.totalQuestions, 2);
  assert.equal(snapshot.stats.reviewQuestions, 2);
  assert.equal(snapshot.stats.wrongQuestions, 2);
  assert.equal(snapshot.stats.blockedReviewQuestions, 1);
  assert.equal(model.getQuestion("a").caution.reason, "需要核对题干条件");
  assert.equal(model.getQuestion("b").caution.questionId, "b");
  const node = snapshot.nodes.find((node) => node.id === "core");
  assert.deepEqual(node.questionIds, ["a", "c"]);
  assert.deepEqual(node.wrongIds, ["a", "c"]);
  assert.deepEqual(node.blockedIds, ["a"]);
  assert.deepEqual(node.practiceIds, ["c"]);
  assert.deepEqual(node.practiceReviewIds, ["c"]);
  assert.equal(snapshot.questions.find((question) => question.id === "a").inWrongLibrary, true);
  const revised = create({ questions: [{ ...alias, stem: "修订后的核心概念问题" }], catalog: fixture });
  assert.equal(revised.getQuestion("b").caution, null, "old editorial metadata cannot silently block revised content");
});

test("the public caution list still matches the exact shipped question wording and answer keys", () => {
  const model = create({ questions, catalog });
  assert.equal(catalog.cautions.length, 14);
  for (const caution of catalog.cautions) {
    const source = questions.find((question) => question.id === caution.questionId);
    assert(source, `${caution.questionId}: source must exist`);
    assert.equal(caution.questionFingerprint, questionFingerprint(source), `${caution.questionId}: recheck the caution after editing its source`);
    assert.equal(model.getQuestion(caution.questionId).caution.reason, caution.reason);
  }
  assert.equal(model.snapshot().stats.blockedQuestions, 14);
});
