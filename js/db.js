// =====================================================================
//  데이터 저장소 — 선생님마다 '방'이 따로 있습니다.
//    rooms/{선생님코드}                 ← 설정(입장 열기, 제한시간 …) + 선생님 이름
//    rooms/{선생님코드}/problems/{id}   ← 문제 이미지 + 정답 해시
//    rooms/{선생님코드}/answerKeys/{id} ← 정답 원문 (그 선생님만)
//    rooms/{선생님코드}/players/{학번}  ← 학생 진행 기록
//  - Firebase 설정이 있으면 Firestore(실시간, 여러 기기)
//  - 없으면 DEMO 모드(localStorage, 같은 브라우저의 탭끼리만)
// =====================================================================
import { CONFIG } from "./config.js";
import { hashAnswers } from "./utils.js";

export const mode = CONFIG.firebase && CONFIG.firebase.apiKey ? "firebase" : "demo";
const FB_VER = "10.12.2";
let fb = null;
let room = null; // 현재 선생님 코드

const DEFAULT_SETTINGS = { open: false, ...CONFIG.defaults };
export const ID_RULE = /^[a-z0-9]{3,12}$/;
export const normId = (s) => String(s ?? "").trim().toLowerCase();
const idToEmail = (id) => `${normId(id)}@${CONFIG.idDomain}`;

export function setRoom(code) { room = normId(code); }
export function getRoom() { return room; }

// ---------------- 공통 ----------------
export async function init(role) {
  if (mode !== "firebase") return;
  const base = `https://www.gstatic.com/firebasejs/${FB_VER}`;
  const [appM, fs, au] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-firestore.js`),
    import(`${base}/firebase-auth.js`),
  ]);
  const app = appM.initializeApp(CONFIG.firebase);
  fb = { fs, au, db: fs.getFirestore(app), auth: au.getAuth(app) };
  const user = await new Promise((res) => {
    const off = au.onAuthStateChanged(fb.auth, (u) => { off(); res(u); });
  });
  if (role === "student" && !user) await au.signInAnonymously(fb.auth);
}

// Firestore 경로 도우미
const rDoc = () => fb.fs.doc(fb.db, "rooms", room);
const rCol = (name) => fb.fs.collection(fb.db, "rooms", room, name);
const rItem = (name, id) => fb.fs.doc(fb.db, "rooms", room, name, id);

// ---------------- 교사 인증 ----------------
// 반환: { ok: true } 또는 { ok: false, msg }
export async function teacherLogin(id, password) {
  id = normId(id);
  if (!ID_RULE.test(id)) return { ok: false, msg: "아이디는 영문 소문자·숫자 3~12자예요." };
  if (mode === "firebase") {
    try {
      // 브라우저를 닫으면 로그인이 풀리도록 (교실 PC를 여러 선생님이 함께 쓰는 경우 대비)
      await fb.au.setPersistence(fb.auth, fb.au.browserSessionPersistence);
      await fb.au.signInWithEmailAndPassword(fb.auth, idToEmail(id), password);
    } catch (e) {
      console.warn(e);
      return { ok: false, msg: "아이디 또는 비밀번호가 틀렸습니다." };
    }
  } else {
    if (password !== CONFIG.demoTeacherPassword) return { ok: false, msg: "DEMO 모드 비밀번호가 틀렸습니다." };
    sessionStorage.setItem("er_teacher", id);
  }
  setRoom(id);
  await ensureRoom();
  return { ok: true };
}

export async function teacherSignup({ id, name, password, code }) {
  id = normId(id);
  if (!ID_RULE.test(id)) return { ok: false, msg: "아이디는 영문 소문자·숫자 3~12자로 정해 주세요." };
  if (CONFIG.signupCode && code !== CONFIG.signupCode) return { ok: false, msg: "가입 코드가 맞지 않아요. 처음 사이트를 만든 선생님께 물어보세요." };
  if (!password || password.length < 6) return { ok: false, msg: "비밀번호는 6자 이상이어야 해요." };
  if (mode === "firebase") {
    try {
      await fb.au.setPersistence(fb.auth, fb.au.browserSessionPersistence);
      await fb.au.createUserWithEmailAndPassword(fb.auth, idToEmail(id), password);
    } catch (e) {
      console.warn(e);
      if (e.code === "auth/email-already-in-use") return { ok: false, msg: "이미 쓰고 있는 아이디예요. 다른 아이디를 정해 주세요." };
      return { ok: false, msg: "등록 실패: " + (e.code || e.message) };
    }
  } else {
    sessionStorage.setItem("er_teacher", id);
  }
  setRoom(id);
  await ensureRoom(name);
  return { ok: true };
}

// 로그인되어 있으면 선생님 코드, 아니면 null
export async function currentTeacher() {
  if (mode === "firebase") {
    const u = fb.auth.currentUser;
    if (!u || u.isAnonymous || !u.email?.endsWith("@" + CONFIG.idDomain)) return null;
    return u.email.split("@")[0];
  }
  return sessionStorage.getItem("er_teacher");
}

export async function teacherLogout() {
  if (mode === "firebase") await fb.au.signOut(fb.auth);
  sessionStorage.removeItem("er_teacher");
}

// 방(설정 문서)이 없으면 만들기
async function ensureRoom(name) {
  const exists = await roomExists();
  if (exists && !name) return;
  const patch = { teacherName: name || room, ...(exists ? {} : { ...DEFAULT_SETTINGS, createdAt: Date.now() }) };
  if (mode === "firebase") await fb.fs.setDoc(rDoc(), patch, { merge: true });
  else LS.set(k("settings"), { ...LS.get(k("settings"), {}), ...patch });
}

export async function roomExists() {
  if (mode === "firebase") return (await fb.fs.getDoc(rDoc())).exists();
  return localStorage.getItem(k("settings")) !== null;
}

// ---------------- DEMO 저장소 ----------------
const k = (name) => `er:${room}:${name}`;
const LS = {
  get(key, d) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); }
    catch (e) { alert("브라우저 저장 공간이 가득 찼어요. 문제 수를 줄이거나 Firebase 모드를 사용하세요."); throw e; }
  },
};
function localWatch(key, fn, cb) {
  let last = null;
  const run = () => {
    const raw = localStorage.getItem(key) || "";
    if (raw !== last) { last = raw; cb(fn()); }
  };
  run();
  const iv = setInterval(run, 1000);
  const onStorage = (e) => { if (e.key === key) run(); };
  window.addEventListener("storage", onStorage);
  return () => { clearInterval(iv); window.removeEventListener("storage", onStorage); };
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------------- 설정 ----------------
export async function getSettings() {
  if (mode === "firebase") {
    const s = await fb.fs.getDoc(rDoc());
    return { ...DEFAULT_SETTINGS, ...(s.exists() ? s.data() : {}) };
  }
  return { ...DEFAULT_SETTINGS, ...LS.get(k("settings"), {}) };
}
export async function saveSettings(patch) {
  if (mode === "firebase") return fb.fs.setDoc(rDoc(), patch, { merge: true });
  LS.set(k("settings"), { ...LS.get(k("settings"), {}), ...patch });
}
export function watchSettings(cb) {
  if (mode === "firebase") {
    return fb.fs.onSnapshot(rDoc(), (s) => cb({ ...DEFAULT_SETTINGS, ...(s.exists() ? s.data() : {}) }));
  }
  return localWatch(k("settings"), () => ({ ...DEFAULT_SETTINGS, ...LS.get(k("settings"), {}) }), cb);
}

// ---------------- 문제 ----------------
// problem = { id, level:'mid'|'high', order, image(dataURL), hashes:[], hint }
const sortProblems = (list) =>
  list.sort((a, b) => (a.level === b.level ? (a.order ?? 0) - (b.order ?? 0) : a.level < b.level ? -1 : 1));

export async function getProblems() {
  if (mode === "firebase") {
    const snap = await fb.fs.getDocs(rCol("problems"));
    return sortProblems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }
  return sortProblems(LS.get(k("problems"), []));
}
export async function addProblem({ level, order, image, hint }, answerText) {
  const data = { level, order, image, hint: hint || "", hashes: hashAnswers(answerText), createdAt: Date.now() };
  if (mode === "firebase") {
    const ref = await fb.fs.addDoc(rCol("problems"), data);
    await fb.fs.setDoc(rItem("answerKeys", ref.id), { answer: answerText });
    return ref.id;
  }
  const id = newId();
  LS.set(k("problems"), [...LS.get(k("problems"), []), { id, ...data }]);
  LS.set(k("keys"), { ...LS.get(k("keys"), {}), [id]: answerText });
  return id;
}
export async function updateProblem(id, patch, answerText) {
  if (answerText !== undefined) patch = { ...patch, hashes: hashAnswers(answerText) };
  if (mode === "firebase") {
    await fb.fs.updateDoc(rItem("problems", id), patch);
    if (answerText !== undefined) await fb.fs.setDoc(rItem("answerKeys", id), { answer: answerText });
    return;
  }
  LS.set(k("problems"), LS.get(k("problems"), []).map((p) => (p.id === id ? { ...p, ...patch } : p)));
  if (answerText !== undefined) LS.set(k("keys"), { ...LS.get(k("keys"), {}), [id]: answerText });
}
export async function deleteProblem(id) {
  if (mode === "firebase") {
    await fb.fs.deleteDoc(rItem("problems", id));
    await fb.fs.deleteDoc(rItem("answerKeys", id));
    return;
  }
  LS.set(k("problems"), LS.get(k("problems"), []).filter((p) => p.id !== id));
  const keys = LS.get(k("keys"), {}); delete keys[id]; LS.set(k("keys"), keys);
}
export async function getAnswerKeys() {
  if (mode === "firebase") {
    const snap = await fb.fs.getDocs(rCol("answerKeys"));
    const o = {}; snap.docs.forEach((d) => (o[d.id] = d.data().answer)); return o;
  }
  return LS.get(k("keys"), {});
}

// ---------------- 학생 기록 ----------------
export async function getPlayer(id) {
  if (mode === "firebase") {
    const s = await fb.fs.getDoc(rItem("players", id));
    return s.exists() ? { id: s.id, ...s.data() } : null;
  }
  return LS.get(k("players"), {})[id] || null;
}
export async function savePlayer(id, patch) {
  if (mode === "firebase") return fb.fs.setDoc(rItem("players", id), patch, { merge: true });
  const all = LS.get(k("players"), {});
  all[id] = { ...(all[id] || { id }), ...patch };
  LS.set(k("players"), all);
}
export function watchPlayers(cb) {
  if (mode === "firebase") {
    return fb.fs.onSnapshot(rCol("players"), (snap) => {
      const o = {}; snap.docs.forEach((d) => (o[d.id] = { id: d.id, ...d.data() })); cb(o);
    });
  }
  return localWatch(k("players"), () => LS.get(k("players"), {}), cb);
}
export async function deletePlayer(id) {
  if (mode === "firebase") return fb.fs.deleteDoc(rItem("players", id));
  const all = LS.get(k("players"), {}); delete all[id]; LS.set(k("players"), all);
}
export async function clearPlayers() {
  if (mode === "firebase") {
    const snap = await fb.fs.getDocs(rCol("players"));
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = fb.fs.writeBatch(fb.db);
      snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    return;
  }
  LS.set(k("players"), {});
}
