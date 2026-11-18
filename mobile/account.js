import { createClient } from "@supabase/supabase-js";

const config = window.QuizCloud;
const byId = (id) => document.getElementById(id);
const accountLabel = () => byId("account-label");
const accountKey = (id) => "xigai-account-v1:" + id;
const keyFor = (record) => record.kind + ":" + record.record_key;

function readCache(id) {
  try {
    return JSON.parse(localStorage.getItem(accountKey(id))) || { records: {}, pending: {} };
  } catch {
    return { records: {}, pending: {} };
  }
}

function isNewer(row, other) {
  return !other || row.revision > other.revision ||
    (row.revision === other.revision && row.change_id > other.change_id);
}

function attachRecovery(dialog, loginForm, canStart, restoreLogin) {
  const form = byId("account-recovery-form");
  const email = byId("account-recovery-email");
  const code = byId("account-recovery-code");
  const password = byId("account-recovery-password");
  const submit = byId("account-recovery-submit");
  const back = byId("account-recovery-back");
  const restart = byId("account-recovery-restart");
  const message = byId("account-recovery-message");
  let active = null;
  const stillOpen = (attempt) => active === attempt && dialog.open && !dialog.hasAttribute("data-sheet-closing");

  function showVerification(value) {
    byId("account-recovery-verification").hidden = !value;
    email.readOnly = value;
    code.disabled = !value;
    code.readOnly = false;
    password.disabled = !value;
    restart.hidden = !value;
    submit.textContent = value ? "重置密码" : "发送验证码";
  }

  function setBusy(value) {
    submit.disabled = value;
    back.disabled = value;
    restart.disabled = value;
  }

  function endSession(attempt) {
    if (!attempt?.verified) return;
    attempt.verified = false;
    return attempt.auth.signOut({ scope: "local" }).catch(() => {});
  }

  function reset() {
    const previous = active;
    active = null;
    endSession(previous);
    form.reset();
    form.hidden = true;
    showVerification(false);
    setBusy(false);
    message.textContent = "";
    byId("account-heading").textContent = "同步学习进度";
  }

  function start(address) {
    reset();
    active = {
      auth: createClient(config.url, config.key, { auth: {
        storageKey: "xigai-password-recovery-v1", autoRefreshToken: false,
        persistSession: false, detectSessionInUrl: false,
      } }).auth,
      sentTo: "",
      verified: false,
    };
    email.value = address;
    loginForm.hidden = true;
    byId("account-heading").textContent = "重置密码";
    form.hidden = false;
    email.focus();
  }

  function leave(notice) {
    const address = email.value.trim();
    reset();
    restoreLogin(address, notice);
  }

  byId("account-forgot").onclick = () => {
    if (canStart()) start(byId("account-email-input").value.trim());
  };
  back.onclick = () => leave("");
  restart.onclick = () => start(email.value.trim());
  form.onsubmit = async (event) => {
    event.preventDefault();
    const attempt = active;
    if (!attempt || !stillOpen(attempt) || submit.disabled) return;
    const address = email.value.trim().toLowerCase();
    const newPassword = password.value;
    if (attempt.sentTo && (newPassword.length < 10 || new TextEncoder().encode(newPassword).length > 72)) {
      message.textContent = "请使用至少 10 个字符且不超过 72 字节的新密码。";
      return;
    }
    setBusy(true);
    message.textContent = attempt.sentTo ? "正在验证并重置…" : "正在发送验证码…";
    try {
      if (!attempt.sentTo) {
        const { error } = await attempt.auth.resetPasswordForEmail(address);
        if (!stillOpen(attempt)) return;
        if (error) {
          message.textContent = error.status === 429 ? "验证码发送过于频繁，请稍后再试。" : "暂时无法发送验证码，请稍后再试。";
          return;
        }
        attempt.sentTo = address;
        email.value = address;
        showVerification(true);
        code.focus();
        message.textContent = "如果此邮箱有账号，请查收验证码，也可检查垃圾邮件。";
        return;
      }
      if (!attempt.verified) {
        const { data, error } = await attempt.auth.verifyOtp({
          email: attempt.sentTo, token: code.value.trim(), type: "recovery",
        });
        attempt.verified = !error && Boolean(data?.session);
        if (!stillOpen(attempt)) {
          await endSession(attempt);
          return;
        }
        if (!attempt.verified) {
          message.textContent = error?.status === 429 ? "验证码尝试过于频繁，请稍后再试。" : "验证码无效或已过期，请核对或重新发送。";
          return;
        }
        code.readOnly = true;
      }
      const { error } = await attempt.auth.updateUser({ password: newPassword });
      if (!stillOpen(attempt)) return;
      if (error) {
        message.textContent = error.code === "same_password" || error.code === "weak_password"
          ? "请换一个不同且更难猜的新密码。"
          : "暂时无法更新密码。可以稍后重试，或重新获取验证码。";
        return;
      }
      leave("密码已重置，请用新密码登录。");
    } catch {
      if (stillOpen(attempt)) message.textContent = "连接失败，请稍后重试。";
    } finally {
      if (active === attempt) setBusy(false);
    }
  };
  return { reset };
}

function connect(callbacks) {
  if (!config?.url || !config?.key) return null;
  const client = createClient(config.url, config.key, {
    auth: { storageKey: "xigai-supabase-auth-v1", detectSessionInUrl: false },
  });
  let actor = null;
  let cache = null;
  let generation = 0;
  let scheduled;
  let busy = false;
  let enrolled = false;

  function persist() {
    if (!actor) return;
    try {
      localStorage.setItem(accountKey(actor.id), JSON.stringify(cache));
    } catch {
      accountLabel().textContent = "本机存储已满，待同步更改仅保留在当前页面";
    }
  }

  function giveState(reset) {
    const result = { history: {}, stars: {}, session: null };
    let latest = null;
    for (const row of Object.values(cache.records)) {
      if (row.kind === "history") result.history[row.record_key] = row.payload;
      if (row.kind === "star") result.stars[row.record_key] = row.payload;
      if (row.kind === "session" && row.payload && isNewer(row, latest)) latest = row;
    }
    result.session = latest?.payload || null;
    callbacks.receive(result, reset);
  }

  function queue(kind, record_key, payload) {
    if (!actor) return;
    const id = kind + ":" + record_key;
    const previous = cache.records[id];
    const revision = Math.max(Date.now(), (previous?.revision || 0) + 1);
    const row = { kind, record_key, revision, change_id: callbacks.randomId(), payload: structuredClone(payload) };
    cache.records[id] = row;
    cache.pending[id] = row;
    persist();
    schedule();
  }

  function schedule() {
    clearTimeout(scheduled);
    scheduled = setTimeout(refresh, 550);
  }

  async function refresh() {
    if (!actor || busy) return;
    busy = true;
    const epoch = generation;
    const profile = actor;
    const sameAccount = () => generation === epoch;
    try {
      if (!enrolled) {
        const membership = await client.from("quiz_members").select("account_id").eq("account_id", profile.id).maybeSingle();
        if (!sameAccount()) return;
        if (membership.error) throw membership.error;
        if (!membership.data) {
          accountLabel().textContent = "此账号尚未激活同步";
          return;
        }
        enrolled = true;
      }
      accountLabel().textContent = "同步中…";
      for (const batch of pendingBatches(Object.values(cache.pending))) {
        const response = await client.rpc("merge_account_quiz_state", { expected_account: profile.id, changes: batch });
        if (!sameAccount()) return;
        if (response.error) throw response.error;
        for (const sent of batch) {
          const tag = keyFor(sent);
          if (cache.pending[tag]?.change_id === sent.change_id) delete cache.pending[tag];
        }
        persist();
      }

      let changed = false;
      const size = 200;
      for (let from = 0; ; from += size) {
        const response = await client.from("quiz_state")
          .select("kind,record_key,revision,change_id,payload")
          .eq("account_id", profile.id).order("kind").order("record_key").range(from, from + size - 1);
        if (!sameAccount()) return;
        if (response.error) throw response.error;
        for (const row of response.data) {
          const tag = keyFor(row);
          if (isNewer(row, cache.records[tag])) {
            cache.records[tag] = row;
            changed = true;
          }
        }
        if (response.data.length < size) break;
      }
      persist();
      if (changed) giveState(false);
      accountLabel().textContent = Object.keys(cache.pending).length ? "有更改待同步" : "进度已同步";
    } catch {
      if (sameAccount()) accountLabel().textContent = "暂未联网同步 · 本机记录已保留";
    } finally {
      busy = false;
      if (!sameAccount() && actor) schedule();
    }
  }

  function switchAccount(user) {
    if (user?.id === actor?.id) return;
    generation += 1;
    actor = user || null;
    enrolled = false;
    callbacks.accountChanged?.(actor?.id ?? null);
    if (actor) {
      recovery?.reset();
      cache = readCache(actor.id);
      byId("account-button").textContent = "账号";
      byId("account-email").textContent = actor.email || "";
      byId("account-form").hidden = true;
      byId("account-active").hidden = false;
      giveState(true);
      schedule();
    } else {
      cache = null;
      byId("account-button").textContent = "登录";
      byId("account-form").hidden = false;
      byId("account-active").hidden = true;
      accountLabel().textContent = "";
      callbacks.guest();
    }
  }

  const dialog = byId("account-dialog");
  const sheet = window.QuizSheetMotion?.attach(dialog);
  const closeDialog = sheet ? sheet.close : () => dialog.close();
  const form = byId("account-form");
  const passwordInput = byId("account-password");
  const submitButton = byId("account-submit");
  const toggleButton = byId("account-toggle");
  const nativeUI = window.webkit?.messageHandlers?.quizNativeUI;
  let nativePending = false;
  let registering = false;
  const message = (value) => { byId("account-message").textContent = value; };

  function setRegistering(value) {
    registering = value;
    if (registering) passwordInput.minLength = 10;
    else passwordInput.removeAttribute("minlength");
    byId("account-password-label").textContent = registering ? "密码（至少 10 个字符）" : "密码";
    byId("account-register-hint").hidden = !registering;
    byId("account-forgot").hidden = registering || !recovery;
    submitButton.textContent = registering ? "创建并登录" : "登录";
    passwordInput.autocomplete = registering ? "new-password" : "current-password";
    toggleButton.textContent = registering ? "返回登录" : "注册账号";
    message("");
  }

  const recovery = config.passwordRecovery === true && !nativeUI ? attachRecovery(
    dialog, form, () => !actor && !submitButton.disabled,
    (address, notice) => {
      form.hidden = false;
      setRegistering(false);
      byId("account-email-input").value = address;
      passwordInput.value = "";
      passwordInput.focus();
      message(notice);
    },
  ) : null;
  byId("account-forgot").hidden = !recovery;

  byId("account-button").hidden = false;
  byId("account-button").onclick = async () => {
    message("");
    if (nativePending || dialog.open) return;
    if (nativeUI) {
      nativePending = true;
      try {
        await nativeUI.postMessage({ kind: "account", email: actor ? actor.email || "" : null });
        return;
      } catch {
        // The bundled form remains available if native presentation fails.
      } finally {
        nativePending = false;
      }
    }
    dialog.showModal();
  };
  byId("account-close").onclick = closeDialog;
  toggleButton.onclick = () => setRegistering(!registering);
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    recovery?.reset();
    form.hidden = Boolean(actor);
    form.reset();
    setRegistering(false);
  });
  byId("account-refresh").onclick = refresh;
  async function signOut() {
    // Scope is the current device. Other devices keep their own sessions.
    try {
      const response = await client.auth.signOut({ scope: "local" });
      if (!response.error) {
        switchAccount(null);
        return null;
      }
    } catch {
      // The user can try again when the network is available.
    }
    return "退出失败，请联网后重试";
  }

  async function authenticate(email, password, creatingAccount) {
    email = email.trim().toLowerCase();
    if (!email || !password) return { message: "请输入邮箱和密码。" };
    if (creatingAccount && password.length < 10) return { message: "密码至少需要 10 个字符。" };
    let registrationStatus = 0;
    try {
      if (creatingAccount) {
        const enrolled = await client.functions.invoke("quiz-register", { body: { email, password } });
        if (enrolled.error) {
          const response = enrolled.error.context;
          registrationStatus = response?.status || 0;
          if (registrationStatus !== 409 && registrationStatus !== 429) {
            const body = await response?.json?.().catch(() => null);
            return { message: body?.message || "注册未完成，请检查网络后重试。" };
          }
        }
      }
      const response = await client.auth.signInWithPassword({ email, password });
      if (response.error || !response.data.user) {
        if (response.error?.code === "invalid_credentials") {
          if (registrationStatus === 409) {
            return { message: "这个邮箱已注册。请用原来设置的密码登录。", switchToLogin: true };
          }
          if (registrationStatus === 429) {
            return { message: "注册请求过多。已有账号可直接登录，新用户请稍后再注册。", switchToLogin: true };
          }
          return { message: "邮箱或密码不正确，请核对后重试。" };
        }
        return { message: registrationStatus === 409 ? "这个邮箱已注册，暂时无法登录，请稍后重试。" : "暂时无法登录，请稍后重试。" };
      }
      switchAccount(response.data.user);
      return null;
    } catch {
      return { message: "连接失败，请稍后重试。" };
    }
  }

  if (nativeUI) {
    window.QuizNativeAccount = {
      async run(action, email, password) {
        if (action === "login" || action === "register") {
          const failure = await authenticate(email, password, action === "register");
          return failure?.message ?? null;
        }
        if (action === "logout") return signOut();
        if (action === "refresh") {
          await refresh();
          return accountLabel().textContent;
        }
        return "账号操作未完成，请重试。";
      },
    };
  }

  byId("account-logout").onclick = async () => {
    const error = await signOut();
    if (error) accountLabel().textContent = error;
    else closeDialog();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const creatingAccount = registering;
    const email = byId("account-email-input").value;
    const password = passwordInput.value;
    submitButton.disabled = true;
    toggleButton.disabled = true;
    message(creatingAccount ? "正在注册…" : "正在登录…");
    try {
      const failure = await authenticate(email, password, creatingAccount);
      if (failure?.switchToLogin) {
        setRegistering(false);
        passwordInput.value = "";
        passwordInput.focus();
      }
      if (failure) message(failure.message);
      else closeDialog();
    } finally {
      submitButton.disabled = false;
      toggleButton.disabled = false;
    }
  };

  client.auth.onAuthStateChange((_event, session) => {
    // Auth callbacks must not await another call on the same client.
    setTimeout(() => switchAccount(session?.user || null), 0);
  });
  addEventListener("online", refresh);
  addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  setInterval(() => {
    if (document.visibilityState === "visible") refresh();
  }, 45000);
  async function deskRpc(name, params) {
    if (!actor) return { error: { message: "pk_auth_required" } };
    const epoch = generation;
    const result = await client.rpc(name, params);
    return epoch === generation ? result : { error: { message: "pk_auth_required" } };
  }
  return { queue, deskRpc, enabled: () => Boolean(actor) };
}

function* pendingBatches(records) {
  const encoder = new TextEncoder();
  let batch = [];
  let bytes = 0;
  for (const record of records) {
    const size = encoder.encode(JSON.stringify(record)).byteLength + 5;
    if (batch.length && (bytes + size > 290000 || batch.length >= 50)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(record);
    bytes += size;
  }
  if (batch.length) yield batch;
}

window.QuizAccount = { connect };
