/* Public knowledge definitions + account-scoped history, without a second progress store. */
((root, factory) => {
  const api = factory(typeof module === "object" && module.exports
    ? require("./question-catalog.js") : root.QuizQuestionCatalog);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QuizKnowledgeModel = api;
})(typeof window === "object" ? window : globalThis, (questionCatalog) => {
  "use strict";

  // Matching deliberately excludes distractors and the explanatory prose, which
  // often mention concepts only to reject or contrast them. It is an association
  // heuristic, never a diagnosis of why a learner selected a particular answer.
  const normalize = (text) => String(text || "").normalize("NFKC")
    .toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "").replace(/的/g, "");

  // A small change detector, not a security hash. Editorial cautions must be
  // rechecked when a question's wording/options/answer change in a later bank.
  function questionFingerprint(item) {
    const text = JSON.stringify([item?.stem, item?.options, item?.answer]);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function create({ questions = [], catalog = {}, canonicalRows } = {}) {
    const source = Array.isArray(questions) ? questions : [];
    const rows = typeof canonicalRows === "function" ? canonicalRows(source)
      : canonicalRows || questionCatalog?.canonicalRows(source) || source.map((item) => ({
        id: item.id, canonicalId: item.id,
        answerable: item.review_status === "可练习" && item.type !== "填空",
      }));
    const sourceById = new Map(source.map((item) => [item.id, item]));
    const cautionsById = new Map((catalog.cautions || []).filter((caution) => {
      const item = sourceById.get(caution.questionId);
      return item && caution.reason && (!caution.questionFingerprint ||
        caution.questionFingerprint === questionFingerprint(item));
    }).map(({ questionId, reason, sourceUrl }) => [questionId, {
      questionId, reason, ...(sourceUrl ? { sourceUrl } : {}),
    }]));
    const groups = new Map();
    for (const row of rows) {
      if (!row.answerable || !sourceById.has(row.id)) continue;
      const id = row.canonicalId || row.id;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(row.id);
    }
    const definitions = (Array.isArray(catalog.concepts) ? catalog.concepts : [])
      .filter((concept) => concept && typeof concept.id === "string" && concept.id);
    const conceptById = new Map(definitions.map((concept) => [concept.id, {
      id: concept.id, title: concept.title || concept.id, chapter: concept.chapter || "其他",
      summary: concept.summary || "", recall: [...(concept.recall || [])],
      distinctions: [...(concept.distinctions || [])], method: concept.method || "",
      kind: "concept", needsMapping: false,
    }]));
    const rules = definitions.map((concept) => ({ id: concept.id, chapter: concept.chapter,
      chapters: new Set([concept.chapter, ...(concept.chapters || [])]),
      terms: [...new Set((concept.keywords || []).map(normalize).filter((term) => term.length >= 2))],
    }));
    const canonical = [...groups].map(([id, aliases]) => {
      const item = sourceById.get(id) || sourceById.get(aliases[0]);
      return { id, aliases, item, stemText: normalize(item.stem),
        answerText: normalize((item.answer || []).map((letter) => item.options?.[letter] || "").join(" ")) };
    });
    const frequency = new Map();
    for (const term of new Set(rules.flatMap((rule) => rule.terms))) {
      frequency.set(term, canonical.reduce((count, question) => count + Number(
        question.stemText.includes(term) || question.answerText.includes(term)), 0));
    }
    const questionById = new Map();
    const mappedQuestions = canonical.map(({ id, aliases, item, stemText, answerText }) => {
      const candidates = [];
      const chapter = item.chapter || "其他";
      for (const rule of rules) {
        // The mixed supplement has no curriculum chapter. Elsewhere, cross-
        // chapter use is opt-in in the public catalog: a passing mention of
        // "reform" in an education question must not change its subject.
        if (chapter !== "新增（必刷）" && !rule.chapters.has(chapter)) continue;
        const sameChapter = rule.chapter === chapter;
        const referenceChapter = rule.chapter === item.study?.reference?.chapter;
        const matches = [];
        for (const term of rule.terms) {
          // Very short terms (e.g. 国体) need a chapter context to avoid accidental
          // cross-subject matches. A reference is only a tie-break, not evidence.
          if (term.length < 4 && !sameChapter && !referenceChapter &&
              !(chapter === "新增（必刷）" && term.length >= 3)) continue;
          const inStem = stemText.includes(term);
          const inAnswer = answerText.includes(term);
          if (!inStem && !inAnswer) continue;
          const rarity = 1 + Math.log(1 + canonical.length / (1 + frequency.get(term)));
          const specificity = term.length < 4 ? 0.75 : 1;
          matches.push({ term, field: inStem ? "stem" : "answer",
            weight: rarity * specificity * (inStem ? 1 : 0.65) });
        }
        if (!matches.length) continue;
        matches.sort((a, b) => b.weight - a.weight);
        // Longer overlapping phrases are one piece of evidence, not multiple votes.
        const distinct = matches.filter((match, index) => !matches.slice(0, index)
          .some((prior) => prior.term.includes(match.term) || match.term.includes(prior.term)));
        const score = (distinct[0].weight + distinct.slice(1).reduce((sum, match) => sum + match.weight * 0.35, 0))
          * (sameChapter ? 1.35 : referenceChapter ? 1.15 : 1);
        candidates.push({ id: rule.id, score, matches: distinct });
      }
      candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      const best = candidates[0];
      const selected = best ? candidates.filter((candidate, index) => index === 0 || (
        index < 2 && candidate.score >= best.score * 0.82 &&
        candidate.matches.some((match) => match.field === "stem") &&
        best.matches.some((match) => match.field === "stem") &&
        candidate.matches.some((match) => !best.matches.some((other) => other.term === match.term))
      )) : [];
      let conceptIds = selected.map((candidate) => candidate.id);
      if (!conceptIds.length) {
        const fallbackId = `chapter:${chapter}`;
        if (!conceptById.has(fallbackId)) conceptById.set(fallbackId, {
          id: fallbackId, title: `${chapter} · 待细分`, chapter, kind: "chapter", needsMapping: true,
          summary: "这些题目暂未匹配到具体考点，当前只按题库章节归类。",
          recall: ["先阅读关联题目的教材出处和解析，再归纳题干要求的概念、条件或固定表述。"],
          distinctions: ["章节归类不代表这些题目考查同一个知识点，也不能据此判断已经掌握。"],
          method: "打开原题核对。暂未细分的题目仍可按当前错题记录直接练习。",
        });
        conceptIds = [fallbackId];
      }
      const caution = [id, ...aliases].map((alias) => cautionsById.get(alias)).find(Boolean) || null;
      const result = { id, aliases: [...aliases], chapter, type: item.type, stem: item.stem, caution,
        conceptIds, mapping: { status: best ? "matched" : "chapter",
          evidence: selected.flatMap((candidate) => ["stem", "answer"].flatMap((field) => {
            const terms = candidate.matches.filter((match) => match.field === field).map((match) => match.term);
            return terms.length ? [{ conceptId: candidate.id, terms, field }] : [];
          })) } };
      for (const alias of new Set([id, ...aliases])) questionById.set(alias, result);
      return result;
    });
    const edges = (Array.isArray(catalog.relations) ? catalog.relations : [])
      .filter((edge) => edge && edge.source !== edge.target && conceptById.has(edge.source) && conceptById.has(edge.target))
      .map(({ source, target, type, label }) => ({ source, target, type, label }));

    function snapshot({ historyEntry = () => null, inWrongLibrary } = {}) {
      const nodes = [...conceptById.values()].map((definition) => ({ ...definition,
        recall: [...definition.recall], distinctions: [...definition.distinctions],
        questionIds: [], wrongIds: [], retainedIds: [], reviewIds: [], wrongCount: 0,
        blockedIds: [], practiceIds: [], practiceReviewIds: [],
        retainedCount: 0, reviewCount: 0, attemptedCount: 0, questionCount: 0,
      }));
      const nodesById = new Map(nodes.map((node) => [node.id, node]));
      const stats = { totalQuestions: mappedQuestions.length, reviewQuestions: 0, wrongQuestions: 0,
        retainedQuestions: 0, mappedQuestions: 0, unmappedQuestions: 0,
        mappedReviewQuestions: 0, unmappedReviewQuestions: 0,
        blockedQuestions: 0, blockedReviewQuestions: 0,
        conceptCount: definitions.length, activeConceptCount: 0 };
      const currentQuestions = mappedQuestions.map((question) => {
        // The app's historyEntry already resolves aliases; accepting raw readers
        // here also keeps this pure model safe for exports and offline tooling.
        const entries = [...new Set([question.id, ...question.aliases])]
          .map((id) => historyEntry(id)).filter(Boolean);
        const entry = entries.reduce((latest, candidate) => !latest ||
          (Number(candidate.last) || 0) > (Number(latest.last) || 0) ? candidate : latest, null);
        const wrong = entry?.wrong === true;
        const attempted = typeof entry?.wrong === "boolean";
        const included = Boolean(typeof inWrongLibrary === "function" ? inWrongLibrary(question.id)
          : (entry?.review ?? wrong));
        const matched = question.mapping.status === "matched";
        const blocked = Boolean(question.caution);
        if (blocked) stats.blockedQuestions++;
        if (matched) stats.mappedQuestions++; else stats.unmappedQuestions++;
        if (included) {
          stats.reviewQuestions++;
          if (wrong) stats.wrongQuestions++; else stats.retainedQuestions++;
          if (blocked) stats.blockedReviewQuestions++;
          if (matched) stats.mappedReviewQuestions++; else stats.unmappedReviewQuestions++;
        }
        for (const id of question.conceptIds) {
          const node = nodesById.get(id);
          node.questionIds.push(question.id);
          node.questionCount++;
          if (blocked) node.blockedIds.push(question.id); else node.practiceIds.push(question.id);
          if (attempted) node.attemptedCount++;
          if (included) {
            node.reviewIds.push(question.id);
            if (!blocked) node.practiceReviewIds.push(question.id);
            node.reviewCount++;
            if (wrong) { node.wrongIds.push(question.id); node.wrongCount++; }
            else { node.retainedIds.push(question.id); node.retainedCount++; }
          }
        }
        return { ...question, aliases: [...question.aliases], conceptIds: [...question.conceptIds],
          caution: question.caution ? { ...question.caution } : null,
          mapping: { ...question.mapping, evidence: question.mapping.evidence.map((entry) => ({ ...entry, terms: [...entry.terms] })) },
          wrong, inWrongLibrary: included, attempted };
      });
      stats.activeConceptCount = nodes.filter((node) => node.reviewCount > 0 && !node.needsMapping).length;
      return { nodes, edges: edges.map((edge) => ({ ...edge })), questions: currentQuestions, stats };
    }
    return { snapshot,
      getQuestion(id) { return questionById.get(id) || null; },
      conceptsForQuestion(id) { return [...(questionById.get(id)?.conceptIds || [])]; },
    };
  }
  return { create, normalize, questionFingerprint };
});
