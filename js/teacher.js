// =====================================================================
//  교사용: 로그인 · 실시간 현황 · 문제 만들기(PDF 자르기) · 설정
// =====================================================================
import { CONFIG } from "./config.js";
import * as DB from "./db.js";
import { $, $$, esc, fmtTime, toast, lvName, perDoor } from "./utils.js";

const FLOORS = CONFIG.floors;
const DOORS = FLOORS.length - 1;
const ONLINE_MS = 150_000; // 이 시간 안에 신호가 있으면 '접속 중'
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";

let players = {}, problems = [], keys = {}, settings = {};
let dashIv = null;

// ---------------------------------------------------------------- 시작
boot();
async function boot() {
  if (DB.mode === "demo") { $("#modeBadge").hidden = false; $("#modeBadge2").hidden = false; $("#demoTip").hidden = false; }
  try { await DB.init("teacher"); }
  catch (e) { console.error(e); toast("서버 연결 실패: " + e.message, "err"); return; }
  if (await DB.isTeacher()) return startApp();
  $("#tLoginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (await DB.teacherLogin($("#tPw").value)) startApp();
    else { toast("비밀번호가 틀렸습니다.", "err"); $("#tPw").select(); }
  });
}

async function startApp() {
  $("#t-login").hidden = true;
  $("#t-app").hidden = false;

  $$(".tabs button").forEach((b) => b.addEventListener("click", () => {
    $$(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    $$(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + b.dataset.tab));
  }));
  $("#logoutBtn").onclick = async () => { await DB.teacherLogout(); location.reload(); };
  $("#zoom").onclick = () => $("#zoom").classList.remove("show");

  settings = await DB.getSettings();
  DB.watchSettings((s) => { settings = s; renderOpen(); });
  DB.watchPlayers((ps) => { players = ps; renderDash(); });
  clearInterval(dashIv);
  dashIv = setInterval(renderDash, 1000);

  $("#openBtn").onclick = async () => {
    const next = !settings.open;
    await DB.saveSettings({ open: next });
    toast(next ? "게임 시작! 학생들이 깨어납니다." : "입장을 닫았습니다.");
  };
  $("#resetBtn").onclick = async () => {
    if (!confirm("모든 학생 기록을 지우고, 입장도 닫습니다. 계속할까요?\n(다음 반 수업 전에 사용하세요)")) return;
    await DB.clearPlayers();
    await DB.saveSettings({ open: false });
    toast("초기화했습니다.");
  };
  $("#csvBtn").onclick = downloadCsv;
  $("#qrBtn").onclick = showQr;
  $("#qrModal").onclick = () => $("#qrModal").classList.remove("show");

  initSettingsForm();
  initMaker();
  await reloadProblems();
}

function renderOpen() {
  $("#openBtn").textContent = settings.open ? "🔓 입장 열림 — 닫기" : "🔒 게임 시작하기";
  $("#openBtn").classList.toggle("red", settings.open);
  $("#openTip").textContent = settings.open
    ? "학생들이 로그인하면 바로 시작합니다."
    : "닫혀 있는 동안 학생들은 로그인 후 대기 화면에서 기다립니다.";
}

// ---------------------------------------------------------------- 실시간 현황
const isOnline = (p) => Date.now() - (p.lastSeen || 0) < ONLINE_MS;
function elapsed(p) {
  if (!p.startedAt) return 0;
  return (p.finishedAt || Date.now()) - p.startedAt + (p.penaltyMs || 0);
}
function progress(p) { return { done: (p.solved || []).length, total: (p.plan || []).length || DOORS * perDoor(p.level) }; }
function rankSort(a, b) {
  const order = { escaped: 0, phone: 1, playing: 1, timeout: 2, waiting: 3 };
  if (order[a.status] !== order[b.status]) return (order[a.status] ?? 9) - (order[b.status] ?? 9);
  if (a.status === "escaped") return elapsed(a) - elapsed(b);
  const pa = progress(a).done / (progress(a).total || 1), pb = progress(b).done / (progress(b).total || 1);
  if (pa !== pb) return pb - pa;
  return elapsed(a) - elapsed(b);
}
const STATUS = { waiting: "대기", playing: "진행 중", phone: "휴대폰!", escaped: "탈출", timeout: "시간 초과" };

function renderDash() {
  const list = Object.values(players).sort(rankSort);
  $("#kOnline").textContent = list.filter(isOnline).length;
  $("#kWait").textContent = list.filter((p) => p.status === "waiting").length;
  $("#kPlay").textContent = list.filter((p) => p.status === "playing" || p.status === "phone").length;
  $("#kWin").textContent = list.filter((p) => p.status === "escaped").length;
  $("#kLose").textContent = list.filter((p) => p.status === "timeout").length;

  // 건물 단면
  const chip = (p) => `<span class="chip ${p.level} ${p.status === "escaped" ? "escaped" : ""} ${p.status === "timeout" ? "timeout" : ""} ${isOnline(p) ? "" : "off"}" title="${esc(p.id)}">${esc(p.name)}</span>`;
  let html = `<div class="tb-floor escape"><span class="code">탈출</span><div class="chips">${list.filter((p) => p.status === "escaped").map(chip).join("")}</div></div>`;
  for (let i = FLOORS.length - 1; i >= 0; i--) {
    const here = list.filter((p) => p.status !== "escaped" && p.status !== "waiting" && (p.floor || 0) === i);
    html += `<div class="tb-floor"><span class="code">${FLOORS[i].code}</span><div class="chips">${here.map(chip).join("") || `<span class="muted" style="font-size:12px">${esc(FLOORS[i].place)}</span>`}</div></div>`;
  }
  const waiting = list.filter((p) => p.status === "waiting");
  if (waiting.length) html += `<div class="tb-floor"><span class="code">대기</span><div class="chips">${waiting.map(chip).join("")}</div></div>`;
  $("#tBuilding").innerHTML = html;

  // 표
  $("#tRows").innerHTML = list.map((p, n) => {
    const { done, total } = progress(p);
    const f = FLOORS[Math.min(p.floor || 0, FLOORS.length - 1)];
    const t = p.status === "waiting" ? "-" :
      p.status === "escaped" ? `<b style="color:var(--exit)">${fmtTime(elapsed(p))}</b>` :
      p.status === "timeout" ? "-" :
      `남음 ${fmtTime((p.limitMs || 0) - elapsed(p))}`;
    return `<tr>
      <td class="num">${p.status === "escaped" ? n + 1 : ""}</td>
      <td class="num"><span class="dot ${isOnline(p) ? "on" : ""}"></span>${esc(p.id)}</td>
      <td>${esc(p.name)}</td>
      <td>${lvName(p.level)}</td>
      <td>${p.status === "waiting" ? "-" : esc(f.code + " " + f.place)}</td>
      <td class="num"><span class="bar"><i style="width:${total ? (done / total) * 100 : 0}%"></i></span> ${done}/${total}</td>
      <td class="num">${p.wrong || 0}</td>
      <td class="num">${(p.hints || []).length}</td>
      <td class="num">${t}</td>
      <td><span class="st ${p.status}">${STATUS[p.status] || p.status}</span></td>
      <td><button class="btn ghost small" data-del="${esc(p.id)}" title="기록 삭제(다시 도전 가능)">✕</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="11" class="muted" style="text-align:center;padding:30px">아직 접속한 학생이 없어요.</td></tr>`;
  $$("#tRows [data-del]").forEach((b) => (b.onclick = async () => {
    if (confirm(`${b.dataset.del} 학생 기록을 지울까요? (처음부터 다시 도전하게 됩니다)`)) await DB.deletePlayer(b.dataset.del);
  }));
}

// 지금 주소(Vercel/GitHub Pages)에서 student.html 주소를 만들어 QR로 크게 띄움
async function showQr() {
  const url = new URL("student.html", location.href).href;
  try {
    if (!window.QRCode) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js");
    $("#qrBox").innerHTML = "";
    const size = Math.min(window.innerWidth, window.innerHeight) * 0.62;
    new window.QRCode($("#qrBox"), { text: url, width: size, height: size, correctLevel: window.QRCode.CorrectLevel.M });
  } catch (e) {
    $("#qrBox").textContent = "QR을 만들지 못했어요. 아래 주소를 알려 주세요.";
  }
  $("#qrUrl").textContent = url;
  $("#qrModal").classList.add("show");
}

function downloadCsv() {
  const list = Object.values(players).sort(rankSort);
  const rows = [["학번", "이름", "난이도", "상태", "도달 층", "푼 문제", "전체", "오답", "힌트", "기록(초)"]];
  list.forEach((p) => {
    const { done, total } = progress(p);
    rows.push([p.id, p.name, lvName(p.level), STATUS[p.status] || p.status, FLOORS[Math.min(p.floor || 0, FLOORS.length - 1)].code, done, total, p.wrong || 0, (p.hints || []).length, p.status === "escaped" ? Math.round(elapsed(p) / 1000) : ""]);
  });
  const csv = "﻿" + rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const d = new Date();
  a.download = `방탈출결과_${d.getMonth() + 1}월${d.getDate()}일_${d.getHours()}시${d.getMinutes()}분.csv`;
  a.click();
}

// ---------------------------------------------------------------- 설정
function initSettingsForm() {
  $("#sLimit").value = settings.timeLimitMin;
  $("#sHint").value = settings.hintPenaltySec;
  $("#sLock").value = settings.wrongLockSec;
  $("#sShuffle").checked = !!settings.shuffle;
  $("#setForm").onsubmit = async (e) => {
    e.preventDefault();
    await DB.saveSettings({
      timeLimitMin: Math.max(5, Number($("#sLimit").value) || 50),
      hintPenaltySec: Math.max(0, Number($("#sHint").value) || 0),
      wrongLockSec: Math.max(0, Number($("#sLock").value) || 0),
      shuffle: $("#sShuffle").checked,
    });
    toast("설정을 저장했습니다.");
  };
}

// ---------------------------------------------------------------- 문제 만들기
let sources = [];     // { label, render(canvas) }
let curSrc = -1;
let sel = null;       // {x,y,w,h} 화면 좌표(px)
let pending = null;   // 모달에서 저장할 이미지 / 수정할 문제
let lastLevel = "mid";

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("스크립트를 불러오지 못했어요: " + src));
    document.head.appendChild(s);
  });
}
async function ensurePdfJs() {
  if (window.pdfjsLib) return;
  await loadScript(`${PDFJS}/pdf.min.js`);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.js`;
}

function initMaker() {
  const drop = $("#drop"), input = $("#fileIn");
  input.onchange = () => handleFiles([...input.files]).finally(() => (input.value = ""));
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hover"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hover"); }));
  drop.addEventListener("drop", (e) => handleFiles([...e.dataTransfer.files]));

  // 드래그 선택
  const wrap = $("#viewer"), box = $("#selBox");
  let start = null;
  const pos = (e) => { const r = wrap.getBoundingClientRect(); return { x: Math.max(0, Math.min(r.width, e.clientX - r.left)), y: Math.max(0, Math.min(r.height, e.clientY - r.top)) }; };
  wrap.addEventListener("pointerdown", (e) => { start = pos(e); wrap.setPointerCapture(e.pointerId); sel = null; box.style.display = "none"; $("#addSelBtn").disabled = true; });
  wrap.addEventListener("pointermove", (e) => {
    if (!start) return;
    const p = pos(e);
    sel = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    Object.assign(box.style, { display: "block", left: sel.x + "px", top: sel.y + "px", width: sel.w + "px", height: sel.h + "px" });
  });
  wrap.addEventListener("pointerup", () => {
    start = null;
    if (!sel || sel.w < 12 || sel.h < 12) { sel = null; box.style.display = "none"; }
    $("#addSelBtn").disabled = !sel;
  });

  $("#addSelBtn").onclick = () => sel && openAddModal(cropImage(sel));
  $("#addPageBtn").onclick = () => openAddModal(cropImage(null));
  $("#pCancel").onclick = () => $("#pModal").classList.remove("show");
  $("#pForm").onsubmit = saveModal;
}

async function handleFiles(files) {
  for (const f of files) {
    const name = f.name.toLowerCase();
    if (name.endsWith(".hwp") || name.endsWith(".hwpx")) {
      alert("한글(HWP) 파일은 브라우저에서 바로 열 수 없어요.\n\n한글에서 [파일] → [PDF로 저장하기]를 한 뒤 PDF를 올려 주세요.\n(또는 문제를 캡처한 이미지 파일도 됩니다)");
      continue;
    }
    try {
      if (name.endsWith(".pdf") || f.type === "application/pdf") await addPdf(f);
      else if (f.type.startsWith("image/")) await addImage(f);
      else toast(`${f.name}: 지원하지 않는 형식`, "err");
    } catch (e) {
      console.error(e);
      toast(`${f.name} 열기 실패: ${e.message}`, "err");
    }
  }
  renderThumbs();
  if (curSrc < 0 && sources.length) showSource(0);
}

async function addPdf(file) {
  toast("PDF를 여는 중…");
  await ensurePdfJs();
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    sources.push({
      label: `${file.name} · ${i}쪽`,
      async render(canvas, scale = 2) {
        const vp = page.getViewport({ scale });
        canvas.width = vp.width; canvas.height = vp.height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      },
    });
  }
}

async function addImage(file) {
  const url = URL.createObjectURL(file);
  const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
  sources.push({
    label: file.name,
    async render(canvas, scale = 1) {
      const s = Math.min(scale, 2400 / img.width, 1) || 1;
      canvas.width = img.width * s; canvas.height = img.height * s;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    },
  });
}

async function renderThumbs() {
  const box = $("#thumbs");
  box.innerHTML = "";
  for (let i = 0; i < sources.length; i++) {
    const d = document.createElement("div");
    d.className = i === curSrc ? "on" : "";
    const c = document.createElement("canvas");
    d.appendChild(c);
    d.insertAdjacentHTML("beforeend", `<small>${esc(sources[i].label)}</small>`);
    d.onclick = () => showSource(i);
    box.appendChild(d);
    await sources[i].render(c, 0.25);
  }
}

async function showSource(i) {
  curSrc = i;
  $$("#thumbs > div").forEach((d, n) => d.classList.toggle("on", n === i));
  $("#viewerEmpty").hidden = true;
  $("#viewer").hidden = false;
  $("#vTools").hidden = false;
  sel = null; $("#selBox").style.display = "none"; $("#addSelBtn").disabled = true;
  await sources[i].render($("#vCanvas"), 2);
}

// 선택 영역 → JPEG dataURL (Firestore 문서 크기 제한 1MB 이하로 압축)
function cropImage(rect) {
  const c = $("#vCanvas");
  const k = c.width / c.clientWidth;
  const sx = rect ? rect.x * k : 0, sy = rect ? rect.y * k : 0;
  const sw = rect ? rect.w * k : c.width, sh = rect ? rect.h * k : c.height;
  const maxW = 1200;
  const s = Math.min(1, maxW / sw);
  const out = document.createElement("canvas");
  out.width = Math.round(sw * s); out.height = Math.round(sh * s);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(c, sx, sy, sw, sh, 0, 0, out.width, out.height);
  let q = 0.88, url = out.toDataURL("image/jpeg", q);
  while (url.length > 650_000 && q > 0.4) { q -= 0.12; url = out.toDataURL("image/jpeg", q); }
  return url;
}

function openAddModal(image) {
  pending = { mode: "add", image };
  $("#pTitle").textContent = "문제 등록";
  $("#pPrev").src = image;
  $(`input[name="plevel"][value="${lastLevel}"]`).checked = true;
  $("#pAns").value = ""; $("#pHint").value = "";
  $("#pModal").classList.add("show");
  setTimeout(() => $("#pAns").focus(), 50);
}
function openEditModal(p) {
  pending = { mode: "edit", id: p.id, oldLevel: p.level };
  $("#pTitle").textContent = "문제 수정";
  $("#pPrev").src = p.image;
  $(`input[name="plevel"][value="${p.level}"]`).checked = true;
  $("#pAns").value = keys[p.id] ?? "";
  $("#pHint").value = p.hint || "";
  $("#pModal").classList.add("show");
}

async function saveModal(e) {
  e.preventDefault();
  const level = $('input[name="plevel"]:checked').value;
  const answer = $("#pAns").value.trim();
  const hint = $("#pHint").value.trim();
  if (!answer) return toast("정답을 입력하세요.", "err");
  $("#pSave").disabled = true;
  try {
    const maxOrder = (lv) => Math.max(0, ...problems.filter((p) => p.level === lv).map((p) => p.order || 0));
    if (pending.mode === "add") {
      await DB.addProblem({ level, order: maxOrder(level) + 1, image: pending.image, hint }, answer);
      lastLevel = level;
      toast(`[${lvName(level)}] 문제를 등록했어요.`);
      sel = null; $("#selBox").style.display = "none"; $("#addSelBtn").disabled = true;
    } else {
      const patch = { hint, level };
      if (level !== pending.oldLevel) patch.order = maxOrder(level) + 1;
      await DB.updateProblem(pending.id, patch, answer);
      toast("수정했어요.");
    }
    $("#pModal").classList.remove("show");
    await reloadProblems();
  } catch (err) {
    console.error(err);
    toast("저장 실패: " + err.message, "err");
  } finally {
    $("#pSave").disabled = false;
  }
}

async function reloadProblems() {
  [problems, keys] = await Promise.all([DB.getProblems(), DB.getAnswerKeys()]);
  renderProblemList();
}

function renderProblemList() {
  const sec = (level) => {
    const list = problems.filter((p) => p.level === level);
    const need = DOORS * perDoor(level);
    const ok = list.length >= need;
    return `<h4>${level === "mid" ? "중 — 층마다 2문제" : "상 — 층마다 1문제"}
        <span class="need ${ok ? "ok" : "no"}">${list.length} / ${need}${ok ? " ✓" : " 필요"}</span></h4>
      <div class="pitems">${list.map((p, i) => `
        <div class="pitem">
          <span class="n">${i + 1}</span>
          <img src="${p.image}" data-zoom="${p.id}" alt="" />
          <div class="ans">정답: ${esc(keys[p.id] ?? "?")}${p.hint ? `<small>💡 ${esc(p.hint)}</small>` : ""}</div>
          <div class="acts">
            <button data-up="${p.id}" title="위로">▲</button><button data-down="${p.id}" title="아래로">▼</button>
            <button data-edit="${p.id}">수정</button><button data-delp="${p.id}">삭제</button>
          </div>
        </div>`).join("") || `<p class="muted" style="font-size:13px;margin:0">아직 없음</p>`}</div>`;
  };
  $("#plist").innerHTML = sec("mid") + sec("high") +
    `<p class="muted" style="font-size:12px;margin:0">문제가 필요 개수보다 적으면 반복해서 출제돼요. 섞기를 끄면 위에서부터 차례로 B1→1F, 1F→2F… 문에 배정됩니다.</p>`;

  const byId = (id) => problems.find((p) => p.id === id);
  $$("#plist [data-zoom]").forEach((im) => (im.onclick = () => { $("#zoom img").src = im.src; $("#zoom").classList.add("show"); }));
  $$("#plist [data-edit]").forEach((b) => (b.onclick = () => openEditModal(byId(b.dataset.edit))));
  $$("#plist [data-delp]").forEach((b) => (b.onclick = async () => {
    if (!confirm("이 문제를 삭제할까요?")) return;
    await DB.deleteProblem(b.dataset.delp);
    await reloadProblems();
  }));
  const move = async (id, dir) => {
    const p = byId(id);
    const list = problems.filter((x) => x.level === p.level);
    const i = list.indexOf(p), j = i + dir;
    if (j < 0 || j >= list.length) return;
    // 순서를 1..n 으로 다시 매기고 두 개를 바꿈
    const ordered = list.map((x) => x.id);
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    await Promise.all(ordered.map((pid, n) => (byId(pid).order !== n + 1 ? DB.updateProblem(pid, { order: n + 1 }) : null)));
    await reloadProblems();
  };
  $$("#plist [data-up]").forEach((b) => (b.onclick = () => move(b.dataset.up, -1)));
  $$("#plist [data-down]").forEach((b) => (b.onclick = () => move(b.dataset.down, 1)));
}
