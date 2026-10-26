// =====================================================================
//  데이터 저장소
//  - Firebase 설정이 있으면 Firestore(실시간, 여러 기기)
//  - 없으면 DEMO 모드(localStorage, 같은 브라우저의 탭끼리만)
// =====================================================================
import { CONFIG } from "./config.js";
import { hashAnswers } from "./utils.js";

export const mode = CONFIG.firebase && CONFIG.firebase.apiKey ? "firebase" : "demo";
const FB_VER = "10.12.2";
let fb = null;

const DEFAULT_SETTINGS = { open: false, ...CONFIG.defaults };

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

// ---------------- 교사 인증 ----------------
export async function teacherLogin(password) {
  if (mode === "firebase") {
    try {
      await fb.au.signInWithEmailAndPassword(fb.auth, CONFIG.teacherEmail, password);
      return true;
    } catch (e) { console.warn(e); return false; }
  }
  const ok = password === CONFIG.demoTeacherPassword;
  if (ok) sessionStorage.setItem("er_teacher", "1");
  return ok;
}
export async function isTeacher() {
  if (mode === "firebase") return fb.auth.currentUser?.email === CONFIG.teacherEmail;
  return sessionStorage.getItem("er_teacher") === "1";
}
export async function teacherLogout() {
  if (mode === "firebase") await fb.au.signOut(fb.auth);
  sessionStorage.removeItem("er_teacher");
}

// ---------------- DEMO 저장소 ----------------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch (e) { alert("브라우저 저장 공간이 가득 찼어요. 문제 수를 줄이거나 Firebase 모드를 사용하세요."); throw e; }
  },
};
function localWatch(key, fn, cb) {
  let last = "";
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
    const { fs, db } = fb;
    const s = await fs.getDoc(fs.doc(db, "escape", "settings"));
    return { ...DEFAULT_SETTINGS, ...(s.exists() ? s.data() : {}) };
  }
  return { ...DEFAULT_SETTINGS, ...LS.get("er_settings", {}) };
}
export async function saveSettings(patch) {
  if (mode === "firebase") {
    const { fs, db } = fb;
    return fs.setDoc(fs.doc(db, "escape", "settings"), patch, { merge: true });
  }
  LS.set("er_settings", { ...LS.get("er_settings", {}), ...patch });
}
export function watchSettings(cb) {
  if (mode === "firebase") {
    const { fs, db } = fb;
    return fs.onSnapshot(fs.doc(db, "escape", "settings"), (s) => cb({ ...DEFAULT_SETTINGS, ...(s.exists() ? s.data() : {}) }));
  }
  return localWatch("er_settings", () => ({ ...DEFAULT_SETTINGS, ...LS.get("er_settings", {}) }), cb);
}

// ---------------- 문제 ----------------
// problem = { id, level:'mid'|'high', order, image(dataURL), hashes:[], hint }
export async function getProblems() {
  let list;
  if (mode === "firebase") {
    const { fs, db } = fb;
    const snap = await fs.getDocs(fs.collection(db, "problems"));
    list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } else {
    list = LS.get("er_problems", []);
  }
  return list.sort((a, b) => (a.level === b.level ? (a.order ?? 0) - (b.order ?? 0) : a.level < b.level ? -1 : 1));
}
export async function addProblem({ level, order, image, hint }, answerText) {
  const data = { level, order, image, hint: hint || "", hashes: hashAnswers(answerText), createdAt: Date.now() };
  if (mode === "firebase") {
    const { fs, db } = fb;
    const ref = await fs.addDoc(fs.collection(db, "problems"), data);
    await fs.setDoc(fs.doc(db, "answerKeys", ref.id), { answer: answerText });
    return ref.id;
  }
  const id = newId();
  LS.set("er_problems", [...LS.get("er_problems", []), { id, ...data }]);
  LS.set("er_keys", { ...LS.get("er_keys", {}), [id]: answerText });
  return id;
}
export async function updateProblem(id, patch, answerText) {
  if (answerText !== undefined) patch = { ...patch, hashes: hashAnswers(answerText) };
  if (mode === "firebase") {
    const { fs, db } = fb;
    await fs.updateDoc(fs.doc(db, "problems", id), patch);
    if (answerText !== undefined) await fs.setDoc(fs.doc(db, "answerKeys", id), { answer: answerText });
    return;
  }
  LS.set("er_problems", LS.get("er_problems", []).map((p) => (p.id === id ? { ...p, ...patch } : p)));
  if (answerText !== undefined) LS.set("er_keys", { ...LS.get("er_keys", {}), [id]: answerText });
}
export async function deleteProblem(id) {
  if (mode === "firebase") {
    const { fs, db } = fb;
    await fs.deleteDoc(fs.doc(db, "problems", id));
    await fs.deleteDoc(fs.doc(db, "answerKeys", id));
    return;
  }
  LS.set("er_problems", LS.get("er_problems", []).filter((p) => p.id !== id));
  const k = LS.get("er_keys", {}); delete k[id]; LS.set("er_keys", k);
}
export async function getAnswerKeys() {
  if (mode === "firebase") {
    const { fs, db } = fb;
    const snap = await fs.getDocs(fs.collection(db, "answerKeys"));
    const o = {}; snap.docs.forEach((d) => (o[d.id] = d.data().answer)); return o;
  }
  return LS.get("er_keys", {});
}

// ---------------- 학생 기록 ----------------
export async function getPlayer(id) {
  if (mode === "firebase") {
    const { fs, db } = fb;
    const s = await fs.getDoc(fs.doc(db, "players", id));
    return s.exists() ? { id: s.id, ...s.data() } : null;
  }
  return LS.get("er_players", {})[id] || null;
}
export async function savePlayer(id, patch) {
  if (mode === "firebase") {
    const { fs, db } = fb;
    return fs.setDoc(fs.doc(db, "players", id), patch, { merge: true });
  }
  const all = LS.get("er_players", {});
  all[id] = { ...(all[id] || { id }), ...patch };
  LS.set("er_players", all);
}
export function watchPlayers(cb) {
  if (mode === "firebase") {
    const { fs, db } = fb;
    return fs.onSnapshot(fs.collection(db, "players"), (snap) => {
      const o = {}; snap.docs.forEach((d) => (o[d.id] = { id: d.id, ...d.data() })); cb(o);
    });
  }
  return localWatch("er_players", () => LS.get("er_players", {}), cb);
}
export async function deletePlayer(id) {
  if (mode === "firebase") { const { fs, db } = fb; return fs.deleteDoc(fs.doc(db, "players", id)); }
  const all = LS.get("er_players", {}); delete all[id]; LS.set("er_players", all);
}
export async function clearPlayers() {
  if (mode === "firebase") {
    const { fs, db } = fb;
    const snap = await fs.getDocs(fs.collection(db, "players"));
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = fs.writeBatch(db);
      snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    return;
  }
  LS.set("er_players", {});
}
