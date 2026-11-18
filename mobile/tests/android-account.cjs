const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const { runInNewContext } = require("node:vm");

const source = readFileSync(resolve(__dirname, "../account.js"), "utf8");
const sourceWithMockClient = source.replace(/^import .* from "@supabase\/supabase-js";\r?\n/m, "");
assert.notEqual(source, sourceWithMockClient);

const user = { id: "local-account-fixture", email: "learner@example.test" };
const password = "Local-test-password-42";
const duplicate = "无法用这个邮箱创建账号。如果注册过，请直接登录。";

function registrationError(status, message) {
  return {
    error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
      name: "FunctionsHttpError",
      context: new Response(JSON.stringify({ message }), { status }),
    }),
  };
}

async function setup({ registration = { error: null }, signIn = { data: { user }, error: null } } = {}) {
  const events = [];
  const calls = [];
  const elements = new Map();
  const document = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) {
        const element = {
          value: "",
          hidden: id === "account-active",
          open: false,
          focus() { document.activeElement = this; },
          removeAttribute(name) { if (name === "minlength") this.minLength = -1; },
          addEventListener(name, listener) { this[name + "Listener"] = listener; },
        };
        elements.set(id, element);
      }
      return elements.get(id);
    },
    addEventListener() {},
  };
  const field = (name) => document.getElementById(`account-${name}`);
  const dialog = field("dialog");
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.closeListener?.(); };
  field("form").reset = () => { field("email-input").value = ""; field("password").value = ""; };
  const window = { QuizCloud: { url: "https://fixture.example.test", key: "mock-client-key" } };
  const saved = {
    records: { "history:q1": { kind: "history", record_key: "q1", payload: { wrong: 2 } } },
    pending: {},
  };
  const client = {
    functions: { async invoke(name, { body }) { calls.push([name, { ...body }]); return registration; } },
    auth: {
      async signInWithPassword(credentials) {
        calls.push(["signIn", { ...credentials }]);
        return typeof signIn === "function" ? signIn(credentials) : signIn;
      },
      onAuthStateChange() {},
    },
  };
  runInNewContext(sourceWithMockClient, {
    window,
    document,
    createClient: () => client,
    localStorage: { getItem: (key) => key === `xigai-account-v1:${user.id}` ? JSON.stringify(saved) : null },
    addEventListener() {},
    setTimeout() {},
    clearTimeout() {},
    setInterval() {},
  });
  const sync = window.QuizAccount.connect({ receive: (state, reset) => events.push({ state, reset }) });
  await field("button").onclick();
  field("toggle").onclick();
  field("email-input").value = user.email;
  field("password").value = password;
  return {
    document, field, dialog, calls, events, sync,
    submit: () => field("form").onsubmit({ preventDefault() {} }),
  };
}

test("new account creation signs in with the submitted credentials and closes the form", async () => {
  const { field, calls, dialog, sync, submit } = await setup();
  await submit();
  assert.deepEqual(calls, [
    ["quiz-register", { email: user.email, password }],
    ["signIn", { email: user.email, password }],
  ]);
  assert.equal(sync.enabled(), true);
  assert.equal(dialog.open, false);
  assert.equal(field("active").hidden, false);
});

test("a registration conflict with matching credentials opens the existing account without resetting progress", async () => {
  const { calls, dialog, events, field, sync, submit } = await setup({ registration: registrationError(409, duplicate) });
  await submit();
  assert.deepEqual(calls, [
    ["quiz-register", { email: user.email, password }],
    ["signIn", { email: user.email, password }],
  ]);
  assert.equal(dialog.open, false);
  assert.equal(sync.enabled(), true);
  assert.equal(field("email").textContent, user.email);
  assert.equal(events.length, 1);
  assert.equal(events[0].state.history.q1.wrong, 2);
});

test("a registration conflict with incorrect credentials sends one login attempt and leaves a focused login form", async () => {
  const originalPassword = "Another-fixture-password-23";
  const signIn = ({ password: received }) => received === originalPassword
    ? { data: { user }, error: null }
    : { data: { user: null }, error: { status: 400, code: "invalid_credentials" } };
  const { calls, dialog, document, field, sync, submit } = await setup({
    registration: registrationError(409, duplicate), signIn,
  });
  await submit();
  assert.deepEqual(calls, [
    ["quiz-register", { email: user.email, password }],
    ["signIn", { email: user.email, password }],
  ]);
  assert.equal(sync.enabled(), false);
  assert.equal(dialog.open, true);
  assert.equal(field("submit").textContent, "登录");
  assert.equal(field("submit").disabled, false);
  assert.equal(field("toggle").disabled, false);
  assert.equal(field("email-input").value, user.email);
  assert.equal(field("password").value, "");
  assert.equal(field("password").autocomplete, "current-password");
  assert.equal(document.activeElement, field("password"));
  assert.match(field("message").textContent, /登录/);
  field("password").value = originalPassword;
  await submit();
  assert.equal(dialog.open, false);
  assert.equal(sync.enabled(), true);
  assert.deepEqual(calls.slice(2), [["signIn", { email: user.email, password: originalPassword }]]);
});

test("registration errors other than a conflict keep the registration form and never attempt login", async () => {
  for (const [status, copy] of [[400, "请换一个更难猜的密码。"], [429, "注册请求过多，请稍后再试。"], [503, "注册服务暂不可用。"]]) {
    const { calls, dialog, field, sync, submit } = await setup({ registration: registrationError(status, copy) });
    await submit();
    assert.deepEqual(calls, [["quiz-register", { email: user.email, password }]]);
    assert.equal(dialog.open, true);
    assert.equal(sync.enabled(), false);
    assert.equal(field("submit").textContent, "创建并登录");
    assert.equal(field("submit").disabled, false);
    assert.equal(field("message").textContent, copy);
  }
});

test("a temporary auth error after a registration conflict keeps the retry available without blaming the password", async () => {
  const signIn = { data: { user: null }, error: { status: 429, code: "over_request_rate_limit" } };
  const { calls, field, sync, submit } = await setup({ registration: registrationError(409, duplicate), signIn });
  await submit();
  assert.equal(calls.filter(([operation]) => operation === "signIn").length, 1);
  assert.equal(sync.enabled(), false);
  assert.equal(field("submit").disabled, false);
  assert.match(field("message").textContent, /暂时无法登录/);
});
