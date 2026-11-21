(() => {
  "use strict";

  function connect({ run, saved }) {
    const get = (id) => document.getElementById("desk-avatar-" + id);
    const button = get("edit");
    const dialog = get("dialog");
    const preview = get("preview");
    const picker = get("input");
    const sheet = window.QuizSheetMotion?.attach(dialog);
    const close = sheet ? sheet.close : () => dialog.close();
    const mine = { images: ["desk-mine-avatar", "desk-seat-avatar"].map((id) => document.getElementById(id)) };
    const peer = { images: [document.getElementById("desk-peer-avatar")] };
    let draft;
    let draftUrl;
    let changing = false;
    let removing = false;
    let preparing = false;
    let selection = 0;
    let identity = 0;

    function imageSource(image, url) {
      image.hidden = !url;
      if (url) image.src = url;
      else image.removeAttribute("src");
    }

    function display(slot, url) {
      for (const image of slot.images) imageSource(image, url);
      if (slot.url) URL.revokeObjectURL(slot.url);
      slot.url = url;
    }

    function resetSlot(slot) {
      slot.path = null;
      slot.revision = null;
      slot.renderedRevision = null;
      slot.load = null;
      display(slot, null);
    }

    function isOpen() {
      return dialog.open && !dialog.hasAttribute("data-sheet-closing");
    }

    function refreshEditor() {
      imageSource(preview, draftUrl || mine.url);
      get("pick").disabled = changing;
      get("save").disabled = !draft || preparing || changing || removing;
      get("remove").hidden = !mine.path || removing;
      get("remove").disabled = changing;
      get("remove-confirm").hidden = !removing;
      get("remove-yes").disabled = changing;
      get("remove-cancel").disabled = changing;
    }

    async function updateSlot(slot, avatar) {
      if (!avatar?.path || !avatar.revision) {
        resetSlot(slot);
        return;
      }
      const { path, revision } = avatar;
      const sameImage = path === slot.path && revision === slot.revision;
      if (sameImage && (slot.load || (slot.url && slot.renderedRevision === revision))) return;
      if (slot.path !== path) display(slot, null);
      slot.path = path;
      slot.revision = revision;
      const load = {};
      slot.load = load;
      try {
        const { data, error } = await run("download", avatar);
        if (slot.load !== load || error || !(data instanceof Blob) || !data.size) return;
        display(slot, URL.createObjectURL(data));
        slot.renderedRevision = revision;
      } catch {
        // A later desk refresh retries an image that could not be read.
      } finally {
        if (slot.load === load) {
          slot.load = null;
          if (slot === mine && isOpen()) refreshEditor();
        }
      }
    }

    function setStatus(text) {
      get("status").textContent = text;
    }

    function clearDraft() {
      if (draftUrl) URL.revokeObjectURL(draftUrl);
      draftUrl = null;
      draft = null;
    }

    function clearEditor() {
      selection += 1;
      preparing = false;
      removing = false;
      clearDraft();
      picker.value = "";
      setStatus("");
      refreshEditor();
    }

    async function save(action) {
      if (changing || (action === "save" && (!draft || preparing))) return;
      const startedAs = identity;
      changing = true;
      refreshEditor();
      setStatus(action === "save" ? "正在保存头像…" : "正在恢复默认头像…");
      try {
        const { error } = await run(action, draft);
        if (startedAs !== identity) return;
        if (error) throw error;
        if (isOpen()) close();
        if (action === "remove") resetSlot(mine);
        saved();
      } catch {
        if (startedAs === identity && isOpen()) setStatus("暂时无法保存头像，请检查网络后重试。");
      } finally {
        if (startedAs === identity) {
          changing = false;
          if (isOpen()) refreshEditor();
        }
      }
    }

    button.onclick = () => {
      if (dialog.open) return;
      clearEditor();
      if (typeof dialog.showModal === "function") dialog.showModal();
    };
    get("close").onclick = close;
    dialog.addEventListener("close", () => { if (!dialog.open) clearEditor(); });
    get("pick").onclick = () => picker.click();
    picker.onchange = async () => {
      const file = picker.files[0];
      if (!file || !isOpen() || changing) return;
      picker.value = "";
      const pick = ++selection;
      removing = false;
      clearDraft();
      preparing = true;
      setStatus("正在处理图片…");
      refreshEditor();
      try {
        const blob = await window.QuizAvatarImage.prepare(file);
        if (selection !== pick || !isOpen()) return;
        draft = blob;
        draftUrl = URL.createObjectURL(blob);
        setStatus("");
      } catch (error) {
        if (selection === pick && isOpen()) setStatus(error.message || "图片读取失败，请换一张试试。");
      } finally {
        if (selection === pick) {
          preparing = false;
          refreshEditor();
        }
      }
    };
    get("save").onclick = () => save("save");
    get("remove").onclick = () => {
      removing = true;
      refreshEditor();
      get("remove-cancel").focus();
    };
    get("remove-cancel").onclick = () => {
      removing = false;
      refreshEditor();
      get("remove").focus();
    };
    get("remove-yes").onclick = () => save("remove");

    return {
      show(visible) { button.hidden = !visible; },
      update(own, partner) {
        updateSlot(mine, own);
        updateSlot(peer, partner);
      },
      reset() {
        identity += 1;
        changing = false;
        if (dialog.open) dialog.close();
        resetSlot(mine);
        resetSlot(peer);
        clearEditor();
      },
    };
  }

  window.QuizDeskAvatar = { connect };
})();
