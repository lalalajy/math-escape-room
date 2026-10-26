// 공통 도우미 함수

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- 정답 처리 ----------
// 공백, 전각문자, ①②, 다양한 빼기 기호 등을 통일해서 비교
export function normalizeAnswer(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[−–—﹣－]/g, "-")
    .replace(/\s+/g, "")
    .replace(/[.。]+$/, "");
}

// 간단한 53비트 해시 (정답을 그대로 저장하지 않기 위함)
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const SALT = "math-escape-room::";
export const hashAnswer = (a) => cyrb53(SALT + normalizeAnswer(a)).toString(36);

// "1/2 | 0.5" 처럼 | 로 여러 정답 허용
export function hashAnswers(text) {
  return String(text ?? "").split("|").map((s) => s.trim()).filter(Boolean).map(hashAnswer);
}
export function checkAnswer(input, hashes = []) {
  if (!normalizeAnswer(input)) return false;
  return hashes.includes(hashAnswer(input));
}

// ---------- 섞기 ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function seededShuffle(arr, seedStr) {
  const rand = mulberry32(cyrb53(String(seedStr)) % 4294967296);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 시간 ----------
export function fmtTime(ms) {
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

// ---------- 알림 ----------
export function toast(msg, type = "") {
  let box = $("#toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; document.body.appendChild(box); }
  const t = document.createElement("div");
  t.className = "toast " + type;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.classList.add("out"), 2800);
  setTimeout(() => t.remove(), 3300);
}

// ---------- 타자기 효과 ----------
let skipTyping = false;
export function setSkipTyping(v) { skipTyping = v; }
export async function typewriter(el, text, speed = 38) {
  for (const ch of text) {
    el.textContent += ch;
    if (!skipTyping) await sleep(ch === "\n" ? speed * 6 : ch === "." || ch === "…" ? speed * 4 : speed);
  }
}

export function lvName(level) { return level === "high" ? "상" : "중"; }
export function perDoor(level) { return level === "high" ? 1 : 2; }
