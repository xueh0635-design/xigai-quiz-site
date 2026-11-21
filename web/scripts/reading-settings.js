(() => {
  "use strict";
  const key = "quiz-reading-size-v1";
  const sizes = new Set(["100", "115", "130"]);
  const select = document.getElementById("reading-size");
  if (!select) return;
  function apply(value) {
    select.value = sizes.has(value) ? value : "100";
    document.documentElement.style.fontSize = `${16 * Number(select.value) / 100}px`;
  }
  try { apply(localStorage.getItem(key)); } catch { apply("100"); }
  select.addEventListener("change", () => {
    apply(select.value);
    try { localStorage.setItem(key, select.value); } catch { /* The preference still applies this session. */ }
  });
})();
