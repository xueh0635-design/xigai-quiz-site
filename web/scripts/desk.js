(() => {
  "use strict";

  const byId = (id) => document.getElementById("desk-" + id);
  const errors = {
    pk_auth_required: "请重新登录后再试。",
    pk_membership_required: "账号尚未开通进度同步。请重新登录后再试。",
  };
  const resultLabels = { win: "我赢了", loss: "同桌赢了", tie: "平局" };
  const statusLabels = { expired: "已结束", open: "待结算" };
  const date = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const score = (entry, submitted) => entry ? `${entry.correct} / ${entry.total}` : submitted ? "已提交" : "未提交";
  const title = (game) => `${game.chapter || "综合"} · ${game.questionIds.length} 题`;
  const text = (id, value) => { byId(id).textContent = value; };
  const missedIds = (game) => game?.own?.paper?.missedIds ?? game?.own?.missedIds;
  const canReview = (game) => Boolean(game?.questionIds?.length && Array.isArray(missedIds(game)));

  function tag(element, content, className) {
    const node = document.createElement(element);
    node.textContent = content;
    if (className) node.className = className;
    return node;
  }

  function connect({ byId: questions, chapters, rpc, subscribeProgress, subscribeArena, avatar, login, openOwnHistory }) {
    if (!document.getElementById("desk")) return null;
    const comparison = byId("progress-comparison");
    const detailDialog = byId("progress-dialog");
    const paired = byId("paired");
    let account = null;
    let dashboard = null;
    let active = false;
    let activeRequest = null;
    let dashboardDirty = false;
    let progressTimer = null;
    let stopProgress = null;
    let actionInProgress = false;
    let renderedDashboard = null;
    let selectedPaper = null;
    let renderedPaper = "";
    let renderedArchive = "";
    const progress = window.QuizDeskProgress?.connect({ questions, rpc, openOwnHistory });
    const avatars = window.QuizDeskAvatar?.connect({
      run: avatar,
      saved: () => requestDashboard({ silent: true }),
    });
    const social = window.QuizSocial?.connect({ rpc });
    const live = window.QuizLive?.connect({ questions, chapters, rpc, onLobby: () => social?.refresh() });
    const arena = window.QuizArena?.connect({ questions, chapters, rpc, subscribe: subscribeArena });

    function setStatus(value) {
      text("status", value);
    }

    function setBusy() {
      document.getElementById("desk").setAttribute("aria-busy", String(Boolean(actionInProgress)));
      byId("refresh").disabled = actionInProgress;
    }

    function renderStats(kind, stats, total) {
      const completion = total > 0 ? Math.round(1000 * stats.answered / total) / 10 : 0;
      text(kind + "-answered", `${stats.answered} / ${total}`);
      text(kind + "-accuracy", stats.answered ? `${stats.accuracy}%` : "—");
      text(kind + "-completion", `${completion}%`);
      text(kind + "-today", `${stats.today} 道`);
      byId(kind + "-bar").value = completion;
    }

    function clearStats() {
      for (const kind of ["mine", "peer"]) {
        for (const stat of ["answered", "accuracy", "completion", "today"]) text(kind + "-" + stat, "—");
        byId(kind + "-bar").value = 0;
      }
    }

    function renderReview(game) {
      const panel = byId("duel-review-panel");
      const contents = byId("duel-review");
      const paper = game?.own?.paper;
      const available = canReview(game);
      panel.hidden = !available;
      const key = available ? game.id + ":" + game.status + ":" + Boolean(paper?.picks) : "";
      if (key !== renderedPaper) {
        renderedPaper = key;
        contents.replaceChildren();
        panel.querySelector("summary").textContent = available ? `回看我的试卷 · ${title(game)}` : "回看我的试卷";
      }
      if (!available) {
        panel.open = false;
        return;
      }
      if (contents.childElementCount) return;
      const missedQuestions = new Set(missedIds(game));
      const answersVisible = ["complete", "expired"].includes(game.status);
      if (!answersVisible) contents.append(tag("p", "已交卷，可以查看自己的对错。"));
      const choiceText = (answers, item) => answers.map((letter) => `${letter}. ${item.options?.[letter] || letter}`).join("；");
      for (const [index, id] of game.questionIds.entries()) {
        const item = questions.get(id);
        const card = document.createElement("article");
        card.className = "duel-paper-item";
        const wrong = missedQuestions.has(id);
        card.dataset.outcome = wrong ? "wrong" : "right";
        card.append(tag("b", wrong ? "答错" : "答对", "duel-paper-verdict"),
          tag("h4", `${index + 1}. ${item?.stem || "请更新题库后查看题干"}`));
        if (item) {
          const selected = paper?.picks?.[id];
          if (Array.isArray(selected)) card.append(tag("p", "我的选择　" + (choiceText(selected, item) || "跳过")));
          if (answersVisible) {
            card.append(tag("p", "正确答案　" + choiceText(item.answer, item)));
            if (item.study?.explanation) card.append(tag("p", item.study.explanation));
            if (item.study?.memory) card.append(tag("p", "记忆提示　" + item.study.memory));
          }
        }
        contents.append(card);
      }
    }

    function renderArchive() {
      const history = dashboard?.partner ? [dashboard.duel, ...(dashboard.history || [])] : [];
      const games = [...new Map(history.filter((game) => game &&
        (game.own || game.opponentSubmitted || game.opponent)).map((game) => [game.id, game])).values()];
      const panel = byId("duel-history-panel");
      panel.hidden = games.length === 0;
      if (panel.hidden) panel.open = false;
      const key = JSON.stringify(games.map((game) => [
        game.id, game.status, game.retired, game.result, game.own?.correct, game.opponent?.correct,
        game.opponentSubmitted, canReview(game),
      ]));
      const current = games.find((game) => game.id === selectedPaper);
      if (!current) selectedPaper = null;
      renderReview(current);
      if (key === renderedArchive) return;
      renderedArchive = key;
      byId("duel-history").replaceChildren(...games.map((game) => {
        const row = document.createElement("article");
        const created = new Date(game.createdAt);
        const dateLabel = Number.isFinite(created.getTime()) ? date.format(created) : "";
        const when = tag("time", dateLabel);
        if (dateLabel) when.dateTime = created.toISOString();
        const outcome = resultLabels[game.result] || (game.retired ? "已归档" : statusLabels[game.status]) || "已结束";
        row.append(
          tag("h4", title(game)),
          when,
          tag("p", `${outcome} · 我 ${score(game.own)} · 同桌 ${score(game.opponent, game.opponentSubmitted)}`),
        );
        if (canReview(game)) {
          const paper = tag("button", "回看我的试卷");
          paper.type = "button";
          paper.setAttribute("aria-controls", "desk-duel-review-panel");
          paper.onclick = () => {
            selectedPaper = game.id;
            const review = byId("duel-review-panel");
            renderArchive();
            review.open = true;
            review.querySelector("summary").focus({ preventScroll: true });
            review.scrollIntoView({ block: "nearest" });
          };
          row.append(paper);
        }
        return row;
      }));
    }

    function renderDashboard() {
      if (renderedDashboard === dashboard || !dashboard) return;
      renderedDashboard = dashboard;
      avatars?.update(dashboard.me?.avatar, dashboard.partner?.avatar);
      renderArchive();
      const peer = dashboard.progressPeer || dashboard.partner;
      if (!peer) return clearStats();
      const peerName = dashboard.progressPeer ? "学友" : "同桌";
      text("peer-name", peerName);
      comparison.querySelector('[data-desk-progress-owner="peer"]').setAttribute("aria-label", `查看${peerName}的学习进度`);
      byId("peer-bar").setAttribute("aria-label", `${peerName}的题库完成度`);
      renderStats("mine", dashboard.me, dashboard.total);
      renderStats("peer", peer, dashboard.total);
    }

    function render() {
      const hasPartner = Boolean(dashboard?.partner);
      const adminProgress = Boolean(dashboard?.progressPeer);
      const showUnpairedProgress = adminProgress && !hasPartner;
      const progressAnchor = showUnpairedProgress ? byId("cover") : byId("records");
      if (comparison.parentElement !== progressAnchor.parentElement) {
        if (detailDialog.open) detailDialog.close();
        progressAnchor.before(comparison, detailDialog);
      }
      byId("guest").hidden = Boolean(account);
      byId("cover").hidden = Boolean(account && !dashboard);
      byId("companions").hidden = !hasPartner;
      byId("unpaired").hidden = !dashboard || hasPartner;
      paired.hidden = !hasPartner;
      const progressAccess = adminProgress ? "admin" : hasPartner ? "paired" : null;
      progress?.setAccess(active ? progressAccess : null);
      byId("refresh").hidden = !account;
      avatars?.show(Boolean(account && dashboard));
      renderDashboard();
      setBusy();
      live?.setContext(account, hasPartner, active);
      social?.setContext(account, hasPartner, active);
      arena?.setContext(account, hasPartner, active);
    }

    async function requestDashboard({ silent = false } = {}) {
      if (!account || actionInProgress || (silent && activeRequest)) return;
      const token = {};
      activeRequest = token;
      actionInProgress = !silent;
      if (!silent) setStatus("正在连接…");
      render();
      try {
        const { data, error } = await rpc("quiz_pk_dashboard");
        if (activeRequest !== token) return;
        if (error) throw error;
        if (!data) throw new Error("pk_empty");
        dashboard = data;
        if (!silent || byId("status").textContent === "正在同步学习进度…") setStatus("");
      } catch (error) {
        if (activeRequest !== token) return;
        if (!silent || !dashboard) {
          setStatus(errors[error.message] || (error.code === "PGRST202"
            ? "同桌服务暂不可用。请稍后刷新。"
            : "连接失败，请稍后重试。"));
        }
      } finally {
        if (activeRequest === token) {
          activeRequest = null;
          actionInProgress = false;
          render();
          if (dashboardDirty) {
            dashboardDirty = false;
            if (canRefresh()) requestDashboard({ silent: true });
          }
        }
      }
    }

    byId("login").onclick = login;
    byId("refresh").onclick = () => requestDashboard();

    function canRefresh() {
      return active && Boolean(account) && !document.hidden;
    }

    function refresh() {
      if (!canRefresh()) return;
      if (activeRequest) dashboardDirty = true;
      else requestDashboard({ silent: true });
      progress?.refresh();
    }

    function progressChanged() {
      if (!canRefresh() || progressTimer !== null) return;
      progressTimer = setTimeout(() => {
        progressTimer = null;
        refresh();
      }, 120);
    }

    function watchProgress() {
      if (canRefresh()) {
        stopProgress ||= subscribeProgress?.(progressChanged);
      } else {
        stopProgress?.();
        stopProgress = null;
        clearTimeout(progressTimer);
        progressTimer = null;
      }
    }

    function resume() {
      watchProgress();
      refresh();
    }

    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", resume);
    setInterval(() => {
      if (!activeRequest) refresh();
    }, 15000);

    return {
      progressChanged,
      show(visible) {
        if (visible === active) return;
        active = visible;
        if (active) {
          if (account && !dashboard && !byId("status").textContent) setStatus("正在同步学习进度…");
          render();
          resume();
        } else {
          watchProgress();
          progress?.setAccess(null);
          live?.setContext(account, Boolean(dashboard?.partner), false);
          social?.setContext(account, Boolean(dashboard?.partner), false);
          arena?.setContext(account, Boolean(dashboard?.partner), false);
        }
      },
      setLoginAvailable(available) {
        byId("login").disabled = !available;
        if (!available) text("status", "请使用已配置账号同步的版本登录。");
      },
      accountChanged(next) {
        if (next === account) return;
        stopProgress?.();
        stopProgress = null;
        clearTimeout(progressTimer);
        progressTimer = null;
        account = next;
        avatars?.reset();
        dashboard = null;
        activeRequest = null;
        dashboardDirty = false;
        actionInProgress = false;
        renderedDashboard = null;
        selectedPaper = null;
        clearStats();
        renderArchive();
        text("status", account && active ? "正在同步学习进度…" : "");
        render();
        resume();
      },
    };
  }

  window.QuizDesk = { connect };
})();
