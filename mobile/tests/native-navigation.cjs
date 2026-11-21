const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

test("iOS native tabs and the WebView agree on every route, label and position", () => {
  const native = readFileSync(resolve(__dirname, "../ios-native/QuizNativeTabBarController.swift"), "utf8");
  const html = readFileSync(resolve(__dirname, "../../web/index.template.html"), "utf8");
  const dock = html.match(/<nav\b[^>]*id="mobile-tabs"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(dock, "the bundled WebView has a primary tab bar");
  const nativeTabs = [...native.matchAll(/StudyTab\(name: "([^"]+)", title: "([^"]+)"/g)]
    .map((match) => ({ name: match[1], title: match[2] }));
  const webTabs = [...dock.matchAll(/<button\b[^>]*data-study-tab="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)]
    .map((match) => ({ name: match[1], title: match[2].replace(/<[^>]*>/g, "").trim() }));
  assert.deepEqual(nativeTabs, webTabs, "a native tap must open the corresponding WebView page");
  assert.ok(nativeTabs.length > 0 && nativeTabs.length <= 5, "keep every route directly available in the iPhone tab bar");
  assert.equal(new Set(nativeTabs.map((tab) => tab.name)).size, nativeTabs.length, "native routes are unique");
  assert.ok(nativeTabs.some((tab) => tab.name === "knowledge"), "knowledge has its own native tab");
  assert.match(html, /data-profile-library="starred"/, "collections remain reachable after moving their bottom tab");
});
