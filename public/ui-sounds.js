/** 輕量 UI 音效（Web Audio，無外部音檔） */

const MUTE_KEY = "miaoyu_sfx_mute";

let audioCtx = null;

export function isSfxMuted() {
  return localStorage.getItem(MUTE_KEY) === "1";
}

export function setSfxMuted(on) {
  localStorage.setItem(MUTE_KEY, on ? "1" : "0");
}

export function toggleSfxMuted() {
  setSfxMuted(!isSfxMuted());
  return isSfxMuted();
}

export function initUiSounds() {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

function beep(freq, durSec, vol = 0.09, type = "sine") {
  if (isSfxMuted()) return;
  initUiSounds();
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.018);
  g.gain.exponentialRampToValueAtTime(0.0008, t0 + durSec);
  osc.connect(g);
  g.connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + durSec + 0.04);
}

/** 一般按鈕／點選 */
export function playTap() {
  beep(880, 0.055, 0.055);
}

/** 選牌、選格等 */
export function playPick() {
  beep(720, 0.04, 0.045);
}

/** 送出成功感（雙音） */
export function playSend() {
  beep(523, 0.07, 0.065);
  setTimeout(() => beep(784, 0.09, 0.055), 75);
}

/** 錯誤／伺服器拒絕 */
export function playError() {
  beep(200, 0.14, 0.09, "triangle");
  setTimeout(() => beep(165, 0.2, 0.07, "triangle"), 100);
}

/** 他人聊天訊息 */
export function playChat() {
  beep(600, 0.06, 0.04);
  setTimeout(() => beep(750, 0.05, 0.035), 55);
}

/** 回合結算（投票揭曉後） */
export function playRound() {
  const seq = [392, 494, 587, 698];
  seq.forEach((f, i) => {
    setTimeout(() => beep(f, 0.11, 0.055), i * 85);
  });
}

/** 階段切換（較輕） */
export function playPhase() {
  beep(440, 0.07, 0.045);
}

/** 遊戲結束 */
export function playWin() {
  const seq = [523, 659, 784, 988];
  seq.forEach((f, i) => {
    setTimeout(() => beep(f, 0.16, 0.06), i * 110);
  });
}

/** 加入房間／連線恢復 */
export function playJoin() {
  beep(330, 0.1, 0.05);
  setTimeout(() => beep(440, 0.12, 0.055), 90);
}
