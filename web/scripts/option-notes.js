(() => {
  "use strict";

  const dialog = document.getElementById("option-notes-dialog");
  const closeButton = document.getElementById("option-notes-close");
  const tabs = document.getElementById("option-notes-tabs");
  const scroll = document.getElementById("option-notes-scroll");
  const content = document.getElementById("option-notes-content");
  const evidence = document.getElementById("option-notes-basis");
  const { concepts, questionNotes } = window.QuizOptionKnowledge;
  const sheet = window.QuizSheetMotion.attach(dialog);
  const bindings = new WeakMap();
  const holdTime = 480;
  let session;
  let gesture;
  let suppressClickUntil = 0;
  let renderEvidence;
  let tutor;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function term(value) {
    return value.normalize("NFKC").trim().replace(/^[“”「」‘’"']+|[“”「」‘’"'。]+$/g, "");
  }

  function lookup(value) {
    const name = term(value);
    const concept = concepts.get(name);
    if (concept) return concept;
    const meeting = window.QuizMeetingData?.events.find((event) => event.title === name);
    if (meeting) return { category: meeting.date, summary: meeting.detail, source: meeting.sources?.[0] };
  }

  function contextualNote(item) {
    const note = questionNotes.get(item.id);
    if (note && item.answer.length === note.answers.length &&
        note.answers.every((letter) => item.answer.includes(letter)) &&
        Object.entries(note.terms).every(([letter, name]) => item.options[letter] && term(item.options[letter]) === name)) {
      return note;
    }
  }

  function reviewedDistractor(item, letter) {
    const option = item.options[letter];
    if (!option || item.answer.includes(letter)) return;
    const note = window.QuizDistractorNotes?.[item.id]?.[letter];
    if (note && option === note.option) return note;
    const contextual = contextualNote(item)?.reasons[letter];
    if (contextual) return { option, reason: contextual };
  }

  function distractor(item, letter) {
    const option = item.options[letter];
    if (!option || item.answer.includes(letter)) return;
    const reviewed = reviewedDistractor(item, letter);
    if (reviewed) return reviewed;
    const prepared = window.QuizWrongOptionReasons?.[item.id]?.[letter];
    if (prepared?.option === option) return prepared;
    return { option, reason: item.type === "判断" ? item.study?.explanation : "" };
  }

  function study(item) {
    const note = contextualNote(item);
    if (!note) return item.study;
    const { explanation, memory, reference } = note;
    return { ...item.study, explanation, memory, reference };
  }

  function tutorEvidence(item) {
    const reviewed = contextualNote(item);
    return Object.entries(item.options).flatMap(([letter, value]) => {
      const concept = lookup(value);
      const wrong = reviewedDistractor(item, letter);
      const reason = reviewed?.reasons[letter] || wrong?.reason;
      if (!concept && !reason) return [];
      const source = concept?.source || wrong?.source;
      return [{
        letter, reason, position: concept?.category, explanation: concept?.summary,
        points: concept?.items?.map(([title]) => title),
        source: source?.title || source?.label,
      }];
    });
  }

  function showEvidence(note, value, revealed) {
    const reference = note?.reference;
    const quote = reference?.quote;
    evidence.hidden = !revealed || (!reference && !note?.source?.url);
    if (evidence.hidden) return;
    evidence.open = false;
    const name = term(value);
    // The passage is the question's source. Mark the selected wording only when it occurs literally.
    const highlighted = name.length >= 2 && quote?.includes(name);
    renderEvidence(highlighted
      ? { ...note, reference: { ...reference, highlights: [name] } }
      : note, "option-note-");
  }

  function select(letter) {
    const { item, revealed } = session;
    const value = item.options[letter];
    const concept = lookup(value);
    const questionStudy = study(item);
    const correct = item.answer.includes(letter);
    tutor?.bind(document.getElementById("option-tutor-open"), window.QuizTutor.questionContext(item, {
      revealed, focus: letter,
    }));
    const falseChoice = revealed ? distractor(item, letter) : null;
    const reason = revealed ? falseChoice?.reason || contextualNote(item)?.reasons[letter] : "";
    for (const button of tabs.children) button.setAttribute("aria-pressed", String(button.value === letter));

    const lead = element("header", "", "option-note-lead");
    lead.append(element("span", `${letter} 选项`, "option-note-letter"));
    if (revealed) {
      const verdict = element("span", correct ? "本题应选" : "本题不选", "option-note-verdict");
      verdict.dataset.correct = String(correct);
      lead.append(verdict);
    }
    const parts = [lead, element("h3", value, "option-note-title")];
    if (concept?.category) parts.push(element("p", concept.category, "option-note-category"));
    if (reason) parts.push(element("p", reason, "option-note-reason"));
    if (concept?.summary) parts.push(element("p", concept.summary, "option-note-summary"));
    if (concept?.items) {
      const list = element("ol", "", "option-note-outline");
      for (const [title, description] of concept.items) {
        const row = element("li");
        row.append(element("strong", title), element("p", description));
        list.append(row);
      }
      parts.push(list);
    }
    if (concept?.memory) {
      const memory = element("aside", "", "option-note-memory");
      memory.append(element("strong", "速记"), element("p", concept.memory));
      parts.push(memory);
    }
    if (falseChoice?.applies) {
      const transfer = element("aside", "", "option-note-memory");
      transfer.append(element("strong", "换个问法"), element("p", falseChoice.applies));
      parts.push(transfer);
    }
    const reference = concept?.source || falseChoice?.source;
    if (concept?.pages || reference) {
      const source = element("p", concept?.pages ? `教材 · ${concept.pages}` : "", "option-note-source");
      if (reference) {
        const link = element("a", reference.title || reference.label);
        link.href = reference.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        if (concept?.pages) source.append(" · ");
        source.append(link);
      }
      parts.push(source);
    }
    if (!reason && revealed) {
      const answers = item.answer.map((key) => item.options[key] ? `${key} ${item.options[key]}` : key);
      const context = element("section", "", "option-note-question-context");
      context.append(element("h4", falseChoice ? "答题依据" : "本题解析"), element("p", `标准答案 · ${answers.join("；")}`));
      const note = questionStudy?.explanation;
      if (note) context.append(element("p", note));
      if (falseChoice) context.append(element("p", `${letter} 项的具体错因待补充。`, "option-note-category"));
      parts.push(context);
    } else if (!concept && !revealed) {
      parts.push(element("p", "作答后可在这里对照本题解析和依据。", "option-note-category"));
    }
    content.replaceChildren(...parts);
    showEvidence(questionStudy, value, revealed);
    scroll.scrollTop = 0;
  }

  function open(item, letter, revealed, trigger) {
    if (dialog.open || !Object.hasOwn(item.options, letter) ||
        document.querySelector("dialog[open]:not(#history-question)")) return false;
    session = { item, revealed, trigger };
    const options = Object.keys(item.options).map((key) => {
      const button = element("button", key);
      button.type = "button";
      button.value = key;
      button.setAttribute("aria-label", `${key} 选项`);
      button.setAttribute("aria-controls", content.id);
      return button;
    });
    tabs.replaceChildren(...options);
    tabs.hidden = options.length < 2;
    select(letter);
    dialog.showModal();
    return true;
  }

  function attach(button, item, letter, revealed, opensOnTap = false) {
    button.dataset.optionNote = "";
    bindings.set(button, { item, letter, revealed });
    if (opensOnTap) {
      button.dataset.optionNoteAction = "open";
      button.setAttribute("aria-haspopup", "dialog");
      button.addEventListener("click", () => open(item, letter, revealed, button));
    }
  }

  function stopGesture() {
    if (!gesture) return;
    stopHold(gesture);
    gesture = null;
  }

  function stopHold(press) {
    clearTimeout(press.timer);
    press.button.removeAttribute("data-option-holding");
  }

  document.addEventListener("pointerdown", (event) => {
    stopGesture();
    if (!event.isPrimary || event.button !== 0) return;
    suppressClickUntil = 0;
    const button = event.target.closest("button[data-option-note]");
    const target = bindings.get(button);
    if (!target || dialog.open) return;
    const press = {
      id: event.pointerId, button, x: event.clientX, y: event.clientY, opened: false,
      timer: setTimeout(() => {
        if (!button.isConnected) return stopGesture();
        press.opened = open(target.item, target.letter, target.revealed, button);
        button.removeAttribute("data-option-holding");
      }, holdTime),
    };
    gesture = press;
    button.setAttribute("data-option-holding", "");
  }, true);

  document.addEventListener("pointermove", (event) => {
    if (event.pointerId !== gesture?.id || gesture.opened || gesture.moved) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 8) {
      gesture.moved = true;
      stopHold(gesture);
    }
  }, { capture: true, passive: true });

  function finishGesture(event) {
    if (event.pointerId !== gesture?.id) return;
    if (gesture.opened || gesture.moved) suppressClickUntil = performance.now() + 550;
    stopGesture();
  }

  document.addEventListener("pointerup", finishGesture, true);
  document.addEventListener("pointercancel", finishGesture, true);
  window.addEventListener("blur", stopGesture);

  function keepOptionTextUnselected(event) {
    if (event.target instanceof Element && event.target.closest("button.option")) event.preventDefault();
  }
  document.addEventListener("selectstart", keepOptionTextUnselected, true);
  document.addEventListener("contextmenu", keepOptionTextUnselected, true);
  document.addEventListener("selectionchange", () => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) return;
    const touchesOption = [selection.anchorNode, selection.focusNode].some((node) => {
      const element = node instanceof Element ? node : node?.parentElement;
      return element?.closest("button.option");
    });
    if (touchesOption) selection.removeAllRanges();
  });

  document.addEventListener("click", (event) => {
    if (event.detail === 0 || (!gesture?.opened && performance.now() >= suppressClickUntil)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClickUntil = 0;
  }, true);

  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button && button.getAttribute("aria-pressed") !== "true") {
      select(button.value);
      if (!document.documentElement.hasAttribute("data-reduced-motion")) {
        content.animate?.([{ opacity: .54, transform: "translateY(5px)" }, { opacity: 1, transform: "none" }],
          { duration: 175, easing: "cubic-bezier(.2,.72,.22,1)" });
      }
    }
  });
  closeButton.addEventListener("click", sheet.close);
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    if (session?.trigger?.isConnected) session.trigger.focus({ preventScroll: true });
    session = null;
  });

  window.QuizOptionNotes = {
    attach, open, study, distractor, tutorEvidence,
    useEvidence: (render) => { renderEvidence = render; },
    useTutor: (assistant) => { tutor = assistant; },
  };
})();
