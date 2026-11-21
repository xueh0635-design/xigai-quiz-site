(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const dialog = byId("development-requests");
  const sheet = window.QuizSheetMotion.attach(dialog);
  const pairForm = byId("development-pair-form");
  const pairCode = byId("development-pair-code");
  const requestForm = byId("development-request-form");
  const brief = byId("development-brief");
  const send = byId("development-send");
  const local = byId("development-local");
  const mark = byId("development-mark");
  const marks = byId("development-marks");
  const picker = byId("development-picker");
  const target = byId("development-target");
  const box = byId("development-box");
  const noteForm = byId("development-note-form");
  const note = byId("development-note");
  const receipts = byId("development-receipts");
  const status = byId("development-status");
  const mac = byId("development-mac");
  const shortcuts = document.querySelectorAll("[data-development-shortcut]");
  const states = { queued: "等待 Mac", running: "开发中", ready: "草稿已就绪", failed: "需要查看" };
  const envelope = "[[xigai-development-v1]]\n";
  const maxMarks = 6;

  function compact(value, limit) {
    return value.replace(/\s+/g, " ").replace(/[\w.+-]+@[\w.-]+\.[\w-]+/g, "[邮箱] ").trim().slice(0, limit);
  }

  function describeArea(rect, bounds, surface) {
    const candidates = [];
    const elements = surface.querySelectorAll("button, label, h1, h2, h3, p, span, li, img, canvas, [role=img]");
    for (const element of elements) {
      if (element.closest("#development-picker, #development-requests, [hidden], [aria-hidden=true], dialog:not([open])")) continue;
      const area = element.getBoundingClientRect();
      const width = Math.min(area.right, rect.right) - Math.max(area.left, rect.left);
      const height = Math.min(area.bottom, rect.bottom) - Math.max(area.top, rect.top);
      if (width <= 0 || height <= 0 || getComputedStyle(element).visibility !== "visible") continue;
      const text = compact(element.innerText || element.getAttribute("alt") || element.getAttribute("aria-label") || "", 84);
      if (!text && !element.id) continue;
      candidates.push({ element, text, score: width * height / Math.max(1, area.width * area.height) });
    }
    candidates.sort((a, b) => b.score - a.score);
    const targets = [];
    for (const { element, text } of candidates) {
      if (targets.some((item) => item[2] === text)) continue;
      targets.push([element.localName, element.id || "", text]);
      if (targets.length === 2) break;
    }
    const section = surface === document.body
      ? candidates[0]?.element.closest("main > section") || document.querySelector("main > section:not([hidden])") : surface;
    const heading = section?.querySelector("h1, h2");
    const position = section?.id === "quiz" ? byId("where").textContent : "";
    const percent = (part, total) => Math.round(100 * part / total);
    return {
      page: [section?.id || "page", compact(position || heading?.textContent || "", 70)],
      ...(section?.dataset.questionId ? { question: section.dataset.questionId } : {}),
      viewport: [Math.round(bounds.width), Math.round(bounds.height)],
      box: [percent(rect.left, bounds.width), percent(rect.top, bounds.height),
        percent(rect.right, bounds.width), percent(rect.bottom, bounds.height)],
      targets,
    };
  }

  function visibleTarget(area) {
    return area.targets.map(([tag, id, text]) => text || (id ? `#${id}` : tag)).join(" · ") || area.page[1] || "页面选区";
  }

  function trackKeyboard() {
    if (!picker.open || !window.visualViewport) return;
    const visual = window.visualViewport;
    const covered = Math.max(0, window.innerHeight - visual.height - visual.offsetTop);
    picker.style.setProperty("--development-keyboard", `${Math.round(covered)}px`);
  }
  window.visualViewport?.addEventListener("resize", trackKeyboard);
  window.visualViewport?.addEventListener("scroll", trackKeyboard);

  function requestId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return [
      hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20),
    ].join("-");
  }

  function connect(call) {
    let account = null;
    let revision = 0;
    let data = null;
    let busy = false;
    let retry = null;
    let timer;
    let annotations = [];
    let surface = document.body;
    let drag = null;
    let pending = null;

    function updateActions() {
      mark.disabled = busy || annotations.length >= maxMarks;
      send.disabled = busy;
      local.disabled = busy;
      local.hidden = annotations.length !== 1 || !annotations[0].targets.some((item) => item[2]);
    }

    function renderMarks() {
      marks.hidden = !annotations.length;
      marks.replaceChildren(...annotations.map((annotation, index) => {
        const item = document.createElement("li");
        const context = document.createElement("p");
        context.textContent = `批注 ${index + 1} · ${visibleTarget(annotation)}`;
        const value = document.createElement("textarea");
        value.rows = 1;
        value.maxLength = 240;
        value.required = true;
        value.value = annotation.note;
        value.setAttribute("aria-label", `批注 ${index + 1}`);
        value.addEventListener("input", () => { annotation.note = value.value; });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "移除";
        remove.setAttribute("aria-label", `移除批注 ${index + 1}`);
        remove.onclick = () => {
          annotations.splice(index, 1);
          renderMarks();
          mark.focus({ preventScroll: true });
        };
        item.append(context, value, remove);
        return item;
      }));
      updateActions();
    }

    function resetPicker() {
      drag = pending = null;
      box.hidden = noteForm.hidden = true;
      note.value = "";
      byId("development-picker-hint").textContent = "拖动手指框出要改的位置";
    }

    function startPicker() {
      if (!data?.available || mark.disabled) return;
      surface = [...document.querySelectorAll("dialog[open]")].findLast((element) => element !== dialog) || document.body;
      resetPicker();
      dialog.close();
      picker.showModal();
      trackKeyboard();
    }

    function updateBox(event) {
      const x = Math.max(0, Math.min(drag.bounds.width, event.clientX - drag.bounds.left));
      const y = Math.max(0, Math.min(drag.bounds.height, event.clientY - drag.bounds.top));
      const rect = { left: Math.min(x, drag.x), top: Math.min(y, drag.y), right: Math.max(x, drag.x), bottom: Math.max(y, drag.y) };
      Object.assign(box.style, {
        left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${rect.right - rect.left}px`, height: `${rect.bottom - rect.top}px`,
      });
      box.hidden = false;
      return rect;
    }

    target.onpointerdown = (event) => {
      if (event.button !== 0 || !event.isPrimary || pending || drag) return;
      const bounds = target.getBoundingClientRect();
      drag = { id: event.pointerId, bounds, x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      target.setPointerCapture(event.pointerId);
      updateBox(event);
    };
    target.onpointermove = (event) => {
      if (drag?.id === event.pointerId) updateBox(event);
    };
    target.onpointerup = (event) => {
      if (drag?.id !== event.pointerId) return;
      const rect = updateBox(event);
      const { bounds } = drag;
      drag = null;
      if (rect.right - rect.left < 12 || rect.bottom - rect.top < 12) {
        box.hidden = true;
        byId("development-picker-hint").textContent = "请拖出一个稍大的区域";
        return;
      }
      pending = describeArea(rect, bounds, surface);
      byId("development-picker-hint").textContent = "选区已框出";
      byId("development-note-target").textContent = visibleTarget(pending);
      noteForm.toggleAttribute("data-above", rect.top > bounds.height / 2);
      noteForm.hidden = false;
      if (event.pointerType === "mouse") note.focus({ preventScroll: true });
    };
    target.onpointercancel = () => { if (drag) resetPicker(); };
    byId("development-picker-done").onclick = () => picker.close();
    byId("development-redraw").onclick = resetPicker;
    mark.onclick = startPicker;
    picker.addEventListener("close", () => {
      resetPicker();
      surface = document.body;
      if (open()) mark.focus({ preventScroll: true });
    });
    noteForm.onsubmit = (event) => {
      event.preventDefault();
      if (!pending || !note.value.trim()) return;
      annotations.push({ ...pending, note: note.value.trim() });
      renderMarks();
      picker.close();
    };

    function render() {
      const available = data?.available === true;
      const pairing = data?.pairing === true;
      byId("development-profile").hidden = !available && !pairing;
      byId("profile-development-open").textContent = available ? "提需求" : "绑定 Mac";
      for (const shortcut of shortcuts) shortcut.hidden = !available;
      pairForm.hidden = !pairing || available;
      requestForm.hidden = !available;
      const requests = Array.isArray(data?.requests) ? data.requests : [];
      const working = requests.some((request) => request.status === "running");
      mac.textContent = pairing ? "在自己的题库账号下，用 Mac 上的一次性绑定码开通。"
        : available ? (working ? "Codex 正在处理，请稍后查看进展。"
          : data.macOnline ? "Mac 在线。发出需求后会自动开始。"
            : "Mac 暂未响应。需求会等它上线再开始。") : "开发助手暂未开通。";
      receipts.replaceChildren(...requests.map((request) => {
        const row = document.createElement("li");
        row.className = "tutor-turn";
        const state = document.createElement("strong");
        state.textContent = states[request.status] || states.failed;
        const text = document.createElement("p");
        let submitted;
        if (request.brief?.startsWith(envelope)) {
          try {
            const parsed = JSON.parse(request.brief.slice(envelope.length));
            if (Array.isArray(parsed?.annotations) && parsed.annotations.every((item) =>
              Array.isArray(item?.targets) && item.targets.every((target) => Array.isArray(target)) && Array.isArray(item.page))) submitted = parsed;
          } catch { /* Leave the stored request readable. */ }
        }
        text.textContent = submitted
          ? [submitted.brief, ...submitted.annotations.map((annotation) => `${visibleTarget(annotation)}\n${annotation.note}`)].filter(Boolean).join("\n\n")
          : request.brief;
        if (submitted?.route === "local") state.textContent += " · Mac 本地文案";
        row.append(state, text);
        if (request.result) {
          const result = document.createElement("p");
          result.textContent = request.result;
          row.append(result);
        }
        if (/^https:\/\/github\.com\/xueh0635-design\/xigai-quiz-development\/pull\/[0-9]+$/.test(request.pr_url || "")) {
          const link = document.createElement("a");
          link.href = request.pr_url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = "查看私有草稿";
          row.append(link);
        }
        return row;
      }));
    }

    async function request(action, payload = {}) {
      if (!account || busy || (action === "list" && picker.open)) return;
      const stamp = revision;
      const snapshot = JSON.stringify([brief.value, annotations]);
      busy = true;
      if (action === "pair") pairForm.querySelector("button").disabled = true;
      if (action !== "list") updateActions();
      try {
        const result = await call(action, payload);
        if (stamp !== revision) return;
        if (result) {
          data = result;
          render();
        }
        if (action === "list") return;
        if (!result) status.textContent = "连接失败，请重试。";
        else if (result.error === "pairing") status.textContent = "绑定码不正确或已失效。";
        else if (!result.available || result.error) status.textContent = "需求未发送，请重新打开助手。";
        else {
          if (action === "pair") pairCode.value = "";
          if (action === "submit" && JSON.stringify([brief.value, annotations]) === snapshot) {
            brief.value = "";
            annotations = [];
            renderMarks();
          }
          retry = null;
          status.textContent = action === "pair" ? "Mac 已绑定。" : "已发送。";
        }
      } catch {
        if (action !== "list" && stamp === revision) status.textContent = "连接失败，请重试。";
      } finally {
        if (stamp === revision) {
          busy = false;
          pairForm.querySelector("button").disabled = false;
          updateActions();
        }
      }
    }

    function open() {
      if (!data || (!data.available && !data.pairing) || dialog.open || picker.open) return false;
      status.textContent = "";
      dialog.showModal();
      void request("list");
      timer = setInterval(() => {
        if (!document.hidden) void request("list");
      }, 8000);
      return true;
    }

    byId("development-close").onclick = sheet.close;
    byId("profile-development-open").onclick = open;
    for (const shortcut of shortcuts) shortcut.onclick = open;
    dialog.addEventListener("close", () => {
      clearInterval(timer);
      pairCode.value = "";
    });
    pairForm.onsubmit = (event) => {
      event.preventDefault();
      void request("pair", { code: pairCode.value.trim() });
    };
    requestForm.onsubmit = (event) => {
      event.preventDefault();
      const route = event.submitter === local && !local.hidden ? "local" : "codex";
      const general = brief.value.trim();
      if ((!general && !annotations.length) || !data?.available || busy) return;
      if (annotations.some((annotation) => !annotation.note.trim())) {
        status.textContent = "请填写每条批注，或移除空白批注。";
        return;
      }
      const text = annotations.length || general.startsWith(envelope.trim())
        ? envelope + JSON.stringify({ route, brief: general, annotations }) : general;
      if ([...text].length > 2000) {
        status.textContent = "这批批注较长。请缩短文字，或分两次发送。";
        return;
      }
      retry = retry?.brief === text ? retry : { id: requestId(), brief: text };
      void request("submit", retry);
    };
    window.addEventListener("focus", () => void request("list"));
    return { accountChanged(id) {
      if (account === id) return;
      revision += 1;
      account = id;
      data = retry = null;
      brief.value = pairCode.value = "";
      annotations = [];
      busy = false;
      pairForm.querySelector("button").disabled = false;
      renderMarks();
      if (picker.open) picker.close();
      if (dialog.open) dialog.close();
      render();
      void request("list");
    } };
  }

  window.QuizDevelopmentRequests = { connect };
})();
