const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const { runInNewContext } = require("node:vm");

const practice = readFileSync(resolve(__dirname, "../../web/scripts/practice.js"), "utf8");
function source(name) {
  const start = practice.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return practice.slice(start, practice.indexOf("\n}", start + 1) + 2);
}

function app(scale = 1) {
  const handlers = new Map();
  const viewportHandlers = new Map();
  const moves = [];
  const session = { ids: ["q1", "q2", "q3"], index: 1 };
  const context = {
    window: { visualViewport: { scale, addEventListener: (name, handler) => viewportHandlers.set(name, handler) }, getSelection: () => null },
    document: { documentElement: { style: {} }, querySelector: () => null,
      addEventListener: (name, handler) => handlers.set(name, handler) },
    accountSwitching: false,
    $: () => ({ hidden: false }),
    current: () => ({ id: session.ids[session.index] }),
    state: { session },
    lessonCard: { style: { removeProperty() {} } },
    reducedMotion: { matches: true },
    pageMotion: null,
    questionDestination: (_, direction) => session.index + direction,
    moveQuestion: (direction) => moves.push(direction),
    cancelAutoAdvance() {},
  };
  const nativeStart = practice.indexOf("  window.QuizNativeUI = {");
  assert.ok(nativeStart >= 0);
  const native = practice.slice(nativeStart, practice.indexOf("\n  };", nativeStart) + 5);
  runInNewContext([source("canSwipeQuestion"), source("connectQuestionSwipe"), native,
    "connectQuestionSwipe();"].join("\n"), context);

  const point = (x, id = 1) => ({ identifier: id, clientX: x, clientY: 100 });
  let prevented = 0;
  function touch(type, points, timeStamp = 100) {
    handlers.get(type)({
      touches: type === "touchend" ? [] : points,
      changedTouches: points,
      target: { closest: () => null },
      timeStamp,
      cancelable: true,
      preventDefault() { prevented++; },
    });
  }
  function swipe(dx = -40) {
    touch("touchstart", [point(150)], 0);
    touch("touchmove", [point(150 + dx)], 50);
    touch("touchend", [point(150 + dx)], 100);
  }
  function zoom(value) {
    context.window.visualViewport.scale = value;
    viewportHandlers.get("resize")();
  }
  return { context, moves, point, touch, swipe, zoom, prevented: () => prevented };
}

test("a magnified question allows horizontal panning without changing the question", () => {
  const model = app(2);
  model.swipe();
  assert.deepEqual(model.moves, []);
  assert.equal(model.prevented(), 0);
  assert.equal(model.context.document.documentElement.style.touchAction, "manipulation");
});

test("ordinary left and right swipes still change questions", () => {
  const model = app();
  model.swipe(-40);
  model.swipe(40);
  assert.deepEqual(model.moves, [1, -1]);
  assert.equal(model.prevented(), 4);
  assert.equal(model.context.document.documentElement.style.touchAction, "");
});

test("a pinch or a zoom change cancels an in-progress question swipe", () => {
  for (const pinch of [false, true]) {
    const model = app();
    model.touch("touchstart", [model.point(150)], 0);
    if (pinch) {
      model.touch("touchstart", [model.point(150), model.point(200, 2)], 20);
    }
    model.zoom(2);
    // Returning to normal scale must not resurrect the interrupted gesture,
    // even if the WebView did not send a second touchstart to the document.
    model.zoom(1);
    model.touch("touchmove", [model.point(110)], 50);
    model.touch("touchend", [model.point(110)], 100);
    assert.deepEqual(model.moves, []);
    assert.equal(model.prevented(), 0);
  }
});

test("native question swipes respect zoom and resume after returning to normal scale", () => {
  const model = app(2);
  model.context.window.QuizNativeUI.swipeQuestion(1);
  assert.deepEqual(model.moves, []);
  model.zoom(1);
  model.context.window.QuizNativeUI.swipeQuestion(1);
  assert.deepEqual(model.moves, [1]);
  assert.equal(model.context.document.documentElement.style.touchAction, "");
});
