"""Add a visible pass/fail result after exercising the quiz in a simulator build."""
from pathlib import Path
import sys

SCRIPT = r"""
<script>
window.addEventListener("load", () => {
  const field = (id) => document.getElementById(id);
  const change = (id, value) => {
    field(id).value = value;
    field(id).dispatchEvent(new Event("change", { bubbles: true }));
  };
  const check = (condition, step) => {
    if (!condition) throw new Error(step);
  };

  const report = document.createElement("p");
  report.style.cssText = "position:fixed;top:32%;left:8%;right:8%;z-index:2147483646;background:#fff;color:#111;padding:20px;text-align:center;font:bold 24px system-ui;border:2px solid #111";
  try {
    check(window.QuizData.length === 1221, "question count");
    check(!field("account-button").hidden, "account access");
    const glass = getComputedStyle(document.querySelector(".masthead"));
    check((glass.backdropFilter || glass.webkitBackdropFilter || "").includes("blur"), "navigation material");
    check(document.documentElement.scrollWidth <= window.innerWidth, "layout");
    check(!field("advanced-settings").open, "default chapter layout");
    document.querySelector("[data-quick-chapter]").click();
    check(field("where").textContent.endsWith("1 / 20"), "quick chapter practice");
    field("options").children[1].click();
    check(field("feedback").textContent === "回答正确" && field("answer-text").textContent.includes("全面从严治党"), "answer reveal");
    check(!field("study-note").hidden && field("reference").textContent.includes("337"), "explanation");
    check(!field("related-study").hidden && field("related-list").children.length, "related practice");
    field("back").click();
    check(field("stat-done").firstElementChild.textContent === "1", "progress");
    check(!field("resume").hidden, "resume access");
    field("resume").click();
    check(!field("answer-summary").hidden, "resume answer");
    field("back").click();
    field("advanced-settings").open = true;
    change("count", "1");
    change("order", "source");
    change("mode", "memory");
    field("start").click();
    field("submit").click();
    check(!field("study-note").hidden, "memory reveal");
    report.textContent = "XIGAI PASS";
  } catch (error) {
    report.textContent = "XIGAI FAIL: " + error.message;
  }
  document.body.append(report);
});
</script>
"""

target = Path(sys.argv[1])
html = target.read_text()
if html.count("</body>") != 1:
    raise RuntimeError("Missing unique body tag in app HTML")
target.write_text(html.replace("</body>", SCRIPT + "</body>", 1))
