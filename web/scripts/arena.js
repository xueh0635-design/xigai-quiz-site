(() => {
  "use strict";

  const get = (key) => document.getElementById(`arena-${key}`);
  const playing = (match) => ["waiting", "countdown", "active"].includes(match?.phase);
  const outcome = { win: "你赢了", loss: "同桌赢了", tie: "平局" };
  const reactions = { nice: "漂亮！", letsgo: "加油", close: "好接近", gg: "打得好" };
  const relics = {
    guard: { name: "护阵", unlock: "护阵挡下伤害" },
    pierce: { name: "破阵", unlock: "打出一次穿盾攻击" },
    repair: { name: "回炉", unlock: "修复一次受损的塔" },
    focus: { name: "蓄势", unlock: "答错时保住一次连击" },
    combo: { name: "流星连斩", unlock: "连续答对三题" },
  };
  const errors = {
    arena_auth_required: "请重新登录后再试。",
    arena_pair_required: "当前账号暂无同桌。",
    arena_partner_required: "当前账号暂无同桌。",
    arena_chapter_unavailable: "本章暂时无法组题，换一章试试。",
    arena_chapter_empty: "本章暂时无法组题，换一章试试。",
    arena_invalid_total: "请重新选择对垒题数。",
    arena_not_enough_questions: "本章可用题数不足，请少选几题或切换到综合题库。",
    arena_invalid_skill: "这张战术牌不可用。",
    arena_skill_unavailable: "当前还不能打出这张牌。",
    arena_skill_energy: "能量不足，再答对几题就能用牌。",
    arena_unavailable: "这一场已结束或不可用，正在同步。",
    arena_not_active: "对局状态已更新，正在同步。",
    arena_unexpected_question: "当前题目已更新，正在同步。",
    arena_invalid_choice: "请检查选择后再提交。",
    arena_reaction_limited: "刚发过消息，等一下再试。",
    pk_auth_required: "请重新登录后再试。",
    pk_membership_required: "请先开通账号同步。",
    pk_pair_required: "当前账号暂无同桌。",
  };

  function node(tag, text, className) {
    const entry = document.createElement(tag);
    entry.textContent = text;
    if (className) entry.className = className;
    return entry;
  }

  function put(key, value) {
    const target = get(key);
    if (target.textContent !== value) target.textContent = value;
  }

  function connect({ questions, chapters, rpc, subscribe }) {
    const arena = document.getElementById("battle-arena");
    if (!arena) return null;
    const desk = document.getElementById("desk");
    const chapter = get("chapter");
    const voice = window.QuizArenaVoice?.connect({ rpc });
    const motion = window.QuizArenaMotion?.attach(arena);
    const quickButtons = [...get("quick").querySelectorAll("button")];
    const roundButtons = [...get("rounds").querySelectorAll("[data-arena-rounds]")];
    const skillCards = [...get("tactics").querySelectorAll(".arena-card")];
    const eligibleByChapter = new Map();
    let eligibleTotal = 0;
    for (const item of questions.values()) {
      if (item.type === "填空" || !Object.keys(item.options || {}).length) continue;
      eligibleTotal += 1;
      eligibleByChapter.set(item.chapter, (eligibleByChapter.get(item.chapter) || 0) + 1);
    }
    for (const name of new Set([...chapters, ...eligibleByChapter.keys()])) {
      if (eligibleByChapter.get(name) < 3) continue;
      const option = node("option", name);
      option.value = name;
      chapter.append(option);
    }
    const cardView = node("dialog", "", "arena-card-view");
    const closeCard = node("button", "关闭");
    closeCard.type = "button";
    closeCard.onclick = () => cardView.close();
    const viewTitle = node("h4", "");
    viewTitle.id = "arena-card-view-title";
    cardView.setAttribute("aria-labelledby", viewTitle.id);
    const viewArt = node("div", "", "arena-collectible");
    viewArt.setAttribute("data-owned", "");
    const viewEmblem = node("span", "", "arena-card-emblem");
    viewEmblem.setAttribute("aria-hidden", "true");
    viewArt.append(viewEmblem);
    const viewUnlock = node("p", "");
    cardView.append(closeCard, viewTitle, viewArt, viewUnlock);
    arena.append(cardView);

    function viewCard(skill) {
      viewTitle.textContent = relics[skill].name;
      viewArt.dataset.skill = skill;
      viewUnlock.textContent = `收藏条件 · ${relics[skill].unlock}`;
      cardView.showModal();
    }

    let account = null;
    let paired = false;
    let visible = false;
    let entered = false;
    let snapshot = null;
    let pending = null;
    let refreshQueued = false;
    let nextRefreshAt = 0;
    let serverOffset = 0;
    let subscribedPair = null;
    let unsubscribe = null;
    let connectionError = "";
    let actionError = "";
    let activeMatchId = null;
    let lastEvent = 0;
    let recentEffect = null;
    let effectTimer;
    let reactionTimer;
    let questionKey = "";
    let selected = [];
    let shownPaperId = null;
    let renderedPaper = "";
    let renderedHistory = "";
    let renderedCollection = null;
    let confirmLeave = false;
    let focusQuestion = false;
    let desiredRounds = 15;
    let countdownLabel = null;

    const match = () => snapshot?.match || null;
    const ready = () => Boolean(account && paired && visible && !document.hidden);
    const serverTime = () => Date.now() + serverOffset;
    const chapterTitle = (game) => game.chapter || "综合题库";
    const currentQuestion = (game) => questions.get(game?.questionIds?.[game.own?.answered ?? 0]);
    const matchParams = () => ({ p_match_id: match().id });
    const capacity = (game) => game?.maxShield || 100;
    const secondsFor = (count) => 20 + 7 * count;
    const duration = (count) => {
      const seconds = secondsFor(count);
      const minutes = Math.floor(seconds / 60);
      const remainder = seconds % 60;
      return `${minutes ? `${minutes} 分` : ""}${remainder ? ` ${remainder} 秒` : ""}`.trim();
    };

    function updateSubscription() {
      const pairId = ready() ? snapshot?.pairId || match()?.pairId || null : null;
      if (pairId === subscribedPair) return;
      unsubscribe?.();
      subscribedPair = pairId;
      unsubscribe = pairId ? subscribe?.(pairId, () => request("state")) : null;
    }

    function clearEffect() {
      delete arena.dataset.effect;
      delete arena.dataset.target;
      delete get("lane").dataset.effect;
      delete get("lane").dataset.target;
      put("lane-effect", "");
    }

    function effect({ kind, target, caption = "", ...details }) {
      if (motion) {
        motion.play({ kind, target, caption, ...details });
        return;
      }
      clearTimeout(effectTimer);
      clearEffect();
      // Flush the removal so consecutive strikes in the same direction each animate.
      void get("lane").offsetWidth;
      arena.dataset.effect = get("lane").dataset.effect = kind;
      arena.dataset.target = get("lane").dataset.target = target;
      put("lane-effect", caption);
      effectTimer = setTimeout(clearEffect, 900);
    }

    function consumeEvents(game, previous) {
      const events = game?.events || [];
      const newMatch = activeMatchId !== (game?.id || null);
      if (newMatch) {
        activeMatchId = game?.id || null;
        lastEvent = Math.max(0, ...events.map((entry) => Number(entry.seq)));
        recentEffect = null;
        countdownLabel = null;
        motion?.clear();
        get("reaction").hidden = true;
        return;
      }
      const incoming = events.filter((entry) => Number(entry.seq) > lastEvent)
        .sort((first, second) => Number(first.seq) - Number(second.seq));
      if (!incoming.length) return;
      lastEvent = Math.max(lastEvent, ...incoming.map((entry) => Number(entry.seq)));
      if (!entered || !visible) return;
      const latestMessage = incoming.findLast((entry) => entry.kind === "message" && reactions[entry.reaction]);
      if (latestMessage) {
        clearTimeout(reactionTimer);
        put("reaction", `${latestMessage.byMe ? "我" : "同桌"}说：${reactions[latestMessage.reaction]}`);
        get("reaction").hidden = false;
        reactionTimer = setTimeout(() => { get("reaction").hidden = true; }, 5000);
      }
      const maxShield = capacity(game);
      const shields = { self: previous?.own?.shield, opponent: previous?.opponent?.shield };
      for (const entry of incoming) {
        const actor = entry.byMe ? "self" : "opponent";
        const name = entry.byMe ? "我" : "同桌";
        if (entry.kind === "cast" && relics[entry.skill]) {
          if (Number.isFinite(entry.shieldAfter)) shields[actor] = entry.shieldAfter;
          recentEffect = `${name}打出「${relics[entry.skill].name}」`;
          motion?.card({ kind: "cast", skill: entry.skill, target: actor, caption: relics[entry.skill].name });
        } else if (entry.kind === "unlock" && entry.byMe && relics[entry.skill]) {
          motion?.card({ kind: "collect", skill: entry.skill, target: "self", caption: `收录 · ${relics[entry.skill].name}` });
        } else if (entry.kind === "miss") {
          recentEffect = entry.preserved ? `${name}用蓄势守住 ${entry.combo} 连击。` : `${name}答错，连击中断。`;
          effect({ kind: "block", target: actor, caption: entry.preserved ? `守住 ${entry.combo} 连击` : "未命中", skill: entry.skill });
        } else if (entry.kind === "hit") {
          const target = entry.byMe ? "opponent" : "self";
          const before = Number.isFinite(entry.shieldBefore) ? entry.shieldBefore : shields[target];
          const after = Number.isFinite(entry.shieldAfter) ? entry.shieldAfter
            : Number.isFinite(before) ? Math.max(0, before - (entry.damage || 0)) : undefined;
          shields[target] = after;
          const label = entry.streak ? `${entry.streak} 连暴击` : entry.skill === "pierce" ? "破阵"
            : entry.critical ? "疾速暴击" : entry.combo > 1 ? `${entry.combo} 连击` : "";
          const blocked = entry.blocked || 0;
          const chip = entry.damage ? `−${entry.damage}` : blocked ? "护阵挡住了" : "";
          const collapse = before > 0 && after === 0;
          recentEffect = before === 0 ? `${name}答对。塔已失守，仍可继续答题。`
            : collapse ? `${entry.byMe ? "同桌" : "我"}方塔已失守。`
            : blocked ? `${name}答对，护阵挡下 ${blocked} 点伤害。`
            : `${name}${label || "答对"}，${entry.byMe ? "同桌" : "我"}的护盾 ${chip}`;
          if (before !== 0) {
            effect({ kind: entry.critical ? "critical" : entry.combo > 1 ? "combo" : "hit",
              target, caption: [label, chip].filter(Boolean).join(" "), before, after,
              combo: entry.combo || 0, blocked, skill: entry.skill, maxShield });
          }
          if (entry.charged && entry.byMe) motion?.card({ kind: "charge", target: "self", caption: "能量 +1" });
        }
      }
    }

    function tower(key, player, maxShield) {
      const shield = Math.max(0, Math.min(maxShield, player?.shield ?? maxShield));
      const percent = 100 * (shield / maxShield);
      const side = get(key);
      side.dataset.state = shield === 0 ? "destroyed" : percent <= 25 ? "critical" : percent <= 65 ? "worn" : "intact";
      side.toggleAttribute("data-barrier", Boolean(player?.barrier));
      side.style.setProperty("--battle-health", `${percent}%`);
      get(`${key}-shield`).setAttribute("aria-valuemax", maxShield);
      get(`${key}-shield`).setAttribute("aria-valuenow", shield);
      put(`${key}-health`, player?.barrier ? `${shield} · 护阵 ${player.barrier}` : String(shield));
      get(`${key}-combo`).hidden = !(player?.combo > 1);
      put(`${key}-combo`, player?.combo > 1 ? `${player.combo} 连击` : "");
    }

    function statusCopy(game) {
      if (actionError || connectionError) return actionError || connectionError;
      if (pending?.write) return "正在同步…";
      if (!snapshot) return "正在连接擂台…";
      if (!game) return "";
      if (game.phase === "waiting") return game.isHost
        ? `已邀请同桌 · ${game.total} 题 · ${duration(game.total)}`
        : `同桌邀请你挑战 · ${chapterTitle(game)} · ${game.total} 题 · ${duration(game.total)}`;
      if (game.phase === "countdown") return "双方已准备，马上开战。";
      if (game.phase === "active") return game.own?.done ? "你已完成，等待同桌交卷。" : "对局进行中。";
      if (game.phase === "cancelled") return "本场邀约已取消。";
      return outcome[game.winner] || "本场已结束。";
    }

    function renderTimer() {
      const game = match();
      if (!game || !entered || !ready()) return;
      if (game.phase === "countdown") {
        const seconds = Math.max(0, Math.ceil((Date.parse(game.startedAt) - serverTime()) / 1000));
        const label = seconds > 0 ? String(seconds) : "开战";
        put("countdown", label);
        if (label !== countdownLabel) {
          countdownLabel = label;
          motion?.countdown(label);
        }
      }
      if (game.phase === "active") {
        const seconds = Math.max(0, Math.ceil((Date.parse(game.expiresAt) - serverTime()) / 1000));
        put("timer", Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "—");
        get("timer").toggleAttribute("data-urgent", seconds <= 10);
      }
    }

    function renderQuestion(game) {
      const item = entered && game?.phase === "active" && !game.own?.done ? currentQuestion(game) : null;
      get("question").hidden = !item;
      if (!item) {
        questionKey = "";
        selected = [];
        return;
      }
      const key = `${game.id}:${item.id}`;
      if (key !== questionKey) {
        const keepFocus = get("options").contains(document.activeElement);
        questionKey = key;
        selected = [];
        put("stem", item.stem);
        put("counter", `${game.own.answered + 1} / ${game.total}`);
        put("kind", `${item.type}题`);
        get("options").replaceChildren(...Object.entries(item.options || {}).map(([letter, label]) => {
          const option = node("button", "", "battle-option option");
          option.type = "button";
          option.dataset.answer = letter;
          option.append(node("span", letter, "letter"), node("span", label));
          option.onclick = () => {
            selected = item.type !== "多选" ? [letter] : selected.includes(letter)
              ? selected.filter((value) => value !== letter) : [...selected, letter];
            actionError = "";
            render();
          };
          return option;
        }));
        motion?.question();
        if (focusQuestion || keepFocus) get("stem").focus({ preventScroll: true });
        focusQuestion = false;
      }
      for (const option of get("options").children) {
        option.setAttribute("aria-pressed", String(selected.includes(option.dataset.answer)));
        option.disabled = Boolean(pending?.write);
      }
      get("answer").disabled = Boolean(pending?.write) || selected.length === 0;
    }

    const playerScore = (player, total) => {
      if (!player) return "未参战";
      const accuracy = Number.isFinite(player.accuracy) ? ` · 正确率 ${Math.round(player.accuracy)}%` : "";
      const speed = player.answered && Number.isFinite(player.timeMs) ? ` · 平均 ${(player.timeMs / player.answered / 1000).toFixed(1)} 秒` : "";
      return `${player.correct} / ${total} 答对 · ${player.damage} 伤害 · 最长 ${player.bestCombo} 连击${accuracy}${speed}`;
    };

    const liveScore = (player) => {
      const speed = player?.answered && Number.isFinite(player.timeMs) ? ` · 均速 ${(player.timeMs / player.answered / 1000).toFixed(1)} 秒` : "";
      const accuracy = player?.answered && Number.isFinite(player.accuracy) ? ` · ${Math.round(player.accuracy)}% 正确` : "";
      return `${player?.correct ?? 0} 对 · ${player?.damage ?? 0} 伤害${accuracy}${speed}`;
    };

    function eligibleRounds(limit) {
      return roundButtons.map((button) => Number(button.dataset.arenaRounds))
        .filter((count) => count <= limit && (count !== 3 || limit < 5));
    }

    function roundChoice() {
      const limit = chapter.value ? eligibleByChapter.get(chapter.value) || 0 : eligibleTotal;
      const choices = eligibleRounds(limit);
      const count = choices.includes(desiredRounds) ? desiredRounds : choices.at(-1);
      return { limit, count };
    }

    function renderRounds(game, canCreate, writing) {
      get("rounds").hidden = Boolean(game && !canCreate);
      const { limit, count } = roundChoice();
      for (const button of roundButtons) {
        const size = Number(button.dataset.arenaRounds);
        button.hidden = size === 3 && limit >= 5;
        button.disabled = writing || size > limit;
        button.setAttribute("aria-pressed", String(size === count));
      }
      put("rounds-hint", !count ? "本章可对垒的题目不足 3 道。" :
        `${count} 题 · ${duration(count)} · 塔的耐久 ${Math.max(75, count * 10)}`);
      return Boolean(count);
    }

    function renderTactics(game, writing) {
      const active = game?.phase === "active";
      const own = game?.own;
      const shown = entered && active && Boolean(own) && !own.done;
      get("tactics").hidden = !shown;
      if (!shown) return;
      const energy = own.energy ?? 0;
      put("energy", `能量 ${energy}`);
      put("hand-note", energy ? "每张牌本场限用一次。" :
        (own.correct % 2 === 1 ? "再答对一题即可充能。" : "每答对两题充能一次。"));
      for (const button of skillCards) {
        const skill = button.dataset.skill;
        const used = own.used?.includes(skill);
        const armed = own.armed?.includes(skill) || (skill === "guard" && own.barrier > 0);
        const health = own.shield ?? capacity(game);
        const blockedByState = (skill === "guard" && health <= 0) ||
          (skill === "repair" && (health <= 0 || health >= capacity(game))) || (skill === "focus" && !own.combo);
        button.disabled = writing || Boolean(used) || !energy || blockedByState;
        button.dataset.state = armed ? "armed" : used ? "spent" : button.disabled ? "locked" : "ready";
        button.querySelector(".arena-card-state").textContent = armed ? "已生效" : used ? "已使用" :
          blockedByState ? (skill === "focus" ? "需要连击" : health <= 0 ? "塔已失守" : "无需修复")
            : energy ? "消耗 1" : "待充能";
      }
    }

    function renderCollection() {
      const book = new Set((snapshot?.collection || []).map((entry) => entry.skill).filter((skill) => Object.hasOwn(relics, skill)));
      const summary = `${book.size} / ${Object.keys(relics).length}`;
      put("collection-count", summary);
      const key = [...book].sort().join(":");
      if (renderedCollection === key) return;
      renderedCollection = key;
      get("collection-grid").replaceChildren(...Object.entries(relics).map(([skill, { name, unlock }]) => {
        const owned = book.has(skill);
        const tile = node(owned ? "button" : "article", "", "arena-collectible");
        tile.dataset.skill = skill;
        tile.toggleAttribute("data-owned", owned);
        if (owned) {
          tile.type = "button";
          tile.setAttribute("aria-label", `查看${name}插画`);
          tile.onclick = () => viewCard(skill);
        }
        const emblem = node("span", "", "arena-card-emblem");
        emblem.setAttribute("aria-hidden", "true");
        tile.append(emblem, node("strong", name), node("span", owned ? "已收藏" : unlock, "arena-card-copy"));
        return tile;
      }));
    }

    function renderPaper(current, history) {
      const previous = history.find((game) => game.id === shownPaperId);
      const game = previous || current;
      const details = get("review");
      const container = entered && current ? get("review-stage") : get("history");
      if (details.parentElement !== container) container.append(details);
      details.hidden = !(entered || previous) || !game?.paper;
      if (!game?.paper) {
        details.open = false;
        get("paper").replaceChildren();
        renderedPaper = "";
        return;
      }
      const key = `${game.id}:${game.phase}`;
      if (key === renderedPaper) return;
      renderedPaper = key;
      put("review-heading", `回看我的试卷 · ${chapterTitle(game)}`);
      const review = get("paper");
      const missed = new Set(game.paper.missedIds || []);
      const unanswered = new Set(game.paper.unansweredIds || []);
      const answersVisible = game.phase === "finished";
      review.replaceChildren(node("p", answersVisible ? "逐题回看选择、正确答案和解析。" : "可以查看自己的对错。结算后显示正确答案和解析。"));
      if (previous && current?.paper && previous.id !== current.id) {
        const back = node("button", "查看本场试卷");
        back.type = "button";
        back.onclick = () => { shownPaperId = null; entered = true; render(); };
        review.append(back);
      }
      const choices = (item, answer) => answer.map((letter) => `${letter}. ${item.options?.[letter] || letter}`).join("；");
      game.questionIds.forEach((id, index) => {
        const item = questions.get(id);
        const selectedPicks = game.paper.picks?.[id];
        const answered = !unanswered.has(id) && Array.isArray(selectedPicks) && selectedPicks.length > 0;
        const wrong = missed.has(id);
        const card = node("article", "", "duel-paper-item");
        card.dataset.outcome = !answered ? "skipped" : wrong ? "wrong" : "right";
        card.append(node("b", !answered ? "未答" : wrong ? "答错" : "答对", "duel-paper-verdict"),
          node("h4", `${index + 1}. ${item?.stem || "请更新题库后查看题干"}`));
        if (item && answered) card.append(node("p", `我的选择　${choices(item, selectedPicks)}`));
        if (item && answersVisible) {
          card.append(node("p", `正确答案　${choices(item, item.answer)}`));
          if (item.study?.explanation) card.append(node("p", item.study.explanation));
          if (item.study?.memory) card.append(node("p", `记忆提示　${item.study.memory}`));
        }
        review.append(card);
      });
    }

    function renderHistory(game, history) {
      const recent = history.filter((entry) => entry.id !== game?.id);
      get("history").hidden = !recent.length || Boolean(entered && playing(game));
      const key = recent.map((entry) => entry.id).join(":");
      if (key === renderedHistory) return;
      renderedHistory = key;
      get("history-list").replaceChildren(...recent.map((entry) => {
        const row = node("article", "");
        row.append(node("h4", `${chapterTitle(entry)} · ${outcome[entry.winner] || "已结束"}`),
          node("p", `护盾：我 ${entry.own?.shield ?? 0} · 同桌 ${entry.opponent?.shield ?? 0}`));
        if (entry.paper) {
          const paper = node("button", "回看我的试卷");
          paper.type = "button";
          paper.onclick = () => {
            shownPaperId = entry.id;
            render();
            get("review").open = true;
            get("review-heading").scrollIntoView({ block: "nearest" });
          };
          row.append(paper);
        }
        return row;
      }));
    }

    function render() {
      const game = match();
      const started = game?.phase === "active";
      const canCreate = Boolean(snapshot && !playing(game));
      const canJoin = game?.phase === "waiting" && !game.isHost;
      const canLeave = playing(game) && !canJoin && !(started && game.own?.done);
      const missingQuestion = started && !game.own?.done && !currentQuestion(game);
      const inStage = Boolean(entered && game);
      const writing = Boolean(pending?.write);
      arena.dataset.mood = game?.phase === "countdown" ? "ready" : started ? "battle" : game?.phase === "finished" ? "result" : "waiting";
      desk.toggleAttribute("data-arena-active", visible && inStage);
      get("back").hidden = !inStage;
      get("lobby").hidden = inStage;
      get("stage").hidden = !inStage;
      get("scope").hidden = !canCreate && Boolean(game);
      put("status", statusCopy(game));
      const hasEligibleCount = renderRounds(game, canCreate, writing);
      get("create").hidden = Boolean(game && !canCreate);
      get("create").disabled = writing || !canCreate || !hasEligibleCount;
      get("join").hidden = !canJoin;
      get("join").disabled = writing;
      get("open").hidden = !game || canJoin || game.phase === "cancelled";
      put("open", game?.phase === "finished" ? "查看本场结果" : "进入擂台");
      tower("self", game?.own, capacity(game));
      tower("opponent", game?.opponent, capacity(game));
      get("countdown").hidden = game?.phase !== "countdown";
      put("match-info", game ? `${chapterTitle(game)} · ${game.total} 题 · 我已答 ${game.own?.answered ?? 0} · 同桌已答 ${game.opponent?.answered ?? 0}` : "");
      get("live-stats").hidden = !started;
      if (started) {
        put("live-self", liveScore(game.own));
        put("live-opponent", liveScore(game.opponent));
      }
      get("feedback").hidden = !(missingQuestion || (recentEffect && started));
      put("feedback", missingQuestion ? "你的题库版本缺少本题，请更新后再参加。" : recentEffect || "");
      get("quick").hidden = !started;
      for (const button of quickButtons) button.disabled = writing;
      get("result").hidden = game?.phase !== "finished";
      put("result-heading", outcome[game?.winner] || "本场已结束");
      if (game?.phase === "finished") {
        put("result-self", playerScore(game.own, game.total));
        put("result-opponent", playerScore(game.opponent, game.total));
      }
      get("confirm").hidden = !confirmLeave || !canLeave;
      get("leave").hidden = confirmLeave || !canLeave;
      get("leave-yes").disabled = writing;
      put("leave", started ? "退出本场" : "取消本场");
      put("leave-yes", started ? "确认退出" : "确认取消");
      put("confirm-copy", started ? "退出本场会判负，已经提交的答案仍可回看。" : "取消后，本场对局不会开始。");
      renderQuestion(game);
      renderTimer();
      renderTactics(game, writing);
      renderCollection();
      const history = snapshot?.history || [];
      renderPaper(game, history);
      renderHistory(game, history);
      voice?.setContext({ account, matchId: game?.id || null, active: inStage && ready() && started, isHost: game?.isHost });
    }

    function openStage() {
      entered = true;
      shownPaperId = null;
      confirmLeave = false;
      focusQuestion = true;
    }

    async function request(action, params, { onSuccess } = {}) {
      if (!ready()) return;
      if (pending) {
        if (action === "state") refreshQueued = true;
        else if (!pending.write) {
          // A direct action takes precedence over an older in-flight read.
          pending = null;
          refreshQueued = false;
        } else return;
        if (action === "state") return;
      }
      const token = { write: action !== "state" };
      pending = token;
      const requestedAt = Date.now();
      if (token.write) {
        actionError = "";
        render();
      }
      try {
        const { data, error } = await rpc(`quiz_arena_${action}`, params);
        if (pending !== token) return;
        if (error) throw error;
        const previous = match();
        snapshot = { match: data?.match || null, history: data?.history || snapshot?.history || [],
          pairId: data?.pairId || null, collection: data?.collection || snapshot?.collection || [] };
        const game = match();
        const reportedAt = Date.parse(game?.serverAt);
        if (Number.isFinite(reportedAt)) serverOffset = reportedAt - (requestedAt + Date.now()) / 2;
        connectionError = "";
        if (action === "state" && previous?.phase !== game?.phase) actionError = "";
        if (!game) entered = false;
        if (!playing(game)) confirmLeave = false;
        onSuccess?.(game);
        consumeEvents(game, previous);
        if (entered && previous?.id === game?.id && previous?.phase !== "finished" && game?.phase === "finished" && game.winner) {
          if (motion) motion.result(game.winner);
          else effect({ kind: game.winner === "win" ? "victory" : game.winner === "loss" ? "defeat" : "block",
            target: game.winner === "win" ? "opponent" : "self" });
        }
        updateSubscription();
      } catch (error) {
        if (pending !== token) return;
        const copy = errors[error.message] || (error.code === "PGRST202" ? "实时擂台暂时不可用。" : "擂台连接中断，正在尝试重连。");
        if (token.write) actionError = copy;
        else connectionError = copy;
      } finally {
        if (pending === token) {
          pending = null;
          nextRefreshAt = performance.now() + (connectionError ? 5000 : ["countdown", "active"].includes(match()?.phase) ? 1000 : 4000);
          const queued = refreshQueued;
          refreshQueued = false;
          render();
          if (queued && !connectionError) request("state");
        }
      }
    }

    chapter.addEventListener("change", render);
    for (const button of roundButtons) {
      button.onclick = () => { desiredRounds = Number(button.dataset.arenaRounds); actionError = ""; render(); };
    }
    for (const button of skillCards) {
      button.onclick = () => request("cast", { ...matchParams(), p_skill: button.dataset.skill });
    }
    get("create").onclick = () => {
      const { count } = roundChoice();
      if (!count) return;
      request("create", { p_chapter: chapter.value || null, p_total: count }, {
        onSuccess: () => { openStage(); get("heading").focus(); },
      });
    };
    get("join").onclick = () => request("join", matchParams(), {
      onSuccess: () => { openStage(); get("heading").focus(); },
    });
    get("open").onclick = () => {
      openStage();
      render();
      if (get("question").hidden) get("heading").focus();
    };
    get("back").onclick = () => {
      entered = false;
      confirmLeave = false;
      motion?.clear();
      render();
      get("heading").focus({ preventScroll: true });
    };
    get("answer").onclick = () => {
      const game = match();
      const item = currentQuestion(game);
      if (game?.phase !== "active" || game.own?.done || !item || !selected.length) return;
      request("answer", { ...matchParams(), p_question_id: item.id, p_choice: selected.slice() }, {
        onSuccess: () => { focusQuestion = true; },
      });
    };
    get("leave").onclick = () => {
      confirmLeave = true;
      render();
      get("leave-no").focus();
    };
    get("leave-no").onclick = () => {
      confirmLeave = false;
      render();
      get("leave").focus();
    };
    get("leave-yes").onclick = () => request("leave", matchParams(), {
      onSuccess: (game) => {
        confirmLeave = false;
        if (game?.phase !== "finished") entered = false;
      },
    });
    for (const button of quickButtons) {
      button.onclick = () => request("react", { ...matchParams(), p_reaction: button.dataset.arenaReact });
    }

    setInterval(() => {
      if (!ready()) return;
      renderTimer();
      if (!pending && performance.now() >= nextRefreshAt) request("state");
    }, 200);
    window.addEventListener("online", () => request("state"));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) motion?.clear();
      updateSubscription();
      render();
      if (ready()) request("state");
    });

    return {
      setContext(nextAccount, nextPaired, nextVisible) {
        const changed = account !== nextAccount || paired !== nextPaired;
        const returned = !visible && nextVisible;
        if (visible && !nextVisible) motion?.clear();
        if ((changed || !nextVisible) && cardView.open) cardView.close();
        account = nextAccount;
        paired = nextPaired;
        visible = nextVisible;
        if (changed) {
          pending = null;
          refreshQueued = false;
          snapshot = null;
          entered = false;
          confirmLeave = false;
          nextRefreshAt = 0;
          connectionError = "";
          actionError = "";
          shownPaperId = null;
          desiredRounds = 15;
          get("collection").open = false;
          consumeEvents(null);
          clearTimeout(effectTimer);
          clearEffect();
          chapter.value = "";
          chapter.dispatchEvent(new Event("change", { bubbles: true }));
        }
        updateSubscription();
        render();
        if (ready() && (changed || returned)) request("state");
      },
    };
  }

  window.QuizArena = { connect };
})();
