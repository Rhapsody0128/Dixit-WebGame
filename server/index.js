import http from "http";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import multer from "multer";
import sharp from "sharp";
import { WebSocketServer } from "ws";
import { randomBytes } from "crypto";
import { GameRoom } from "./game.js";
import {
  assertSafeDeckFolderName,
  CARD_H,
  CARD_W,
  DATA_DIR,
  getDeckCardCount,
  isBaseDeckKey,
  pickDefaultDeckKey,
  resolveCardImageFile,
  resolveDeckFolder,
} from "./spriteDeck.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3847;
const HOST = process.env.HOST ?? "0.0.0.0";

function isLanIPv4(addr) {
  if (!addr || addr.internal) return false;
  return addr.family === "IPv4" || addr.family === 4;
}
const rooms = new Map();
const cardImageCache = new Map();
const RECONNECT_GRACE_MS = 5 * 60 * 1000;
const socketByPlayer = new Map();
const disconnectTimers = new Map();

function playerSocketKey(roomCode, playerId) {
  return `${roomCode}:${playerId}`;
}

function cancelDisconnectSchedule(roomCode, playerId) {
  const key = playerSocketKey(roomCode, playerId);
  clearTimeout(disconnectTimers.get(key));
  disconnectTimers.delete(key);
}

function scheduleDisconnectEviction(roomCode, playerId) {
  const key = playerSocketKey(roomCode, playerId);
  clearTimeout(disconnectTimers.get(key));
  disconnectTimers.set(
    key,
    setTimeout(() => {
      disconnectTimers.delete(key);
      const room = rooms.get(roomCode);
      if (!room) return;
      const p = room.players.get(playerId);
      if (!p || !p.disconnected) return;
      const { emptied } = room.evictDisconnectedPlayer(playerId);
      socketByPlayer.delete(key);
      if (emptied) rooms.delete(roomCode);
      else {
        broadcastChat(room);
        broadcast(room);
      }
    }, RECONNECT_GRACE_MS)
  );
}

function makeRoomCode() {
  return randomBytes(3).toString("hex").toUpperCase();
}

function getOrCreateRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = new GameRoom(code);
    rooms.set(code, room);
  }
  return room;
}

function broadcast(room) {
  for (const pl of room.players.values()) {
    try {
      pl.send({ type: "state", state: room.publicState(pl.id) });
    } catch (_) {}
  }
}

function invalidateDeckImageCache(deckKey) {
  const folder = resolveDeckFolder(DATA_DIR, deckKey);
  if (!folder) return;
  const prefix = folder + path.sep;
  for (const key of [...cardImageCache.keys()]) {
    if (key.startsWith(prefix) || key === folder) cardImageCache.delete(key);
  }
}

/** 單張圖檔 → 固定牌面尺寸 WebP（mtime 變則重算） */
async function getCardWebpBufferForFile(fullPath) {
  let st;
  try {
    st = await fs.stat(fullPath);
  } catch {
    return null;
  }
  const hit = cardImageCache.get(fullPath);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.buffer;

  const raw = await fs.readFile(fullPath);
  const buffer = await sharp(raw)
    .resize(CARD_W, CARD_H, {
      fit: "contain",
      position: "center",
      background: { r: 10, g: 8, b: 12 },
    })
    .webp({ quality: 86 })
    .toBuffer();
  cardImageCache.set(fullPath, { mtimeMs: st.mtimeMs, buffer });
  return buffer;
}

const uploadDeckImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 120 },
});

function broadcastChat(room) {
  const chat = room.getChatSnapshot();
  for (const pl of room.players.values()) {
    try {
      pl.send({ type: "chat", chat });
    } catch (_) {}
  }
}

const app = express();
const jsonParser = express.json({ limit: "2mb" });

app.get("/cards/:deck/:cardId", async (req, res) => {
  try {
    const deckParam = String(req.params.deck || "").trim();
    const cardId = Number(req.params.cardId);
    const maxCards = getDeckCardCount(DATA_DIR, deckParam);
    if (!deckParam || !Number.isInteger(cardId) || cardId < 1 || cardId > maxCards) {
      res.status(400).end();
      return;
    }
    const resolved = resolveCardImageFile(DATA_DIR, deckParam, cardId);
    if (!resolved) {
      res.redirect(302, `https://picsum.photos/seed/miaoyu${cardId}/280/420`);
      return;
    }
    const tile = await getCardWebpBufferForFile(resolved.filePath);
    if (!tile) {
      res.redirect(302, `https://picsum.photos/seed/miaoyu${cardId}/280/420`);
      return;
    }
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(tile);
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

app.post("/api/upload-deck", uploadDeckImages.array("images", 100), async (req, res) => {
  try {
    const code = String(req.body?.roomCode ?? "")
      .trim()
      .toUpperCase()
      .replace(/[^A-F0-9]/g, "");
    if (code.length !== 6) {
      res.status(400).json({ error: "房間碼無效（須為 6 位十六進位）", field: "roomCode" });
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      res.status(404).json({ error: "找不到房間" });
      return;
    }
    const pid = String(req.body?.playerId || "");
    const tok = String(req.body?.sessionToken || "");
    if (!room.validateSession(pid, tok)) {
      res.status(401).json({ error: "身分驗證失敗，請重新加入房間" });
      return;
    }
    if (pid !== room.hostId) {
      res.status(403).json({ error: "僅房主可上傳圖庫" });
      return;
    }
    if (room.phase !== "lobby") {
      res.status(409).json({ error: "僅等候廳可上傳圖庫" });
      return;
    }

    const nameCheck = assertSafeDeckFolderName(String(req.body?.deckKey ?? ""));
    if (nameCheck.error) {
      res.status(400).json({ error: nameCheck.error, field: "deckKey" });
      return;
    }
    const folderName = nameCheck.name;
    if (isBaseDeckKey(folderName)) {
      res.status(403).json({ error: "origin 為基礎圖庫，不能新增或覆寫" });
      return;
    }

    const files = req.files || [];
    if (!files.length) {
      res.status(400).json({ error: "請至少選擇一張圖檔（JPG／PNG／WebP）" });
      return;
    }

    await fs.mkdir(DATA_DIR, { recursive: true });
    const deckDir = path.join(DATA_DIR, folderName);
    await fs.mkdir(deckDir, { recursive: true });

    let saved = 0;
    for (const f of files) {
      const ext = path.extname(f.originalname || "").toLowerCase();
      if (!/\.(jpe?g|png|webp)$/.test(ext)) continue;
      const fname = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}${ext}`;
      await fs.writeFile(path.join(deckDir, fname), f.buffer);
      saved += 1;
    }

    if (saved === 0) {
      res.status(400).json({ error: "沒有可存的圖檔（僅支援 JPG／PNG／WebP）" });
      return;
    }

    invalidateDeckImageCache(folderName);
    room.cardDeck = folderName;
    broadcast(room);
    res.json({ ok: true, deckKey: folderName, count: saved });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/delete-deck", jsonParser, async (req, res) => {
  try {
    const code = String(req.body?.roomCode ?? "")
      .trim()
      .toUpperCase()
      .replace(/[^A-F0-9]/g, "");
    if (code.length !== 6) {
      res.status(400).json({ error: "房間碼無效（須為 6 位十六進位）", field: "roomCode" });
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      res.status(404).json({ error: "找不到房間" });
      return;
    }
    const pid = String(req.body?.playerId || "");
    const tok = String(req.body?.sessionToken || "");
    if (!room.validateSession(pid, tok)) {
      res.status(401).json({ error: "身分驗證失敗，請重新加入房間" });
      return;
    }
    if (pid !== room.hostId) {
      res.status(403).json({ error: "僅房主可刪除圖庫" });
      return;
    }
    if (room.phase !== "lobby") {
      res.status(409).json({ error: "僅等候廳可刪除圖庫" });
      return;
    }

    const deckKey = String(req.body?.deckKey || "").trim();
    if (!deckKey) {
      res.status(400).json({ error: "請指定要刪除的圖庫" });
      return;
    }
    if (isBaseDeckKey(deckKey)) {
      res.status(403).json({ error: "origin 為基礎圖庫，不可刪除" });
      return;
    }
    const folder = resolveDeckFolder(DATA_DIR, deckKey);
    if (!folder) {
      res.status(404).json({ error: "找不到該圖庫資料夾" });
      return;
    }
    const baseName = path.basename(folder);
    if (isBaseDeckKey(baseName)) {
      res.status(403).json({ error: "origin 為基礎圖庫，不可刪除" });
      return;
    }

    invalidateDeckImageCache(baseName);
    await fs.rm(folder, { recursive: true, force: true });

    if (room.cardDeck === baseName || room.cardDeck === deckKey) {
      room.cardDeck = pickDefaultDeckKey(DATA_DIR);
    }
    broadcast(room);
    res.json({ ok: true, deleted: baseName, cardDeck: room.cardDeck });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.use(express.static(path.join(__dirname, "../public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let playerId = null;
  let roomCode = null;

  function safeSend(obj) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch (_) {}
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      safeSend({ type: "error", message: "無效的訊息格式" });
      return;
    }

    if (msg.type === "resume_session") {
      const code = String(msg.roomCode || "")
        .trim()
        .toUpperCase();
      const pid = String(msg.playerId || "");
      const token = String(msg.sessionToken || "");
      if (!/^[A-F0-9]{6}$/.test(code)) {
        safeSend({ type: "error", message: "房間碼格式錯誤" });
        return;
      }
      const room = rooms.get(code);
      if (!room) {
        safeSend({ type: "error", message: "找不到此房間" });
        return;
      }
      const r = room.resumePlayer(pid, token, (obj) => safeSend(obj));
      if (r.error) {
        safeSend({ type: "error", message: r.error });
        return;
      }
      const key = playerSocketKey(code, pid);
      const oldWs = socketByPlayer.get(key);
      if (oldWs && oldWs !== ws) {
        try {
          old.close(4000, "replaced");
        } catch (_) {}
      }
      socketByPlayer.set(key, ws);
      playerId = pid;
      roomCode = code;
      cancelDisconnectSchedule(code, pid);
      const pl = room.players.get(pid);
      safeSend({
        type: "joined",
        roomCode: code,
        playerId: pid,
        sessionToken: pl.sessionToken,
        chat: room.getChatSnapshot(),
      });
      broadcast(room);
      return;
    }

    if (msg.type === "create_room") {
      const code = makeRoomCode();
      const room = getOrCreateRoom(code);
      const name = String(msg.name || "").trim() || "玩家";
      const r = room.addPlayer(name, (obj) => safeSend(obj));
      if (r.error) {
        safeSend({ type: "error", message: r.error });
        return;
      }
      playerId = r.id;
      roomCode = code;
      socketByPlayer.set(playerSocketKey(roomCode, playerId), ws);
      room.appendSystemChat(`${name} 進入房間`);
      broadcastChat(room);
      const pl = room.players.get(playerId);
      safeSend({
        type: "joined",
        roomCode,
        playerId,
        sessionToken: pl.sessionToken,
        chat: room.getChatSnapshot(),
      });
      broadcast(room);
      return;
    }

    if (msg.type === "join_room") {
      const code = String(msg.roomCode || "")
        .trim()
        .toUpperCase();
      const name = String(msg.name || "").trim() || "玩家";
      if (!/^[A-F0-9]{6}$/.test(code)) {
        safeSend({ type: "error", message: "房間碼格式錯誤（6 位十六進位）" });
        return;
      }
      const room = rooms.get(code);
      if (!room) {
        safeSend({ type: "error", message: "找不到此房間" });
        return;
      }
      const r = room.addPlayer(name, (obj) => safeSend(obj));
      if (r.error) {
        safeSend({ type: "error", message: r.error });
        return;
      }
      playerId = r.id;
      roomCode = code;
      socketByPlayer.set(playerSocketKey(roomCode, playerId), ws);
      room.appendSystemChat(`${name} 進入房間`);
      broadcastChat(room);
      const pl = room.players.get(playerId);
      safeSend({
        type: "joined",
        roomCode,
        playerId,
        sessionToken: pl.sessionToken,
        chat: room.getChatSnapshot(),
      });
      broadcast(room);
      return;
    }

    if (!playerId || !roomCode) {
      safeSend({ type: "error", message: "請先建立或加入房間" });
      return;
    }
    const room = rooms.get(roomCode);
    if (!room || !room.players.has(playerId)) {
      safeSend({ type: "error", message: "房間狀態失效，請重新加入" });
      return;
    }

    if (msg.type === "start_game") {
      const err = room.startGame(playerId).error;
      if (err) safeSend({ type: "error", message: err });
      else broadcast(room);
      return;
    }

    if (msg.type === "set_card_deck") {
      const err = room.setCardDeck(playerId, msg.deckKey).error;
      if (err) safeSend({ type: "error", message: err });
      else broadcast(room);
      return;
    }

    if (msg.type === "submit_clue") {
      const err = room.submitClue(playerId, msg.clue, Number(msg.cardId)).error;
      if (err) safeSend({ type: "error", message: err });
      else broadcast(room);
      return;
    }

    if (msg.type === "submit_card") {
      const err = room.submitCard(playerId, Number(msg.cardId)).error;
      if (err) safeSend({ type: "error", message: err });
      else broadcast(room);
      return;
    }

    if (msg.type === "submit_vote") {
      const err = room.submitVote(playerId, msg.slotIndex).error;
      if (err) safeSend({ type: "error", message: err });
      else broadcast(room);
      return;
    }

    if (msg.type === "confirm_next_round") {
      const err = room.confirmNextRound(playerId).error;
      if (err) safeSend({ type: "error", message: err });
      else broadcast(room);
      return;
    }

    if (msg.type === "return_to_lobby") {
      const err = room.returnToLobbyAfterGame(playerId).error;
      if (err) safeSend({ type: "error", message: err });
      else broadcast(room);
      return;
    }

    if (msg.type === "react_card") {
      const err = room.setSlotReaction(playerId, msg.slotIndex, msg.emoji).error;
      if (err) safeSend({ type: "error", message: err });
      else broadcast(room);
      return;
    }

    if (msg.type === "chat") {
      const err = room.appendChat(playerId, msg.text).error;
      if (err) safeSend({ type: "error", message: err });
      else broadcastChat(room);
      return;
    }

    if (msg.type === "leave_room") {
      const rc = roomCode;
      const pid = playerId;
      const r0 = rooms.get(rc);
      if (!r0 || !r0.players.has(pid)) {
        playerId = null;
        roomCode = null;
        safeSend({ type: "left_room" });
        try {
          ws.close();
        } catch (_) {}
        return;
      }
      cancelDisconnectSchedule(rc, pid);
      const pname = r0.players.get(pid)?.name;
      if (pname) r0.appendSystemChat(`${pname} 離開了房間`);
      r0.removePlayer(pid);
      socketByPlayer.delete(playerSocketKey(rc, pid));
      playerId = null;
      roomCode = null;
      if (r0.players.size === 0) rooms.delete(rc);
      else {
        broadcastChat(r0);
        broadcast(r0);
      }
      safeSend({ type: "left_room" });
      try {
        ws.close();
      } catch (_) {}
      return;
    }

    safeSend({ type: "error", message: "未知的指令" });
  });

  ws.on("close", () => {
    if (!playerId || !roomCode) return;
    const key = playerSocketKey(roomCode, playerId);
    if (socketByPlayer.get(key) !== ws) return;
    socketByPlayer.delete(key);
    const room = rooms.get(roomCode);
    if (!room || !room.players.has(playerId)) return;
    room.markSoftDisconnect(playerId);
    scheduleDisconnectEviction(roomCode, playerId);
    broadcast(room);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`妙語說書人伺服器已啟動（綁定 ${HOST}:${PORT}）`);
  console.log(`  本機開啟：http://localhost:${PORT}`);
  if (HOST === "0.0.0.0" || HOST === "::") {
    const nets = os.networkInterfaces();
    for (const addrs of Object.values(nets)) {
      for (const addr of addrs || []) {
        if (isLanIPv4(addr)) {
          console.log(`  同一區網可分享：http://${addr.address}:${PORT}`);
        }
      }
    }
    console.log(`  給網際網路上的朋友：請用 ngrok / Cloudflare Tunnel 等轉發 ${PORT}，或部署到雲主機並開放防火牆。`);
  }
});
