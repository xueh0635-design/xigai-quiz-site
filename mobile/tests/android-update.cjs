const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const { runInNewContext } = require("node:vm");

const source = readFileSync(resolve(__dirname, "../android-update.js"), "utf8");

async function setup(status, openRelease) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { hidden: true, classList: { toggle() {} } });
      return elements.get(id);
    },
  };
  runInNewContext(source, { document, window: { Capacitor: {
    getPlatform: () => "android",
    isPluginAvailable: () => true,
    Plugins: { QuizUpdate: {
      getStatus: async () => status,
      addListener: () => "native callback handle",
      openRelease,
    } },
  } } });
  await new Promise(setImmediate);
  return elements;
}

test("tapping the GitHub button runs the native action without a completion callback", async () => {
  for (const available of [true, false]) {
    let opens = 0;
    const elements = await setup({ available, currentVersionName: "1.1.3", versionName: "1.1.4" }, async () => { opens++; });
    const button = elements.get("update-download");
    assert.equal(button.hidden, false);
    assert.equal(button.textContent, available ? "前往 GitHub 下载" : "查看 GitHub 发布页");
    await button.onclick();
    assert.equal(opens, 1);
    assert.equal(button.disabled, false);
  }
});

test("a failed browser launch reports the error and permits another tap", async () => {
  const elements = await setup({ currentVersionName: "1.1.3" }, async () => { throw Error("No browser available"); });
  const button = elements.get("update-download");
  await button.onclick();
  assert.equal(button.disabled, false);
  assert.match(elements.get("update-status").textContent, /操作未完成/);
});
