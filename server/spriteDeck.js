import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 牌面顯示寬高（與前端投票區比例一致） */
export const CARD_W = 280;
export const CARD_H = 420;

/** 每局從圖庫隨機抽出的最多張數（超過則只取此數量成一局牌池） */
export const GAME_POOL_MAX = 84;

export const DATA_DIR = path.join(__dirname, "../data");

const EXT_RE = /\.(jpe?g|png|webp)$/i;
const BASE_DECK_KEY = "origin";

export function sanitizeDeckKey(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s;
}

export function isBaseDeckKey(raw) {
  return String(raw || "").trim().toLowerCase() === BASE_DECK_KEY;
}

/** 上傳／新建資料夾用：僅允許安全字元，避免路徑穿越 */
export function assertSafeDeckFolderName(raw) {
  const s = String(raw || "").trim();
  if (!s) return { error: "請填資料夾名稱" };
  if (s.length > 64) return { error: "資料夾名稱過長（最多 64 字元）" };
  if (/[\\/]|\.\./.test(s)) return { error: "資料夾名稱不可用" };
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) {
    return { error: "資料夾名稱僅能使用英數、底線、連字、句點（例如 my-deck）" };
  }
  return { name: s };
}

export function isDeckImageFilename(name) {
  return EXT_RE.test(name);
}

/** 卡組資料夾路徑（須為目錄）；先試原字串再試 sanitize 後名稱 */
export function resolveDeckFolder(dataDir, deckKey) {
  const raw = String(deckKey || "").trim();
  const candidates = raw ? [raw, sanitizeDeckKey(raw)] : [sanitizeDeckKey(deckKey)];
  const uniq = [...new Set(candidates.filter(Boolean))];
  for (const c of uniq) {
    const dir = path.join(dataDir, c);
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 列出資料夾內圖檔（僅一層），依檔名排序；一檔 = 一張牌 */
export function listDeckImageFiles(deckFolderPath) {
  let names;
  try {
    names = fs.readdirSync(deckFolderPath);
  } catch {
    return [];
  }
  return names
    .filter((n) => isDeckImageFilename(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
    .map((n) => path.join(deckFolderPath, n));
}

/** @deprecated 請改用 listDeckImageFiles */
export function listDeckSheetFiles(deckFolderPath) {
  return listDeckImageFiles(deckFolderPath);
}

export function deckFolderExists(dataDir, deckKey) {
  const dir = resolveDeckFolder(dataDir, deckKey);
  if (!dir) return false;
  return listDeckImageFiles(dir).length > 0;
}

export function listDeckKeys(dataDir) {
  let entries;
  try {
    entries = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const keys = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    if (name.startsWith(".")) continue;
    const dir = path.join(dataDir, name);
    if (listDeckImageFiles(dir).length > 0) keys.push(name);
  }
  return [...new Set(keys)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function pickDefaultDeckKey(dataDir) {
  const keys = listDeckKeys(dataDir);
  if (keys.includes("origin")) return "origin";
  const originCi = keys.find((k) => k.toLowerCase() === "origin");
  if (originCi) return originCi;
  const originLike = keys.find((k) => k.toLowerCase().includes("origin"));
  if (originLike) return originLike;

  const want = sanitizeDeckKey(process.env.CARD_DECK || "");
  if (want && keys.includes(want)) return want;
  const hit = keys.find((k) => sanitizeDeckKey(k) === want);
  if (want && hit) return hit;
  if (keys.length) return keys[0];
  return want || "origin";
}

export function getDeckImageCount(dataDir, deckKey) {
  const dir = resolveDeckFolder(dataDir, deckKey);
  if (!dir) return 0;
  return listDeckImageFiles(dir).length;
}

/** 與 getDeckImageCount 相同（一檔一卡） */
export function getDeckCardCount(dataDir, deckKey) {
  return getDeckImageCount(dataDir, deckKey);
}

/** 相容舊欄位名：張數 */
export function getDeckSheetCount(dataDir, deckKey) {
  return getDeckImageCount(dataDir, deckKey);
}

/**
 * 牌張編號 1-based → 對應圖檔絕對路徑
 */
export function resolveCardImageFile(dataDir, deckKey, cardIdOneBased) {
  const id = Number(cardIdOneBased);
  if (!Number.isInteger(id) || id < 1) return null;
  const dir = resolveDeckFolder(dataDir, deckKey);
  if (!dir) return null;
  const files = listDeckImageFiles(dir);
  if (!files.length || id > files.length) return null;
  return { filePath: files[id - 1] };
}
