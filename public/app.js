import {
  initUiSounds,
  playTap,
  playPick,
  playSend,
  playError,
  playChat,
  playRound,
  playPhase,
  playWin,
  playJoin,
  isSfxMuted,
  toggleSfxMuted,
} from "./ui-sounds.js";

const WS_PATH = "/ws";
const SESSION_KEY = "miaoyu_session_v1";
const MAX_RECONNECT = 15;

const QUICK_EMOJIS = ["😂", "❤️", "👍", "😮", "🎉", "🔥", "👏", "🤔", "💀", "🙏", "⭐", "😍", "🥰", "😭", "✨", "🤣", "💯"];

const el = (id) => document.getElementById(id);

document.addEventListener("pointerdown", () => initUiSounds(), { once: true, capture: true });

function updateSfxToggleUi() {
  const b = el("btn-sfx-toggle");
  if (!b) return;
  const muted = isSfxMuted();
  b.setAttribute("aria-pressed", muted ? "true" : "false");
  b.textContent = muted ? "音效：關" : "音效：開";
  b.title = muted ? "點擊開啟操作音效" : "點擊關閉操作音效";
}

/** 依伺服器狀態變化播放提示（靜音時由 ui-sounds 內部略過） */
function maybePlayStateSfx(prev, state) {
  if (!prev || !state || isSfxMuted()) return;
  if (state.phase === "gameover" && prev.phase !== "gameover") {
    playWin();
    return;
  }
  const vid = state.lastRoundSummary?.voteReveal?.id;
  const pvid = prev.lastRoundSummary?.voteReveal?.id;
  if (vid && vid !== pvid) {
    playRound();
    return;
  }
  if (state.phase !== prev.phase) {
    if (prev.phase === "lobby" && state.phase === "clue") {
      playPhase();
      return;
    }
    if (prev.phase === "clue" && state.phase === "submit") {
      playSend();
      return;
    }
    if (prev.phase === "submit" && state.phase === "vote") {
      playPhase();
      return;
    }
    if (prev.phase === "gameover" && state.phase === "lobby") {
      playTap();
      return;
    }
  }
  if (state.phase === "lobby" && prev.phase === "lobby" && state.cardDeck !== prev.cardDeck) {
    playTap();
  }
}

let ws = null;
let playerId = null;
let roomCode = null;
let lastState = null;
let selectedCardId = null;
let chatHistory = [];
let pendingResume = false;
let intentionalDisconnect = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let dismissedVoteRevealId = 0;
let currentOpenVoteRevealId = null;
let lastChatSendAt = 0;
let selectedVoteSlotIndex = null;
let votePickConfirmed = false;
/** 等候廳「產製圖庫」折疊區是否展開（預設收合，只顯示選圖庫＋套用） */
let deckGenPanelExpanded = false;

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${WS_PATH}`;
}

function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._tid);
  toast._tid = setTimeout(() => t.classList.add("hidden"), 3200);
}

function send(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast("尚未連線，請稍候");
    return;
  }
  ws.send(JSON.stringify(msg));
}

function setConn(ok) {
  const pill = el("conn-pill");
  pill.textContent = ok ? "已連線" : "離線";
  pill.classList.toggle("pill-online", ok);
  pill.classList.toggle("pill-offline", !ok);
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o?.roomCode || !o?.playerId || !o?.sessionToken) return null;
    return o;
  } catch {
    return null;
  }
}

function saveSession(data) {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      roomCode: data.roomCode,
      playerId: data.playerId,
      sessionToken: data.sessionToken,
    })
  );
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function setRouteToRoom(code) {
  const c = String(code || "").toUpperCase();
  if (!/^[A-F0-9]{6}$/.test(c)) return;
  const base = `${location.pathname}${location.search}`;
  history.replaceState(null, "", `${base}#/r/${c}`);
}

function setRouteToLobby() {
  const base = `${location.pathname}${location.search}`;
  history.replaceState(null, "", `${base}#/`);
}

function parseRoute() {
  const raw = (location.hash || "#").replace(/^#/, "");
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  const m = path.match(/^\/r\/([A-Fa-f0-9]{6})\/?$/i);
  if (m) return { type: "room", roomCode: m[1].toUpperCase() };
  return { type: "lobby" };
}

function applyRouteToForm() {
  const r = parseRoute();
  if (r.type === "room") el("input-room").value = r.roomCode;
}

function clearReconnectTimer() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function leaveRoomClient() {
  clearReconnectTimer();
  if (ws && ws.readyState === WebSocket.OPEN) {
    intentionalDisconnect = true;
    send({ type: "leave_room" });
    return;
  }
  intentionalDisconnect = false;
  clearSession();
  setRouteToLobby();
  playerId = null;
  roomCode = null;
  chatHistory = [];
  setChatDockVisible(false);
  showLobby();
  renderChat();
}

function setChatDockVisible(on) {
  el("chat-dock").classList.toggle("hidden", !on);
}

function formatChatTime(ts) {
  try {
    return new Intl.DateTimeFormat("zh-TW", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

function renderChat() {
  const log = el("chat-log");
  log.innerHTML = "";
  for (const m of chatHistory) {
    const row = document.createElement("div");
    const isSys = Boolean(m.system);
    const isMe = !isSys && m.playerId === playerId;
    row.className = `chat-line${isSys ? " system" : ""}${isMe ? " me" : ""}`;
    if (isSys) {
      row.textContent = m.text;
    } else {
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = `${m.name || "玩家"} `;
      const body = document.createElement("span");
      body.className = "chat-msg-body";
      body.textContent = m.text ?? "";
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = formatChatTime(m.ts);
      row.appendChild(who);
      row.appendChild(body);
      row.appendChild(when);
    }
    log.appendChild(row);
  }
  log.scrollTop = log.scrollHeight;
}

function syncChatFromServer(list) {
  chatHistory = Array.isArray(list) ? list.map((x) => ({ ...x })) : [];
  renderChat();
}

function connectWebSocket() {
  clearReconnectTimer();
  ws = new WebSocket(wsUrl());

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    setConn(true);
    const saved = loadSession();
    if (saved?.roomCode && saved?.playerId && saved?.sessionToken) {
      pendingResume = true;
      send({
        type: "resume_session",
        roomCode: saved.roomCode,
        playerId: saved.playerId,
        sessionToken: saved.sessionToken,
      });
      return;
    }
    pendingResume = false;
    applyRouteToForm();
  });

  ws.addEventListener("close", () => {
    setConn(false);
    clearReconnectTimer();
    if (intentionalDisconnect) {
      intentionalDisconnect = false;
      reconnectAttempts = 0;
      clearSession();
      setRouteToLobby();
      playerId = null;
      roomCode = null;
      chatHistory = [];
      setChatDockVisible(false);
      showLobby();
      renderChat();
      return;
    }
    if (loadSession() && reconnectAttempts < MAX_RECONNECT) {
      reconnectAttempts += 1;
      toast("連線中斷，正自動重連…");
      const delay = Math.min(4000, 400 + reconnectAttempts * 350);
      reconnectTimer = setTimeout(() => connectWebSocket(), delay);
      return;
    }
    reconnectAttempts = 0;
    toast("無法重連，請檢查網路或重新加入房間");
    playerId = null;
    roomCode = null;
    chatHistory = [];
    setChatDockVisible(false);
    showLobby();
    renderChat();
  });

  ws.addEventListener("message", (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (data.type === "error") {
      if (pendingResume) {
        pendingResume = false;
        clearSession();
        setRouteToLobby();
      }
      playError();
      toast(data.message || "發生錯誤");
      return;
    }
    if (data.type === "left_room") {
      deckGenPanelExpanded = false;
      clearSession();
      setRouteToLobby();
      playerId = null;
      roomCode = null;
      chatHistory = [];
      setChatDockVisible(false);
      showLobby();
      renderChat();
      return;
    }
    if (data.type === "joined") {
      deckGenPanelExpanded = false;
      pendingResume = false;
      reconnectAttempts = 0;
      playerId = data.playerId;
      roomCode = data.roomCode;
      if (data.sessionToken) {
        saveSession({
          roomCode,
          playerId,
          sessionToken: data.sessionToken,
        });
        setRouteToRoom(roomCode);
      }
      el("room-code-display").textContent = roomCode;
      syncChatFromServer(data.chat);
      setChatDockVisible(true);
      showRoom();
      playJoin();
      return;
    }
    if (data.type === "chat") {
      const prevLen = chatHistory.length;
      syncChatFromServer(data.chat);
      const last = chatHistory[chatHistory.length - 1];
      if (
        chatHistory.length > prevLen &&
        last &&
        last.playerId != null &&
        last.playerId !== playerId &&
        !last.system
      ) {
        playChat();
      }
      return;
    }
    if (data.type === "state") {
      const prev = lastState;
      lastState = data.state;
      renderState(data.state, prev);
    }
  });
}

function showLobby() {
  setChatDockVisible(false);
  el("panel-lobby").classList.remove("hidden");
  el("panel-room").classList.add("hidden");
  el("panel-game").classList.add("hidden");
}

function showRoom() {
  if (roomCode && playerId) setChatDockVisible(true);
  el("panel-lobby").classList.add("hidden");
  el("panel-room").classList.remove("hidden");
  el("panel-game").classList.add("hidden");
}

function showGame() {
  if (roomCode && playerId) setChatDockVisible(true);
  el("panel-lobby").classList.add("hidden");
  el("panel-room").classList.add("hidden");
  el("panel-game").classList.remove("hidden");
}

function renderLobbyHints(state) {
  if (state?.minPlayers) el("min-p").textContent = String(state.minPlayers);
  if (state?.maxPlayers) el("max-p").textContent = String(state.maxPlayers);
}

function renderState(state, prevState = null) {
  maybePlayStateSfx(prevState, state);
  renderLobbyHints(state);
  if (state.phase === "lobby") {
    if (roomCode && playerId) {
      showRoom();
      renderRoom(state);
    } else {
      showLobby();
    }
    return;
  }
  showGame();
  renderGame(state);
}

function renderRoom(state) {
  const list = el("player-list");
  list.innerHTML = "";
  for (const p of state.players || []) {
    const li = document.createElement("li");
    const isHost = p.id === state.hostId;
    const isMe = p.id === playerId;
    const roleBadge = `<span class="badge ${isHost ? "host" : ""}">${isHost ? "房主" : "玩家"}</span>`;
    const dcBadge = p.disconnected ? '<span class="badge dc">離線</span>' : "";
    li.innerHTML = `<span>${escapeHtml(p.name)}${isMe ? "（你）" : ""}</span><span>${roleBadge}${dcBadge}</span>`;
    list.appendChild(li);
  }
  const canStart = playerId === state.hostId && (state.players?.length || 0) >= state.minPlayers;
  const btn = el("btn-start");
  btn.classList.toggle("hidden", !canStart);
  el("hint-room").textContent =
    (state.players?.length || 0) < state.minPlayers ? `還需要至少 ${state.minPlayers - (state.players?.length || 0)} 位玩家才能開始。` : "人數已夠，房主可以開始遊戲。";

  const blockDeck = el("block-deck");
  if (blockDeck) {
    blockDeck.classList.remove("hidden");
    const decks = state.availableDecks || [];
    const n = decks.length;
    const deckKeyOf = (e) => (typeof e === "string" ? e : e?.key ?? "");
    const cur = decks.find((e) => deckKeyOf(e) === state.cardDeck);
    const detail =
      cur && typeof cur === "object" && typeof cur.cards === "number"
        ? ` — ${cur.cards} 張牌（${cur.sheets} 張九宮圖）`
        : "";
    el("deck-active-label").textContent = `本房間圖庫：${state.cardDeck || "—"}${detail}（${n} 組卡組資料夾）`;
    const isHost = playerId === state.hostId;
    el("deck-host-controls").classList.toggle("hidden", !isHost);
    if (isHost) {
      const sel = el("select-card-deck");
      sel.innerHTML = "";
      for (const entry of decks) {
        const k = deckKeyOf(entry);
        const o = document.createElement("option");
        o.value = k;
        o.textContent =
          typeof entry === "object" && entry != null && typeof entry.cards === "number"
            ? `${k}（${entry.cards} 張）`
            : k;
        if (k === state.cardDeck) o.selected = true;
        sel.appendChild(o);
      }
      if (!decks.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = "（尚無圖檔，請產製或放入 data）";
        sel.appendChild(o);
      }
      const coll = el("deck-gen-collapsible");
      const toggle = el("btn-deck-gen-toggle");
      if (coll) coll.classList.toggle("hidden", !deckGenPanelExpanded);
      if (toggle) {
        toggle.textContent = deckGenPanelExpanded ? "收合產製區" : "展開：產製圖庫…";
        toggle.setAttribute("aria-expanded", deckGenPanelExpanded ? "true" : "false");
        toggle.setAttribute("aria-controls", "deck-gen-collapsible");
      }

      const btnGen = el("btn-generate-deck");
      if (btnGen) {
        btnGen.disabled = false;
        btnGen.removeAttribute("title");
      }
    }
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function closeVoteRevealModal() {
  el("vote-result-modal").classList.add("hidden");
  if (currentOpenVoteRevealId != null) {
    dismissedVoteRevealId = currentOpenVoteRevealId;
    currentOpenVoteRevealId = null;
  }
}

function maybeShowVoteRevealModal(state) {
  const vr = state.lastRoundSummary?.voteReveal;
  if (!vr?.id) return;
  if (vr.id === dismissedVoteRevealId) return;
  if (currentOpenVoteRevealId === vr.id) return;

  currentOpenVoteRevealId = vr.id;
  const deltas = vr.scoreDeltas || {};
  const rawDelta = deltas[playerId] ?? deltas[String(playerId)];
  const myDelta = rawDelta != null && rawDelta !== "" ? Number(rawDelta) : 0;
  let myLine = "你本回合沒有加分。";
  if (Number.isFinite(myDelta) && myDelta > 0) myLine = `你本回合 +${myDelta} 分。`;
  else if (Number.isFinite(myDelta) && myDelta < 0) myLine = `你本回合 ${myDelta} 分。`;
  el("vote-result-my").textContent = myLine;
  el("vote-result-sub").textContent = `上回合說書人：${vr.roundStorytellerName || ""}`;

  el("vote-result-rule").textContent = state.lastRoundSummary.rule || "";

  const body = el("vote-result-body");
  body.innerHTML = "";
  const ul = document.createElement("ul");
  ul.className = "modal-list";
  for (const line of vr.voterLines || []) {
    const li = document.createElement("li");
    li.textContent = line;
    ul.appendChild(li);
  }
  body.appendChild(ul);

  const bySlot = vr.bySlot || [];
  if (bySlot.length) {
    const cap = document.createElement("p");
    cap.className = "modal-cap";
    cap.textContent = "依圖卡（牌主與投票者）";
    body.appendChild(cap);
    const ul2 = document.createElement("ul");
    ul2.className = "modal-list";
    for (const row of bySlot) {
      const li = document.createElement("li");
      const tag = row.isStorytellerCard ? "（說書人牌）" : "";
      const voters = (row.voterNames || []).length ? row.voterNames.join("、") : "無人";
      li.textContent = `「${row.ownerName}」的圖${tag}：${voters}`;
      ul2.appendChild(li);
    }
    body.appendChild(ul2);
  }

  const storyBox = el("vote-result-story-box");
  const storyUl = el("vote-result-story-list");
  if (playerId === vr.roundStorytellerId) {
    storyBox.classList.remove("hidden");
    storyUl.innerHTML = "";
    for (const line of vr.storytellerNudges || []) {
      const li = document.createElement("li");
      li.textContent = line;
      storyUl.appendChild(li);
    }
  } else {
    storyBox.classList.add("hidden");
  }

  el("vote-result-detail").classList.add("hidden");
  el("vote-result-toggle-detail").textContent = "展開：誰選了誰的牌";

  el("vote-result-modal").classList.remove("hidden");
}

function renderGame(state) {
  const strip = el("score-strip");
  strip.innerHTML = (state.players || [])
    .map((p) => {
      const me = p.id === playerId ? "me" : "";
      const dc = p.disconnected ? " dc" : "";
      const off = p.disconnected ? " · 離線" : "";
      return `<span class="${me}${dc}">${escapeHtml(p.name)} · ${p.score} 分${off}</span>`;
    })
    .join("");

  const deckHint = el("game-deck-hint");
  if (deckHint) {
    if (state.cardDeck) {
      deckHint.textContent = `圖庫：${state.cardDeck}`;
      deckHint.classList.remove("hidden");
    } else {
      deckHint.classList.add("hidden");
    }
  }

  const title = el("phase-title");
  const desc = el("phase-desc");
  const clue = el("clue-display");
  const blockClue = el("block-clue");
  const blockHand = el("block-hand");
  const blockSubmitWait = el("block-submit-wait");
  const blockVote = el("block-vote");
  const blockSummary = el("block-summary");
  const blockGameOver = el("block-game-over");

  if (state.phase === "gameover") {
    maybeShowVoteRevealModal(state);
    clue.classList.add("hidden");
    blockClue.classList.add("hidden");
    blockHand.classList.add("hidden");
    blockSubmitWait.classList.add("hidden");
    blockVote.classList.add("hidden");
    blockSummary.classList.add("hidden");
    el("vote-wait").classList.add("hidden");
    el("btn-send-card").classList.add("hidden");
    selectedVoteSlotIndex = null;
    votePickConfirmed = false;

    title.textContent = "遊戲結束";
    desc.textContent = "";
    const go = state.gameOver;

    const lead = el("game-over-lead");
    if (lead) lead.textContent = go?.messageZh || "";

    const wsEl = el("game-over-win-score");
    if (wsEl != null && state.winScoreTarget != null) wsEl.textContent = String(state.winScoreTarget);

    const ol = el("game-over-ranks");
    if (ol) {
      ol.innerHTML = "";
      for (const row of go?.leaderboard || []) {
        const li = document.createElement("li");
        li.className = row.id === playerId ? "me" : "";
        li.textContent = `第 ${row.rank} 名 · ${row.name} · ${row.score} 分`;
        ol.appendChild(li);
      }
    }

    const btnRet = el("btn-return-lobby");
    const waitHost = el("game-over-wait-host");
    const isHost = playerId === state.hostId;
    if (btnRet) {
      btnRet.classList.toggle("hidden", !isHost);
    }
    if (waitHost) {
      waitHost.classList.toggle("hidden", isHost);
    }
    if (blockGameOver) blockGameOver.classList.remove("hidden");
    return;
  }

  if (blockGameOver) blockGameOver.classList.add("hidden");

  if (state.phase !== "vote") {
    selectedVoteSlotIndex = null;
    votePickConfirmed = false;
  }

  clue.classList.add("hidden");
  blockClue.classList.add("hidden");
  blockHand.classList.remove("hidden");
  blockSubmitWait.classList.add("hidden");
  blockVote.classList.add("hidden");
  blockSummary.classList.add("hidden");
  el("vote-wait").classList.add("hidden");

  const stId = state.storytellerId;
  const imStory = playerId === stId;

  if (state.currentClue) {
    clue.textContent = `「${state.currentClue}」`;
    clue.classList.remove("hidden");
  }

  if (state.phase === "clue") {
    title.textContent = imStory ? "你是說書人" : "等待說書人";
    desc.textContent = imStory
      ? "選一張手牌，寫下能讓部分人猜中、但不會讓所有人都猜中的提示。"
      : "說書人正在構思提示與選牌…";
    if (imStory) blockClue.classList.remove("hidden");
    if (state.lastRoundSummary?.rule && !state.lastRoundSummary?.voteReveal) {
      blockSummary.classList.remove("hidden");
      const r = state.lastRoundSummary;
      blockSummary.innerHTML = `<strong>上回合結算</strong><br>${escapeHtml(r.rule || "")}`;
    }
    el("btn-send-card").classList.add("hidden");
    renderHand(state, "clue");
    maybeShowVoteRevealModal(state);
    return;
  }

  if (state.phase === "submit") {
    title.textContent = imStory ? "說書人 · 等待中" : "選一張牌";
    desc.textContent = imStory
      ? "其他玩家會選一張牌來呼應你的提示。請稍待。"
      : "選一張最符合提示的牌，它會與說書人的牌混在一起。";
    if (imStory) {
      blockHand.classList.add("hidden");
      blockSubmitWait.classList.remove("hidden");
    } else if (state.submitDone) {
      blockHand.classList.add("hidden");
      blockSubmitWait.classList.remove("hidden");
    } else {
      renderHand(state, "submit");
      el("btn-send-card").classList.remove("hidden");
    }
    return;
  }

  if (state.phase === "vote") {
    title.textContent = imStory ? "說書人 · 旁觀投票" : "投票";
    desc.textContent = imStory
      ? "你不能投票，看看大家如何解讀你的提示。"
      : "點選你認為是說書人出的那張圖（不能選自己出的牌），再依序按兩個確認按鈕才會送出。";
    blockHand.classList.add("hidden");
    blockVote.classList.remove("hidden");
    renderVote(state, imStory);
    return;
  }

  title.textContent = "遊戲中";
  desc.textContent = "";
}

function renderHand(state, mode) {
  const hand = el("hand");
  hand.innerHTML = "";
  selectedCardId = null;
  const images = state.myHandImages || [];
  const n = images.length;
  hand.className = n <= 1 ? "hand hand--fan hand--fan--solo" : "hand hand--fan";

  images.forEach((item, i) => {
    const div = document.createElement("div");
    div.className = "card-tile";
    div.dataset.cardId = String(item.cardId);
    const inner = document.createElement("div");
    inner.className = "card-tile-inner";
    const img = document.createElement("img");
    img.src = item.imageUrl;
    img.alt = `圖卡 ${item.cardId}`;
    img.loading = "lazy";
    inner.appendChild(img);
    div.appendChild(inner);

    if (n > 1) {
      const mid = (n - 1) / 2;
      const spread = n > 5 ? 4.2 : n > 3 ? 5.8 : 7.2;
      const rot = (i - mid) * spread;
      const arc = Math.abs(i - mid) * 2.2;
      div.style.setProperty("--hand-rot", `${rot.toFixed(2)}deg`);
      div.style.setProperty("--hand-y", `${arc.toFixed(1)}px`);
      div.style.setProperty("--hand-z", String(10 + i));
    } else {
      div.style.setProperty("--hand-rot", "0deg");
      div.style.setProperty("--hand-y", "0px");
      div.style.setProperty("--hand-z", "20");
    }

    div.addEventListener("click", () => {
      if (mode === "clue" || mode === "submit") {
        playPick();
        [...hand.children].forEach((c) => c.classList.remove("selected"));
        div.classList.add("selected");
        selectedCardId = item.cardId;
      }
    });
    hand.appendChild(div);
  });
}

function syncVoteActionUI(state) {
  const actions = el("vote-actions");
  const btn1 = el("btn-vote-confirm-pick");
  const btn2 = el("btn-vote-submit");
  if (!actions || !btn1 || !btn2) return;
  const imStory = playerId === state?.storytellerId;
  const canVote = state?.phase === "vote" && !imStory && !state?.myVoteDone;
  if (!canVote) {
    actions.classList.add("hidden");
    return;
  }
  actions.classList.remove("hidden");
  btn1.disabled = selectedVoteSlotIndex === null || votePickConfirmed;
  btn2.disabled = !votePickConfirmed;
  btn1.textContent =
    votePickConfirmed && selectedVoteSlotIndex !== null ? "已確認選擇" : "第一步：確認選擇此圖";
}

function initVoteConfirmButtons() {
  const actions = el("vote-actions");
  if (!actions || actions.dataset.inited) return;
  actions.dataset.inited = "1";
  el("btn-vote-confirm-pick").addEventListener("click", () => {
    if (selectedVoteSlotIndex == null || votePickConfirmed) return;
    playTap();
    votePickConfirmed = true;
    syncVoteActionUI(lastState);
  });
  el("btn-vote-submit").addEventListener("click", () => {
    if (!votePickConfirmed || selectedVoteSlotIndex == null || !lastState || lastState.phase !== "vote") return;
    send({ type: "submit_vote", slotIndex: selectedVoteSlotIndex });
    selectedVoteSlotIndex = null;
    votePickConfirmed = false;
    syncVoteActionUI(lastState);
  });
}

function renderVote(state, imStory) {
  const grid = el("vote-grid");
  grid.innerHTML = "";
  const slots = state.revealSlots || [];
  const canVote = !imStory && !state.myVoteDone;
  const mySlot = typeof state.myVoteSlotIndex === "number" ? state.myVoteSlotIndex : null;

  if (state.myVoteDone) {
    selectedVoteSlotIndex = null;
    votePickConfirmed = false;
  } else if (selectedVoteSlotIndex !== null) {
    if (!Number.isInteger(selectedVoteSlotIndex) || selectedVoteSlotIndex < 0 || selectedVoteSlotIndex >= slots.length) {
      selectedVoteSlotIndex = null;
      votePickConfirmed = false;
    } else if (mySlot !== null && selectedVoteSlotIndex === mySlot) {
      selectedVoteSlotIndex = null;
      votePickConfirmed = false;
    }
  }

  for (const s of slots) {
    const wrap = document.createElement("div");
    wrap.className = "vote-slot-wrap";
    wrap.dataset.slotIndex = String(s.slotIndex);

    const isOwnSubmission = mySlot !== null && s.slotIndex === mySlot;

    const media = document.createElement("div");
    media.className = "vote-slot-media";
    const img = document.createElement("img");
    img.src = s.imageUrl;
    img.alt = `選項 ${s.slotIndex + 1}`;
    img.draggable = false;
    media.appendChild(img);
    if (isOwnSubmission && canVote) {
      wrap.classList.add("vote-slot-wrap--own-card");
      media.classList.add("vote-slot-media--own");
      const badge = document.createElement("span");
      badge.className = "vote-slot-own-badge";
      badge.textContent = "你出的牌";
      media.appendChild(badge);
    }
    if (canVote && !isOwnSubmission) {
      media.classList.add("vote-slot-media--clickable");
      media.addEventListener("click", () => {
        playPick();
        selectedVoteSlotIndex = s.slotIndex;
        votePickConfirmed = false;
        grid.querySelectorAll(".vote-slot-media--selected").forEach((m) => m.classList.remove("vote-slot-media--selected"));
        media.classList.add("vote-slot-media--selected");
        syncVoteActionUI(state);
      });
    }

    const rx = document.createElement("div");
    rx.className = "vote-slot-reactions";
    for (const r of s.reactions || []) {
      const pill = document.createElement("span");
      pill.className = "rx-pill";
      pill.title = r.name || "";
      pill.textContent = r.emoji || "";
      rx.appendChild(pill);
    }

    const bar = document.createElement("div");
    bar.className = "vote-slot-emoji-bar";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "emoji-drawer-toggle emoji-drawer-toggle--slot";
    toggle.textContent = "😊";
    toggle.setAttribute("aria-expanded", "false");
    const panel = document.createElement("div");
    panel.className = "emoji-drawer-panel emoji-drawer-panel--slot hidden";
    for (const em of QUICK_EMOJIS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "emoji-pick";
      b.textContent = em;
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        playPick();
        send({ type: "react_card", slotIndex: s.slotIndex, emoji: em });
        panel.classList.add("hidden");
        toggle.setAttribute("aria-expanded", "false");
      });
      panel.appendChild(b);
    }
    toggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const willOpen = panel.classList.contains("hidden");
      document.querySelectorAll(".emoji-drawer-panel--slot").forEach((p) => p.classList.add("hidden"));
      document.querySelectorAll(".emoji-drawer-toggle--slot").forEach((t) => t.setAttribute("aria-expanded", "false"));
      if (willOpen) {
        panel.classList.remove("hidden");
        toggle.setAttribute("aria-expanded", "true");
      }
    });
    bar.appendChild(toggle);
    bar.appendChild(panel);
    wrap.appendChild(media);
    wrap.appendChild(rx);
    wrap.appendChild(bar);
    grid.appendChild(wrap);
  }

  if (canVote && selectedVoteSlotIndex !== null) {
    const w = grid.querySelector(`[data-slot-index="${selectedVoteSlotIndex}"]`);
    const m = w?.querySelector(".vote-slot-media");
    if (m && !w.classList.contains("vote-slot-wrap--own-card")) m.classList.add("vote-slot-media--selected");
  }

  syncVoteActionUI(state);
  if (!imStory && state.myVoteDone) el("vote-wait").classList.remove("hidden");
}

function initChatEmojiDrawer() {
  const panel = el("chat-emoji-panel");
  const btn = el("btn-chat-emoji-toggle");
  if (!panel || !btn || panel.dataset.inited) return;
  panel.dataset.inited = "1";
  for (const em of QUICK_EMOJIS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "emoji-pick";
    b.setAttribute("aria-label", `插入 ${em}`);
    b.textContent = em;
    b.addEventListener("click", () => {
      const inp = el("chat-input");
      if (!inp) return;
      if ((inp.value + em).length > Number(inp.maxLength)) return;
      inp.value += em;
      inp.focus();
      panel.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    });
    panel.appendChild(b);
  }
  btn.addEventListener("click", () => {
    panel.classList.toggle("hidden");
    btn.setAttribute("aria-expanded", String(!panel.classList.contains("hidden")));
  });
}

el("btn-create").addEventListener("click", () => {
  clearSession();
  setRouteToLobby();
  pendingResume = false;
  const name = el("input-name").value.trim() || "玩家";
  send({ type: "create_room", name });
});

el("btn-join").addEventListener("click", () => {
  clearSession();
  setRouteToLobby();
  pendingResume = false;
  const name = el("input-name").value.trim() || "玩家";
  const code = el("input-room").value.trim().toUpperCase();
  send({ type: "join_room", roomCode: code, name });
});

el("btn-clear-session").addEventListener("click", () => {
  if (playerId && ws && ws.readyState === WebSocket.OPEN) {
    leaveRoomClient();
  } else {
    clearSession();
    setRouteToLobby();
    pendingResume = false;
  }
  toast("已清除本機紀錄（若在房中會一併離開）");
});

for (const b of document.querySelectorAll(".btn-leave-room")) {
  b.addEventListener("click", () => leaveRoomClient());
}

el("btn-start").addEventListener("click", () => {
  send({ type: "start_game" });
});

el("btn-return-lobby")?.addEventListener("click", () => {
  send({ type: "return_to_lobby" });
});

el("btn-deck-gen-toggle").addEventListener("click", () => {
  deckGenPanelExpanded = !deckGenPanelExpanded;
  const coll = el("deck-gen-collapsible");
  const toggle = el("btn-deck-gen-toggle");
  if (coll) coll.classList.toggle("hidden", !deckGenPanelExpanded);
  if (toggle) {
    toggle.textContent = deckGenPanelExpanded ? "收合產製區" : "展開：產製圖庫…";
    toggle.setAttribute("aria-expanded", deckGenPanelExpanded ? "true" : "false");
  }
});

el("btn-apply-deck").addEventListener("click", () => {
  const sel = el("select-card-deck");
  const v = sel?.value?.trim();
  if (!v) {
    toast("請先選擇圖庫");
    return;
  }
  send({ type: "set_card_deck", deckKey: v });
});

el("btn-generate-deck").addEventListener("click", async () => {
  const openaiApiKey = el("input-openai-api-key")?.value?.trim() || "";
  if (openaiApiKey.length < 8) {
    toast("請填寫 OpenAI API 金鑰");
    return;
  }
  const stylePrompt = el("input-deck-style")?.value?.trim() || "";
  const deckName = el("input-deck-name")?.value?.trim() || "";
  if (stylePrompt.length < 2) {
    toast("請至少輸入 2 個字的畫風／主題");
    return;
  }
  if (!deckName || deckName.length < 2) {
    toast("請填存檔檔名");
    return;
  }
  const sess = loadSession();
  if (!roomCode || !playerId || !sess?.sessionToken) {
    toast("房間狀態異常，請重新加入");
    return;
  }
  const rc = String(roomCode).trim().toUpperCase().replace(/[^A-F0-9]/g, "");
  if (rc.length !== 6) {
    toast("房間碼異常，請離開房間後重新加入");
    return;
  }
  const status = el("deck-gen-status");
  const btn = el("btn-generate-deck");
  status.classList.remove("hidden");
  status.textContent = "產圖中（單張 3×3 九宮，將存入卡組資料夾並切出 9 張牌）…";
  btn.disabled = true;
  try {
    const r = await fetch("/api/generate-deck", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomCode: rc,
        playerId,
        sessionToken: sess.sessionToken,
        openaiApiKey,
        stylePrompt,
        deckKey: deckName,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast(j.error || `產圖失敗（${r.status}）`);
      status.textContent = j.error || "失敗";
      return;
    }
    toast(`已將九宮圖存入資料夾「${j.deckKey || deckName}」並套用`);
    status.textContent = "完成，已套用新圖庫。";
    el("input-deck-style").value = "";
    const keyIn = el("input-openai-api-key");
    if (keyIn) keyIn.value = "";
  } catch (e) {
    toast("網路錯誤，產圖失敗");
    status.textContent = String(e.message || e);
  } finally {
    btn.disabled = false;
  }
});

el("btn-send-clue").addEventListener("click", () => {
  const clue = el("input-clue").value.trim();
  if (!clue) {
    toast("請填寫提示");
    return;
  }
  if (selectedCardId == null) {
    toast("請先點選一張手牌");
    return;
  }
  send({ type: "submit_clue", clue, cardId: selectedCardId });
  el("input-clue").value = "";
});

el("btn-send-card").addEventListener("click", () => {
  if (selectedCardId == null) {
    toast("請先點選一張手牌");
    return;
  }
  send({ type: "submit_card", cardId: selectedCardId });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("vote-result-modal").classList.contains("hidden")) {
    closeVoteRevealModal();
    return;
  }
  if (e.key !== "Enter" || e.shiftKey) return;
  if (e.isComposing || e.keyCode === 229) return;
  if (el("block-clue") && !el("block-clue").classList.contains("hidden")) {
    if (document.activeElement === el("chat-input")) return;
    const clueInput = el("input-clue");
    if (document.activeElement === clueInput && clueInput.dataset.ime === "1") return;
    el("btn-send-clue").click();
  }
});

function sendChatFromInput() {
  const now = Date.now();
  if (now - lastChatSendAt < 220) return;
  const input = el("chat-input");
  const text = input.value.trim();
  if (!text) return;
  lastChatSendAt = now;
  playTap();
  send({ type: "chat", text });
  input.value = "";
}

el("btn-chat-send").addEventListener("click", sendChatFromInput);

el("chat-input").addEventListener("keyup", (e) => {
  if (e.key !== "Enter" || e.shiftKey) return;
  if (e.repeat) return;
  if (e.isComposing) return;
  sendChatFromInput();
});

el("input-clue").addEventListener("compositionstart", () => {
  el("input-clue").dataset.ime = "1";
});
el("input-clue").addEventListener("compositionend", () => {
  delete el("input-clue").dataset.ime;
});

el("vote-result-close").addEventListener("click", () => closeVoteRevealModal());
el("vote-result-modal").addEventListener("click", (e) => {
  if (e.target.classList.contains("modal-backdrop")) closeVoteRevealModal();
});

window.addEventListener("hashchange", () => {
  applyRouteToForm();
});

applyRouteToForm();
updateSfxToggleUi();
el("btn-sfx-toggle")?.addEventListener("click", () => {
  toggleSfxMuted();
  updateSfxToggleUi();
});

initChatEmojiDrawer();
initVoteConfirmButtons();
connectWebSocket();

el("vote-result-toggle-detail").addEventListener("click", () => {
  const d = el("vote-result-detail");
  d.classList.toggle("hidden");
  el("vote-result-toggle-detail").textContent = d.classList.contains("hidden") ? "展開：誰選了誰的牌" : "收合詳情";
});
