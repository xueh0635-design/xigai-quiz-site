import { createClient } from "@supabase/supabase-js";
import { createQuizStore, attemptPayload } from "./quiz-store.mjs";
import { mergeChapterTests, plainSession, stateFromCache } from "./study-state.mjs";

window.QuizPersistence = { createStore: createQuizStore, mergeChapterTests, plainSession, stateFromCache };

const config = window.QuizCloud;
const byId = (id) => document.getElementById(id);
const accountLabel = () => byId("account-label");
const accountKey = (id) => "xigai-account-v1:" + id;
const legacyKinds = new Set(["history", "star", "note", "session"]);
const wrongReviewDraft = (row) => row.kind === "draft" && row.payload?.wrongBookReview === true &&
  row.payload.sid === row.record_key && Array.isArray(row.payload.ids);

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
  return { reset, start };
}

function connect(callbacks) {
  if (!config?.url || !config?.key) return null;
  const client = createClient(config.url, config.key, {
    auth: { storageKey: "xigai-supabase-auth-v1", detectSessionInUrl: false },
  });
  let actor = null;
  let scopeReady = true;
  let cache = null;
  let store = null;
  let storeReady = Promise.resolve(null);
  let unsubscribe;
  let localWrites = Promise.resolve();
  const unsaved = new Map();
  let storageFailed = false;
  let generation = 0;
  let scheduled;
  let inFlight = null;
  let refreshAgain = false;
  let enrolled = false;

  function giveState(reset) {
    callbacks.receive(stateFromCache(cache), reset);
  }

  function queue(changes) {
    if (!actor || !scopeReady) return Promise.resolve(false);
    const epoch = generation;
    const accountId = actor.id;
    const ready = storeReady;
    const input = structuredClone(changes);
    const token = {};
    if (!unsaved.has(accountId)) unsaved.set(accountId, new Map());
    if (input.length) unsaved.get(accountId).set(token, input);
    const write = localWrites.catch(() => {}).then(async () => {
      const target = await ready;
      if (!target) return false;
      const buffer = unsaved.get(accountId);
      const entries = [...buffer.entries()];
      if (!entries.length) return target.durable;
      const progressChanges = entries.flatMap(([, values]) => values);
      const saved = await target.commit(progressChanges);
      for (const [key] of entries) buffer.delete(key);
      if (generation === epoch) {
        cache = saved;
        storageFailed = !target.durable;
        if (storageFailed) accountLabel().textContent = "本机未能持久保存，请保持页面打开并联网同步";
        schedule(progressChanges.some(([kind]) => kind === "history"));
      }
      return target.durable;
    }).catch(() => {
      if (generation === epoch) {
        storageFailed = true;
        accountLabel().textContent = "保存失败，本次更改尚未入库，请保持页面打开并重试";
      }
      return false;
    });
    localWrites = write;
    return write;
  }

  function schedule(immediate = false) {
    if (inFlight) {
      refreshAgain = true;
      return;
    }
    clearTimeout(scheduled);
    if (immediate) refresh();
    else scheduled = setTimeout(refresh, 550);
  }

  function refresh() {
    clearTimeout(scheduled);
    if (!actor) return;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        do {
          refreshAgain = false;
          await refreshOnce();
        } while (actor && refreshAgain);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function refreshOnce() {
    const epoch = generation;
    const profile = actor;
    const sameAccount = () => generation === epoch;
    try {
      if (unsaved.get(profile.id)?.size) await queue([]);
      await localWrites;
      const target = await storeReady;
      if (!sameAccount() || !target) return;
      cache = await target.read();
      if (!sameAccount()) return;
      accountLabel().textContent = "同步中…";
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
      if (Date.now() >= cache.v2RetryAt) {
        try {
          await refreshV2(target, sameAccount, profile.id);
          return;
        } catch (error) {
          if (!sameAccount()) return;
          if (error?.message === "quiz_cursor_ahead") {
            cache = await target.accept({ resetCursor: true });
            await refreshV2(target, sameAccount, profile.id);
            return;
          }
          if (error?.code !== "PGRST202" && error?.code !== "42883") throw error;
          cache = await target.accept({ v2RetryAt: Date.now() + 5 * 60 * 1000 });
        }
      }
      let uploadFailed = false;
      try {
        const pending = Object.values(cache.pending);
        const general = pendingBatches(pending.filter((row) => legacyKinds.has(row.kind)));
        const reviews = pendingBatches(pending.filter(wrongReviewDraft));
        for (const batch of [...general, ...reviews]) {
          const response = await client.rpc("merge_account_quiz_state", { expected_account: profile.id, changes: batch });
          if (!sameAccount()) return;
          if (response.error) throw response.error;
          cache = await target.accept({ ackChanges: batch.map((row) => row.change_id) });
          if (!sameAccount()) return;
          if (batch.some(({ kind }) => kind === "history" || kind === "session")) callbacks.progressUploaded?.();
        }
      } catch {
        if (!sameAccount()) return;
        uploadFailed = true;
      }

      // Apply only after all pages arrive, so a retry can still notify the view
      // when new rows were returned on a page before the failure.
      const rows = [];
      const size = 200;
      for (let from = 0; ; from += size) {
        const response = await client.from("quiz_state")
          .select("kind,record_key,revision,change_id,payload")
          .eq("account_id", profile.id).order("kind").order("record_key").range(from, from + size - 1);
        if (!sameAccount()) return;
        if (response.error) throw response.error;
        rows.push(...response.data);
        if (response.data.length < size) break;
      }
      cache = await target.accept({ rows });
      if (!sameAccount()) return;
      giveState(false);
      const pendingEvents = await target.pendingAttempts();
      accountLabel().textContent = !target.durable || storageFailed ? "云端连接已恢复 · 本机保存不可用，请保持页面打开"
        : uploadFailed || Object.values(cache.pending).some((row) => legacyKinds.has(row.kind) || wrongReviewDraft(row))
          ? "已读取云端记录 · 本机更改待上传"
        : pendingEvents.length || Object.keys(cache.pending).length
          ? "进度已同步 · 新版学习记录已保存在本机，等待服务升级"
          : "进度已同步";
    } catch (error) {
      if (sameAccount()) accountLabel().textContent = storageFailed || !scopeReady || unsaved.get(profile.id)?.size
        ? "同步未完成，本机仍有未保存更改，请保持页面打开并重试"
        : error?.message === "quiz_catalog_unavailable" ? "题库版本等待云端升级 · 本机作答已保留"
        : "未能读取云端记录 · 本机记录已保留";
    }
  }

  async function refreshV2(target, sameAccount, accountId) {
    const pending = Object.values(cache.pending);
    const events = await target.pendingAttempts();
    const changes = [...pendingBatches(pending)];
    const attempts = [...pendingBatches(events.map(attemptPayload))];
    let page = 0;
    let more = true;
    while (more || page < changes.length || page < attempts.length) {
      const requestCursor = cache.cursor;
      const request = client.rpc("quiz_sync_v2", {
        expected_account: accountId, changes: changes[page] || [], attempts: attempts[page] || [],
        cursor: requestCursor, page_size: 200,
      });
      const response = await (typeof request.abortSignal === "function"
        ? request.abortSignal(AbortSignal.timeout(15000)) : request);
      if (!sameAccount()) return;
      if (response.error) throw response.error;
      const data = response.data;
      if (data?.version !== 2 || !Array.isArray(data.rows) || !Array.isArray(data.attemptRows) ||
          !Array.isArray(data.ack?.changes) || !Array.isArray(data.ack?.attempts) ||
          !Number.isSafeInteger(data.next_cursor) || data.next_cursor < requestCursor || typeof data.has_more !== "boolean" ||
          (data.has_more && data.next_cursor <= requestCursor)) throw new Error("invalid_sync_response");
      cache = await target.accept({ rows: data.rows, attempts: data.attemptRows,
        ackChanges: data.ack.changes, ackAttempts: data.ack.attempts, cursor: data.next_cursor, v2RetryAt: 0 });
      if (!sameAccount()) return;
      if (data.ack.attempts.length ||
          changes[page]?.some(({ kind }) => kind === "history" || kind === "session")) callbacks.progressUploaded?.();
      more = data.has_more;
      page++;
    }
    giveState(false);
    const remaining = (await target.pendingAttempts()).length + Object.keys(cache.pending).length;
    accountLabel().textContent = unsaved.get(accountId)?.size ? "有更改尚未保存和上传，请保持页面打开并重试"
      : !target.durable || storageFailed ? "云端已同步 · 本机保存不可用，请保持页面打开"
      : remaining ? "有更改待同步" : "进度已同步";
  }

  async function switchAccount(user) {
    if (user?.id === actor?.id) return storeReady;
    generation += 1;
    const epoch = generation;
    scopeReady = false;
    unsubscribe?.();
    unsubscribe = null;
    const previousStore = store;
    if (previousStore) localWrites.finally(() => previousStore.close());
    actor = user || null;
    enrolled = false;
    storageFailed = false;
    callbacks.accountChanged?.(actor?.id ?? null);
    if (actor) {
      recovery?.reset();
      const accountId = actor.id;
      byId("account-button").textContent = "账号";
      byId("account-email").textContent = actor.email || "";
      byId("account-form").hidden = true;
      byId("account-active").hidden = false;
      accountLabel().textContent = "等待同步…";
      storeReady = createQuizStore({ scope: "account:" + accountId, legacyKey: accountKey(accountId),
        randomId: callbacks.randomId }).then(async (next) => {
        if (epoch !== generation) return next;
        store = next;
        cache = await next.read();
        if (epoch !== generation) return next;
        giveState(true);
        scopeReady = true;
        storageFailed = !next.durable;
        if (storageFailed) accountLabel().textContent = "本机保存不可用，请联网后继续";
        unsubscribe = next.subscribe(async () => {
          try {
            await localWrites;
            const value = await next.read();
            if (epoch === generation) { cache = value; giveState(false); }
          } catch {
            if (epoch === generation) accountLabel().textContent = "本机记录读取失败，请保持页面打开并重试";
          }
        });
        schedule();
        return next;
      });
      return storeReady;
    } else {
      cache = null;
      store = null;
      byId("account-button").textContent = "登录";
      byId("account-form").hidden = false;
      byId("account-active").hidden = true;
      accountLabel().textContent = "";
      storeReady = Promise.resolve(callbacks.guest()).then(() => {
        if (epoch === generation) scopeReady = true;
        return null;
      });
      await storeReady;
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

  const recovery = config.passwordRecovery === true ? attachRecovery(
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
    if (actor) refresh();
    if (nativeUI) {
      nativePending = true;
      try {
        let capabilityTimer;
        const capabilities = await Promise.race([
          nativeUI.postMessage({ kind: "capabilities" }),
          new Promise((_, reject) => { capabilityTimer = setTimeout(() => reject(new Error("native_capabilities_timeout")), 1500); }),
        ]).finally(() => clearTimeout(capabilityTimer));
        if (capabilities?.schemaVersion !== 1 || capabilities.account !== true ||
            (recovery && capabilities.passwordRecovery !== true)) throw new Error("native_capabilities_unsupported");
        const result = await nativeUI.postMessage({
          kind: "account", email: actor ? actor.email || "" : null, recovery: Boolean(recovery),
        });
        if (recovery && !actor && typeof result?.recoveryEmail === "string") {
          dialog.showModal();
          recovery.start(result.recoveryEmail);
        }
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
        await switchAccount(null);
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
      await switchAccount(response.data.user);
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
    setTimeout(() => switchAccount(session?.user || null).catch(() => {
      accountLabel().textContent = "本机记录未能打开，请保持页面打开并重试";
    }), 0);
  });
  addEventListener("online", refresh);
  addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  setInterval(() => {
    if (document.visibilityState === "visible") refresh();
  }, 15000);
  async function deskRpc(name, params) {
    if (!actor) return { error: { message: "pk_auth_required" } };
    const epoch = generation;
    const result = await client.rpc(name, params);
    return epoch === generation ? result : { error: { message: "pk_auth_required" } };
  }
  function deskProgressSubscribe(listener) {
    if (!actor) return null;
    const epoch = generation;
    let listening = true;
    const notify = () => { if (listening && epoch === generation) listener(); };
    const channel = client.channel("quiz-desk-progress-" + randomId());
    channel.on("postgres_changes", {
      event: "*", schema: "public", table: "quiz_desk_progress_ticks",
    }, notify);
    channel.subscribe((status) => { if (status === "SUBSCRIBED") notify(); });
    return () => {
      listening = false;
      client.removeChannel(channel).catch(() => {});
    };
  }
  function arenaSubscribe(pairId, listener) {
    if (!actor) return null;
    const epoch = generation;
    const channel = client.channel("quiz-arena-" + randomId());
    channel.on("postgres_changes", {
      event: "*", schema: "public", table: "quiz_arena_ticks", filter: `pair_id=eq.${pairId}`,
    }, () => { if (epoch === generation) listener(); });
    channel.subscribe();
    return () => { client.removeChannel(channel).catch(() => {}); };
  }
  async function deskAvatar(action, input) {
    const user = actor;
    if (!user) return { error: { message: "pk_auth_required" } };
    const epoch = generation;
    const images = client.storage.from("quiz-pk-avatars");
    const path = user.id + ".jpg";
    const operations = {
      download: () => images.download(input.path, { cacheNonce: input.revision }, { cache: "no-store" }),
      save: () => images.upload(path, input, { upsert: true, contentType: "image/jpeg", cacheControl: "0" }),
      remove: () => images.remove([path]),
    };
    const result = await operations[action]();
    return epoch === generation ? result : { error: { message: "pk_auth_required" } };
  }
  async function tutor(method, body, signal) {
    if (!actor) return { code: "sign_in" };
    const epoch = generation;
    // Older Android WebViews provide AbortController without AbortSignal.timeout().
    const controller = signal ? null : new AbortController();
    const timeout = controller && setTimeout(() => controller.abort(), 8000);
    try {
      const { data, error } = await client.functions.invoke("quiz-tutor", {
        method, ...(body ? { body } : {}), signal: signal || controller.signal,
      });
      if (epoch !== generation) return { code: "sign_in" };
      if (!error) return { data };
      if (error.context instanceof Response) {
        const result = await error.context.json().catch(() => null);
        return { code: result?.code || (error.context.status === 401 ? "sign_in" : "unavailable") };
      }
    } catch {
      return { code: "unavailable" };
    } finally {
      if (controller) clearTimeout(timeout);
    }
    return { code: "unavailable" };
  }

  async function development(action, payload) {
    if (!actor) return null;
    const epoch = generation;
    const { data, error } = await client.rpc("quiz_development_client", { action, payload })
      .abortSignal(AbortSignal.timeout(10000));
    return !error && epoch === generation ? data : null;
  }

  return { queue, flush: () => localWrites, deskRpc, deskAvatar, deskProgressSubscribe, arenaSubscribe, tutor, development, enabled: () => Boolean(actor) };
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
