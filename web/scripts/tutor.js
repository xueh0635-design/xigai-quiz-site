(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const dialog = byId("quiz-tutor");
  const sheet = window.QuizSheetMotion.attach(dialog);
  const context = byId("quiz-tutor-context");
  const stem = byId("quiz-tutor-stem");
  const evidence = byId("quiz-tutor-evidence");
  const prompts = byId("quiz-tutor-prompts");
  const starters = byId("quiz-tutor-starters");
  const log = byId("quiz-tutor-log");
  const scroll = byId("quiz-tutor-scroll");
  const field = byId("quiz-tutor-input");
  const send = byId("quiz-tutor-send");
  const status = byId("quiz-tutor-status");
  const waiting = byId("quiz-tutor-waiting");
  const tools = byId("quiz-tutor-tools");
  const search = byId("quiz-tutor-search");
  const model = byId("quiz-tutor-model");
  const modelKey = "xigai-tutor-model";
  const errors = {
    sign_in: "登录已失效，请重新登录。",
    not_allowed: "这个账号尚未开通题目助手。",
    inactive: "题目助手暂未开通。",
    limit: "提问次数已达上限，请稍后再试。",
    provider_quota: "OpenAI 额度暂不可用。",
    too_long: "这段对话太长，请缩短问题再试。",
    bad_question: "没能读到题目，请关闭后重新打开。",
    no_answer: "暂未收到完整回答，请再问一次。",
    search_unavailable: "联网查证暂时未完成。问题已保留，可以重试。",
    search_after_answer: "作答后可以联网查证。",
    invalid_model: "该模型已调整，请重新选择。",
    model_unavailable: "当前 API 项目暂时无法调用这个模型，可以切换后重试。",
  };

  function element(tag, text = "", className = "") {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function appendInline(parent, text, sources) {
    for (const part of text.split(/(\*\*[^*]+\*\*|〔\d+〕)/g)) {
      if (part.startsWith("**") && part.endsWith("**")) {
        const strong = element("strong");
        appendInline(strong, part.slice(2, -2), sources);
        parent.append(strong);
        continue;
      }
      const match = part.match(/^〔(\d+)〕$/);
      const source = match && sources[Number(match[1]) - 1];
      if (!source || !/^https?:\/\//i.test(source.url)) {
        parent.append(part);
        continue;
      }
      const link = element("a", part, "tutor-citation");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = source.title;
      link.setAttribute("aria-label", "来源 " + match[1] + " · " + source.title);
      parent.append(link);
    }
  }

  function replyContent(text, sources) {
    const body = element("div", "", "tutor-reply");
    let list;
    let paragraph;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        list = paragraph = null;
        continue;
      }
      const entry = line.trim().match(/^(?:(\d{1,2})[.、)]\s+|[-*•]\s+)(.+)$/);
      if (entry) {
        const tag = entry[1] ? "ol" : "ul";
        if (list?.localName !== tag) {
          list = element(tag);
          if (entry[1]) list.start = Number(entry[1]);
          body.append(list);
        }
        const item = element("li");
        appendInline(item, entry[2], sources);
        list.append(item);
        paragraph = null;
      } else {
        list = null;
        if (!paragraph) {
          paragraph = element("p");
          body.append(paragraph);
        } else paragraph.append("\n");
        appendInline(paragraph, line.trim(), sources);
      }
    }
    return body;
  }

  function promptChoices(question) {
    const { answerVisible, focus, answer = [], selected } = question;
    const hasOptions = Object.keys(question.options).length > 1;
    if (!answerVisible) return [
      focus
        ? [`理解 ${focus} 项`, "先弄懂选项里的关键词", `请解释 ${focus} 项的关键词和概念，只给解题提示。`]
        : ["拆解题干", "找出范围和限定词", "这题在考什么？请指出题干关键词和限定范围，先给提示。"],
      hasOptions
        ? ["区分易混选项", "先了解概念的区别", "请讲讲这道题涉及的易混概念，给我一个自己辨别选项的提示。"]
        : ["复习考点", "回忆相关概念", "请帮我回忆这题相关的概念，先给提示。"],
    ];
    const rejected = focus || selected.find((letter) => !answer.includes(letter));
    return [
      rejected
        ? answer.includes(rejected)
          ? [`为什么选 ${rejected}`, "看看这一项如何扣住题干", `请结合本题解释为什么要选 ${rejected} 项。`]
          : [`为什么不选 ${rejected}`, "看这一项与题干要求的关系", `为什么本题不选 ${rejected}？请解释这一项和题干要求的关系。`]
        : ["为什么这样答", "按题干逐步推理", "请结合本题和已有依据解释作答思路。"],
      hasOptions
        ? ["辨析其他选项", "比较容易混淆的说法", "请对照题干辨析其他几个易混的选项。"]
        : ["整理易混考点", "归纳这题里容易记错的概念", "请归纳这道题容易混淆的概念和记忆线索。"],
    ];
  }

  function trackKeyboard() {
    const visual = window.visualViewport;
    if (!dialog.open || !visual) return;
    dialog.style.setProperty("--tutor-visible-height", `${Math.round(visual.height)}px`);
    dialog.style.setProperty("--tutor-keyboard", `${Math.max(0, Math.round(innerHeight - visual.height - visual.offsetTop))}px`);
  }

  function connect(call, fillNote) {
    const buttons = new Map();
    let account = null;
    let available = false;
    let searchAvailable = false;
    let preferredModel = "";
    try { preferredModel = localStorage.getItem(modelKey) || ""; } catch { /* Keep the default. */ }
    let checked = 0;
    let checking = null;
    let retryTimer;
    let chat = null;
    let pending = null;

    function setAvailable(value, capabilities) {
      available = value;
      searchAvailable = capabilities?.webSearch === true;
      const choices = Array.isArray(capabilities?.models) ? capabilities.models : [];
      model.replaceChildren(...choices.map(({ id, label }) => new Option(label, id)));
      model.value = choices.some(choice => choice.id === preferredModel) ? preferredModel : capabilities?.defaultModel || "";
      byId("quiz-tutor-model-label").hidden = !choices.length;
      for (const [button, context] of buttons) button.hidden = !value || !context;
      renderComposer();
    }

    async function refresh(retry = false) {
      if (!account || checking || document.hidden || (!retry && Date.now() - checked < 45000)) return;
      const probe = {};
      checking = probe;
      checked = Date.now();
      const result = await Promise.resolve().then(() => call("GET")).catch(() => null);
      if (checking !== probe) return;
      checking = null;
      const allowed = result?.data?.available;
      if (typeof allowed === "boolean") {
        clearTimeout(retryTimer);
        setAvailable(allowed, result.data);
      } else if (!retry && result?.code !== "sign_in") {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void refresh(true);
        }, 3500);
      }
    }

    function renderTurns(toEnd) {
      const questionId = chat.question.id;
      starters.hidden = Boolean(pending);
      starters.toggleAttribute("data-followup", chat.turns.length > 0);
      if (chat.turns.length) log.after(starters);
      else log.before(starters);
      log.replaceChildren(...chat.turns.map(({ role, text, searched, sources = [], model: usedModel }) => {
        const row = element("li", "", "tutor-turn");
        row.dataset.role = role;
        const isReply = role === "assistant";
        const name = element("strong", isReply ? "题目助手" : "你", "tutor-turn-name");
        row.append(name);
        const meta = [usedModel, searched && (sources.length ? "已联网查证" : "已联网 · 未取得可引用来源")].filter(Boolean);
        if (meta.length) row.append(element("p", meta.join(" · "), "tutor-answer-meta"));
        row.append(isReply ? replyContent(text, sources) : element("p", text));
        if (isReply) {
          const button = element("button", "填入本题笔记", "tutor-note-action");
          button.type = "button";
          button.setAttribute("aria-haspopup", "dialog");
          button.setAttribute("aria-controls", "question-note-dialog");
          button.onclick = () => fillNote(questionId, sources.length
            ? [text, "网络来源", ...sources.map((source, index) => `〔${index + 1}〕${source.title} ${source.url}`)].join("\n")
            : text);
          row.append(button);
        }
        return row;
      }));
      scroll.scrollTop = toEnd ? scroll.scrollHeight : 0;
    }

    function renderComposer() {
      const busy = Boolean(pending);
      send.disabled = busy || !available || !field.value.trim();
      field.readOnly = busy;
      waiting.hidden = !busy;
      search.hidden = !searchAvailable || !chat?.question.answerVisible;
      search.disabled = busy || !available;
      search.setAttribute("aria-pressed", String(Boolean(chat?.search)));
      model.disabled = busy;
      tools.hidden = search.hidden && !model.options.length;
      for (const button of prompts.children) button.disabled = busy || !available;
    }

    async function ask(text) {
      if (pending || !chat || !text || !available || !dialog.open) return;
      const active = chat;
      const controller = new AbortController();
      pending = controller;
      active.turns.push({ role: "user", text });
      active.draft = "";
      field.value = "";
      status.textContent = "";
      renderComposer();
      renderTurns(true);
      const restoreDraft = (message) => {
        active.turns.pop();
        field.value = active.draft = text;
        status.textContent = message;
      };
      try {
        const turns = active.turns.slice(-7).map(({ role, text }) => ({ role, text }));
        const result = await call("POST", {
          question: active.question, turns, search: active.search === true, model: model.value || undefined,
        }, controller.signal);
        if (controller.signal.aborted || chat !== active) return;
        if (typeof result?.data?.answer === "string" && result.data.answer.trim()) {
          active.turns.push({
            role: "assistant", text: result.data.answer, searched: result.data.searched === true,
            sources: Array.isArray(result.data.sources) ? result.data.sources : [], model: result.data.model,
          });
          active.search = false;
        } else {
          restoreDraft(errors[result?.code] || "暂时无法回答。可以编辑后重新发送。");
        }
      } catch {
        if (controller.signal.aborted || chat !== active) return;
        restoreDraft("连接中断。问题已保留，可以重新发送。");
      } finally {
        if (pending === controller) {
          pending = null;
          renderComposer();
          renderTurns(active.turns.length > 0);
        }
      }
    }

    function open(question) {
      if (!available || dialog.open) return;
      if (chat?.question.id !== question.id || chat.question.answerVisible !== question.answerVisible) {
        chat = { question, turns: [], draft: "" };
      }
      else chat.question = question;
      context.open = false;
      stem.textContent = question.stem;
      byId("quiz-tutor-meta").textContent = [question.chapter, `${question.type}题`].filter(Boolean).join(" · ");
      byId("quiz-tutor-mode").textContent = question.answerVisible ? "复盘解析" : "解题提示";
      const focused = byId("quiz-tutor-focus");
      const value = question.options[question.focus];
      focused.hidden = !value;
      focused.textContent = value ? `${question.focus} 项 · ${value}` : "";
      evidence.hidden = !question.textbook && !question.explanation;
      evidence.open = false;
      byId("quiz-tutor-source").textContent = question.textbook ? [
        ({ related: "教材相关段落", difference: "教材原文（表述有差异）" })[question.textbookMatch] || "教材依据",
        question.textbookPage,
      ].filter(Boolean).join(" · ") : "本题解析";
      byId("quiz-tutor-quote").textContent = question.textbook || question.explanation || "";
      prompts.replaceChildren(...promptChoices(question).map(([title, detail, text]) => {
        const button = element("button");
        button.type = "button";
        button.append(element("strong", title), element("small", detail));
        button.onclick = () => ask(text);
        return button;
      }));
      status.textContent = "";
      field.value = chat.draft;
      field.placeholder = question.answerVisible ? "继续追问这道题" : "想从哪里找提示？";
      dialog.showModal();
      trackKeyboard();
      renderComposer();
      renderTurns(chat.turns.length > 0);
    }

    search.onclick = () => {
      if (!chat || pending || search.hidden) return;
      chat.search = !chat.search;
      renderComposer();
    };
    model.onchange = () => {
      preferredModel = model.value;
      try { localStorage.setItem(modelKey, preferredModel); } catch { /* Retain the selection for this session. */ }
    };

    function bind(button, question) {
      buttons.set(button, question);
      button.hidden = !available || !question;
      button.onclick = question ? () => open(question) : null;
      if (question) {
        button.querySelector("[data-tutor-label]").textContent = question.focus ? `问 ${question.focus} 项` : "问这题";
        button.querySelector("[data-tutor-purpose]").textContent = question.answerVisible ? "追问解析" : "解题提示";
      }
      void refresh();
    }

    function resetPending() {
      if (!pending) return;
      pending.abort();
      pending = null;
      if (chat?.turns.at(-1)?.role === "user") chat.draft = chat.turns.pop().text;
      renderComposer();
    }

    function accountChanged(id) {
      if (id === account) return;
      resetPending();
      account = id;
      chat = null;
      checking = null;
      clearTimeout(retryTimer);
      checked = 0;
      setAvailable(false);
      if (dialog.open) dialog.close();
      void refresh();
    }

    byId("quiz-tutor-form").onsubmit = (event) => {
      event.preventDefault();
      void ask(field.value.trim());
    };
    field.addEventListener("input", () => {
      if (chat) chat.draft = field.value;
      renderComposer();
    });
    byId("quiz-tutor-close").onclick = sheet.close;
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      resetPending();
      dialog.style.removeProperty("--tutor-visible-height");
      dialog.style.removeProperty("--tutor-keyboard");
    });
    window.visualViewport?.addEventListener("resize", trackKeyboard);
    window.visualViewport?.addEventListener("scroll", trackKeyboard);
    window.addEventListener("focus", () => refresh());
    window.addEventListener("online", () => refresh(true));
    document.addEventListener("visibilitychange", () => refresh(true));
    renderComposer();
    return { bind, accountChanged };
  }

  function questionContext(item, { selected = [], revealed = false, focus } = {}) {
    const study = revealed ? window.QuizOptionNotes.study(item) : null;
    const reference = study?.reference;
    return {
      id: item.id, stem: item.stem, type: item.type, chapter: item.chapter,
      options: item.options, selected, focus, answerVisible: revealed,
      ...(revealed ? {
        answer: item.blank_answers?.map((variants) => variants.join(" / ")) || item.answer,
        explanation: study?.explanation,
        textbook: reference?.quote,
        textbookPage: reference?.page ? `${reference.chapter}第 ${reference.page}${reference.endPage ? `–${reference.endPage}` : ""} 页` : undefined,
        textbookMatch: reference?.match,
        optionEvidence: window.QuizOptionNotes.tutorEvidence(item),
      } : {}),
    };
  }

  window.QuizTutor = { connect, questionContext };
})();
