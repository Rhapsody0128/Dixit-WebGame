import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 每張精靈大圖為 3×3，共 9 張牌面；每格 280×420（2:3） */
export const SPRITE_COLS = 3;
export const SPRITE_ROWS = 3;
export const TILE_W = 280;
export const TILE_H = 420;
/** 單張大圖內含牌張數（= SPRITE_COLS * SPRITE_ROWS） */
export const CARDS_PER_SHEET = SPRITE_COLS * SPRITE_ROWS;

/** 每格裁切時四邊內縮（像素），再縮放進牌面；可由環境變數 SPRITE_TILE_PADDING_PX 覆寫 */
export const TILE_CONTENT_PADDING = 0;

export function getEffectiveTileContentPadding() {
  const n = Number(process.env.SPRITE_TILE_PADDING_PX);
  if (Number.isFinite(n) && n >= 0 && n <= 80) return Math.floor(n);
  return TILE_CONTENT_PADDING;
}

/**
 * 單張 3×3 大圖套入固定畫布時的 cover 錨點（預設置中，對齊九宮）
 * 環境變數 SPRITE_SHEET_COVER_POSITION：center | entropy | northwest 等
 */
export function getSheetCoverPosition() {
  const p = String(process.env.SPRITE_SHEET_COVER_POSITION || "center").toLowerCase();
  const allowed = new Set([
    "center",
    "centre",
    "entropy",
    "attention",
    "north",
    "south",
    "east",
    "west",
    "northeast",
    "northwest",
    "southeast",
    "southwest",
  ]);
  return allowed.has(p) ? p : "center";
}

export const DATA_DIR = path.join(__dirname, "../data");

const EXT_RE = /\.(jpe?g|png|webp)$/i;

const SHEET_W = SPRITE_COLS * TILE_W;
const SHEET_H = SPRITE_ROWS * TILE_H;

export function sanitizeDeckKey(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s;
}

/** 是否為可接受的圖檔副檔名 */
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

/** 列出資料夾內圖檔（深度僅一層），依檔名排序 */
export function listDeckSheetFiles(deckFolderPath) {
  let names;
  try {
    names = fs.readdirSync(deckFolderPath);
  } catch {
    return [];
  }
  const files = names
    .filter((n) => isDeckImageFilename(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
    .map((n) => path.join(deckFolderPath, n));
  return files;
}

/** 卡組是否存在：data/{key}/ 下至少一張圖 */
export function deckFolderExists(dataDir, deckKey) {
  const dir = resolveDeckFolder(dataDir, deckKey);
  if (!dir) return false;
  return listDeckSheetFiles(dir).length > 0;
}

/** 所有卡組資料夾名稱（僅含至少一張圖的子資料夾；依檔案系統實際資料夾名） */
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
    if (listDeckSheetFiles(dir).length > 0) keys.push(name);
  }
  return [...new Set(keys)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function pickDefaultDeckKey(dataDir) {
  const keys = listDeckKeys(dataDir);
  const want = sanitizeDeckKey(process.env.CARD_DECK || "");
  if (want && keys.includes(want)) return want;
  const hit = keys.find((k) => sanitizeDeckKey(k) === want);
  if (want && hit) return hit;
  if (keys.length) return keys[0];
  return want || "default";
}

/** @deprecated 改用 resolveDeckFolder / deckFolderExists */
export function resolveDeckPath(dataDir, deckKey) {
  const dir = resolveDeckFolder(dataDir, deckKey);
  if (!dir) return null;
  const files = listDeckSheetFiles(dir);
  return files[0] ?? null;
}

export function getDeckSheetCount(dataDir, deckKey) {
  const dir = resolveDeckFolder(dataDir, deckKey);
  if (!dir) return 0;
  return listDeckSheetFiles(dir).length;
}

export function getDeckCardCount(dataDir, deckKey) {
  return getDeckSheetCount(dataDir, deckKey) * CARDS_PER_SHEET;
}

export function sheetPixelSize() {
  return { width: SHEET_W, height: SHEET_H };
}

/** 單張大圖內第 n 格（0-based，row-major）的矩形 */
export function tileRegionInSheet(cellIndex0Based) {
  const idx = Number(cellIndex0Based);
  if (!Number.isInteger(idx) || idx < 0 || idx >= CARDS_PER_SHEET) return null;
  const col = idx % SPRITE_COLS;
  const row = Math.floor(idx / SPRITE_COLS);
  return { left: col * TILE_W, top: row * TILE_H, width: TILE_W, height: TILE_H };
}

/** 格內留白後的 extract 區域 */
export function tileExtractRegionInSheet(cellIndex0Based) {
  const cell = tileRegionInSheet(cellIndex0Based);
  if (!cell) return null;
  const padPx = getEffectiveTileContentPadding();
  const p = Math.max(0, Math.min(padPx, Math.floor(Math.min(TILE_W, TILE_H) / 8)));
  const w = cell.width - 2 * p;
  const h = cell.height - 2 * p;
  if (w < 48 || h < 48) return cell;
  return { left: cell.left + p, top: cell.top + p, width: w, height: h };
}

/**
 * 全域牌張編號（1-based）→ 第幾張大圖、圖內第幾格（0-based）
 */
export function cardIdToSheetAndCell(cardIdOneBased) {
  const id = Number(cardIdOneBased);
  if (!Number.isInteger(id) || id < 1) return null;
  const idx = id - 1;
  return {
    sheetIndex: Math.floor(idx / CARDS_PER_SHEET),
    cellIndex: idx % CARDS_PER_SHEET,
  };
}

/** 若牌張編號超出卡組張數則回傳 null */
export function resolveCardSlice(dataDir, deckKey, cardIdOneBased) {
  const k = sanitizeDeckKey(deckKey);
  const dir = resolveDeckFolder(dataDir, k);
  if (!dir) return null;
  const files = listDeckSheetFiles(dir);
  if (!files.length) return null;
  const pos = cardIdToSheetAndCell(cardIdOneBased);
  if (!pos || pos.sheetIndex < 0 || pos.sheetIndex >= files.length) return null;
  return {
    filePath: files[pos.sheetIndex],
    cellIndex: pos.cellIndex,
  };
}

// ---------------------------------------------------------------------------
// 產圖：每張為 3×3 一圖；存進卡組資料夾
// ---------------------------------------------------------------------------

export function buildSpritePrompt(playerStyleOnly) {
  const style = String(playerStyleOnly || "").trim().slice(0, 900);
  const padPx = getEffectiveTileContentPadding();

  const styleBlock =
    style.length > 0
      ? style
      : "Soft surreal fairytale illustration, gentle mystery, warm diffused light (default because player left style blank).";

  return `[IMAGE TASK — STRICT SPRITE SHEET GENERATION]

[A] OUTPUT FORMAT:
Generate ONE single image that is a CLEAN 3×3 sprite sheet.
- Exactly 3 columns × 3 rows
- Total 9 panels
- All panels MUST be equal size and perfectly aligned
- Panels must be arranged in a straight rectangular grid (no perspective, no distortion)

[B] PANEL GEOMETRY (CRITICAL):
- Each panel must be a PORTRAIT rectangle (height greater than width, approx 2:3 ratio)
- All panels identical in size and shape
- Hard visual separation between panels (clear boundaries)
- No gaps, no gutters, no outer borders

[C] CUT SAFETY (VERY IMPORTANT):
- Each panel must be fully self-contained
- DO NOT let subjects cross panel edges
- Keep important elements inside a safe margin (~${padPx}px inset from edges)
- Avoid placing faces, hands, or key objects near borders
- Every panel must remain valid if cropped independently

[D] GRID INTEGRITY:
- Do NOT tilt, skew, or curve the grid
- Do NOT merge panels visually
- Do NOT add frames, comic borders, or decorative separators
- Do NOT create overlapping compositions between panels

[E] CONTENT:
- 9 DISTINCT scenes (no duplicates)
- Each panel should feel like an independent illustration
- Maintain one consistent art style across all panels
- Style should be evocative, surreal, slightly ambiguous (Dixit-like mood)

[F] NEGATIVE CONSTRAINTS:
- No text
- No letters or numbers
- No logos, watermarks, signatures, QR codes
- No UI elements or layout graphics

[G] PLAYER STYLE:
---
${styleBlock}
---
`;
}

export async function fetchGeneratedSheetBuffer(playerStyleOnly, openaiApiKey) {
  const apiKey = String(openaiApiKey || "").trim();
  if (!apiKey) throw new Error("缺少 OpenAI API 金鑰");

  const prompt = buildSpritePrompt(playerStyleOnly);
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "dall-e-3",
      prompt: prompt.slice(0, 4000),
      n: 1,
      size: "840×1260",
      response_format: "url",
    }),
  });

  const rawText = await res.text();
  if (!res.ok) {
    let msg = rawText;
    try {
      const j = JSON.parse(rawText);
      msg = j.error?.message || rawText;
    } catch {
      /* keep */
    }
    throw new Error(msg || `HTTP ${res.status}`);
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error("產圖 API 回傳非 JSON");
  }
  const url = data.data?.[0]?.url;
  if (!url) throw new Error("產圖 API 未回傳圖片網址");

  const imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error("無法下載產出圖檔");
  return Buffer.from(await imgRes.arrayBuffer());
}
