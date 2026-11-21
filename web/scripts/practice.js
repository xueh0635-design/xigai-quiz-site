"use strict";

const allQuestions = Array.isArray(window.QuizData) ? window.QuizData : [];
const questions = allQuestions.filter((item) => item.review_status === "可练习");
const markedForReview = allQuestions.filter((item) => item.review_status !== "可练习");
const byId = new Map(questions.map((item) => [item.id, item]));
const $ = (id) => document.getElementById(id);
const storageKey = "xigai-local-quiz-v1";
const bankStorageKey = "xigai-practice-bank-v1";
const autoAdvanceStorageKey = "xigai-auto-advance-delay-v1";
const answerHapticsStorageKey = "xigai-answer-haptics-v1";
const bankLabels = { all: "全部题库", sizheng: "思政云", xuexitong: "学习通", common: "常考题" };
const sharedQuestions = indexSharedQuestions(questions);
const libraryPageSize = 12;
const libraryTabs = {
  done: { title: "已答题", empty: "提交过作答的题目会出现在这里。" },
  wrong: { title: "错题", empty: "答错的题目会自动收录，也可以在做题时手动加入。" },
  starred: { title: "收藏", empty: "收藏的题目会出现在这里。" },
};
const tabDock = $("mobile-tabs");
const tabButtons = [...tabDock.querySelectorAll("[data-study-tab]")];
const nativeNavigation = window.webkit?.messageHandlers?.quizNativeUI;
let nativeQuestionRevision = 0;
let nativeQuestionFrame = 0;
function optionalFeature(name, create, fallback) {
  try { return create() || fallback; }
  catch (error) { console.warn(`${name} is unavailable`, error); return fallback; }
}
const persistence = window.QuizPersistence;
const optionNotes = optionalFeature("option notes", () => {
  const feature = window.QuizOptionNotes;
  feature.useEvidence(renderStudyEvidence);
  return feature;
}, { available: false, study: (item) => item?.study, distractor: () => null, attach() {}, open() {}, useTutor() {} });
const quizTutor = optionalFeature("question tutor", () => window.QuizTutor.connect((...args) => sync?.tutor?.(...args), openQuestionNote),
  { bind(button) { if (button) button.hidden = true; }, accountChanged() {} });
const tutorContext = (...args) => window.QuizTutor?.questionContext?.(...args) || null;
optionalFeature("option tutor", () => optionNotes.useTutor(quizTutor), null);
const developmentRequests = optionalFeature("development requests", () => window.QuizDevelopmentRequests.connect((...args) => sync?.development?.(...args)),
  { accountChanged() {} });
const chapterTopics = {
  "新增（必刷）": "综合考点",
  "导论": "理论的形成、内容与地位",
  "第一章": "新时代坚持和发展中国特色社会主义",
  "第二章": "中国式现代化与中华民族伟大复兴",
  "第三章": "党的全面领导",
  "第四章": "以人民为中心",
  "第五章": "全面深化改革开放",
  "第六章": "高质量发展",
  "第七章": "教育、科技和人才",
  "第八章": "全过程人民民主",
  "第九章": "全面依法治国",
  "第十章": "社会主义文化强国",
  "第十一章": "民生与社会治理",
  "第十二章": "社会主义生态文明",
  "第十三章": "维护和塑造国家安全",
  "第十四章": "国防和军队现代化",
  "第十五章": "一国两制与祖国统一",
  "第十六章": "中国特色大国外交",
  "第十七章": "全面从严治党",
  "结语": "学以致用",
};
const chapterPools = new Map();
for (const item of questions) {
  if (!chapterPools.has(item.chapter)) chapterPools.set(item.chapter, []);
  chapterPools.get(item.chapter).push(item);
}
const reducedMotion = window.QuizWorldMotion?.preference || matchMedia("(prefers-reduced-motion: reduce)");
const studyDay = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric" });
const pageContent = document.querySelector("main");
const lessonCard = document.querySelector(".lesson-card");
let selectedTab = "practice";
let selectedBank = "all";
let inspectedChapter = null;
let profileLibrary = null;
let wrongChapter = null;
let wrongBank = "all";
let libraryLimit = libraryPageSize;
let openLibraryRow = null;
let wrongUndo = null;
let pageMotion;
let answerMotion;
let answerStreakMotion;
let answerStreakTimer;
let autoAdvanceTimer;
let sync = null;
let desk = null;
let meetingTimeline = null;
let deferredResume = null;
let state = guestState();
let guestStore = null;
let guestWrites = Promise.resolve();
const guestUnsaved = new Map();
let activeAccountId = null;
let accountSwitching = false;
let accountScopeRevision = 0;
let persistenceRevision = 0;
pageContent.inert = true;
tabDock.inert = true;
const questionNoteDialog = $("question-note-dialog");
const questionNoteText = $("question-note-text");
const questionNoteStatus = $("question-note-status");
const questionNoteSheet = optionalFeature("note sheet", () => window.QuizSheetMotion.attach(questionNoteDialog), { close: () => questionNoteDialog.close() });
let editingNote = null;

function guestState() {
  try {
    const previous = JSON.parse(localStorage.getItem(storageKey)) || {};
    return { history: previous.history || {}, stars: previous.stars || {}, notes: previous.notes || {}, session: previous.session || null, drafts: previous.drafts || {}, chapterTests: previous.chapterTests || {} };
  } catch {
    $("storage-status").textContent = "浏览器练习记录读取失败，本次可继续练习。";
    return { history: {}, stars: {}, notes: {}, session: null, drafts: {}, chapterTests: {} };
  }
}

function openQuestionNote(id, answer = "") {
  const item = byId.get(id);
  if (!item || questionNoteDialog.open) return;
  const original = state.notes[id] || "";
  editingNote = { id, original };
  $("question-note-stem").textContent = item.stem;
  questionNoteStatus.textContent = "";
  questionNoteText.value = original;
  if (answer && !original.includes(answer)) {
    const appended = [original, answer].filter(Boolean).join("\n\n");
    if (appended.length <= questionNoteText.maxLength) questionNoteText.value = appended;
    else questionNoteStatus.textContent = "这份回答放不进当前笔记。可以先缩短笔记，再填入回答。";
  }
  questionNoteDialog.showModal();
}

$("question-note-close").onclick = questionNoteSheet.close;
questionNoteDialog.addEventListener("close", () => {
  if (questionNoteDialog.open) return;
  editingNote = null;
  questionNoteText.value = "";
});
$("question-note-form").onsubmit = (event) => {
  event.preventDefault();
  if (!editingNote || questionNoteDialog.hasAttribute("data-sheet-closing")) return;
  const { id, original } = editingNote;
  const value = questionNoteText.value.trim();
  const latest = state.notes[id] || "";
  if (value !== original && value !== latest) {
    if (latest !== original) {
      editingNote.original = latest;
      questionNoteStatus.textContent = "另一台设备更新了这条笔记。再次点保存将使用当前编辑的内容。";
      return;
    }
    if (value) state.notes[id] = value;
    else delete state.notes[id];
    save([["note", id, value]]);
  }
  questionNoteSheet.close();
};

function save(changes = []) {
  if (accountSwitching) return Promise.resolve(false);
  if (!changes.length) return Promise.resolve(true);
  const revision = ++persistenceRevision;
  const input = structuredClone(changes);
  const status = $("storage-status");
  status.textContent = "正在保存…";
  let saving;
  if (sync?.enabled()) saving = sync.queue(input);
  else {
    const token = {};
    guestUnsaved.set(token, input);
    guestWrites = guestWrites.catch(() => {}).then(async () => {
      if (!guestStore) return false;
      const pending = [...guestUnsaved.entries()];
      await guestStore.commit(pending.flatMap(([, values]) => values));
      for (const [key] of pending) guestUnsaved.delete(key);
      return guestStore.durable;
    });
    saving = guestWrites;
  }
  return Promise.resolve(saving).then((saved) => {
    if (revision === persistenceRevision) status.textContent = saved ? "" : "本机保存不可用，请保持页面打开并重试。";
    return saved;
  }).catch(() => {
    if (revision === persistenceRevision) status.textContent = "保存失败，本次更改尚未入库，请保持页面打开并重试。";
    return false;
  });
}

function setAccountSwitching(value) {
  accountSwitching = value;
  pageContent.inert = value;
  tabDock.inert = value;
  if (value) cancelAutoAdvance();
}

function draftSnapshot(session) {
  if (!session?.sid || !Array.isArray(session.ids)) return null;
  const copy = structuredClone(session);
  delete copy.chapterStudy;
  return copy;
}

function rememberSession(session) {
  const draft = draftSnapshot(session);
  if (!draft) return null;
  state.drafts ??= {};
  const complete = draft.testSubmitted || draft.index >= draft.ids.length;
  if (complete) delete state.drafts[draft.sid];
  else state.drafts[draft.sid] = draft;
  return ["draft", draft.sid, complete ? null : draft];
}

function saveSession(extra = []) {
  const session = state.session;
  applyQuestionRedos(session);
  if (!session?.sid) return save(extra);
  deferredResume = null;
  session.updatedAt = Date.now();
  session.chapterStudy = { tests: state.chapterTests || session.chapterStudy?.tests || {} };
  const draft = rememberSession(session);
  return save([...extra, ...(draft ? [draft] : []), ["session", "resume", session]]);
}

function activateDraft(draft) {
  const previous = rememberSession(state.session);
  state.session = { ...structuredClone(draft), chapterStudy: { tests: state.chapterTests || {} } };
  saveSession(previous ? [previous] : []);
}

function matchingDraft(predicate) {
  const candidates = [state.session, ...Object.values(state.drafts || {})].filter((session) =>
    session && Array.isArray(session.ids) && session.ids.every((id) => byId.has(id)) && predicate(session));
  return candidates.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0];
}

function view(name) {
  cancelAutoAdvance();
  if (name !== "quiz") clearAnswerStreak();
  if (deferredResume && name !== "quiz" && name !== "result") {
    state.session = deferredResume;
    deferredResume = null;
  }
  answerMotion?.cancel();
  answerMotion = null;
  const wasAnswering = !$("quiz").hidden;
  const answering = name === "quiz";
  for (const id of ["setup", "quiz", "result", "library", "desk", "profile"]) $(id).hidden = id !== name;
  document.documentElement.classList.toggle("question-swipe-active", answering);
  if (nativeNavigation && answering !== wasAnswering) {
    nativeNavigation.postMessage({ kind: "question-swipe", enabled: answering }).catch(() => {});
    syncNativeQuestionPosition();
  }
  $("overview").hidden = name !== "setup";
  desk?.show(name === "desk");
}

function animatePage(horizontal, vertical, duration = 210) {
  pageMotion?.cancel();
  const surface = $("quiz").hidden ? pageContent : lessonCard;
  pageMotion = window.QuizWorldMotion?.page(surface, horizontal, vertical, duration);
}

reducedMotion.addEventListener("change", () => {
  if (!reducedMotion.matches) return;
  pageMotion?.cancel();
  answerMotion?.cancel();
  lessonCard.style.removeProperty("translate");
  answerStreakMotion?.cancel();
});

function showTab(tab, animate = false, fromNative = false) {
  const previousIndex = tabButtons.findIndex((button) => button.dataset.studyTab === selectedTab);
  if (nativeNavigation && !fromNative && selectedTab !== tab) {
    nativeNavigation.postMessage({ kind: "tab", tab, animate: animate && !reducedMotion.matches }).catch(() => {});
  }
  if (selectedTab !== tab || profileLibrary) {
    resetLibrary();
    wrongChapter = null;
    wrongBank = selectedBank;
  }
  profileLibrary = null;
  $("history-question").close();
  selectedTab = tab;
  const index = tabButtons.findIndex((button) => button.dataset.studyTab === tab);
  for (const [position, button] of tabButtons.entries()) {
    if (position === index) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  tabDock.style.setProperty("--tab-index", String(index));
  moveTabLens(index, animate);
  const library = libraryTabs[tab];
  const destination = library ? "library" : { desk: "desk", profile: "profile" }[tab] || "setup";
  const changed = index !== previousIndex || $(destination).hidden;
  $("back").textContent = library ? `返回${library.title}` : "返回路线";
  view(destination);
  updateAvailability();
  window.scrollTo(0, 0);
  if (animate && changed) animatePage(Math.sign(index - previousIndex) * 8, index === previousIndex ? -8 : 0);
  else if (changed) pageMotion?.cancel();
}

function openProfileLibrary(scope) {
  if (profileLibrary !== scope) {
    resetLibrary();
    wrongChapter = null;
    wrongBank = "all";
  }
  profileLibrary = scope;
  $("back").textContent = `返回${libraryTabs[scope].title}`;
  view("library");
  updateAvailability();
  window.scrollTo(0, 0);
  $("library-title").focus({ preventScroll: true });
  animatePage(0, 9);
}

function returnFromQuestion() {
  if (state.session?.meetingPractice && meetingTimeline) {
    showTab("practice", true);
    meetingTimeline.open({ resume: true });
  } else if (profileLibrary) openProfileLibrary(profileLibrary);
  else showTab(selectedTab, true);
}

function appendCommonQuestionBadge(container, item) {
  const badge = document.createElement("span");
  badge.className = "common-question-badge";
  renderCommonQuestionBadge(badge, item);
  if (!badge.hidden) container.append(badge);
}

function renderCommonQuestionBadge(badge, item) {
  const shared = sharedQuestions.has(item.id);
  badge.hidden = !shared && !item.common_question;
  badge.title = shared ? "两个题库共用作答进度" : "两库收录相近考点";
  badge.textContent = shared ? "两库同题" : "常考";
}

function filterScope(scope) {
  $("advanced-settings").open = true;
  $("chapter").value = "";
  $("scope").value = scope;
  for (const type of $("types").querySelectorAll("input")) type.checked = true;
  updateAvailability();
  const scopeTrigger = $("scope-picker-trigger");
  (scopeTrigger && !scopeTrigger.hidden ? scopeTrigger : $("scope")).focus();
}

function makeOption(text, value) {
  const item = document.createElement("option");
  item.textContent = text;
  item.value = value;
  return item;
}

function inBank(item, bank) {
  return window.QuizQuestionCatalog.inBank(item, bank);
}

function questionTextKey(value) {
  return window.QuizQuestionCatalog.questionTextKey(value);
}

function indexSharedQuestions(pool) {
  return window.QuizQuestionCatalog.indexSharedQuestions(pool);
}

function sharedQuestionId(id) {
  return sharedQuestions.get(id)?.[0] || id;
}

function translateSelection(selected, from, to) {
  if (!Array.isArray(selected)) return [];
  if (from === to || !Object.keys(byId.get(from).options).length) return selected;
  const options = new Map(Object.entries(byId.get(to).options).map(([letter, text]) => [questionTextKey(text), letter]));
  const translated = selected.map((letter) => {
    const text = byId.get(from).options[letter];
    return text && options.get(questionTextKey(text));
  });
  return translated.every(Boolean) ? translated : [];
}

function historyRecordId(id) {
  const group = sharedQuestions.get(id);
  if (!group) return id;
  let chosen = group[0];
  for (const candidate of group.slice(1)) {
    const entry = state.history[candidate];
    const previous = state.history[chosen];
    if (entry && (!previous || (typeof entry.wrong === "boolean" &&
        (typeof previous.wrong !== "boolean" || (Number(entry.last) || 0) > (Number(previous.last) || 0))))) {
      chosen = candidate;
    }
  }
  return chosen;
}

function historyEntry(id) {
  return state.history[historyRecordId(id)];
}

function isStarred(id) {
  return (sharedQuestions.get(id) || [id]).some((copy) => state.stars[copy] === true);
}

function commonQuestionPriority(item) {
  const entry = historyEntry(item.id);
  if (typeof entry?.wrong === "boolean") return 2 + (Number.isFinite(entry.last) ? Math.max(0, entry.last) : 0);
  return Number(Boolean(isStarred(item.id) || entry?.review));
}

function bankQuestions(bank, pool = questions, scope = "all") {
  if (bank !== "common") {
    const seen = new Set();
    return pool.filter((item) => {
      const id = sharedQuestionId(item.id);
      if (seen.has(id) || !inBank(item, bank) || !inScope(item, scope)) return false;
      seen.add(id);
      return true;
    });
  }
  const shared = new Map();
  for (const item of pool) {
    const id = item.common_question_id || sharedQuestions.get(item.id)?.[0];
    // For 未做过, consider both sources before filtering out answered questions.
    if (!id || (scope !== "new" && !inScope(item, scope))) continue;
    const previous = shared.get(id);
    const priority = commonQuestionPriority(item);
    if (!previous || priority > previous.priority || (priority === previous.priority && item.id === id)) {
      shared.set(id, { item, priority });
    }
  }
  return [...shared.values()].map(({ item }) => item).filter((item) => inScope(item, scope));
}

function chapterQuestions(chapter, bank = selectedBank) {
  return bankQuestions(bank, chapterPools.get(chapter) || []);
}

function requiresAnswer(id) {
  return byId.get(id)?.type !== "填空";
}

function chapterStudy(chapter, bank) {
  const pool = chapterQuestions(chapter, bank);
  const remaining = [];
  const marked = [];
  let total = 0;
  let latest = 0;
  for (const item of pool) {
    if (inWrongLibrary(item.id)) marked.push(item.id);
    if (!requiresAnswer(item.id)) continue;
    total++;
    if (hasAnswered(item.id)) latest = Math.max(latest, Number(historyEntry(item.id).last) || 0);
    else remaining.push(item.id);
  }
  const wrong = marked.filter(requiresAnswer);
  const test = state.chapterTests?.[bank + ":" + chapter] || state.session?.chapterStudy?.tests?.[bank + ":" + chapter];
  return { chapter, bank, pool, total, answered: total - remaining.length, remaining, wrong, marked, latest, test };
}

function selectBank(bank) {
  if (bank !== selectedBank) inspectedChapter = null;
  selectedBank = bank;
  try {
    localStorage.setItem(bankStorageKey, bank);
  } catch {
    // Continue with the current page's selection when storage is unavailable.
  }
  for (const button of $("bank-selector").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.studyBank === bank));
  }
  const common = bank === "common";
  const total = bankQuestions(bank).length.toLocaleString("zh-CN");
  $("inventory").textContent = `${total} 道${common ? "常考题" : "原题"}`;
  $("setup-heading").textContent = common ? "常考题章节" : "章节路线";
  const chapterSelect = $("chapter");
  const previous = chapterSelect.value;
  const chapters = [...chapterPools.keys()].filter((chapter) => chapterQuestions(chapter).length);
  chapterSelect.replaceChildren(makeOption("全部章节", ""), ...chapters.map((chapter) => makeOption(chapter, chapter)));
  chapterSelect.value = chapters.includes(previous) ? previous : "";
  updateAvailability();
}

function setup() {
  setupAutoAdvanceDelay();
  setupAnswerHaptics();
  $("stat-done").onclick = () => filterScope("done");
  $("stat-wrong").onclick = () => showTab("wrong", true);
  $("stat-starred").onclick = () => showTab("starred", true);
  $("chapter").append(makeOption("全部章节", ""));
  for (const name of new Set(allQuestions.map((item) => item.chapter))) {
    $("chapter").append(makeOption(name, name));
    const pool = chapterPools.get(name);
    if (pool?.length) $("chapter-list").append(makeChapterCard(name, pool.length));
  }
  if (questions.some((item) => item.chapter === "新增（必刷）")) $("chapter").value = "新增（必刷）";
  for (const kind of ["单选", "多选", "判断", "填空"]) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = kind;
    input.checked = true;
    label.append(input, kind + "题");
    $("types").append(label);
  }
  const allowSources = questions.some((item) => inBank(item, "xuexitong"));
  const allowCommon = sharedQuestions.size > 0 || questions.some((item) => item.common_question_id);
  const reviewBanks = allowSources ? ["all", "sizheng", "xuexitong"] : ["all"];
  if (allowCommon) reviewBanks.push("common");
  $("wrong-bank").replaceChildren(...reviewBanks.map((bank) => makeOption(bankLabels[bank], bank)));
  $("bank-selector").hidden = !allowSources;
  $("bank-selector").querySelector('[data-study-bank="common"]').hidden = !allowCommon;
  for (const button of $("bank-selector").querySelectorAll("button")) {
    button.onclick = () => selectBank(button.dataset.studyBank);
  }
  let savedBank;
  try {
    savedBank = localStorage.getItem(bankStorageKey);
  } catch {
    savedBank = "all";
  }

  $("review-panel").hidden = markedForReview.length === 0;
  $("review-count").textContent = `${markedForReview.length} 道`;
  for (const item of markedForReview) {
    const link = document.createElement("a");
    link.href = item.source_image;
    link.target = "_blank";
    link.rel = "noopener";
    link.title = item.review_reasons.join("、");
    link.textContent = `${item.chapter} · 第 ${item.number} 题`;
    $("review-list").append(link);
  }

  if (state.session && (!Array.isArray(state.session.ids) || !state.session.ids.every((id) => byId.has(id)))) {
    state.session = null;
    save();
  }
  applyQuestionRedos(state.session);
  const hasSavedBank = allowSources && Object.hasOwn(bankLabels, savedBank) && (savedBank !== "common" || allowCommon);
  selectBank(hasSavedBank ? savedBank : "all");
}

function setupAutoAdvanceDelay() {
  const field = $("auto-advance-delay");
  try {
    const saved = localStorage.getItem(autoAdvanceStorageKey);
    if ([...field.options].some((option) => option.value === saved)) field.value = saved;
  } catch {
    // The initial option remains available when device storage cannot be read.
  }
  field.addEventListener("change", () => {
    try {
      localStorage.setItem(autoAdvanceStorageKey, field.value);
    } catch {
      $("storage-status").textContent = "无法保存等待时间，本次仍可使用所选时长。";
    }
  });
}

function setupAnswerHaptics() {
  const capacitor = window.Capacitor;
  if (!capacitor?.isPluginAvailable?.("QuizHaptics")) return;

  const field = $("answer-haptics");
  try {
    field.checked = localStorage.getItem(answerHapticsStorageKey) !== "off";
  } catch {
    // The switch still applies for the current session.
  }
  field.addEventListener("change", () => {
    try {
      localStorage.setItem(answerHapticsStorageKey, field.checked ? "on" : "off");
    } catch {
      $("storage-status").textContent = "无法保存震动设置，本次仍可使用所选设置。";
    }
  });
  $("answer-haptics-setting").hidden = false;
}

function playAnswerHaptic(outcome) {
  if ($("answer-haptics-setting").hidden || !$("answer-haptics").checked || document.hidden) return;
  window.Capacitor.Plugins.QuizHaptics.answer({ outcome }).catch(() => {});
}

function clearAnswerStreak() {
  window.clearTimeout(answerStreakTimer);
  answerStreakMotion?.cancel();
  answerStreakMotion = null;
  $("answer-streak").hidden = true;
  $("answer-streak-status").textContent = "";
}

function showAnswerStreak(count) {
  clearAnswerStreak();
  if (count < 2) return;
  const scene = $("answer-streak");
  const milestone = count % 5 === 0;
  scene.dataset.tier = milestone ? "milestone" : count === 2 ? "pair" : "run";
  scene.toggleAttribute("data-wide", count > 99);
  $("answer-streak-count").textContent = count;
  $("answer-streak-status").textContent = `连对 ${count} 题`;
  scene.hidden = false;
  const duration = milestone ? 1440 : 1180;
  answerStreakMotion = window.QuizWorldMotion?.answerStreak(scene, duration);
  answerStreakTimer = window.setTimeout(clearAnswerStreak, duration);
}

function makeChapterCard(chapter, total) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "chapter-card";
  card.dataset.chapter = chapter;
  card.dataset.quickChapter = chapter;
  card.dataset.count = total;
  const description = document.createElement("span");
  description.className = "chapter-description";
  const title = document.createElement("span");
  title.className = "chapter-name";
  title.textContent = chapter;
  description.append(title);
  if (chapterTopics[chapter]) {
    const topic = document.createElement("span");
    topic.className = "chapter-topic";
    topic.textContent = chapterTopics[chapter];
    description.append(topic);
  }
  const count = document.createElement("span");
  count.className = "chapter-count";
  const track = document.createElement("span");
  track.className = "chapter-track";
  track.setAttribute("aria-hidden", "true");
  track.append(document.createElement("span"));
  const arrow = document.createElement("span");
  arrow.className = "chapter-arrow";
  arrow.setAttribute("aria-hidden", "true");
  description.append(count, track);
  const medallion = document.createElement("span");
  medallion.className = "chapter-medallion";
  medallion.setAttribute("aria-hidden", "true");
  const landmark = document.createElement("img");
  landmark.src = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MiA1MiIgZmlsbD0ibm9uZSIgYXJpYS1oaWRkZW49InRydWUiPgogIDxnIHN0cm9rZT0iIzI4MjI0NCIgc3Ryb2tlLXdpZHRoPSIyLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+CiAgICA8Y2lyY2xlIGN4PSIzOS41IiBjeT0iMTMiIHI9IjUuNSIgZmlsbD0iI2YzYTc1MCIvPgogICAgPHBhdGggZD0iTTguNSAzMCAyMyAxMC41bDkuNSAxMi43IDQtNC43TDQ1IDMwIiBmaWxsPSIjMzQ3NDYxIi8+CiAgICA8cGF0aCBkPSJtMTguNSAxNi42IDQuNCAxLjkgMy44LTIuOSIvPgogICAgPHBhdGggZD0iTTUuNSAyN2M4LTEuNSAxNC4zLjEgMjAuNSA0LjF2MTVjLTYuMy00LTEyLjUtNS41LTIwLjUtNHoiIGZpbGw9IiNmM2E3NTAiLz4KICAgIDxwYXRoIGQ9Ik00Ni41IDI3Yy04LTEuNS0xNC4zLjEtMjAuNSA0LjF2MTVjNi4zLTQgMTIuNS01LjUgMjAuNS00eiIgZmlsbD0iIzgwNjViZiIvPgogICAgPHBhdGggZD0iTTExIDM0YzMuNiAwIDYuMy43IDkuMiAyLjJtMTItMS4xYTIzIDIzIDAgMCAxIDguOS0yLjEiLz4KICA8L2c+Cjwvc3ZnPgo=";
  landmark.alt = "";
  medallion.append(landmark);
  card.append(medallion, description, arrow);
  card.onclick = () => openChapter(chapter);
  return card;
}

function chapterForSession(session) {
  const chapter = session?.routePlan?.chapter || session?.commonChapter || session?.quickChapter;
  if (chapterPools.has(chapter)) return chapter;
  return session?.adventure ? byId.get(session.ids?.[0])?.chapter : null;
}

function bankForSession(session) {
  return session?.commonOnly ? "common" : session?.bankScope || "all";
}

function isAdventureSession(session) {
  return isChapterPractice(session) && Boolean(session.adventure || session.commonChapter || session.routePlan);
}

function isChapterPractice(session) {
  return session?.mode === "practice" && Boolean(chapterForSession(session)) && session.routePlan?.kind !== "review";
}

function usesChapterHistory(session) {
  return isChapterPractice(session) && !session.repeatChapter;
}

function questionResult(session, id) {
  const saved = session?.results?.[id];
  const useHistory = usesChapterHistory(session) || (session?.reuseSharedHistory && sharedQuestions.has(id));
  const source = useHistory && historyRecordId(id);
  const entry = source && state.history[source];
  if (typeof entry?.wrong === "boolean") {
    const selected = translateSelection(entry.selected, source, id);
    return { selected, correct: !entry.wrong, roundSelection: selected.length ? undefined : saved?.selected };
  }
  return saved;
}

function sessionQuestionKey(session, id) {
  return (bankForSession(session) === "common" && byId.get(id)?.common_question_id) || sharedQuestionId(id);
}

function canResumeSession(session = state.session) {
  if (byId.has(session?.ids?.[session.index])) return true;
  if (!isChapterPractice(session)) return false;
  return chapterQuestions(chapterForSession(session), bankForSession(session))
    .some((item) => requiresAnswer(item.id) && !questionResult(session, item.id));
}

function chapterPracticeDraft(chapter, bank, repeatChapter = false) {
  const matches = (session) => isChapterPractice(session) && chapterForSession(session) === chapter &&
    bankForSession(session) === bank && Boolean(session.repeatChapter) === repeatChapter &&
    session.ids?.every((id) => byId.has(id)) && canResumeSession(session);
  return matchingDraft(matches);
}

function pauseChapterPractice(session) {
  if (!isChapterPractice(session) ||
      !session.ids?.some((id) => byId.has(id) && requiresAnswer(id) && !session.results[id])) return undefined;
  const { chapterStudy, ...draft } = session;
  return draft;
}

function openChapter(chapter, { bank = selectedBank, whole = false, review = false } = {}) {
  $("advanced-settings").open = false;
  const draft = chapterPracticeDraft(chapter, bank, whole);
  if (draft) {
    if (draft !== state.session) {
      activateDraft(draft);
    }
    resumeQuestion({ review });
    return;
  }
  const plan = chapterStudy(chapter, bank);
  if (!plan.pool.length) return;
  const ids = plan.pool.map((item) => item.id);
  const target = review ? ids.findIndex(hasAnswered) : ids.indexOf(plan.remaining[0]);
  start(ids, "practice", {
    quickChapter: chapter, adventure: true, bankScope: bank, ...(whole ? { repeatChapter: true } : {}),
  }, whole ? 0 : Math.max(0, target));
}

function openChapterReview(chapter, bank) {
  if (profileLibrary === "wrong") openProfileLibrary("wrong");
  else showTab("wrong", true);
  resetLibrary();
  wrongBank = bank;
  wrongChapter = chapter;
  updateAvailability();
  $("library-title").focus({ preventScroll: true });
}

function chapterRoundDraft(chapter, bank, kind) {
  return matchingDraft((session) => session.routePlan?.kind === kind && session.routePlan.chapter === chapter &&
    bankForSession(session) === bank && canResumeSession(session) && session.index < session.ids.length &&
    (kind === "test" ? !session.testSubmitted : session.ids.some((id) => requiresAnswer(id) && !session.results?.[id])));
}

function chapterRoundInProgress(chapter, bank, kind) {
  return Boolean(chapterRoundDraft(chapter, bank, kind));
}

function startWrongChapter(chapter, bank, id) {
  const draft = !id && chapterRoundDraft(chapter, bank, "review");
  if (draft) {
    if (draft !== state.session) activateDraft(draft);
    resumeQuestion();
    return;
  }
  const plan = chapterStudy(chapter, bank);
  const ids = id ? plan.wrong.filter((key) => key === id) : plan.wrong;
  if (ids.length) start(ids, "practice", { bankScope: bank, routePlan: { chapter, kind: "review" } });
}

function startChapterTest(chapter, bank) {
  const draft = chapterRoundDraft(chapter, bank, "test");
  if (draft) {
    if (draft !== state.session) activateDraft(draft);
    resumeQuestion();
    return;
  }
  const ids = chapterQuestions(chapter, bank).map((item) => item.id);
  if (ids.length) start(shuffled(ids), "chapter-test", { bankScope: bank, routePlan: { chapter, kind: "test" } });
}

function hasAnswered(id) {
  return typeof historyEntry(id)?.wrong === "boolean";
}

function clearRoundAnswer(session, id) {
  if (session.results?.[id] && session.mode === "practice") session.correctStreak = 0;
  delete session.results?.[id];
  delete session.drafts?.[id];
  if (session.ids[session.index] === id && session.selected?.length) session.selected = [];
}

function applyQuestionRedos(session) {
  for (const round of [session, ...Object.values(state.drafts || {})]) {
    // An exam keeps its own drafts and submitted score when a practice answer changes.
    if (!round?.ids || round.mode === "chapter-test") continue;
    for (const id of round.ids) {
      const redo = state.history[id]?.redo;
      if (!redo || round.questionRedos?.[id] === redo) continue;
      clearRoundAnswer(round, id);
      (round.questionRedos ??= {})[id] = redo;
    }
  }
}

function redoCurrentRoundOnly(session) {
  return takingChapterTest(session) || session?.mode === "memory";
}

function canRedoCurrentQuestion(id) {
  const session = state.session;
  return Boolean(session.results[id] || session.selected.length ||
    (!redoCurrentRoundOnly(session) && (hasAnswered(id) || inWrongLibrary(id))));
}

function redoQuestion(item, fromHistory = false) {
  const id = item.id;
  const session = state.session;
  const roundOnly = !fromHistory && redoCurrentRoundOnly(session);
  cancelAutoAdvance();
  clearAnswerStreak();
  if (roundOnly) {
    clearRoundAnswer(session, id);
    saveSession();
  } else {
    // Clear all copies of this question without overwriting another device's resume.
    const entry = { redo: randomId() };
    const changes = (sharedQuestions.get(id) || [id]).map((key) => {
      state.history[key] = entry;
      return ["history", key, entry];
    });
    applyQuestionRedos(session);
    applyQuestionRedos(deferredResume);
    save(changes);
  }
  if (fromHistory) $("history-question").close();
  const index = session?.ids.indexOf(id) ?? -1;
  if ((!roundOnly && session?.mode !== "practice") || index < 0) {
    start([id], "practice", { bankScope: bankForSession(session) });
  } else if (index !== session.index) {
    goToQuestion(index);
  } else {
    renderQuestion();
    window.scrollTo(0, 0);
    $("question").focus({ preventScroll: true });
  }
}

function inWrongLibrary(id) {
  const entry = historyEntry(id);
  return entry?.review ?? (entry?.wrong === true);
}

function setWrongReview(id, review) {
  const key = historyRecordId(id);
  const entry = { ...state.history[key] };
  if (review === undefined) delete entry.review;
  else entry.review = review;
  state.history[key] = entry;
  save([["history", key, entry]]);
}

function renderWrongReview(id) {
  const inLibrary = inWrongLibrary(id);
  const button = $("wrong-review");
  button.setAttribute("aria-pressed", String(inLibrary));
  button.textContent = inLibrary ? "移出错题本" : "加入错题本";
}

function renderQuestionFlags(id) {
  const starred = isStarred(id);
  $("star").setAttribute("aria-pressed", String(starred));
  $("star").textContent = starred ? "已收藏" : "收藏";
  renderWrongReview(id);
  $("question-redo").disabled = !canRedoCurrentQuestion(id);
}

function inScope(item, scope) {
  if (scope === "new") return !hasAnswered(item.id);
  if (scope === "done") return hasAnswered(item.id);
  if (scope === "wrong") return inWrongLibrary(item.id);
  if (scope === "starred") return isStarred(item.id);
  return true;
}

function matches() {
  const chosenTypes = new Set([...$("types").querySelectorAll("input:checked")].map((box) => box.value));
  const chapter = $("chapter").value;
  const scope = $("scope").value;
  const pool = chapter ? (chapterPools.get(chapter) || []) : questions;
  return bankQuestions(selectedBank, pool.filter((item) => chosenTypes.has(item.type)), scope)
    .filter((item) => scope !== "all" || $("mode").value !== "practice" ||
      !sharedQuestions.has(item.id) || !hasAnswered(item.id));
}

function setOpenLibraryRow(row) {
  if (openLibraryRow === row) return;
  for (const [currentRow, open] of [[openLibraryRow, false], [row, true]]) {
    if (!currentRow) continue;
    const menu = currentRow.querySelector(".library-menu");
    const remove = currentRow.querySelector(".library-remove");
    if (!open && document.activeElement === remove) menu.focus({ preventScroll: true });
    currentRow.classList.toggle("is-open", open);
    menu.setAttribute("aria-expanded", String(open));
    remove.inert = !open;
  }
  openLibraryRow = row;
}

function resetLibrary() {
  setOpenLibraryRow(null);
  wrongUndo = null;
  libraryLimit = libraryPageSize;
}

function makeWrongRow(item, questionButton) {
  const row = document.createElement("div");
  row.className = "library-row";
  row.dataset.questionId = item.id;

  const surface = document.createElement("div");
  surface.className = "library-row-surface";
  const menu = document.createElement("button");
  menu.type = "button";
  menu.className = "library-menu";
  menu.textContent = "···";
  menu.setAttribute("aria-label", "错题操作");
  menu.setAttribute("aria-expanded", "false");
  menu.onclick = () => setOpenLibraryRow(openLibraryRow === row ? null : row);
  surface.append(questionButton, menu);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "library-remove";
  remove.textContent = "移除";
  remove.inert = true;
  remove.onclick = () => {
    const entry = historyEntry(item.id);
    wrongUndo = { id: item.id, previous: entry?.review, last: entry?.last };
    setWrongReview(item.id, false);
    updateAvailability();
    $("library-undo").focus({ preventScroll: true });
  };
  row.append(surface, remove);
  return row;
}

function renderWrongChapters(list) {
  const chapters = [...chapterPools.keys()].map((chapter) => chapterStudy(chapter, wrongBank))
    .filter((plan) => plan.answered || plan.marked.length || plan.test)
    .sort((first, second) => Number(Boolean(second.wrong.length)) - Number(Boolean(first.wrong.length)));
  const pending = chapters.filter((plan) => plan.wrong.length);
  const mistakes = pending.reduce((count, plan) => count + plan.wrong.length, 0);
  $("library-count").textContent = mistakes ? `${pending.length} 章 · ${mistakes} 道待复练`
    : chapters.length ? "暂无待复练题，可以查看已练章节。" : "答错的题会按章节收录。";
  const focused = document.activeElement.dataset.reviewChapter;
  const rows = chapters.map((plan) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "library-item chapter-review-row";
    button.dataset.reviewChapter = plan.chapter;
    button.dataset.pending = String(Boolean(plan.wrong.length));
    const heading = document.createElement("strong");
    heading.textContent = plan.chapter;
    const detail = document.createElement("small");
    detail.textContent = plan.total ? `已练 ${plan.answered} / ${plan.total} 道` : "填空题回看";
    const badge = document.createElement("span");
    badge.className = "chapter-review-count";
    badge.textContent = plan.wrong.length ? `${plan.wrong.length} 道待复练 ›` : "查看进度 ›";
    button.append(heading, detail, badge);
    button.onclick = () => openChapterReview(plan.chapter, plan.bank);
    return button;
  });
  list.replaceChildren(...rows);
  rows.find((row) => row.dataset.reviewChapter === focused)?.focus({ preventScroll: true });
}

function renderChapterStudy(plan) {
  const testSize = plan.test?.total;
  const passed = plan.total > 0 && !plan.remaining.length && !plan.wrong.length &&
    (testSize === plan.total || testSize === plan.pool.length) && plan.test?.correct === testSize;
  const steps = [
    ["已练", `${plan.answered} / ${plan.total}`],
    ["待复练", `${plan.wrong.length} 道`, plan.wrong.length ? "pending" : ""],
    ["整章测验", passed ? "已通过" : plan.test ? "待再测" : "未测验", passed ? "passed" : ""],
  ];
  $("chapter-study-steps").replaceChildren(...steps.map(([label, count, status]) => {
    const step = document.createElement("div");
    const name = document.createElement("span");
    const value = document.createElement("strong");
    name.textContent = label;
    value.textContent = count;
    if (status) step.dataset.status = status;
    step.append(name, value);
    return step;
  }));
  $("chapter-study-last-test").hidden = !plan.test;
  $("chapter-study-last-test").textContent = plan.test ? `上次测验答对 ${plan.test.correct} / ${plan.test.total} 道` : "";
  const resume = chapterPracticeDraft(plan.chapter, plan.bank);
  const next = $("wrong-continue");
  next.hidden = !plan.remaining.length && !resume;
  next.textContent = resume ? "继续本章" : "练剩余题";
  next.onclick = () => openChapter(plan.chapter, { bank: plan.bank });
  const test = $("wrong-test");
  test.hidden = !plan.total;
  test.textContent = chapterRoundInProgress(plan.chapter, plan.bank, "test") ? "继续测验" : "整章测验";
  test.onclick = () => startChapterTest(plan.chapter, plan.bank);
  const primary = plan.wrong.length ? $("library-start") : !next.hidden ? next : test;
  for (const button of [$("library-start"), next, test]) button.classList.toggle("primary", button === primary);
}

function renderLibrary() {
  const scope = profileLibrary || selectedTab;
  const { title, empty } = libraryTabs[scope];
  const wrong = scope === "wrong";
  const done = scope === "done";
  const plan = wrong && wrongChapter ? chapterStudy(wrongChapter, wrongBank) : null;
  const list = $("library-list");
  $("library-title").textContent = plan ? `${plan.chapter} · 错题复练` : wrong ? "错题本" : title;
  $("library-back").hidden = !profileLibrary && !plan;
  $("library-back").textContent = plan ? "返回错题本" : "返回我的旅程";
  $("wrong-bank-field").hidden = !wrong || Boolean(plan) || $("wrong-bank").options.length < 2;
  $("wrong-bank").value = wrongBank;
  $("chapter-study-status").hidden = !plan;
  $("wrong-continue").hidden = true;
  $("wrong-test").hidden = true;
  $("library-start").classList.add("primary");
  if (wrong && !plan) {
    for (const id of ["library-start", "library-configure", "library-swipe-hint", "library-removal", "library-more"]) $(id).hidden = true;
    renderWrongChapters(list);
    return;
  }
  const items = plan ? plan.marked.map((id) => byId.get(id)) : bankQuestions("all", questions, scope);
  if (done) items.sort((first, second) => (historyEntry(second.id).last || 0) - (historyEntry(first.id).last || 0));
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const focusedId = focused?.closest("[data-question-id]")?.dataset.questionId;
  const openId = openLibraryRow?.dataset.questionId;
  const rows = items.slice(0, libraryLimit).map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "library-item";
    button.dataset.questionId = item.id;
    const stem = document.createElement("span");
    stem.className = "library-stem";
    stem.textContent = item.stem;
    const meta = document.createElement("span");
    meta.className = "library-meta";
    const result = done ? (historyEntry(item.id).wrong ? " · 答错" : " · 答对") : "";
    meta.textContent = `${item.chapter} · ${item.type}题${result}`;
    appendCommonQuestionBadge(meta, item);
    button.append(stem, meta);
    button.onclick = done || wrong ? () => showHistoryQuestion(item, wrong)
      : () => start([item.id], "practice");
    return wrong ? makeWrongRow(item, button) : button;
  });
  $("library-count").textContent = plan ? bankLabels[plan.bank] :
    items.length ? `共 ${items.length} 道` : `共 0 道。${empty}`;
  const startButton = $("library-start");
  startButton.hidden = done || Boolean(plan && !plan.wrong.length);
  startButton.textContent = plan ? chapterRoundInProgress(plan.chapter, plan.bank, "review")
    ? "继续复练" : `复练 ${plan.wrong.length} 道错题` : `练习${title}`;
  startButton.disabled = items.length === 0;
  startButton.onclick = plan ? () => startWrongChapter(plan.chapter, plan.bank)
    : () => start(items.map((item) => item.id), "practice");
  if (plan) renderChapterStudy(plan);
  $("library-configure").hidden = wrong || done;
  $("library-configure").disabled = items.length === 0;
  $("library-swipe-hint").hidden = !wrong || items.length === 0;
  if (wrongUndo) {
    const entry = historyEntry(wrongUndo.id);
    if (entry?.review !== false || entry.last !== wrongUndo.last) wrongUndo = null;
  }
  $("library-removal").hidden = !wrong || !wrongUndo;
  openLibraryRow = null;
  list.replaceChildren(...rows);
  if (openId) setOpenLibraryRow(rows.find((row) => row.dataset.questionId === openId) || null);
  $("library-more").hidden = items.length <= libraryLimit;
  const replacement = focusedId && rows.find((row) => row.dataset.questionId === focusedId);
  if (replacement) {
    const button = wrong ? replacement.querySelector(`.${focused.className}`) : replacement;
    button?.focus({ preventScroll: true });
  } else if (focused) {
    $("library-title").focus({ preventScroll: true });
  }
}

function optionButton(letter, value) {
  const option = document.createElement("button");
  option.type = "button";
  option.className = "option";
  const tag = document.createElement("span");
  tag.className = "letter";
  tag.textContent = letter;
  const text = document.createElement("span");
  text.textContent = value;
  option.append(tag, text);
  return option;
}

function historyOptionLabel(item, answer) {
  return item.options[answer] ? `${answer}　${item.options[answer]}` : answer;
}

function renderHistoryAnswer(item) {
  const key = historyRecordId(item.id);
  const entry = state.history[key] || {};
  const answered = typeof entry.wrong === "boolean";
  const selected = translateSelection(entry.selected, key, item.id);
  const markedWrong = inWrongLibrary(item.id);
  $("history-question-result").textContent = answered ? entry.wrong ? "上次答错" : "上次答对"
    : markedWrong ? "手动加入，尚未作答" : "尚未作答";
  $("history-question-redo").disabled = !answered && !markedWrong;
  $("history-question-practice").hidden =
    $("history-question").dataset.practice !== "true" || !markedWrong || !requiresAnswer(item.id);
  $("history-question-selection").textContent = selected.length
    ? selected.map((answer) => historyOptionLabel(item, answer)).join("\n")
    : answered ? "这条早期记录保存了判分。" : "暂无作答记录。";
  renderDistractorNotes(item, $("history-distractor-notes"), selected);
}

function showHistoryQuestion(item, practice = false) {
  const dialog = $("history-question");
  dialog.dataset.questionId = item.id;
  dialog.dataset.practice = String(practice);
  $("history-question-meta").textContent = `${item.chapter} · ${item.type}题`;
  appendCommonQuestionBadge($("history-question-meta"), item);
  $("history-question-title").textContent = item.stem;
  const rows = Object.entries(item.options).map(([letter, text]) => {
    const row = document.createElement("li");
    const option = optionButton(letter, text);
    optionNotes.attach(option, item, letter, true, true);
    row.append(option);
    return row;
  });
  $("history-question-options").replaceChildren(...rows);
  $("history-question-options").hidden = !rows.length;
  renderHistoryAnswer(item);
  const answers = item.blank_answers?.map((choices) => choices.join(" / ")) ||
    item.answer.map((answer) => historyOptionLabel(item, answer));
  $("history-question-answer").textContent = answers.join("\n");
  const study = optionNotes.study(item);
  $("history-question-study").hidden = !study?.explanation;
  $("history-question-explanation").textContent = study?.explanation || "";
  quizTutor.bind($("history-tutor-open"), tutorContext(item, {
    revealed: true, selected: state.history[item.id]?.selected || [],
  }));
  $("history-note-open").onclick = () => openQuestionNote(item.id);
  renderStudyEvidence(study, "history-question-");
  meetingTimeline?.link($("meeting-from-history"), item.id);
  const retry = $("history-question-practice");
  retry.onclick = () => {
    $("history-question").close();
    startWrongChapter(item.chapter, wrongBank, item.id);
  };
  dialog.showModal();
}

function studyRoute(bank = selectedBank) {
  return [...chapterPools.keys()].map((chapter) => chapterStudy(chapter, bank)).filter((plan) => plan.pool.length);
}

function routeChapterForSession(session) {
  return session?.routePlan?.chapter || chapterForSession(session);
}

function currentRouteChapter(chapters) {
  const inspected = chapters.find(({ chapter }) => chapter === inspectedChapter);
  if (inspected) return inspected;
  const unfinished = chapters.filter((row) => row.remaining.length);
  const needsReview = chapters.filter((row) => row.wrong.length);
  if (bankForSession(state.session) === selectedBank) {
    const savedChapter = routeChapterForSession(state.session);
    const saved = chapters.find(({ chapter }) => chapter === savedChapter);
    if (saved && (unfinished.length || !needsReview.length || saved.wrong.length || canResumeSession())) return saved;
  }
  const candidates = unfinished.length ? unfinished : needsReview;
  return candidates.reduce((recent, row) => !recent || row.latest > recent.latest ? row : recent, null) || chapters[0];
}

function nextUnfinishedChapter(chapters, currentChapter) {
  const index = chapters.indexOf(currentChapter);
  return [...chapters.slice(index + 1), ...chapters.slice(0, index)].find((row) => row.remaining.length);
}

function startRouteChapter(row, bank = selectedBank) {
  if (bank !== selectedBank) selectBank(bank);
  openChapter(row.chapter, { bank });
}

function renderRouteStops(chapters, selected) {
  const container = $("route-stops");
  const focused = container.contains(document.activeElement) ? document.activeElement.dataset.chapter : null;
  const start = Math.max(0, Math.min(chapters.indexOf(selected) - 1, chapters.length - 3));
  const stops = chapters.slice(start, start + 3).map((row) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "route-stop";
    button.dataset.chapter = row.chapter;
    button.style.setProperty("--stop-progress", `${row.total ? row.answered / row.total * 100 : 0}%`);
    if (row === selected) button.setAttribute("aria-current", "step");
    if (!row.remaining.length) button.dataset.complete = "true";
    const pin = document.createElement("span");
    pin.className = "route-pin";
    pin.setAttribute("aria-hidden", "true");
    const label = document.createElement("strong");
    label.textContent = row.chapter;
    const count = document.createElement("span");
    count.className = "route-stop-count";
    count.textContent = !row.total ? "看填空" : !row.remaining.length ? "已练完" : `${row.answered} / ${row.total}`;
    button.append(pin, label, count);
    button.onclick = () => {
      if (row === selected) return;
      inspectedChapter = row.chapter;
      updateAvailability();
    };
    return button;
  });
  container.style.setProperty("--stop-count", String(stops.length));
  container.replaceChildren(...stops);
  if (focused) stops.find((stop) => stop.dataset.chapter === focused)?.focus({ preventScroll: true });
}

function expandChapterSession() {
  const session = state.session;
  if (!isChapterPractice(session)) return;
  const pool = chapterQuestions(chapterForSession(session), bankForSession(session));
  if (!pool.length) return;
  const openId = current()?.id;
  const included = new Map(session.ids.map((id) => [sessionQuestionKey(session, id), id]));
  const poolIds = pool.map(({ id }) => included.get(sessionQuestionKey(session, id)) || id);
  const previousIds = new Set(session.ids);
  const missing = poolIds.filter((id) => !previousIds.has(id));
  if (!missing.length && openId) return;
  if (session.routePlan?.kind === "remaining" && missing.length) {
    // Older remaining-only sessions omitted the earlier answered questions.
    const inChapter = new Set(poolIds);
    session.ids = [...poolIds, ...session.ids.filter((id) => !inChapter.has(id))];
  } else {
    session.ids.push(...missing);
  }
  if (openId) {
    session.index = session.ids.indexOf(openId);
  } else {
    session.index = session.ids.findIndex((id) => requiresAnswer(id) && !questionResult(session, id));
    if (session.index < 0) session.index = session.ids.length - 1;
    const id = session.ids[session.index];
    session.selected = session.drafts?.[id] || [];
    if (session.drafts) delete session.drafts[id];
  }
  saveSession();
}

function renderLearningRoute(chapters, currentChapter, resume) {
  const start = $("adventure-start");
  const review = $("route-answers");
  const next = $("route-next");
  const chapter = currentChapter?.chapter;
  const upcoming = currentChapter && nextUnfinishedChapter(chapters, currentChapter);
  $("course-title").textContent = chapter || "学习路线";
  $("adventure-target").textContent = chapter ? chapterTopics[chapter] || "" : "当前题库暂无习题";
  $("route-progress").hidden = !currentChapter?.total;
  $("route-all-chapters").hidden = !chapter;
  $("route-map").hidden = !chapter;
  start.hidden = !chapter;
  review.hidden = !currentChapter?.answered;
  next.hidden = true;
  if (!currentChapter) return;
  const { answered, total, remaining, wrong } = currentChapter;
  review.onclick = () => openChapter(chapter, { review: true });
  $("route-answered").textContent = `${answered} / ${total} 道已答`;
  $("route-wrong").textContent = `${wrong.length} 道错题`;
  $("route-wrong").hidden = !wrong.length;
  $("adventure-goal").max = total;
  $("adventure-goal").value = answered;
  $("route-map-completion").textContent = `已练完 ${chapters.filter((row) => !row.remaining.length).length} / ${chapters.length} 章`;
  const day = studyDay.format();
  const practiced = bankQuestions("all").filter((item) => {
    const last = historyEntry(item.id)?.last;
    return Number.isFinite(last) && last > 0 && last <= 9999999999999 && studyDay.format(last) === day;
  }).length;
  $("adventure-today").textContent = ` · 今日已答 ${practiced} 道`;
  renderRouteStops(chapters, currentChapter);

  if (resume) {
    start.textContent = state.session.routePlan?.kind === "test" ? "继续测验"
      : state.session.routePlan?.kind === "review" ? "继续复练" : "继续本章";
    start.onclick = resumeQuestion;
  } else if (remaining.length) {
    start.textContent = answered ? "练剩余题" : "开始本章";
    start.onclick = () => startRouteChapter(currentChapter);
  } else if (!total) {
    start.textContent = "看填空答案";
    start.onclick = () => startRouteChapter(currentChapter);
  } else if (wrong.length) {
    start.textContent = "复习本章错题";
    start.onclick = () => openChapterReview(chapter, selectedBank);
    if (upcoming) {
      next.hidden = false;
      next.textContent = `去${upcoming.chapter}`;
      next.onclick = () => startRouteChapter(upcoming);
    }
  } else {
    start.textContent = "整章测验";
    start.onclick = () => startChapterTest(chapter, selectedBank);
    if (upcoming) {
      next.hidden = false;
      next.textContent = `去${upcoming.chapter}`;
      next.onclick = () => startRouteChapter(upcoming);
    }
  }
}

function longestStreak(ids, session) {
  let highest = 0;
  let count = 0;
  for (const id of ids) {
    if (!requiresAnswer(id)) continue;
    count = questionResult(session, id)?.correct ? count + 1 : 0;
    highest = Math.max(highest, count);
  }
  return highest;
}

function updateAvailability() {
  const length = matches().length;
  const unique = bankQuestions("all");
  const stats = {
    done: unique.filter((item) => hasAnswered(item.id)).length,
    wrong: unique.filter((item) => inWrongLibrary(item.id)).length,
    starred: unique.filter((item) => isStarred(item.id)).length,
  };
  for (const [key, count] of Object.entries(stats)) {
    $(`stat-${key}`).firstElementChild.textContent = count;
    $(`profile-${key}`).textContent = count;
  }
  $("start").disabled = length === 0;
  $("adventure-chapter-long").disabled = !chapterQuestions($("chapter").value).length;
  $("count").max = Math.max(length, 1);
  if ($("count").valueAsNumber > length && length > 0) $("count").value = length;
  $("availability").textContent = `符合条件 ${length} 道`;
  const chapters = studyRoute();
  const routeChapter = currentRouteChapter(chapters);
  const routeResume = routeChapter?.chapter && routeChapterForSession(state.session) === routeChapter.chapter &&
    bankForSession(state.session) === selectedBank && canResumeSession();
  renderLearningRoute(chapters, routeChapter, routeResume);
  const chapterProgress = new Map(chapters.map((row) => [row.chapter, row]));
  for (const card of $("chapter-list").children) {
    const row = chapterProgress.get(card.dataset.chapter);
    card.hidden = !row;
    if (!row) continue;
    const { total, answered } = row;
    card.dataset.count = row.pool.length;
    card.querySelector(".chapter-count").textContent = total ? `${answered} / ${total} 道已练` : `${row.pool.length} 道填空`;
    card.style.setProperty("--chapter-progress", `${total ? 100 * answered / total : 0}%`);
    const step = total && answered === total ? "done" : row === routeChapter ? "next" : "open";
    card.dataset.adventureState = step;
    if (row === routeChapter) card.setAttribute("aria-current", "step");
    else card.removeAttribute("aria-current");
  }
  const resume = !routeResume && (state.session?.meetingPractice || selectedBank !== "common" ||
    bankForSession(state.session) === "common") && canResumeSession();
  $("resume").hidden = !resume;
  if (resume) {
    const session = state.session;
    const chapter = routeChapterForSession(session);
    const bank = bankForSession(session);
    const kind = session.routePlan?.kind;
    const label = kind === "test" ? " · 整章测验" : kind === "review" ? " · 错题复练" : "";
    $("resume-detail").textContent = chapter
      ? `${chapter} · ${bankLabels[bank]}${label}`
      : `${session.meetingPractice ? "会议专题" : current().chapter} · ${session.index + 1} / ${session.ids.length}`;
  }
  if (!$("library").hidden) renderLibrary();
  if (!$("quiz").hidden && current()) renderQuestionFlags(current().id);
  const historyDialog = $("history-question");
  if (historyDialog.open) renderHistoryAnswer(byId.get(historyDialog.dataset.questionId));
  window.QuizChapterPicker?.refresh();
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function start(ids, mode = $("mode").value, chapterOptions = {}, index = 0) {
  if (accountSwitching) return;
  const queue = mode === "chapter-test" ? ids.filter(requiresAnswer) : ids;
  if (!queue.length) return;
  clearAnswerStreak();
  // Older clients can resume these IDs as a regular quiz without expanding them to the full chapter.
  const options = chapterOptions.bankScope === "common"
    ? { commonOnly: true, commonChapter: chapterOptions.quickChapter, routePlan: chapterOptions.routePlan,
      repeatChapter: chapterOptions.repeatChapter, reuseSharedHistory: chapterOptions.reuseSharedHistory } : chapterOptions;
  const previous = rememberSession(state.session);
  state.session = { sid: randomId(), ids: queue, mode, index, results: {}, selected: [], ...options,
    chapterStudy: { tests: state.chapterTests || {} } };
  showStartedQuestion(previous ? [previous] : []);
}

function showStartedQuestion(changes = []) {
  inspectedChapter = null;
  saveSession(changes);
  renderQuestion();
  window.scrollTo(0, 0);
  $("question").focus();
  animatePage(0, 11);
}

function shuffled(items) {
  for (let last = items.length - 1; last > 0; last--) {
    const index = Math.floor(Math.random() * (last + 1));
    [items[last], items[index]] = [items[index], items[last]];
  }
  return items;
}

function current() {
  return byId.get(state.session?.ids?.[state.session.index]);
}

function goToQuestion(index, { swipe = false, direction, focusQuestion = true } = {}) {
  if (accountSwitching) return;
  const session = state.session;
  if (!byId.has(session?.ids[index]) || index === session.index) return;
  const travel = direction ?? Math.sign(index - session.index);
  const item = current();
  const drafts = session.drafts ??= {};
  if (item && !session.results[item.id] && session.selected.length) {
    drafts[item.id] = session.selected;
  }
  session.index = index;
  const id = session.ids[index];
  session.selected = drafts[id] || [];
  delete drafts[id];
  saveSession();
  renderQuestion();
  window.scrollTo(0, 0);
  if (focusQuestion) $("question").focus({ preventScroll: true });
  animatePage(travel * (swipe ? 36 : 22), 0, swipe ? 210 : 185);
}

function checksOnTap(item) {
  const session = state.session;
  return session.mode === "practice" && (session.quickChapter || session.meetingPractice ||
    isAdventureSession(session) || session.routePlan?.kind === "review") &&
    (item.type === "单选" || item.type === "判断");
}

function choose(letter) {
  if (accountSwitching) return;
  const item = current();
  if (!item || state.session.mode === "memory" || !Object.hasOwn(item.options, letter) ||
      !requiresAnswer(item.id) || questionResult(state.session, item.id)) return;
  const selected = new Set(state.session.selected);
  if (item.type !== "多选") selected.clear();
  if (selected.has(letter)) selected.delete(letter);
  else selected.add(letter);
  state.session.selected = [...selected];
  if (checksOnTap(item)) {
    submit();
    return;
  }
  saveSession();
  renderQuestion();
}

function renderRelated(ids, session) {
  const buttons = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (!item || session.results[id]) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.questionId = id;
    const stem = document.createElement("span");
    stem.className = "related-stem";
    stem.textContent = item.stem;
    const detail = document.createElement("span");
    detail.className = "related-meta";
    detail.textContent = `${item.chapter} · ${item.type}题`;
    button.append(stem, detail);
    button.onclick = () => {
      const previousIndex = session.ids.indexOf(id);
      if (previousIndex >= 0) {
        session.ids.splice(previousIndex, 1);
        if (previousIndex < session.index) session.index -= 1;
      }
      session.ids.splice(session.index + 1, 0, id);
      goToQuestion(session.index + 1);
    };
    buttons.push(button);
  }
  $("related-list").replaceChildren(...buttons);
  $("related-study").hidden = buttons.length === 0;
}

function renderStudyEvidence(study, prefix = "") {
  const reference = study?.reference;
  const quote = reference?.quote;
  $(`${prefix}textbook-evidence`).hidden = !quote;
  $(`${prefix}textbook-label`).textContent = {
    related: "教材相关段落",
    difference: "教材原文 · 与题库表述有差异",
  }[reference?.match] || "教材原文";
  const passage = $(`${prefix}textbook-quote`);
  const citation = $(`${prefix}reference`);
  passage.replaceChildren();
  if (quote) {
    let cursor = 0;
    for (const phrase of reference.highlights || []) {
      const index = quote.indexOf(phrase, cursor);
      if (index < 0) continue;
      const mark = document.createElement("mark");
      mark.textContent = phrase;
      passage.append(quote.slice(cursor, index), mark);
      cursor = index + phrase.length;
    }
    passage.append(quote.slice(cursor));
  }
  if (!reference) {
    citation.textContent = "题库口径 · 暂未定位到直接教材依据";
    if (study?.source?.url?.startsWith("https://")) {
      const link = document.createElement("a");
      link.href = study.source.url;
      link.textContent = study.source.title;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      citation.replaceChildren("文件依据 · ", link);
    }
    return;
  }
  const pages = reference.endPage ? `${reference.page}–${reference.endPage}` : reference.page;
  const pdfPages = reference.pdfEndPage ? `${reference.pdfPage}–${reference.pdfEndPage}` : reference.pdfPage;
  const pdfLocation = pdfPages ? `（PDF 第 ${pdfPages} 页）` : "";
  citation.textContent = `教材 · ${reference.chapter} · 第 ${pages} 页${pdfLocation}`;
}

function renderDistractorNotes(item, section, selected = []) {
  const rows = [];
  const letters = Object.keys(item?.options || {});
  letters.sort((a, b) => Number(selected.includes(b)) - Number(selected.includes(a)));
  for (const letter of letters) {
    const note = optionNotes.distractor(item, letter);
    if (!note) continue;
    const row = document.createElement("li");
    if (selected.includes(letter)) row.dataset.selectedWrong = "";
    const title = document.createElement("h4");
    title.textContent = `${letter} · ${selected.includes(letter) ? "误选 · " : ""}${note.option}`;
    row.append(title);
    if (note.reason) {
      const reason = document.createElement("p");
      reason.textContent = note.reason;
      row.append(reason);
    }
    if (note.applies) {
      const context = document.createElement("p");
      context.textContent = `适用语境 · ${note.applies}`;
      row.append(context);
    }
    if (note.source) {
      const reference = document.createElement("a");
      reference.href = note.source.url;
      reference.textContent = note.source.title;
      reference.target = "_blank";
      reference.rel = "noopener noreferrer";
      row.append(reference);
    }
    const more = document.createElement("button");
    more.type = "button";
    more.textContent = note.reason ? `看 ${letter} 项详情` : `查看 ${letter} 项依据`;
    more.setAttribute("aria-haspopup", "dialog");
    more.setAttribute("aria-controls", "option-notes-dialog");
    more.addEventListener("click", () => optionNotes.open(item, letter, true, more));
    row.append(more);
    rows.push(row);
  }
  section.querySelector("ul").replaceChildren(...rows);
  section.hidden = !rows.length;
}

function renderRoundProgress(session) {
  const scored = session.ids.filter(requiresAnswer);
  const answered = scored.filter((id) => questionResult(session, id)).length;
  const completion = $("quiz-completion");
  completion.hidden = scored.length === 0 || takingChapterTest(session);
  completion.textContent = `已答 ${answered} / ${scored.length}`;
  return { answered, total: scored.length };
}

function renderQuestionActions(session, item, result, { answered, total }) {
  const submitButton = $("submit");
  const last = session.index === session.ids.length - 1;
  const memoryMode = session.mode === "memory";
  const fill = !requiresAnswer(item.id);
  submitButton.hidden = !fill && (result ? !last : checksOnTap(item));
  submitButton.textContent = fill && !last ? "下一题"
    : fill || result ? (answered === total ? "查看结果" : "去未答题")
    : memoryMode ? (item.study?.explanation ? "显示答案与解析" : "显示答案") : "提交";
  submitButton.disabled = !fill && !result && !memoryMode && session.selected.length === 0;
  submitButton.parentElement.hidden = submitButton.hidden;
}

function previewQuestionPosition(session, number) {
  const total = session.ids.length;
  const chapter = session.meetingPractice ? "会议专题" : byId.get(session.ids[number - 1])?.chapter;
  const label = `第 ${number} 题，共 ${total} 题`;
  const slider = $("question-position");
  slider.setAttribute("aria-valuetext", label);
  slider.style.setProperty("--question-position", `${total > 1 ? (number - 1) / (total - 1) * 100 : 100}%`);
  $("where").textContent = `${takingChapterTest(session) ? "测验 · " : ""}${chapter ?? ""} · ${number} / ${total}`;
}

function renderQuestion() {
  const item = current();
  if (item) $("quiz").dataset.questionId = item.id;
  if (!item) return;
  const session = state.session;
  const adventure = isAdventureSession(session);
  const bank = bankForSession(session);
  const result = questionResult(session, item.id);
  const memoryMode = session.mode === "memory";
  const testing = takingChapterTest(session);
  const fill = !requiresAnswer(item.id);
  const showAnswer = fill || Boolean(result);
  const showGrade = result && !fill && !memoryMode;
  const selected = result?.selected || session.selected;
  const total = session.ids.length;
  view("quiz");
  $("quiz").classList.toggle("adventure-round", adventure);
  if (session.meetingPractice) $("back").textContent = "返回时间线";
  const slider = $("question-position");
  slider.disabled = total < 2;
  slider.max = total;
  slider.value = session.index + 1;
  previewQuestionPosition(session, slider.valueAsNumber);
  nativeQuestionRevision++;
  syncNativeQuestionPosition();
  const progress = renderRoundProgress(session);
  const source = bank === "sizheng" || bank === "xuexitong" ? bankLabels[bank] : item.source || bankLabels.sizheng;
  $("kind").textContent = `${item.type}题 · ${source}`;
  renderCommonQuestionBadge($("common-question-badge"), item);
  $("option-hint").hidden = item.type !== "多选" || memoryMode || Boolean(result);
  $("option-hint").textContent = testing ? "可选多项" : "选齐后提交";
  $("question").textContent = item.stem;
  renderQuestionFlags(item.id);
  $("wrong-review").hidden = testing;
  $("star").disabled = testing;
  const buttons = [];
  const readOnly = Boolean(result) || memoryMode;
  for (const [letter, value] of Object.entries(item.options)) {
    const option = optionButton(letter, value);
    if (!readOnly) {
      option.setAttribute("aria-pressed", String(selected.includes(letter)));
      option.addEventListener("click", () => choose(letter));
    }
    if (!testing) optionNotes.attach(option, item, letter, Boolean(result), readOnly);
    else option.disabled = readOnly;
    option.classList.toggle("correct", Boolean(result && item.answer.includes(letter)));
    option.classList.toggle("incorrect", Boolean(result && selected.includes(letter) && !item.answer.includes(letter)));
    buttons.push(option);
  }
  const focusedOption = [...$("options").children].indexOf(document.activeElement);
  $("options").replaceChildren(...buttons);
  $("option-note-tools").hidden = optionNotes.available === false || testing || !buttons.length;
  if (focusedOption >= 0 && !result) buttons[focusedOption]?.focus();
  $("answer-summary").hidden = !showAnswer;
  $("answer-heading").textContent = fill ? "参考答案" : "正确答案";
  meetingTimeline?.link($("meeting-from-answer"), showAnswer ? item.id : undefined);
  $("feedback").textContent = showGrade ? (adventure
    ? result.correct ? "答对了！" : "差一点，再记住这个考点"
    : result.correct ? "回答正确" : "回答错误") : "";
  $("feedback").dataset.state = showGrade ? result.correct ? "correct" : "incorrect" : "";
  $("submitted-answer").hidden = !result || memoryMode;
  $("submitted-answer").textContent = !result || memoryMode ? "" : selected.length
    ? `我的作答\n${selected.map((answer) => historyOptionLabel(item, answer)).join("\n")}`
    : result.roundSelection?.length
      ? `最近的记录仅保存了判分。\n本轮保存的作答\n${result.roundSelection.map((answer) => historyOptionLabel(item, answer)).join("\n")}`
      : "这条早期记录未保存所选答案。";
  const answerLabels = item.blank_answers?.map((choices) => choices.join(" / ")) || item.answer;
  $("answer-text").textContent = showAnswer ? answerLabels.map((answer) => {
    const option = item.options[answer];
    return option && item.type !== "判断" ? `${answer}　${option}` : option || answer;
  }).join("\n") : "";
  renderDistractorNotes(result && !testing ? item : null, $("distractor-notes"), selected);
  const tapCheck = checksOnTap(item);
  renderQuestionActions(session, item, result, progress);
  $("chapter-test-status").hidden = !testing;
  if (testing) renderChapterTestActions(session);
  $("source").hidden = !showAnswer || !item.source_image;
  $("source").href = item.source_image || "#";
  const study = showAnswer && optionNotes.study(item);
  quizTutor.bind($("quiz-tutor-open"), testing ? null : tutorContext(item, {
    revealed: showAnswer, selected,
  }));
  const noteButton = $("quiz-note-open");
  noteButton.hidden = testing;
  noteButton.onclick = testing ? null : () => openQuestionNote(item.id);
  $("study-note").hidden = !study;
  if (study) {
    $("explanation").textContent = study.explanation;
    $("memory").textContent = study.memory;
    $("memory").parentElement.hidden = !study.memory;
    renderStudyEvidence(study);
  }
  renderRelated(showAnswer && bank !== "common" && !chapterForSession(session) ? item.related || [] : [], session);
  document.querySelector(".keys").textContent = fill ? "方向键翻题"
    : testing ? "方向键翻题，可回到前面修改答案"
    : memoryMode
    ? "Enter 查看答案，方向键翻题"
    : tapCheck ? "按 A–H 作答，方向键翻题" : "按 A–H 选择，Enter 提交，方向键翻题";
}

function focusAnswer(reveal = false) {
  const summary = $("answer-summary");
  const feedback = $("feedback");
  const target = feedback.textContent ? feedback : $("answer-text");
  target.focus({ preventScroll: true });
  summary.scrollIntoView({ block: "start", behavior: reducedMotion.matches ? "instant" : "smooth" });
  if (reveal) answerMotion = window.QuizWorldMotion?.answer(summary, feedback.dataset.state === "correct");
}

function resumeQuestion({ review = false } = {}) {
  inspectedChapter = null;
  expandChapterSession();
  const item = current();
  if (!item) return;
  if (review) {
    const first = state.session.ids.findIndex(hasAnswered);
    if (first >= 0 && first !== state.session.index) {
      goToQuestion(first);
      return;
    }
  }
  renderQuestion();
  window.scrollTo(0, 0);
  if (!review && questionResult(state.session, item.id)) focusAnswer();
  else $("question").focus();
  animatePage(0, 11);
}

function takingChapterTest(session = state.session) {
  return session?.mode === "chapter-test" && !session.testSubmitted;
}

function testSelections(session) {
  return { ...session.drafts, [session.ids[session.index]]: session.selected };
}

function renderChapterTestActions(session) {
  const answers = testSelections(session);
  const scored = session.ids.filter(requiresAnswer);
  const count = scored.filter((id) => answers[id]?.length).length;
  const ready = count === scored.length;
  const last = session.index === session.ids.length - 1;
  const reading = !requiresAnswer(current().id) && !last;
  $("chapter-test-status").textContent = scored.length ? `已答 ${count} / ${scored.length} 道 · 交卷后查看答案` : "";
  $("submit").hidden = !reading && !ready && !last;
  $("submit").disabled = false;
  $("submit").textContent = reading ? "下一题" : !scored.length ? "查看结果" : ready ? "交卷" : "去未答题";
  $("submit").parentElement.hidden = $("submit").hidden;
}

function recordAnswer(session, item, selected, timestamp) {
  const correct = selected.length > 0 &&
    item.answer.length === selected.length && item.answer.every((letter) => selected.includes(letter));
  session.results[item.id] = { selected, correct };
  const id = sharedQuestionId(item.id);
  const entry = { wrong: !correct, last: timestamp, selected: [...translateSelection(selected, item.id, id)] };
  const redo = state.history[id]?.redo;
  if (redo) entry.redo = redo;
  state.history[id] = entry;
  const attempt = {
    event_id: randomId(), question_id: item.id, selected: [...selected].sort(), occurred_at: timestamp,
    mode: session.mode === "chapter-test" ? "chapter-test" : session.routePlan?.kind === "review" ? "review" : "practice",
    catalog_version: window.QuizCatalog?.version || "legacy-inline",
  };
  return ["history", id, entry, attempt];
}

function submitChapterTest(session) {
  if (accountSwitching) return;
  const answers = testSelections(session);
  const pending = session.ids.findIndex((id) => requiresAnswer(id) && !answers[id]?.length);
  if (pending >= 0) {
    if (session.index !== pending) goToQuestion(pending);
    else $("options").firstElementChild?.focus();
    return;
  }
  const timestamp = Date.now();
  const scored = session.ids.filter(requiresAnswer);
  const changes = [];
  for (const id of scored) {
    const change = recordAnswer(session, byId.get(id), answers[id], timestamp);
    // Shared history keeps one latest projection, but each displayed question
    // still contributes its own immutable answer event.
    changes.push(change);
  }
  if (scored.length) {
    const correct = scored.filter((id) => session.results[id].correct).length;
    const bank = bankForSession(session);
    const chapter = chapterForSession(session);
    const result = { sessionId: session.sid, bank, chapter, correct, total: scored.length, completedAt: timestamp };
    (state.chapterTests ??= {})[bank + ":" + chapter] = result;
    session.chapterStudy = { tests: state.chapterTests };
    changes.push(["test", session.sid, result]);
  }
  session.testSubmitted = true;
  delete session.drafts;
  completeRound(changes);
}

function submit() {
  if (accountSwitching) return;
  const item = current();
  const session = state.session;
  if (!item) return;
  if (takingChapterTest(session)) {
    submitChapterTest(session);
    return;
  }
  if (!requiresAnswer(item.id) || questionResult(session, item.id)) return;
  if (session.mode === "memory") {
    session.results[item.id] = { selected: [] };
    saveSession();
    renderQuestion();
    focusAnswer(true);
    return;
  }
  if (!session.selected.length) return;
  const change = recordAnswer(session, item, session.selected, Date.now());
  const { correct } = session.results[item.id];
  const previousStreak = Number.isSafeInteger(session.correctStreak) ? session.correctStreak : 0;
  session.correctStreak = correct ? previousStreak + 1 : 0;
  saveSession([change]);
  let outcome = correct ? "correct" : "incorrect";
  if (session.correctStreak >= 2) outcome = "streak";
  playAnswerHaptic(outcome);
  renderQuestion();
  showAnswerStreak(session.correctStreak);
  const delay = Number($("auto-advance-delay").value);
  if (correct && delay > 0) {
    answerMotion = window.QuizWorldMotion?.answer($("answer-summary"), true);
    scheduleAutoAdvance(session, delay);
  } else {
    focusAnswer(true);
  }
}

function questionDestination(session, direction, skipShared = false) {
  let adjacent = session.index + direction;
  while (skipShared && sharedQuestions.has(session.ids[adjacent]) && questionResult(session, session.ids[adjacent])) {
    adjacent += direction;
  }
  if (byId.has(session.ids[adjacent])) return adjacent;
  const id = session.ids[session.index];
  if (direction < 0 || takingChapterTest(session) || (requiresAnswer(id) && !questionResult(session, id))) return null;
  const pending = session.ids.findIndex((key) => requiresAnswer(key) && !questionResult(session, key));
  return pending < 0 ? session.ids.length : pending;
}

function moveQuestion(direction, swipe = false, skipShared = false) {
  if (accountSwitching) return;
  if (!current()) return;
  const session = state.session;
  const destination = questionDestination(session, direction, skipShared);
  if (destination === null) return;
  if (destination === session.ids.length) completeRound();
  else goToQuestion(destination, { swipe, direction });
}

function cancelAutoAdvance() {
  window.clearTimeout(autoAdvanceTimer);
  autoAdvanceTimer = undefined;
}

function scheduleAutoAdvance(session, delay) {
  const index = session.index;
  autoAdvanceTimer = window.setTimeout(() => {
    autoAdvanceTimer = undefined;
    if (state.session !== session || session.index !== index || document.hidden || $("quiz").hidden ||
        document.querySelector("dialog[open]")) return;
    moveQuestion(1, false, true);
  }, delay);
}

function completeRound(changes = []) {
  const session = state.session;
  session.index = session.ids.length;
  session.selected = [];
  saveSession(changes);
  const memoryMode = session.mode === "memory";
  const testMode = session.mode === "chapter-test";
  const round = testMode ? session.ids.filter((id) => session.results[id]) : session.ids.filter(requiresAnswer);
  const wrong = round.filter((id) => !questionResult(session, id)?.correct);
  const bank = bankForSession(session);
  const chapter = chapterForSession(session);
  const reviewing = session.routePlan?.kind === "review";
  const adventure = isAdventureSession(session);
  const route = chapter ? chapterStudy(chapter, bank) : null;
  $("result-title").textContent = !round.length ? "填空题查看完成" : testMode ? wrong.length ? "整章测验完成" : "整章测验通过"
    : reviewing ? "本轮错题复练完成" : route && !route.remaining.length ? "本章练习完成"
    : memoryMode ? "本次背诵完成" : "本次练习完成";
  $("score").textContent = !round.length ? `本轮有 ${session.ids.length} 道填空题。` : memoryMode ? `已复习 ${session.ids.length} 道。` : usesChapterHistory(session)
    ? `本章已答 ${round.length} 道 · 答对 ${round.length - wrong.length} 道`
    : `答对 ${round.length - wrong.length} 道，共 ${round.length} 道。`;
  const retry = $("retry");
  const retryCount = route ? route.wrong.length : wrong.length;
  retry.hidden = memoryMode || !round.length || Boolean(route && !retryCount);
  retry.disabled = !retryCount;
  retry.textContent = route ? `复练 ${retryCount} 道错题` : "重练本次错题";
  retry.onclick = route ? () => startWrongChapter(chapter, bank)
    : () => start(wrong, "practice", { bankScope: bank, meetingPractice: session.meetingPractice });
  const review = $("result-chapter-review");
  review.hidden = !route;
  review.textContent = retryCount ? "查看本章错题" : "查看本章进度";
  review.onclick = () => openChapterReview(chapter, bank);
  const test = $("result-chapter-test");
  test.hidden = !route?.total || retryCount > 0 || route.remaining.length > 0 || testMode;
  test.onclick = () => startChapterTest(chapter, bank);
  const advance = $("route-result-next");
  advance.hidden = !route?.remaining.length;
  advance.textContent = "练剩余题";
  advance.onclick = () => openChapter(chapter, { bank });
  const step = $("chapter-result-next-step");
  step.hidden = !route?.total || (testMode && !retryCount);
  step.textContent = !route ? "" : route.remaining.length ? `全章还有 ${route.remaining.length} 道未练。`
    : retryCount ? "这轮仍答错的题可以接着复练。" : "可以开始整章测验，交卷后查看答案和解析。";
  const primary = [retry, test, advance].find((button) => !button.hidden && !button.disabled) || $("again");
  for (const button of [retry, test, advance, $("again")]) button.classList.toggle("primary", button === primary);
  $("adventure-result").hidden = !adventure || !route;
  if (adventure && route) {
    $("adventure-result-stops").textContent = `${route.chapter} · ${route.answered} / ${route.total} 道已答`;
    $("adventure-result-streak").textContent = `最高连中 ${longestStreak(round, session)} 题`;
  }
  $("review-round").textContent = testMode ? "回看试卷" : isChapterPractice(session) ? "回看本章" : "回看本次";
  const library = libraryTabs[profileLibrary || selectedTab];
  $("again").textContent = session.meetingPractice ? "返回时间线" : library ? `返回${library.title}` : "返回路线";
  $("again").onclick = returnFromQuestion;
  view("result");
  window.scrollTo(0, 0);
  primary.focus();
  animatePage(0, 11);
}

$("setup-form").addEventListener("change", updateAvailability);
$("setup-form").addEventListener("submit", (event) => {
  event.preventDefault();
  let pool = matches();
  if ($("order").value === "random") pool = shuffled(pool);
  const ids = pool.slice(0, $("count").valueAsNumber).map((item) => item.id);
  const mode = $("mode").value;
  const reuseSharedHistory = mode === "practice" && ["all", "new"].includes($("scope").value);
  if (ids.length) start(ids, mode, { bankScope: selectedBank, reuseSharedHistory });
});
$("resume").onclick = resumeQuestion;
$("adventure-chapter-long").onclick = () => openChapter($("chapter").value, { whole: true });
$("adventure-together").onclick = () => showTab("desk", true);
$("route-all-chapters").onclick = () => {
  $("setup-heading").focus({ preventScroll: true });
  $("setup-heading").scrollIntoView({ block: "start", behavior: reducedMotion.matches ? "instant" : "smooth" });
};
$("submit").onclick = () => {
  const session = state.session;
  const id = current()?.id;
  if (takingChapterTest(session)) {
    if (!requiresAnswer(id) && session.index < session.ids.length - 1) moveQuestion(1);
    else submit();
  } else if (!requiresAnswer(id) || questionResult(session, id)) moveQuestion(1);
  else submit();
};
$("review-round").onclick = () => goToQuestion(state.session.ids.length - 1);
$("back").onclick = returnFromQuestion;
$("history-question-close").onclick = () => $("history-question").close();
$("history-question-redo").onclick = () => {
  const item = byId.get($("history-question").dataset.questionId);
  if (item && (hasAnswered(item.id) || inWrongLibrary(item.id))) redoQuestion(item, true);
};
$("library-back").onclick = () => {
  if (wrongChapter) {
    wrongChapter = null;
    resetLibrary();
    updateAvailability();
    $("library-title").focus({ preventScroll: true });
    return;
  }
  const scope = profileLibrary;
  showTab("profile", true);
  document.querySelector(`[data-profile-library="${scope}"]`)?.focus();
};
$("wrong-bank").onchange = (event) => {
  wrongBank = event.target.value;
  renderLibrary();
};
for (const button of document.querySelectorAll("[data-profile-library]")) {
  button.onclick = () => openProfileLibrary(button.dataset.profileLibrary);
}
$("star").onclick = () => {
  const item = current();
  const starred = !isStarred(item.id);
  const ids = starred ? [sharedQuestionId(item.id)] : (sharedQuestions.get(item.id) || [item.id])
    .filter((id) => state.stars[id] === true);
  for (const id of ids) state.stars[id] = starred;
  save(ids.map((id) => ["star", id, starred]));
  renderQuestion();
};
$("wrong-review").onclick = () => {
  const item = current();
  if (!item) return;
  setWrongReview(item.id, !inWrongLibrary(item.id));
  renderQuestionFlags(item.id);
};
$("question-redo").onclick = () => {
  const item = current();
  if (item && canRedoCurrentQuestion(item.id)) redoQuestion(item);
};
$("option-notes-open").onclick = (event) => {
  const item = current();
  if (!item || takingChapterTest()) return;
  const result = questionResult(state.session, item.id);
  const selected = result?.selected || state.session.selected;
  const wrong = result && selected.find((letter) => Object.hasOwn(item.options, letter) && !item.answer.includes(letter));
  const first = wrong || selected.find((letter) => Object.hasOwn(item.options, letter)) || Object.keys(item.options)[0];
  if (first) optionNotes.open(item, first, Boolean(result), event.currentTarget);
};
document.addEventListener("keydown", (event) => {
  cancelAutoAdvance();
  if (accountSwitching || event.target === $("question-position") || $("quiz").hidden || document.querySelector("dialog[open]") ||
      event.ctrlKey || event.metaKey || event.altKey ||
      event.repeat || event.isComposing) return;
  const key = event.key.toUpperCase();
  const editing = document.activeElement.matches("input, textarea, select, [contenteditable]");
  if (!editing && (key === "ARROWLEFT" || key === "ARROWRIGHT")) {
    event.preventDefault();
    moveQuestion(key === "ARROWLEFT" ? -1 : 1);
  } else if (!editing && /^[A-H]$/.test(key)) {
    event.preventDefault();
    choose(key);
  } else if (key === "ENTER" && document.activeElement.dataset.optionNoteAction !== "open" &&
                                   (document.activeElement.classList.contains("option") ||
                                   !["BUTTON", "A"].includes(document.activeElement.tagName))) {
    event.preventDefault();
    const id = current()?.id;
    if (takingChapterTest() || !requiresAnswer(id) || questionResult(state.session, id)) moveQuestion(1);
    else submit();
  }
});

document.addEventListener("pointerdown", cancelAutoAdvance, { capture: true });
document.addEventListener("wheel", cancelAutoAdvance, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) return;
  cancelAutoAdvance();
  clearAnswerStreak();
});

function canSwipeQuestion() {
  // Leave one-finger pans to the browser while a reader magnifies the page.
  return (window.visualViewport?.scale ?? 1) <= 1 && !accountSwitching &&
    !$("quiz").hidden && current() && !document.querySelector("dialog[open]");
}

function syncNativeQuestionPosition() {
  if (!nativeNavigation || nativeQuestionFrame) return;
  nativeQuestionFrame = requestAnimationFrame(async () => {
    nativeQuestionFrame = 0;
    const slider = $("question-position");
    const revision = nativeQuestionRevision;
    const show = canSwipeQuestion() && !slider.disabled && (window.visualViewport?.scale ?? 1) === 1;
    const bounds = slider.getBoundingClientRect();
    const layout = show ? {
      x: bounds.left + window.scrollX, y: bounds.top + window.scrollY,
      width: bounds.width, height: bounds.height,
      number: state.session.index + 1, total: state.session.ids.length,
    } : {};
    const active = await nativeNavigation.postMessage({ kind: "question-position", revision, ...layout }).catch(() => false);
    if (revision === nativeQuestionRevision) slider.toggleAttribute("data-native-question-position", active === true);
  });
}

const questionPositionSlider = $("question-position");
questionPositionSlider.addEventListener("input", () => {
  if (canSwipeQuestion()) previewQuestionPosition(state.session, questionPositionSlider.valueAsNumber);
});
questionPositionSlider.addEventListener("change", () => {
  if (canSwipeQuestion()) goToQuestion(questionPositionSlider.valueAsNumber - 1, { focusQuestion: false });
});
questionPositionSlider.addEventListener("pointercancel", () => {
  if (!canSwipeQuestion()) return;
  questionPositionSlider.value = state.session.index + 1;
  previewQuestionPosition(state.session, questionPositionSlider.valueAsNumber);
});

function connectQuestionSwipe() {
  const horizontalRatio = 1.12;
  let gesture = null;

  function clearGesture() {
    const start = gesture;
    gesture = null;
    lessonCard.style.removeProperty("translate");
    return start;
  }

  function syncZoomGestures() {
    const magnified = (window.visualViewport?.scale ?? 1) > 1;
    // The normal swipe surface permits only vertical browser panning.
    document.documentElement.style.touchAction = magnified ? "manipulation" : "";
    if (magnified && gesture) clearGesture();
  }
  window.visualViewport?.addEventListener("resize", syncZoomGestures);
  syncZoomGestures();

  function settle(offset) {
    if (reducedMotion.matches || !offset || !lessonCard.animate) return;
    pageMotion?.cancel();
    pageMotion = lessonCard.animate([
      { translate: `${offset}px 0` },
      { translate: "0 0" },
    ], { duration: 150, easing: "cubic-bezier(.20,.72,.22,1)" });
  }

  document.addEventListener("touchstart", (event) => {
    if (gesture) clearGesture();
    if (!canSwipeQuestion() || event.touches.length !== 1 ||
        event.target.closest?.("input, textarea, select, [contenteditable]") ||
        window.getSelection()?.toString()) return;
    const touch = event.touches[0];
    const session = state.session;
    gesture = {
      id: touch.identifier, x: touch.clientX, y: touch.clientY, time: event.timeStamp,
      session, index: session.index, offset: 0,
    };
  }, { passive: true });

  document.addEventListener("touchmove", (event) => {
    if (!gesture) return;
    const touch = event.touches[0];
    if (!canSwipeQuestion() || event.touches.length !== 1 || touch.identifier !== gesture.id || !event.cancelable) {
      clearGesture();
      return;
    }
    const dx = touch.clientX - gesture.x;
    const dy = Math.abs(touch.clientY - gesture.y);
    const horizontal = Math.abs(dx);
    if (!gesture.horizontal) {
      if (dy >= 7 && dy >= horizontal) {
        clearGesture();
        return;
      }
      if (horizontal < 6 || horizontal < dy * horizontalRatio) return;
      gesture.horizontal = true;
      pageMotion?.cancel();
    }
    event.preventDefault();
    if (reducedMotion.matches) return;
    const available = questionDestination(gesture.session, -Math.sign(dx)) !== null;
    gesture.offset = Math.sign(dx) * Math.min(available ? 48 : 14, horizontal * (available ? .62 : .22));
    lessonCard.style.translate = `${gesture.offset}px 0`;
  }, { passive: false, capture: true });

  document.addEventListener("touchend", (event) => {
    if (!gesture) return;
    const start = clearGesture();
    if (!canSwipeQuestion() || state.session !== start.session ||
        state.session.index !== start.index) return;
    const touch = [...event.changedTouches].find((point) => point.identifier === start.id);
    if (!touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const distance = Math.abs(dx);
    const quickFlick = event.timeStamp - start.time <= 140;
    const swipe = distance >= (quickFlick ? 10 : 16) && distance >= Math.abs(dy) * horizontalRatio;
    // A horizontal drag over a button should never activate that button.
    if ((start.horizontal || swipe) && event.cancelable) event.preventDefault();
    const direction = -Math.sign(dx);
    if (swipe && questionDestination(start.session, direction) !== null) {
      moveQuestion(direction, true);
    } else {
      settle(start.offset, false);
    }
  }, { passive: false, capture: true });

  document.addEventListener("touchcancel", () => {
    if (gesture) settle(clearGesture().offset, false);
  }, { passive: true });
}

connectQuestionSwipe();

function connectTabLens() {
  const lastTab = tabButtons.length - 1;
  const optics = window.QuizGlassOptics?.attach(tabDock.querySelector(".tab-lens-optics"));
  let position = 0;
  let target = 0;
  let speed = 0;
  let pressure = 0;
  let pressureSpeed = 0;
  let flow = 0;
  let frame = 0;
  let previousTime = 0;
  let gesture = null;
  let skipClick = false;
  let preview = null;

  const limit = (value, min, max) => Math.min(max, Math.max(min, value));
  const selection = () => tabButtons.findIndex((button) => button.dataset.studyTab === selectedTab);

  function dragPosition(x, current) {
    const raw = (x - current.origin) / current.pitch;
    const edge = limit(raw, 0, lastTab);
    return edge + limit((raw - edge) * .16, -.10, .10);
  }

  function setPreview(index) {
    const button = tabButtons[index];
    if (preview === button) return;
    preview?.removeAttribute("data-tab-preview");
    preview = button;
    preview?.setAttribute("data-tab-preview", "");
  }

  function paint(value, stretch = 1, drift = 0) {
    position = value;
    const expansion = limit(pressure, 0, 1.12);
    const edgeTravel = Math.max(0, -value, value - lastTab);
    // Reserve room for the expanded lens during elastic travel at either end.
    const width = Math.min(stretch + expansion * .20, 1.36 - edgeTravel * 2);
    tabDock.style.setProperty("--tab-position", value.toFixed(4));
    tabDock.style.setProperty("--tab-stretch", width.toFixed(3));
    tabDock.style.setProperty("--tab-squash", (1 + expansion * .35 - (stretch - 1) * .47).toFixed(3));
    tabDock.style.setProperty("--tab-lift", `${(-expansion * 2).toFixed(2)}px`);
    flow += (limit(drift / 5.8, -1, 1) - flow) * .34;
    if (Math.abs(flow) < .006) flow = 0;
    optics?.draw(flow, Math.min(1, Math.abs(flow) + expansion * .42));
  }

  function stopFrame() {
    cancelAnimationFrame(frame);
    frame = 0;
  }

  function frameStep(time) {
    const step = limit((time - previousTime) / 1000, 0, 1 / 30);
    previousTime = time;
    return step;
  }

  function updatePressure(step) {
    const goal = gesture ? (gesture.dragging ? .78 : 1) : 0;
    const damping = gesture ? 29 : 36;
    pressureSpeed += ((goal - pressure) * 525 - pressureSpeed * damping) * step;
    pressure += pressureSpeed * step;
    if (Math.abs(goal - pressure) >= .003 || Math.abs(pressureSpeed) >= .045) return true;
    pressure = goal;
    pressureSpeed = 0;
    return false;
  }

  function startFrame(callback) {
    if (frame) return;
    previousTime = performance.now();
    frame = requestAnimationFrame(callback);
  }

  function tick(time) {
    frame = 0;
    const step = frameStep(time);
    const resizing = updatePressure(step);
    speed += ((target - position) * 510 - speed * 35) * step;
    const next = position + speed * step;
    if (Math.abs(target - next) < .001 && Math.abs(speed) < .05) {
      speed = 0;
      paint(target);
      if (flow || resizing) frame = requestAnimationFrame(tick);
      return;
    }
    paint(next, 1 + Math.min(.17, Math.abs(speed) * .021), speed);
    frame = requestAnimationFrame(tick);
  }

  function tickDrag(time) {
    frame = 0;
    if (!gesture?.dragging || reducedMotion.matches) return;
    const resizing = updatePressure(frameStep(time));
    const drift = gesture.speed * Math.exp(-Math.max(0, time - gesture.time - 24) / 77);
    paint(gesture.position, 1 + Math.min(.14, Math.abs(drift) * .017), drift);
    if (Math.abs(drift) > .04 || flow || resizing) frame = requestAnimationFrame(tickDrag);
  }

  function move(index, animate) {
    target = index;
    if (!animate || reducedMotion.matches) {
      stopFrame();
      speed = 0;
      pressure = 0;
      pressureSpeed = 0;
      flow = 0;
      paint(index);
    } else startFrame(tick);
  }

  function finish(event, commit) {
    if (!gesture || (event && event.pointerId !== gesture.id)) return;
    const current = gesture;
    gesture = null;
    tabDock.removeAttribute("data-glass-pressed");
    tabDock.removeAttribute("data-glass-dragging");
    setPreview(-1);
    const released = current.dragging && commit ? dragPosition(event.clientX, current) : current.position;
    if (current.dragging) {
      stopFrame();
      speed = event && event.timeStamp - current.time < 80 ? current.speed : 0;
      if (!reducedMotion.matches) paint(released, 1 + Math.min(.14, Math.abs(speed) * .017), speed);
    }
    skipClick = true;
    const selected = selection();
    if (commit && current.dragging) {
      const index = limit(Math.round(released), 0, lastTab);
      if (index !== selected) {
        showTab(tabButtons[index].dataset.studyTab, true);
        return;
      }
    } else if (commit) {
      const button = tabButtons[current.index];
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      if (button.contains(hit)) {
        showTab(button.dataset.studyTab, true);
        return;
      }
    }
    move(selected, true);
  }

  tabDock.addEventListener("pointerdown", (event) => {
    const index = tabButtons.indexOf(event.target.closest("[data-study-tab]"));
    if (!event.isPrimary || event.button !== 0 || gesture || index < 0) return;
    // In a quiz, the touch swipe turns the question while a tap still selects the tab.
    if (event.pointerType === "touch" && !$("quiz").hidden) {
      skipClick = false;
      return;
    }
    const first = tabButtons[0].getBoundingClientRect();
    const second = tabButtons[1].getBoundingClientRect();
    gesture = {
      id: event.pointerId, index, x: event.clientX, y: event.clientY,
      origin: first.left + first.width / 2, pitch: second.left - first.left,
      position, speed: 0, time: event.timeStamp, dragging: false,
    };
    skipClick = false;
    tabDock.setAttribute("data-glass-pointer", "");
    tabDock.setAttribute("data-glass-pressed", "");
    setPreview(index);
    if (!reducedMotion.matches) {
      pressureSpeed = Math.max(pressureSpeed, 6);
      move(index, true);
    }
  });

  tabDock.addEventListener("pointermove", (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (!gesture.dragging) {
      const dx = Math.abs(event.clientX - gesture.x);
      const dy = Math.abs(event.clientY - gesture.y);
      if (dy > 8 && dy > dx) return finish(event, false);
      if (dx < 6 || dx <= dy) return;
      stopFrame();
      gesture.dragging = true;
      tabDock.setAttribute("data-glass-dragging", "");
      tabDock.setPointerCapture(event.pointerId);
    }
    const next = dragPosition(event.clientX, gesture);
    const elapsed = Math.max(event.timeStamp - gesture.time, 8);
    gesture.speed = limit((next - gesture.position) * 1000 / elapsed, -8, 8);
    gesture.position = next;
    gesture.time = event.timeStamp;
    setPreview(limit(Math.round(next), 0, lastTab));
    if (!reducedMotion.matches) startFrame(tickDrag);
  });

  tabDock.addEventListener("contextmenu", (event) => {
    if (gesture) event.preventDefault();
  });
  window.addEventListener("pointerup", (event) => finish(event, true));
  window.addEventListener("pointercancel", (event) => finish(event, false));
  window.addEventListener("blur", () => finish(null, false));
  window.addEventListener("keydown", () => tabDock.removeAttribute("data-glass-pointer"));
  tabDock.addEventListener("lostpointercapture", (event) => {
    if (event.target === tabDock) finish(event, false);
  });
  reducedMotion.addEventListener("change", () => {
    if (!reducedMotion.matches) return;
    move(selection(), false);
  });

  for (const button of tabButtons) {
    button.onclick = (event) => {
      if (!skipClick || event.detail === 0) showTab(button.dataset.studyTab, true);
      skipClick = false;
    };
  }
  return move;
}

const moveTabLens = nativeNavigation ? () => {} : connectTabLens();
if (nativeNavigation) {
  document.documentElement.setAttribute("data-native-tabs", "");
  window.QuizNativeUI = {
    selectTab(tab, animate = true) {
      if (accountSwitching || document.getElementById("development-picker")?.open) return;
      if (tabButtons.some((button) => button.dataset.studyTab === tab)) showTab(tab, animate, true);
    },
    swipeQuestion(direction) {
      if ((direction !== 1 && direction !== -1) || !canSwipeQuestion() || window.getSelection()?.toString()) return;
      cancelAutoAdvance();
      moveQuestion(direction, true);
    },
    setQuestionPosition(number, action, revision) {
      if (!canSwipeQuestion() || revision !== nativeQuestionRevision ||
          !Number.isInteger(number) || number < 1 || number > state.session.ids.length) return;
      cancelAutoAdvance();
      questionPositionSlider.value = number;
      previewQuestionPosition(state.session, number);
      if (action === "commit") goToQuestion(number - 1, { focusQuestion: false });
    },
  };
  const positionLayout = new ResizeObserver(syncNativeQuestionPosition);
  positionLayout.observe(document.querySelector(".lesson-header"));
  const dialogVisibility = new MutationObserver(syncNativeQuestionPosition);
  for (const dialog of document.querySelectorAll("dialog")) dialogVisibility.observe(dialog, {
    attributes: true, attributeFilter: ["open"],
  });
  window.visualViewport?.addEventListener("resize", syncNativeQuestionPosition);
}
$("library-configure").onclick = () => {
  const scope = profileLibrary || selectedTab;
  showTab("practice", true);
  filterScope(scope);
};
$("library-more").onclick = () => {
  const firstNewIndex = libraryLimit;
  libraryLimit += libraryPageSize;
  renderLibrary();
  const firstNew = $("library-list").children[firstNewIndex];
  (firstNew?.querySelector(".library-item") || firstNew)?.focus();
};
$("library-undo").onclick = () => {
  if (!wrongUndo) return;
  const { id, previous } = wrongUndo;
  wrongUndo = null;
  setWrongReview(id, previous);
  updateAvailability();
  const restored = [...$("library-list").children].find((row) => row.dataset.questionId === id);
  (restored?.querySelector(".library-item") || $("library-start")).focus({ preventScroll: true });
};
$("profile-account").onclick = () => $("account-button").click();

function connectLibrarySwipe() {
  const list = $("library-list");
  let gesture = null;
  let suppressClick = false;

  function finish(event, commit = false) {
    if (!gesture || (event && event.pointerId !== gesture.id)) return;
    const { row, surface, distance, offset, dragging, wasOpen } = gesture;
    gesture = null;
    if (!dragging) return;
    suppressClick = true;
    if (row.isConnected) {
      const open = commit ? offset <= -distance / 2 : wasOpen;
      setOpenLibraryRow(open ? row : null);
    }
    row.classList.remove("is-dragging");
    surface.style.removeProperty("--library-offset");
  }

  document.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary) finish();
    if (openLibraryRow && !list.contains(event.target)) setOpenLibraryRow(null);
  });
  list.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick = false;
    const surface = event.target.closest(".library-row-surface");
    if (!surface || event.target.closest(".library-menu")) return;
    const row = surface.parentElement;
    const distance = row.querySelector(".library-remove").offsetWidth;
    const wasOpen = row === openLibraryRow;
    gesture = { id: event.pointerId, row, surface, distance, wasOpen,
      x: event.clientX, y: event.clientY, offset: wasOpen ? -distance : 0, dragging: false };
  });
  list.addEventListener("pointermove", (event) => {
    if (gesture?.id !== event.pointerId) return;
    const { row, surface, distance, x, y, wasOpen } = gesture;
    const dx = event.clientX - x;
    const dy = event.clientY - y;
    if (!gesture.dragging) {
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) return finish(event);
      if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
      if (!wasOpen && dx > 0) return;
      gesture.dragging = true;
      if (!wasOpen) setOpenLibraryRow(null);
      row.classList.add("is-dragging");
      list.setPointerCapture(event.pointerId);
    }
    gesture.offset = Math.max(-distance, Math.min(0, (wasOpen ? -distance : 0) + dx));
    surface.style.setProperty("--library-offset", `${gesture.offset}px`);
  });
  window.addEventListener("pointerup", (event) => finish(event, true));
  window.addEventListener("pointercancel", (event) => finish(event));
  window.addEventListener("blur", () => finish());
  list.addEventListener("lostpointercapture", (event) => {
    if (event.target === list) finish(event);
  });
  list.addEventListener("click", (event) => {
    if (suppressClick && event.detail > 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    suppressClick = false;
  }, true);
  list.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpenLibraryRow(null);
  });
}

function restoreGuestState() {
  deferredResume = null;
  const revision = accountScopeRevision;
  return guestWrites.catch(() => {}).then(() => guestStore?.read()).then((cache) => {
    if (activeAccountId || accountScopeRevision !== revision) return;
    state = cache ? persistence.stateFromCache(cache) : guestState();
    applyQuestionRedos(state.session);
    inspectedChapter = null;
    wrongChapter = null;
    wrongBank = selectedBank;
    resetLibrary();
    showTab(selectedTab);
    setAccountSwitching(false);
  }).catch(() => {
    if (activeAccountId || accountScopeRevision !== revision) return;
    // Keep account data out of the guest UI even when its storage cannot be
    // opened. Existing guest records remain in their store for a later retry.
    state = { history: {}, stars: {}, notes: {}, session: null, drafts: {}, chapterTests: {} };
    resetLibrary();
    showTab(selectedTab);
    setAccountSwitching(false);
    $("storage-status").textContent = "访客记录未能读取，请刷新重试。";
  });
}

function receiveStudyState(remote, reset) {
    const active = !reset && (!$("quiz").hidden || !$("result").hidden) ? state.session : null;
    const item = active && !$("quiz").hidden ? current() : null;
    const previous = item && questionResult(active, item.id);
    const previousSelection = item && active.selected;
    const session = Array.isArray(remote.session?.ids) && remote.session.ids.every((id) => byId.has(id))
      ? structuredClone(remote.session) : null;
    // Keep the open question in place, and use the synced resume once the user leaves it.
    if (reset) deferredResume = null;
    else if (active && session) deferredResume = session;
    const chapterTests = reset ? remote.chapterTests || {} : persistence?.mergeChapterTests
      ? persistence.mergeChapterTests(state.chapterTests, remote.chapterTests) : { ...state.chapterTests, ...remote.chapterTests };
    state = { ...remote, notes: remote.notes || {}, drafts: remote.drafts || {}, chapterTests, session: active || session };
    applyQuestionRedos(state.session);
    applyQuestionRedos(deferredResume);
    if (reset) {
      inspectedChapter = null;
      wrongChapter = null;
      wrongBank = selectedBank;
      resetLibrary();
      showTab(selectedTab);
      setAccountSwitching(false);
    } else {
      updateAvailability();
      if (item) {
        const result = questionResult(active, item.id);
        if (previousSelection !== active.selected || previous?.correct !== result?.correct ||
            JSON.stringify(previous?.selected) !== JSON.stringify(result?.selected) ||
            JSON.stringify(previous?.roundSelection) !== JSON.stringify(result?.roundSelection)) {
          renderQuestion();
        } else if (usesChapterHistory(active) || sharedQuestions.has(item.id)) {
          const progress = renderRoundProgress(active);
          if (takingChapterTest(active)) renderChapterTestActions(active);
          else renderQuestionActions(active, item, result, progress);
        }
      }
    }
}

connectLibrarySwipe();
async function initializeStudy() {
  try {
    if (persistence?.createStore) {
      guestStore = await persistence.createStore({ scope: "guest", guest: true, legacyKey: storageKey, randomId });
      state = persistence.stateFromCache(await guestStore.read());
      if (!guestStore.durable) $("storage-status").textContent = "本机保存不可用，请保持页面打开。";
    } else $("storage-status").textContent = "存储组件未能加载，本次记录暂留在当前页面。";
  } catch {
    $("storage-status").textContent = "本机记录未能打开，本次记录暂留在当前页面。";
  }
  setup();
const leaderboard = optionalFeature("leaderboard", () => window.QuizLeaderboard?.connect({
  signedIn: () => Boolean(sync?.enabled()),
  rpc: (name, params) => sync.deskRpc(name, params),
  login: () => $("account-button").click(),
}), null);
meetingTimeline = optionalFeature("meeting timeline", () => window.QuizMeetingTimeline?.connect({
  questions: byId,
  priority: commonQuestionPriority,
  practiceQuestions(ids) {
    showTab("practice");
    start(shuffled(ids), "practice", { meetingPractice: true });
  },
}), null);
desk = optionalFeature("study desk", () => window.QuizDesk?.connect({
  byId,
  chapters: [...chapterPools].filter(([, pool]) => pool.filter((item) => item.type !== "填空").length >= 10).map(([chapter]) => chapter),
  rpc: (name, params) => sync.deskRpc(name, params),
  subscribeArena: (pairId, listener) => sync?.arenaSubscribe(pairId, listener),
  avatar: (action, input) => sync.deskAvatar(action, input),
  login: () => $("account-button").click(),
  openOwnHistory: () => {
    showTab("profile", true);
    openProfileLibrary("done");
  },
}), null);
showTab("practice");
sync = optionalFeature("account", () => window.QuizAccount?.connect({
  randomId,
  accountChanged(account) {
    accountScopeRevision++;
    activeAccountId = account;
    setAccountSwitching(true);
    editingNote = null;
    questionNoteText.value = "";
    if (questionNoteDialog.open) questionNoteDialog.close();
    leaderboard?.accountChanged();
    desk?.accountChanged(account);
    quizTutor.accountChanged(account);
    developmentRequests.accountChanged(account);
  },
  receive: receiveStudyState,
  guest: restoreGuestState,
}), null);
desk?.setLoginAvailable(Boolean(sync));
$("profile-account").hidden = $("account-button").hidden;
  guestStore?.subscribe(async () => {
    try {
      await guestWrites;
      const cache = await guestStore.read();
      if (!activeAccountId && !accountSwitching) receiveStudyState(persistence.stateFromCache(cache), false);
    } catch { $("storage-status").textContent = "本机记录读取失败，请保持页面打开并重试。"; }
  });
  pageContent.inert = accountSwitching;
  tabDock.inert = accountSwitching;
  document.documentElement.dataset.studyReady = "true";
  window.dispatchEvent(new Event("quiz-study-ready"));
}
initializeStudy().catch((error) => {
  pageContent.inert = accountSwitching;
  tabDock.inert = accountSwitching;
  $("storage-status").textContent = "学习页面初始化失败，请刷新重试。";
  console.error("study initialization failed", error);
});
