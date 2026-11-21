function connectChapterPicker() {
  "use strict";

  const dialog = document.getElementById("chapter-picker");
  const heading = document.getElementById("chapter-picker-heading");
  const list = document.getElementById("chapter-picker-options");
  if (typeof dialog.showModal !== "function") return;
  const sheet = window.QuizSheetMotion?.attach(dialog);
  const nativeUI = window.webkit?.messageHandlers?.quizNativeUI;

  const fields = [...document.querySelectorAll(".picker-field")].map((container) => ({
    container,
    select: container.querySelector("select"),
    label: container.querySelector("label"),
    trigger: container.querySelector("button"),
    value: container.querySelector(".picker-field-value"),
  })).filter(({ select }) => select.options.length > 0);

  function chapterTotals() {
    const cards = [...document.getElementById("chapter-list").children].filter((row) => !row.hidden);
    const totals = new Map(cards.map((row) => [row.dataset.chapter, Number(row.dataset.count)]));
    totals.set("", [...totals.values()].reduce((sum, count) => sum + count, 0));
    return totals;
  }
  let active = null;
  let rows = [];
  let nativePending = false;

  function refresh() {
    for (const { select, label, trigger, value } of fields) {
      const text = select.selectedOptions[0]?.textContent ?? `选择${label.textContent}`;
      if (value.textContent !== text) value.textContent = text;
      trigger.disabled = select.disabled;
    }
    if (active) {
      for (const row of rows) {
        row.setAttribute("aria-selected", String(row.dataset.value === active.select.value));
      }
    }
  }

  function focusRow(index) {
    for (const [position, row] of rows.entries()) row.tabIndex = position === index ? 0 : -1;
    rows[index].focus({ preventScroll: true });
    rows[index].scrollIntoView({ block: "nearest" });
  }

  list.addEventListener("keydown", (event) => {
    const index = rows.indexOf(document.activeElement);
    if (index < 0) return;
    const next = {
      ArrowUp: Math.max(0, index - 1),
      ArrowDown: Math.min(rows.length - 1, index + 1),
      Home: 0,
      End: rows.length - 1,
    }[event.key];
    if (!Number.isInteger(next)) return;
    event.preventDefault();
    focusRow(next);
  });

  function close() {
    if (!dialog.open || !active) return;
    if (sheet) sheet.close();
    else dialog.close();
  }

  function selectValue(select, value) {
    if (select.value === value || ![...select.options].some((option) => option.value === value)) return;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function openNative(field) {
    if (nativePending || dialog.open) return;
    const { select, label, trigger } = field;
    const totals = select.id === "chapter" ? chapterTotals() : null;
    const items = [...select.options].map((option) => ({
      value: option.value,
      title: option.textContent,
      detail: totals ? `${totals.get(option.value) ?? 0} 道` : null,
    }));
    nativePending = true;
    trigger.setAttribute("aria-expanded", "true");
    try {
      const result = await nativeUI.postMessage({
        kind: "choices", title: `选择${label.textContent}`, items, selected: select.value,
      });
      if (typeof result?.value === "string") selectValue(select, result.value);
    } catch {
      open(field);
    } finally {
      nativePending = false;
      if (!dialog.open) {
        trigger.setAttribute("aria-expanded", "false");
        if (trigger.getClientRects().length) trigger.focus({ preventScroll: true });
      }
    }
  }

  function open(field) {
    if (dialog.open) return;
    active?.trigger.setAttribute("aria-expanded", "false");
    active = field;
    const { select, label, trigger } = field;
    const chapters = select.id === "chapter";
    const totals = chapters ? chapterTotals() : null;
    heading.textContent = `选择${label.textContent}`;
    rows = [...select.options].map((option) => {
      const row = document.createElement("button");
      const name = document.createElement("span");
      const detail = document.createElement("span");
      const marker = document.createElement("span");
      row.type = "button";
      row.setAttribute("role", "option");
      row.dataset.value = option.value;
      name.textContent = option.textContent;
      name.className = "chapter-picker-name";
      detail.className = "chapter-picker-detail";
      if (chapters) {
        row.dataset.chapter = option.value;
        const count = document.createElement("span");
        count.className = "chapter-picker-count";
        count.textContent = `${totals.get(option.value) ?? 0} 道`;
        detail.append(count);
      }
      marker.className = "chapter-picker-marker";
      marker.setAttribute("aria-hidden", "true");
      detail.append(marker);
      row.append(name, detail);
      row.addEventListener("click", () => {
        selectValue(select, option.value);
        close();
      });
      return row;
    });
    list.replaceChildren(...rows);
    refresh();
    dialog.showModal();
    trigger.setAttribute("aria-expanded", "true");
    focusRow(Math.max(0, select.selectedIndex));
  }

  dialog.addEventListener("close", () => {
    if (dialog.open || !active) return;
    const { trigger } = active;
    active = null;
    trigger.setAttribute("aria-expanded", "false");
    if (trigger.getClientRects().length) trigger.focus({ preventScroll: true });
  });
  document.getElementById("chapter-picker-close").addEventListener("click", close);

  for (const field of fields) {
    const { container, select, label, trigger } = field;
    label.htmlFor = trigger.id;
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    container.classList.add("picker-field-enhanced");
    select.addEventListener("change", refresh);
    trigger.addEventListener("click", () => nativeUI ? openNative(field) : open(field));
    trigger.hidden = false;
  }
  window.QuizChapterPicker = { refresh };
  refresh();
 }
if (document.documentElement.dataset.studyReady === "true") connectChapterPicker();
else window.addEventListener("quiz-study-ready", connectChapterPicker, { once: true });
