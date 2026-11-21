"""Add a visible pass/fail result after exercising the quiz in a simulator build."""

from pathlib import Path
import sys


SCRIPT = r"""
<script>
window.addEventListener("load", async () => {
  const field = (id) => document.getElementById(id);
  const text = (id) => field(id).textContent.trim();
  const change = (id, value) => {
    field(id).value = value;
    field(id).dispatchEvent(new Event("change", { bubbles: true }));
  };
  const check = (condition, step) => {
    if (!condition) throw new Error(step);
  };
  const wait = (time) => new Promise((resolve) => setTimeout(resolve, time));
  const until = async (condition, step) => {
    for (let count = 0; count < 35 && !condition(); count++) await wait(85);
    check(condition(), step);
  };
  const swipe = (direction, target = field("question")) => {
    const start = new Touch({ identifier: 1, target, clientX: innerWidth / 2, clientY: 220 });
    const finish = new Touch({ identifier: 1, target, clientX: start.clientX - direction * 86, clientY: 220 });
    for (const [type, touches, changedTouches] of [
      ["touchstart", [start], [start]],
      ["touchmove", [finish], [finish]],
      ["touchend", [], [finish]],
    ]) {
      target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, changedTouches }));
    }
  };

  const report = document.createElement("p");
  report.id = "xigai-smoke-result";
  report.style.cssText = "position:fixed;top:32%;left:8%;right:8%;z-index:2147483646;background:#fff;color:#111;padding:20px;text-align:center;font:bold 24px system-ui;border:2px solid #111";
  try {
    await until(() => document.documentElement.dataset.studyReady === "true", "study initialization");
    const bank = window.QuizData;
    check(Array.isArray(bank) && bank.length > 0, "question bank");
    for (const item of bank) {
      for (const letter of Object.keys(item.options)) {
        if (item.answer.includes(letter)) continue;
        check(optionNotes.distractor(item, letter)?.reason?.trim(), `missing distractor reason ${item.id}/${letter}`);
      }
    }
    check(!field("account-button").hidden, "account access");
    const glass = getComputedStyle(document.querySelector(".masthead"));
    check((glass.backdropFilter || glass.webkitBackdropFilter || "").includes("blur"), "navigation material");
    check(document.documentElement.scrollWidth <= window.innerWidth + 1, "layout");
    check(!field("advanced-settings").open, "default chapter layout");

    const route = field("adventure-start");
    check(!route.hidden && !route.disabled, "chapter route");
    const answeredCount = () => Number(field("stat-done").firstElementChild.textContent);
    const before = answeredCount();
    route.click();
    const chapterCount = state.session.ids.length;
    const chapterName = text("where").split(" · ")[0];
    check(!field("quiz").hidden && text("where").includes(chapterName) &&
      chapterCount > 1 && text("where").endsWith("1 / " + chapterCount),
      "chapter practice started");
    check(document.querySelectorAll(".quiz-actions button").length === 1 && !field("previous") && !field("next"),
      "single study action");
    check(field("answer-summary").hidden && field("study-note").hidden, "answer hidden before submission");

    const stem = text("question");
    const optionButtons = () => [...field("options").querySelectorAll("button")];
    const letters = optionButtons().map((button) => button.querySelector(".letter").textContent);
    const question = bank.find((item) => item.chapter === chapterName && item.stem.trim() === stem &&
      Object.entries(item.options).every(([letter, option], index) =>
        letters[index] === letter && optionButtons()[index].lastElementChild.textContent === option) &&
      Object.keys(item.options).length === letters.length);
    check(question?.answer.length && question.study?.explanation, "opened question and explanation data");

    for (const answer of question.answer) {
      check(letters.includes(answer), "correct option available");
      optionButtons()[letters.indexOf(answer)].click();
    }
    if (!field("submit").hidden) field("submit").click();

    const checkExplanation = () => {
      check(!field("answer-summary").hidden, "answer shown");
      const answers = question.blank_answers?.map((choices) => choices.join(" / ")) || question.answer;
      check(answers.every((answer) => text("answer-text").includes(question.options[answer] || answer)),
        "correct answer displayed");
      check(!field("study-note").hidden && text("explanation") === question.study.explanation.trim(),
        "explanation displayed");
      if (question.study.reference?.page) {
        check(text("reference").includes(String(question.study.reference.page)), "textbook reference displayed");
      }
    };
    check(field("feedback").dataset.state === "correct" && text("quiz-completion").startsWith("已答 1 / "), "correct answer scored");
    checkExplanation();
    await until(() => text("where").endsWith("2 / " + chapterCount) && field("answer-summary").hidden,
      "correct answer advances automatically");
    swipe(-1, document.querySelector(".masthead"));
    check(text("question") === stem && field("feedback").dataset.state === "correct", "previous answer retained");
    checkExplanation();

    const slider = field("question-position");
    slider.value = chapterCount;
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    check(state.session.index === 0 && text("question") === stem &&
      text("where").endsWith(chapterCount + " / " + chapterCount), "position drag previews without changing questions");
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    check(state.session.index === chapterCount - 1, "position change jumps to the last question");
    change("question-position", 1);
    check(text("question") === stem && field("feedback").dataset.state === "correct", "jumping back retains the answer");

    swipe(1, document.querySelector(".quiz-actions"));
    check(text("where").endsWith("2 / " + chapterCount), "swipe on quiz action row");
    swipe(-1, document.body);
    check(text("question") === stem && field("feedback").dataset.state === "correct", "swipe on page background");

    field("back").click();
    check(field("quiz").hidden && answeredCount() === before + 1, "progress saved");
    const resume = field("resume");
    check(!resume.hidden || (!route.hidden && route.textContent.includes("继续")), "resume access");
    (resume.hidden ? route : resume).click();
    check(!field("quiz").hidden && text("question") === stem &&
      field("feedback").dataset.state === "correct", "resume retained answer");
    checkExplanation();

    field("back").click();
    field("advanced-settings").open = true;
    change("chapter", chapterName);
    change("scope", "done");
    change("order", "source");
    change("mode", "memory");
    change("count", "1");
    field("start").click();
    check(!field("quiz").hidden && field("question-position").disabled && text("question") === stem &&
      field("answer-summary").hidden && !field("submit").disabled, "memory round started");
    field("submit").click();
    checkExplanation();
    await wait(950);
    check(!field("quiz").hidden, "memory mode stays on the answer");

    const example = bank.find((item) => item.id === "导论-18");
    const other = bank.find((item) => item.id === "章节自测-导论-多选-6");
    check(example && other, "distractor fixture");
    const select = (letters) => {
      for (const letter of letters) optionButtons().find((button) => button.querySelector(".letter").textContent === letter).click();
    };
    const position = (index) => text("where").endsWith(`${index} / 2`);
    start([example.id, other.id], "practice");
    check(field("distractor-notes").hidden, "distractors hidden before grading");
    select(["A", "B", "C", "D"]);
    field("submit").click();
    await wait(950);
    check(position(1) && field("feedback").dataset.state === "incorrect", "incorrect answer stays in place");
    check(text("distractor-notes").includes("邓小平理论") && text("distractor-notes").includes("适用语境"), "wrong option has context");
    check(field("submit").hidden, "wrong answer has no next button");
    swipe(1);
    check(position(2) && field("distractor-notes").hidden, "left swipe clears old distractors");
    select(["C", "D"]);
    field("submit").click();
    check(field("distractor-notes").querySelectorAll("li").length ===
      Object.keys(other.options).filter((letter) => !other.answer.includes(letter)).length, "all distractors explained");
    check(text("submit") === "查看结果", "round can be closed");
    swipe(1);
    check(!field("result").hidden, "last question can be swiped to results");
    showHistoryQuestion(example);
    check(text("history-distractor-notes").includes("邓小平理论"), "history has the same distractor notes");
    field("history-question").close();

    const leadership = bank.find((item) => item.id === "章节自测-第三章-多选-6");
    check(leadership, "leadership example");
    start([leadership.id], "practice");
    check(field("distractor-notes").hidden, "option reasons hidden before answering");
    select(["A", "B", "C", "D"]);
    field("submit").click();
    const wrong = field("distractor-notes").querySelector("li");
    check(wrong?.textContent.includes("B · 误选") && wrong.textContent.includes("勇于自我革命"),
      "example explains the substituted concept");
    wrong.querySelector("button").click();
    check(field("option-notes-dialog").open && text("option-notes-content").includes("勇于自我革命"),
      "specific option detail matches the answer panel");
    field("option-notes-dialog").close();

    start([example.id, other.id], "chapter-test");
    check(field("distractor-notes").hidden, "chapter test keeps option reasons hidden before submission");
    select(example.answer);
    await wait(950);
    check(position(1) && field("answer-summary").hidden, "test saves selection without grading");
    swipe(1);
    select(other.answer);
    swipe(1);
    check(position(2) && text("submit") === "交卷" && field("answer-summary").hidden,
      "last test swipe cannot submit");
    swipe(-1);
    check(optionButtons().filter((button) => button.getAttribute("aria-pressed") === "true").length === example.answer.length,
      "test draft survives a round trip");
    field("submit").click();
    check(!field("result").hidden && text("score").includes("答对 2 道"), "explicit test submission");

    const optionSheet = field("option-notes-dialog");
    const optionBody = field("option-notes-content");
    const hold = async (index) => {
      const option = optionButtons()[index];
      const event = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: "touch", button: 0 };
      option.dispatchEvent(new PointerEvent("pointerdown", event));
      await until(() => optionSheet.open, "long press opens option details");
      option.dispatchEvent(new PointerEvent("pointerup", event));
      option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    };
    start(["导论-19", example.id], "practice");
    select(["B"]);
    const draft = JSON.stringify(state.session.selected);
    const optionText = optionButtons()[0].lastElementChild;
    check((getComputedStyle(optionText).userSelect || getComputedStyle(optionText).webkitUserSelect) === "none",
      "option text cannot be selected");
    for (const type of ["selectstart", "contextmenu"]) {
      check(!optionText.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })), "option blocks " + type);
    }
    await hold(0);
    check(document.getSelection().isCollapsed, "opening details leaves no selected text");
    check(JSON.stringify(state.session.selected) === draft, "long press keeps the existing answer draft");
    check(!optionBody.querySelector(".option-note-verdict"), "the practice note leaves grading hidden");
    for (const [index, count] of [10, 14, 13, 6].entries()) {
      field("option-notes-tabs").children[index].click();
      check(optionBody.querySelectorAll(".option-note-outline li").length === count, "four complete option outlines");
    }
    field("option-notes-close").click();
    await until(() => !optionSheet.open, "option sheet can close");
    field("submit").click();
    await hold(3);
    check(text("option-notes-content").includes("本题不选") &&
      text("option-notes-content").includes("党的二十大"), "review explains why the fourth option is outside the question");
    check(text("option-note-reference").includes("第 6 页") && field("option-note-textbook-quote").querySelector("mark"),
      "the selected term is highlighted in the textbook evidence");
    field("option-notes-close").click();
    await until(() => !optionSheet.open, "review note can close");
    const textbookQuestion = bank.find((item) => item.id === "第一章-3");
    const textbook = textbookQuestion?.study?.reference;
    check(textbook?.quote && textbook.highlights?.length === 2 &&
      textbook.page === 15 && textbook.endPage === 16, "bundled textbook excerpt and page range");
    const checkTextbook = (prefix = "") => {
      const passage = field(prefix + "textbook-quote");
      const marks = [...passage.querySelectorAll("mark")];
      check(!field(prefix + "textbook-evidence").hidden && passage.textContent === textbook.quote &&
        marks.length === textbook.highlights.length &&
        marks.every((mark, index) => mark.textContent === textbook.highlights[index]) &&
        text(prefix + "reference").includes("15–16"), "textbook shows the same excerpt and highlights");
    };
    start([textbookQuestion.id], "practice");
    check(field("study-note").hidden, "textbook excerpt stays hidden before grading");
    select(textbookQuestion.answer);
    if (!state.session.results[textbookQuestion.id]) field("submit").click();
    checkTextbook();
    showHistoryQuestion(textbookQuestion);
    checkTextbook("history-question-");
    field("history-question").close();

    const fill = bank.find((item) => item.type === "填空" && item.study?.reference?.quote);
    const savedFill = JSON.stringify(state.history[fill.id]);
    const optionsAnswer = textbookQuestion.answer;
    const answerLines = fill.blank_answers?.map((choices) => choices.join(" / ")) || fill.answer;
    const checkFill = () => {
      check(!field("answer-summary").hidden && text("answer-heading") === "参考答案" &&
        text("answer-text") === answerLines.join("\n") && !field("fill-answer") &&
        text("feedback") === "", "fill-in displays the answer immediately");
      check(!field("study-note").hidden && field("textbook-quote").querySelector("mark"),
        "fill-in displays explanation and textbook highlights");
    };

    start([fill.id, textbookQuestion.id, fill.id], "practice");
    checkFill();
    check(text("quiz-completion") === "已答 0 / 1" &&
      text("submit") === "下一题", "fill-ins are study pages and choices count toward progress");
    field("submit").click();
    check(field("answer-summary").hidden, "next question still waits for an answer");
    select(optionsAnswer);
    if (!state.session.results[textbookQuestion.id]) field("submit").click();
    swipe(1);
    checkFill();
    field("submit").click();
    check(!field("result").hidden && text("score").includes("共 1 道") &&
      JSON.stringify(state.history[fill.id]) === savedFill, "mixed practice scores only submitted questions");

    start([fill.id], "memory");
    checkFill();
    check(field("quiz-completion").hidden, "fill-only study has no scoring progress");
    field("submit").click();
    check(text("result-title") === "填空题查看完成", "fill-only study finishes");

    startChapterTest(fill.chapter, "all");
    check(state.session.mode === "chapter-test" && state.session.ids.length > 0 &&
      state.session.ids.every((id) => byId.get(id).type !== "填空") &&
      field("answer-summary").hidden, "chapter tests only include graded question types");
    report.textContent = "XIGAI PASS";
  } catch (error) {
    report.textContent = "XIGAI FAIL: " + error.message;
  }
  document.body.append(report);
});
</script>
"""


def main():
    target = Path(sys.argv[1])
    html = target.read_text(encoding="utf-8")
    if html.count("</body>") != 1:
        raise ValueError("Missing unique body tag in app HTML")
    if 'report.id = "xigai-smoke-result"' in html:
        raise ValueError("The page already contains the simulator smoke test")
    target.write_text(html.replace("</body>", SCRIPT + "</body>", 1), encoding="utf-8")


if __name__ == "__main__":
    main()
