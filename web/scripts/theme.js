(() => {
  "use strict";

  const key = "xigai-world-theme-v1";
  const names = { auto: "随时间", dawn: "晨雾", day: "日间", dusk: "暮色", night: "夜间" };
  const backgrounds = { dawn: "#e9efea", day: "#e7efe5", dusk: "#1a1b2a", night: "#0f1d2b" };
  const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const root = document.documentElement;
  const motion = new EventTarget();
  let nativeReducedMotion;
  Object.defineProperty(motion, "matches", { get: () => nativeReducedMotion ?? motionQuery.matches });
  function syncMotion() {
    if (root.hasAttribute("data-reduced-motion") === motion.matches) return;
    root.toggleAttribute("data-reduced-motion", motion.matches);
    motion.dispatchEvent(new Event("change"));
  }
  motionQuery.addEventListener("change", syncMotion);
  syncMotion();

  let preference = "auto";
  try {
    const saved = localStorage.getItem(key);
    if (Object.hasOwn(names, saved)) preference = saved;
  } catch {}

  function byClock() {
    const hour = new Date().getHours();
    return hour < 5 || hour >= 20 ? "night" : hour < 8 ? "dawn" : hour < 17 ? "day" : "dusk";
  }

  function applyMood() {
    const theme = preference === "auto" ? byClock() : preference;
    root.dataset.worldPreference = preference;
    root.dataset.worldTheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", backgrounds[theme]);
    return theme;
  }

  applyMood();

  const easeOut = "cubic-bezier(.20,.72,.22,1)";

  function page(element, x, y, duration) {
    if (motion.matches || !element.animate) return null;
    return element.animate([
      { opacity: .86, transform: `translate3d(${x}px, ${y}px, 0)` },
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
    ], { duration, easing: easeOut });
  }

  function answer(panel, correct) {
    if (motion.matches || !panel.animate) return null;
    if (correct) {
      return panel.querySelector("#feedback").animate([
        { opacity: .72, transform: "scale(.9)" },
        { opacity: 1, transform: "scale(1.045)", offset: .68 },
        { opacity: 1, transform: "scale(1)" },
      ], { duration: 230, easing: easeOut });
    }
    return panel.animate([
      { opacity: .76, transform: "translateY(6px)" },
      { opacity: 1, transform: "translateY(0)" },
    ], { duration: 190, easing: easeOut });
  }

  function answerStreak(scene, duration) {
    if (motion.matches || !scene.animate) return null;

    const { tier } = scene.dataset;
    const milestone = tier === "milestone";
    const sparkCount = { pair: 2, run: 5, milestone: 8 }[tier];
    const lift = { pair: 8, run: 13, milestone: 22 }[tier];
    const motions = [];
    function play(target, frames, time, delay = 0) {
      const element = target ? scene.querySelector(target) : scene;
      motions.push(element.animate(frames, { duration: time, delay, easing: easeOut, fill: "both" }));
    }
    play(null, [
      { opacity: 1, transform: "translateY(0)" },
      { opacity: 1, transform: "translateY(0)", offset: .78 },
      { opacity: 0, transform: "translateY(-11px)" },
    ], duration);
    play(".streak-crane", [
      { opacity: 0, transform: "translate(-61px, 26px) rotate(-22deg) scale(.63)" },
      { opacity: 1, transform: `translate(13px, -${lift}px) rotate(-9deg) scale(1.08)`, offset: .55 },
      { opacity: 1, transform: "translate(0, 0) rotate(0) scale(1)" },
    ], milestone ? 550 : 460);
    play(".streak-trail", [
      { opacity: 0, transform: "translateX(-43px) rotate(-19deg) scaleX(.36)" },
      { opacity: .95, transform: "translateX(8px) rotate(-14deg) scaleX(1.02)", offset: .43 },
      { opacity: .68, transform: "translateX(0) rotate(-12deg) scaleX(1)" },
    ], milestone ? 700 : 550);
    play(".streak-ticket", [
      { opacity: 0, transform: "translate(-18px, 7px) skewX(-14deg) scale(.88)" },
      { opacity: 1, transform: "translate(3px, -2px) skewX(1deg) scale(1.045)", offset: .63 },
      { opacity: 1, transform: "translate(0, 0) skewX(0) scale(1)" },
    ], 360, 74);
    play(".streak-ticket strong", [
      { opacity: 0, transform: "translateY(14px) scale(.68)" },
      { opacity: 1, transform: "translateY(-2px) scale(1.15)", offset: .56 },
      { opacity: 1, transform: "translateY(0) scale(1)" },
    ], 310, 141);
    play(".streak-ticket-glint", [
      { opacity: 0, transform: "translateX(-30%) skewX(-18deg)" },
      { opacity: 1, offset: .24 },
      { opacity: 0, transform: "translateX(360%) skewX(-18deg)" },
    ], 470, 229);
    if (milestone) {
      play(".streak-halo", [
        { opacity: 0, transform: "scale(.5)" },
        { opacity: .85, transform: "scale(.97)", offset: .39 },
        { opacity: .18, transform: "scale(1.12)" },
      ], 1020, 18);
    }
    const sparkPaths = [[-103, -26], [108, -25], [-90, 33], [102, 31], [31, -44],
      [-121, 11], [123, 3], [6, 45]];
    const sparks = scene.querySelectorAll(".streak-sparks i");
    for (const [index, spark] of [...sparks].slice(0, sparkCount).entries()) {
      const [x, y] = sparkPaths[index];
      motions.push(spark.animate([
        { opacity: 0, transform: "translate(0, 0) scale(.3)" },
        { opacity: 1, transform: `translate(${x * .63}px, ${y * .63}px) scale(1.3)`, offset: .37 },
        { opacity: 0, transform: `translate(${x}px, ${y}px) scale(.35) rotate(32deg)` },
      ], { duration: 640, delay: 65 + index * 22, easing: easeOut }));
    }
    return { cancel: () => motions.forEach((animation) => animation.cancel()) };
  }

  window.QuizWorldMotion = { page, answer, answerStreak, preference: motion };

  function connect() {
    const capacitor = window.Capacitor;
    if (capacitor?.getPlatform?.() === "android" && capacitor.isPluginAvailable?.("QuizAppearance")) {
      const appearance = capacitor.Plugins.QuizAppearance;
      const setMotionPreference = ({ reduced }) => {
        nativeReducedMotion = reduced;
        syncMotion();
      };
      Promise.resolve().then(() => appearance.getMotionPreference()).then(setMotionPreference).catch(() => {});
      Promise.resolve().then(() => appearance.addListener("motionPreferenceChanged", setMotionPreference)).catch(() => {});
    }

    const dialog = document.getElementById("theme-dialog");
    const button = document.getElementById("theme-button");
    if (!dialog || !button) return;
    const panel = window.QuizSheetMotion?.attach(dialog);
    const choices = [...dialog.querySelectorAll("[data-theme-choice]")];
    const scenes = {
      camp: window.QuizCampScene?.attach(document.getElementById("camp-world-canvas"), { theme: root.dataset.worldTheme, variant: "camp", lit: true }),
    };

    let lastTheme = "";
    function sync(animate = false) {
      const theme = applyMood();
      const label = preference === "auto" ? `随时间 · ${names[theme]}` : names[theme];
      document.getElementById("theme-current").textContent = label;
      const summary = document.getElementById("theme-summary");
      if (summary) summary.textContent = label;
      for (const choice of choices) choice.setAttribute("aria-pressed", String(choice.dataset.themeChoice === preference));
      if (lastTheme === theme) return;
      lastTheme = theme;
      for (const scene of Object.values(scenes)) scene?.setTheme(theme);
      const native = window.webkit?.messageHandlers?.quizNativeUI;
      const dark = theme === "night" || theme === "dusk";
      if (native) {
        const accent = getComputedStyle(root).getPropertyValue("--world-accent").trim();
        const rgb = /^#[0-9a-f]{6}$/i.test(accent) ? Number.parseInt(accent.slice(1), 16) : null;
        Promise.resolve(native.postMessage({ kind: "theme", dark, accent: rgb })).catch(() => {});
      }
      if (!native && capacitor?.isNativePlatform?.()) {
        const plugins = capacitor.Plugins;
        const syncBars = plugins?.QuizAppearance
          ? plugins.QuizAppearance.setTheme({ theme })
          : plugins?.SystemBars?.setStyle({ style: dark ? "DARK" : "LIGHT" });
        Promise.resolve(syncBars).catch(() => {});
      }
      if (animate && !motion.matches) {
        for (const canvas of document.querySelectorAll(".world-scene canvas[data-scene-rendered]")) {
          canvas.animate([{ opacity: .56 }, { opacity: 1 }], { duration: 380, easing: "ease-out" });
        }
      }
    }

    function open() {
      if (!dialog.open) dialog.showModal();
    }

    button.onclick = open;
    const profile = document.getElementById("theme-profile");
    if (profile) profile.onclick = open;
    document.getElementById("theme-close").onclick = () => panel ? panel.close() : dialog.close();
    for (const choice of choices) {
      choice.onclick = () => {
        const selection = choice.dataset.themeChoice;
        if (!Object.hasOwn(names, selection)) return;
        preference = selection;
        try { localStorage.setItem(key, preference); } catch {}
        sync(true);
      };
    }

    for (const control of document.querySelectorAll("[data-scene-action]")) {
      const scene = scenes[control.dataset.sceneTarget];
      control.hidden = !scene;
      control.onclick = () => {
        const action = control.dataset.sceneAction;
        if (action === "reset") scene?.resetView();
        else scene?.rotate(action === "left" ? -1 : 1);
      };
    }

    window.addEventListener("focus", () => sync());
    document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
    setInterval(() => { if (preference === "auto" && !document.hidden) sync(); }, 30000);
    sync();
  }

  document.addEventListener("DOMContentLoaded", connect, { once: true });
})();
