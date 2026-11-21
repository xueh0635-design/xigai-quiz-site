"use strict";

(() => {
  const field = (name) => document.getElementById(`knowledge-${name}`);
  const colors = ["#ae6f45", "#628e76", "#737eb0", "#b37891", "#608f9e", "#9a8652", "#9a78ab"];
  const chapterOrder = ["导论", ...Array.from({ length: 17 }, (_, i) =>
    `第${["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七"][i]}章`), "结语", "新增（必刷）"];
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, action, className = "") {
    const node = element("button", className, text);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  const sortNodes = (a, b) => b.wrongCount - a.wrongCount || b.reviewCount - a.reviewCount ||
    Number(a.needsMapping) - Number(b.needsMapping) || b.questionCount - a.questionCount || a.id.localeCompare(b.id);
  const colorFor = (chapter) => colors[Math.max(0, chapterOrder.indexOf(chapter)) % colors.length];

  function connect({ questions, historyEntry, inWrongLibrary, practiceQuestions, accountScope }) {
    const root = document.getElementById("knowledge");
    if (!root || !window.QuizKnowledgeModel || !window.QuizKnowledgeCatalog) return null;
    const model = window.QuizKnowledgeModel.create({ questions, catalog: window.QuizKnowledgeCatalog });
    const publicQuestions = new Map(questions.map((item) => [item.id, item]));
    const searchText = new Map();
    let snapshot = null;
    let nodeById = new Map();
    let shown = false;
    let waiting = false;
    let scopeKey = null;
    let ratings = {};
    let state;
    const freshState = () => ({ view: "graph", scope: "wrong", chapter: "", search: "", selected: "",
      neighbors: matchMedia("(max-width: 600px)").matches, list: false, revealed: false, questionLimit: 6 });
    state = freshState();
    const graph = new KnowledgeCanvas(field("canvas"), (id) => chooseConcept(id));

    function message(text) { field("message").textContent = text; }
    function readRatings() {
      ratings = {};
      try {
        const saved = JSON.parse(localStorage.getItem(scopeKey) || "{}");
        if (saved && typeof saved === "object" && !Array.isArray(saved)) {
          for (const [id, value] of Object.entries(saved)) {
            if (nodeById.has(id) && typeof value === "boolean") ratings[id] = value;
          }
        }
      } catch { /* A private browsing session can still use cards in memory. */ }
    }
    function loadScope() {
      const key = `xigai-knowledge-recall-v1:${encodeURIComponent(accountScope())}`;
      if (key === scopeKey) return;
      scopeKey = key;
      readRatings();
    }
    function rate(node, remembered) {
      if (waiting) return;
      const focused = document.activeElement?.dataset.knowledgeFocus;
      ratings[node.id] = remembered;
      try { localStorage.setItem(scopeKey, JSON.stringify(ratings)); }
      catch { message("本机暂时无法保存自评，本次打开期间仍可使用。"); }
      renderCards(filtered());
      restoreFocus(focused);
    }
    function normalized(value) { return String(value || "").toLocaleLowerCase().replace(/\s/g, ""); }
    function searchable(node) {
      if (!searchText.has(node.id)) {
        searchText.set(node.id, normalized([node.title, node.chapter, node.summary, ...node.recall,
          ...node.distinctions, ...node.questionIds.map((id) => publicQuestions.get(id)?.stem || "")].join(" ")));
      }
      return searchText.get(node.id);
    }
    function filtered() {
      if (!snapshot) return [];
      const term = normalized(state.search);
      return snapshot.nodes.filter((node) => (state.scope === "all" || node.reviewCount > 0) &&
        (!state.chapter || node.chapter === state.chapter) && (!term || searchable(node).includes(term))).sort(sortNodes);
    }
    function refresh() {
      if (!shown || waiting) return;
      snapshot = model.snapshot({ historyEntry, inWrongLibrary });
      nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
      loadScope();
      const chapters = [...new Set(snapshot.nodes.map((node) => node.chapter))].sort((a, b) =>
        chapterOrder.indexOf(a) - chapterOrder.indexOf(b));
      const selector = field("chapter");
      if (selector.options.length !== chapters.length + 1) {
        selector.replaceChildren(new Option("全部章节", ""), ...chapters.map((name) => new Option(name, name)));
      }
      selector.value = state.chapter;
      const stats = snapshot.stats;
      field("wrong").textContent = stats.wrongQuestions;
      field("points").textContent = stats.activeConceptCount;
      field("retained").textContent = stats.retainedQuestions;
      field("count").textContent = `错题本 ${stats.reviewQuestions} 道 · ${stats.mappedReviewQuestions} 道有考点线索` +
        (stats.unmappedReviewQuestions ? ` · ${stats.unmappedReviewQuestions} 道待细分` : "") +
        (stats.blockedReviewQuestions ? ` · ${stats.blockedReviewQuestions} 道内容待核对` : "") +
        (accountScope() === "guest" ? " · 当前访客记录" : " · 当前账号记录");
      render();
    }
    function render() {
      if (!shown || waiting || !snapshot) return;
      const focusedConcept = document.activeElement?.dataset.knowledgeConcept;
      const nodes = filtered();
      if (!nodes.some((node) => node.id === state.selected)) {
        state.selected = nodes[0]?.id || "";
        state.revealed = false;
        state.questionLimit = 6;
      }
      field("scope").value = state.scope;
      field("chapter").value = state.chapter;
      field("search").value = state.search;
      for (const control of root.querySelectorAll("[data-knowledge-view]")) {
        control.setAttribute("aria-pressed", String(control.dataset.knowledgeView === state.view));
      }
      field("filter-count").textContent = `${state.chapter || "全部章节"} · ${nodes.length} 个${state.scope === "wrong" ? "待复习" : "知识"}节点`;
      field("empty").hidden = nodes.length > 0;
      const clean = !snapshot.stats.reviewQuestions && state.scope === "wrong" && !state.search && !state.chapter;
      field("empty-title").textContent = clean ? "还没有需要复习的错题" : "当前筛选下没有知识点";
      field("empty-text").textContent = clean ? "练习后，这里会按当前错题整理考点。也可以先浏览知识卡片。"
        : "试试其他关键词、章节，或浏览全部考点。";
      for (const view of ["graph", "cards", "analysis"]) field(`${view}-view`).hidden = state.view !== view || !nodes.length;
      graph.setActive(shown && state.view === "graph" && !state.list && nodes.length > 0);
      // Keep the accessible list current even when the canvas is the selected presentation.
      renderList(nodes);
      if (state.view === "graph") {
        renderGraph(nodes);
        renderDetail();
      } else if (state.view === "cards") renderCards(nodes);
      else renderAnalysis(nodes);
      if (focusedConcept && state.view === "graph" && state.list) {
        [...field("list").querySelectorAll("[data-knowledge-concept]")]
          .find((item) => item.dataset.knowledgeConcept === focusedConcept)?.focus({ preventScroll: true });
      }
    }
    function restoreFocus(key) {
      if (!key) return;
      const control = [...root.querySelectorAll("[data-knowledge-focus]")].find((item) => item.dataset.knowledgeFocus === key && !item.disabled);
      (control || field("card-reveal") || field("detail").querySelector("h3"))?.focus({ preventScroll: true });
    }
    function chooseConcept(id, { view = state.view, preserveFilters = false } = {}) {
      if (waiting || !nodeById.has(id)) return;
      const focused = document.activeElement?.dataset.knowledgeFocus;
      const relation = document.activeElement?.classList.contains("knowledge-relation");
      const node = nodeById.get(id);
      if (!preserveFilters && !filtered().some((item) => item.id === id)) {
        state.chapter = "";
        state.search = "";
        if (!node.reviewCount) state.scope = "all";
      }
      state.selected = id;
      state.view = view;
      state.revealed = false;
      state.questionLimit = 6;
      render();
      if (relation) field("detail").querySelector("h3")?.focus({ preventScroll: true });
      else restoreFocus(focused);
    }
    function renderList(nodes) {
      field("list").replaceChildren(...nodes.map((node) => {
        const item = button("", () => chooseConcept(node.id), "knowledge-node-row");
        item.dataset.knowledgeConcept = node.id;
        item.setAttribute("aria-pressed", String(node.id === state.selected));
        const dot = element("span", "knowledge-dot");
        dot.style.setProperty("--knowledge-color", colorFor(node.chapter));
        dot.setAttribute("aria-hidden", "true");
        const title = element("span", "knowledge-node-label");
        title.append(element("strong", "", node.title), element("small", "", node.chapter + (node.needsMapping ? " · 待细分" : "")));
        item.append(dot, title, element("span", "knowledge-node-count", node.reviewCount ? `${node.reviewCount} 题` : "可预习"));
        return item;
      }));
    }
    function renderGraph(nodes) {
      if (!graph.context) {
        state.list = true;
        message("当前设备无法绘制图谱，已切换为知识点列表。卡片和关联练习仍可使用。");
      }
      const ids = new Set([state.selected]);
      if (state.neighbors) for (const edge of snapshot.edges) {
        if (edge.source === state.selected || edge.target === state.selected) {
          ids.add(edge.source); ids.add(edge.target);
        }
      }
      const visible = state.neighbors && state.selected ? snapshot.nodes.filter((node) => ids.has(node.id)) : nodes;
      const visibleIds = new Set(visible.map((node) => node.id));
      const edges = snapshot.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
      field("neighbors").setAttribute("aria-pressed", String(state.neighbors));
      field("neighbors").textContent = state.neighbors ? "查看全图" : "只看关联";
      field("list-toggle").setAttribute("aria-pressed", String(state.list));
      field("list-toggle").textContent = state.list ? "图谱" : "列表";
      field("list-toggle").disabled = !graph.context;
      field("map").hidden = state.list;
      field("list").hidden = !state.list;
      for (const id of ["zoom-in", "zoom-out", "fit", "neighbors"]) field(id).disabled = state.list;
      field("map-hint").textContent = state.neighbors ? "局部图谱含相邻考点 · 拖动 / 双指缩放" : "拖动节点 · 双指缩放 · 点击查看";
      graph.setData(visible, edges, state.selected);
      graph.resize();
    }
    function facts(parent, heading, items) {
      if (!items?.length) return;
      parent.append(element("h4", "", heading));
      const list = element("ul", "knowledge-facts");
      for (const text of items) list.append(element("li", "", text));
      parent.append(list);
    }
    function practice(node, ids) {
      if (!shown || waiting || !ids.length) return;
      const ready = ids.filter((id) => !model.getQuestion(id)?.caution);
      if (!ready.length) { message("这些题目内容尚待核对，可先在关联原题中查看具体问题。"); return; }
      practiceQuestions(ready, { id: node.id, title: node.title });
    }
    function practiceActions(node, stableIds = false) {
      const actions = element("div", "knowledge-practice-actions");
      const reviewIds = node.practiceReviewIds || node.reviewIds;
      const allIds = node.practiceIds || node.questionIds;
      const wrong = button(reviewIds.length ? `练这 ${reviewIds.length} 道错题` : node.reviewCount ? "错题内容待核对" : "该考点暂无错题", () => practice(node, reviewIds), "primary");
      const all = button(`练关联题 · ${allIds.length}`, () => practice(node, allIds));
      if (stableIds) { wrong.id = "knowledge-practice"; all.id = "knowledge-practice-all"; }
      wrong.disabled = !reviewIds.length;
      all.disabled = !allIds.length;
      actions.append(wrong, all);
      return actions;
    }
    function renderDetail() {
      const panel = field("detail");
      panel.replaceChildren();
      const node = nodeById.get(state.selected);
      if (!node) return;
      panel.append(element("p", "knowledge-eyebrow", node.chapter + (node.needsMapping ? " · 待细分" : " · 考点线索")));
      const heading = element("h3", "", node.title);
      heading.tabIndex = -1;
      panel.append(heading, element("p", "knowledge-detail-meta", `${node.wrongCount} 道答错 · ${node.retainedCount} 道手动保留 · ${node.questionCount} 道关联题`));
      panel.append(element("p", "knowledge-node-summary", node.summary));
      if (node.blockedIds?.length) panel.append(element("p", "knowledge-method", `${node.blockedIds.length} 道关联题存在内容疑点，暂不进入知识专项练习。具体原因见下方关联原题，错题记录仍会保留。`));
      panel.append(practiceActions(node, true));
      const card = button("用卡片背一遍", () => chooseConcept(node.id, { view: "cards" }), "knowledge-text-button");
      panel.append(card);
      facts(panel, "必背要点", node.recall);
      facts(panel, "容易混淆", node.distinctions);
      if (node.method) panel.append(element("p", "knowledge-method", node.method));
      const edges = snapshot.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
      if (edges.length) {
        panel.append(element("h4", "", "顺着关系理解"));
        const links = element("div", "knowledge-relations");
        for (const edge of edges) {
          const other = nodeById.get(edge.source === node.id ? edge.target : edge.source);
          if (!other) continue;
          const link = button("", () => chooseConcept(other.id), "knowledge-relation");
          const source = nodeById.get(edge.source)?.title || "";
          const target = nodeById.get(edge.target)?.title || "";
          link.append(element("span", "", `${source} → ${target}`), element("small", "", `${edge.type} · ${edge.label}`));
          links.append(link);
        }
        panel.append(links);
      }
      const disclosure = element("details", "knowledge-questions");
      disclosure.append(element("summary", "", `关联原题 · ${node.questionCount} 道`));
      const order = [...node.reviewIds, ...node.questionIds.filter((id) => !node.reviewIds.includes(id))];
      const items = element("div", "knowledge-question-list");
      function renderQuestions() {
        items.replaceChildren(...order.slice(0, state.questionLimit).map((id) => {
          const item = publicQuestions.get(id);
          const metadata = model.getQuestion(id);
          const row = button("", () => practice(node, [id]), "knowledge-question-row");
          const entry = historyEntry(id);
          const status = inWrongLibrary(id) ? (entry?.wrong ? "当前答错" : "手动保留")
            : typeof entry?.wrong === "boolean" ? (entry.wrong ? "已移出错题本" : "最近答对") : "尚未作答";
          row.append(element("small", "", `${item?.chapter || ""} · ${item?.type || ""} · ${status}`), element("span", "", item?.stem || id));
          if (metadata?.caution) {
            row.disabled = true;
            row.append(element("small", "knowledge-question-caution", "内容待核对：" + metadata.caution.reason));
          }
          const evidence = metadata?.mapping?.evidence?.find((value) => value.conceptId === node.id);
          if (evidence?.terms?.length) row.append(element("small", "", "关联线索：" + evidence.terms.join("、")));
          return row;
        }));
        if (order.length > state.questionLimit) items.append(button("显示更多关联题", () => {
          state.questionLimit += 12; renderQuestions();
        }, "knowledge-text-button"));
      }
      renderQuestions();
      disclosure.append(items);
      panel.append(disclosure, element("p", "knowledge-caption", node.needsMapping
        ? "这些题暂按章节归组，尚未提炼出足够准确的细分考点。请结合原题解析复习。"
        : "考点关联依据题干与正确答案中的线索，用于安排复习。掌握程度仍需通过作答检验。"));
    }
    function renderCards(nodes) {
      const parent = field("cards-view");
      parent.replaceChildren();
      const node = nodeById.get(state.selected);
      if (!node || !nodes.length) return;
      const position = Math.max(0, nodes.findIndex((item) => item.id === node.id));
      const top = element("div", "knowledge-card-top");
      top.append(element("span", "knowledge-eyebrow", `${position + 1} / ${nodes.length} · ${node.chapter}`),
        element("span", "knowledge-recall-state", ratings[node.id] === true ? "已记住 · 本机自评" : ratings[node.id] === false ? "再复习 · 本机自评" : "先试着复述"));
      const card = element("article", "knowledge-flashcard");
      card.append(top, element("h3", "", node.title), element("p", "knowledge-card-prompt", "你能说出关键结论，并区分容易混淆的说法吗？"));
      const reveal = button(state.revealed ? "收起要点" : "展开要点，核对记忆", () => {
        state.revealed = !state.revealed; renderCards(nodes); field("card-reveal")?.focus({ preventScroll: true });
      }, "primary");
      reveal.id = "knowledge-card-reveal";
      reveal.setAttribute("aria-expanded", String(state.revealed));
      reveal.setAttribute("aria-controls", "knowledge-card-answer");
      card.append(reveal);
      const answer = element("div", "knowledge-card-answer");
      answer.id = "knowledge-card-answer";
      answer.hidden = !state.revealed;
      answer.append(element("p", "", node.summary));
      facts(answer, "必背要点", node.recall);
      facts(answer, "容易混淆", node.distinctions);
      if (node.method) answer.append(element("p", "knowledge-method", node.method));
      const rating = element("div", "knowledge-card-rating");
      for (const [remembered, label] of [[false, "还要再背"], [true, "这次记住了"]]) {
        const control = button(label, () => rate(node, remembered));
        control.dataset.knowledgeFocus = remembered ? "remembered" : "review-again";
        control.setAttribute("aria-pressed", String(ratings[node.id] === remembered));
        rating.append(control);
      }
      answer.append(rating, element("p", "knowledge-caption", "自评仅保存在本机当前账号下。答对关联题后，错题状态才会更新。"));
      card.append(answer);
      const navigation = element("div", "knowledge-card-navigation");
      const previous = button("上一张", () => chooseConcept(nodes[position - 1].id));
      const next = button("下一张", () => chooseConcept(nodes[position + 1].id));
      previous.dataset.knowledgeFocus = "previous-card";
      next.dataset.knowledgeFocus = "next-card";
      previous.disabled = position === 0;
      next.disabled = position >= nodes.length - 1;
      navigation.append(previous, button("在图谱中查看", () => chooseConcept(node.id, { view: "graph" })), next);
      parent.append(card, navigation, practiceActions(node));
    }
    function renderAnalysis(nodes) {
      const parent = field("analysis-view");
      parent.replaceChildren();
      const ids = new Set(nodes.flatMap((node) => node.reviewIds));
      const current = snapshot.questions.filter((item) => ids.has(item.id));
      const wrong = current.filter((item) => item.wrong).length;
      const pending = current.filter((item) => item.mapping.status === "chapter").length;
      const heading = element("div", "knowledge-analysis-intro");
      heading.append(element("h3", "", wrong ? "先补上这些知识点" : "先复习，再用题目检验"),
        element("p", "", `当前筛选涉及 ${current.length} 道错题本条目，其中 ${wrong} 道最近答错、${current.length - wrong} 道手动保留。`));
      parent.append(heading);
      const blocked = current.filter((item) => item.caution).length;
      const ranked = nodes.filter((node) => (node.practiceReviewIds || node.reviewIds).length > 0 && !node.needsMapping).slice(0, 8);
      const list = element("ol", "knowledge-priorities");
      for (const node of ranked) {
        const row = element("li", "knowledge-priority");
        const open = button(node.title, () => chooseConcept(node.id, { view: "graph" }), "knowledge-priority-title");
        row.append(open, element("p", "knowledge-detail-meta", `${node.wrongCount} 道答错 · ${node.retainedCount} 道手动保留`),
          element("p", "", node.recall[0] || node.summary));
        const actions = element("div", "knowledge-priority-actions");
        actions.append(button("先背要点", () => chooseConcept(node.id, { view: "cards" })),
          button("练关联错题", () => practice(node, node.reviewIds)));
        row.append(actions); list.append(row);
      }
      if (ranked.length) parent.append(list);
      if (blocked) parent.append(element("p", "knowledge-method", `${blocked} 道题存在内容疑点，已暂停知识专项练习；这些题仍保留在当前记录中，不能仅凭它们判断知识薄弱。`));
      if (pending) parent.append(element("p", "knowledge-method", `还有 ${pending} 道题暂按章节归组。它们仍在图谱列表与练习中，待补充更具体的考点映射。`));
      if (!current.length) parent.append(element("p", "knowledge-method", "当前没有错题证据，暂不判断薄弱点。可以先看知识卡片，再做关联题。"));
      const types = new Map();
      for (const item of current.filter((row) => row.wrong)) types.set(item.type, (types.get(item.type) || 0) + 1);
      if (types.size) {
        const panel = element("section", "knowledge-type-summary");
        panel.append(element("h4", "", "这些错题的题型"));
        for (const [type, count] of types) {
          const row = element("div", "knowledge-type-row");
          const track = element("span", "knowledge-type-track");
          const fill = element("span", ""); fill.style.width = `${100 * count / wrong}%`; track.append(fill);
          row.append(element("span", "", type), track, element("strong", "", `${count} 题`)); panel.append(row);
        }
        parent.append(panel);
      }
      parent.append(element("p", "knowledge-caption", "排序依据当前错题数量，反映最近一次保存的答题状态；不代表累计错次或知识掌握率。手动保留与答错分别统计，同题跨题库合并计算。"));
    }
    function changeFilters() {
      state.scope = field("scope").value;
      state.chapter = field("chapter").value;
      state.search = field("search").value.trim();
      state.revealed = false;
      state.questionLimit = 6;
      message(""); render();
    }
    for (const id of ["scope", "chapter"]) field(id).addEventListener("change", changeFilters);
    field("search").addEventListener("input", changeFilters);
    for (const control of root.querySelectorAll("[data-knowledge-view]")) control.addEventListener("click", () => {
      state.view = control.dataset.knowledgeView; render();
    });
    field("reset-filters").addEventListener("click", () => {
      state.scope = "all"; state.chapter = ""; state.search = ""; state.revealed = false; render();
    });
    field("neighbors").addEventListener("click", () => { state.neighbors = !state.neighbors; render(); });
    field("list-toggle").addEventListener("click", () => { state.list = !state.list; render(); });
    field("zoom-in").addEventListener("click", () => graph.zoom(1.25));
    field("zoom-out").addEventListener("click", () => graph.zoom(0.8));
    field("fit").addEventListener("click", () => graph.fit());
    window.addEventListener("storage", (event) => {
      if (scopeKey && event.key === scopeKey && !waiting) { readRatings(); if (shown) render(); }
    });
    return {
      refresh,
      show(value) { shown = value; if (value) refresh(); else graph.setActive(false); },
      selectConcept(id) { chooseConcept(id); },
      accountReady() { waiting = false; if (shown) refresh(); },
      reset() {
        waiting = true; snapshot = null; nodeById = new Map(); scopeKey = null; ratings = {}; state = freshState();
        graph.setActive(false); graph.setData([], [], "");
        for (const id of ["list", "detail", "cards-view", "analysis-view"]) field(id).replaceChildren();
        for (const id of ["wrong", "points", "retained"]) field(id).textContent = "0";
        field("count").textContent = "正在切换学习记录…";
        field("filter-count").textContent = "";
        field("search").value = ""; field("chapter").value = ""; field("scope").value = "wrong";
        message("");
      },
    };
  }

  // A bounded layout avoids a permanent animation loop on a phone. All content
  // is also available through real DOM buttons in the equivalent list view.
  class KnowledgeCanvas {
    constructor(canvas, onSelect) {
      this.canvas = canvas; this.onSelect = onSelect;
      try { this.context = canvas.getContext("2d"); } catch { this.context = null; }
      this.nodes = []; this.edges = []; this.positions = new Map(); this.pointers = new Map();
      this.transform = { x: 0, y: 0, scale: 1 }; this.active = false; this.frame = 0; this.steps = 0;
      this.selected = ""; this.layoutKey = ""; this.width = 1; this.height = 1; this.movedView = false;
      this.motion = matchMedia("(prefers-reduced-motion: reduce)");
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas.parentElement);
      this.themeObserver = new MutationObserver(() => this.draw());
      this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-world-theme"] });
      this.motion.addEventListener("change", () => { if (this.motion.matches) { this.steps = 0; this.stop(); this.draw(); } });
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) this.stop(); else if (this.active) { this.resize(); this.animate(); }
      });
      canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
      canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
      canvas.addEventListener("pointerup", (event) => this.pointerEnd(event, true));
      canvas.addEventListener("pointercancel", (event) => this.pointerEnd(event, false));
      canvas.addEventListener("lostpointercapture", (event) => this.pointerEnd(event, false));
      canvas.addEventListener("wheel", (event) => {
        event.preventDefault(); this.zoom(Math.exp(-event.deltaY * .0015), this.local(event));
      }, { passive: false });
      canvas.addEventListener("keydown", (event) => {
        if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key) && this.nodes.length) {
          event.preventDefault(); const index = Math.max(0, this.nodes.findIndex((node) => node.id === this.selected));
          const direction = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1;
          this.onSelect(this.nodes[(index + direction + this.nodes.length) % this.nodes.length].id);
        } else if (["+", "=", "-", "0", "Enter"].includes(event.key)) {
          event.preventDefault();
          if (event.key === "0") this.fit();
          else if (event.key === "Enter") field("detail").querySelector("h3")?.focus();
          else this.zoom(event.key === "-" ? .8 : 1.25);
        }
      });
    }
    setActive(value) {
      this.active = Boolean(value && this.context);
      if (!this.active) { this.stop(); this.pointers.clear(); this.drag = null; }
      else { this.resize(); this.animate(); }
    }
    setData(nodes, edges, selected) {
      this.selected = selected;
      const key = nodes.map((node) => node.id).sort().join("|");
      this.edges = edges;
      if (key !== this.layoutKey) {
        this.layoutKey = key;
        const chapters = [...new Set(nodes.map((node) => node.chapter))];
        this.nodes = nodes.map((value, index) => {
          const chapter = chapters.indexOf(value.chapter);
          const angle = chapter / Math.max(1, chapters.length) * Math.PI * 2 - Math.PI / 2;
          const spread = chapters.length > 1 ? Math.min(240, chapters.length * 45) : 0;
          const anchorX = 400 + Math.cos(angle) * spread;
          const anchorY = 260 + Math.sin(angle) * spread * .7;
          const theta = index * 2.399963;
          const radius = 45 + 17 * Math.sqrt(index % Math.max(3, nodes.length / chapters.length));
          return { id: value.id, value, x: anchorX + Math.cos(theta) * radius, y: anchorY + Math.sin(theta) * radius,
            anchorX, anchorY, vx: 0, vy: 0 };
        });
        this.positions = new Map(this.nodes.map((node) => [node.id, node]));
        this.steps = this.motion.matches ? 0 : 110;
        this.movedView = false;
        if (this.motion.matches) for (let i = 0; i < 80; i++) this.tick();
        this.fit(false); this.animate();
      } else for (const node of this.nodes) node.value = nodes.find((value) => value.id === node.id) || node.value;
      const active = nodes.find((node) => node.id === selected);
      this.canvas.setAttribute("aria-label", `知识图谱，${nodes.length} 个节点。${active ? `当前：${active.title}，${active.wrongCount} 道错题。` : ""}方向键选择考点，加减键缩放；也可切换列表。`);
      this.draw();
    }
    stop() { cancelAnimationFrame(this.frame); this.frame = 0; }
    animate() {
      if (!this.active || document.hidden || this.frame || !this.steps || this.motion.matches) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        if (!this.active || document.hidden) return;
        for (let i = 0; i < 2 && this.steps > 0; i++, this.steps--) this.tick();
        if (!this.movedView && this.steps % 12 === 0) this.fit(false);
        this.draw(); this.animate();
      });
    }
    tick() {
      const nodes = this.nodes;
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j]; const dx = a.x - b.x || .1, dy = a.y - b.y || .1;
        const distance = Math.hypot(dx, dy); const force = Math.min(5, 1900 / (distance * distance + 100));
        a.vx += dx / distance * force; a.vy += dy / distance * force;
        b.vx -= dx / distance * force; b.vy -= dy / distance * force;
      }
      for (const edge of this.edges) {
        const a = this.positions.get(edge.source), b = this.positions.get(edge.target);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
        const force = (distance - 105) * .009;
        a.vx += dx / distance * force; a.vy += dy / distance * force;
        b.vx -= dx / distance * force; b.vy -= dy / distance * force;
      }
      for (const node of nodes) {
        if (node === this.drag?.node) { node.vx = 0; node.vy = 0; continue; }
        node.vx = (node.vx + (node.anchorX - node.x) * .008) * .74;
        node.vy = (node.vy + (node.anchorY - node.y) * .008) * .74;
        node.x += node.vx; node.y += node.vy;
      }
    }
    resize() {
      if (!this.active) return;
      const bounds = this.canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const changed = Math.abs(this.width - bounds.width) > 1 || Math.abs(this.height - bounds.height) > 1;
      this.width = bounds.width; this.height = bounds.height;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.round(this.width * ratio), height = Math.round(this.height * ratio);
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width; this.canvas.height = height;
      }
      this.context?.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (changed) this.fit(false);
      this.draw();
    }
    fit(manual = true) {
      if (!this.nodes.length) { this.draw(); return; }
      const xs = this.nodes.map((node) => node.x), ys = this.nodes.map((node) => node.y);
      const minX = Math.min(...xs) - 65, maxX = Math.max(...xs) + 65;
      const minY = Math.min(...ys) - 55, maxY = Math.max(...ys) + 70;
      const scale = Math.max(.15, Math.min(1.4, (this.width - 30) / (maxX - minX), (this.height - 60) / (maxY - minY)));
      this.transform = { scale, x: this.width / 2 - (minX + maxX) / 2 * scale,
        y: this.height / 2 - (minY + maxY) / 2 * scale - 8 };
      if (manual) this.movedView = true;
      this.draw();
    }
    zoom(factor, point = { x: this.width / 2, y: this.height / 2 }) {
      const t = this.transform, scale = Math.max(.15, Math.min(3.5, t.scale * factor));
      this.transform = { x: point.x - (point.x - t.x) * scale / t.scale,
        y: point.y - (point.y - t.y) * scale / t.scale, scale };
      this.movedView = true; this.draw();
    }
    local(event) { const rect = this.canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
    radius(node) { return 5.5 + Math.min(11, Math.sqrt(node.value.reviewCount || 0) * 1.9); }
    hit(point) {
      const t = this.transform;
      return [...this.nodes].reverse().find((node) => Math.hypot(node.x * t.scale + t.x - point.x,
        node.y * t.scale + t.y - point.y) < Math.max(17, this.radius(node) * t.scale + 9));
    }
    pointerDown(event) {
      if (!this.active || (event.pointerType === "mouse" && event.button !== 0)) return;
      const point = this.local(event); this.pointers.set(event.pointerId, point);
      this.canvas.setPointerCapture(event.pointerId);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.drag = { pinch: true, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, transform: { ...this.transform }, moved: true };
      } else if (this.pointers.size === 1) this.drag = { id: event.pointerId, start: point, last: point,
        node: this.hit(point), moved: false };
      this.movedView = true;
    }
    pointerMove(event) {
      if (!this.pointers.has(event.pointerId)) return;
      const point = this.local(event); this.pointers.set(event.pointerId, point);
      if (this.drag?.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()], previous = this.drag.transform;
        const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const scale = Math.max(.15, Math.min(3.5, previous.scale * distance / this.drag.distance));
        this.transform = { scale, x: (a.x + b.x) / 2 - (this.drag.center.x - previous.x) * scale / previous.scale,
          y: (a.y + b.y) / 2 - (this.drag.center.y - previous.y) * scale / previous.scale };
      } else if (this.drag?.id === event.pointerId) {
        if (Math.hypot(point.x - this.drag.start.x, point.y - this.drag.start.y) > 5) this.drag.moved = true;
        if (this.drag.moved) {
          if (this.drag.node) {
            this.drag.node.x += (point.x - this.drag.last.x) / this.transform.scale;
            this.drag.node.y += (point.y - this.drag.last.y) / this.transform.scale;
          } else {
            this.transform.x += point.x - this.drag.last.x;
            this.transform.y += point.y - this.drag.last.y;
          }
        }
        this.drag.last = point;
      }
      this.draw();
    }
    pointerEnd(event, allowSelection) {
      if (!this.pointers.has(event.pointerId)) return;
      const chosen = allowSelection && this.drag?.id === event.pointerId && !this.drag.moved ? this.drag.node : null;
      this.pointers.delete(event.pointerId);
      this.drag = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      if (chosen) this.onSelect(chosen.id);
      this.draw();
    }
    draw() {
      const ctx = this.context;
      if (!ctx) return;
      const t = this.transform, palette = getComputedStyle(document.documentElement);
      const ink = palette.getPropertyValue("--world-ink").trim() || "#203d33";
      const muted = palette.getPropertyValue("--world-muted").trim() || "#4c675b";
      const edgeColor = palette.getPropertyValue("--world-edge").trim() || "#cedbcd";
      const accent = palette.getPropertyValue("--world-accent").trim() || "#266b54";
      const paper = palette.getPropertyValue("--world-card").trim() || "#f8f9ef";
      ctx.clearRect(0, 0, this.width, this.height);
      if (!this.nodes.length) return;
      ctx.fillStyle = edgeColor;
      for (let x = ((t.x % 23) + 23) % 23; x < this.width; x += 23) for (let y = ((t.y % 23) + 23) % 23; y < this.height; y += 23) {
        ctx.beginPath(); ctx.arc(x, y, .65, 0, Math.PI * 2); ctx.fill();
      }
      const neighbors = new Set(this.edges.filter((edge) => edge.source === this.selected || edge.target === this.selected)
        .flatMap((edge) => [edge.source, edge.target]));
      for (const edge of this.edges) {
        const a = this.positions.get(edge.source), b = this.positions.get(edge.target);
        if (!a || !b) continue;
        const active = a.id === this.selected || b.id === this.selected;
        ctx.globalAlpha = active ? .65 : .4; ctx.strokeStyle = active ? accent : edgeColor; ctx.lineWidth = active ? 1.4 : .9;
        ctx.beginPath(); ctx.moveTo(a.x * t.scale + t.x, a.y * t.scale + t.y);
        ctx.lineTo(b.x * t.scale + t.x, b.y * t.scale + t.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const node of this.nodes) {
        const x = node.x * t.scale + t.x, y = node.y * t.scale + t.y, radius = Math.max(4.5, this.radius(node) * Math.sqrt(t.scale));
        const color = colorFor(node.value.chapter);
        ctx.fillStyle = color; ctx.globalAlpha = node.value.reviewCount ? 1 : .6;
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
        if (node.id === this.selected) {
          ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, radius + 5, 0, Math.PI * 2); ctx.stroke();
        }
      }
      const boxes = [];
      const sorted = [...this.nodes].sort((a, b) => Number(b.id === this.selected) - Number(a.id === this.selected) ||
        Number(neighbors.has(b.id)) - Number(neighbors.has(a.id)) || b.value.reviewCount - a.value.reviewCount);
      for (const node of sorted) {
        const active = node.id === this.selected, near = neighbors.has(node.id);
        if (this.nodes.length > 28 && !active && !near && t.scale < .85) continue;
        const label = node.value.title.length > (active ? 23 : 13) ? node.value.title.slice(0, active ? 23 : 13) + "…" : node.value.title;
        const font = active ? 13 : 11;
        ctx.font = `${active ? 650 : 500} ${font}px system-ui, sans-serif`;
        const width = ctx.measureText(label).width;
        const x = Math.max(width / 2 + 8, Math.min(this.width - width / 2 - 8, node.x * t.scale + t.x));
        const y = node.y * t.scale + t.y + Math.max(4.5, this.radius(node) * Math.sqrt(t.scale)) + 19;
        const box = { x: x - width / 2 - 4, y: y - font - 2, width: width + 8, height: font + 7 };
        if (!active && boxes.some((value) => box.x < value.x + value.width && box.x + box.width > value.x && box.y < value.y + value.height && box.y + box.height > value.y)) continue;
        boxes.push(box);
        if (active) { ctx.fillStyle = paper; ctx.fillRect(box.x, box.y, box.width, box.height); }
        ctx.fillStyle = active ? ink : muted; ctx.textAlign = "center"; ctx.fillText(label, x, y);
      }
    }
  }
  window.QuizKnowledge = { connect };
})();
