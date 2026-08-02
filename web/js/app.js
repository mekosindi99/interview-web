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
  collection, getDocs, query, where, orderBy, serverTimestamp, onSnapshot, deleteField,
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

// Site-wide font, admin-configurable (Exam Settings). Only fonts actually
// available for free via Google Fonts are listed here — "Sarchia"/"IrSharp"
// (Farsi fonts) aren't on Google Fonts and would need the admin to supply
// the actual font files to add them.
const FONT_OPTIONS = {
  cairo: { label: "Cairo", family: `"Cairo", "Segoe UI", Tahoma, "Noto Sans Arabic", sans-serif`, googleFamily: "Cairo:wght@400;600;700;800" },
  vazirmatn: { label: "Vazirmatn", family: `"Vazirmatn", "Segoe UI", Tahoma, "Noto Sans Arabic", sans-serif`, googleFamily: "Vazirmatn:wght@400;600;700;800" },
  notosans: { label: "Noto Sans Arabic", family: `"Noto Sans Arabic", "Segoe UI", Tahoma, sans-serif`, googleFamily: "Noto+Sans+Arabic:wght@400;600;700;800" },
};
let _appliedFontKey = null;
function applyFont(key) {
  const font = FONT_OPTIONS[key] || FONT_OPTIONS.cairo;
  if (_appliedFontKey === key) return;
  _appliedFontKey = key;
  let link = document.getElementById("dynamic-font-link");
  if (!link) {
    link = document.createElement("link");
    link.id = "dynamic-font-link";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  link.href = `https://fonts.googleapis.com/css2?family=${font.googleFamily}&display=swap`;
  document.documentElement.style.fontFamily = font.family;
}

// Picks n random items from arr without mutating it (Fisher-Yates partial
// shuffle). n <= 0 or n >= arr.length just returns everything.
function fmtFileSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// A small "uploaded file" card (icon + name + size/date meta line) —
// the polished-app style the admin asked for, instead of a bare filename.
// Candidate's own login credentials (name/phone/password), laid out as
// clear label/value rows so it's easy to read at a glance and not lose
// track of — shown pinned at the top of the pre-exam and result screens.
function renderCredentialsCard(p) {
  return el(`
    <div class="card cred-card">
      <div class="cred-row"><span class="cred-label">${L("name")}</span><span class="cred-value">${escapeHtml(p.name || "")}</span></div>
      <div class="cred-row"><span class="cred-label">${L("phone")}</span><span class="cred-value mono">${escapeHtml(p.phone || "")}</span></div>
      ${p.code ? `<div class="cred-row"><span class="cred-label">${L("password")}</span><span class="cred-value mono">${escapeHtml(p.code)}</span></div>` : ""}
    </div>
  `);
}

function renderFileInfoCard(m, lang) {
  // -u-nu-latn: keep Arabic date/time formatting but force Western digits
// (0-9) instead of Eastern Arabic-Indic numerals (٠-٩) everywhere in the app.
const localeMap = { ar: "ar-IQ-u-nu-latn", ku: "en-GB", en: "en-US" };
  const dateStr = m.updatedAt?.seconds
    ? new Date(m.updatedAt.seconds * 1000).toLocaleString(localeMap[lang])
    : m.updatedAtMs ? new Date(m.updatedAtMs).toLocaleString(localeMap[lang]) : "";
  const meta = [fmtFileSize(m.fileSize), dateStr].filter(Boolean).join(" · ");
  return el(`
    <div class="file-info-card">
      <div class="file-info-icon">📄</div>
      <div>
        <div class="file-info-name">${escapeHtml(m.fileName || "")}</div>
        ${meta ? `<div class="file-info-meta">${escapeHtml(meta)}</div>` : ""}
      </div>
    </div>
  `);
}

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
  // English removed site-wide — Arabic/Kurdish only. Guards against a
  // browser that still has "en" saved from before this change.
  lang: LANGS.includes(localStorage.getItem("lang")) ? localStorage.getItem("lang") : "ar",
  user: null,       // firebase auth user
  profile: null,     // users/{uid} doc
  route: "login",    // login | admin | exam | result | admin-setup
  questions: [],
  candidates: [],
  attempts: {},
  examConfig: { sectionMinutes: { ...DEFAULT_SECTION_MINUTES }, sectionCounts: { ...DEFAULT_SECTION_COUNTS }, sectionOrder: [...SECTIONS], selectionMode: "random", manualQuestionIds: [], fontFamily: "cairo" },
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
    logLoginDevice(user);
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
    // "random": sectionCounts picks a fresh random subset per candidate.
    // "manual": every candidate gets the exact same admin-picked question set.
    selectionMode: data?.selectionMode === "manual" ? "manual" : "random",
    manualQuestionIds: Array.isArray(data?.manualQuestionIds) ? data.manualQuestionIds : [],
    fontFamily: FONT_OPTIONS[data?.fontFamily] ? data.fontFamily : "cairo",
  };
}
function watchExamConfig() {
  if (unsubExamConfig) return;
  unsubExamConfig = onSnapshot(doc(db, "settings", "examConfig"), (snap) => {
    const cfg = mergeExamConfig(snap.exists() ? snap.data() : null);
    applyFont(cfg.fontFamily);
    setState({ examConfig: cfg });
  });
}
async function loadExamConfig() {
  try {
    const snap = await getDoc(doc(db, "settings", "examConfig"));
    state.examConfig = mergeExamConfig(snap.exists() ? snap.data() : null);
    applyFont(state.examConfig.fontFamily);
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

// Records this device (IP + User-Agent, read server-side from the raw
// request — not anything the client claims) against the candidate's
// profile, so staff can see every device/browser they've logged in from
// (see server/index.js's /log-login). Best-effort — never blocks sign-in.
async function logLoginDevice(user) {
  if (!ADMIN_SERVER_URL) return;
  try {
    const token = await user.getIdToken();
    await fetch(`${ADMIN_SERVER_URL}/log-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ deviceId: getDeviceId() }),
    });
  } catch (err) {
    console.warn("login device logging failed", err);
  }
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
  const wrap = el(`<div></div>`);

  // ---- Site-wide font ----
  const fontForm = el(`
    <form id="font-form" class="card">
      <h3>${L("fontsLabel")}</h3>
      <p class="hint">${L("fontsHint")}</p>
      <label>${L("fontType")}
        <select name="fontFamily">
          ${Object.entries(FONT_OPTIONS).map(([key, f]) => `<option value="${key}">${f.label}</option>`).join("")}
        </select>
      </label>
      <div class="err" id="font-msg"></div>
      <button type="submit" class="primary">${L("saveSettings")}</button>
    </form>
  `);
  fontForm.querySelector("[name=fontFamily]").value = cfg.fontFamily;
  fontForm.onsubmit = async (e) => {
    e.preventDefault();
    const fontFamily = new FormData(e.target).get("fontFamily");
    await setDoc(doc(db, "settings", "examConfig"), { fontFamily }, { merge: true });
    applyFont(fontFamily);
    state.examConfig = { ...state.examConfig, fontFamily };
    const msg = fontForm.querySelector("#font-msg");
    msg.textContent = L("settingsSaved"); msg.classList.remove("err"); msg.classList.add("notice");
  };
  wrap.appendChild(fontForm);

  // ---- Per-section time limits (independent of selection mode) ----
  const minutesForm = el(`
    <form id="minutes-form" class="card">
      <h3>${L("sectionMinutesLabel")}</h3>
      ${SECTIONS.map((s) => `
        <label>${L(s)}<input type="number" name="min_${s}" min="1" value="${cfg.sectionMinutes[s]}" /></label>
      `).join("")}
      <div class="err" id="minutes-msg"></div>
      <button type="submit" class="primary">${L("saveSettings")}</button>
    </form>
  `);
  minutesForm.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const sectionMinutes = {};
    SECTIONS.forEach((s) => { sectionMinutes[s] = Number(f.get(`min_${s}`)) || DEFAULT_SECTION_MINUTES[s]; });
    await setDoc(doc(db, "settings", "examConfig"), { sectionMinutes, sectionOrder: SECTIONS }, { merge: true });
    state.examConfig = { ...state.examConfig, sectionMinutes };
    const msg = minutesForm.querySelector("#minutes-msg");
    msg.textContent = L("settingsSaved"); msg.classList.remove("err"); msg.classList.add("notice");
  };
  wrap.appendChild(minutesForm);

  // ---- Question selection mode: random (per-candidate sample) vs manual
  // (one fixed set, same for every candidate) ----
  const modeCard = el(`<div class="card"></div>`);
  modeCard.appendChild(el(`<h3>${L("questionSelectionMode")}</h3>`));
  const modeButtons = el(`
    <div class="row-actions" style="margin-bottom:14px">
      <button type="button" id="mode-random-btn">${L("modeRandom")}</button>
      <button type="button" id="mode-manual-btn">${L("modeManual")}</button>
    </div>
  `);
  modeCard.appendChild(modeButtons);
  const modeBody = el(`<div id="mode-body"></div>`);
  modeCard.appendChild(modeBody);
  wrap.appendChild(modeCard);

  let currentMode = cfg.selectionMode || "random";
  const randomBtn = modeButtons.querySelector("#mode-random-btn");
  const manualBtn = modeButtons.querySelector("#mode-manual-btn");

  function renderModeBody() {
    randomBtn.className = currentMode === "random" ? "primary" : "ghost";
    manualBtn.className = currentMode === "manual" ? "primary" : "ghost";
    modeBody.innerHTML = "";

    if (currentMode === "random") {
      const randomForm = el(`
        <form id="random-form">
          <p class="hint">${L("sectionCountsHint")}</p>
          ${SECTIONS.map((s) => `<label>${L(s)}<input type="number" name="count_${s}" min="0" value="${state.examConfig.sectionCounts[s]}" /></label>`).join("")}
          <div class="err" id="random-msg"></div>
          <button type="submit" class="primary">${L("saveSettings")}</button>
        </form>
      `);
      randomForm.onsubmit = async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const sectionCounts = {};
        SECTIONS.forEach((s) => { sectionCounts[s] = Math.max(0, Number(f.get(`count_${s}`)) || 0); });
        await setDoc(doc(db, "settings", "examConfig"), { selectionMode: "random", sectionCounts }, { merge: true });
        state.examConfig = { ...state.examConfig, selectionMode: "random", sectionCounts };
        const msg = randomForm.querySelector("#random-msg");
        msg.textContent = L("settingsSaved"); msg.classList.remove("err"); msg.classList.add("notice");
      };
      modeBody.appendChild(randomForm);
      return;
    }

    // Manual: a checkbox list of every active question, grouped by section.
    // Pre-checked from whatever is already saved in manualQuestionIds.
    const activeQs = state.questions.filter((q) => q.active !== false);
    const bySection = SECTIONS
      .map((s) => ({ section: s, qs: activeQs.filter((q) => (q.section || "reading") === s) }))
      .filter((g) => g.qs.length);
    const checkedIds = new Set(state.examConfig.manualQuestionIds || []);

    modeBody.appendChild(el(`<p class="hint">${L("manualSelectionHint")}</p>`));
    const list = el(`<div class="manual-q-list"></div>`);
    if (!bySection.length) list.appendChild(el(`<p>${L("noQuestions")}</p>`));
    bySection.forEach((g) => {
      list.appendChild(el(`<h4 class="manual-q-section-h">${L(g.section)}</h4>`));
      g.qs.forEach((q, i) => {
        list.appendChild(el(`
          <label class="manual-q-row">
            <input type="checkbox" value="${q.id}" ${checkedIds.has(q.id) ? "checked" : ""} />
            ${i + 1}. ${escapeHtml(q.text?.[state.lang] || q.text?.ar || "")}
          </label>
        `));
      });
    });
    modeBody.appendChild(list);

    const msg = el(`<div class="err" id="manual-msg"></div>`);
    const actions = el(`<div class="row-actions" style="margin-top:12px"></div>`);
    const clearBtn = el(`<button type="button" class="ghost danger">${L("clearSelection")}</button>`);
    clearBtn.onclick = async () => {
      if (!confirm(L("clearSelectionConfirm"))) return;
      await setDoc(doc(db, "settings", "examConfig"), { manualQuestionIds: [] }, { merge: true });
      state.examConfig = { ...state.examConfig, manualQuestionIds: [] };
      list.querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = false; });
      msg.textContent = L("selectionCleared"); msg.classList.remove("err"); msg.classList.add("notice");
    };
    const saveBtn = el(`<button type="button" class="primary">${L("saveSelection")}</button>`);
    saveBtn.onclick = async () => {
      const ids = [...list.querySelectorAll("input[type=checkbox]:checked")].map((cb) => cb.value);
      if (!ids.length) { msg.textContent = L("selectAtLeastOne"); msg.classList.remove("notice"); return; }
      await setDoc(doc(db, "settings", "examConfig"), { selectionMode: "manual", manualQuestionIds: ids }, { merge: true });
      state.examConfig = { ...state.examConfig, selectionMode: "manual", manualQuestionIds: ids };
      msg.textContent = L("settingsSaved"); msg.classList.remove("err"); msg.classList.add("notice");
    };
    actions.appendChild(clearBtn);
    actions.appendChild(saveBtn);
    modeBody.appendChild(msg);
    modeBody.appendChild(actions);
  }
  randomBtn.onclick = () => { currentMode = "random"; renderModeBody(); };
  manualBtn.onclick = () => { currentMode = "manual"; renderModeBody(); };
  renderModeBody();

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

// Score as a 0..1 fraction for a candidate, or -1 if they have no scoreable
// attempt yet — used for both sorting and the distribution chart below.
function candidateScoreFraction(c) {
  const att = state.attempts[c.id];
  if (!att || !att.totalPoints) return -1;
  return ((att.autoScore ?? att.score ?? 0) + (att.manualScore ?? 0)) / att.totalPoints;
}

function renderDashboardStats(visible) {
  const wrap = el(`<div class="card"></div>`);
  const completedCount = visible.filter((c) => ["submitted", "graded"].includes(c.examStatus)).length;
  const blockedCount = visible.filter((c) => c.blocked).length;
  const scored = visible.filter((c) => candidateScoreFraction(c) >= 0);
  const avgPct = scored.length
    ? Math.round(scored.reduce((sum, c) => sum + candidateScoreFraction(c), 0) / scored.length * 100)
    : null;
  wrap.innerHTML = `
    <h3>${L("dashboardStatsTitle")}</h3>
    <div class="stat-row">
      <div class="stat-box"><div class="stat-num">${visible.length}</div><div class="stat-lbl">${L("candidates")}</div></div>
      <div class="stat-box"><div class="stat-num">${completedCount}</div><div class="stat-lbl">${L("completedCount")}</div></div>
      <div class="stat-box"><div class="stat-num">${blockedCount}</div><div class="stat-lbl">${L("blocked")}</div></div>
      <div class="stat-box"><div class="stat-num">${avgPct == null ? "—" : avgPct + "%"}</div><div class="stat-lbl">${L("avgScoreLabel")}</div></div>
    </div>
  `;
  if (scored.length) {
    const bucketLabels = ["0-20%", "21-40%", "41-60%", "61-80%", "81-100%"];
    const buckets = [0, 0, 0, 0, 0];
    scored.forEach((c) => { buckets[Math.min(4, Math.floor(candidateScoreFraction(c) * 100 / 20))] += 1; });
    const max = Math.max(...buckets, 1);
    const chart = el(`<div class="score-chart"></div>`);
    buckets.forEach((count, i) => {
      chart.appendChild(el(`
        <div class="score-chart-row">
          <span class="score-chart-lbl">${bucketLabels[i]}</span>
          <div class="score-chart-bar-track"><div class="score-chart-bar" style="width:${(count / max) * 100}%"></div></div>
          <span class="score-chart-count">${count}</span>
        </div>
      `));
    });
    wrap.appendChild(el(`<h3 style="margin-top:16px">${L("scoreDistributionTitle")}</h3>`));
    wrap.appendChild(chart);
  }
  return wrap;
}

function renderCandidatesTab() {
  const showRemoved = !!state.showRemovedCandidates;
  let visible = state.candidates.filter((c) => showRemoved ? c.deleted : !c.deleted);

  const wrap = el(`<div></div>`);
  if (!showRemoved) wrap.appendChild(renderDashboardStats(visible));

  const filterStatus = state.candidateFilterStatus || "all";
  const sortBy = state.candidateSortBy || "recent";
  if (filterStatus !== "all") visible = visible.filter((c) => (c.examStatus || "not_started") === filterStatus);
  const durationOf = (c) => state.attempts[c.id]?.durationSec ?? Infinity;
  if (sortBy === "nameAsc") visible = [...visible].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  else if (sortBy === "scoreDesc") visible = [...visible].sort((a, b) => candidateScoreFraction(b) - candidateScoreFraction(a));
  else if (sortBy === "scoreAsc") visible = [...visible].sort((a, b) => candidateScoreFraction(a) - candidateScoreFraction(b));
  else if (sortBy === "durationAsc") visible = [...visible].sort((a, b) => durationOf(a) - durationOf(b));
  // "recent" (default) keeps watchCandidates()'s own createdAt-desc order.

  const toolbar = el(`
    <div>
      <button id="new-cand-btn" class="primary">${L("createCandidate")}</button>
      <button id="toggle-removed-btn" class="ghost">${showRemoved ? L("candidates") : L("removedCandidates")}</button>
      ${state.profile.role === "admin" ? `<button id="reset-all-exams-btn" class="ghost danger">${L("resetAllExamsBtn")}</button>` : ""}
      <div id="new-cand-form"></div>
      <div class="row-actions" style="margin:12px 0">
        <select id="filter-status">
          <option value="all">${L("filterAll")}</option>
          <option value="not_started">${L("notStarted")}</option>
          <option value="in_progress">${L("inProgress")}</option>
          <option value="submitted">${L("submitted")}</option>
          <option value="graded">${L("graded")}</option>
        </select>
        <select id="sort-by">
          <option value="recent">${L("sortRecent")}</option>
          <option value="nameAsc">${L("sortNameAsc")}</option>
          <option value="scoreDesc">${L("sortScoreDesc")}</option>
          <option value="scoreAsc">${L("sortScoreAsc")}</option>
          <option value="durationAsc">${L("sortDurationAsc")}</option>
        </select>
      </div>
      <div class="table-scroll">
        <table class="grid">
          <thead><tr>
            <th>${L("name")}</th><th>${L("phone")}</th><th>${L("password")}</th>
            <th>${L("status")}</th><th>${L("score")}</th><th>${L("examDurationLabel")}</th><th></th>
          </tr></thead>
          <tbody id="cand-rows"></tbody>
        </table>
      </div>
    </div>
  `);
  toolbar.querySelector("#filter-status").value = filterStatus;
  toolbar.querySelector("#sort-by").value = sortBy;
  toolbar.querySelector("#filter-status").onchange = (e) => setState({ candidateFilterStatus: e.target.value });
  toolbar.querySelector("#sort-by").onchange = (e) => setState({ candidateSortBy: e.target.value });
  wrap.appendChild(toolbar);
  toolbar.querySelector("#new-cand-btn").onclick = () => {
    const formHost = toolbar.querySelector("#new-cand-form");
    formHost.innerHTML = "";
    formHost.appendChild(renderNewCandidateForm());
  };
  toolbar.querySelector("#toggle-removed-btn").onclick = () => setState({ showRemovedCandidates: !showRemoved });
  const resetAllBtn = toolbar.querySelector("#reset-all-exams-btn");
  if (resetAllBtn) resetAllBtn.onclick = resetAllExamsBulk;
  const rows = toolbar.querySelector("#cand-rows");
  visible.forEach((c) => {
    const att = state.attempts[c.id];
    const tr = el(`
      <tr>
        <td>${escapeHtml(c.name)}</td>
        <td>${escapeHtml(c.phone || "")}</td>
        <td class="mono">${escapeHtml(c.code || "—")}</td>
        <td>${statusLabel(c)}</td>
        <td>${att ? `${att.score}/${att.totalPoints}` : "—"}</td>
        <td>${Number.isFinite(att?.durationSec) ? fmtTime(att.durationSec) : "—"}</td>
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
    const devicesBtn = el(`<button class="link">${L("viewDevices")}</button>`);
    devicesBtn.onclick = () => setState({ adminTab: "candidates", viewCandidateDevices: c.id });
    actions.appendChild(devicesBtn);
    const historyBtn = el(`<button class="link">${L("examHistory")}</button>`);
    historyBtn.onclick = () => setState({ adminTab: "candidates", viewCandidateHistory: c.id });
    actions.appendChild(historyBtn);
    if (state.profile.role === "admin" && c.examStatus && c.examStatus !== "not_started") {
      const newExamBtn = el(`<button class="link warn">${L("newExam")}</button>`);
      newExamBtn.onclick = () => resetCandidateExam(c);
      actions.appendChild(newExamBtn);
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
  if (state.viewCandidateDevices) {
    const c = state.candidates.find((x) => x.id === state.viewCandidateDevices);
    if (c) wrap.appendChild(renderCandidateDevicesPanel(c));
  }
  if (state.viewCandidateHistory) {
    const c = state.candidates.find((x) => x.id === state.viewCandidateHistory);
    if (c) wrap.appendChild(renderCandidateHistoryPanel(c));
  }
  return wrap;
}

// Wipes exam data for EVERY candidate — current attempt, all archived
// history, and progress fields — everywhere at once. Destructive and
// irreversible, gated behind typing an exact confirmation word (not just a
// yes/no dialog) since this can't be undone.
async function resetAllExamsBulk() {
  const CONFIRM_WORD = "تصفير";
  const typed = prompt(L("resetAllExamsPrompt", { word: CONFIRM_WORD }));
  if (typed === null) return;
  if (typed.trim() !== CONFIRM_WORD) { alert(L("resetAllExamsCancelled")); return; }
  const candidates = state.candidates.filter((c) => !c.deleted);
  for (const c of candidates) {
    try {
      const pastSnap = await getDocs(collection(db, "users", c.id, "pastAttempts"));
      await Promise.all(pastSnap.docs.map((d) => deleteDoc(d.ref)));
      await deleteDoc(doc(db, "attempts", c.id)).catch(() => {});
      await updateDoc(doc(db, "users", c.id), {
        examStatus: "not_started",
        examProgress: deleteField(), examManualProgress: deleteField(),
        examSectionIndex: deleteField(), examQIndex: deleteField(),
        examSectionDeadline: deleteField(), examStartedAtMs: deleteField(),
        examSelectedQuestionIds: deleteField(),
      }).catch(() => {});
    } catch (err) {
      console.warn(`reset failed for candidate ${c.id}`, err);
    }
  }
  alert(L("resetAllExamsDone"));
}

// Archives the candidate's current attempt (if any) into pastAttempts, then
// resets their profile so they can take the exam again from scratch — old
// results survive as history instead of being silently overwritten.
async function resetCandidateExam(c) {
  if (!confirm(L("newExamConfirm", { name: c.name }))) return;
  try {
    const attemptSnap = await getDoc(doc(db, "attempts", c.id));
    if (attemptSnap.exists()) {
      await addDoc(collection(db, "users", c.id, "pastAttempts"), {
        ...attemptSnap.data(), archivedAt: serverTimestamp(),
      });
      await deleteDoc(doc(db, "attempts", c.id));
    }
    await updateDoc(doc(db, "users", c.id), {
      examStatus: "not_started",
      examProgress: deleteField(), examManualProgress: deleteField(),
      examSectionIndex: deleteField(), examQIndex: deleteField(),
      examSectionDeadline: deleteField(), examStartedAtMs: deleteField(),
      examSelectedQuestionIds: deleteField(),
    });
  } catch (err) {
    alert(`${L("error")}: ${err.message}`);
  }
}

function renderCandidateHistoryPanel(c) {
  const wrap = el(`<div class="card"><h3>${escapeHtml(c.name)} — ${L("examHistory")}</h3><div id="history-body">${L("loading")}</div></div>`);
  const localeMap = { ar: "ar-IQ-u-nu-latn", ku: "en-GB", en: "en-US" };
  getDocs(query(collection(db, "users", c.id, "pastAttempts"), orderBy("archivedAt", "desc"))).then((snap) => {
    const body = wrap.querySelector("#history-body");
    body.innerHTML = "";
    if (snap.empty) { body.textContent = L("noExamHistory"); return; }
    snap.forEach((d) => {
      const a = d.data();
      const total = (a.autoScore ?? a.score ?? 0) + (a.manualScore ?? 0);
      const archivedStr = a.archivedAt?.seconds ? new Date(a.archivedAt.seconds * 1000).toLocaleString(localeMap[state.lang]) : "—";
      body.appendChild(el(`
        <div class="history-card">
          <div class="history-card-score">${total} / ${a.totalPoints ?? 0}</div>
          <div class="hint">${L("archivedAtLabel")}: ${archivedStr}</div>
        </div>
      `));
    });
  });
  return wrap;
}

const DEVICE_TYPE_KEY = { mobile: "deviceTypeMobile", tablet: "deviceTypeTablet", desktop: "deviceTypeDesktop" };

function renderCandidateDevicesPanel(c) {
  const wrap = el(`<div class="card"><h3>${escapeHtml(c.name)} — ${L("viewDevices")}</h3><div id="devices-body">${L("loading")}</div></div>`);
  // -u-nu-latn: keep Arabic date/time formatting but force Western digits
// (0-9) instead of Eastern Arabic-Indic numerals (٠-٩) everywhere in the app.
const localeMap = { ar: "ar-IQ-u-nu-latn", ku: "en-GB", en: "en-US" };
  getDocs(collection(db, "users", c.id, "loginDevices")).then((snap) => {
    const body = wrap.querySelector("#devices-body");
    body.innerHTML = "";
    if (snap.empty) { body.textContent = L("noDevicesYet"); return; }
    const list = [];
    snap.forEach((d) => list.push(d.data()));
    list.sort((a, b) => (b.lastSeenAt?.seconds || 0) - (a.lastSeenAt?.seconds || 0));
    if (list.length > 1) body.appendChild(el(`<p class="hint" style="color:var(--bad)">${L("multipleDevicesWarning", { n: list.length })}</p>`));
    const tableWrap = el(`
      <div class="table-scroll">
        <table class="grid">
          <thead><tr>
            <th>${L("deviceTypeLabel")}</th><th>${L("browserLabel")}</th><th>${L("ipLabel")}</th>
            <th>${L("lastSeenLabel")}</th><th>${L("loginCountLabel")}</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
    `);
    const tbody = tableWrap.querySelector("tbody");
    list.forEach((d) => {
      const lastStr = d.lastSeenAt?.seconds ? new Date(d.lastSeenAt.seconds * 1000).toLocaleString(localeMap[state.lang]) : "—";
      tbody.appendChild(el(`
        <tr>
          <td>${L(DEVICE_TYPE_KEY[d.deviceType] || "deviceTypeDesktop")}</td>
          <td>${escapeHtml(d.browser || "—")}</td>
          <td class="mono">${escapeHtml(d.ip || "—")}</td>
          <td>${lastStr}</td>
          <td>${d.loginCount ?? 1}</td>
        </tr>
      `));
    });
    body.appendChild(tableWrap);
  });
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
    const graded = a.examStatus === "graded";

    // Same 4-section box layout as the candidate's own result screen, so
    // the admin can see the breakdown at a glance instead of re-tallying
    // the question list by hand.
    const sectionScoresNow = a.sectionScores || {};
    const usedSectionsNow = SECTIONS.filter((s) => (sectionScoresNow[s]?.total || 0) > 0);
    if (usedSectionsNow.length) {
      const grid = el(`<div class="section-score-grid"></div>`);
      usedSectionsNow.forEach((s) => {
        const ss = sectionScoresNow[s];
        const isManualSection = (s === "speaking" || s === "writing");
        const stillPending = isManualSection && !graded;
        grid.appendChild(el(`
          <div class="section-score-box">
            <div class="section-score-lbl">${L(s)}</div>
            <div class="section-score-val">${stillPending ? "—" : `${ss.score} / ${ss.total}`}</div>
          </div>
        `));
      });
      body.appendChild(grid);
    }

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
        // Fold the manual scores into their sections too, so the result
        // screen's per-section breakdown includes speaking/writing once graded.
        const sectionScores = { ...(a.sectionScores || {}) };
        const manualSections = new Set(manualQs.map((q) => q.section || "reading"));
        manualSections.forEach((sec) => {
          sectionScores[sec] = { ...(sectionScores[sec] || { total: 0 }), score: 0 };
        });
        manualQs.forEach((q) => {
          const sec = q.section || "reading";
          sectionScores[sec].score += newManualScores[q.id];
        });
        await updateDoc(doc(db, "attempts", c.id), {
          manualScores: newManualScores,
          manualScore,
          score: autoScore + manualScore,
          sectionScores,
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
    const summary = el(`<p class="total-score-line"><span>${L("finalScoreLabel")}</span> <b>${total} / ${a.totalPoints}</b></p>`);
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
      <div class="table-scroll">
        <table class="grid">
          <thead><tr><th>${L("name")}</th><th>${L("phone")}</th><th>${L("password")}</th><th></th></tr></thead>
          <tbody id="coadmin-rows"><tr><td colspan="4">${L("loading")}</td></tr></tbody>
        </table>
      </div>
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
  const m = state.material || {};
  const hasPdf = !!m.fileId;
  const hasImages = Array.isArray(m.images) && m.images.length > 0;
  const mode = m.mode === "images" ? "images" : "pdf";

  if (isAdmin) {
    // ---- PDF upload ----
    const form = el(`
      <form id="material-form" class="card">
        <h3>${L("uploadMaterial")}</h3>
        <label>${L("chooseFile")}<input type="file" name="file" accept="application/pdf" required /></label>
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
        const fileSize = file.size;
        const { fileId, fileName } = await uploadViaServer("/uploads/material", file);
        const patch = { fileId, fileName, fileSize, updatedAt: serverTimestamp() };
        if (!hasImages) patch.mode = "pdf"; // first content uploaded becomes the active mode
        await setDoc(doc(db, "settings", "material"), patch, { merge: true });
        state.material = { ...state.material, fileId, fileName, fileSize, updatedAtMs: Date.now(), mode: patch.mode || mode };
        setState({});
      } catch (err) {
        errBox.textContent = err.message;
      }
    };
    wrap.appendChild(form);

    // ---- Images upload (alternative to the PDF — sturdier when a PDF's
    // embedded font doesn't render correctly, since an image can't garble) ----
    const imgForm = el(`
      <form id="material-images-form" class="card">
        <h3>${L("uploadMaterialImages")}</h3>
        <p class="hint">${L("uploadMaterialImagesHint")}</p>
        <label>${L("chooseFiles")}<input type="file" name="files" accept="image/*" multiple required /></label>
        <div class="err" id="material-images-err"></div>
        <button type="submit" class="primary">${L("save")}</button>
      </form>
    `);
    imgForm.onsubmit = async (e) => {
      e.preventDefault();
      const input = imgForm.querySelector("[name=files]");
      const files = [...input.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const errBox = imgForm.querySelector("#material-images-err");
      errBox.textContent = L("uploadingFile");
      errBox.classList.remove("notice");
      try {
        const fd = new FormData();
        files.forEach((file) => fd.append("files", file));
        const token = await state.user.getIdToken();
        const res = await fetch(`${ADMIN_SERVER_URL}/uploads/material-images`, {
          method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || res.statusText);
        const patch = { images: body.images, imagesUpdatedAt: serverTimestamp() };
        if (!hasPdf) patch.mode = "images";
        await setDoc(doc(db, "settings", "material"), patch, { merge: true });
        state.material = { ...state.material, images: body.images, imagesUpdatedAtMs: Date.now(), mode: patch.mode || mode };
        setState({});
      } catch (err) {
        errBox.textContent = err.message;
      }
    };
    wrap.appendChild(imgForm);
  }

  // ---- PDF status ----
  const pdfRow = el(`<div class="row-actions" style="align-items:center"></div>`);
  pdfRow.appendChild(hasPdf ? renderFileInfoCard(m, state.lang) : el(`<p>${L("noMaterial")}</p>`));
  if (isAdmin && hasPdf) {
    const delBtn = el(`<button class="link danger">${L("deleteMaterial")}</button>`);
    delBtn.onclick = async () => {
      if (!confirm(L("deleteMaterialConfirm"))) return;
      delBtn.disabled = true;
      try {
        const token = await state.user.getIdToken();
        const res = await fetch(`${ADMIN_SERVER_URL}/material/${m.fileId}`, {
          method: "DELETE", headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        const patch = { fileId: deleteField(), fileName: deleteField(), fileSize: deleteField() };
        if (mode === "pdf" && hasImages) patch.mode = "images";
        await updateDoc(doc(db, "settings", "material"), patch);
        state.material = { ...state.material, fileId: null, fileName: null, fileSize: null, mode: patch.mode || state.material.mode };
        setState({});
      } catch (err) {
        alert(`${L("error")}: ${err.message}`);
        delBtn.disabled = false;
      }
    };
    pdfRow.appendChild(delBtn);
  }
  wrap.appendChild(pdfRow);

  // ---- Images status ----
  const imagesRow = el(`<div class="row-actions" style="align-items:center"></div>`);
  imagesRow.appendChild(el(`<p>${hasImages ? L("materialImagesCount", { n: m.images.length }) : L("noMaterialImages")}</p>`));
  if (isAdmin && hasImages) {
    const delImgsBtn = el(`<button class="link danger">${L("deleteMaterialImages")}</button>`);
    delImgsBtn.onclick = async () => {
      if (!confirm(L("deleteMaterialImagesConfirm"))) return;
      delImgsBtn.disabled = true;
      try {
        const token = await state.user.getIdToken();
        await fetch(`${ADMIN_SERVER_URL}/material-images`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ fileIds: m.images.map((im) => im.fileId) }),
        });
        const patch = { images: deleteField() };
        if (mode === "images" && hasPdf) patch.mode = "pdf";
        await updateDoc(doc(db, "settings", "material"), patch);
        state.material = { ...state.material, images: null, mode: patch.mode || state.material.mode };
        setState({});
      } catch (err) {
        alert(`${L("error")}: ${err.message}`);
        delImgsBtn.disabled = false;
      }
    };
    imagesRow.appendChild(delImgsBtn);
  }
  wrap.appendChild(imagesRow);

  // ---- Active mode toggle (which one candidates actually see) ----
  // Always visible once at least one format exists — picking a format with
  // nothing uploaded yet is how the admin can deliberately show "no
  // material" for that format (its button is just disabled instead, so
  // that specific no-op isn't available, but the other format stays a
  // one-click switch away at any time).
  if (isAdmin && (hasPdf || hasImages)) {
    const modeCard = el(`
      <div class="card">
        <h3>${L("materialActiveModeLabel")}</h3>
        <p class="hint">${L("materialActiveModeHint")}</p>
        <div class="row-actions">
          <button type="button" id="mode-pdf-btn" class="${mode === "pdf" ? "primary" : "ghost"}" ${hasPdf ? "" : "disabled"}>${L("materialModePdf")}</button>
          <button type="button" id="mode-images-btn" class="${mode === "images" ? "primary" : "ghost"}" ${hasImages ? "" : "disabled"}>${L("materialModeImages")}</button>
        </div>
      </div>
    `);
    modeCard.querySelector("#mode-pdf-btn").onclick = async () => {
      await updateDoc(doc(db, "settings", "material"), { mode: "pdf" });
      state.material = { ...state.material, mode: "pdf" };
      setState({});
    };
    modeCard.querySelector("#mode-images-btn").onclick = async () => {
      await updateDoc(doc(db, "settings", "material"), { mode: "images" });
      state.material = { ...state.material, mode: "images" };
      setState({});
    };
    wrap.appendChild(modeCard);
  }

  const statsHost = el(`
    <div>
      <h3>${L("materialStats")}</h3>
      <div class="table-scroll">
        <table class="grid">
          <thead><tr><th>${L("name")}</th><th>${L("sessionsCount")}</th><th>${L("totalTime")}</th><th>${L("maxPageReached")}</th><th>${L("lastRead")}</th></tr></thead>
          <tbody id="material-stats-rows"><tr><td colspan="5">${L("loading")}</td></tr></tbody>
        </table>
      </div>
    </div>
  `);
  wrap.appendChild(statsHost);

  (async () => {
    if (state.material == null) {
      const snap = await getDoc(doc(db, "settings", "material"));
      state.material = snap.exists() ? snap.data() : false;
      // Re-render so the synchronous code above rebuilds the file-info card
      // (and delete button, now that state.material.fileId exists) fresh.
      if (state.material) setState({});
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
    // -u-nu-latn: keep Arabic date/time formatting but force Western digits
// (0-9) instead of Eastern Arabic-Indic numerals (٠-٩) everywhere in the app.
const localeMap = { ar: "ar-IQ-u-nu-latn", ku: "en-GB", en: "en-US" };
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
function wireAutoFill(arEl, kuEl) {
  if (!kuEl.value || kuEl.value === arEl.value) kuEl.dataset.autoFilled = "1";
  kuEl.addEventListener("input", () => {
    if (kuEl.value !== arEl.value) delete kuEl.dataset.autoFilled;
  });
  arEl.addEventListener("input", () => {
    if (kuEl.dataset.autoFilled) kuEl.value = arEl.value;
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
          <option value="ku">${L("displayLangKu")}</option>
        </select>
      </label>
      <label>${L("questionTextAr")}<input name="text_ar" required value="${escapeHtml(existing?.text?.ar || "")}" /></label>
      <label>${L("questionTextKu")}<input name="text_ku" value="${escapeHtml(existing?.text?.ku || "")}" /></label>
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
  wireAutoFill(wrap.querySelector("[name=text_ar]"), wrap.querySelector("[name=text_ku]"));
  function renderExtra() {
    extra.innerHTML = "";
    const type = typeSel.value;
    const section = sectionSel.value;
    if (type === "speaking" || type === "writing") {
      extra.appendChild(el(`<p class="hint">${L(type === "speaking" ? "speaking" : "writing")}: ${L("points")} = ${L("scoreOutOf", { max: "" })}. ${L("manualGrading")}.</p>`));
      return;
    }
    if (type === "mcq" || type === "image") {
      // The correct-answer radio sits right on each option's own fieldset
      // (not a separate "1/2/3/4" dropdown disconnected from the text) —
      // so it's obvious at a glance, while editing, which option is correct.
      for (let i = 0; i < 4; i++) {
        const optSet = el(`
          <fieldset class="opt-set">
            <legend>
              <label class="correct-radio">
                <input type="radio" name="correctIndex" value="${i}" ${i === 0 ? "checked" : ""} />
                ${L("correctAnswer")}
              </label>
              ${L("options")} ${i + 1}
            </legend>
            <input name="opt_ar_${i}" placeholder="AR" />
            <input name="opt_ku_${i}" placeholder="KU" />
          </fieldset>
        `);
        extra.appendChild(optSet);
      }
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
        });
        extra.querySelector(`[name=correctIndex][value="${existing.correctIndex ?? 0}"]`).checked = true;
        const imgSel = extra.querySelector("[name=imagePath]");
        if (imgSel && existing.imagePath) imgSel.value = existing.imagePath;
      }
      // Wired after any existing values are populated above, so editing an
      // already-translated question doesn't mistake real translations for
      // auto-filled placeholders.
      for (let i = 0; i < 4; i++) {
        wireAutoFill(extra.querySelector(`[name=opt_ar_${i}]`), extra.querySelector(`[name=opt_ku_${i}]`));
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
        </div>
      `);
      extra.appendChild(passageWrap);
      wireAutoFill(passageWrap.querySelector("[name=passage_ar]"), passageWrap.querySelector("[name=passage_ku]"));
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
      text: { ar: f.get("text_ar"), ku: f.get("text_ku") || f.get("text_ar") },
    };
    if (!existing) { data.active = true; data.createdAt = serverTimestamp(); }
    if (type === "mcq" || type === "image") {
      data.options = [0,1,2,3].map((i) => ({
        ar: f.get(`opt_ar_${i}`) || "", ku: f.get(`opt_ku_${i}`) || f.get(`opt_ar_${i}`) || "",
      }));
      data.correctIndex = Number(f.get("correctIndex"));
      if (type === "image") data.imagePath = f.get("imagePath");
    } else if (type === "truefalse") {
      data.correctAnswer = f.get("correctAnswer") === "true";
    }
    if (data.section === "reading" && (type === "mcq" || type === "truefalse" || type === "image")) {
      const pAr = f.get("passage_ar"), pKu = f.get("passage_ku");
      if (pAr || pKu) data.passage = { ar: pAr || "", ku: pKu || pAr || "" };
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
let examStartedAtMs = 0;       // ms epoch, when the candidate clicked "start exam"
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
    examStartedAtMs = state.profile.examStartedAtMs || 0;
    state._progressLoadedFor = state.profile.id;
  }

  if (state.profile.examStatus === "not_started") {
    const wrap = el(`<div></div>`);
    wrap.appendChild(renderCredentialsCard(state.profile));
    const actionsCard = el(`
      <div class="card center-card">
        <h2>${L("appName")}</h2>
        <button id="material-btn" class="ghost">${L("readMaterial")}</button>
        <button id="start-btn" class="primary">${L("startExam")}</button>
      </div>
    `);
    wrap.appendChild(actionsCard);
    wrap.querySelector("#material-btn").onclick = () => setState({ route: "material" });
    wrap.querySelector("#start-btn").onclick = async () => {
      // Manual mode: every candidate gets the exact same admin-picked set.
      // Random mode: sample once, here, from the full pool — sectionCounts
      // of 0 means "use everything" (pickRandom returns the whole array).
      let examSelectedQuestionIds;
      if (state.examConfig.selectionMode === "manual" && state.examConfig.manualQuestionIds.length) {
        const manualSet = new Set(state.examConfig.manualQuestionIds);
        examSelectedQuestionIds = activeQs.filter((q) => manualSet.has(q.id)).map((q) => q.id);
      } else {
        examSelectedQuestionIds = [];
        fullSections.forEach((sec) => {
          const n = state.examConfig.sectionCounts[sec.section] || 0;
          pickRandom(sec.qs, n).forEach((q) => examSelectedQuestionIds.push(q.id));
        });
      }
      // Safety net: never leave a candidate with an empty exam (e.g. a
      // saved manual selection whose questions were later deactivated).
      if (!examSelectedQuestionIds.length) examSelectedQuestionIds = activeQs.map((q) => q.id);
      const startSections = groupBySections(activeQs.filter((q) => examSelectedQuestionIds.includes(q.id)));
      const deadline = Date.now() + (state.examConfig.sectionMinutes[startSections[0].section] || 20) * 60000;
      const startedAtMs = Date.now();
      await updateDoc(doc(db, "users", state.profile.id), {
        examStatus: "in_progress", startedAt: serverTimestamp(),
        examSectionIndex: 0, examQIndex: 0, examSectionDeadline: deadline,
        examSelectedQuestionIds, examStartedAtMs: startedAtMs,
      });
      examSectionIndex = 0; examQIndex = 0; examSectionDeadline = deadline; examStartedAtMs = startedAtMs;
      setState({ profile: { ...state.profile, examStatus: "in_progress", examSelectedQuestionIds, examStartedAtMs: startedAtMs } });
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
  // Per-section breakdown (reading/listening/speaking/writing) so the
  // result screen can show each section's score, not just one grand total.
  const sectionScores = {};
  SECTIONS.forEach((s) => { sectionScores[s] = { score: 0, total: 0 }; });
  activeQs.forEach((q) => {
    const sec = q.section || "reading";
    const pts = q.points || 1;
    totalPoints += pts;
    sectionScores[sec].total += pts;
    if (q.type === "speaking" || q.type === "writing") {
      manualQuestions.push(q.id);
      return;
    }
    const given = examLocalAnswers[q.id];
    const correct = q.type === "truefalse" ? q.correctAnswer : q.correctIndex;
    if (given === correct) { autoScore += pts; sectionScores[sec].score += pts; }
  });
  const hasManual = manualQuestions.length > 0;
  // Recorded so staff can see it — deliberately not fed into the score
  // itself (see candidate table below), just shown alongside it.
  const durationSec = examStartedAtMs ? Math.max(0, Math.round((Date.now() - examStartedAtMs) / 1000)) : null;
  await setDoc(doc(db, "attempts", state.profile.id), {
    answers: examLocalAnswers,
    manualAnswers: examManualAnswers,
    autoScore, manualScore: 0, totalPoints, sectionScores,
    score: autoScore,
    examStatus: hasManual ? "submitted" : "submitted",
    needsManualGrading: hasManual,
    submittedAt: serverTimestamp(),
    durationSec,
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
      <div class="row-actions" style="justify-content:center;margin-bottom:4px">
        <button id="material-btn-result" class="ghost">${L("readMaterial")}</button>
      </div>
      <div id="cred-card-host"></div>
      <div class="card center-card" id="exam-meta"></div>
      <div class="card center-card" id="result-summary">
        <h2>${L("yourResult")}</h2>
        <p>${L("loading")}</p>
      </div>
      <div id="result-review"></div>
    </div>
  `);
  wrap.querySelector("#material-btn-result").onclick = () => setState({ route: "material" });
  // -u-nu-latn: keep Arabic date/time formatting but force Western digits
  // (0-9) instead of Eastern Arabic-Indic numerals (٠-٩) everywhere in the app.
  const localeMap = { ar: "ar-IQ-u-nu-latn", ku: "en-GB", en: "en-US" };
  wrap.querySelector("#cred-card-host").appendChild(renderCredentialsCard(p));
  getDoc(doc(db, "attempts", p.id)).then((snap) => {
    if (!snap.exists()) return;
    const a = snap.data();
    const graded = a.examStatus === "graded";
    const pendingManual = a.needsManualGrading && !graded;
    const total = (a.autoScore ?? a.score ?? 0) + (a.manualScore ?? 0);
    const submittedStr = a.submittedAt?.seconds
      ? new Date(a.submittedAt.seconds * 1000).toLocaleString(localeMap[state.lang])
      : "—";
    wrap.querySelector("#exam-meta").innerHTML = `
      <p><b>${L("status")}:</b> ${L(EXAM_STATUS_KEY[a.examStatus] || "submitted")}</p>
      <p><b>${L("submittedAtLabel")}:</b> ${submittedStr}</p>
      ${Number.isFinite(a.durationSec) ? `<p><b>${L("examDurationLabel")}:</b> ${fmtTime(a.durationSec)}</p>` : ""}
    `;

    // Four section scores (reading/listening/speaking/writing), each shown
    // even if pending manual grading (shows "—" for those until graded),
    // with the combined total below.
    const sectionScores = a.sectionScores || {};
    const usedSections = SECTIONS.filter((s) => (sectionScores[s]?.total || 0) > 0);
    const summaryHtml = [`<h2>${L("yourResult")}</h2>`];
    if (usedSections.length) {
      summaryHtml.push(`<div class="section-score-grid">`);
      usedSections.forEach((s) => {
        const ss = sectionScores[s];
        const isManualSection = (s === "speaking" || s === "writing");
        const stillPending = isManualSection && !graded;
        summaryHtml.push(`
          <div class="section-score-box">
            <div class="section-score-lbl">${L(s)}</div>
            <div class="section-score-val">${stillPending ? "—" : `${ss.score} / ${ss.total}`}</div>
          </div>
        `);
      });
      summaryHtml.push(`</div>`);
    }
    summaryHtml.push(`<p class="total-score-line"><span>${L("finalScoreLabel")}</span> <b>${total} / ${a.totalPoints}</b></p>`);
    if (pendingManual) summaryHtml.push(`<p class="hint">${L("pendingGrading")}</p>`);
    wrap.querySelector("#result-summary").innerHTML = summaryHtml.join("");

    const review = wrap.querySelector("#result-review");
    const answers = a.answers || {};
    const manualAnswers = a.manualAnswers || {};
    const manualScores = a.manualScores || {};

    // Auto-graded (reading/listening): right/wrong per question, same
    // right-answer logic used to score at submit time.
    const autoQs = state.questions.filter((q) => q.id in answers);
    if (autoQs.length) {
      const card = el(`<div class="card"><h3>${L("autoScore")}</h3></div>`);
      autoQs.forEach((q, i) => {
        const given = answers[q.id];
        const correct = q.type === "truefalse" ? q.correctAnswer : q.correctIndex;
        const isRight = given === correct;
        card.appendChild(el(`
          <div class="review-row ${isRight ? "ok" : "bad"}">
            <b>${i + 1}.</b> ${escapeHtml(q.text[qLang(q)] || q.text.ar)}
          </div>
        `));
      });
      review.appendChild(card);
    }

    // Speaking/writing: candidate's own submitted answer, with the score
    // once an admin has graded it (or a pending note until then).
    const manualQs = state.questions.filter((q) => (q.type === "speaking" || q.type === "writing") && q.id in manualAnswers);
    if (manualQs.length) {
      const card = el(`<div class="card"><h3>${L("manualGrading")}</h3></div>`);
      manualQs.forEach((q, i) => {
        const ans = manualAnswers[q.id];
        const row = el(`<div class="review-row"></div>`);
        row.appendChild(el(`<div><b>${i + 1}.</b> ${escapeHtml(q.text[qLang(q)] || q.text.ar)}</div>`));
        if (q.type === "speaking") {
          row.appendChild(ans?.audioUrl ? el(`<audio controls src="${ans.audioUrl}"></audio>`) : el(`<p class="hint">${L("noAnswerGiven")}</p>`));
        } else {
          row.appendChild(el(`<p class="writing-answer-view">${escapeHtml(ans?.text || "")}</p>`));
        }
        row.appendChild(el(`<p class="hint">${graded ? `${L("scoreOutOf", { max: q.points ?? 1 })}: ${manualScores[q.id] ?? 0}` : L("pendingGrading")}</p>`));
        card.appendChild(row);
      });
      review.appendChild(card);
    }
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
// 1 = fit the page to the viewer's width (see availWidth in renderPage).
let materialZoom = 1;
// Teardown callbacks for one viewing session (event listeners, blob URLs).
// Without these, every re-open stacked another set of window/document
// listeners closing over stale DOM, and leaked every page's object URL.
let materialCleanups = [];
function runMaterialCleanups() {
  materialCleanups.forEach((fn) => { try { fn(); } catch {} });
  materialCleanups = [];
}

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
  // Safety net in case the viewer is re-entered without the back button
  // (which is what normally triggers stopMaterialTracking).
  runMaterialCleanups();
  if (state.material == null) {
    const snap = await getDoc(doc(db, "settings", "material"));
    state.material = snap.exists() ? snap.data() : false;
  }
  if (!state.material) { body.innerHTML = `<p>${L("noMaterial")}</p>`; return; }

  // Bug fix: materialZoom is a module-level var that used to carry over
  // from a previous viewing session (e.g. someone zoomed out once, and
  // every later open started back at that same reduced zoom instead of a
  // fresh 100%) — reset it every time the viewer opens.
  materialZoom = 1;

  const hasImages = Array.isArray(state.material.images) && state.material.images.length > 0;
  const hasPdf = !!state.material.fileId;
  let mode = state.material.mode === "images" ? "images" : "pdf";
  if (mode === "images" && !hasImages) mode = hasPdf ? "pdf" : null;
  if (mode === "pdf" && !hasPdf) mode = hasImages ? "images" : null;
  if (!mode) { body.innerHTML = `<p>${L("noMaterial")}</p>`; return; }

  body.innerHTML = `
    <div class="material-toolbar">
      <button id="prev-page">${L("prevPage")}</button>
      <span id="page-label"></span>
      <button id="next-page">${L("nextPage")}</button>
    </div>
    <div class="material-toolbar">
      <button id="zoom-out" type="button">−</button>
      <span id="zoom-label"></span>
      <button id="zoom-in" type="button">+</button>
    </div>
    <p class="hint" style="text-align:center">${L("noScreenshotHint")}</p>
    <div class="pdf-canvas-wrap" id="pdf-canvas-wrap">
      <div class="page-stage" id="page-stage">
        <canvas id="pdf-canvas"></canvas>
        <img id="page-img" alt="" />
        <div class="wm-overlay" id="wm-overlay"></div>
      </div>
    </div>
  `;
  const prevBtn = body.querySelector("#prev-page");
  const nextBtn = body.querySelector("#next-page");
  const label = body.querySelector("#page-label");
  const zoomOutBtn = body.querySelector("#zoom-out");
  const zoomInBtn = body.querySelector("#zoom-in");
  const zoomLabel = body.querySelector("#zoom-label");
  const canvasWrap = body.querySelector("#pdf-canvas-wrap");
  const stage = body.querySelector("#page-stage");
  const canvas = body.querySelector("#pdf-canvas");
  const pageImg = body.querySelector("#page-img");
  const wmOverlay = body.querySelector("#wm-overlay");
  // Only one of the two page elements is ever visible, depending on mode.
  canvas.style.display = mode === "pdf" ? "block" : "none";
  pageImg.style.display = mode === "images" ? "block" : "none";

  // Best-effort deterrents only — no web page can actually block a device's
  // screenshot/screen-recording capability (that needs a native app API).
  // This just makes casual copying/printing harder and traceable.
  canvasWrap.oncontextmenu = (e) => e.preventDefault();
  canvasWrap.style.userSelect = "none";
  // Bug fix: reading time used to keep counting even while the tab/app was
  // backgrounded or the screen locked — durationSec is (now - openedAt), a
  // plain wall-clock diff with nothing pausing it while hidden, so idle
  // time silently inflated the "total reading time" stat. Shifting both
  // reference timestamps forward by exactly how long it was hidden makes
  // the diff skip that gap entirely once it becomes visible again.
  let materialHiddenAt = 0;
  const onVisibilityChange = () => {
    const now = Date.now();
    if (document.hidden) {
      materialHiddenAt = now;
    } else if (materialHiddenAt) {
      const hiddenMs = now - materialHiddenAt;
      materialOpenedAt += hiddenMs;
      materialPageStartTs += hiddenMs;
      materialHiddenAt = 0;
    }
    canvasWrap.style.filter = document.hidden ? "blur(20px)" : "";
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  const beforePrint = () => { canvasWrap.style.visibility = "hidden"; };
  const afterPrint = () => { canvasWrap.style.visibility = "visible"; };
  window.addEventListener("beforeprint", beforePrint);
  window.addEventListener("afterprint", afterPrint);
  materialCleanups.push(() => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("beforeprint", beforePrint);
    window.removeEventListener("afterprint", afterPrint);
  });

  let pdfjsLib;
  if (mode === "pdf") {
    try {
      pdfjsLib = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs");
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs";
      if (!ADMIN_SERVER_URL) throw new Error(L("uploadServerMissing"));
      // disableRange/disableStream: our server proxies the PDF from Google
      // Drive as a plain stream with no Content-Length (Drive doesn't give us
      // the size upfront), so pdf.js's default range-request probing has
      // nothing to measure progress against and just hangs forever with no
      // error — this forces a single full fetch instead, which our proxy
      // supports fine.
      // The proxy route now requires auth (was open-by-URL before, which let
      // anyone with the fileId download the raw, un-watermarked PDF directly,
      // bypassing the app entirely) — so the request needs the candidate's
      // own ID token, same as the upload endpoints.
      const token = await state.user.getIdToken();
      // cMapUrl/standardFontDataUrl: without these, pdf.js can't substitute
      // glyphs for fonts that aren't fully embedded in the PDF (common with
      // Kurdish/Arabic-script documents) — text renders as garbled boxes
      // instead of the real characters. Even with these, some PDFs still
      // don't render cleanly (embedded-font quirks pdf.js can't fix) — the
      // image-pages mode above exists specifically as a reliable fallback.
      materialPdfDoc = await pdfjsLib.getDocument({
        url: `${ADMIN_SERVER_URL}/material/${state.material.fileId}`,
        httpHeaders: { Authorization: `Bearer ${token}` },
        disableRange: true, disableStream: true,
        cMapUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/standard_fonts/",
      }).promise;
    } catch (err) {
      body.innerHTML = `<p class="err">${err.message}</p>`;
      return;
    }
    materialPageCount = materialPdfDoc.numPages;
  } else {
    materialPageCount = state.material.images.length;
  }
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

  // Watermark: tiled, rotated, faint candidate name+phone laid over the page
  // as a CSS overlay rather than painted into the canvas. Keeping it out of
  // the bitmap means the page itself can be rendered/scaled at full quality
  // (see renderPage) — it doesn't stop a screenshot (nothing can), it just
  // makes any leaked copy traceable back to who took it.
  (function buildWatermark() {
    const text = `${state.profile.name || ""}  ${state.profile.phone || ""}`.trim();
    if (!text) return;
    wmOverlay.innerHTML = Array.from({ length: 120 }, () =>
      `<span class="wm-item">${escapeHtml(text)}</span>`).join("");
  })();

  // Page images are fetched once and cached as object URLs. They're shown in
  // a real <img> (not drawn into a canvas): the browser downscales a
  // 2500px-wide scan to phone width far better than canvas drawImage does,
  // and handles the device's pixel ratio for free. Canvas downscaling was
  // what turned the Kurdish text into unreadable mush.
  const imageUrlCache = {};
  async function getImageUrl(n) {
    if (imageUrlCache[n]) return imageUrlCache[n];
    const token = await state.user.getIdToken();
    const fileId = state.material.images[n - 1].fileId;
    const res = await fetch(`${ADMIN_SERVER_URL}/material-image/${fileId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    imageUrlCache[n] = URL.createObjectURL(await res.blob());
    return imageUrlCache[n];
  }

  // Width available for a page at 100% zoom — "100%" means fit-to-width,
  // which is what makes sense on a phone, instead of an arbitrary fixed scale.
  const availWidth = () => Math.max(200, canvasWrap.clientWidth || 320);

  async function renderPage(n) {
    if (mode === "pdf") {
      const page = await materialPdfDoc.getPage(n);
      const unscaled = page.getViewport({ scale: 1 });
      const cssScale = (availWidth() / unscaled.width) * materialZoom;
      // Render the bitmap at the device's real pixel density (capped at 3 so
      // huge pages don't blow up memory), then size it back down in CSS.
      // Without this the canvas is rendered at 1x and looks blurry on every
      // modern phone screen (which are 2x-3x).
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const viewport = page.getViewport({ scale: cssScale * dpr });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    } else {
      const url = await getImageUrl(n);
      if (pageImg.src !== url) pageImg.src = url;
      pageImg.style.width = `${availWidth() * materialZoom}px`;
      pageImg.style.height = "auto";
    }
    label.textContent = L("pageOf", { n, total: materialPageCount });
    zoomLabel.textContent = `${Math.round(materialZoom * 100)}%`;
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
  // 1 = fit-to-width, so allowing below that would only add empty margins.
  const MIN_ZOOM = 1, MAX_ZOOM = 4;
  zoomInBtn.onclick = () => { materialZoom = Math.min(MAX_ZOOM, materialZoom + 0.25); renderPage(materialCurrentPage); };
  zoomOutBtn.onclick = () => { materialZoom = Math.max(MIN_ZOOM, materialZoom - 0.25); renderPage(materialCurrentPage); };
  // Re-fit on rotate/resize, since "100%" is defined by the viewer's width.
  const onResize = () => renderPage(materialCurrentPage);
  window.addEventListener("resize", onResize);
  materialCleanups.push(() => {
    window.removeEventListener("resize", onResize);
    Object.values(imageUrlCache).forEach((u) => URL.revokeObjectURL(u));
  });

  // Pinch-to-zoom on touch devices.
  let pinchStartDist = 0, pinchStartZoom = materialZoom;
  const touchDist = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  canvasWrap.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) { pinchStartDist = touchDist(e.touches); pinchStartZoom = materialZoom; }
  }, { passive: true });
  canvasWrap.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2 && pinchStartDist) {
      e.preventDefault();
      const scale = touchDist(e.touches) / pinchStartDist;
      materialZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinchStartZoom * scale));
      renderPage(materialCurrentPage);
    }
  }, { passive: false });
  canvasWrap.addEventListener("touchend", (e) => { if (e.touches.length < 2) pinchStartDist = 0; });

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
  runMaterialCleanups();
  if (materialSessionId) {
    saveMaterialProgress();
    updateDoc(doc(db, "materialSessions", materialSessionId), { closedAt: serverTimestamp() }).catch(() => {});
    materialSessionId = null;
  }
}

render();
