import { firebaseConfig, ADMIN_SETUP_KEY } from "./firebase-config.js";
import { tr, DIR, LANG_NAME, LANGS } from "./i18n.js";
import { seedQuestions, CATEGORIES } from "./questions.js";

import { initializeApp, getApp, getApps } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, setPersistence, browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
  collection, getDocs, query, where, orderBy, serverTimestamp, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
// Explicit local persistence: keep the session in this browser across tab
// closes / restarts, so the login screen isn't shown again on the same
// device until the user explicitly signs out.
setPersistence(auth, browserLocalPersistence).catch(() => {});

// Secondary app instance so the admin can create candidate accounts
// without Firebase Auth switching the admin's own session to the new user.
function getSecondaryApp() {
  const name = "secondary";
  const existing = getApps().find((a) => a.name === name);
  return existing || initializeApp(firebaseConfig, name);
}

// ---------- Global state ----------
let state = {
  lang: localStorage.getItem("lang") || "ar",
  user: null,       // firebase auth user
  profile: null,     // users/{uid} doc
  route: "login",    // login | admin | exam | result | admin-setup
  questions: [],
  candidates: [],
  attempts: {},
};

function L(key, vars) { return tr(state.lang, key, vars); }

function setState(patch) {
  state = { ...state, ...patch };
  render();
}

// ---------- Boot ----------
const root = document.getElementById("app");

document.documentElement.lang = state.lang;
document.documentElement.dir = DIR[state.lang];

onAuthStateChanged(auth, async (user) => {
  stopStaffWatchers();
  if (!user) {
    setState({ user: null, profile: null, route: location.hash === "#admin-setup" ? "admin-setup" : "login" });
    return;
  }
  const snap = await getDoc(doc(db, "users", user.uid));
  if (!snap.exists()) {
    // No profile — shouldn't normally happen; sign out to be safe.
    await signOut(auth);
    return;
  }
  const profile = { id: user.uid, ...snap.data() };
  if (profile.role === "candidate" || profile.role === "coadmin") {
    if (await isFingerprintBlocked()) {
      await signOut(auth);
      setState({ user: null, profile: null, route: "login", loginBlocked: true });
      return;
    }
  }
  if (profile.role === "candidate") {
    const deviceId = getDeviceId();
    if (deviceId !== profile.deviceId) {
      updateDoc(doc(db, "users", user.uid), { deviceId }).catch(() => {});
    }
  }
  setState({
    user,
    profile,
    route: profile.role === "candidate" ? "exam" : "admin",
  });
  if (profile.role === "admin" || profile.role === "coadmin") {
    watchCandidates();
    watchQuestions();
    watchAttempts();
  }
});

window.addEventListener("hashchange", () => {
  if (!state.user && location.hash === "#admin-setup") setState({ route: "admin-setup" });
});

// ---------- Firestore watchers (admin/coadmin) ----------
let unsubCandidates = null;
function watchCandidates() {
  if (unsubCandidates) return;
  const q = query(collection(db, "users"), where("role", "==", "candidate"));
  unsubCandidates = onSnapshot(q, (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    setState({ candidates: list });
  });
}

let unsubQuestions = null;
function watchQuestions() {
  if (unsubQuestions) return;
  unsubQuestions = onSnapshot(collection(db, "questions"), (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    setState({ questions: list });
  });
}

let unsubAttempts = null;
function watchAttempts() {
  if (unsubAttempts) return;
  unsubAttempts = onSnapshot(collection(db, "attempts"), (snap) => {
    const map = {};
    snap.forEach((d) => { map[d.id] = d.data(); });
    setState({ attempts: map });
  });
}

function stopStaffWatchers() {
  if (unsubCandidates) { unsubCandidates(); unsubCandidates = null; }
  if (unsubQuestions) { unsubQuestions(); unsubQuestions = null; }
  if (unsubAttempts) { unsubAttempts(); unsubAttempts = null; }
}

// ---------- Helpers ----------
// Firebase Auth needs an email under the hood; candidates/co-admins log in
// with an 11-digit phone number instead, so we map phone -> a synthetic
// email address that never leaves the client.
const PHONE_DOMAIN = "phone.interview.local";
function phoneToEmail(phone) { return `${phone}@${PHONE_DOMAIN}`; }
function isPhone(v) { return /^\d{11}$/.test(v); }

// ---------- Device fingerprint (best-effort abuse deterrent) ----------
// NOT a real security boundary: clearing localStorage or using a different
// browser routes around this. It only stops the common case of someone
// re-registering with the same phone on the same browser after a block.
//
// Deliberately device-only, NOT IP-based: an IP is shared by an entire
// household/office network (NAT), so blocking an IP can lock out everyone
// on that network, including staff/admins — this happened once during
// testing and is not an acceptable tradeoff for a soft deterrent.
function getDeviceId() {
  let id = localStorage.getItem("device_id");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem("device_id", id);
  }
  return id;
}
async function isFingerprintBlocked() {
  try {
    const snap = await getDoc(doc(db, "blockedDevices", getDeviceId()));
    return snap.exists();
  } catch (err) {
    // Fail-open: this is a deterrent, not the primary access control (the
    // per-account "blocked" flag is), so a rules/network hiccup here must
    // never lock every candidate out of the exam.
    console.warn("fingerprint check failed, allowing sign-in", err);
    return false;
  }
}
async function blacklistFingerprint(c) {
  if (!c.deviceId) return;
  await setDoc(doc(db, "blockedDevices", c.deviceId), { blockedAt: serverTimestamp(), fromUid: c.id });
}
async function unblacklistFingerprint(c) {
  if (!c.deviceId) return;
  await deleteDoc(doc(db, "blockedDevices", c.deviceId)).catch(() => {});
}

function genCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ============================================================
// RENDER
// ============================================================
function render() {
  document.documentElement.lang = state.lang;
  document.documentElement.dir = DIR[state.lang];
  root.innerHTML = "";
  root.appendChild(langSwitcher());

  if (state.route === "admin-setup") return root.appendChild(renderAdminSetup());
  if (!state.user) return root.appendChild(renderLogin());

  if (state.profile?.role === "candidate") {
    if (state.route === "result" || ["submitted", "graded"].includes(state.profile.examStatus)) {
      root.appendChild(renderResult());
    } else {
      root.appendChild(renderExam());
    }
    return;
  }

  // admin / coadmin
  root.appendChild(renderAdminShell());
}

// Real flag glyphs. Kurdish has no official Unicode flag emoji, so it's a
// tiny inline SVG of the Kurdistan flag instead of an emoji.
const KURD_FLAG_SVG = `<svg viewBox="0 0 30 20" class="flag-svg"><rect width="30" height="20" fill="#ED1C24"/><rect width="30" height="13.34" fill="#fff"/><rect width="30" height="6.67" fill="#007A3D"/><circle cx="15" cy="10" r="3.2" fill="none" stroke="#F9A11B" stroke-width="0.5"/><g fill="#F9A11B">${Array.from({length:21},(_,i)=>{const a=(i*360/21)*Math.PI/180;const x1=15+2.6*Math.cos(a),y1=10+2.6*Math.sin(a),x2=15+4*Math.cos(a),y2=10+4*Math.sin(a);return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#F9A11B" stroke-width="0.5"/>`;}).join("")}</g></svg>`;
const LANG_FLAG = { ar: "🇮🇶", ku: KURD_FLAG_SVG, en: "🇺🇸" };
function flagHtml(l) { return l === "ku" ? KURD_FLAG_SVG : `<span class="flag-emoji">${LANG_FLAG[l]}</span>`; }

function langSwitcher() {
  const wrap = el(`
    <div class="lang-dd">
      <button class="lang-dd-btn" id="lang-dd-btn" type="button" aria-label="${L("changeLang")}">
        ${flagHtml(state.lang)}
      </button>
      <div class="lang-dd-menu" id="lang-dd-menu" hidden></div>
    </div>
  `);
  const menu = wrap.querySelector("#lang-dd-menu");
  LANGS.forEach((l) => {
    const item = el(`
      <button type="button" class="lang-dd-item ${l === state.lang ? "active" : ""}">
        ${flagHtml(l)}
        <span>${LANG_NAME[l]}</span>
        <span class="lang-dd-check">${l === state.lang ? "✔" : ""}</span>
      </button>
    `);
    item.onclick = () => { localStorage.setItem("lang", l); setState({ lang: l }); };
    menu.appendChild(item);
  });
  const btn = wrap.querySelector("#lang-dd-btn");
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener("click", () => { menu.hidden = true; }, { once: true });
  return wrap;
}

// ---------- Admin bootstrap ----------
function renderAdminSetup() {
  const wrap = el(`
    <div class="card center-card">
      <h1>${L("adminSetupTitle")}</h1>
      <form id="setup-form">
        <label>${L("name")}<input required name="name" /></label>
        <label>${L("email")}<input required type="email" name="email" /></label>
        <label>${L("password")}<input required type="password" name="password" minlength="6" /></label>
        <label>${L("setupKey")}<input required type="password" name="key" /></label>
        <div class="err" id="setup-err"></div>
        <button type="submit">${L("setupBtn")}</button>
      </form>
    </div>
  `);
  wrap.querySelector("#setup-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const key = f.get("key");
    const errBox = wrap.querySelector("#setup-err");
    errBox.textContent = "";
    if (key !== ADMIN_SETUP_KEY) { errBox.textContent = L("error"); return; }
    let cred;
    try {
      const bootstrapSnap = await getDoc(doc(db, "meta", "adminBootstrap"));
      if (bootstrapSnap.exists()) { errBox.textContent = L("setupExists"); return; }
      cred = await createUserWithEmailAndPassword(auth, f.get("email"), f.get("password"));
      await setDoc(doc(db, "users", cred.user.uid), {
        role: "admin", name: f.get("name"), email: f.get("email"),
        createdAt: serverTimestamp(),
      });
      await setDoc(doc(db, "meta", "adminBootstrap"), { createdAt: serverTimestamp(), by: cred.user.uid });
    } catch (err) {
      // Race lost (someone else bootstrapped first) or write denied — undo the auth account.
      console.error("admin-setup error", err.code, err.message, err);
      if (cred?.user) { try { await cred.user.delete(); } catch {} }
      errBox.textContent = err.code === "permission-denied" ? L("setupExists") : `${err.code || ""} ${err.message}`;
    }
  };
  return wrap;
}

// ---------- Login ----------
// Admin signs in with a real email; candidates & co-admins sign in with an
// 11-digit phone number instead (mapped to a synthetic email under the hood
// via phoneToEmail — see the Helpers section).
function renderLogin() {
  const wrap = el(`
    <div class="card center-card">
      <img class="brand-logo" src="assets/brand/logo.svg" alt="${L("appName")}" />
      <h1>${L("appName")}</h1>
      <h2>${L("loginTitle")}</h2>
      ${state.loginBlocked ? `<div class="err">${L("loginBlockedMsg")}</div>` : ""}
      <form id="login-form">
        <label>${L("email")} / ${L("phone")}
          <input required name="identifier" autocomplete="username" placeholder="you@email.com — or — 07701234567" />
        </label>
        <p class="hint">${L("phoneLoginHint")}</p>
        <label>${L("password")}<input required type="password" name="password" autocomplete="current-password" /></label>
        <div class="err" id="login-err"></div>
        <button type="submit">${L("loginBtn")}</button>
      </form>
    </div>
  `);
  wrap.querySelector("#login-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const errBox = wrap.querySelector("#login-err");
    errBox.textContent = "";
    const raw = String(f.get("identifier")).trim();
    const email = raw.includes("@") ? raw : phoneToEmail(raw);
    try {
      await signInWithEmailAndPassword(auth, email, f.get("password"));
    } catch (err) {
      errBox.textContent = L("loginError");
    }
  };
  return wrap;
}

// ============================================================
// ADMIN / CO-ADMIN
// ============================================================
function renderAdminShell() {
  const isAdmin = state.profile.role === "admin";
  const tab = state.adminTab || "candidates";
  const wrap = el(`
    <div class="shell">
      <header class="topbar">
        <div class="brand">${L("appName")}</div>
        <div class="who">${L("welcome")}, ${escapeHtml(state.profile.name || "")} · ${L(state.profile.role === "admin" ? "roleAdmin" : "roleCoadmin")}</div>
        <button id="logout-btn" class="ghost">${L("logout")}</button>
      </header>
      <nav class="tabs">
        <button data-tab="candidates" class="${tab === "candidates" ? "active" : ""}">${L("candidates")}</button>
        <button data-tab="questions" class="${tab === "questions" ? "active" : ""}">${L("questionsBank")}</button>
        ${isAdmin ? `<button data-tab="coadmins" class="${tab === "coadmins" ? "active" : ""}">${L("coadmins")}</button>` : ""}
      </nav>
      <main id="tab-body"></main>
    </div>
  `);
  wrap.querySelector("#logout-btn").onclick = () => signOut(auth);
  wrap.querySelectorAll("[data-tab]").forEach((b) => {
    b.onclick = () => setState({ adminTab: b.dataset.tab });
  });
  const body = wrap.querySelector("#tab-body");
  if (tab === "candidates") body.appendChild(renderCandidatesTab());
  else if (tab === "questions") body.appendChild(renderQuestionsTab());
  else if (tab === "coadmins" && isAdmin) body.appendChild(renderCoadminsTab());
  return wrap;
}

const EXAM_STATUS_KEY = { not_started: "notStarted", in_progress: "inProgress", submitted: "submitted", graded: "graded" };
function statusLabel(c) {
  if (c.blocked) return L("blocked");
  return L(EXAM_STATUS_KEY[c.examStatus] || "notStarted");
}

function renderCandidatesTab() {
  const wrap = el(`
    <div>
      <button id="new-cand-btn" class="primary">${L("createCandidate")}</button>
      <div id="new-cand-form"></div>
      <table class="grid">
        <thead><tr>
          <th>${L("name")}</th><th>${L("phone")}</th>
          <th>${L("status")}</th><th>${L("score")}</th><th></th>
        </tr></thead>
        <tbody id="cand-rows"></tbody>
      </table>
    </div>
  `);
  wrap.querySelector("#new-cand-btn").onclick = () => {
    const formHost = wrap.querySelector("#new-cand-form");
    formHost.innerHTML = "";
    formHost.appendChild(renderNewCandidateForm());
  };
  const rows = wrap.querySelector("#cand-rows");
  state.candidates.forEach((c) => {
    const att = state.attempts[c.id];
    const tr = el(`
      <tr>
        <td>${escapeHtml(c.name)}</td>
        <td>${escapeHtml(c.phone || "")}</td>
        <td>${statusLabel(c)}</td>
        <td>${att ? `${att.score}/${att.totalPoints}` : "—"}</td>
        <td class="row-actions"></td>
      </tr>
    `);
    const actions = tr.querySelector(".row-actions");
    if (["submitted", "graded"].includes(c.examStatus)) {
      const btn = el(`<button class="link">${L("viewResult")}</button>`);
      btn.onclick = () => setState({ adminTab: "candidates", viewCandidate: c.id });
      actions.appendChild(btn);
    }
    const blockBtn = el(`<button class="link warn">${c.blocked ? L("unblock") : L("block")}</button>`);
    blockBtn.onclick = async () => {
      const blocking = !c.blocked;
      await updateDoc(doc(db, "users", c.id), { blocked: blocking });
      try { if (blocking) await blacklistFingerprint(c); else await unblacklistFingerprint(c); } catch (err) { console.warn("fingerprint blacklist write failed", err); }
    };
    actions.appendChild(blockBtn);
    if (state.profile.role === "admin") {
      const delBtn = el(`<button class="link danger">${L("delete")}</button>`);
      delBtn.onclick = async () => {
        if (!confirm(L("delete") + "?")) return;
        try { await blacklistFingerprint(c); } catch (err) { console.warn("fingerprint blacklist write failed", err); }
        await deleteDoc(doc(db, "users", c.id));
      };
      actions.appendChild(delBtn);
    }
    rows.appendChild(tr);
  });
  if (state.viewCandidate) {
    const c = state.candidates.find((x) => x.id === state.viewCandidate);
    if (c) wrap.appendChild(renderCandidateResultPanel(c));
  }
  return wrap;
}

function renderCandidateResultPanel(c) {
  const wrap = el(`<div class="card"><h3>${escapeHtml(c.name)} — ${L("yourResult")}</h3><div id="res-body">${L("loading")}</div></div>`);
  getDoc(doc(db, "attempts", c.id)).then((snap) => {
    const body = wrap.querySelector("#res-body");
    if (!snap.exists()) { body.textContent = "—"; return; }
    const a = snap.data();
    body.innerHTML = "";
    state.questions.filter(q => a.answers && q.id in a.answers).forEach((q, i) => {
      const given = a.answers[q.id];
      const correct = q.type === "truefalse" ? q.correctAnswer : q.correctIndex;
      const isRight = given === correct;
      const row = el(`<div class="review-row ${isRight ? "ok" : "bad"}"><b>${i + 1}.</b> ${escapeHtml(q.text[state.lang] || q.text.ar)}</div>`);
      body.appendChild(row);
    });
    const summary = el(`<p><b>${L("score")}:</b> ${a.score} / ${a.totalPoints}</p>`);
    body.appendChild(summary);
  });
  return wrap;
}

function renderNewCandidateForm() {
  const wrap = el(`
    <form id="cand-form" class="card">
      <label>${L("name")}<input required name="name" /></label>
      <label>${L("phone")}<input required name="phone" inputmode="numeric" maxlength="11" pattern="\\d{11}" placeholder="07701234567" /></label>
      <p class="hint">${L("invalidPhone")}</p>
      <label>${L("password")}<input name="code" value="${genCode()}" /></label>
      <div class="err" id="cand-err"></div>
      <div class="row-actions">
        <button type="submit" class="primary">${L("create")}</button>
      </div>
      <div id="cand-result"></div>
    </form>
  `);
  wrap.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const errBox = wrap.querySelector("#cand-err");
    errBox.textContent = "";
    const phone = String(f.get("phone")).trim();
    const code = f.get("code");
    if (!isPhone(phone)) { errBox.textContent = L("invalidPhone"); return; }
    try {
      const secApp = getSecondaryApp();
      const secAuth = getAuth(secApp);
      const cred = await createUserWithEmailAndPassword(secAuth, phoneToEmail(phone), code);
      await setDoc(doc(db, "users", cred.user.uid), {
        role: "candidate", name: f.get("name"), phone,
        examStatus: "not_started", blocked: false,
        createdAt: serverTimestamp(), createdBy: state.user.uid,
      });
      await signOut(secAuth);
      wrap.querySelector("#cand-result").innerHTML = `
        <div class="notice">${L("accountCreated")}<br><b>${escapeHtml(phone)}</b> / <b>${escapeHtml(code)}</b></div>
      `;
      e.target.reset();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };
  return wrap;
}

function renderCoadminsTab() {
  const coadmins = state.candidates; // placeholder, replaced below by live query
  const wrap = el(`
    <div>
      <button id="new-coadmin-btn" class="primary">${L("addCoadmin")}</button>
      <div id="new-coadmin-form"></div>
      <table class="grid">
        <thead><tr><th>${L("name")}</th><th>${L("phone")}</th><th></th></tr></thead>
        <tbody id="coadmin-rows"><tr><td colspan="3">${L("loading")}</td></tr></tbody>
      </table>
    </div>
  `);
  wrap.querySelector("#new-coadmin-btn").onclick = () => {
    const host = wrap.querySelector("#new-coadmin-form");
    host.innerHTML = "";
    host.appendChild(renderNewCoadminForm());
  };
  getDocs(query(collection(db, "users"), where("role", "==", "coadmin"))).then((snap) => {
    const rows = wrap.querySelector("#coadmin-rows");
    rows.innerHTML = "";
    if (snap.empty) { rows.innerHTML = `<tr><td colspan="3">—</td></tr>`; return; }
    snap.forEach((d) => {
      const c = { id: d.id, ...d.data() };
      const tr = el(`<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.phone || "")}</td><td></td></tr>`);
      const delBtn = el(`<button class="link danger">${L("remove")}</button>`);
      delBtn.onclick = () => { if (confirm(L("remove") + "?")) deleteDoc(doc(db, "users", c.id)); };
      tr.lastElementChild.appendChild(delBtn);
      rows.appendChild(tr);
    });
  });
  return wrap;
}

function renderNewCoadminForm() {
  const wrap = el(`
    <form id="coadmin-form" class="card">
      <label>${L("name")}<input required name="name" /></label>
      <label>${L("phone")}<input required name="phone" inputmode="numeric" maxlength="11" pattern="\\d{11}" placeholder="07701234567" /></label>
      <p class="hint">${L("invalidPhone")}</p>
      <label>${L("password")}<input required name="code" value="${genCode(8)}" /></label>
      <div class="err" id="coadmin-err"></div>
      <button type="submit" class="primary">${L("create")}</button>
      <div id="coadmin-result"></div>
    </form>
  `);
  wrap.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const errBox = wrap.querySelector("#coadmin-err");
    errBox.textContent = "";
    const phone = String(f.get("phone")).trim();
    if (!isPhone(phone)) { errBox.textContent = L("invalidPhone"); return; }
    try {
      const secApp = getSecondaryApp();
      const secAuth = getAuth(secApp);
      const cred = await createUserWithEmailAndPassword(secAuth, phoneToEmail(phone), f.get("code"));
      await setDoc(doc(db, "users", cred.user.uid), {
        role: "coadmin", name: f.get("name"), phone,
        createdAt: serverTimestamp(), createdBy: state.user.uid,
      });
      await signOut(secAuth);
      wrap.querySelector("#coadmin-result").innerHTML = `<div class="notice">${L("accountCreated")}<br><b>${escapeHtml(phone)}</b> / <b>${escapeHtml(f.get("code"))}</b></div>`;
      e.target.reset();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };
  return wrap;
}

// ---------- Questions tab (admin only can edit; coadmin read-only) ----------
function renderQuestionsTab() {
  const isAdmin = state.profile.role === "admin";
  const wrap = el(`<div></div>`);
  if (isAdmin) {
    const seedBtn = el(`<button class="ghost">${L("seedSample")}</button>`);
    seedBtn.onclick = async () => {
      seedBtn.disabled = true;
      for (const q of seedQuestions) {
        await addDoc(collection(db, "questions"), { ...q, active: true, createdAt: serverTimestamp() });
      }
      alert(L("seeded"));
      seedBtn.disabled = false;
    };
    wrap.appendChild(seedBtn);
    const addBtn = el(`<button class="primary">${L("addQuestion")}</button>`);
    const formHost = el(`<div id="q-form-host"></div>`);
    addBtn.onclick = () => { formHost.innerHTML = ""; formHost.appendChild(renderQuestionForm()); };
    wrap.appendChild(addBtn);
    wrap.appendChild(formHost);
  }
  const list = el(`<div class="q-list"></div>`);
  if (!state.questions.length) list.appendChild(el(`<p>${L("noQuestions")}</p>`));
  state.questions.forEach((q, i) => {
    const card = el(`
      <div class="q-card ${q.active === false ? "inactive" : ""}">
        <div class="q-head"><span class="tag">${L(q.category)}</span> <span class="tag">${L(q.type)}</span> ${q.active === false ? `<span class="tag warn">${L("inactive")}</span>` : ""}</div>
        <div class="q-text">${i + 1}. ${escapeHtml(q.text?.[state.lang] || q.text?.ar || "")}</div>
        ${q.imagePath ? `<img class="q-thumb" src="${q.imagePath}" />` : ""}
        <div class="q-answer">${answerPreview(q)}</div>
        <div id="q-edit-host-${q.id}"></div>
      </div>
    `);
    if (isAdmin) {
      const actions = el(`<div class="row-actions"></div>`);
      const editBtn = el(`<button class="link">${L("edit")}</button>`);
      editBtn.onclick = () => {
        const host = card.querySelector(`#q-edit-host-${q.id}`);
        host.innerHTML = host.children.length ? "" : "";
        if (host.dataset.open) { host.innerHTML = ""; delete host.dataset.open; return; }
        host.dataset.open = "1";
        host.appendChild(renderQuestionForm(q));
      };
      const toggleBtn = el(`<button class="link">${q.active === false ? L("active") : L("inactive")}</button>`);
      toggleBtn.onclick = () => updateDoc(doc(db, "questions", q.id), { active: q.active === false });
      const delBtn = el(`<button class="link danger">${L("delete")}</button>`);
      delBtn.onclick = () => { if (confirm(L("delete") + "?")) deleteDoc(doc(db, "questions", q.id)); };
      actions.appendChild(editBtn);
      actions.appendChild(toggleBtn);
      actions.appendChild(delBtn);
      card.appendChild(actions);
    }
    list.appendChild(card);
  });
  wrap.appendChild(list);
  return wrap;
}

function answerPreview(q) {
  if (q.type === "truefalse") {
    return `${L("correctAnswer")}: <b>${q.correctAnswer ? L("yes") : L("no")}</b>`;
  }
  if (!q.options) return "";
  return q.options.map((o, i) => {
    const txt = escapeHtml(o[state.lang] || o.ar || "");
    return i === q.correctIndex ? `<div class="opt-preview correct">✔ ${txt}</div>` : `<div class="opt-preview">${txt}</div>`;
  }).join("");
}

function renderQuestionForm(existing) {
  const imgFiles = [
    "image1.jpeg","image2.jpeg","image10.jpeg","image11.jpeg","image12.jpeg","image13.jpeg",
    "image14.jpeg","image16.jpeg","image17.jpeg","image18.jpeg","image20.png","image21.png",
    "image22.png","image23.jpeg","image24.jpeg","image25.jpeg","image26.jpeg","image27.jpeg",
  ];
  const wrap = el(`
    <form id="new-q-form" class="card">
      <label>${L("questionType")}
        <select name="type">
          <option value="mcq">${L("mcq")}</option>
          <option value="truefalse">${L("truefalse")}</option>
          <option value="image">${L("image")}</option>
        </select>
      </label>
      <label>${L("category")}
        <select name="category">${CATEGORIES.map((c) => `<option value="${c}">${L(c)}</option>`).join("")}</select>
      </label>
      <label>${L("points")}<input type="number" name="points" value="${existing?.points ?? 1}" min="1" /></label>
      <label>${L("questionTextAr")}<input name="text_ar" required value="${escapeHtml(existing?.text?.ar || "")}" /></label>
      <label>${L("questionTextKu")}<input name="text_ku" value="${escapeHtml(existing?.text?.ku || "")}" /></label>
      <label>${L("questionTextEn")}<input name="text_en" value="${escapeHtml(existing?.text?.en || "")}" /></label>
      <div id="type-extra"></div>
      <div class="err" id="q-err"></div>
      <button type="submit" class="primary">${L("save")}</button>
    </form>
  `);
  const extra = wrap.querySelector("#type-extra");
  const typeSel = wrap.querySelector("[name=type]");
  if (existing) {
    typeSel.value = existing.type;
    wrap.querySelector("[name=category]").value = existing.category || CATEGORIES[0];
  }
  function renderExtra() {
    extra.innerHTML = "";
    const type = typeSel.value;
    if (type === "mcq" || type === "image") {
      for (let i = 0; i < 4; i++) {
        extra.appendChild(el(`
          <fieldset class="opt-set">
            <legend>${L("options")} ${i + 1}</legend>
            <input name="opt_ar_${i}" placeholder="AR" />
            <input name="opt_ku_${i}" placeholder="KU" />
            <input name="opt_en_${i}" placeholder="EN" />
          </fieldset>
        `));
      }
      extra.appendChild(el(`
        <label>${L("correctAnswer")}
          <select name="correctIndex">
            ${[0,1,2,3].map((i) => `<option value="${i}">${i + 1}</option>`).join("")}
          </select>
        </label>
      `));
      if (type === "image") {
        extra.appendChild(el(`
          <label>${L("chooseImage")}
            <select name="imagePath">
              ${imgFiles.map((f) => `<option value="assets/questions/${f}">${f}</option>`).join("")}
            </select>
          </label>
        `));
      }
      if (existing && (existing.type === "mcq" || existing.type === "image") && existing.options) {
        existing.options.forEach((o, i) => {
          extra.querySelector(`[name=opt_ar_${i}]`).value = o.ar || "";
          extra.querySelector(`[name=opt_ku_${i}]`).value = o.ku || "";
          extra.querySelector(`[name=opt_en_${i}]`).value = o.en || "";
        });
        extra.querySelector("[name=correctIndex]").value = existing.correctIndex ?? 0;
        const imgSel = extra.querySelector("[name=imagePath]");
        if (imgSel && existing.imagePath) imgSel.value = existing.imagePath;
      }
    } else if (type === "truefalse") {
      extra.appendChild(el(`
        <label>${L("correctAnswer")}
          <select name="correctAnswer">
            <option value="true">${L("yes")}</option>
            <option value="false">${L("no")}</option>
          </select>
        </label>
      `));
      if (existing && existing.type === "truefalse") {
        extra.querySelector("[name=correctAnswer]").value = String(!!existing.correctAnswer);
      }
    }
  }
  typeSel.onchange = renderExtra;
  renderExtra();

  wrap.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const type = f.get("type");
    const data = {
      type,
      category: f.get("category"),
      points: Number(f.get("points")) || 1,
      text: { ar: f.get("text_ar"), ku: f.get("text_ku") || f.get("text_ar"), en: f.get("text_en") || f.get("text_ar") },
    };
    if (!existing) { data.active = true; data.createdAt = serverTimestamp(); }
    if (type === "mcq" || type === "image") {
      data.options = [0,1,2,3].map((i) => ({
        ar: f.get(`opt_ar_${i}`) || "", ku: f.get(`opt_ku_${i}`) || f.get(`opt_ar_${i}`) || "", en: f.get(`opt_en_${i}`) || f.get(`opt_ar_${i}`) || "",
      }));
      data.correctIndex = Number(f.get("correctIndex"));
      if (type === "image") data.imagePath = f.get("imagePath");
    } else if (type === "truefalse") {
      data.correctAnswer = f.get("correctAnswer") === "true";
    }
    try {
      if (existing) {
        await updateDoc(doc(db, "questions", existing.id), data);
      } else {
        await addDoc(collection(db, "questions"), data);
        e.target.reset();
        renderExtra();
      }
    } catch (err) {
      wrap.querySelector("#q-err").textContent = err.message;
    }
  };
  return wrap;
}

// ============================================================
// CANDIDATE — EXAM
// ============================================================
let examLocalAnswers = {};
let examQIndex = 0;

function renderExam() {
  if (state.profile.blocked) {
    return el(`<div class="card center-card"><p>${L("blocked")}</p></div>`);
  }
  if (["submitted", "graded"].includes(state.profile.examStatus)) {
    return renderResult();
  }
  const activeQs = state.questions.filter((q) => q.active !== false);
  if (!state._examLoaded) {
    // lazy-load questions once for candidates (they don't get live admin watcher)
    loadQuestionsForCandidate();
    return el(`<div class="card center-card">${L("loading")}</div>`);
  }
  if (!activeQs.length) return el(`<div class="card center-card">${L("noQuestions")}</div>`);

  // Restore answers/position saved on the candidate's own profile so a
  // refresh mid-exam doesn't wipe progress (previously it did — this was
  // reported and is now fixed).
  if (state._progressLoadedFor !== state.profile.id) {
    examLocalAnswers = state.profile.examProgress ? { ...state.profile.examProgress } : {};
    examQIndex = Number.isInteger(state.profile.examQIndex)
      ? Math.min(state.profile.examQIndex, activeQs.length - 1) : 0;
    state._progressLoadedFor = state.profile.id;
  }

  if (state.profile.examStatus === "not_started") {
    const wrap = el(`
      <div class="card center-card">
        <h2>${L("appName")}</h2>
        <p>${escapeHtml(state.profile.name || "")}</p>
        <button id="start-btn" class="primary">${L("startExam")}</button>
        <div><button id="logout-btn" class="ghost">${L("logout")}</button></div>
      </div>
    `);
    wrap.querySelector("#logout-btn").onclick = () => signOut(auth);
    wrap.querySelector("#start-btn").onclick = async () => {
      await updateDoc(doc(db, "users", state.profile.id), { examStatus: "in_progress", startedAt: serverTimestamp() });
      setState({ profile: { ...state.profile, examStatus: "in_progress" } });
    };
    return wrap;
  }

  const q = activeQs[examQIndex];
  const wrap = el(`
    <div class="shell exam-shell">
      <header class="topbar">
        <div class="brand">${L("appName")}</div>
        <button id="logout-btn" class="ghost">${L("logout")}</button>
      </header>
      <div class="exam-progress">${L("questionOf", { n: examQIndex + 1, total: activeQs.length })}</div>
      <div class="card q-card-big">
        <div class="q-text">${escapeHtml(q.text[state.lang] || q.text.ar)}</div>
        ${q.imagePath ? `<img class="q-image" src="${q.imagePath}" />` : ""}
        <div id="q-options"></div>
      </div>
      <div class="row-actions exam-nav">
        <button id="prev-btn" ${examQIndex === 0 ? "disabled" : ""}>${L("prev")}</button>
        ${examQIndex === activeQs.length - 1
          ? `<button id="submit-btn" class="primary">${L("submitExam")}</button>`
          : `<button id="next-btn" class="primary">${L("next")}</button>`}
      </div>
    </div>
  `);
  wrap.querySelector("#logout-btn").onclick = () => signOut(auth);
  const optHost = wrap.querySelector("#q-options");
  const opts = q.type === "truefalse"
    ? [{ label: L("yes"), value: true }, { label: L("no"), value: false }]
    : q.options.map((o, i) => ({ label: o[state.lang] || o.ar, value: i }));
  opts.forEach((o) => {
    const checked = examLocalAnswers[q.id] === o.value;
    const optEl = el(`<label class="option ${checked ? "picked" : ""}"><input type="radio" name="ans" ${checked ? "checked" : ""}/> ${escapeHtml(o.label)}</label>`);
    optEl.querySelector("input").onchange = () => {
      examLocalAnswers[q.id] = o.value;
      saveExamProgress();
      render();
    };
    optHost.appendChild(optEl);
  });
  const prevBtn = wrap.querySelector("#prev-btn");
  if (prevBtn) prevBtn.onclick = () => { examQIndex = Math.max(0, examQIndex - 1); saveExamProgress(); render(); };
  const nextBtn = wrap.querySelector("#next-btn");
  if (nextBtn) nextBtn.onclick = () => { examQIndex = Math.min(activeQs.length - 1, examQIndex + 1); saveExamProgress(); render(); };
  const submitBtn = wrap.querySelector("#submit-btn");
  if (submitBtn) submitBtn.onclick = () => { if (confirm(L("submitConfirm"))) submitExam(activeQs); };
  return wrap;
}

function saveExamProgress() {
  updateDoc(doc(db, "users", state.profile.id), {
    examProgress: examLocalAnswers, examQIndex,
  }).catch(() => {});
}

async function loadQuestionsForCandidate() {
  const snap = await getDocs(query(collection(db, "questions"), where("active", "==", true)));
  const list = [];
  snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
  state.questions = list;
  state._examLoaded = true;
  render();
}

async function submitExam(activeQs) {
  let score = 0, total = 0;
  activeQs.forEach((q) => {
    total += q.points || 1;
    const given = examLocalAnswers[q.id];
    const correct = q.type === "truefalse" ? q.correctAnswer : q.correctIndex;
    if (given === correct) score += q.points || 1;
  });
  await setDoc(doc(db, "attempts", state.profile.id), {
    answers: examLocalAnswers, score, totalPoints: total, submittedAt: serverTimestamp(),
  });
  // Note: score/totalPoints intentionally live only on the attempts doc —
  // candidates are not allowed to write "score" on their own users doc
  // (see firestore.rules), so staff read it from attempts instead.
  await updateDoc(doc(db, "users", state.profile.id), { examStatus: "submitted" });
  setState({ profile: { ...state.profile, examStatus: "submitted", score, totalPoints: total } });
}

function renderResult() {
  const p = state.profile;
  const wrap = el(`
    <div class="shell">
      <header class="topbar">
        <div class="brand">${L("appName")}</div>
        <button id="logout-btn" class="ghost">${L("logout")}</button>
      </header>
      <div class="card center-card" id="result-card">
        <h2>${L("yourResult")}</h2>
        <p>${L("resultPending")}</p>
      </div>
    </div>
  `);
  wrap.querySelector("#logout-btn").onclick = () => signOut(auth);
  getDoc(doc(db, "attempts", p.id)).then((snap) => {
    if (!snap.exists()) return;
    const a = snap.data();
    const card = wrap.querySelector("#result-card");
    card.innerHTML = `
      <h2>${L("yourResult")}</h2>
      <p style="font-size:32px;font-weight:700;">${a.score} / ${a.totalPoints}</p>
    `;
  });
  return wrap;
}

render();
