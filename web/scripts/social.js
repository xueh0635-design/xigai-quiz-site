(() => {
  "use strict";

  const get = (id) => document.getElementById("social-" + id);
  const actions = { cheer: "打气", high_five: "击掌" };

  function connect({ rpc }) {
    const section = get("reactions");
    if (!section) return null;
    const buttons = [...section.querySelectorAll("[data-social-reaction]")];
    let snapshot = null;
    let account = null;
    let paired = false;
    let visible = false;
    let pending = null;
    let sending = false;
    let feedback = "";

    function put(id, text) {
      const node = get(id);
      if (node.textContent !== text) node.textContent = text;
    }

    function render() {
      section.hidden = !paired;
      const sent = snapshot?.reactions?.sent || [];
      const received = (snapshot?.reactions?.received || []).map((value) => actions[value]).filter(Boolean);
      for (const button of buttons) {
        button.disabled = sending;
        button.dataset.sent = String(sent.includes(button.dataset.socialReaction));
      }
      get("received").hidden = !received.length;
      put("received", received.length ? `同桌送来了${received.join("和")}。` : "");
      put("reaction-status", feedback);
    }

    async function send(reaction) {
      if (!visible || !paired || !account || sending || (pending && !reaction)) return;
      const token = {};
      pending = token;
      sending = Boolean(reaction);
      if (reaction) feedback = "正在送出…";
      render();
      try {
        const { data, error } = await rpc(reaction ? "quiz_social_react" : "quiz_social_state", reaction ? { reaction } : undefined);
        if (pending !== token) return;
        if (error || !data || typeof data.paired !== "boolean") throw error || new Error("bad social response");
        const dayChanged = snapshot && snapshot.day !== data.day;
        const alreadySent = snapshot?.day === data.day && snapshot?.reactions?.sent?.includes(reaction);
        snapshot = data;
        if (reaction) {
          if (!data.reactions?.sent?.includes(reaction)) throw new Error("reaction_unconfirmed");
          feedback = `${alreadySent ? "今天已" : "已"}给同桌${actions[reaction]}。`;
        } else if (dayChanged) feedback = "";
      } catch {
        if (pending !== token) return;
        if (reaction) feedback = "还没送出，点一下再试。";
      } finally {
        if (pending === token) {
          pending = null;
          sending = false;
          render();
        }
      }
    }

    for (const button of buttons) button.onclick = () => send(button.dataset.socialReaction);
    function refresh() {
      if (!document.hidden && !document.getElementById("desk").hasAttribute("data-live-active")) send();
    }
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    setInterval(refresh, 8500);

    return {
      refresh,
      setContext(nextAccount, nextPaired, nextVisible) {
        const changed = account !== nextAccount || paired !== nextPaired;
        const entered = !visible && nextVisible;
        account = nextAccount;
        paired = nextPaired;
        visible = nextVisible;
        if (changed) {
          snapshot = null;
          pending = null;
          sending = false;
          feedback = "";
          render();
        }
        if (changed || entered) refresh();
      },
    };
  }

  window.QuizSocial = { connect };
})();
