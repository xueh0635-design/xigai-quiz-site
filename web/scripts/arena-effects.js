(() => {
  "use strict";

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const palette = {
    self: { light: "#ffedd1", glow: "#ff9873", shade: "#e35476" },
    opponent: { light: "#f3ffdb", glow: "#82ecdc", shade: "#57afeb" },
    critical: { light: "#fffad4", glow: "#ffcd75", shade: "#bb7ce7" },
    combo: { light: "#fcffe4", glow: "#c2a5ff", shade: "#a17be9" },
    streak: { light: "#f9eaff", glow: "#c096ff", shade: "#7fbafa" },
    legendary: { light: "#fff6d1", glow: "#ffc476", shade: "#f48695" },
    block: { light: "#dce9ff", glow: "#b4badc", shade: "#74769c" },
  };
  const skillLabels = { guard: "护阵", pierce: "破阵", repair: "回炉", focus: "蓄势", combo: "连斩" };
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const mix = (a, b, t) => a + (b - a) * t;
  const easeOut = (x) => 1 - (1 - x) ** 3;
  const twoPi = Math.PI * 2;

  function parts(tag, className) {
    const part = document.createElement(tag);
    part.className = className;
    return part;
  }

  function stateFor(health) {
    if (health <= 0) return "destroyed";
    if (health <= 25) return "critical";
    return health <= 65 ? "worn" : "intact";
  }

  function scatter(strike) {
    const count = strike.collapse || strike.tier === "legendary" ? 25 : strike.kind === "critical" ? 19 : strike.kind === "combo" ? 16 : 12;
    return Array.from({ length: count }, (_, index) => {
      const angle = twoPi * (index / count + Math.random() * .07);
      const speed = .48 + Math.random() * .49;
      const radius = (strike.collapse ? 58 : strike.kind === "block" ? 28 : 42) * speed;
      return {
        x: Math.cos(angle) * radius + 8 * strike.direction,
        y: Math.sin(angle) * radius - (strike.collapse ? 12 : 4),
        size: 1.2 + Math.random() * (strike.collapse ? 4.9 : 3.1),
        spin: (Math.random() * 2 - 1) * Math.PI,
        color: index % 4 === 0 ? strike.colors.light : index % 3 === 0 ? strike.colors.shade : strike.colors.glow,
      };
    });
  }

  function point(strike, t) {
    return {
      x: mix(strike.from.x, strike.to.x, t),
      y: mix(strike.from.y, strike.to.y, t) - Math.sin(t * Math.PI) * strike.loft,
    };
  }

  function line(ctx, source, end, width, color, alpha) {
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }

  function ring(ctx, at, radius, flatten, color, alpha, width = 1) {
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.ellipse(at.x, at.y, radius, radius * flatten, 0, 0, twoPi);
    ctx.stroke();
  }

  function light(ctx, at, radius, color, alpha, wide = 1) {
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, "transparent");
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.scale(wide, 1);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = gradient;
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
    ctx.restore();
  }

  function drawCharge(ctx, strike, amount) {
    const alpha = Math.sin(amount * Math.PI * .59) * .53;
    const radius = mix(18, 5, amount);
    light(ctx, strike.from, 17, strike.colors.glow, alpha);
    ring(ctx, strike.from, radius, .55, strike.colors.glow, alpha, 1.15);
    ring(ctx, strike.from, radius + 3, .66, strike.colors.light, alpha * .4);
    if (strike.kind === "critical" || strike.kind === "combo") {
      const angle = amount * 2.8;
      ctx.globalAlpha = alpha * .85;
      ctx.strokeStyle = strike.colors.light;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.ellipse(strike.from.x, strike.from.y, radius + 2, radius * .68, angle, .15, Math.PI * 1.15);
      ctx.stroke();
    }
    if (strike.tier === "legendary") ring(ctx, strike.from, radius * 1.52, .93, strike.colors.shade, alpha * .85, 1.2);
  }

  function drawFlight(ctx, strike, amount) {
    const { kind, colors } = strike;
    const t = easeOut(amount * .61) / easeOut(.61);
    const head = point(strike, t);
    const tailLength = strike.tier === "legendary" ? .42 : kind === "critical" ? .30 : kind === "combo" ? .26 : .18;
    const alpha = kind === "block" ? 1 - amount * .38 : 1;
    const gradient = ctx.createLinearGradient(head.x - strike.direction * 56, head.y, head.x, head.y);
    gradient.addColorStop(0, "transparent");
    gradient.addColorStop(.58, colors.shade);
    gradient.addColorStop(1, colors.light);

    const back = point(strike, Math.max(0, t - tailLength));
    ctx.globalAlpha = .6 * alpha;
    ctx.strokeStyle = gradient;
    ctx.lineWidth = kind === "critical" ? 5 : 3.3;
    ctx.beginPath();
    ctx.moveTo(back.x, back.y);
    for (let segment = 1; segment <= 8; segment += 1) {
      const dot = point(strike, mix(Math.max(0, t - tailLength), t, segment / 8));
      ctx.lineTo(dot.x, dot.y);
    }
    ctx.stroke();

    if (kind === "combo" || kind === "critical") {
      for (const side of [-1, 1]) {
        const ribbon = point(strike, Math.max(0, t - .09));
        const wake = point(strike, Math.max(0, t - .23));
        line(ctx, { x: wake.x, y: wake.y + side * 8 }, { x: ribbon.x, y: ribbon.y + side * 4 }, 1, colors.glow, alpha * .74);
      }
    }
    if (strike.tier === "legendary" || strike.skill === "pierce") {
      const wake = point(strike, Math.max(0, t - .33));
      line(ctx, { x: wake.x, y: wake.y + 11 }, { x: head.x, y: head.y + 3 }, 1.4, colors.shade, alpha * .85);
    }

    const radius = kind === "critical" ? 7 : kind === "combo" ? 5.4 : 4.5;
    light(ctx, head, radius * 2.9, colors.glow, alpha * .62, 1.65);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colors.light;
    ctx.beginPath();
    ctx.moveTo(head.x + strike.direction * radius, head.y);
    ctx.lineTo(head.x - strike.direction * 2, head.y - radius * .55);
    ctx.lineTo(head.x - strike.direction * radius * 1.82, head.y);
    ctx.lineTo(head.x - strike.direction * 2, head.y + radius * .55);
    ctx.closePath();
    ctx.fill();
  }

  function drawImpact(ctx, strike, elapsed) {
    const amount = clamp(elapsed / strike.recovery);
    const { to, kind, colors, collapse, tier, blocked } = strike;
    const fade = 1 - amount;
    const shock = easeOut(amount);
    const size = collapse || tier === "legendary" ? 58 : kind === "critical" ? 47 : kind === "block" ? 24 : 38;
    if (amount < .38) light(ctx, to, mix(size * .27, size, amount), colors.glow, .71 * (1 - amount / .38));
    ring(ctx, to, mix(4, size, shock), kind === "block" ? .62 : .77, colors.light, fade ** 1.8 * .9, 2.3 - amount);
    if (kind === "critical" || collapse || tier === "legendary") {
      const second = clamp((amount - .12) / .88);
      if (amount >= .12) ring(ctx, to, mix(5, size * 1.22, easeOut(second)), .61, colors.shade, (1 - second) ** 2 * .92, 1.15);
      if (amount < .26) {
        const rays = collapse ? 7 : 4;
        for (let ray = 0; ray < rays; ray += 1) {
          const angle = ray / rays * twoPi + (collapse ? .23 : Math.PI / 4);
          const x = Math.cos(angle), y = Math.sin(angle) * .78;
          line(ctx, { x: to.x + x * 5, y: to.y + y * 5 },
            { x: to.x + x * size * (.43 + shock), y: to.y + y * size * (.43 + shock) },
            1.3, colors.light, (1 - amount / .26) * .73);
        }
      }
    }
    if (blocked > 0 && amount < .68) {
      const deflection = amount / .68;
      ring(ctx, to, mix(18, 42, easeOut(deflection)), .9, "#82ebff", (1 - deflection) * .86, 2);
    }

    for (const chip of strike.particles) {
      const size = chip.size * mix(1, .32, amount);
      const x = to.x + chip.x * shock;
      const y = to.y + chip.y * shock + amount ** 2 * (collapse ? 27 : 12);
      const angle = chip.spin * (amount + .15);
      const cos = Math.cos(angle) * size, sin = Math.sin(angle) * size;
      ctx.globalAlpha = fade ** .82;
      ctx.fillStyle = chip.color;
      ctx.beginPath();
      ctx.moveTo(x + cos, y + sin);
      ctx.lineTo(x - cos * .66 - sin * .62, y - sin * .66 + cos * .62);
      ctx.lineTo(x - cos * .81 + sin * .29, y - sin * .81 - cos * .29);
      ctx.closePath();
      ctx.fill();
    }
  }

  function attach(arena) {
    const field = arena.querySelector(".battlefield");
    if (!field) return null;
    const sides = Object.fromEntries(["self", "opponent"].map(key => [key, arena.querySelector("#arena-" + key)]));
    if (!sides.self || !sides.opponent) return null;
    const art = Object.fromEntries(Object.entries(sides).map(([key, side]) => [key, side.querySelector(".battle-tower-art")]));
    const layer = parts("div", "battle-fx-layer");
    const canvas = parts("canvas", "battle-fx-canvas");
    layer.setAttribute("aria-hidden", "true");
    canvas.hidden = true;
    layer.append(canvas);
    field.append(layer);
    const ctx = canvas.getContext("2d");
    const strikes = [];
    const hitTimes = new Map();
    const captions = new Set();
    const cards = new Set();
    const pendingCollections = [];
    const cardCues = new Map();
    let frame = 0, nextLaunch = 0, width = 0, height = 0, dpr = 1, dimensionsDirty = true;
    let resultTimer = 0, resultCue = null;
    let countdownLabel = "";
    let anchors = null;
    let countdownCue = null;
    let questionCue = null;

    const watchSize = typeof ResizeObserver === "function" ? new ResizeObserver(() => { dimensionsDirty = true; }) : null;
    watchSize?.observe(field);

    function resize() {
      if (!dimensionsDirty) return;
      dimensionsDirty = false;
      width = field.clientWidth;
      height = field.clientHeight;
      dpr = Math.min(1.8, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      anchors = { self: coreOf("self"), opponent: coreOf("opponent") };
    }

    function coreOf(key) {
      const tower = art[key];
      const side = sides[key];
      return {
        x: side.offsetLeft + tower.offsetLeft + tower.offsetWidth * .5,
        y: side.offsetTop + tower.offsetTop + tower.offsetHeight * .57,
      };
    }

    function position(strike) {
      strike.from = anchors[strike.target === "self" ? "opponent" : "self"];
      strike.to = { ...anchors[strike.target] };
      if (strike.kind === "block") {
        strike.to.x = mix(strike.from.x, strike.to.x, .62);
        strike.to.y = mix(strike.from.y, strike.to.y, .62) - 3;
      }
      strike.loft = Math.min(21, Math.abs(strike.to.x - strike.from.x) * .11) + (strike.kind === "critical" ? 8 : 0);
    }

    function displayCaption(strike) {
      if (!strike.caption && !strike.collapse) return;
      const note = parts("span", "battle-fx-caption");
      note.dataset.kind = strike.collapse ? "collapse" : strike.tier;
      const label = [strike.caption];
      if (strike.collapse) label.push("破盾");
      if (strike.blocked > 0 && !/格挡|抵挡|护阵/.test(strike.caption || "")) label.push(`格挡 ${strike.blocked}`);
      note.textContent = label.filter(Boolean).join(" · ");
      const at = strike.to;
      const availableWidth = field.clientWidth;
      note.style.left = `${Math.max(48, Math.min(availableWidth - 48, at.x))}px`;
      note.style.top = `${Math.max(33, at.y - 14)}px`;
      layer.append(note);
      const duration = reduced.matches ? 760 : strike.collapse ? 920 : 670;
      const entry = { note, timer: setTimeout(() => {
        note.remove();
        captions.delete(entry);
      }, duration) };
      captions.add(entry);
      if (captions.size > 4) {
        const oldest = captions.values().next().value;
        clearTimeout(oldest.timer);
        oldest.note.remove();
        captions.delete(oldest);
      }
    }

    function syncHealth(key) {
      const side = sides[key];
      const waiting = strikes.find(strike => strike.target === key && !strike.impacted && Number.isFinite(strike.before));
      if (waiting && !reduced.matches) {
        const percent = Math.round(10000 * clamp(waiting.before / waiting.maxShield)) / 100;
        side.style.setProperty("--battle-visual-health", `${percent}%`);
        side.dataset.motionState = stateFor(percent);
      } else {
        side.style.removeProperty("--battle-visual-health");
        delete side.dataset.motionState;
      }
    }

    function impact(strike) {
      strike.impacted = true;
      syncHealth(strike.target);
      displayCaption(strike);
      if (strike.kind === "block" || reduced.matches) return;
      const side = sides[strike.target];
      const previous = hitTimes.get(side);
      if (previous) clearTimeout(previous);
      delete side.dataset.motionHit;
      void side.offsetWidth;
      side.dataset.motionHit = strike.collapse ? "collapse" : strike.tier;
      const timer = setTimeout(() => {
        delete side.dataset.motionHit;
        hitTimes.delete(side);
      }, strike.recovery);
      hitTimes.set(side, timer);
    }

    function draw(now) {
      frame = 0;
      resize();
      ctx.clearRect(0, 0, width, height);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalCompositeOperation = "screen";
      let status = null;
      for (const strike of strikes) {
        const elapsed = now - strike.start;
        if (elapsed < 0) continue;
        position(strike);
        if (elapsed < strike.charge) {
          drawCharge(ctx, strike, elapsed / strike.charge);
          status = { phase: "launch", target: strike.target };
        } else if (elapsed < strike.contact) {
          drawFlight(ctx, strike, (elapsed - strike.charge) / (strike.contact - strike.charge));
          status = { phase: "flight", target: strike.target };
        } else {
          if (!strike.impacted) impact(strike);
          if (elapsed < strike.contact + strike.recovery) {
            drawImpact(ctx, strike, elapsed - strike.contact);
            status = { phase: "impact", target: strike.target };
          }
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      if (status) {
        if (layer.dataset.phase !== status.phase) layer.dataset.phase = status.phase;
        if (layer.dataset.target !== status.target) layer.dataset.target = status.target;
      }
      for (let index = strikes.length - 1; index >= 0; index -= 1) {
        const strike = strikes[index];
        if (now >= strike.start + strike.contact + strike.recovery) strikes.splice(index, 1);
      }
      if (strikes.length) frame = requestAnimationFrame(draw);
      else {
        canvas.hidden = true;
        delete layer.dataset.phase;
        delete layer.dataset.target;
      }
    }

    function play({ kind, target, caption, before, after, combo, blocked, skill, maxShield }) {
      if (!Object.hasOwn(sides, target)) return;
      if (kind === "victory" || kind === "defeat") {
        result(kind === "victory" ? "win" : "loss");
        return;
      }
      if (!["hit", "combo", "critical", "block"].includes(kind)) return;
      const now = performance.now();
      const critical = kind === "critical";
      const tier = kind === "block" ? "block" : combo >= 5 ? "legendary" : combo >= 3 ? "streak" : kind;
      const collapse = kind !== "block" && before > 0 && after === 0;
      const charge = critical ? 115 : kind === "combo" ? 95 : 70;
      const start = Math.max(now, Math.min(nextLaunch, now + 300));
      nextLaunch = start + 88;
      const strike = {
        kind, target, caption, before, after, combo, blocked, skill, tier, collapse, start, charge,
        maxShield: Number.isFinite(maxShield) && maxShield > 0 ? maxShield : 100,
        contact: charge + (critical ? 268 : 225),
        recovery: collapse ? 710 : critical ? 520 : 420,
        colors: palette[tier] || palette[target],
        direction: target === "opponent" ? 1 : -1,
      };
      if (!ctx || reduced.matches) {
        resize();
        position(strike);
        displayCaption(strike);
        return;
      }
      strike.particles = scatter(strike);
      strikes.push(strike);
      // Limit bursts when a reconnect delivers several answers at once, preserving recent break events.
      if (strikes.length > 10) {
        const stale = strikes.findIndex(item => !item.collapse && item !== strike);
        if (stale >= 0) {
          const [removed] = strikes.splice(stale, 1);
          syncHealth(removed.target);
        }
      }
      syncHealth(target);
      canvas.hidden = false;
      if (!frame) frame = requestAnimationFrame(draw);
    }

    function card({ kind, skill, target, caption }) {
      if (!["cast", "charge", "collect"].includes(kind)) return;
      if (kind === "collect" && [...cards].some((entry) => entry.kind === "collect")) {
        pendingCollections.push({ kind, skill, target, caption });
        return;
      }
      const cardSkill = Object.hasOwn(skillLabels, skill) ? skill : "focus";
      const badge = parts("div", "battle-skill-badge");
      badge.dataset.skill = cardSkill;
      badge.dataset.kind = kind;
      const sigil = parts("span", "arena-card-emblem");
      const label = parts("span", "battle-skill-caption");
      label.textContent = caption || (kind === "collect" ? `收录 · ${skillLabels[cardSkill]}` : skillLabels[cardSkill]);
      badge.append(sigil, label);
      layer.append(badge);
      if (Object.hasOwn(sides, target) && kind === "cast") {
        const side = sides[target];
        const previous = cardCues.get(side);
        if (previous) clearTimeout(previous);
        delete side.dataset.motionSkill;
        if (!reduced.matches) void side.offsetWidth;
        side.dataset.motionSkill = cardSkill;
        const cue = setTimeout(() => {
          delete side.dataset.motionSkill;
          cardCues.delete(side);
        }, 710);
        cardCues.set(side, cue);
      }
      const previous = kind !== "collect" && [...cards].find((item) => item.kind !== "collect");
      if (previous) {
        clearTimeout(previous.timer);
        previous.badge.remove();
        cards.delete(previous);
      }
      const current = { badge, kind, timer: setTimeout(() => {
        badge.remove();
        cards.delete(current);
        if (kind === "collect" && pendingCollections.length) card(pendingCollections.shift());
      }, kind === "collect" ? 1490 : 1050) };
      cards.add(current);
    }

    function result(winner) {
      if (!["win", "loss", "tie"].includes(winner)) return;
      clearTimeout(resultTimer);
      delete arena.dataset.motionResult;
      arena.dataset.motionResult = winner;
      resultCue?.cancel();
      const panel = arena.querySelector(".battle-result");
      if (!reduced.matches && panel?.animate) {
        const delay = strikes.reduce((latest, strike) => Math.max(latest, strike.start + strike.contact - performance.now()), 0);
        resultCue = panel.animate([
          { opacity: .35, transform: "translateY(12px) scale(.977)" },
          { opacity: 1, transform: "translateY(-2px) scale(1.003)", offset: .69 },
          { opacity: 1, transform: "translateY(0) scale(1)" },
        ], { delay, duration: 460, easing: "cubic-bezier(.18,.74,.24,1)", fill: "backwards" });
      }
      resultTimer = setTimeout(() => { delete arena.dataset.motionResult; }, 1300);
    }

    function countdown(label) {
      if (countdownLabel === label) return;
      countdownLabel = label;
      countdownCue?.cancel();
      const clock = arena.querySelector(".battle-countdown");
      if (!reduced.matches && clock?.animate && label) {
        countdownCue = clock.animate([
          { opacity: .55, transform: "scale(.96)" },
          { opacity: 1, transform: "scale(1.022)", offset: .55 },
          { opacity: 1, transform: "scale(1)" },
        ], { duration: 285, easing: "cubic-bezier(.15,.72,.27,1)" });
      }
    }

    function question() {
      questionCue?.cancel();
      if (reduced.matches) return;
      const content = arena.querySelector(".battle-question");
      questionCue = content?.animate?.([
        { opacity: .62, transform: "translateY(5px)" },
        { opacity: 1, transform: "translateY(0)" },
      ], { duration: 240, easing: "cubic-bezier(.19,.82,.33,1)" });
    }

    function clear() {
      cancelAnimationFrame(frame);
      frame = nextLaunch = 0;
      strikes.length = 0;
      for (const key of Object.keys(sides)) syncHealth(key);
      for (const [side, timer] of hitTimes) {
        clearTimeout(timer);
        delete side.dataset.motionHit;
      }
      hitTimes.clear();
      for (const entry of captions) {
        clearTimeout(entry.timer);
        entry.note.remove();
      }
      captions.clear();
      for (const [side, timer] of cardCues) {
        clearTimeout(timer);
        delete side.dataset.motionSkill;
      }
      cardCues.clear();
      for (const entry of cards) {
        clearTimeout(entry.timer);
        entry.badge.remove();
      }
      cards.clear();
      pendingCollections.length = 0;
      clearTimeout(resultTimer);
      delete arena.dataset.motionResult;
      delete layer.dataset.phase;
      delete layer.dataset.target;
      canvas.hidden = true;
      resultCue?.cancel();
      countdownCue?.cancel();
      questionCue?.cancel();
      countdownLabel = "";
    }

    function motionPreference() {
      layer.dataset.reducedMotion = String(reduced.matches);
      if (reduced.matches) clear();
    }
    reduced.addEventListener?.("change", motionPreference);
    motionPreference();
    return { play, result, countdown, question, card, clear };
  }

  window.QuizArenaMotion = { attach };
})();
