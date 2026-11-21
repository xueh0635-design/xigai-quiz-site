(() => {
  "use strict";

  const get = (key) => document.getElementById("live-" + key);
  const terminal = (phase) => ["complete", "ended", "expired"].includes(phase);
  const errors = {
    live_room_unavailable: "这间学习室已结束，请回到一起学页刷新。",
    live_pair_required: "当前账号暂无同桌。",
    live_not_ready: "这一题的状态刚刚变了，正在同步。",
    live_invalid_picks: "请核对所选答案后重新提交。",
    live_chapter_unavailable: "这个范围暂时无法组题，请换一章。",
    pk_auth_required: "请重新登录后再进入学习室。",
    pk_membership_required: "这个账号尚未启用同步。",
  };

  function element(tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function connect({ questions, chapters, rpc, onLobby }) {
    const lobby = get("lobby");
    if (!lobby) return null;
    const desk = document.getElementById("desk");
    const chapter = get("chapter");
    for (const name of chapters) {
      const option = element("option", name);
      option.value = name;
      chapter.append(option);
    }
    let account = null;
    let paired = false;
    let visible = false;
    let inRoom = false;
    let snapshot = null;
    let pending = null;
    let writing = false;
    let blocked = false;
    let message = "";
    let pollAt = 0;
    let questionKey = "";
    let summaryKey = "";
    let revealedKey = "";
    let options = [];
    let selected = [];
    let confirmLeave = false;

    function put(key, value) {
      const target = get(key);
      if (target.textContent !== value) target.textContent = value;
    }

    function online(key, value, copy) {
      const status = get(key);
      status.dataset.online = String(Boolean(value));
      put(key, copy);
    }

    function lobbyCopy(room) {
      if (!snapshot) return blocked ? "学习室暂时连不上，正在尝试重连。" : "正在连接一起学…";
      if (!snapshot.paired) return "同桌暂不可用，请刷新后重试。";
      if (!room) return "";
      if (room.phase === "waiting") return room.isHost ? "已邀请同桌，等对方加入。" : `同桌邀请你共学 · ${room.chapter || "综合题库"}`;
      if (room.phase === "complete") return "上一轮已完成，可以再开一轮。";
      if (terminal(room.phase)) return "上一轮已结束，可以重新开桌。";
      return "这一轮还在，随时回到刚才的题。";
    }

    function renderLobby() {
      const room = snapshot?.room;
      const canOpen = Boolean(snapshot?.paired && (!room || terminal(room.phase)));
      const canJoin = Boolean(room?.phase === "waiting" && !room.joined && !room.isHost);
      const canResume = Boolean(room && !terminal(room.phase) && (room.joined || room.isHost));
      get("start").hidden = Boolean(room && !terminal(room.phase));
      get("start").disabled = writing || !canOpen;
      chapter.closest(".picker-field").hidden = Boolean(room && !terminal(room.phase));
      get("join").hidden = !canJoin;
      get("resume").hidden = !canResume;
      get("join").disabled = writing;
      get("resume").disabled = writing;
      put("lobby-status", message || lobbyCopy(room));
      online("local-presence", snapshot && !blocked, snapshot && !blocked ? "在线" : "连接中");
      const connected = snapshot?.partnerOnline && !blocked;
      online("presence", connected, connected ? "在线" : snapshot && !blocked ? "暂不在线" : "等待连接");
    }

    function showAnswers(item, room) {
      const correct = room.correctPicks || item.answer;
      const answer = correct.map((letter) => item.options[letter] || letter);
      put("correct-answer", answer.join("、"));
      const mine = room.myPicks?.slice().sort().join("、") || "—";
      const other = room.partnerPicks?.slice().sort().join("、") || "—";
      const same = mine === other;
      put("choice-comparison", `我选 ${mine} · 同桌选 ${other}。${same ? "想法一致。" : "可以一起找出两种选法的区别。"}`);
      put("review", item.study?.explanation || "");
      get("review").hidden = !item.study?.explanation;
      put("memory", item.study?.memory || "");
      get("memory").hidden = !item.study?.memory;
    }

    function renderQuestion(item, room) {
      const key = room.id + ":" + item.id;
      if (key !== questionKey) {
        questionKey = key;
        selected = [];
        put("kind", item.type + "题");
        put("stem", item.stem);
        options = Object.entries(item.options).map(([letter, value]) => {
          const button = element("button", "", "option");
          button.type = "button";
          button.dataset.answer = letter;
          button.append(element("span", letter, "letter"), element("span", value));
          button.onclick = () => {
            const current = snapshot?.room;
            if (writing || current?.questionId !== item.id || current.phase !== "answering" || current.myPicks) return;
            if (item.type === "多选") {
              selected = selected.includes(letter) ? selected.filter((choice) => choice !== letter) : [...selected, letter];
            } else {
              selected = [letter];
            }
            render();
          };
          return button;
        });
        get("options").replaceChildren(...options);
      }
      const submitted = Boolean(room.myPicks);
      const reveal = room.phase === "reveal";
      const picks = room.myPicks || selected;
      for (const button of options) {
        const letter = button.dataset.answer;
        const picked = picks.includes(letter);
        const correct = reveal && (room.correctPicks || item.answer).includes(letter);
        button.disabled = writing || submitted || reveal;
        button.setAttribute("aria-pressed", String(picked));
        button.classList.toggle("correct", correct);
        button.classList.toggle("incorrect", reveal && picked && !correct);
      }
      get("submit").hidden = reveal || submitted;
      get("submit").disabled = writing || !selected.length;
      get("reveal").hidden = !reveal;
      get("next").hidden = !reveal;
      get("next").disabled = writing || Boolean(room.myReady);
      if (reveal) {
        showAnswers(item, room);
        put("next", room.myReady ? "等同桌准备" : room.index === room.total ? "准备好看总结" : "我准备好了");
        if (visible && revealedKey !== key) {
          revealedKey = key;
          requestAnimationFrame(() => {
            if (visible && inRoom && questionKey === key && snapshot?.room?.phase === "reveal") {
              get("reveal").scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
            }
          });
        }
      }
    }

    function renderSummary(room) {
      const key = room.id + ":" + room.phase;
      if (key === summaryKey) return;
      summaryKey = key;
      const summary = room.summary;
      put("summary-heading", room.phase === "complete" ? "一起学完了" : "这轮一起学已结束");
      put("summary-detail", summary
        ? `共同答对 ${summary.bothCorrect} / ${room.total} 道。你答对 ${summary.myCorrect} 道，同桌答对 ${summary.partnerCorrect} 道。`
        : "回到一起学页，可以重新开一轮。");
      const missed = (summary?.review || []).filter((row) => !row.myCorrect || !row.partnerCorrect).map((row) => {
        const item = questions.get(row.questionId);
        if (!item) return null;
        const card = document.createElement("article");
        card.append(element("h4", item.stem));
        if (item.study?.explanation) card.append(element("p", item.study.explanation));
        return card;
      }).filter(Boolean);
      get("summary-review").replaceChildren(...missed);
    }

    function roomCopy(room, item) {
      if (room.phase === "waiting") return "等同桌加入，你们就会一起看到第一题。";
      if (terminal(room.phase)) return "";
      if (!item) return "这道题在当前版本不可用，请更新题库后再来。";
      if (room.phase === "reveal") {
        if (room.myReady) return "你的确认已同步。";
        return "看完解析后点准备好，两人都确认就能继续。";
      }
      if (room.myPicks) return "你的答案已锁定。等同桌提交后一起揭晓。";
      return room.partnerSubmitted ? "同桌已提交，轮到你锁定答案。" : "先各自作答，交卷后再看彼此的选项。";
    }

    function renderRoom() {
      const room = snapshot?.room;
      if (!inRoom || !room) return;
      const item = questions.get(room.questionId);
      const done = terminal(room.phase);
      const canAnswer = Boolean(item && (room.phase === "answering" || room.phase === "reveal"));
      put("room-title", room.chapter || "综合一起学");
      put("round-counter", room.phase === "complete" ? "本轮完成" : done ? "本轮结束" : `${room.index} / ${room.total}`);
      const progress = get("progress");
      progress.max = room.total;
      progress.value = room.phase === "complete" ? room.total : Math.max(0, room.index - 1 + (room.phase === "reveal" ? 1 : 0));
      get("leave").hidden = done || confirmLeave;
      get("leave-confirm").hidden = done || !confirmLeave;
      get("leave-yes").disabled = writing;
      get("leave-cancel").disabled = writing;
      get("back").disabled = writing;
      get("question").hidden = !canAnswer;
      get("submit").hidden = !canAnswer;
      get("next").hidden = !canAnswer;
      get("reveal").hidden = !canAnswer;
      get("summary").hidden = !done;
      online("me-status", true, room.myReady ? "我已准备" : room.myPicks ? "我已提交" : "我在场");
      const partnerStatus = room.partnerReady ? "同桌已准备" : room.partnerSubmitted ? "同桌已提交" : snapshot.partnerOnline ? "同桌在场" : "等同桌入座";
      online("peer-status", snapshot.partnerOnline, partnerStatus);
      put("room-status", message || roomCopy(room, item));
      if (canAnswer) renderQuestion(item, room);
      if (done) renderSummary(room);
    }

    function render() {
      desk.toggleAttribute("data-live-active", Boolean(inRoom && snapshot?.room));
      get("room").hidden = !inRoom || !snapshot?.room;
      renderLobby();
      renderRoom();
    }

    async function send(action, args, { quiet = false, enter = false } = {}) {
      if (!visible || !paired || !account || writing || (quiet && pending)) return;
      const token = {};
      pending = token;
      writing = !quiet;
      if (!quiet) message = "正在同步…";
      pollAt = Date.now() + (inRoom ? 2000 : 5000);
      render();
      try {
        const { error, data } = await rpc("quiz_live_" + action, args);
        if (pending !== token) return;
        if (error) throw error;
        if (!data || typeof data.paired !== "boolean") throw new Error("live_bad_response");
        snapshot = data;
        blocked = false;
        message = "";
        if (!data.room || !data.paired) inRoom = false;
        else if (enter) showRoom();
        else if (action === "leave") {
          confirmLeave = false;
          backToLobby();
        }
      } catch (error) {
        if (pending !== token) return;
        if (quiet) {
          blocked = true;
          pollAt = Date.now() + 5000;
          if (inRoom) message = "连接短暂中断，正在重连。";
        } else {
          message = errors[error.message] || "同步失败，请稍后再试。";
        }
      } finally {
        if (pending === token) {
          pending = null;
          writing = false;
          render();
        }
      }
    }

    function sync(force = false) {
      if (!document.hidden && (force || Date.now() >= pollAt)) return send("state", undefined, { quiet: true });
    }

    function showRoom() {
      if (!snapshot?.room) return;
      inRoom = true;
      confirmLeave = false;
      message = "";
      pollAt = Date.now() + 2000;
      render();
      if (visible) {
        window.scrollTo(0, 0);
        get("room-title").focus({ preventScroll: true });
      }
    }

    function backToLobby() {
      inRoom = false;
      confirmLeave = false;
      message = "";
      render();
      if (visible) window.scrollTo(0, 0);
      if (visible) onLobby?.();
    }

    get("start").onclick = () => send("start", { chapter: chapter.value || null }, { enter: true });
    get("resume").onclick = () => { showRoom(); sync(true); };
    get("join").onclick = () => send("join", { room_id: snapshot.room.id }, { enter: true });
    get("back").onclick = backToLobby;
    get("finish").onclick = backToLobby;
    get("submit").onclick = () => {
      const room = snapshot?.room;
      if (room && selected.length) send("answer", { room_id: room.id, question_id: room.questionId, picks: selected });
    };
    get("next").onclick = () => {
      const room = snapshot?.room;
      if (room) send("next", { room_id: room.id, question_id: room.questionId });
    };
    get("leave").onclick = () => {
      confirmLeave = true;
      render();
      get("leave-cancel").focus();
    };
    get("leave-cancel").onclick = () => {
      confirmLeave = false;
      render();
      get("leave").focus();
    };
    get("leave-yes").onclick = () => send("leave", { room_id: snapshot.room.id });

    setInterval(sync, 1000);
    document.addEventListener("visibilitychange", () => sync(true));
    window.addEventListener("online", () => sync(true));

    return {
      setContext(nextAccount, nextPaired, nextVisible) {
        const identityChanged = account !== nextAccount || paired !== nextPaired;
        const entering = !visible && nextVisible;
        account = nextAccount;
        paired = nextPaired;
        visible = nextVisible;
        if (identityChanged) {
          snapshot = null;
          pending = null;
          writing = false;
          blocked = false;
          message = "";
          questionKey = "";
          summaryKey = "";
          revealedKey = "";
          inRoom = false;
          confirmLeave = false;
          chapter.value = "";
          chapter.dispatchEvent(new Event("change", { bubbles: true }));
          render();
        }
        if (visible && (entering || identityChanged)) sync(true);
      },
    };
  }

  window.QuizLive = { connect };
})();
