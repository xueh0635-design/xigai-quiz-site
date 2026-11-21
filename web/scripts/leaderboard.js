(() => {
  "use strict";

  const get = (id) => document.getElementById("leaderboard-" + id);
  const number = new Intl.NumberFormat("zh-CN");

  function node(tag, value, className) {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    return element;
  }

  function boardRow(entry) {
    const row = document.createElement("li");
    row.dataset.rank = entry.rank;
    row.toggleAttribute("data-me", entry.isMe);
    row.append(
      node("span", String(entry.rank), "leaderboard-place"),
      node("span", entry.nickname + (entry.isMe ? "（我）" : ""), "leaderboard-name"),
      node("strong", `${number.format(entry.answered)} 道`, "leaderboard-count")
    );
    return row;
  }

  function connect({ signedIn, rpc, login }) {
    const dialog = get("dialog");
    if (!dialog) return null;
    const sheet = window.QuizSheetMotion?.attach(dialog);
    const editor = get("editor");
    const nickname = get("nickname");
    let board = null;
    let pending = null;

    function render() {
      get("data").hidden = !board;
      get("self").hidden = !board;
      if (!board) return;
      const [year, month, day] = board.day.split("-").map(Number);
      get("day").dateTime = board.day;
      get("day").textContent = `${year}年${month}月${day}日`;
      const answered = board.entries.reduce((total, entry) => total + entry.answered, 0);
      get("total").textContent = `${board.entries.length} 人上榜 · 共答 ${number.format(answered)} 道`;
      get("empty").hidden = Boolean(board.entries.length);
      const top = board.entries.slice(0, 3);
      get("top").hidden = !top.length;
      get("top").style.setProperty("--podium-count", String(top.length || 1));
      get("top").replaceChildren(...top.map(boardRow));
      get("rows").replaceChildren(...board.entries.slice(3).map(boardRow));
      const me = board.me;
      get("self-rank").textContent = me.rank ? `我的名次 · 第 ${me.rank} 名`
        : me.joined ? "我的名次 · 今日未上榜" : "我还未加入榜单";
      get("self-count").textContent = `今日已答 ${number.format(me.answered)} 道`;
      get("edit").textContent = me.joined ? "编辑昵称" : "加入榜单";
    }

    function busy(value) {
      for (const id of ["refresh", "retry", "leave", "save"]) get(id).disabled = value;
    }

    async function request(update) {
      if (!dialog.open || !signedIn() || (pending && (!update || pending.update))) return;
      const token = { update };
      pending = token;
      busy(true);
      get("retry").hidden = true;
      get("status").textContent = update ? "正在保存…" : board ? "" : "正在加载今日榜单…";
      try {
        const { data, error } = await rpc(update ? "quiz_leaderboard_set_nickname" : "quiz_leaderboard_today", update);
        if (pending !== token || !dialog.open) return;
        if (error || !data?.me || !Array.isArray(data.entries) || typeof data.day !== "string") {
          throw error || new Error("board_unavailable");
        }
        board = data;
        if (update) editor.hidden = true;
        render();
        get("status").textContent = "";
        if (update) get("edit").focus({ preventScroll: true });
      } catch (error) {
        if (pending !== token || !dialog.open) return;
        get("status").textContent = error?.message === "leaderboard_invalid_nickname" ? "昵称请使用 16 个字以内的可见字符。"
          : error?.message === "pk_membership_required" ? "该账号尚未开通学习同步。"
          : update ? "保存失败，请重试。" : "暂时无法加载榜单。";
        get("retry").hidden = Boolean(board);
      } finally {
        if (pending === token) {
          pending = null;
          busy(false);
        }
      }
    }

    function reset() {
      board = null;
      pending = null;
      editor.hidden = true;
      nickname.value = "";
      get("guest").hidden = true;
      get("retry").hidden = true;
      get("status").textContent = "";
      get("top").replaceChildren();
      get("rows").replaceChildren();
      busy(false);
      render();
    }

    for (const button of document.querySelectorAll("[data-open-leaderboard]")) {
      button.onclick = () => {
        if (dialog.open) return;
        reset();
        button.focus({ preventScroll: true });
        dialog.showModal();
        get("scroll").scrollTop = 0;
        get("guest").hidden = signedIn();
        request();
      };
    }
    get("close").onclick = () => sheet ? sheet.close() : dialog.close();
    get("login").onclick = () => {
      dialog.close();
      login();
    };
    get("refresh").onclick = get("retry").onclick = () => request();
    get("edit").onclick = () => {
      if (!board) return;
      nickname.value = board.me.nickname || "";
      get("save").textContent = board.me.joined ? "保存昵称" : "加入榜单";
      get("leave").hidden = !board.me.joined;
      editor.hidden = false;
      editor.scrollIntoView({ block: "nearest" });
      nickname.focus({ preventScroll: true });
    };
    get("cancel").onclick = () => {
      editor.hidden = true;
      get("edit").focus({ preventScroll: true });
    };
    editor.onsubmit = (event) => {
      event.preventDefault();
      const label = nickname.value.trim();
      if ([...label].length > 16) {
        get("status").textContent = "昵称最多 16 个字。";
        return;
      }
      request({ nickname: label });
    };
    get("leave").onclick = () => request({ nickname: null });
    dialog.addEventListener("close", () => { if (!dialog.open) reset(); });
    const refresh = () => {
      if (!document.hidden && editor.hidden) request();
    };
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    setInterval(refresh, 20000);

    return {
      accountChanged() {
        if (dialog.open) dialog.close();
        reset();
      },
    };
  }

  window.QuizLeaderboard = { connect };
})();
