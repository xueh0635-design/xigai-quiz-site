(() => {
  "use strict";

  const get = (id) => document.getElementById("desk-progress-" + id);
  const number = new Intl.NumberFormat("zh-CN");
  const scopeNames = { all: "全部题库", sizheng: "思政云", xuexitong: "学习通", common: "常考题" };
  const typeNames = ["单选", "多选", "判断", "填空", "未分类"];
  const percent = (done, total) => total ? `${Math.round(1000 * done / total) / 10}%` : "—";

  function node(element, value, className) {
    const item = document.createElement(element);
    if (value) item.textContent = value;
    if (className) item.className = className;
    return item;
  }

  function stats(entry, owner) {
    return { answered: entry[owner], correct: entry[owner + "Correct"], review: entry[owner + "Review"] || 0 };
  }

  function segment(kind, count, scale) {
    const item = node("span", "", "desk-chart-" + kind);
    item.style.setProperty("--segment", `${scale ? 100 * count / scale : 0}%`);
    return item;
  }

  function showMetrics(chapters, owner) {
    let total = 0, answered = 0, correct = 0, review = 0, finished = 0;
    for (const chapter of chapters) {
      const activity = stats(chapter, owner);
      total += chapter.total;
      answered += activity.answered;
      correct += activity.correct;
      review += activity.review;
      if (activity.answered === chapter.total) finished += 1;
    }
    const metrics = [
      ["completion", "题库完成度", percent(answered, total), `已答 ${number.format(answered)} / ${number.format(total)} 道`],
      ["accuracy", "整体正确率", percent(correct, answered), `答对 ${number.format(correct)} · 答错 ${number.format(answered - correct)}`],
      ["review", "待复练", `${number.format(review)} 道`, ""],
      ["chapters", "已练完章节", `${finished} / ${chapters.length}`, ""],
    ];
    get("metrics").replaceChildren(...metrics.map(([key, label, value, detail]) => {
      const item = node("div");
      item.dataset.metric = key;
      const dd = node("dd");
      dd.append(node("strong", value));
      if (detail) dd.append(node("span", detail));
      item.append(node("dt", label), dd);
      return item;
    }));
  }

  function showTrend(days, owner) {
    const entries = [...days].reverse().map((entry, index) => {
      const [, month, day] = entry.date.split("-").map(Number);
      const today = index === days.length - 1;
      return { ...stats(entry, owner), label: today ? "今天" : `${month}/${day}`, date: today ? "今天" : `${month}月${day}日` };
    });
    const weekCount = entries.reduce((sum, entry) => sum + entry.answered, 0);
    const weekCorrect = entries.reduce((sum, entry) => sum + entry.correct, 0);
    const studyDays = entries.filter((entry) => entry.answered > 0).length;
    get("week-summary").textContent = weekCount
      ? `${studyDays} 天有作答 · ${weekCount} 道 · 正确率 ${percent(weekCorrect, weekCount)}`
      : "近 7 天暂无作答记录。";

    const peak = Math.max(1, ...entries.map((entry) => entry.answered));
    const unit = 10 ** Math.floor(Math.log10(peak));
    const max = Math.ceil(peak / unit) * unit;
    const axis = node("div", "", "desk-day-chart-axis");
    axis.setAttribute("aria-hidden", "true");
    axis.append(node("span", String(max)), node("span", "0"));
    const columns = node("div", "", "desk-day-chart-columns");
    const buttons = entries.map((entry) => {
      const button = node("button");
      button.type = "button";
      const stack = node("span", "", "desk-day-stack");
      const mistakes = entry.answered - entry.correct;
      stack.setAttribute("aria-hidden", "true");
      stack.append(segment("wrong", mistakes, max), segment("correct", entry.correct, max));
      button.append(stack, node("span", entry.label));
      const accuracy = entry.answered ? ` · 正确率 ${percent(entry.correct, entry.answered)}` : "";
      const detail = `${entry.date} · 已答 ${entry.answered} · 答对 ${entry.correct} · 答错 ${mistakes}${accuracy}`;
      button.setAttribute("aria-label", detail);
      button.onclick = () => {
        for (const day of buttons) day.setAttribute("aria-pressed", String(day === button));
        get("day-detail").textContent = detail;
      };
      return button;
    });
    columns.append(...buttons);
    get("days").replaceChildren(axis, columns);
    buttons.at(-1)?.click();
  }

  function barRow(label, amount, detail, correct, wrong, total) {
    const row = node("li");
    const heading = node("div", "", "desk-chart-row-label");
    heading.append(node("strong", label), node("span", amount));
    const track = node("div", "", "desk-chart-track");
    track.setAttribute("aria-hidden", "true");
    track.append(segment("correct", correct, total), segment("wrong", wrong, total));
    row.append(heading, track, node("small", detail, "desk-chart-row-detail"));
    return row;
  }

  function activityBar(label, entry, owner) {
    const { answered, correct, review } = stats(entry, owner);
    const accuracy = answered ? `正确率 ${percent(correct, answered)}` : "还未作答";
    return barRow(label, `${answered} / ${entry.total} 道`, `${accuracy} · 待复练 ${review} 道`,
      correct, answered - correct, entry.total);
  }

  function connect({ questions, rpc, openOwnHistory }) {
    const dialog = get("dialog");
    if (!dialog) return null;
    const sheet = window.QuizSheetMotion?.attach(dialog);
    const cards = [...document.querySelectorAll("[data-desk-progress-owner]")];
    const views = [...dialog.querySelectorAll("[data-progress-view]")];
    const chapterOrder = [...new Set([...questions.values()].map((item) => item.chapter))];
    let access = null;
    let opener = null;
    let pending = null;
    let refreshPending = false;
    let tests = [];

    function showView(view) {
      for (const button of views) {
        const selected = view === button.dataset.progressView;
        button.setAttribute("aria-pressed", String(selected));
        get(button.dataset.progressView).hidden = !selected;
      }
    }

    function showTestBars() {
      const bank = get("test-bank").value;
      const byChapter = new Map(tests.filter((entry) => entry.bank === bank).map((entry) => [entry.chapter, entry]));
      get("test-bars").replaceChildren(...chapterOrder.filter((chapter) => byChapter.has(chapter)).map((chapter) => {
        const { correct, total } = byChapter.get(chapter);
        return barRow(chapter, `${correct} / ${total} 道`, correct === total ? "全对" : `正确率 ${percent(correct, total)}`,
          correct, total - correct, total);
      }));
    }

    function render(data, owner) {
      const chapterData = new Map(data.chapters.map((entry) => [entry.chapter, entry]));
      const typeData = new Map(data.types.map((entry) => [entry.type, entry]));
      showMetrics(data.chapters, owner);
      showTrend(data.days, owner);
      get("chapter-bars").replaceChildren(...chapterOrder.filter((name) => chapterData.has(name))
        .map((name) => activityBar(name, chapterData.get(name), owner)));
      get("type-bars").replaceChildren(...typeNames.filter((name) => typeData.has(name))
        .map((name) => activityBar(name === "未分类" ? name : name + "题", typeData.get(name), owner)));
      tests = data.tests[owner];
      const scopes = Object.keys(scopeNames).filter((scope) => tests.some((entry) => entry.bank === scope));
      const selectedBank = get("test-bank").value;
      get("test-bank").replaceChildren(...scopes.map((scope) => new Option(scopeNames[scope], scope)));
      if (scopes.includes(selectedBank)) get("test-bank").value = selectedBank;
      get("test-filter").hidden = !scopes.length;
      get("tests-empty").hidden = Boolean(scopes.length);
      showTestBars();
      get("history").hidden = owner !== "mine";
      get("data").hidden = false;
    }

    async function load() {
      if (!access || !dialog.open || !opener || pending) return;
      const owner = opener.dataset.deskProgressOwner;
      const request = {};
      pending = request;
      get("retry").hidden = true;
      if (get("data").hidden) get("status").textContent = "正在加载学习进度…";
      try {
        const admin = access === "admin";
        const { data, error } = await rpc(admin ? "quiz_pk_admin_progress" : "quiz_pk_progress_details");
        if (pending !== request || !dialog.open) return;
        const allowed = admin ? data?.access === "admin" : data?.paired;
        if (error || !allowed || data.days?.length !== 7 || !Array.isArray(data.chapters) ||
            !Array.isArray(data.types) || !Array.isArray(data.tests?.[owner])) {
          throw error || new Error("progress_unavailable");
        }
        render(data, owner);
        get("status").textContent = "";
      } catch {
        if (pending !== request || !dialog.open) return;
        get("status").textContent = "暂时无法加载学习进度。";
        get("retry").hidden = false;
      } finally {
        if (pending === request) {
          pending = null;
          if (refreshPending) {
            refreshPending = false;
            load();
          }
        }
      }
    }

    for (const card of cards) {
      card.onclick = () => {
        if (!access || dialog.open) return;
        pending = null;
        opener = card;
        const name = card.dataset.deskProgressOwner === "mine" ? "我" : access === "admin" ? "学友" : "同桌";
        get("title").textContent = `${name}的学习进度`;
        showView("trend");
        card.focus({ preventScroll: true });
        dialog.showModal();
        dialog.scrollTop = 0;
        load();
      };
    }
    for (const button of views) button.onclick = () => showView(button.dataset.progressView);
    get("test-bank").onchange = showTestBars;
    get("retry").onclick = load;
    get("close").onclick = () => sheet ? sheet.close() : dialog.close();
    get("history").onclick = () => {
      if (opener?.dataset.deskProgressOwner !== "mine") return;
      dialog.close();
      openOwnHistory();
    };
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      opener = null;
      pending = null;
      refreshPending = false;
      tests = [];
      get("data").hidden = true;
      for (const id of ["metrics", "days", "chapter-bars", "type-bars", "test-bars"]) get(id).replaceChildren();
    });

    return {
      refresh() {
        if (pending) refreshPending = true;
        else load();
      },
      setAccess(next) {
        if (access === next) return;
        access = next;
        pending = null;
        refreshPending = false;
        if (dialog.open) dialog.close();
      },
    };
  }

  window.QuizDeskProgress = { connect };
})();
