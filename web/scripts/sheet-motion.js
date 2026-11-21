(() => {
  "use strict";

  const sheets = new WeakMap();
  const reduceMotion = window.QuizWorldMotion?.preference || matchMedia("(prefers-reduced-motion: reduce)");
  let inlinePanel = null;

  function clearInlineAnimation(panel) {
    panel?.animation?.cancel();
    panel?.dialog.removeAttribute("data-inline-closing");
  }

  function restoreInline(panel) {
    clearInlineAnimation(panel);
    panel.trigger?.setAttribute("aria-expanded", "false");
    panel.closeButton.textContent = panel.closeLabel;
    panel.dialog.removeAttribute("data-inline");
    panel.marker.replaceWith(panel.dialog);
    if (inlinePanel === panel) inlinePanel = null;
    panel.host.hidden = true;
  }

  function openInline(dialog, trigger, layout) {
    const inlineHost = document.getElementById(trigger?.getAttribute("aria-controls"));
    if (!inlineHost?.classList.contains("question-inline-panel") || dialog.open) return false;
    const marker = document.createComment(`${dialog.id}-home`);
    dialog.replaceWith(marker);
    inlineHost.append(dialog);
    const closeButton = dialog.querySelector("[data-sheet-handle] > button");
    const panel = {
      dialog, trigger, marker, closeButton, host: inlineHost,
      closeLabel: closeButton.textContent,
      animation: null,
    };
    inlinePanel = panel;
    inlineHost.hidden = false;
    dialog.dataset.inline = "";
    closeButton.textContent = "收起";
    trigger.setAttribute("aria-expanded", "true");
    dialog.addEventListener("close", () => { if (inlinePanel === panel && !dialog.open) restoreInline(panel); }, { once: true });
    dialog.setAttribute("open", "");
    layout?.();
    if (!reduceMotion.matches && typeof dialog.animate === "function") {
      const height = dialog.getBoundingClientRect().height;
      panel.animation = dialog.animate([
        { height: "0px", opacity: .35, transform: "translateY(-8px)", overflow: "hidden" },
        { height: `${height}px`, opacity: 1, transform: "translateY(0)", overflow: "hidden" },
      ], { duration: 260, easing: "cubic-bezier(.2,.78,.24,1)" });
      panel.animation.finished.then(() => {
        if (inlinePanel === panel) panel.animation = null;
      }, () => {});
    }
    requestAnimationFrame(() => inlineHost.scrollIntoView({
      block: "nearest", behavior: reduceMotion.matches ? "instant" : "smooth",
    }));
    return true;
  }

  function closeInline(dialog, immediately = false) {
    const panel = inlinePanel;
    if (!panel || panel.dialog !== dialog || !dialog.open) return false;
    clearInlineAnimation(panel);
    if (immediately || reduceMotion.matches || typeof dialog.animate !== "function") {
      dialog.close();
      restoreInline(panel);
      return true;
    }
    dialog.dataset.inlineClosing = "";
    const height = dialog.getBoundingClientRect().height;
    panel.animation = dialog.animate([
      { height: `${height}px`, opacity: 1, transform: "translateY(0)", overflow: "hidden" },
      { height: "0px", opacity: 0, transform: "translateY(-6px)", overflow: "hidden" },
    ], { duration: 170, easing: "cubic-bezier(.4,0,.8,.35)", fill: "forwards" });
    panel.animation.finished.then(() => {
      if (dialog.open) dialog.close();
    }, () => {});
    return true;
  }

  function attach(dialog) {
    if (sheets.has(dialog)) return sheets.get(dialog);

    let drag = null;
    let animation = null;
    let offset = 0;
    let height = 0;

    function paint(value) {
      offset = value;
      dialog.style.setProperty("--sheet-offset", `${reduceMotion.matches ? 0 : value}px`);
      dialog.style.setProperty("--sheet-dim", String(
        reduceMotion.matches ? 1 : Math.max(0, 1 - value / Math.max(112, height * .78))
      ));
    }

    function releasePointer() {
      const active = drag;
      drag = null;
      dialog.removeAttribute("data-sheet-dragging");
      if (active?.handle.hasPointerCapture(active.id)) active.handle.releasePointerCapture(active.id);
    }

    function stopAnimation() {
      const running = animation;
      animation = null;
      running?.cancel();
    }

    function stopAtCurrentPosition() {
      if (!animation) return;
      const transform = getComputedStyle(dialog).transform;
      const y = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
      stopAnimation();
      paint(y);
    }

    function reset() {
      releasePointer();
      stopAnimation();
      offset = 0;
      dialog.removeAttribute("data-sheet-closing");
      dialog.style.removeProperty("--sheet-offset");
      dialog.style.removeProperty("--sheet-dim");
    }

    function slide(to, duration, easing, done) {
      if (reduceMotion.matches || typeof dialog.animate !== "function") {
        done();
        return;
      }
      const motion = dialog.animate([
        { transform: `translateY(${offset}px)` },
        { transform: `translateY(${to}px)` },
      ], { duration, easing, fill: "forwards" });
      animation = motion;
      motion.finished.then(() => {
        if (animation === motion) done();
      }, () => {});
    }

    function close() {
      if (!dialog.open || dialog.hasAttribute("data-sheet-closing")) return;
      if (closeInline(dialog)) return;
      stopAtCurrentPosition();
      releasePointer();
      const edge = dialog.getBoundingClientRect().top - offset;
      const down = Math.max(offset + 16, innerHeight - edge + 16);
      dialog.setAttribute("data-sheet-closing", "");
      slide(down, 225, "cubic-bezier(.32, .06, .55, 1)", () => {
        if (dialog.open) dialog.close();
        reset();
      });
    }

    function settle() {
      releasePointer();
      dialog.style.setProperty("--sheet-dim", "1");
      slide(0, 245, "cubic-bezier(.2, .85, .34, 1.18)", () => {
        stopAnimation();
        paint(0);
      });
    }

    dialog.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0 || drag || !dialog.open ||
          dialog.hasAttribute("data-sheet-closing") || dialog.hasAttribute("data-inline")) return;
      const handle = event.target.closest("[data-sheet-handle]");
      if (!handle || event.target.closest("button, input, textarea, select, a, [contenteditable]")) return;
      drag = {
        id: event.pointerId, handle, x: event.clientX, y: event.clientY,
        lastY: event.clientY, time: event.timeStamp, speed: 0, start: 0, moving: false,
      };
    });

    dialog.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const delta = event.clientY - drag.y;
      if (!drag.moving) {
        const horizontal = Math.abs(event.clientX - drag.x);
        if (delta < -6 || (horizontal > 7 && horizontal > delta)) {
          releasePointer();
          return;
        }
        if (delta < 6 || delta < horizontal) return;
        stopAtCurrentPosition();
        drag.start = offset;
        drag.moving = true;
        height = dialog.getBoundingClientRect().height;
        dialog.setAttribute("data-sheet-dragging", "");
        drag.handle.setPointerCapture(drag.id);
      }
      const speed = (event.clientY - drag.lastY) / Math.max(8, event.timeStamp - drag.time);
      drag.speed = .4 * drag.speed + .6 * speed;
      drag.lastY = event.clientY;
      drag.time = event.timeStamp;
      paint(Math.max(0, drag.start + delta));
    });

    window.addEventListener("pointerup", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!drag.moving) {
        releasePointer();
        return;
      }
      const distance = Math.max(0, drag.start + event.clientY - drag.y);
      const speed = event.timeStamp - drag.time < 100 ? drag.speed : 0;
      const threshold = Math.max(72, Math.min(108, height * .22));
      paint(distance);
      if (distance >= threshold || (distance > 24 && speed > .55)) close();
      else settle();
    });

    function cancelDrag(event) {
      if (!drag || event.pointerId !== drag.id) return;
      if (drag.moving) settle();
      else releasePointer();
    }
    window.addEventListener("pointercancel", cancelDrag);
    dialog.addEventListener("lostpointercapture", (event) => {
      if (event.target === drag?.handle) cancelDrag(event);
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener("click", (event) => {
      if (dialog.hasAttribute("data-sheet-closing")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.target !== dialog) return;
      const { left, right, top, bottom } = dialog.getBoundingClientRect();
      if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) close();
    }, true);
    dialog.addEventListener("close", () => { if (!dialog.open) reset(); });

    const sheet = { close };
    sheets.set(dialog, sheet);
    return sheet;
  }

  window.QuizSheetMotion = { attach };
  window.QuizInlinePanel = {
    open: openInline,
    close: closeInline,
    closeCurrent: (immediately = false) => inlinePanel ? closeInline(inlinePanel.dialog, immediately) : false,
  };
})();
