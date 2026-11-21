const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const { runInNewContext } = require("node:vm");

const source = readFileSync(resolve(__dirname, "../account.js"), "utf8");
const accountWithMockClient = require("./helpers/account-source.cjs").accountSource();
assert.notEqual(accountWithMockClient, source);

const email = "learner@example.test";
const token = "00123456";
const password = "Fixture-new-password-42";
const verified = { data: { session: { access_token: "fixture-session" } }, error: null };

async function setup({ enabled = true, verify = () => verified, update = () => ({ error: null }), animated = false } = {}) {
  const recoveryCalls = [];
  const normalCalls = [];
  const configurations = [];
  const elements = new Map();
  const document = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) {
        const attributes = new Set();
        elements.set(id, {
          value: "",
          hidden: ["account-active", "account-forgot", "account-recovery-form", "account-recovery-verification"].includes(id),
          open: false,
          focus() { document.activeElement = this; },
          closest(selector) { return selector === "dialog" || selector === "#account-dialog" ? field("dialog") : null; },
          setAttribute(name) { attributes.add(name); },
          hasAttribute(name) { return attributes.has(name); },
          removeAttribute(name) { attributes.delete(name); },
          addEventListener(name, callback) { this[name + "Listener"] = callback; },
        });
      }
      return elements.get(id);
    },
    addEventListener() {},
  };
  const field = (name) => document.getElementById(`account-${name}`);
  const dialog = field("dialog");
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.closeListener?.(); dialog.removeAttribute("data-sheet-closing"); };
  field("form").reset = () => { field("email-input").value = ""; field("password").value = ""; };
  field("recovery-form").reset = () => {
    for (const name of ["recovery-email", "recovery-code", "recovery-password"]) field(name).value = "";
  };
  const window = { QuizCloud: { url: "https://recovery.example.test", key: "mock-key", passwordRecovery: enabled } };
  if (animated) {
    window.QuizSheetMotion = { attach: () => ({ close: () => dialog.setAttribute("data-sheet-closing", "") }) };
  }

  const recoveryAuth = {
    async resetPasswordForEmail(address) { recoveryCalls.push(["send", address]); return { error: null }; },
    async verifyOtp(payload) { recoveryCalls.push(["verify", { ...payload }]); return verify(payload); },
    async updateUser(payload) { recoveryCalls.push(["update", { ...payload }]); return update(payload); },
    async signOut(options) { recoveryCalls.push(["signOut", { ...options }]); return { error: null }; },
  };
  const unexpected = (operation) => (...args) => {
    normalCalls.push([operation, ...args]);
    throw new Error(`Recovery accessed normal auth or progress: ${operation}`);
  };
  const normalClient = {
    auth: {
      onAuthStateChange() {},
      signInWithPassword: unexpected("normal signIn"),
      resetPasswordForEmail: unexpected("normal send"),
      verifyOtp: unexpected("normal verify"),
      updateUser: unexpected("normal update"),
      signOut: unexpected("normal signOut"),
    },
    from: unexpected("sync read"),
    rpc: unexpected("sync write"),
  };
  runInNewContext(accountWithMockClient, {
    window,
    document,
    TextEncoder,
    createClient(_url, _key, { auth }) {
      configurations.push({ ...auth });
      return configurations.length === 1 ? normalClient : { auth: recoveryAuth };
    },
    localStorage: { getItem: unexpected("cache read"), setItem: unexpected("cache write") },
    addEventListener() {}, setTimeout() {}, clearTimeout() {}, setInterval() {},
  });
  const sync = window.QuizAccount.connect({ receive: unexpected("sync state"), guest: unexpected("guest state reset") });
  await field("button").onclick();
  field("email-input").value = "  Learner@Example.TEST  ";
  const submit = () => field("recovery-form").onsubmit({ preventDefault() {} });
  return { field, dialog, document, recoveryCalls, normalCalls, configurations, sync, submit };
}

async function requestCode(app) {
  const { field, submit } = app;
  assert.equal(field("forgot").hidden, false);
  field("forgot").onclick();
  assert.equal(field("form").hidden, true);
  assert.equal(field("recovery-form").hidden, false);
  await submit();
  assert.equal(field("recovery-email").value, email);
  assert.equal(field("recovery-email").readOnly, true);
  assert.equal(field("recovery-code").disabled, false);
  assert.equal(app.document.activeElement, field("recovery-code"));
  assert.match(field("recovery-message").textContent, /如果此邮箱有账号/);
  field("recovery-code").value = token;
  field("recovery-password").value = password;
}

function assertRecoveryIsolated(app) {
  assert.equal(app.configurations.length, 2);
  assert.notEqual(app.configurations[0].storageKey, app.configurations[1].storageKey);
  assert.equal(app.configurations[1].persistSession, false);
  assert.equal(app.configurations[1].autoRefreshToken, false);
  assert.equal(app.configurations[1].detectSessionInUrl, false);
  assert.deepEqual(app.normalCalls, []);
  assert.equal(app.sync.enabled(), false);
}

test("password reset is hidden until the project explicitly enables it", async () => {
  for (const enabled of [false, null, "true"]) {
    const { field, configurations, recoveryCalls } = await setup({ enabled });
    assert.equal(field("forgot").hidden, true);
    assert.equal(field("recovery-form").hidden, true);
    assert.equal(field("forgot").onclick, undefined);
    assert.equal(configurations.length, 1);
    assert.deepEqual(recoveryCalls, []);
  }
});

test("recovery email code validates 6–10 digits and preserves leading zeros", () => {
  const template = ["../../index.html", "../../docs/index.html"].map((name) => resolve(__dirname, name)).find(existsSync);
  const input = readFileSync(template, "utf8").match(/<input id="account-recovery-code"[^>]+>/)?.[0];
  assert.match(input, /type="text"/);
  assert.match(input, /inputmode="numeric"/);
  assert.match(input, /pattern="\[0-9\]\{6,10\}"/);
  assert.match(input, /maxlength="10"/);
});

test("a valid code updates only the recovery session and returns to ordinary login", async () => {
  const app = await setup();
  await requestCode(app);
  await app.submit();
  assert.deepEqual(app.recoveryCalls, [
    ["send", email], ["verify", { email, token, type: "recovery" }],
    ["update", { password }], ["signOut", { scope: "local" }],
  ]);
  assert.equal(app.field("recovery-form").hidden, true);
  assert.equal(app.field("recovery-password").value, "");
  assert.equal(app.field("form").hidden, false);
  assert.equal(app.field("email-input").value, email);
  assert.equal(app.field("password").value, "");
  assert.match(app.field("message").textContent, /密码已重置.*登录/);
  assertRecoveryIsolated(app);
});

test("an invalid or expired recovery code does not write a password", async () => {
  const app = await setup({ verify: () => ({ data: { session: null }, error: { code: "otp_expired", status: 403 } }) });
  await requestCode(app);
  await app.submit();
  assert.deepEqual(app.recoveryCalls.map(([operation]) => operation), ["send", "verify"]);
  assert.equal(app.field("recovery-form").hidden, false);
  assert.equal(app.field("recovery-submit").disabled, false);
  assert.equal(app.field("recovery-code").readOnly, false);
  assert.match(app.field("recovery-message").textContent, /验证码无效或已过期/);
  assertRecoveryIsolated(app);
});

test("a rejected password can be changed and retried without consuming another code", async () => {
  const secondPassword = "Different-fixture-password-99";
  const app = await setup({ update: ({ password: candidate }) => ({
    error: candidate === secondPassword ? null : { code: "weak_password" },
  }) });
  await requestCode(app);
  await app.submit();
  assert.equal(app.field("recovery-code").readOnly, true);
  assert.equal(app.field("recovery-submit").disabled, false);
  assert.match(app.field("recovery-message").textContent, /不同且更难猜/);
  app.field("recovery-password").value = secondPassword;
  await app.submit();
  assert.deepEqual(app.recoveryCalls, [
    ["send", email], ["verify", { email, token, type: "recovery" }],
    ["update", { password }], ["update", { password: secondPassword }], ["signOut", { scope: "local" }],
  ]);
  assertRecoveryIsolated(app);
});

for (const animated of [false, true]) {
  test(`closing ${animated ? "with" : "without"} the sheet animation during verification never writes a password`, async () => {
    const { promise, resolve: finishVerification } = Promise.withResolvers();
    const app = await setup({ verify: () => promise, animated });
    await requestCode(app);
    const submission = app.submit();
    assert.equal(app.field("recovery-submit").disabled, true);
    app.field("close").onclick();
    assert.equal(app.dialog.open, animated);
    if (animated) assert.equal(app.dialog.hasAttribute("data-sheet-closing"), true);
    finishVerification(verified);
    await submission;
    if (animated) app.dialog.close();
    assert.deepEqual(app.recoveryCalls.map(([operation]) => operation), ["send", "verify", "signOut"]);
    assert.deepEqual(app.recoveryCalls[2][1], { scope: "local" });
    assert.equal(app.field("recovery-form").hidden, true);
    assertRecoveryIsolated(app);
  });
}
