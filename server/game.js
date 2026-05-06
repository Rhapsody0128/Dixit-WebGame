import { randomBytes, randomUUID } from "crypto";
import path from "path";
import {
  DATA_DIR,
  deckFolderExists,
  getDeckCardCount,
  getDeckSheetCount,
  listDeckKeys,
  listDeckSheetFiles,
  pickDefaultDeckKey,
  resolveDeckFolder,
} from "./spriteDeck.js";

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;
const HAND_SIZE = 6;
const CHAT_MAX = 120;
/** 任一玩家達到此分數（含以上）則本回合結算後遊戲結束 */
const WIN_SCORE = 30;

function normalizeEmoji(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let g;
  try {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      const seg = new Intl.Segmenter("und", { granularity: "grapheme" });
      g = [...seg.segment(s)][0]?.segment ?? "";
    } else {
      g = [...s][0] ?? "";
    }
  } catch {
    g = [...s][0] ?? "";
  }
  if (!g || [...g].length > 12) return null;
  if (!/\p{Extended_Pictographic}/u.test(g)) return null;
  return g;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cardUrl(cardId, deckKey) {
  return `/cards/${encodeURIComponent(deckKey)}/${Number(cardId)}`;
}

export class GameRoom {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.hostId = null;
    this.phase = "lobby";
    this.deck = [];
    this.storytellerIndex = 0;
    this.currentClue = "";
    this.storytellerCard = null;
    this.submissions = new Map();
    this.revealOrder = [];
    this.slotToPlayerId = [];
    this.votes = new Map();
    this.lastRoundSummary = null;
    this.chatMessages = [];
    this.slotReactions = [];
    this.cardDeck = pickDefaultDeckKey(DATA_DIR);
    /** @type {null | { reason: string; winScore: number; leaderboard: Array<{ rank: number; name: string; score: number; id: string }>; messageZh: string }} */
    this.gameOver = null;
  }

  validateSession(playerId, token) {
    const p = this.players.get(playerId);
    return Boolean(p && p.sessionToken === String(token || ""));
  }

  setCardDeck(playerId, deckKey) {
    if (this.phase !== "lobby") return { error: "僅在等候廳可更換圖庫" };
    if (playerId !== this.hostId) return { error: "僅房主可設定圖庫" };
    const folder = resolveDeckFolder(DATA_DIR, deckKey);
    if (!folder || listDeckSheetFiles(folder).length === 0) {
      return { error: "找不到該圖庫資料夾（請確認 data/{卡組名}/ 內有 JPG／PNG／WebP）" };
    }
    this.cardDeck = path.basename(folder);
    return {};
  }

  getChatSnapshot() {
    return this.chatMessages.map((m) => ({ ...m }));
  }

  _pushChat(entry) {
    this.chatMessages.push(entry);
    if (this.chatMessages.length > CHAT_MAX) {
      this.chatMessages.splice(0, this.chatMessages.length - CHAT_MAX);
    }
  }

  appendSystemChat(text) {
    const t = String(text || "").trim().slice(0, 200);
    if (!t) return;
    this._pushChat({ playerId: null, name: "系統", text: t, ts: Date.now(), system: true });
  }

  appendChat(playerId, text) {
    const pl = this.players.get(playerId);
    if (!pl) return { error: "找不到玩家" };
    const t = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (t.length < 1 || t.length > 300) return { error: "訊息須為 1–300 字" };
    this._pushChat({ playerId, name: pl.name, text: t, ts: Date.now(), system: false });
    return {};
  }

  addPlayer(name, send) {
    if (this.players.size >= MAX_PLAYERS) return { error: "房間已滿" };
    if (this.phase !== "lobby") return { error: "遊戲進行中無法加入" };
    const id = randomUUID();
    const sessionToken = randomBytes(24).toString("hex");
    const player = {
      id,
      name: name.slice(0, 12) || "玩家",
      hand: [],
      score: 0,
      send,
      sessionToken,
      disconnected: false,
    };
    this.players.set(id, player);
    if (!this.hostId) this.hostId = id;
    return { id, player };
  }

  markSoftDisconnect(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.disconnected = true;
    p.send = () => {};
  }

  resumePlayer(playerId, sessionToken, send) {
    const p = this.players.get(playerId);
    if (!p || p.sessionToken !== sessionToken) return { error: "恢復連線失敗，請重新加入房間" };
    p.disconnected = false;
    p.sessionToken = randomBytes(24).toString("hex");
    p.send = send;
    return {};
  }

  evictDisconnectedPlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p || !p.disconnected) return { emptied: false };
    this.appendSystemChat(`${p.name} 已離開房間`);
    this.removePlayer(playerId);
    return { emptied: this.players.size === 0 };
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    this.players.delete(playerId);
    if (this.hostId === playerId) {
      const first = this.players.keys().next().value;
      this.hostId = first ?? null;
    }
    if (this.phase !== "lobby" && this.phase !== "gameover" && this.players.size < MIN_PLAYERS) {
      this.resetToLobby("人數不足，遊戲已結束");
    }
  }

  resetToLobby(reason) {
    this.phase = "lobby";
    this.gameOver = null;
    this.deck = [];
    this.storytellerIndex = 0;
    this.currentClue = "";
    this.storytellerCard = null;
    this.submissions.clear();
    this.revealOrder = [];
    this.slotToPlayerId = [];
    this.votes.clear();
    this.slotReactions = [];
    this.lastRoundSummary = reason ? { message: reason } : null;
    for (const pl of this.players.values()) {
      pl.hand = [];
      pl.score = 0;
    }
  }

  startGame(playerId) {
    if (this.phase !== "lobby") return { error: "無法開始" };
    if (playerId !== this.hostId) return { error: "只有房主可以開始" };
    if (this.players.size < MIN_PLAYERS) return { error: `至少需要 ${MIN_PLAYERS} 位玩家` };
    if (!deckFolderExists(DATA_DIR, this.cardDeck)) {
      return { error: "找不到圖庫資料夾（data/），請房主先套用或產製圖庫" };
    }
    const total = getDeckCardCount(DATA_DIR, this.cardDeck);
    const minNeeded = this.players.size * HAND_SIZE + 16;
    if (total < minNeeded) {
      return {
        error: `圖庫牌張不足：目前 ${total} 張（約需 ${minNeeded} 張以上才能順利遊玩），請在該卡組資料夾放入更多 3×3 九宮圖檔`,
      };
    }

    this.deck = shuffle(Array.from({ length: total }, (_, i) => i + 1));
    for (const pl of this.players.values()) {
      pl.hand = [];
      pl.score = 0;
    }
    const list = [...this.players.values()];
    for (let h = 0; h < HAND_SIZE; h++) {
      for (const pl of list) {
        const c = this.deck.pop();
        if (c != null) pl.hand.push(c);
      }
    }
    this.storytellerIndex = 0;
    this.phase = "clue";
    this.currentClue = "";
    this.storytellerCard = null;
    this.submissions.clear();
    this.revealOrder = [];
    this.slotToPlayerId = [];
    this.votes.clear();
    this.slotReactions = [];
    this.lastRoundSummary = null;
    this.gameOver = null;
    return {};
  }

  /** 遊戲結算後由房主返回等候廳 */
  returnToLobbyAfterGame(playerId) {
    if (this.phase !== "gameover") return { error: "目前不在遊戲結算畫面" };
    if (playerId !== this.hostId) return { error: "僅房主可返回等候廳" };
    this.resetToLobby("");
    return {};
  }

  enterGameOver(reason, roundSummary) {
    const leaderboard = [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name), "zh-Hant"));

    let messageZh = "";
    if (reason === "win_score") {
      const reached = leaderboard.filter((p) => p.score >= WIN_SCORE);
      const names = reached.map((p) => `「${p.name}」`).join("、");
      messageZh = names ? `${names} 達到 ${WIN_SCORE} 分，遊戲結束！` : "已有玩家達標，遊戲結束！";
    } else {
      messageZh = "牌庫已無法再補滿手牌，遊戲結束。";
    }

    this.phase = "gameover";
    this.gameOver = {
      reason,
      winScore: WIN_SCORE,
      leaderboard: leaderboard.map((p, i) => ({ rank: i + 1, name: p.name, score: p.score, id: p.id })),
      messageZh,
    };
    this.lastRoundSummary = roundSummary;
    this.appendSystemChat(messageZh);
  }

  getStorytellerId() {
    const ids = [...this.players.keys()];
    return ids[this.storytellerIndex % ids.length] ?? null;
  }

  submitClue(playerId, clue, cardId) {
    if (this.phase === "gameover") return { error: "遊戲已結束" };
    if (this.phase !== "clue") return { error: "目前不是提示階段" };
    if (playerId !== this.getStorytellerId()) return { error: "只有本回合說書人可以出題" };
    const pl = this.players.get(playerId);
    if (!pl) return { error: "找不到玩家" };
    const idx = pl.hand.indexOf(cardId);
    if (idx === -1) return { error: "你沒有這張牌" };
    const text = String(clue || "").trim();
    if (text.length < 1 || text.length > 120) return { error: "提示長度須在 1–120 字" };

    pl.hand.splice(idx, 1);
    this.currentClue = text;
    this.storytellerCard = cardId;
    this.submissions.clear();
    this.submissions.set(playerId, cardId);
    this.phase = "submit";
    return {};
  }

  submitCard(playerId, cardId) {
    if (this.phase === "gameover") return { error: "遊戲已結束" };
    if (this.phase !== "submit") return { error: "目前不是出牌階段" };
    if (playerId === this.getStorytellerId()) return { error: "說書人不用出牌" };
    if (this.submissions.has(playerId)) return { error: "你已經出過牌了" };
    const pl = this.players.get(playerId);
    if (!pl) return { error: "找不到玩家" };
    const idx = pl.hand.indexOf(cardId);
    if (idx === -1) return { error: "你沒有這張牌" };

    pl.hand.splice(idx, 1);
    this.submissions.set(playerId, cardId);

    if (this.submissions.size >= this.players.size) this.goReveal();
    return {};
  }

  goReveal() {
    const entries = [...this.submissions.entries()];
    const shuffled = shuffle(entries);
    this.revealOrder = shuffled.map(([, card]) => card);
    this.slotToPlayerId = shuffled.map(([pid]) => pid);
    this.votes.clear();
    this.slotReactions = this.revealOrder.map(() => ({}));
    this.phase = "vote";
  }

  setSlotReaction(playerId, slotIndex, emoji) {
    if (this.phase === "gameover") return { error: "遊戲已結束" };
    if (this.phase !== "vote") return { error: "目前不能貼表情" };
    const i = Number(slotIndex);
    if (!Number.isInteger(i) || i < 0 || i >= this.revealOrder.length) return { error: "無效的圖卡位置" };
    if (!this.players.has(playerId)) return { error: "找不到玩家" };
    const e = normalizeEmoji(emoji);
    if (!e) return { error: "請選擇或貼上一個表情符號" };
    const bucket = this.slotReactions[i];
    if (!bucket) return { error: "無效的圖卡位置" };
    bucket[playerId] = e;
    return {};
  }

  submitVote(playerId, slotIndex) {
    if (this.phase === "gameover") return { error: "遊戲已結束" };
    if (this.phase !== "vote") return { error: "目前不是投票階段" };
    if (playerId === this.getStorytellerId()) return { error: "說書人不能投票" };
    if (this.votes.has(playerId)) return { error: "你已經投過票了" };
    const i = Number(slotIndex);
    if (!Number.isInteger(i) || i < 0 || i >= this.revealOrder.length) return { error: "無效的選項" };
    if (this.slotToPlayerId[i] === playerId) return { error: "不能投票給自己出的牌" };
    this.votes.set(playerId, i);

    const votersNeeded = this.players.size - 1;
    if (this.votes.size >= votersNeeded) this.resolveRound();
    return {};
  }

  resolveRound() {
    const scoresBefore = new Map();
    for (const [id, p] of this.players) scoresBefore.set(id, p.score);

    const storytellerId = this.getStorytellerId();
    const correctSlot = this.slotToPlayerId.indexOf(storytellerId);
    const votesOnSlot = new Map();
    for (let s = 0; s < this.revealOrder.length; s++) votesOnSlot.set(s, 0);
    for (const slot of this.votes.values()) {
      votesOnSlot.set(slot, (votesOnSlot.get(slot) || 0) + 1);
    }
    const correctVotes = votesOnSlot.get(correctSlot) || 0;
    const totalVoters = this.players.size - 1;
    const allWrong = correctVotes === 0;
    const allRight = correctVotes === totalVoters;

    const summary = { correctSlot, votesOnSlot: Object.fromEntries(votesOnSlot), allWrong, allRight };

    if (allWrong || allRight) {
      const st = this.players.get(storytellerId);
      if (st) st.score += 0;
      for (const pid of this.players.keys()) {
        if (pid === storytellerId) continue;
        const pl = this.players.get(pid);
        if (pl) pl.score += 2;
      }
      summary.storytellerBonus = 0;
      summary.rule = allWrong ? "沒人猜中：說書人 0 分，其他人各 +2" : "所有人都猜中：說書人 0 分，其他人各 +2";
    } else {
      const st = this.players.get(storytellerId);
      if (st) st.score += 3;
      for (const [voterId, slot] of this.votes) {
        if (slot === correctSlot) {
          const pl = this.players.get(voterId);
          if (pl) pl.score += 3;
        }
      }
      for (let s = 0; s < this.revealOrder.length; s++) {
        if (s === correctSlot) continue;
        const ownerId = this.slotToPlayerId[s];
        const n = votesOnSlot.get(s) || 0;
        if (n > 0 && ownerId !== storytellerId) {
          const pl = this.players.get(ownerId);
          if (pl) pl.score += n;
        }
      }
      summary.storytellerBonus = 3;
      summary.rule = "部分人猜中：說書人 +3，猜中者 +3；若有人投到你的牌，你每张得票 +1";
    }

    const stName = this.players.get(storytellerId)?.name ?? "說書人";
    const slotVoters = new Map();
    for (const [voterId, slot] of this.votes) {
      const vn = this.players.get(voterId)?.name ?? "?";
      if (!slotVoters.has(slot)) slotVoters.set(slot, []);
      slotVoters.get(slot).push(vn);
    }
    const bySlot = [];
    for (let s = 0; s < this.revealOrder.length; s++) {
      const oid = this.slotToPlayerId[s];
      const oname = this.players.get(oid)?.name ?? "?";
      bySlot.push({
        slotIndex: s,
        ownerName: oname,
        isStorytellerCard: oid === storytellerId,
        voterNames: [...(slotVoters.get(s) || [])],
      });
    }
    const voterLines = [];
    const storytellerNudges = [];
    for (const [voterId, slot] of this.votes) {
      const vname = this.players.get(voterId)?.name ?? "?";
      const oid = this.slotToPlayerId[slot];
      const oname = this.players.get(oid)?.name ?? "?";
      if (oid === storytellerId) {
        voterLines.push(`「${vname}」選了說書人「${stName}」的這張圖。`);
        storytellerNudges.push(`「${vname}」選了你出的圖。`);
      } else {
        voterLines.push(`「${vname}」選了「${oname}」的圖。`);
        storytellerNudges.push(`「${vname}」把你的提示聯想到「${oname}」的圖。`);
      }
    }
    const scoreDeltas = {};
    for (const [id, p] of this.players) {
      scoreDeltas[id] = p.score - (scoresBefore.get(id) ?? 0);
    }

    summary.voteReveal = {
      id: Date.now(),
      roundStorytellerId: storytellerId,
      roundStorytellerName: stName,
      bySlot,
      voterLines,
      storytellerNudges,
      scoreDeltas,
    };

    this.dealReplacements();

    const hitWinScore = [...this.players.values()].some((p) => p.score >= WIN_SCORE);
    const deckEmpty = this.deck.length === 0;
    const anyHandShort = [...this.players.values()].some((p) => p.hand.length < HAND_SIZE);
    const deckExhausted = deckEmpty && anyHandShort;

    if (hitWinScore || deckExhausted) {
      const reason = hitWinScore ? "win_score" : "deck_exhausted";
      this.enterGameOver(reason, summary);
      return summary;
    }

    this.storytellerIndex = (this.storytellerIndex + 1) % this.players.size;
    this.phase = "clue";
    this.currentClue = "";
    this.storytellerCard = null;
    this.submissions.clear();
    this.revealOrder = [];
    this.slotToPlayerId = [];
    this.votes.clear();
    this.slotReactions = [];
    this.lastRoundSummary = summary;
    return summary;
  }

  dealReplacements() {
    for (const pl of this.players.values()) {
      while (pl.hand.length < HAND_SIZE && this.deck.length > 0) {
        pl.hand.push(this.deck.pop());
      }
    }
  }

  publicState(forPlayerId) {
    const storytellerId = this.getStorytellerId();
    const playersList = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      isStoryteller: p.id === storytellerId,
      cardCount: p.hand.length,
      disconnected: Boolean(p.disconnected),
    }));

    const base = {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      players: playersList,
      storytellerId,
      currentClue: this.phase === "submit" || this.phase === "vote" ? this.currentClue : "",
      lastRoundSummary: this.lastRoundSummary,
      cardDeck: this.cardDeck,
      availableDecks: listDeckKeys(DATA_DIR).map((key) => ({
        key,
        sheets: getDeckSheetCount(DATA_DIR, key),
        cards: getDeckCardCount(DATA_DIR, key),
      })),
      imageGenConfigured: true,
      winScoreTarget: WIN_SCORE,
    };

    if (this.phase === "lobby") {
      return { ...base, myHand: forPlayerId ? this.players.get(forPlayerId)?.hand ?? [] : [] };
    }

    if (this.phase === "gameover") {
      return {
        ...base,
        phase: "gameover",
        gameOver: this.gameOver,
        myHand: [],
      };
    }

    const me = forPlayerId ? this.players.get(forPlayerId) : null;
    const myHand = me?.hand ? [...me.hand] : [];

    if (this.phase === "vote") {
      let myVoteSlotIndex = null;
      if (forPlayerId && forPlayerId !== storytellerId) {
        const idx = this.slotToPlayerId.findIndex((pid) => pid === forPlayerId);
        if (idx >= 0) myVoteSlotIndex = idx;
      }
      return {
        ...base,
        myHand,
        myVoteSlotIndex,
        revealSlots: this.revealOrder.map((cardId, i) => {
          const bucket = this.slotReactions[i] || {};
          const reactions = Object.entries(bucket).map(([pid, em]) => ({
            playerId: pid,
            name: this.players.get(pid)?.name ?? "?",
            emoji: em,
          }));
          return {
            slotIndex: i,
            cardId,
            imageUrl: cardUrl(cardId, this.cardDeck),
            reactions,
          };
        }),
        myVoteDone: forPlayerId ? this.votes.has(forPlayerId) : false,
      };
    }

    return {
      ...base,
      myHand,
      myHandImages: myHand.map((id) => ({ cardId: id, imageUrl: cardUrl(id, this.cardDeck) })),
      submitDone: forPlayerId ? this.submissions.has(forPlayerId) : false,
    };
  }
}
