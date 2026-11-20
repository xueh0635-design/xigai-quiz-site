"""Inject a disposable sync UI fixture into an assembled quiz app page."""

from pathlib import Path
import sys


SETUP = r"""
const syncFixture = { writes: [] };
window.QuizAccount = {
  connect(callbacks) {
    syncFixture.receive = callbacks.receive;
    return {
      enabled: () => true,
      queue: (rows) => syncFixture.writes.push(...structuredClone(rows)),
    };
  },
};
"""


SCRIPT = r"""
<script>
window.addEventListener("load", () => {
  const field = (id) => document.getElementById(id);
  const text = (id) => field(id).textContent.trim();
  const check = (condition, step) => {
    if (!condition) throw new Error(step);
  };
  const report = document.createElement("p");
  report.id = "xigai-sync-ui-result";
  report.style.cssText = "position:fixed;top:32%;left:8%;right:8%;z-index:2147483646;background:#fff;color:#111;padding:20px;text-align:center;font:bold 24px system-ui;border:2px solid #111";
  try {
    const first = window.QuizData.find((question) => question.type === "多选" && Object.keys(question.options).length >= 2);
    const second = window.QuizData.find((question) => question.type === "单选" && Object.keys(question.options).length >= 2);
    check(first && second, "option fixtures");
    const firstLetters = Object.keys(first.options).slice(0, 2);
    const [secondDraft, secondEdit] = Object.keys(second.options);
    const session = {
      sid: "cross-device-round", mode: "practice", ids: [first.id, second.id], index: 0, selected: [], results: {},
    };
    const legacy = { wrong: true, last: 1 };
    const received = { wrong: true, last: 2, selected: firstLetters };
    const deliver = (answer, resume, reset = false) => syncFixture.receive(structuredClone({
      history: { [first.id]: answer }, stars: reset ? {} : { [first.id]: true }, session: resume,
    }), reset);
    const selected = () => [...field("options").querySelectorAll('[aria-pressed="true"] .letter')]
      .map((letter) => letter.textContent);

    deliver(legacy, session, true);
    field("resume").click();
    check(text("question") === first.stem.trim(), "first question resumed");
    const newResume = { ...session, index: 1, selected: [secondDraft] };
    deliver(legacy, newResume);
    check(text("question") === first.stem.trim(), "open question stayed in place");
    check(field("star").getAttribute("aria-pressed") === "true", "remote star displayed on open question");
    field("back").click();
    field("resume").click();
    check(text("question") === second.stem.trim() && selected().join() === secondDraft,
      "remote resume displayed the exact saved draft option");

    deliver(legacy, session);
    const option = [...field("options").querySelectorAll(".option")]
      .find((button) => button.querySelector(".letter").textContent === secondEdit);
    option.click();
    field("back").click();
    field("resume").click();
    check(text("question") === second.stem.trim() && selected().join() === secondEdit,
      "a later local draft remained the active resume");
    field("submit").click();
    const sent = syncFixture.writes.find(([kind, key]) => kind === "history" && key === second.id);
    check(sent?.[2].selected.join() === secondEdit, "submission queued exact option on the question history record");

    document.querySelector('[data-study-tab="profile"]').click();
    document.querySelector('[data-profile-library="done"]').click();
    [...field("library-list").querySelectorAll(".library-item")]
      .find((button) => button.dataset.questionId === first.id).click();
    check(field("history-question").open && text("history-question-selection") === "这条早期记录保存了判分。",
      "legacy history did not invent an option");
    deliver(received, newResume);
    const optionLabels = firstLetters.map((letter) => `${letter}　${first.options[letter]}`).join("\n");
    check(field("history-question").open && text("history-question-selection") === optionLabels,
      "open history showed all received option letters and text");
    report.textContent = "XIGAI SYNC UI PASS";
  } catch (error) {
    report.textContent = "XIGAI SYNC UI FAIL: " + error.message;
  }
  document.body.append(report);
});
</script>
"""


def main():
    target = Path(sys.argv[1])
    html = target.read_text(encoding="utf-8")
    marker = "const allQuestions ="
    if html.count(marker) != 1 or html.count("</body>") != 1 or 'report.id = "xigai-sync-ui-result"' in html:
        raise ValueError("Expected an assembled app page without the sync UI fixture")
    target.write_text(
        html.replace(marker, SETUP + marker, 1).replace("</body>", SCRIPT + "</body>", 1),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
