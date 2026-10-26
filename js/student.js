// =====================================================================
//  학생용: 로그인 → 대기 → 인트로 → 층별 자물쇠 → 휴대폰 → 결과
// =====================================================================
import { CONFIG } from "./config.js";
import * as DB from "./db.js";
import { $, $$, esc, sleep, fmtTime, checkAnswer, seededShuffle, toast, typewriter, setSkipTyping, lvName, perDoor } from "./utils.js";
import { sfx } from "./audio.js";

const FLOORS = CONFIG.floors;
const DOORS = FLOORS.length - 1;          // 방화문 개수
const HEARTBEAT_MS = 60_000;              // 접속 확인 주기 (Firestore 무료 한도 고려)

let me = null;                // 학생 기록
let settings = null;
let problems = {};            // id → problem
let curLock = 0;              // 현재 보고 있는 자물쇠(plan 인덱스)
let timerIv = null, hbIv = null, lockUntil = 0, ended = false;

// 배경 장면: school(밤 학교) · hall(복도, 층마다 조명) · dawn(탈출) · dead(시간 초과) · black
function setScene(name, floor) {
  document.body.dataset.scene = name;
  if (floor !== undefined) document.body.dataset.floor = String(floor);
}
const plaque = (f) => `<span class="plaque"><small>${esc(f.code)}</small>${esc(f.place)}</span>`;
const LOCK_SVG = `<svg class="padlock" viewBox="0 0 40 48" aria-hidden="true"><path class="shackle" d="M11 22V14a9 9 0 0 1 18 0v8" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><rect x="4" y="21" width="32" height="25" rx="4" fill="currentColor"/><circle cx="20" cy="31" r="3.6" fill="#000" opacity=".55"/><rect x="18.5" y="32" width="3" height="7" rx="1.3" fill="#000" opacity=".55"/></svg>`;

const show = (id) => $$(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
const save = (patch) => { Object.assign(me, patch); return DB.savePlayer(me.id, { ...patch, lastSeen: Date.now() }).catch((e) => { console.error(e); toast("저장 실패 — 인터넷 연결을 확인하세요.", "err"); }); };

// ---------------------------------------------------------------- 시작
boot();
async function boot() {
  if (DB.mode === "demo") $("#modeBadge").hidden = false;
  try { await DB.init("student"); }
  catch (e) { console.error(e); toast("서버 연결 실패: " + e.message, "err"); return; }
  const urlCode = new URLSearchParams(location.search).get("t");
  $("#tcode").value = DB.normId(urlCode || localStorage.getItem("er_last_tcode") || "");
  if (urlCode) $("#tcode").readOnly = true; // QR로 들어오면 코드가 이미 정해져 있음

  $("#sid").value = localStorage.getItem("er_last_sid") || "";
  $("#sname").value = localStorage.getItem("er_last_name") || "";
  $("#loginForm").addEventListener("submit", onLogin);
  $("#muteBtn").addEventListener("click", () => ($("#muteBtn").textContent = sfx.toggle() ? "🔇" : "🔊"));
  $("#pImg").addEventListener("click", () => openZoom($("#pImg img")?.src));
  $("#zoom").addEventListener("click", () => $("#zoom").classList.remove("show"));
  $("#ansForm").addEventListener("submit", onAnswer);
  $("#hintBtn").addEventListener("click", onHint);
  $("#ansInput").addEventListener("keydown", () => sfx.key());
  const torch = (x, y) => { document.body.style.setProperty("--mx", x + "px"); document.body.style.setProperty("--my", y + "px"); };
  window.addEventListener("pointermove", (e) => torch(e.clientX, e.clientY), { passive: true });
  window.addEventListener("touchmove", (e) => torch(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  document.addEventListener("visibilitychange", () => { if (me && !document.hidden) save({}); });
}

// ---------------------------------------------------------------- 로그인
async function onLogin(e) {
  e.preventDefault();
  sfx.wake();
  const sid = $("#sid").value.trim();
  const name = $("#sname").value.trim();
  const level = $('input[name="level"]:checked').value;
  if (!/^\d{4,6}$/.test(sid)) return toast("학번은 숫자 4~6자리로 입력하세요.", "err");
  if (!name) return toast("이름을 입력하세요.", "err");
  const tcode = DB.normId($("#tcode").value);
  if (!DB.ID_RULE.test(tcode)) return toast("선생님 코드를 확인하세요.", "err");
  localStorage.setItem("er_last_tcode", tcode);
  localStorage.setItem("er_last_sid", sid);
  localStorage.setItem("er_last_name", name);
  $("#loginBtn").disabled = true;

  try {
    DB.setRoom(tcode);
    if (!(await DB.roomExists())) { toast(`'${tcode}' 선생님 코드가 없어요. 다시 확인하세요.`, "err"); return; }
    settings = await DB.getSettings();
    const prev = await DB.getPlayer(sid);
    if (prev && prev.status && prev.status !== "waiting") {
      me = prev;
      if (prev.name !== name) await save({ name });
      if (prev.level !== level) toast(`이미 '${lvName(prev.level)}' 난이도로 진행 중이라 이어서 합니다.`);
      startHeartbeat();
      return resume();
    }
    me = { id: sid, name, level, status: "waiting", floor: 0, solved: [], wrong: 0, hints: [], penaltyMs: 0, joinedAt: Date.now() };
    await DB.savePlayer(sid, { ...me, lastSeen: Date.now() });
    startHeartbeat();
    waitForOpen();
  } catch (err) {
    console.error(err);
    toast("입장 실패: " + err.message, "err");
  } finally {
    $("#loginBtn").disabled = false;
  }
}

function startHeartbeat() {
  clearInterval(hbIv);
  hbIv = setInterval(() => { if (!ended) DB.savePlayer(me.id, { lastSeen: Date.now() }).catch(() => {}); }, HEARTBEAT_MS);
}

function resume() {
  if (me.status === "playing") return enterGame();
  if (me.status === "phone") return enterGame();
  if (me.status === "escaped" || me.status === "timeout") return showEnd();
  waitForOpen();
}

// ---------------------------------------------------------------- 대기
function waitForOpen() {
  $("#waitWho").textContent = `${settings.teacherName || ""} 반 · ${me.id} ${me.name} · 난이도 ${lvName(me.level)}`;
  if (settings.open) return intro();
  show("scr-wait");
  const off = DB.watchSettings((s) => {
    settings = s;
    if (s.open) { off(); intro(); }
  });
}

// ---------------------------------------------------------------- 인트로
async function intro() {
  show("scr-intro");
  setScene("school");
  const box = $("#introText");
  box.textContent = ""; box.classList.remove("big");
  $("#noteWrap").hidden = true;
  let skipped = false;
  $("#skipBtn").hidden = false;
  $("#skipBtn").onclick = () => { skipped = true; setSkipTyping(true); };
  const wait = (ms) => (skipped ? Promise.resolve() : sleep(ms));

  await typewriter(box, "학교를 마치고 학원으로 가던 길이었다.\n해가 지고, 골목은 이상할 만큼 조용했다.\n\n뒤에서… 누군가 따라오는 발소리.");
  await wait(900);
  box.textContent = "쿵!"; box.classList.add("big");
  setScene("black");
  if (!skipped) {
    sfx.thud();
    document.body.classList.add("shake");
    const f = document.createElement("div"); f.className = "flash"; document.body.appendChild(f);
    setTimeout(() => { document.body.classList.remove("shake"); f.remove(); }, 700);
  }
  await wait(1400);
  box.classList.remove("big"); box.textContent = "";
  await wait(1200);
  setScene("hall", 0);
  await typewriter(box, `………\n\n차가운 바닥. 퀴퀴한 먼지 냄새.\n천천히 눈을 떠 보니… 여기는\n\n${CONFIG.schoolName} ${CONFIG.startRoom}?\n\n문은 모두 잠겨 있다.\n문에 종이 한 장이 붙어 있다.`);
  await wait(700);

  setSkipTyping(false);
  $("#skipBtn").hidden = true;
  const limit = settings.timeLimitMin;
  $("#note").innerHTML = `
    <div>너의 휴대폰은 <b>${esc(CONFIG.goalRoom)}</b>에 있다.</div>
    <div><span class="blood">${limit}분</span> 안에 문제를 풀어 각 층의 <b>방화문</b>을 열고</div>
    <div>5층까지 올라가 휴대폰으로 도움을 청해라.</div>
    <hr/>
    <div>${me.level === "high" ? "너는 <b>[상]</b> — 문제 <b>1개</b>를 풀면 문이 열린다." : "너는 <b>[중]</b> — 문제 <b>2개</b>를 풀어야 문이 열린다."}</div>
    <div class="blood" style="text-align:right;margin-top:10px">시간이 지나면… 기회는 없다.</div>`;
  $("#noteWrap").hidden = false;
  $("#startBtn").onclick = startGame;
}

// ---------------------------------------------------------------- 게임 시작
async function loadProblems() {
  const list = await DB.getProblems();
  problems = {};
  list.forEach((p) => (problems[p.id] = p));
  return list;
}

function buildPlan(list) {
  const k = perDoor(me.level);
  const need = DOORS * k;
  let pool = list.filter((p) => p.level === me.level);
  if (!pool.length) return null;
  if (settings.shuffle) pool = seededShuffle(pool, me.id + me.level);
  const plan = [];
  for (let i = 0; i < need; i++) plan.push(pool[i % pool.length].id);
  return plan;
}

async function startGame() {
  $("#startBtn").disabled = true;
  try {
    const list = await loadProblems();
    const plan = buildPlan(list);
    if (!plan) { toast(`아직 [${lvName(me.level)}] 난이도 문제가 등록되지 않았어요. 선생님께 알려주세요!`, "err"); return; }
    await save({
      status: "playing", plan, floor: 0, solved: [], wrong: 0, hints: [], penaltyMs: 0,
      startedAt: Date.now(), limitMs: settings.timeLimitMin * 60_000,
    });
    sfx.alarm();
    enterGame();
  } finally {
    $("#startBtn").disabled = false;
  }
}

async function enterGame() {
  if (!Object.keys(problems).length) await loadProblems();
  // 교사가 문제를 지운 경우를 대비해 빈 자리는 같은 난이도 문제로 채움
  const pool = Object.values(problems).filter((p) => p.level === me.level);
  if (!pool.length) { toast("등록된 문제가 없어요. 선생님께 알려주세요!", "err"); return; }
  if (me.plan.some((id) => !problems[id])) {
    await save({ plan: me.plan.map((id, i) => (problems[id] ? id : pool[i % pool.length].id)) });
  }
  $("#hudWho").textContent = `${me.id} ${me.name} · ${lvName(me.level)}`;
  startTimer();
  if (me.floor >= DOORS || me.status === "phone") return phoneScene();
  show("scr-game");
  setScene("hall", me.floor);
  renderBuilding();
  renderDoor();
}

// ---------------------------------------------------------------- 타이머
function remaining() {
  return me.limitMs - (Date.now() - me.startedAt) - (me.penaltyMs || 0);
}
function startTimer() {
  clearInterval(timerIv);
  const tick = () => {
    const r = remaining();
    const t = fmtTime(r);
    $("#hudTimer").textContent = t;
    $("#hudTimer2").textContent = t;
    const warn = r < 5 * 60_000;
    $("#hudTimer").classList.toggle("warn", warn);
    $("#hudTimer2").classList.toggle("warn", warn);
    document.body.classList.toggle("danger", r < 60_000);
    if (r < 60_000 && r > 0) sfx.tick();
    if (r <= 0) timeOver();
  };
  tick();
  timerIv = setInterval(tick, 1000);
}
async function timeOver() {
  if (ended) return;
  ended = true;
  clearInterval(timerIv);
  document.body.classList.remove("danger");
  sfx.alarm();
  await save({ status: "timeout", finishedAt: Date.now() });
  showEnd();
}

// ---------------------------------------------------------------- 화면 그리기
function renderBuilding() {
  $("#floors").innerHTML = FLOORS.map((f, i) => ({ f, i })).reverse().map(({ f, i }) => {
    const cls = i < me.floor ? "done" : i === me.floor ? "current" : "";
    const goal = i === FLOORS.length - 1 ? " goal" : "";
    const ico = i === me.floor ? "🧍" : i < me.floor ? "✅" : i === FLOORS.length - 1 ? "📱" : "🔒";
    return `<div class="floor ${cls}${goal}"><span class="code">${f.code}</span><span class="place">${esc(f.place)}</span><span class="ico">${ico}</span></div>`;
  }).join("");
  const f = FLOORS[me.floor];
  $("#hudLoc").innerHTML = `${esc(f.name)} <small>${esc(f.place)}</small>`;
  const total = me.plan.length;
  $("#hudProg").textContent = `🔓 ${me.solved.length}/${total}`;
}

function doorIndices(d = me.floor) {
  const k = perDoor(me.level);
  return Array.from({ length: k }, (_, i) => d * k + i);
}

function renderDoor() {
  const d = me.floor;
  $("#doorTitle").textContent = `방화문 ${FLOORS[d].code} → ${FLOORS[d + 1].code}`;
  $("#doorPlaque").outerHTML = plaque(FLOORS[d]).replace('class="plaque"', 'class="plaque" id="doorPlaque"');
  const idxs = doorIndices(d);
  if (!idxs.includes(curLock) || me.solved.includes(curLock)) curLock = idxs.find((i) => !me.solved.includes(i)) ?? idxs[0];
  $("#locks").innerHTML = idxs.map((i, n) => {
    const open = me.solved.includes(i);
    return `<span class="lock ${open ? "open" : ""} ${i === curLock && !open ? "sel" : ""}" data-i="${i}">${LOCK_SVG} 자물쇠 ${n + 1}</span>`;
  }).join("");
  $$("#locks .lock").forEach((el) => el.addEventListener("click", () => {
    const i = Number(el.dataset.i);
    if (me.solved.includes(i)) return;
    curLock = i; renderDoor();
  }));
  renderPuzzle();
}

function renderPuzzle() {
  const p = problems[me.plan[curLock]];
  $("#pImg").innerHTML = p ? `<img src="${p.image}" alt="문제" />` : "<p>문제를 불러오지 못했어요.</p>";
  $("#ansInput").value = "";
  $("#ansInput").focus();
  const used = (me.hints || []).includes(curLock);
  $("#hintBtn").hidden = !p?.hint || used;
  $("#hintBtn").textContent = `💡 힌트 보기 (−${Math.round(settings.hintPenaltySec / 60 * 10) / 10}분)`;
  $("#hintBox").hidden = !used;
  $("#hintBox").textContent = used ? "💡 " + p.hint : "";
}

function openZoom(src) {
  if (!src) return;
  $("#zoom img").src = src;
  $("#zoom").classList.add("show");
}

// ---------------------------------------------------------------- 정답 확인
async function onAnswer(e) {
  e.preventDefault();
  if (ended) return;
  const now = Date.now();
  if (now < lockUntil) return toast(`잠금장치가 작동하지 않는다… ${Math.ceil((lockUntil - now) / 1000)}초`, "err");
  const val = $("#ansInput").value;
  if (!val.trim()) return;
  const p = problems[me.plan[curLock]];
  if (!p) return;

  if (checkAnswer(val, p.hashes)) {
    sfx.correct();
    const solved = [...me.solved, curLock];
    await save({ solved });
    const el = $(`#locks .lock[data-i="${curLock}"]`);
    if (el) { el.classList.add("open", "pop"); el.lastChild.textContent = " 열림"; }
    sfx.lockOpen();
    await sleep(650);
    if (doorIndices().every((i) => me.solved.includes(i))) return openDoor();
    toast("🔓 자물쇠 하나가 풀렸다! 하나 더…");
    renderBuilding();
    renderDoor();
  } else {
    sfx.wrong();
    $(".door-panel").classList.add("shake");
    setTimeout(() => $(".door-panel").classList.remove("shake"), 500);
    lockUntil = Date.now() + (settings.wrongLockSec ?? 3) * 1000;
    toast("✖ 틀렸다. 자물쇠가 꿈쩍도 하지 않는다.", "err");
    $("#ansInput").select();
    save({ wrong: (me.wrong || 0) + 1 });
  }
}

async function onHint() {
  const p = problems[me.plan[curLock]];
  if (!p?.hint) return;
  if (!confirm(`힌트를 보면 남은 시간이 ${settings.hintPenaltySec}초 줄어듭니다. 볼까요?`)) return;
  await save({ hints: [...(me.hints || []), curLock], penaltyMs: (me.penaltyMs || 0) + settings.hintPenaltySec * 1000 });
  renderPuzzle();
}

// ---------------------------------------------------------------- 방화문 열림
async function openDoor() {
  const next = me.floor + 1;
  await save({ floor: next, ...(next >= DOORS ? { status: "phone" } : {}) });
  const ov = $("#doorOv"), door = $("#fireDoor");
  door.classList.remove("open");
  $("#ovTitle").textContent = "철컥— 방화문이 열렸다!";
  $("#ovPlace").innerHTML = plaque(FLOORS[next]);
  $("#fireDoor .frame").style.filter = next >= DOORS ? "hue-rotate(75deg) brightness(1.2)" : "";
  $("#ovStory").textContent = "";
  $("#ovNext").hidden = true;
  ov.classList.add("show");
  sfx.door();
  await sleep(250);
  door.classList.add("open");
  setScene("hall", next);
  await sleep(1500);
  await typewriter($("#ovStory"), FLOORS[next].story || `${FLOORS[next].name}에 도착했다.`, 32);
  $("#ovNext").textContent = next >= DOORS ? "휴대폰을 집어 든다 📱" : `${FLOORS[next].name} 탐색 ▲`;
  $("#ovNext").hidden = false;
  $("#ovNext").onclick = () => {
    ov.classList.remove("show");
    if (next >= DOORS) return phoneScene();
    renderBuilding();
    renderDoor();
  };
}

// ---------------------------------------------------------------- 휴대폰
function phoneScene() {
  show("scr-phone");
  setScene("hall", FLOORS.length - 1);
  let num = "";
  const disp = $("#phDisplay"), sub = $("#phSub");
  const d = new Date();
  $("#phClock").textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  disp.textContent = ""; sub.textContent = "긴급 전화 — 도움을 요청할 번호를 누르세요";
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
  $("#pad").innerHTML = keys.map((k) => `<button data-k="${k}">${k}</button>`).join("") +
    `<span></span><button class="call" data-k="call">📞</button><button class="del" data-k="del">⌫</button>`;
  $$("#pad button").forEach((b) => b.addEventListener("click", async () => {
    const k = b.dataset.k;
    if (k === "del") { num = num.slice(0, -1); disp.textContent = num; return; }
    if (k === "call") {
      if (CONFIG.emergencyNumbers.includes(num)) return call(num);
      sfx.wrong(); sub.textContent = "연결할 수 없는 번호입니다."; $("#phone").classList.add("shake");
      setTimeout(() => $("#phone").classList.remove("shake"), 500);
      num = ""; disp.textContent = ""; return;
    }
    if (num.length < 12) { num += k; disp.textContent = num; sfx.dial(k); }
  }));

  async function call(n) {
    $("#phone").classList.add("calling");
    disp.textContent = `${n} 연결 중…`;
    sub.textContent = "";
    sfx.ring();
    await sleep(2300);
    disp.textContent = "연결됨";
    sub.textContent = `"${CONFIG.schoolName} 5층입니다! 도와주세요!"`;
    await sleep(1600);
    escaped();
  }
}

async function escaped() {
  if (ended) return;
  ended = true;
  clearInterval(timerIv);
  document.body.classList.remove("danger");
  sfx.win();
  await save({ status: "escaped", finishedAt: Date.now() });
  showEnd();
}

// ---------------------------------------------------------------- 결과
function showEnd() {
  ended = true;
  clearInterval(timerIv);
  document.body.classList.remove("danger");
  show("scr-end");
  const win = me.status === "escaped";
  setScene(win ? "dawn" : "dead");
  document.body.classList.toggle("escaped", win);
  const used = (me.finishedAt || Date.now()) - me.startedAt + (me.penaltyMs || 0);
  const floorName = FLOORS[Math.min(me.floor, FLOORS.length - 1)].name;
  $("#endBox").innerHTML = win ? `
      <span class="exit-sign">🏃 EXIT</span>
      <div class="big win">탈출 성공!</div>
      <p class="mono">멀리서 사이렌 소리가 들린다. 살았다…</p>
      <div class="stats">
        <div><b>${fmtTime(used)}</b><small>기록 (힌트 감점 포함)</small></div>
        <div><b>${me.wrong || 0}</b><small>오답 수</small></div>
        <div><b>${(me.hints || []).length}</b><small>힌트 사용</small></div>
      </div>
      <p class="muted">${esc(me.id)} ${esc(me.name)} · 난이도 ${lvName(me.level)}</p>` : `
      <div class="big lose">시간 초과</div>
      <p class="mono">비상등이 꺼졌다. 어둠 속에서… 발소리가 멈췄다.</p>
      <div class="stats">
        <div><b>${esc(floorName)}</b><small>도달한 층</small></div>
        <div><b>${(me.solved || []).length}/${(me.plan || []).length}</b><small>푼 자물쇠</small></div>
        <div><b>${me.wrong || 0}</b><small>오답 수</small></div>
      </div>
      <p class="muted">${esc(me.id)} ${esc(me.name)} · 난이도 ${lvName(me.level)}</p>`;
}
