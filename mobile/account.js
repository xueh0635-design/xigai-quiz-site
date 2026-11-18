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
    if (actor) {
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
    submitButton.textContent = registering ? "创建并登录" : "登录";
    passwordInput.autocomplete = registering ? "new-password" : "current-password";
    toggleButton.textContent = registering ? "返回登录" : "注册账号";
    message("");
  }

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
    let existingAccount = false;
    try {
      if (creatingAccount) {
        const enrolled = await client.functions.invoke("quiz-register", { body: { email, password } });
        if (enrolled.error) {
          const response = enrolled.error.context;
          existingAccount = response?.status === 409;
          if (!existingAccount) {
            const body = await response?.json?.().catch(() => null);
            return { message: body?.message || "注册未完成，请检查网络后重试。" };
          }
        }
      }
      const response = await client.auth.signInWithPassword({ email, password });
      if (response.error || !response.data.user) {
        if (response.error?.code === "invalid_credentials") {
          return existingAccount
            ? { message: "这个邮箱已注册。请用原来设置的密码登录。", switchToLogin: true }
            : { message: "邮箱或密码不正确，请核对后重试。" };
        }
        return { message: existingAccount ? "这个邮箱已注册，暂时无法登录，请稍后重试。" : "暂时无法登录，请稍后重试。" };
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
  return { queue, enabled: () => Boolean(actor) };
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
