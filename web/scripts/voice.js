(() => {
  "use strict";

  const pollDelay = 650;
  const connectionTimeout = 18000;
  const defaultIce = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

  function newSessionId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = bytes[6] & 15 | 64;
    bytes[8] = bytes[8] & 63 | 128;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function connect({ rpc }) {
    const section = document.getElementById("arena-voice");
    if (!section) return null;
    const stateText = document.createElement("p");
    stateText.className = "arena-voice-status";
    stateText.id = "arena-voice-status";
    stateText.setAttribute("role", "status");
    const actions = document.createElement("div");
    actions.className = "arena-voice-actions";
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.hidden = true;
    const button = (label) => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = label;
      actions.append(element);
      return element;
    };
    const join = button("加入语音");
    const microphone = button("开麦");
    const play = button("播放对方语音");
    const leave = button("退出语音");
    const controls = document.createElement("div");
    controls.className = "arena-voice-controls";
    controls.append(stateText, actions);
    section.replaceChildren(controls, audio);

    let context = {};
    let joined = null;
    let notice = "";
    const supported = window.isSecureContext && typeof window.RTCPeerConnection === "function";
    const allowed = () => Boolean(context.active && context.account && context.matchId && !document.hidden);

    function isConnected(peer) {
      if (!peer) return false;
      const connection = peer.pc.connectionState;
      if (connection) return connection === "connected";
      return ["connected", "completed"].includes(peer.pc.iceConnectionState);
    }

    function render() {
      section.hidden = !allowed();
      const connected = isConnected(joined?.peer);
      const open = Boolean(joined?.stream?.getAudioTracks().some((track) => track.enabled && track.readyState === "live"));
      join.hidden = Boolean(joined) || !supported;
      microphone.hidden = !connected;
      microphone.disabled = Boolean(joined?.micPending);
      microphone.textContent = open ? "关麦" : "开麦";
      microphone.setAttribute("aria-pressed", String(open));
      play.hidden = !connected || !joined?.playBlocked;
      leave.hidden = !joined;
      section.dataset.voiceState = connected ? "connected" : joined?.peer ? "connecting" : joined ? "waiting" : "off";
      section.dataset.microphone = open ? "on" : "off";
      const status = (joined?.networkIssues > 1 && !connected ? "正在恢复语音连接…" : joined?.status) ||
        notice || (supported ? "对局语音 · 加入后可听，麦克风默认关闭" : "当前环境无法使用对局语音");
      const display = joined?.micMessage || (connected ? `${status} · ${open ? "麦克风开启" : "麦克风关闭"}` : status);
      if (stateText.textContent !== display) stateText.textContent = display;
    }

    function stopTracks(stream) {
      for (const track of stream?.getTracks() || []) track.stop();
    }

    function mute(session) {
      session.micTicket += 1;
      session.micPending = false;
      session.micMessage = "";
      const stream = session.stream;
      session.stream = null;
      stopTracks(stream);
      if (stream) session.peer?.sender?.replaceTrack(null).catch(() => {});
    }

    function closePeer(session) {
      mute(session);
      const peer = session.peer;
      session.peer = null;
      session.playBlocked = false;
      if (peer) {
        peer.pc.onconnectionstatechange = null;
        peer.pc.oniceconnectionstatechange = null;
        peer.pc.onicecandidate = null;
        peer.pc.ontrack = null;
        peer.pc.close();
      }
      audio.pause();
      audio.srcObject = null;
    }

    function release(message = "") {
      const session = joined;
      joined = null;
      notice = message;
      if (session) {
        clearTimeout(session.timer);
        closePeer(session);
        // Serialize leave behind the current heartbeat so it cannot renew a departed session afterwards.
        const leaveRpc = () => rpc("quiz_arena_voice_leave", { match_id: session.matchId, session_id: session.id });
        Promise.resolve(session.request).catch(() => {}).then(leaveRpc).catch(() => {});
      }
      render();
    }

    async function playIncoming(session, peer) {
      try {
        await audio.play();
        if (joined === session && session.peer === peer) session.playBlocked = false;
      } catch {
        if (joined === session && session.peer === peer && audio.srcObject) session.playBlocked = true;
      }
      if (joined === session) render();
    }

    function announceConnection(session, peer) {
      if (joined !== session || session.peer !== peer) return;
      if (isConnected(peer)) {
        peer.deadline = null;
        session.status = "语音已接通";
      } else {
        if (session.stream || session.micPending) mute(session);
        const transport = peer.pc.connectionState || peer.pc.iceConnectionState;
        const reconnecting = transport === "disconnected";
        peer.deadline ??= Date.now() + connectionTimeout;
        session.status = reconnecting ? "语音暂时中断，正在重连…" : "正在连接语音…";
      }
      render();
    }

    function schedule(session, delay = pollDelay) {
      if (joined !== session || session.request || session.synchronizing) return;
      clearTimeout(session.timer);
      session.timer = setTimeout(() => poll(session), delay);
    }

    function enqueue(session, peer, kind, data) {
      if (joined !== session || session.peer !== peer) return;
      peer.outbox.push({ kind, data, peerSessionId: peer.id });
      schedule(session, 0);
    }

    async function receive(session, peer, signals) {
      for (const entry of signals) {
        if (joined !== session || session.peer !== peer) return;
        if (entry.sessionId !== peer.id) continue;
        const { kind, data } = entry;
        if (kind === "ice") {
          if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data);
          else peer.candidates.push(data);
          continue;
        }
        if (kind === "offer" && !peer.initiator && !peer.pc.remoteDescription) {
          await peer.pc.setRemoteDescription({ type: "offer", sdp: data?.sdp });
          const transceiver = peer.pc.getTransceivers().find((item) => item.receiver.track.kind === "audio");
          if (!transceiver) throw new Error("Offer has no audio channel");
          transceiver.direction = "sendrecv";
          peer.sender = transceiver.sender;
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          enqueue(session, peer, "answer", { sdp: peer.pc.localDescription.sdp });
        } else if (kind === "answer" && peer.initiator && peer.pc.signalingState === "have-local-offer") {
          await peer.pc.setRemoteDescription({ type: "answer", sdp: data?.sdp });
        }
        if (peer.pc.remoteDescription) {
          for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
        }
      }
    }

    async function openPeer(session, id, iceServers) {
      const pc = new RTCPeerConnection({ iceServers: Array.isArray(iceServers) ? iceServers : defaultIce });
      const initiator = typeof context.isHost === "boolean" ? context.isHost : session.id < id;
      const peer = { id, pc, initiator, outbox: [], candidates: [], deadline: Date.now() + connectionTimeout };
      session.peer = peer;
      pc.ontrack = (event) => {
        if (joined !== session || session.peer !== peer) return;
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        void playIncoming(session, peer);
      };
      pc.onicecandidate = ({ candidate }) => {
        if (candidate) enqueue(session, peer, "ice", candidate.toJSON());
      };
      pc.onconnectionstatechange = () => announceConnection(session, peer);
      pc.oniceconnectionstatechange = () => announceConnection(session, peer);
      announceConnection(session, peer);
      if (initiator) {
        peer.sender = pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
        await pc.setLocalDescription(await pc.createOffer());
        enqueue(session, peer, "offer", { sdp: pc.localDescription.sdp });
      }
      return peer;
    }

    async function poll(session) {
      if (joined !== session || !allowed()) return;
      const previousPeer = session.peer;
      const signal = previousPeer?.outbox[0] || null;
      let data;
      session.synchronizing = true;
      try {
        session.request = rpc("quiz_arena_voice", {
          match_id: session.matchId, session_id: session.id, after_seq: session.cursor, signal,
        });
        const response = await session.request;
        if (response.error) throw response.error;
        data = response.data;
        if (!data || typeof data.active !== "boolean") throw new Error("Invalid voice response");
        session.networkIssues = 0;
        if (signal) previousPeer.outbox.shift();
      } catch (error) {
        if (joined === session) {
          if (error?.message === "arena_voice_busy") release("你的另一台设备已加入语音。退出后可在这里加入");
          else if (++session.networkIssues >= 4) release("暂时无法连接语音服务，请重试");
          else render();
        }
      } finally {
        session.request = null;
      }
      try {
        if (joined !== session || !data) return;
        if (!data.active) {
          release("语音已结束，请在进行中的对局重新加入");
          return;
        }
        const id = data.peerSessionId;
        if (previousPeer && previousPeer.id !== id) closePeer(session);
        if (!id) {
          session.status = "正在等同桌加入语音…";
        } else {
          const peer = session.peer || await openPeer(session, id, data.iceServers);
          if (joined !== session) return;
          const signals = Array.isArray(data.signals) ? data.signals : [];
          await receive(session, peer, signals);
          if (peer.deadline && Date.now() >= peer.deadline) {
            release("语音连不上。可以换个网络，或重新加入语音");
            return;
          }
          for (const { seq } of signals) session.cursor = Math.max(session.cursor, Number(seq) || 0);
        }
        render();
      } catch {
        if (joined === session) release("语音连接中断，请重新加入");
      } finally {
        session.synchronizing = false;
        schedule(session, session.peer?.outbox.length ? 75 : pollDelay);
      }
    }

    join.onclick = () => {
      if (!allowed() || joined || !supported) return;
      notice = "";
      joined = { matchId: context.matchId, id: newSessionId(), cursor: 0, networkIssues: 0, micTicket: 0,
        status: "正在加入语音…" };
      render();
      schedule(joined, 0);
    };
    leave.onclick = () => release();
    audio.onplaying = () => {
      if (!joined?.playBlocked) return;
      joined.playBlocked = false;
      render();
    };
    play.onclick = () => {
      if (joined?.peer) void playIncoming(joined, joined.peer);
    };
    microphone.onclick = async () => {
      const session = joined;
      const peer = session?.peer;
      if (!allowed() || !isConnected(peer) || session.micPending) return;
      if (session.stream) {
        mute(session);
        render();
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        session.micMessage = "这台设备暂时无法开启麦克风，仍可收听";
        render();
        return;
      }
      const ticket = ++session.micTicket;
      const stillCurrent = () => allowed() && joined === session && session.peer === peer &&
        session.micTicket === ticket && isConnected(peer);
      session.micPending = true;
      session.micMessage = "正在请求麦克风权限…";
      render();
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        if (!stillCurrent()) {
          stopTracks(stream);
          return;
        }
        const track = stream.getAudioTracks()[0];
        if (!track) throw new Error("No microphone track");
        track.enabled = false;
        session.stream = stream;
        await peer.sender.replaceTrack(track);
        if (!stillCurrent()) return;
        track.enabled = true;
        session.micMessage = "";
        track.addEventListener("ended", () => {
          if (!stillCurrent()) return;
          mute(session);
          session.micMessage = "麦克风已断开，仍可收听";
          render();
        }, { once: true });
      } catch {
        stopTracks(stream);
        if (stillCurrent()) {
          session.stream = null;
          session.micMessage = "无法使用麦克风。可以检查权限，也可以只收听";
        }
      } finally {
        if (stillCurrent()) {
          session.micPending = false;
          render();
        }
      }
    };

    document.addEventListener("visibilitychange", () => {
      if (document.hidden && joined) release("语音已退出，回来后可重新加入");
      else render();
    });
    window.addEventListener("pagehide", () => release());
    render();
    return {
      setContext(next) {
        const changed = context.matchId !== next.matchId || context.account !== next.account;
        context = next;
        if (changed || !allowed()) release();
        else render();
      },
    };
  }

  window.QuizArenaVoice = { connect };
})();
