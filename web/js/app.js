import { firebaseConfig, ADMIN_SETUP_KEY, ADMIN_SERVER_URL } from "./firebase-config.js";
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

// File uploads (speaking recordings, listening audio, training PDF) go
// through the admin server to Google Drive, not Firebase Storage — the
// project is on the free Spark plan and Storage now requires Blaze. See
// server/README.md for the Drive folder/service-account setup this needs.
async function uploadViaServer(path, file) {
  if (!ADMIN_SERVER_URL) throw new Error(L("uploadServerMissing"));
  const fd = new FormData();
  fd.append("file", file);
  const token = await state.user.getIdToken();
  const res = await fetch(`${ADMIN_SERVER_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
// Explicit local persistence: keep the session in this browser across tab
// closes / restarts, so the login screen isn't shown again on the same
// device until the user explicitly signs out.
setPersistence(auth, browserLocalPersistence).catch(() => {});

// TOEFL-style exam sections, fixed order. Every question belongs to exactly
// one of these (old questions default to "reading" — see loadQuestions*).
const SECTIONS = ["reading", "listening", "speaking", "writing"];
const DEFAULT_SECTION_MINUTES = { reading: 20, listening: 15, speaking: 10, writing: 20 };
// 0 = no limit, use every active question in that section.
const DEFAULT_SECTION_COUNTS = { reading: 0, listening: 0, speaking: 0, writing: 0 };

// Picks n random items from arr without mutating it (Fisher-Yates partial
// shuffle). n <= 0 or n >= arr.length just returns everything.
function pickRandom(arr, n) {
  if (!n || n >= arr.length) return arr.slice();
  const pool = arr.slice();
  for (let i = pool.length - 1; i > pool.length - 1 - n; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(pool.length - n);
}

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
  examConfig: { sectionMinutes: { ...DEFAULT_SECTION_MINUTES }, sectionCounts: { ...DEFAULT_SECTION_COUNTS }, sectionOrder: [...SECTIONS] },
  material: null,
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
    watchExamConfig();
  } else {
    loadExamConfig();
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
  if (unsubExamConfig) { unsubExamConfig(); unsubExamConfig = null; }
}

let unsubExamConfig = null;
function mergeExamConfig(data) {
  return {
    sectionMinutes: { ...DEFAULT_SECTION_MINUTES, ...(data?.sectionMinutes || {}) },
    sectionCounts: { ...DEFAULT_SECTION_COUNTS, ...(data?.sectionCounts || {}) },
    sectionOrder: (data?.sectionOrder && data.sectionOrder.length === SECTIONS.length) ? data.sectionOrder : [...SECTIONS],
  };
}
function watchExamConfig() {
  if (unsubExamConfig) return;
  unsubExamConfig = onSnapshot(doc(db, "settings", "examConfig"), (snap) => {
    setState({ examConfig: mergeExamConfig(snap.exists() ? snap.data() : null) });
  });
}
async function loadExamConfig() {
  try {
    const snap = await getDoc(doc(db, "settings", "examConfig"));
    state.examConfig = mergeExamConfig(snap.exists() ? snap.data() : null);
  } catch (err) {
    console.warn("examConfig load failed, using defaults", err);
  }
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

// Password field with a show/hide "eye" toggle so the user can verify what
// they typed before submitting. Renders the markup; call wirePwToggles(root)
// once after inserting it into the DOM to wire up the toggle buttons.
function pwField(name, attrs = "") {
  return `
    <div class="pw-wrap">
      <input type="password" name="${name}" ${attrs} />
      <button type="button" class="pw-eye" data-for="${name}" aria-label="${L("showPassword")}">👁</button>
    </div>
  `;
}
function wirePwToggles(root) {
  root.querySelectorAll(".pw-eye").forEach((btn) => {
    btn.onclick = () => {
      const input = btn.previousElementSibling;
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      btn.textContent = showing ? "👁" : "🙈";
    };
  });
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
    if (state.route === "material") {
      root.appendChild(renderMaterialViewer());
    } else if (state.route === "result" || ["submitted", "graded"].includes(state.profile.examStatus)) {
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

// Always-visible row of flag buttons — no dropdown to open/close, so the
// choices stay on screen at all times (per explicit request).
function langSwitcher() {
  const wrap = el(`<div class="lang-row"></div>`);
  if (state.user) {
    const logoutBtn = el(`<button type="button" class="ghost logout-flag-btn">${L("logout")}</button>`);
    logoutBtn.onclick = () => signOut(auth);
    wrap.appendChild(logoutBtn);
  }
  LANGS.forEach((l) => {
    const b = el(`
      <button type="button" class="lang-flag-btn ${l === state.lang ? "active" : ""}" aria-label="${LANG_NAME[l]}" title="${LANG_NAME[l]}">
        ${flagHtml(l)}
      </button>
    `);
    b.onclick = () => { localStorage.setItem("lang", l); setState({ lang: l }); };
    wrap.appendChild(b);
  });
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
        <label>${L("password")}${pwField("password", 'required minlength="6"')}</label>
        <label>${L("setupKey")}${pwField("key", "required")}</label>
        <div class="err" id="setup-err"></div>
        <button type="submit">${L("setupBtn")}</button>
      </form>
    </div>
  `);
  wirePwToggles(wrap);
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
        <label>${L("password")}${pwField("password", 'required autocomplete="current-password"')}</label>
        <div class="err" id="login-err"></div>
        <button type="submit">${L("loginBtn")}</button>
      </form>
    </div>
  `);
  wirePwToggles(wrap);
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
      <nav class="tabs">
        <button data-tab="candidates" class="${tab === "candidates" ? "active" : ""}">${L("candidates")}</button>
        <button data-tab="questions" class="${tab === "questions" ? "active" : ""}">${L("questionsBank")}</button>
        <button data-tab="material" class="${tab === "material" ? "active" : ""}">${L("materialTab")}</button>
        ${isAdmin ? `<button data-tab="settings" class="${tab === "settings" ? "active" : ""}">${L("examSettings")}</button>` : ""}
        ${isAdmin ? `<button data-tab="coadmins" class="${tab === "coadmins" ? "active" : ""}">${L("coadmins")}</button>` : ""}
      </nav>
      <main id="tab-body"></main>
    </div>
  `);
  wrap.querySelectorAll("[data-tab]").forEach((b) => {
    b.onclick = () => setState({ adminTab: b.dataset.tab });
  });
  const body = wrap.querySelector("#tab-body");
  if (tab === "candidates") body.appendChild(renderCandidatesTab());
  else if (tab === "questions") body.appendChild(renderQuestionsTab());
  else if (tab === "material") body.appendChild(renderMaterialAdminTab());
  else if (tab === "settings" && isAdmin) body.appendChild(renderExamSettingsTab());
  else if (tab === "coadmins" && isAdmin) body.appendChild(renderCoadminsTab());
  return wrap;
}

function renderExamSettingsTab() {
  const cfg = state.examConfig;
  const wrap = el(`
    <form id="exam-settings-form" class="card">
      <h3>${L("sectionMinutesLabel")}</h3>
      ${SECTIONS.map((s) => `
        <label>${L(s)}<input type="number" name="min_${s}" min="1" value="${cfg.sectionMinutes[s]}" /></label>
      `).join("")}
      <h3>${L("sectionCountsLabel")}</h3>
      <p class="hint">${L("sectionCountsHint")}</p>
      ${SECTIONS.map((s) => `
        <label>${L(s)}<input type="number" name="count_${s}" min="0" value="${cfg.sectionCounts[s]}" /></label>
      `).join("")}
      <div class="err" id="settings-msg"></div>
      <button type="submit" class="primary">${L("saveSettings")}</button>
    </form>
  `);
  wrap.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const sectionMinutes = {};
    const sectionCounts = {};
    SECTIONS.forEach((s) => {
      sectionMinutes[s] = Number(f.get(`min_${s}`)) || DEFAULT_SECTION_MINUTES[s];
      sectionCounts[s] = Math.max(0, Number(f.get(`count_${s}`)) || 0);
    });
    await setDoc(doc(db, "settings", "examConfig"), { sectionMinutes, sectionCounts, sectionOrder: SECTIONS }, { merge: true });
    wrap.querySelector("#settings-msg").textContent = L("settingsSaved");
    wrap.querySelector("#settings-msg").classList.remove("err");
    wrap.querySelector("#settings-msg").classList.add("notice");
  };
  return wrap;
}

const EXAM_STATUS_KEY = { not_started: "notStarted", in_progress: "inProgress", submitted: "submitted", graded: "graded" };
function statusLabel(c) {
  if (c.blocked) return L("blocked");
  return L(EXAM_STATUS_KEY[c.examStatus] || "notStarted");
}

// Calls the optional admin-server to actually delete the Firebase Auth
// login (not just the Firestore profile) — see server/README.md. Available
// wherever a candidate row is shown, including already-hidden/removed ones,
// since a soft-deleted profile can still have an orphaned Auth account.
function makeHardDeleteBtn(c) {
  const btn = el(`<button class="link danger">${L("hardDelete")}</button>`);
  btn.onclick = async () => {
    if (!confirm(L("hardDeleteConfirm"))) return;
    try {
      const token = await state.user.getIdToken();
      const res = await fetch(`${ADMIN_SERVER_URL}/users/${c.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    } catch (err) {
      alert(`${L("error")}: ${err.message}`);
    }
  };
  return btn;
}

function renderCandidatesTab() {
  const showRemoved = !!state.showRemovedCandidates;
  const visible = state.candidates.filter((c) => showRemoved ? c.deleted : !c.deleted);
  const wrap = el(`
    <div>
      <button id="new-cand-btn" class="primary">${L("createCandidate")}</button>
      <button id="toggle-removed-btn" class="ghost">${showRemoved ? L("candidates") : L("removedCandidates")}</button>
      <div id="new-cand-form"></div>
      <table class="grid">
        <thead><tr>
          <th>${L("name")}</th><th>${L("phone")}</th><th>${L("password")}</th>
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
  wrap.querySelector("#toggle-removed-btn").onclick = () => setState({ showRemovedCandidates: !showRemoved });
  const rows = wrap.querySelector("#cand-rows");
  visible.forEach((c) => {
    const att = state.attempts[c.id];
    const tr = el(`
      <tr>
        <td>${escapeHtml(c.name)}</td>
        <td>${escapeHtml(c.phone || "")}</td>
        <td class="mono">${escapeHtml(c.code || "—")}</td>
        <td>${statusLabel(c)}</td>
        <td>${att ? `${att.score}/${att.totalPoints}` : "—"}</td>
        <td class="row-actions"></td>
      </tr>
    `);
    const actions = tr.querySelector(".row-actions");
    if (c.deleted) {
      // Removed candidates only get restored — we never hard-delete the
      // Firestore profile anymore, since the underlying Auth login can't be
      // deleted from the client, and re-registering the same phone number
      // against a hard-deleted profile always fails with
      // auth/email-already-in-use. Restoring the same doc sidesteps that.
      const restoreBtn = el(`<button class="link">${L("restore")}</button>`);
      restoreBtn.onclick = async () => {
        await updateDoc(doc(db, "users", c.id), { deleted: false });
        try { await unblacklistFingerprint(c); } catch (err) { console.warn("fingerprint unblock failed", err); }
      };
      actions.appendChild(restoreBtn);
      if (ADMIN_SERVER_URL && state.profile.role === "admin") actions.appendChild(makeHardDeleteBtn(c));
      rows.appendChild(tr);
      return;
    }
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
        // Soft delete only — see comment above on why we never hard-delete.
        await updateDoc(doc(db, "users", c.id), { deleted: true });
      };
      actions.appendChild(delBtn);
      if (ADMIN_SERVER_URL) actions.appendChild(makeHardDeleteBtn(c));
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
    const answers = a.answers || {};
    const manualAnswers = a.manualAnswers || {};
    state.questions.filter((q) => q.id in answers).forEach((q, i) => {
      const given = answers[q.id];
      const correct = q.type === "truefalse" ? q.correctAnswer : q.correctIndex;
      const isRight = given === correct;
      const row = el(`<div class="review-row ${isRight ? "ok" : "bad"}"><b>${i + 1}.</b> ${escapeHtml(q.text[state.lang] || q.text.ar)}</div>`);
      body.appendChild(row);
    });
    body.appendChild(el(`<p><b>${L("autoScore")}:</b> ${a.autoScore ?? a.score ?? 0}</p>`));

    const manualQs = state.questions.filter((q) => (q.type === "speaking" || q.type === "writing") && q.id in manualAnswers);
    if (manualQs.length) {
      const gradingForm = el(`<form id="grading-form" class="card"><h4>${L("manualGrading")}</h4></form>`);
      const manualScores = { ...(a.manualScores || {}) };
      manualQs.forEach((q, i) => {
        const ans = manualAnswers[q.id];
        const row = el(`<div class="review-row"></div>`);
        row.appendChild(el(`<div><b>${i + 1}.</b> ${escapeHtml(q.text[state.lang] || q.text.ar)}</div>`));
        if (q.type === "speaking") {
          row.appendChild(ans?.audioUrl
            ? el(`<audio controls src="${ans.audioUrl}"></audio>`)
            : el(`<p class="hint">${L("noAnswerGiven")}</p>`));
        } else {
          row.appendChild(el(`<p class="writing-answer-view">${escapeHtml(ans?.text || "")}</p>`));
          if (!ans?.text) row.appendChild(el(`<p class="hint">${L("noAnswerGiven")}</p>`));
        }
        const scoreInput = el(`<label>${L("scoreOutOf", { max: q.points ?? 1 })}<input type="number" min="0" max="${q.points ?? 1}" name="score_${q.id}" value="${manualScores[q.id] ?? 0}" /></label>`);
        row.appendChild(scoreInput);
        gradingForm.appendChild(row);
      });
      const gradeMsg = el(`<div class="err" id="grade-msg"></div>`);
      gradingForm.appendChild(gradeMsg);
      const saveBtn = el(`<button type="submit" class="primary">${L("saveGrading")}</button>`);
      gradingForm.appendChild(saveBtn);
      gradingForm.onsubmit = async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const newManualScores = {};
        let manualScore = 0;
        manualQs.forEach((q) => {
          const v = Math.max(0, Math.min(q.points ?? 1, Number(f.get(`score_${q.id}`)) || 0));
          newManualScores[q.id] = v;
          manualScore += v;
        });
        const autoScore = a.autoScore ?? a.score ?? 0;
        await updateDoc(doc(db, "attempts", c.id), {
          manualScores: newManualScores,
          manualScore,
          score: autoScore + manualScore,
          examStatus: "graded",
          gradedBy: state.user.uid,
          gradedAt: serverTimestamp(),
        });
        gradeMsg.textContent = L("gradingSaved");
        gradeMsg.classList.remove("err");
        gradeMsg.classList.add("notice");
      };
      body.appendChild(gradingForm);
    }

    const total = (a.autoScore ?? a.score ?? 0) + (a.manualScore ?? 0);
    const summary = el(`<p><b>${L("score")}:</b> ${total} / ${a.totalPoints}</p>`);
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
      // Check for an existing profile with this phone first — a hard delete
      // is no longer possible (see renderCandidatesTab), so if a profile
      // already exists the fix is to restore it, not to try creating a
      // duplicate login that Firebase will reject anyway.
      const existing = await getDocs(query(collection(db, "users"), where("phone", "==", phone)));
      if (!existing.empty) {
        const ex = { id: existing.docs[0].id, ...existing.docs[0].data() };
        if (ex.deleted) {
          errBox.innerHTML = `${L("phoneExistsRemoved")} <button type="button" id="restore-inline" class="link">${L("restore")}</button>`;
          wrap.querySelector("#restore-inline").onclick = async () => {
            await updateDoc(doc(db, "users", ex.id), { deleted: false, name: f.get("name") });
            try { await unblacklistFingerprint(ex); } catch {}
            setState({ showRemovedCandidates: false });
          };
        } else {
          errBox.textContent = L("phoneExists");
        }
        return;
      }
      const secApp = getSecondaryApp();
      const secAuth = getAuth(secApp);
      const cred = await createUserWithEmailAndPassword(secAuth, phoneToEmail(phone), code);
      await setDoc(doc(db, "users", cred.user.uid), {
        // Storing the login code in plain text is a deliberate tradeoff:
        // staff need to be able to look it up again to resend it to a
        // candidate, and this code is a throwaway access code (not reused
        // elsewhere), not a real password. Only staff can read it (rules).
        role: "candidate", name: f.get("name"), phone, code, deleted: false,
        examStatus: "not_started", blocked: false,
        createdAt: serverTimestamp(), createdBy: state.user.uid,
      });
      await signOut(secAuth);
      wrap.querySelector("#cand-result").innerHTML = `
        <div class="notice">${L("accountCreated")}<br><b>${escapeHtml(phone)}</b> / <b>${escapeHtml(code)}</b></div>
      `;
      e.target.reset();
    } catch (err) {
      if (err.code === "auth/email-already-in-use") {
        errBox.textContent = L("phoneOrphaned");
      } else {
        errBox.textContent = err.message;
      }
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
        <thead><tr><th>${L("name")}</th><th>${L("phone")}</th><th>${L("password")}</th><th></th></tr></thead>
        <tbody id="coadmin-rows"><tr><td colspan="4">${L("loading")}</td></tr></tbody>
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
    if (snap.empty) { rows.innerHTML = `<tr><td colspan="4">—</td></tr>`; return; }
    snap.forEach((d) => {
      const c = { id: d.id, ...d.data() };
      const tr = el(`<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.phone || "")}</td><td class="mono">${escapeHtml(c.code || "—")}</td><td></td></tr>`);
      if (ADMIN_SERVER_URL) {
        // Same fix as candidates: a plain Firestore delete would leave an
        // orphaned Auth login behind (see makeHardDeleteBtn). Removing a
        // co-admin should mean actually gone, so this always hard-deletes.
        tr.lastElementChild.appendChild(makeHardDeleteBtn(c));
      } else {
        const delBtn = el(`<button class="link danger" title="${L("hardDeleteUnavailable")}">${L("remove")}</button>`);
        delBtn.onclick = () => alert(L("hardDeleteUnavailable"));
        tr.lastElementChild.appendChild(delBtn);
      }
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
        role: "coadmin", name: f.get("name"), phone, code: f.get("code"),
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

// ---------- Training material tab (admin uploads PDF; shows read stats) ----------
function renderMaterialAdminTab() {
  const isAdmin = state.profile.role === "admin";
  const wrap = el(`<div></div>`);
  if (isAdmin) {
    const form = el(`
      <form id="material-form" class="card">
        <label>${L("uploadMaterial")}<input type="file" name="file" accept="application/pdf" required /></label>
        <div class="err" id="material-err"></div>
        <button type="submit" class="primary">${L("save")}</button>
      </form>
    `);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const file = f.get("file");
      const errBox = form.querySelector("#material-err");
      errBox.textContent = L("uploadingFile");
      errBox.classList.remove("notice");
      try {
        const { fileId, fileName } = await uploadViaServer("/uploads/material", file);
        await setDoc(doc(db, "settings", "material"), { fileId, fileName, updatedAt: serverTimestamp() });
        state.material = { fileId, fileName };
        statusP.textContent = `${L("materialUploaded")}: ${fileName}`;
        errBox.textContent = L("materialUploaded");
        errBox.classList.add("notice");
      } catch (err) {
        errBox.textContent = err.message;
      }
    };
    wrap.appendChild(form);
  }
  const statusP = el(`<p>${state.material?.fileName ? `${L("materialUploaded")}: ${escapeHtml(state.material.fileName)}` : L("noMaterial")}</p>`);
  wrap.appendChild(statusP);

  const statsHost = el(`
    <div>
      <h3>${L("materialStats")}</h3>
      <table class="grid">
        <thead><tr><th>${L("name")}</th><th>${L("sessionsCount")}</th><th>${L("totalTime")}</th><th>${L("maxPageReached")}</th><th>${L("lastRead")}</th></tr></thead>
        <tbody id="material-stats-rows"><tr><td colspan="5">${L("loading")}</td></tr></tbody>
      </table>
    </div>
  `);
  wrap.appendChild(statsHost);

  (async () => {
    if (state.material == null) {
      const snap = await getDoc(doc(db, "settings", "material"));
      state.material = snap.exists() ? snap.data() : false;
      if (state.material) statusP.textContent = `${L("materialUploaded")}: ${escapeHtml(state.material.fileName || "")}`;
    }
    const snap = await getDocs(collection(db, "materialSessions"));
    const byUid = {};
    snap.forEach((d) => {
      const s = d.data();
      if (!s.uid) return;
      const g = byUid[s.uid] || (byUid[s.uid] = { name: s.name, sessions: 0, totalSec: 0, maxPage: 0, lastAt: 0 });
      g.sessions += 1;
      g.totalSec += s.durationSec || 0;
      g.maxPage = Math.max(g.maxPage, s.maxPage || 0);
      const at = s.lastActiveAt?.seconds || 0;
      if (at > g.lastAt) g.lastAt = at;
    });
    const rows = statsHost.querySelector("#material-stats-rows");
    rows.innerHTML = "";
    const uids = Object.keys(byUid);
    if (!uids.length) { rows.innerHTML = `<tr><td colspan="5">${L("neverRead")}</td></tr>`; return; }
    const localeMap = { ar: "ar-IQ", ku: "en-GB", en: "en-US" };
    uids.forEach((uid) => {
      const g = byUid[uid];
      const cand = state.candidates.find((c) => c.id === uid);
      const name = cand?.name || g.name || uid;
      const lastStr = g.lastAt ? new Date(g.lastAt * 1000).toLocaleString(localeMap[state.lang]) : "—";
      rows.appendChild(el(`<tr><td>${escapeHtml(name)}</td><td>${g.sessions}</td><td>${fmtTime(g.totalSec)}</td><td>${g.maxPage}</td><td>${lastStr}</td></tr>`));
    });
  })();

  return wrap;
}

// Mirrors an Arabic field's value into its EN/KU siblings as the admin
// types, until EN/KU are edited by hand — lets admins skip manually typing
// the same text three times when they don't need real per-language
// wording, while still allowing a real translation to be typed in later.
function wireAutoFill(arEl, enEl, kuEl) {
  [enEl, kuEl].forEach((el) => {
    if (!el.value || el.value === arEl.value) el.dataset.autoFilled = "1";
    el.addEventListener("input", () => {
      if (el.value !== arEl.value) delete el.dataset.autoFilled;
    });
  });
  arEl.addEventListener("input", () => {
    [enEl, kuEl].forEach((el) => {
      if (el.dataset.autoFilled) el.value = arEl.value;
    });
  });
}

// Deterministic id for a seed question, derived from its content — lets the
// "add sample questions" button be clicked repeatedly without ever
// inserting duplicates (see renderQuestionsTab below).
function seedDocId(q) {
  const s = `${q.type}|${q.category}|${q.text?.ar || ""}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `seed-${h.toString(36)}`;
}

// ---------- Questions tab (admin only can edit; coadmin read-only) ----------
function renderQuestionsTab() {
  const isAdmin = state.profile.role === "admin";
  const wrap = el(`<div></div>`);
  if (isAdmin) {
    const seedBtn = el(`<button class="ghost">${L("seedSample")}</button>`);
    seedBtn.onclick = async () => {
      seedBtn.disabled = true;
      try {
        for (const q of seedQuestions) {
          // Stable, content-derived id (not a random addDoc id) so clicking
          // this button again re-writes the same docs instead of inserting
          // duplicates every time.
          await setDoc(doc(db, "questions", seedDocId(q)),
            { section: "reading", ...q, active: true, createdAt: serverTimestamp() },
            { merge: true });
        }
        alert(L("seeded"));
      } finally {
        seedBtn.disabled = false;
      }
    };
    wrap.appendChild(seedBtn);
    const dedupeBtn = el(`<button class="ghost">${L("removeDuplicates")}</button>`);
    dedupeBtn.onclick = async () => {
      // Groups by the same content key seedDocId() derives its id from, so
      // this cleans up duplicates left over from before that fix — keeps
      // the oldest doc in each group, deletes the rest.
      const groups = {};
      state.questions.forEach((q) => {
        const key = `${q.type}|${q.category}|${q.text?.ar || ""}`;
        (groups[key] = groups[key] || []).push(q);
      });
      const toDelete = [];
      Object.values(groups).forEach((list) => {
        if (list.length < 2) return;
        list.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
        toDelete.push(...list.slice(1));
      });
      if (!toDelete.length) { alert(L("noDuplicates")); return; }
      if (!confirm(L("removeDuplicatesConfirm", { n: toDelete.length }))) return;
      dedupeBtn.disabled = true;
      try {
        for (const q of toDelete) await deleteDoc(doc(db, "questions", q.id));
        alert(L("duplicatesRemoved", { n: toDelete.length }));
      } finally {
        dedupeBtn.disabled = false;
      }
    };
    wrap.appendChild(dedupeBtn);
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
        <div class="q-head"><span class="tag section-tag">${L(q.section || "reading")}</span> <span class="tag">${L(q.category)}</span> <span class="tag">${L(q.type)}</span> ${q.active === false ? `<span class="tag warn">${L("inactive")}</span>` : ""}</div>
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
  if (q.type === "speaking" || q.type === "writing") {
    return `${L("scoreOutOf", { max: q.points ?? 1 })} — ${L("manualGrading")}`;
  }
  if (q.type === "truefalse") {
    return `${L("correctAnswer")}: <b>${q.correctAnswer ? L("yes") : L("no")}</b>`;
  }
  if (!q.options) return "";
  return q.options.map((o, i) => {
    const txt = escapeHtml(o[state.lang] || o.ar || "");
    return i === q.correctIndex ? `<div class="opt-preview correct">✔ ${txt}</div>` : `<div class="opt-preview">${txt}</div>`;
  }).join("");
}

// Section a question type defaults into when first created/switched to.
const TYPE_DEFAULT_SECTION = { speaking: "speaking", writing: "writing" };

function renderQuestionForm(existing) {
  const imgFiles = [
    "image1.jpeg","image2.jpeg","image10.jpeg","image11.jpeg","image12.jpeg","image13.jpeg",
    "image14.jpeg","image16.jpeg","image17.jpeg","image18.jpeg","image20.png","image21.png",
    "image22.png","image23.jpeg","image24.jpeg","image25.jpeg","image26.jpeg","image27.jpeg",
  ];
  // Listening audio is uploaded immediately on file select (Storage), then
  // referenced by URL on submit — keeps the upload out of the form-submit path.
  let pendingAudioPath = existing?.audioPath || "";
  const wrap = el(`
    <form id="new-q-form" class="card">
      <label>${L("questionType")}
        <select name="type">
          <option value="mcq">${L("mcq")}</option>
          <option value="truefalse">${L("truefalse")}</option>
          <option value="image">${L("image")}</option>
          <option value="speaking">${L("speaking")}</option>
          <option value="writing">${L("writing")}</option>
        </select>
      </label>
      <label>${L("section")}
        <select name="section">${SECTIONS.map((s) => `<option value="${s}">${L(s)}</option>`).join("")}</select>
      </label>
      <label>${L("category")}
        <select name="category">${CATEGORIES.map((c) => `<option value="${c}">${L(c)}</option>`).join("")}</select>
      </label>
      <label>${L("points")}<input type="number" name="points" value="${existing?.points ?? 1}" min="1" /></label>
      <label>${L("displayLang")}
        <select name="displayLang">
          <option value="">${L("displayLangAuto")}</option>
          <option value="ar">${L("displayLangAr")}</option>
          <option value="en">${L("displayLangEn")}</option>
          <option value="ku">${L("displayLangKu")}</option>
        </select>
      </label>
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
  const sectionSel = wrap.querySelector("[name=section]");
  if (existing) {
    typeSel.value = existing.type;
    sectionSel.value = existing.section || "reading";
    wrap.querySelector("[name=category]").value = existing.category || CATEGORIES[0];
    wrap.querySelector("[name=displayLang]").value = existing.displayLang || "";
  }
  wireAutoFill(wrap.querySelector("[name=text_ar]"), wrap.querySelector("[name=text_en]"), wrap.querySelector("[name=text_ku]"));
  function renderExtra() {
    extra.innerHTML = "";
    const type = typeSel.value;
    const section = sectionSel.value;
    if (type === "speaking" || type === "writing") {
      extra.appendChild(el(`<p class="hint">${L(type === "speaking" ? "speaking" : "writing")}: ${L("points")} = ${L("scoreOutOf", { max: "" })}. ${L("manualGrading")}.</p>`));
      return;
    }
    if (type === "mcq" || type === "image") {
      for (let i = 0; i < 4; i++) {
        const optSet = el(`
          <fieldset class="opt-set">
            <legend>${L("options")} ${i + 1}</legend>
            <input name="opt_ar_${i}" placeholder="AR" />
            <input name="opt_ku_${i}" placeholder="KU" />
            <input name="opt_en_${i}" placeholder="EN" />
          </fieldset>
        `);
        extra.appendChild(optSet);
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
      // Wired after any existing values are populated above, so editing an
      // already-translated question doesn't mistake real translations for
      // auto-filled placeholders.
      for (let i = 0; i < 4; i++) {
        wireAutoFill(extra.querySelector(`[name=opt_ar_${i}]`), extra.querySelector(`[name=opt_en_${i}]`), extra.querySelector(`[name=opt_ku_${i}]`));
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
    if (section === "reading") {
      // Wrapped in one <div> — el() only returns the FIRST of several
      // sibling root elements, so without this wrapper the Ku/En passage
      // fields below were silently never attached to the DOM at all.
      const passageWrap = el(`
        <div>
          <label>${L("passageAr")}<textarea name="passage_ar" rows="3">${escapeHtml(existing?.passage?.ar || "")}</textarea></label>
          <label>${L("passageKu")}<textarea name="passage_ku" rows="3">${escapeHtml(existing?.passage?.ku || "")}</textarea></label>
          <label>${L("passageEn")}<textarea name="passage_en" rows="3">${escapeHtml(existing?.passage?.en || "")}</textarea></label>
        </div>
      `);
      extra.appendChild(passageWrap);
      wireAutoFill(passageWrap.querySelector("[name=passage_ar]"), passageWrap.querySelector("[name=passage_en]"), passageWrap.querySelector("[name=passage_ku]"));
    }
    if (section === "listening") {
      const audioWrap = el(`
        <label>${L("chooseAudioFile")}
          <input type="file" name="audio_file" accept="audio/*" />
        </label>
      `);
      const status = el(`<p class="hint" id="audio-status">${pendingAudioPath ? L("materialUploaded") : ""}</p>`);
      audioWrap.querySelector("input").onchange = async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        status.textContent = L("uploadingAudio");
        try {
          const { url } = await uploadViaServer("/uploads/listening", file);
          pendingAudioPath = url;
          status.textContent = L("materialUploaded");
        } catch (err) {
          status.textContent = err.message;
        }
      };
      extra.appendChild(audioWrap);
      extra.appendChild(status);
    }
  }
  typeSel.onchange = () => {
    if (TYPE_DEFAULT_SECTION[typeSel.value]) sectionSel.value = TYPE_DEFAULT_SECTION[typeSel.value];
    renderExtra();
  };
  sectionSel.onchange = renderExtra;
  renderExtra();

  wrap.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const type = f.get("type");
    const data = {
      type,
      section: f.get("section"),
      category: f.get("category"),
      points: Number(f.get("points")) || 1,
      displayLang: f.get("displayLang") || null,
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
    if (data.section === "reading" && (type === "mcq" || type === "truefalse" || type === "image")) {
      const pAr = f.get("passage_ar"), pKu = f.get("passage_ku"), pEn = f.get("passage_en");
      if (pAr || pKu || pEn) data.passage = { ar: pAr || "", ku: pKu || pAr || "", en: pEn || pAr || "" };
    }
    if (data.section === "listening" && pendingAudioPath) data.audioPath = pendingAudioPath;
    try {
      if (existing) {
        await updateDoc(doc(db, "questions", existing.id), data);
      } else {
        await addDoc(collection(db, "questions"), data);
        e.target.reset();
        pendingAudioPath = "";
        renderExtra();
      }
    } catch (err) {
      wrap.querySelector("#q-err").textContent = err.message;
    }
  };
  return wrap;
}

// ============================================================
// CANDIDATE — EXAM (TOEFL-style: reading/listening/speaking/writing sections)
// ============================================================
let examLocalAnswers = {};     // auto-graded answers: {qid: value}
let examManualAnswers = {};    // speaking/writing answers: {qid: {audioUrl} | {text}}
let examSectionIndex = 0;
let examQIndex = 0;
let examSectionDeadline = 0;   // ms epoch, when the current section auto-advances
let examTimerInterval = null;
// Per-question speaking recorder state, not persisted directly (only the
// uploaded audioUrl is): { [qid]: "idle" | "recording" | "recorded" | "uploading" }
let speakingState = {};
let mediaRecorder = null;
let recordedChunks = [];

// A question can force a specific display language for candidates
// (q.displayLang), overriding whatever language they picked from the flag
// switcher — used e.g. to keep a listening/reading question in one language
// regardless of UI language. Falls back to the candidate's own language.
function qLang(q) { return q.displayLang || state.lang; }

function groupBySections(activeQs) {
  const order = state.examConfig.sectionOrder;
  return order
    .map((s) => ({ section: s, qs: activeQs.filter((q) => (q.section || "reading") === s) }))
    .filter((g) => g.qs.length);
}

function fmtTime(totalSec) {
  const s = Math.max(0, Math.round(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function renderExam() {
  if (state.profile.blocked || state.profile.deleted) {
    return el(`<div class="card center-card"><p>${L("blocked")}</p></div>`);
  }
  if (["submitted", "graded"].includes(state.profile.examStatus)) {
    stopExamTimer();
    return renderResult();
  }
  const activeQs = state.questions.filter((q) => q.active !== false);
  if (!state._examLoaded) {
    loadQuestionsForCandidate();
    return el(`<div class="card center-card">${L("loading")}</div>`);
  }
  if (!activeQs.length) return el(`<div class="card center-card">${L("noQuestions")}</div>`);

  // Full pool grouped by section, used to sample from when the exam starts.
  const fullSections = groupBySections(activeQs);
  // Once the candidate has started, examSelectedQuestionIds pins them to the
  // same randomly-sampled subset every render/reload — recomputing the
  // sample on every render would change which questions they see mid-exam.
  const selectedIds = state.profile.examSelectedQuestionIds;
  const sections = selectedIds
    ? groupBySections(activeQs.filter((q) => selectedIds.includes(q.id)))
    : fullSections;

  // Restore progress saved on the candidate's own profile so a refresh
  // mid-exam doesn't wipe it.
  if (state._progressLoadedFor !== state.profile.id) {
    examLocalAnswers = state.profile.examProgress ? { ...state.profile.examProgress } : {};
    examManualAnswers = state.profile.examManualProgress ? { ...state.profile.examManualProgress } : {};
    examSectionIndex = Number.isInteger(state.profile.examSectionIndex)
      ? Math.min(state.profile.examSectionIndex, sections.length - 1) : 0;
    examQIndex = Number.isInteger(state.profile.examQIndex) ? state.profile.examQIndex : 0;
    examSectionDeadline = state.profile.examSectionDeadline || 0;
    state._progressLoadedFor = state.profile.id;
  }

  if (state.profile.examStatus === "not_started") {
    const wrap = el(`
      <div class="card center-card">
        <h2>${L("appName")}</h2>
        <p>${escapeHtml(state.profile.name || "")}</p>
        <button id="material-btn" class="ghost">${L("readMaterial")}</button>
        <button id="start-btn" class="primary">${L("startExam")}</button>
      </div>
    `);
    wrap.querySelector("#material-btn").onclick = () => setState({ route: "material" });
    wrap.querySelector("#start-btn").onclick = async () => {
      // Sample once, here, from the full pool — sectionCounts of 0 means
      // "use everything" (pickRandom returns the whole array in that case).
      const examSelectedQuestionIds = [];
      fullSections.forEach((sec) => {
        const n = state.examConfig.sectionCounts[sec.section] || 0;
        pickRandom(sec.qs, n).forEach((q) => examSelectedQuestionIds.push(q.id));
      });
      const startSections = groupBySections(activeQs.filter((q) => examSelectedQuestionIds.includes(q.id)));
      const deadline = Date.now() + (state.examConfig.sectionMinutes[startSections[0].section] || 20) * 60000;
      await updateDoc(doc(db, "users", state.profile.id), {
        examStatus: "in_progress", startedAt: serverTimestamp(),
        examSectionIndex: 0, examQIndex: 0, examSectionDeadline: deadline,
        examSelectedQuestionIds,
      });
      examSectionIndex = 0; examQIndex = 0; examSectionDeadline = deadline;
      setState({ profile: { ...state.profile, examStatus: "in_progress", examSelectedQuestionIds } });
    };
    return wrap;
  }

  const curSection = sections[examSectionIndex];
  if (!curSection) return el(`<div class="card center-card">${L("noQuestions")}</div>`);
  if (examQIndex > curSection.qs.length - 1) examQIndex = curSection.qs.length - 1;
  const q = curSection.qs[examQIndex];
  const isLastQInSection = examQIndex === curSection.qs.length - 1;
  const isLastSection = examSectionIndex === sections.length - 1;

  const wrap = el(`
    <div class="shell exam-shell">
      <header class="topbar topbar-timer-only">
        <div class="who" id="section-timer"></div>
      </header>
      <div class="exam-progress">
        ${L("sectionOf", { n: examSectionIndex + 1, total: sections.length, section: L(curSection.section) })}
        · ${L("questionOf", { n: examQIndex + 1, total: curSection.qs.length })}
      </div>
      <div class="card q-card-big">
        ${q.passage?.[qLang(q)] || q.passage?.ar ? `<div class="passage">${escapeHtml(q.passage[qLang(q)] || q.passage.ar)}</div>` : ""}
        ${q.audioPath ? `<audio class="q-audio" controls src="${q.audioPath}"></audio>` : ""}
        <div class="q-text">${escapeHtml(q.text[qLang(q)] || q.text.ar)}</div>
        ${q.imagePath ? `<img class="q-image" src="${q.imagePath}" />` : ""}
        <div id="q-options"></div>
      </div>
      <div class="row-actions exam-nav">
        <button id="prev-btn" ${examQIndex === 0 && examSectionIndex === 0 ? "disabled" : ""}>${L("prev")}</button>
        ${isLastQInSection && isLastSection
          ? `<button id="submit-btn" class="primary">${L("submitExam")}</button>`
          : isLastQInSection
            ? `<button id="next-section-btn" class="primary">${L("nextSection")}</button>`
            : `<button id="next-btn" class="primary">${L("next")}</button>`}
      </div>
    </div>
  `);

  renderQuestionAnswerUI(wrap.querySelector("#q-options"), q);

  const prevBtn = wrap.querySelector("#prev-btn");
  if (prevBtn) prevBtn.onclick = () => {
    if (examQIndex > 0) { examQIndex -= 1; }
    else if (examSectionIndex > 0) {
      examSectionIndex -= 1;
      examQIndex = sections[examSectionIndex].qs.length - 1;
    }
    saveExamProgress();
    render();
  };
  const nextBtn = wrap.querySelector("#next-btn");
  if (nextBtn) nextBtn.onclick = () => { examQIndex += 1; saveExamProgress(); render(); };
  const nextSectionBtn = wrap.querySelector("#next-section-btn");
  if (nextSectionBtn) nextSectionBtn.onclick = () => advanceSection(sections);
  const submitBtn = wrap.querySelector("#submit-btn");
  if (submitBtn) submitBtn.onclick = () => { if (confirm(L("submitConfirm"))) submitExam(sections.flatMap((s) => s.qs)); };

  startExamTimer(sections);
  return wrap;
}

function renderQuestionAnswerUI(optHost, q) {
  if (q.type === "speaking") {
    optHost.appendChild(renderSpeakingWidget(q));
    return;
  }
  if (q.type === "writing") {
    const ta = el(`<textarea class="writing-answer" rows="8" placeholder="${L("writeAnswerHere")}">${escapeHtml(examManualAnswers[q.id]?.text || "")}</textarea>`);
    let saveTimer = null;
    ta.oninput = () => {
      examManualAnswers[q.id] = { text: ta.value };
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveExamProgress, 800);
    };
    optHost.appendChild(ta);
    return;
  }
  const opts = q.type === "truefalse"
    ? [{ label: L("yes"), value: true }, { label: L("no"), value: false }]
    : q.options.map((o, i) => ({ label: o[qLang(q)] || o.ar, value: i }));
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
}

function renderSpeakingWidget(q) {
  const existingUrl = examManualAnswers[q.id]?.audioUrl;
  const st = speakingState[q.id] || (existingUrl ? "recorded" : "idle");
  const wrap = el(`<div class="speaking-widget"></div>`);
  if (st === "uploading") {
    wrap.appendChild(el(`<p class="hint">${L("uploadingAudio")}</p>`));
    return wrap;
  }
  if (st === "recording") {
    const stopBtn = el(`<button type="button" class="primary">${L("stopRecording")}</button>`);
    stopBtn.onclick = () => stopRecording(q.id);
    wrap.appendChild(el(`<p class="hint recording-dot">${L("recording")}</p>`));
    wrap.appendChild(stopBtn);
    return wrap;
  }
  if (st === "recorded" && existingUrl) {
    wrap.appendChild(el(`<audio controls src="${existingUrl}"></audio>`));
    const reBtn = el(`<button type="button" class="ghost">${L("reRecord")}</button>`);
    reBtn.onclick = () => startRecording(q.id);
    wrap.appendChild(reBtn);
    return wrap;
  }
  const recBtn = el(`<button type="button" class="primary">${L("record")}</button>`);
  recBtn.onclick = () => startRecording(q.id);
  wrap.appendChild(recBtn);
  return wrap;
}

async function startRecording(qid) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recordedChunks, { type: "audio/webm" });
      speakingState[qid] = "uploading";
      render();
      try {
        const { url } = await uploadViaServer(`/uploads/speaking/${qid}`, blob);
        examManualAnswers[qid] = { audioUrl: url };
        speakingState[qid] = "recorded";
        saveExamProgress();
      } catch (err) {
        alert(`${L("error")}: ${err.message}`);
        speakingState[qid] = "idle";
      }
      render();
    };
    mediaRecorder.start();
    speakingState[qid] = "recording";
    render();
  } catch (err) {
    alert(L("micPermissionDenied"));
  }
}
function stopRecording(qid) {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
}

function startExamTimer(sections) {
  if (examTimerInterval) return; // already ticking
  examTimerInterval = setInterval(() => {
    const el = document.getElementById("section-timer");
    if (!el) return; // navigated away from the exam view
    const remaining = (examSectionDeadline - Date.now()) / 1000;
    if (remaining <= 0) {
      clearInterval(examTimerInterval);
      examTimerInterval = null;
      advanceSection(sections);
      return;
    }
    el.textContent = L("sectionTimeLeft", { time: fmtTime(remaining) });
  }, 1000);
}
function stopExamTimer() {
  if (examTimerInterval) { clearInterval(examTimerInterval); examTimerInterval = null; }
}

function advanceSection(sections) {
  stopExamTimer();
  if (examSectionIndex >= sections.length - 1) {
    // Score against the same (possibly sampled) question set the candidate
    // was actually shown — not the full bank, which would count any
    // never-shown question as "wrong" and skew the total.
    submitExam(sections.flatMap((s) => s.qs));
    return;
  }
  examSectionIndex += 1;
  examQIndex = 0;
  examSectionDeadline = Date.now() + (state.examConfig.sectionMinutes[sections[examSectionIndex].section] || 20) * 60000;
  saveExamProgress();
  render();
}

function saveExamProgress() {
  updateDoc(doc(db, "users", state.profile.id), {
    examProgress: examLocalAnswers,
    examManualProgress: examManualAnswers,
    examQIndex, examSectionIndex, examSectionDeadline,
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
  stopExamTimer();
  let autoScore = 0, totalPoints = 0;
  const manualQuestions = [];
  activeQs.forEach((q) => {
    totalPoints += q.points || 1;
    if (q.type === "speaking" || q.type === "writing") {
      manualQuestions.push(q.id);
      return;
    }
    const given = examLocalAnswers[q.id];
    const correct = q.type === "truefalse" ? q.correctAnswer : q.correctIndex;
    if (given === correct) autoScore += q.points || 1;
  });
  const hasManual = manualQuestions.length > 0;
  await setDoc(doc(db, "attempts", state.profile.id), {
    answers: examLocalAnswers,
    manualAnswers: examManualAnswers,
    autoScore, manualScore: 0, totalPoints,
    score: autoScore,
    examStatus: hasManual ? "submitted" : "submitted",
    needsManualGrading: hasManual,
    submittedAt: serverTimestamp(),
  });
  // Note: score fields intentionally live only on the attempts doc —
  // candidates can't write "score" on their own users doc (see firestore.rules).
  await updateDoc(doc(db, "users", state.profile.id), { examStatus: "submitted" });
  setState({ profile: { ...state.profile, examStatus: "submitted" } });
}

function renderResult() {
  const p = state.profile;
  const wrap = el(`
    <div class="shell">
      <div class="card center-card" id="result-card">
        <h2>${L("yourResult")}</h2>
        <p>${L("resultPending")}</p>
      </div>
    </div>
  `);
  getDoc(doc(db, "attempts", p.id)).then((snap) => {
    if (!snap.exists()) return;
    const a = snap.data();
    const card = wrap.querySelector("#result-card");
    if (a.needsManualGrading && a.examStatus !== "graded") {
      card.innerHTML = `<h2>${L("yourResult")}</h2><p>${L("pendingGrading")}</p>`;
      return;
    }
    const total = (a.autoScore ?? a.score ?? 0) + (a.manualScore ?? 0);
    card.innerHTML = `
      <h2>${L("yourResult")}</h2>
      <p style="font-size:32px;font-weight:700;">${total} / ${a.totalPoints}</p>
    `;
  });
  return wrap;
}

// ============================================================
// CANDIDATE — TRAINING MATERIAL (read-tracked PDF viewer)
// ============================================================
// Page navigation here deliberately does NOT go through the app's global
// render() — that wipes and rebuilds the whole DOM (including the <canvas>),
// which would fight the pdf.js render loop. This view manages its own DOM
// via closures instead, same pattern as the in-form widgets above.
let materialPdfDoc = null;
let materialSessionId = null;
let materialCurrentPage = 1;
let materialPageCount = 1;
let materialPagesTime = {};
let materialPageStartTs = 0;
let materialOpenedAt = 0;
let materialAutosaveInterval = null;

function renderMaterialViewer() {
  const wrap = el(`
    <div class="shell">
      <header class="topbar topbar-timer-only">
        <button id="back-btn" class="ghost">${L("backToExam")}</button>
      </header>
      <div class="card center-card" id="material-body">${L("loading")}</div>
    </div>
  `);
  wrap.querySelector("#back-btn").onclick = () => { stopMaterialTracking(); setState({ route: "exam" }); };
  loadMaterialAndRender(wrap.querySelector("#material-body"));
  return wrap;
}

async function loadMaterialAndRender(body) {
  if (state.material == null) {
    const snap = await getDoc(doc(db, "settings", "material"));
    state.material = snap.exists() ? snap.data() : false;
  }
  if (!state.material) { body.innerHTML = `<p>${L("noMaterial")}</p>`; return; }

  body.innerHTML = `
    <div class="material-toolbar">
      <button id="prev-page">${L("prevPage")}</button>
      <span id="page-label"></span>
      <button id="next-page">${L("nextPage")}</button>
    </div>
    <div class="pdf-canvas-wrap"><canvas id="pdf-canvas"></canvas></div>
  `;
  const prevBtn = body.querySelector("#prev-page");
  const nextBtn = body.querySelector("#next-page");
  const label = body.querySelector("#page-label");
  const canvas = body.querySelector("#pdf-canvas");

  let pdfjsLib;
  try {
    pdfjsLib = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs";
    if (!ADMIN_SERVER_URL) throw new Error(L("uploadServerMissing"));
    materialPdfDoc = await pdfjsLib.getDocument(`${ADMIN_SERVER_URL}/material/${state.material.fileId}`).promise;
  } catch (err) {
    body.innerHTML = `<p class="err">${err.message}</p>`;
    return;
  }
  materialPageCount = materialPdfDoc.numPages;
  materialCurrentPage = 1;
  materialPagesTime = {};
  materialOpenedAt = Date.now();
  materialPageStartTs = Date.now();

  const sessionRef = await addDoc(collection(db, "materialSessions"), {
    uid: state.profile.id, name: state.profile.name || "",
    openedAt: serverTimestamp(), lastActiveAt: serverTimestamp(),
    pages: {}, maxPage: 1, pageCount: materialPageCount, durationSec: 0,
  });
  materialSessionId = sessionRef.id;

  async function renderPage(n) {
    const page = await materialPdfDoc.getPage(n);
    const viewport = page.getViewport({ scale: 1.3 });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    label.textContent = L("pageOf", { n, total: materialPageCount });
    prevBtn.disabled = n <= 1;
    nextBtn.disabled = n >= materialPageCount;
  }
  function trackPageChange(newPage) {
    const now = Date.now();
    const elapsed = (now - materialPageStartTs) / 1000;
    materialPagesTime[materialCurrentPage] = (materialPagesTime[materialCurrentPage] || 0) + elapsed;
    materialCurrentPage = newPage;
    materialPageStartTs = now;
  }
  prevBtn.onclick = async () => {
    if (materialCurrentPage <= 1) return;
    trackPageChange(materialCurrentPage - 1);
    await renderPage(materialCurrentPage);
    saveMaterialProgress();
  };
  nextBtn.onclick = async () => {
    if (materialCurrentPage >= materialPageCount) return;
    trackPageChange(materialCurrentPage + 1);
    await renderPage(materialCurrentPage);
    saveMaterialProgress();
  };
  await renderPage(1);

  if (materialAutosaveInterval) clearInterval(materialAutosaveInterval);
  materialAutosaveInterval = setInterval(saveMaterialProgress, 5000);
  window.addEventListener("beforeunload", saveMaterialProgress);
}

function saveMaterialProgress() {
  if (!materialSessionId) return;
  const now = Date.now();
  const liveElapsed = (now - materialPageStartTs) / 1000;
  const pages = { ...materialPagesTime, [materialCurrentPage]: (materialPagesTime[materialCurrentPage] || 0) + liveElapsed };
  const maxPage = Math.max(materialCurrentPage, ...Object.keys(pages).map(Number));
  updateDoc(doc(db, "materialSessions", materialSessionId), {
    pages, maxPage, durationSec: (now - materialOpenedAt) / 1000, lastActiveAt: serverTimestamp(),
  }).catch(() => {});
}

function stopMaterialTracking() {
  if (materialAutosaveInterval) { clearInterval(materialAutosaveInterval); materialAutosaveInterval = null; }
  window.removeEventListener("beforeunload", saveMaterialProgress);
  if (materialSessionId) {
    saveMaterialProgress();
    updateDoc(doc(db, "materialSessions", materialSessionId), { closedAt: serverTimestamp() }).catch(() => {});
    materialSessionId = null;
  }
}

render();
