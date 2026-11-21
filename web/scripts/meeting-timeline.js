(() => {
  "use strict";

  const field = (id) => document.getElementById("meeting-" + id);
  const normalize = (text) => text.normalize("NFKC").replace(/[\p{P}\s]/gu, "");

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function dateLabel(event) {
    const [year, month, day] = event.date.split("-").map(Number);
    if (!event.end) return `${year}年${month}月${day}日`;
    const [, lastMonth, lastDay] = event.end.split("-").map(Number);
    return `${year}年${month}月${day}日–${lastMonth === month ? "" : lastMonth + "月"}${lastDay}日`;
  }

  function questionKey(item) {
    if (item.common_question_id) return item.common_question_id;
    const answers = item.answer.map((answer) => normalize(item.options[answer] || answer)).sort();
    return [item.type, normalize(item.stem), ...answers].join("|");
  }

  function connect({ questions, priority, practiceQuestions }) {
    const dialog = field("dialog");
    const data = window.QuizMeetingData;
    if (!dialog || !data?.events?.length) return null;

    const sheet = window.QuizSheetMotion?.attach(dialog);
    const related = new Map();
    for (const event of data.events) {
      for (const id of event.questions) {
        if (!questions.has(id)) continue;
        if (!related.has(id)) related.set(id, []);
        related.get(id).push(event.id);
      }
    }
    const tracks = new Map(data.tracks.map((track) => [track.id, track]));
    const selector = field("track");
    selector.replaceChildren(new Option("全部线索", "all"), ...data.tracks.map((track) => new Option(track.label, track.id)));
    const viewButtons = [...dialog.querySelectorAll("[data-meeting-view]")];
    let view = "timeline";
    let focus = [];
    let returnScroll = 0;
    const expanded = new Set();

    function itemsFor(events) {
      const unique = new Map();
      for (const event of events) {
        for (const id of event.questions) {
          const item = questions.get(id);
          if (!item) continue;
          const key = questionKey(item);
          const previous = unique.get(key);
          if (!previous || priority(item) > priority(previous)) unique.set(key, item);
        }
      }
      return [...unique.values()];
    }

    function practice(items) {
      if (!items.length) return;
      returnScroll = dialog.scrollTop;
      dialog.close();
      practiceQuestions(items.map((item) => item.id));
    }

    function questionRows(items) {
      return items.map((item) => {
        const li = element("li");
        const button = element("button");
        button.type = "button";
        button.dataset.questionId = item.id;
        button.append(element("span", item.stem, "meeting-question-stem"),
          element("span", `${item.chapter} · ${item.type}题 · ${item.source || "思政云"}`, "meeting-question-meta"));
        button.onclick = () => practice([item]);
        li.append(button);
        return li;
      });
    }

    function eventCard(event) {
      const li = element("li", "", "meeting-event");
      li.dataset.meetingEvent = event.id;
      li.toggleAttribute("data-highlighted", focus.includes(event.id));
      const time = element("time", dateLabel(event));
      time.dateTime = event.date;
      const card = element("div", "", "meeting-event-card");
      const title = element("h3", event.title);
      title.tabIndex = -1;
      const sources = element("div", "", "meeting-event-sources");
      for (const source of event.sources) {
        const link = element("a", source.label);
        link.href = source.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        sources.append(link);
      }
      card.append(title, element("strong", event.clue, "meeting-event-clue"), element("p", event.detail), sources);
      const items = itemsFor([event]);
      if (items.length) {
        const details = element("details");
        details.open = expanded.has(event.id);
        details.ontoggle = () => {
          if (!details.isConnected) return;
          if (details.open) expanded.add(event.id);
          else expanded.delete(event.id);
        };
        const summary = element("summary", `查看关联原题 · ${items.length} 道`);
        const questions = element("ul", "", "meeting-questions");
        questions.append(...questionRows(items));
        details.append(summary, questions);
        card.append(details);
      }
      li.append(time, card);
      return li;
    }

    function render() {
      const track = tracks.get(selector.value);
      const events = track ? data.events.filter((event) => track.events.includes(event.id)) : data.events;
      const items = itemsFor(events);
      field("hint").hidden = !track;
      field("hint").textContent = track?.hint || "";
      const practiceButton = field("practice");
      practiceButton.textContent = items.length ? `练 ${items.length} 道原题` : "暂无可练原题";
      practiceButton.disabled = !items.length;
      practiceButton.onclick = () => practice(items);
      for (const button of viewButtons) {
        const target = button.dataset.meetingView;
        button.setAttribute("aria-pressed", String(target === view));
        field(target).hidden = target !== view;
      }
      if (view === "timeline") field(view).replaceChildren(...events.map(eventCard));
      else field(view).replaceChildren(...questionRows(items));
    }

    function open({ id, resume = false } = {}) {
      if (dialog.open) return;
      if (!resume) {
        focus = id ? related.get(id) || [] : [];
        const track = focus.length && data.tracks.find((group) => focus.every((event) => group.events.includes(event)));
        selector.value = track?.id || "all";
        expanded.clear();
        view = "timeline";
        returnScroll = 0;
      }
      render();
      dialog.showModal();
      if (resume) dialog.scrollTop = returnScroll;
      else if (focus.length) {
        const target = field("timeline").querySelector("[data-highlighted]");
        if (target) {
          const top = target.getBoundingClientRect().top - dialog.getBoundingClientRect().top + dialog.scrollTop;
          dialog.scrollTop = Math.max(0, top - 12);
          target.querySelector("h3").focus({ preventScroll: true });
        }
      } else dialog.scrollTop = 0;
    }

    selector.onchange = () => {
      focus = [];
      render();
    };
    for (const button of viewButtons) {
      button.onclick = () => {
        view = button.dataset.meetingView;
        render();
      };
    }
    field("close").onclick = () => sheet ? sheet.close() : dialog.close();
    field("entry-count").textContent = `${data.events.length} 个时间节点 · ${itemsFor(data.events).length} 道专题原题`;
    field("open").hidden = false;
    field("open").onclick = () => open();
    return {
      open,
      link(button, id) {
        const hasLink = related.has(id);
        button.hidden = !hasLink;
        button.onclick = hasLink ? () => open({ id }) : null;
      },
    };
  }

  window.QuizMeetingTimeline = { connect };
})();
