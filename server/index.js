// Tiny admin-only backend. Its only job is the one thing the browser SDK
// genuinely cannot do: permanently delete a Firebase Auth account. The main
// site works fully without this server (soft-delete/restore); this just
// upgrades "delete" to a real, permanent delete with no orphaned login left
// behind, for admins who want that instead of hide+restore.
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import multer from "multer";
import { google } from "googleapis";
import { Readable } from "stream";
import sharp from "sharp";
import rateLimit from "express-rate-limit";

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!serviceAccountJson) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT_JSON env var");
  process.exit(1);
}
const serviceAccount = JSON.parse(serviceAccountJson);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
const auth = admin.auth();

// ── Google Drive, via OAuth (NOT the Firebase service account) ──
// Service accounts have no storage quota of their own on a personal Gmail
// account (no Google Workspace shared drives available), so uploads must
// happen as an actual human user instead. One-time setup: the admin visits
// /oauth/start once, authorizes, and the resulting refresh token is saved
// as GOOGLE_OAUTH_REFRESH_TOKEN — after that, all uploads count against the
// admin's own 15GB Drive quota and need no further interaction.
// Scope is deliberately drive.file (not the full drive scope): it only
// grants access to files this app itself creates, which is all we need and
// — unlike full drive access — doesn't require Google's app-verification
// review to use outside "Testing" mode.
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI;
const OAUTH_REFRESH_TOKEN = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
const OAUTH_SETUP_SECRET = process.env.OAUTH_SETUP_SECRET;
if (!DRIVE_FOLDER_ID) console.warn("Missing DRIVE_FOLDER_ID env var — Drive uploads will fail");
if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET || !OAUTH_REDIRECT_URI) {
  console.warn("Missing GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI — Drive OAuth setup unavailable");
}
if (!OAUTH_REFRESH_TOKEN) console.warn("Missing GOOGLE_OAUTH_REFRESH_TOKEN — Drive uploads will fail until /oauth/start is completed");

const oauth2Client = new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI);
if (OAUTH_REFRESH_TOKEN) oauth2Client.setCredentials({ refresh_token: OAUTH_REFRESH_TOKEN });
const drive = google.drive({ version: "v3", auth: oauth2Client });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Uploads a buffer to Drive (flat inside DRIVE_FOLDER_ID — no subfolders,
// since drive.file scope can't reliably list/find existing folders it
// didn't create itself). By default the file is left PRIVATE (readable
// only by the OAuth-owning Drive account) and must be fetched through one
// of this server's own authenticated proxy routes (/material, /material-image,
// /audio) — that's what actually enforces "must be signed in" instead of
// "must have the link". Only pass isPublic:true for content that is not
// personal/sensitive and is fine being reachable by anyone who has the
// direct Drive link (e.g. the listening-section prompt audio, which is the
// same admin-uploaded clip every candidate hears).
async function uploadToDrive({ name, mimeType, buffer, isPublic = false }) {
  const res = await drive.files.create({
    requestBody: { name, parents: [DRIVE_FOLDER_ID] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: "id",
  });
  const fileId = res.data.id;
  if (isPublic) {
    await drive.permissions.create({ fileId, requestBody: { role: "reader", type: "anyone" } });
  }
  return fileId;
}
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173,https://interview.sonbola.shop")
  .split(",").map((s) => s.trim());

const app = express();
// Render sits behind a reverse proxy — without this, req.ip is the proxy's
// internal address, not the real visitor IP that the "X-Forwarded-For"
// header carries.
app.set("trust proxy", true);
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

// Basic per-IP throttling — this server previously had none at all, which
// combined with any IDOR/guessable-id bug (see the /audio fileId fix below)
// meant an attacker could script unlimited attempts with zero friction.
// Generous limits: this is a small interview-exam site, not a public API —
// the goal is to blunt scripted abuse, not to rate-limit real usage.
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const fileProxyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const loginLogLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

app.get("/", (_req, res) => res.json({ ok: true }));

// Google Drive file ids are always URL-safe [A-Za-z0-9_-], typically 28-44
// chars. Route params like :fileId reach the Drive API directly — this
// isn't a defense against SSRF (the Drive SDK isn't a generic URL fetcher),
// but it rejects garbage/oversized input before it's used anywhere, and
// narrows what an IDOR-guessing script could even submit.
function isValidDriveFileId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{10,100}$/.test(id);
}

// Non-admin routes (reachable by ordinary candidates) previously echoed
// err.message straight back to the caller, which can leak internal details
// from the Google API client (folder ids, quota/project info). Admin-only
// routes keep full detail since the caller is already trusted staff.
function sendServerError(res, err, { exposeDetail = false } = {}) {
  console.error(err);
  res.status(500).json({ error: exposeDetail ? err.message : "internal error" });
}

// Rough device-type/browser guess from a User-Agent string — good enough
// for the admin's "which devices did this candidate log in from" view,
// not meant to be a precise UA parser.
function parseUserAgent(ua) {
  const isTablet = /iPad|Tablet/i.test(ua);
  const isMobile = !isTablet && /Mobi|Android|iPhone/i.test(ua);
  const deviceType = isTablet ? "tablet" : isMobile ? "mobile" : "desktop";
  let browser = "Other";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/Chrome\//.test(ua) && !/Chromium\//.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = "Safari";
  return { deviceType, browser };
}

// Verifies the caller is a signed-in admin (checked against Firestore, same
// source of truth the site's own security rules use).
async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "missing token" });
    const decoded = await auth.verifyIdToken(token);
    const snap = await db.collection("users").doc(decoded.uid).get();
    if (!snap.exists || snap.data().role !== "admin") {
      return res.status(403).json({ error: "admin only" });
    }
    req.adminUid = decoded.uid;
    next();
  } catch (err) {
    res.status(401).json({ error: "invalid token" });
  }
}

// Verifies the caller is signed in as ANY role — used for the candidate
// speaking-recording upload (unlike requireAdmin above). The verified uid
// is what the file gets namespaced under, never a client-supplied uid.
async function requireSignedIn(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "missing token" });
    const decoded = await auth.verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch (err) {
    res.status(401).json({ error: "invalid token" });
  }
}

// Lets a signed-in user act on their OWN record (req.params[paramName] ===
// their own uid), or any staff member act on anyone's — used for
// /leaderboard/sync so a candidate can publish their own result the moment
// their exam is fully auto-graded (nothing manual left for an admin to do),
// without opening this up to acting on someone else's uid.
function requireSelfOrAdmin(paramName) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!token) return res.status(401).json({ error: "missing token" });
      const decoded = await auth.verifyIdToken(token);
      if (decoded.uid === req.params[paramName]) return next();
      const snap = await db.collection("users").doc(decoded.uid).get();
      if (snap.exists && (snap.data().role === "admin" || snap.data().role === "coadmin")) return next();
      return res.status(403).json({ error: "forbidden" });
    } catch (err) {
      res.status(401).json({ error: "invalid token" });
    }
  };
}

// Records/updates a login-device fingerprint for the signed-in user —
// IP, User-Agent-derived device type/browser, first/last seen, login count.
// Written with the Admin SDK (bypasses Firestore rules entirely), keyed by
// the same client-generated device id already used for the block-list
// feature, under users/{uid}/loginDevices/{deviceId}. The client can't lie
// about its own IP or User-Agent here since both come from the raw HTTP
// request the server itself received, not anything the client claims.
app.post("/log-login", loginLogLimiter, requireSignedIn, async (req, res) => {
  try {
    const deviceId = String(req.body?.deviceId || "").slice(0, 200);
    if (!deviceId) return res.status(400).json({ error: "missing deviceId" });
    const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    const ua = req.headers["user-agent"] || "";
    const { deviceType, browser } = parseUserAgent(ua);
    const ref = db.collection("users").doc(req.uid).collection("loginDevices").doc(deviceId);
    const snap = await ref.get();
    await ref.set({
      deviceId, ip, userAgent: ua, deviceType, browser,
      lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
      firstSeenAt: snap.exists ? snap.data().firstSeenAt : admin.firestore.FieldValue.serverTimestamp(),
      loginCount: admin.firestore.FieldValue.increment(1),
    }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Masks a phone number to only its last 4 digits for the public
// leaderboard — "07501234567" -> "*******4567". Done here, server-side,
// rather than just in the UI: the leaderboard doc is what a candidate's
// Firestore client can actually read directly, so if the full number were
// stored in it, hiding it in the UI wouldn't really hide it (dev tools/the
// SDK console would still see the raw field). Only the masked string is
// ever written to leaderboard/{uid} — the real number stays only on
// users/{uid}, which staff-only Firestore rules already protect.
function maskPhone(phone) {
  const digits = String(phone || "");
  if (digits.length <= 3) return digits;
  return "*".repeat(digits.length - 3) + digits.slice(-3);
}

const SECTIONS = ["reading", "listening", "speaking", "writing"];
const POINTS_PER_QUESTION = 2;

// Auto-grades a candidate's exam from the real answer key. This is the fix
// for two related bugs: (1) the answer key (questions/{qid}.correctAnswer /
// correctIndex) used to live on the same doc every signed-in candidate can
// read to take the exam at all — anyone could open devtools and read every
// correct answer before or during their own exam. Answers now live in the
// separate questionAnswers/{qid} collection, readable only by staff (see
// firestore.rules), so the browser flow never has access to them. (2) score
// used to be computed in the browser and written straight to attempts/{uid}
// by the candidate's own client — trivial to fake from the console. Grading
// now happens only here, via the Admin SDK, which bypasses firestore.rules;
// those rules in turn block a candidate from ever writing autoScore/score/
// sectionScores/perQuestionCorrect/needsManualGrading/totalPoints on their
// own attempt, so this is the only path that can set them.
// Returns the updated attempt fields, or null if the user/attempt doesn't
// exist. Used both by POST /exam/grade/:uid below (called by the client
// right after submitExam writes the raw answers) and by /leaderboard/sync
// as a fallback if that first call never landed (e.g. the admin server was
// asleep/unreachable at the exact moment the candidate submitted) — without
// that fallback, an attempt with no autoScore yet would look indistinguishable
// from "nothing to grade" and get published with a false zero score.
async function gradeAttempt(uid) {
  const [userSnap, attemptSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("attempts").doc(uid).get(),
  ]);
  if (!userSnap.exists || !attemptSnap.exists) return null;
  const user = userSnap.data();
  const attempt = attemptSnap.data();
  const answers = attempt.answers || {};

  // Same selection the candidate actually took (pinned at exam start — see
  // startBtn.onclick in app.js), falling back to every active question only
  // for the same edge case the client already guarded against (a saved
  // selection whose questions were later deactivated/deleted).
  const selectedIds = Array.isArray(user.examSelectedQuestionIds) ? user.examSelectedQuestionIds : [];
  let questionDocs;
  if (selectedIds.length) {
    const refs = selectedIds.map((id) => db.collection("questions").doc(id));
    questionDocs = (await db.getAll(...refs)).filter((d) => d.exists);
  } else {
    questionDocs = (await db.collection("questions").where("active", "==", true).get()).docs;
  }
  if (!questionDocs.length) return null;

  const answerRefs = questionDocs.map((d) => db.collection("questionAnswers").doc(d.id));
  const answerDocs = await db.getAll(...answerRefs);
  const answerKeyById = {};
  answerDocs.forEach((d) => { if (d.exists) answerKeyById[d.id] = d.data(); });

  let autoScore = 0, totalPoints = 0;
  const sectionScores = {};
  SECTIONS.forEach((s) => { sectionScores[s] = { score: 0, total: 0 }; });
  const perQuestionCorrect = {};
  let needsManualGrading = false;

  questionDocs.forEach((qDoc) => {
    const q = qDoc.data();
    const sec = SECTIONS.includes(q.section) ? q.section : "reading";
    const pts = q.points || POINTS_PER_QUESTION;
    totalPoints += pts;
    sectionScores[sec].total += pts;
    if (q.type === "speaking" || q.type === "writing") {
      needsManualGrading = true;
      return;
    }
    const key = answerKeyById[qDoc.id] || {};
    const correct = q.type === "truefalse" ? key.correctAnswer : key.correctIndex;
    const given = answers[qDoc.id];
    const isCorrect = given !== undefined && given === correct;
    perQuestionCorrect[qDoc.id] = isCorrect;
    if (isCorrect) { autoScore += pts; sectionScores[sec].score += pts; }
  });

  const update = {
    autoScore, totalPoints, sectionScores, perQuestionCorrect, needsManualGrading,
    score: autoScore + (attempt.manualScore || 0),
  };
  await db.collection("attempts").doc(uid).update(update);
  return { ...attempt, ...update };
}

app.post("/exam/grade/:uid", requireSelfOrAdmin("uid"), async (req, res) => {
  try {
    const graded = await gradeAttempt(req.params.uid);
    if (!graded) return res.status(404).json({ error: "not found" });
    const { autoScore, totalPoints, sectionScores, needsManualGrading } = graded;
    res.json({ ok: true, autoScore, totalPoints, sectionScores, needsManualGrading });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Publishes (or removes) one candidate's public leaderboard entry — called
// right after the admin saves manual grading, OR by a candidate for their
// OWN uid right after submitting an exam that had no speaking/writing
// questions (nothing left for anyone to manually grade). Written via the
// Admin SDK (bypasses Firestore rules) specifically so the
// leaderboard/{uid} collection can stay client-write-disabled in
// firestore.rules — a candidate could otherwise just write themselves a
// fake #1 score directly. The score/section breakdown is read fresh from
// attempts/{uid} here, never trusted from the request body, so there's
// nothing for the client to lie about even indirectly.
app.post("/leaderboard/sync/:uid", requireSelfOrAdmin("uid"), async (req, res) => {
  try {
    const { uid } = req.params;
    const [userSnap, attemptSnap] = await Promise.all([
      db.collection("users").doc(uid).get(),
      db.collection("attempts").doc(uid).get(),
    ]);
    if (!userSnap.exists || !attemptSnap.exists) return res.status(404).json({ error: "not found" });
    // A candidate the admin moved to the trash (soft delete) keeps their
    // profile and attempt so they can be restored, but must not stay on the
    // public board in the meantime — pull any existing entry instead.
    if (userSnap.data().deleted) {
      await db.collection("leaderboard").doc(uid).delete().catch(() => {});
      return res.json({ ok: true, published: false, reason: "deleted" });
    }
    let attempt = attemptSnap.data();
    // Auto-grading normally already ran (POST /exam/grade/:uid, called by
    // the client right after submit) by the time anything calls sync — but
    // if that call never landed (e.g. the admin server was briefly asleep
    // right when the candidate submitted), autoScore/needsManualGrading
    // would still be completely unset here, which is indistinguishable from
    // "nothing to grade" below and would publish a false zero score. Grade
    // it now instead, same as if the client's own call had succeeded.
    if (attempt.autoScore === undefined && attempt.examStatus !== "graded") {
      const graded = await gradeAttempt(uid).catch(() => null);
      if (graded) attempt = graded;
    }
    // Self-heals a now-fixed bug where an exam with no manual questions
    // could get stuck at examStatus "submitted" forever (there was no
    // grading form for an admin to ever save, so nothing could move it to
    // "graded") — if there's truly nothing left to grade, treat it as
    // graded here rather than leaving an already-finished result stuck off
    // the board.
    if (attempt.examStatus !== "graded" && !attempt.needsManualGrading) {
      await db.collection("attempts").doc(uid).update({ examStatus: "graded" });
      attempt = { ...attempt, examStatus: "graded" };
    }
    // Mirrors "graded" onto the candidate's own profile doc too — the
    // client's admin candidate list (and its WhatsApp-send button) reads
    // users/{uid}.examStatus, not attempts/{uid}.examStatus, and this is
    // the only path (bulk publish, or a reading-only exam's first sync)
    // that promotes a manual-grading-free exam to graded at all.
    if (attempt.examStatus === "graded" && userSnap.data().examStatus !== "graded") {
      await db.collection("users").doc(uid).update({ examStatus: "graded" }).catch(() => {});
    }
    if (attempt.examStatus !== "graded") {
      // Genuinely still pending manual grading — make sure any previous
      // entry is gone instead of leaving a stale score on the board.
      await db.collection("leaderboard").doc(uid).delete().catch(() => {});
      return res.json({ ok: true, published: false });
    }
    await db.collection("leaderboard").doc(uid).set({
      name: userSnap.data().name || "",
      phoneMasked: maskPhone(userSnap.data().phone),
      sectionScores: attempt.sectionScores || {},
      score: attempt.score ?? 0,
      // How long the candidate took to finish, in seconds — the tie-break
      // when two candidates land on the same score (faster finish ranks
      // higher). Recorded by the client at submit time (submitExam in
      // app.js), null if it somehow wasn't captured.
      durationSec: attempt.durationSec ?? null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true, published: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Removes one candidate's board entry outright — used when an admin resets
// their exam ("امتحان جديد"). /leaderboard/sync/:uid can't do this job: it
// republishes by reading attempts/{uid}, but performExamReset (app.js)
// deletes that very doc as part of the reset, so calling sync afterward
// 404s instead of clearing the stale entry. leaderboard/{uid} is
// client-write-disabled (see firestore.rules), so this has to go through
// the server the same as every other write to that collection.
app.delete("/leaderboard/:uid", requireAdmin, async (req, res) => {
  try {
    await db.collection("leaderboard").doc(req.params.uid).delete();
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

// Drops every board entry whose candidate is gone (profile permanently
// deleted) or in the trash (deleted: true).
//
// The per-candidate sync above can only ever be called for a candidate the
// admin UI still lists, so a permanently deleted one was unreachable by
// design: their profile is gone, they're absent from the candidates list, and
// nothing was left anywhere in the app that could take their name and score
// off the public board. This walks the board itself instead of the candidate
// list, which is the only direction that can see those orphans.
app.post("/leaderboard/prune", requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection("leaderboard").get();
    const removed = [];
    for (const entryDoc of snap.docs) {
      const userSnap = await db.collection("users").doc(entryDoc.id).get();
      if (userSnap.exists && !userSnap.data().deleted) continue;
      await entryDoc.ref.delete();
      removed.push(entryDoc.id);
    }
    res.json({ ok: true, removed: removed.length, scanned: snap.size });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

// Candidate's own speaking-answer recording — flat filename
// speaking__{verifiedUid}__{qid}.webm, made link-readable, URL returned for
// the client to store on the attempt doc.
// Candidate's own voice — the most sensitive file this app ever stores, so
// it stays PRIVATE on Drive; playback only ever goes through the
// authenticated GET /audio/:fileId proxy below, never a public Drive link.
app.post("/uploads/speaking/:qid", uploadLimiter, requireSignedIn, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const fileId = await uploadToDrive({
      name: `speaking__${req.uid}__${req.params.qid}.webm`,
      mimeType: req.file.mimetype || "audio/webm", buffer: req.file.buffer,
    });
    res.json({ fileId });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Candidate's own CV/resume, uploaded as part of the mandatory profile
// intake form (age/education/marital status/tribe/work history/CV — see
// app.js's renderProfileIntakeForm). Private on Drive like the speaking
// recordings; only reachable through GET /cv/:fileId below.
app.post("/uploads/cv", uploadLimiter, requireSignedIn, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const fileId = await uploadToDrive({
      name: `cv__${req.uid}__${Date.now()}__${req.file.originalname}`,
      mimeType: req.file.mimetype || "application/pdf", buffer: req.file.buffer,
    });
    res.json({ fileId });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Listening-section prompt audio — admin only. Used to be uploaded
// isPublic:true with the client playing a raw Drive "uc?export=download"
// link straight in an <audio src>, the same shape as the old material-PDF
// link. Same failure mode as that one: that URL doesn't reliably serve raw
// audio bytes — it can hand back an HTML interstitial instead, which an
// <audio> tag can't parse, so playback silently showed 0:00/0:00 and never
// started. Now private on Drive, streamed only through the authenticated
// GET /audio/:fileId proxy below (same one speaking-answer playback already
// uses), which fetches the real bytes server-side and sets the correct
// Content-Type — reliable regardless of what Drive's direct-link endpoint
// does on a given request.
app.post("/uploads/listening", uploadLimiter, requireAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const fileId = await uploadToDrive({
      name: `listening__${Date.now()}__${req.file.originalname}`,
      mimeType: req.file.mimetype || "audio/mpeg", buffer: req.file.buffer,
    });
    res.json({ fileId });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

// Training-material PDF — admin only. Kept private on Drive; the client
// reads it back through GET /material/:fileId below (both because pdf.js
// needs a CORS-enabled response Drive's own download URL doesn't send, and
// so an un-watermarked copy is never reachable without being signed in).
app.post("/uploads/material", uploadLimiter, requireAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const fileId = await uploadToDrive({
      name: `material__${req.file.originalname}`,
      mimeType: "application/pdf", buffer: req.file.buffer,
    });
    res.json({ fileId, fileName: req.file.originalname });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

// Training-material pages as images — alternative to the PDF (some PDFs
// have embedded fonts pdf.js can't substitute for and render garbled; a
// straight image renders pixel-perfect regardless). Page ORDER is entirely
// determined by req.files' array order, which multer preserves from the
// order the client appended them to the FormData — the client is
// responsible for sorting before upload, this just doesn't re-shuffle it.
app.post("/uploads/material-images", uploadLimiter, requireAdmin, upload.array("files", 200), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: "no files" });
    const results = await Promise.all(req.files.map(async (file, i) => {
      // Phone-camera/scanner pages routinely come in at 3000-4000px wide and
      // several MB each — that raw size, not the network hop itself, was the
      // actual reason the viewer felt slow to open. Re-encoding down to a
      // width that's already more than any screen needs (a phone at 3x
      // pixel density showing it full-width is still under 1300px of real
      // pixels) cuts most files to a fraction of their original size with no
      // visible quality loss when read on-screen, and every future open of
      // this page benefits, not just this one.
      const resized = await sharp(file.buffer)
        .rotate() // apply the file's own EXIF orientation, then drop it, so it can't be re-applied twice
        .resize({ width: 1600, withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      const fileId = await uploadToDrive({
        name: `material-page__${String(i + 1).padStart(3, "0")}__${file.originalname}`,
        mimeType: "image/jpeg", buffer: resized,
      });
      return { fileId };
    }));
    res.json({ images: results });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

// Every delete in this file now only ever TRASHES (never a hard
// drive.files.delete) — trashed files stay recoverable in the OAuth
// account's Drive trash for ~30 days before Google auto-purges them, giving
// a real window to undo a mistake (like a purge tool wrongly targeting a
// file that was still in use). This deliberately trades a little unused
// storage for never having an admin-facing delete be instantly
// unrecoverable. Previously this attempted a hard delete first and any
// failure was swallowed with .catch(() => {}), which is how a past bug left
// files behind with no error AND no way to find them again — trashing
// can't have that failure mode, since a file already in the trash target
// state is not an error.
async function deleteOrTrashFile(fileId) {
  try {
    await drive.files.update({ fileId, requestBody: { trashed: true } });
    return "trashed";
  } catch (err) {
    return "failed";
  }
}

// Deletes a batch of material-page images from Drive (admin only) — used
// when the admin replaces or clears the image set.
app.delete("/material-images", requireAdmin, async (req, res) => {
  try {
    const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];
    const results = await Promise.all(fileIds.map((id) => deleteOrTrashFile(id)));
    const failed = fileIds.filter((_, i) => results[i] === "failed");
    res.json({ ok: true, deleted: results.filter((r) => r === "deleted").length, trashed: results.filter((r) => r === "trashed").length, failed });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

// ── One-time OAuth bootstrap (see server/README.md) ──
// Gated by a shared secret query param instead of a Firebase admin token
// because this is a full-page browser redirect flow (Google's consent
// screen), not a fetch() call that can carry an Authorization header.
app.get("/oauth/start", (req, res) => {
  if (!OAUTH_SETUP_SECRET || req.query.key !== OAUTH_SETUP_SECRET) {
    return res.status(403).send("Forbidden — missing/wrong ?key=");
  }
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces a refresh_token even on repeat authorizations
    scope: ["https://www.googleapis.com/auth/drive.file"],
  });
  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    if (!tokens.refresh_token) {
      return res.status(200).send(
        "No refresh_token returned (already authorized before?). Revoke access at " +
        "https://myaccount.google.com/permissions and try /oauth/start again."
      );
    }
    res.status(200).send(
      "<pre>Copy this into the GOOGLE_OAUTH_REFRESH_TOKEN Render env var, then redeploy:\n\n" +
      tokens.refresh_token + "</pre>"
    );
  } catch (err) {
    res.status(500).send("OAuth callback failed: " + err.message);
  }
});

// Proxies a Drive file's bytes through our own CORS-enabled response — pdf.js
// reads this via fetch/XHR, which Drive's own download URL doesn't support
// (no Access-Control-Allow-Origin header). Open to any signed-in user
// (matches the "read: if isSignedIn()" rule on settings/material in
// firestore.rules) — the material is meant to be readable by every candidate.
// requireSignedIn (not open) — without this, anyone who learns/guesses the
// fileId could fetch the raw, un-watermarked PDF directly by URL, bypassing
// the app (and the watermark, which is only ever drawn client-side onto
// the canvas, never baked into the file itself).
app.get("/material/:fileId", fileProxyLimiter, requireSignedIn, async (req, res) => {
  try {
    if (!isValidDriveFileId(req.params.fileId)) return res.status(400).json({ error: "invalid file id" });
    // Size + the actual media stream are independent Drive API calls — they
    // were awaited one after another, so every request paid for both round
    // trips back-to-back. Firing them together roughly halves this route's
    // own latency on top of Drive's.
    const [meta, driveRes] = await Promise.all([
      drive.files.get({ fileId: req.params.fileId, fields: "size" }),
      drive.files.get({ fileId: req.params.fileId, alt: "media" }, { responseType: "stream" }),
    ]);
    res.setHeader("Content-Type", "application/pdf");
    if (meta.data.size) res.setHeader("Content-Length", meta.data.size);
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    driveRes.data.pipe(res);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Small in-memory cache for material-page images: once any signed-in user
// has fetched a given page, every subsequent request for it (a different
// candidate, or the same one reopening later) is served straight from RAM
// instead of round-tripping to Drive again — Drive's own per-request
// latency, not just the extra hop through this server, was a real part of
// "everything about opening material feels slow". Bounded by byte budget,
// not entry count, since pages vary in size after compression; oldest
// entries are evicted first once the budget is exceeded. Lives only for
// this server process's uptime (cleared on every redeploy/restart) — never
// a substitute for Drive being the actual source of truth.
const imageCache = new Map(); // fileId -> Buffer
let imageCacheBytes = 0;
const IMAGE_CACHE_BUDGET = 80 * 1024 * 1024; // 80MB — comfortable on Render's free-tier RAM
function cacheImage(fileId, buffer) {
  imageCache.set(fileId, buffer);
  imageCacheBytes += buffer.length;
  while (imageCacheBytes > IMAGE_CACHE_BUDGET && imageCache.size > 1) {
    const oldestKey = imageCache.keys().next().value;
    imageCacheBytes -= imageCache.get(oldestKey).length;
    imageCache.delete(oldestKey);
  }
}

// Same idea as the PDF proxy above, for a single material-page image —
// authenticated (not a public Drive URL) so images stay behind a login,
// same as the PDF and everything else here.
app.get("/material-image/:fileId", fileProxyLimiter, requireSignedIn, async (req, res) => {
  try {
    if (!isValidDriveFileId(req.params.fileId)) return res.status(400).json({ error: "invalid file id" });
    const cached = imageCache.get(req.params.fileId);
    if (cached) {
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      return res.end(cached);
    }
    // No metadata pre-fetch here (unlike the PDF proxy above) — every page
    // image is re-encoded to JPEG at upload time (see /uploads/material-images),
    // so the type is already known and this saves a whole extra Drive API
    // round-trip per page, on top of the smaller file itself.
    const driveRes = await drive.files.get(
      { fileId: req.params.fileId, alt: "media" },
      { responseType: "stream" }
    );
    const chunks = [];
    driveRes.data.on("data", (c) => chunks.push(c));
    driveRes.data.on("end", () => cacheImage(req.params.fileId, Buffer.concat(chunks)));
    res.setHeader("Content-Type", "image/jpeg");
    // The image behind a given fileId never changes (replacing a page
    // uploads a new fileId instead) — safe for the browser to cache it
    // indefinitely instead of re-fetching through this proxy every time the
    // material is reopened. "private" since it's behind auth, not meant to
    // sit in a shared/CDN cache.
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    driveRes.data.pipe(res);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Streams a candidate's private speaking recording — signed-in only (staff
// grading it, or the candidate reviewing their own before submit). Same
// pattern as the material proxies above: the file itself is never public on
// Drive, only reachable through here.
//
// FIX: this used to only check requireSignedIn (any authenticated account),
// with no check that the recording actually belonged to the caller — the
// same class of bug /cv/:fileId below was explicitly patched for. Any
// signed-in candidate who obtained/guessed another candidate's fileId could
// listen to their private recording. Speaking recordings are named
// speaking__{uid}__{qid}.webm (see /uploads/speaking/:qid above), which is
// the only record of who a given fileId belongs to — ownership is checked
// by parsing that back out of the Drive filename, same idea as the
// profileExtra.cvFileId lookup /cv/:fileId uses. Fails closed: a name that
// doesn't match the expected pattern denies non-staff instead of guessing.
app.get("/audio/:fileId", fileProxyLimiter, requireSignedIn, async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!isValidDriveFileId(fileId)) return res.status(400).json({ error: "invalid file id" });
    const meta = await drive.files.get({ fileId, fields: "size,mimeType,name" });
    const parts = (meta.data.name || "").split("__");
    const ownerUid = parts[0] === "speaking" && parts.length >= 3 ? parts[1] : null;
    if (!ownerUid) return res.status(403).json({ error: "forbidden" });
    if (ownerUid !== req.uid) {
      const callerSnap = await db.collection("users").doc(req.uid).get();
      const isStaff = callerSnap.exists && ["admin", "coadmin"].includes(callerSnap.data().role);
      if (!isStaff) return res.status(403).json({ error: "forbidden" });
    }
    const driveRes = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );
    res.setHeader("Content-Type", meta.data.mimeType || "audio/webm");
    if (meta.data.size) res.setHeader("Content-Length", meta.data.size);
    driveRes.data.pipe(res);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Streams a candidate's private CV — staff reviewing it, or the candidate
// re-opening the profile form to see what they already uploaded — and
// nobody else. requireSignedIn alone only proves the caller has SOME
// account; it doesn't prove this is THEIR cv. cvFileId lives in exactly one
// place, users/{uid}.profileExtra.cvFileId, so ownership is a single
// equality query: without it, any signed-in candidate who obtained another
// candidate's fileId (Drive's own file id, not derived from anything a
// client is expected to guess, but still not a real access control) could
// read their private CV straight from this route.
app.get("/cv/:fileId", fileProxyLimiter, requireSignedIn, async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!isValidDriveFileId(fileId)) return res.status(400).json({ error: "invalid file id" });
    const callerSnap = await db.collection("users").doc(req.uid).get();
    const isStaff = callerSnap.exists && ["admin", "coadmin"].includes(callerSnap.data().role);
    if (!isStaff) {
      const ownerQuery = await db.collection("users")
        .where("profileExtra.cvFileId", "==", fileId).limit(1).get();
      const isOwner = !ownerQuery.empty && ownerQuery.docs[0].id === req.uid;
      if (!isOwner) return res.status(403).json({ error: "forbidden" });
    }
    const meta = await drive.files.get({ fileId, fields: "size,mimeType" });
    const driveRes = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );
    res.setHeader("Content-Type", meta.data.mimeType || "application/pdf");
    if (meta.data.size) res.setHeader("Content-Length", meta.data.size);
    driveRes.data.pipe(res);
  } catch (err) {
    sendServerError(res, err);
  }
});

// One-time cleanup: earlier versions of this server made every upload
// publicly link-readable on Drive ("anyone with the link"). This revokes
// that public grant from anything already uploaded that should never have
// been public — speaking recordings and training material — so they can
// only be reached through the authenticated proxies above from now on.
// Safe to call more than once; listening-prompt audio (deliberately public,
// see /uploads/listening) is left untouched.
app.post("/drive/revoke-public", requireAdmin, async (req, res) => {
  try {
    let folderFixed = false;
    // The real source of the exposure is usually the parent folder itself
    // being link-shared (e.g. from setting it up in the Drive UI) — every
    // file placed inside it then inherits that, and Drive refuses to delete
    // an *inherited* permission at the individual-file level ("the
    // authenticated user cannot delete the permission... limited access
    // must be leveraged"). Fixing it on the folder fixes every file inside
    // it in one shot, and lets the per-file pass below actually succeed for
    // any permissions that genuinely were set directly on a file.
    const folderPerms = await drive.permissions.list({ fileId: DRIVE_FOLDER_ID, fields: "permissions(id,type)" });
    const folderAnyone = (folderPerms.data.permissions || []).find((p) => p.type === "anyone");
    if (folderAnyone) {
      await drive.permissions.delete({ fileId: DRIVE_FOLDER_ID, permissionId: folderAnyone.id });
      folderFixed = true;
    }

    let pageToken;
    let checked = 0, revoked = 0, skipped = 0;
    do {
      const list = await drive.files.list({
        q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name)",
        pageToken,
      });
      for (const file of list.data.files || []) {
        if (!/^(speaking__|material__|material-page__)/.test(file.name)) continue;
        checked++;
        const perms = await drive.permissions.list({ fileId: file.id, fields: "permissions(id,type)" });
        const anyone = (perms.data.permissions || []).find((p) => p.type === "anyone");
        if (anyone) {
          try {
            await drive.permissions.delete({ fileId: file.id, permissionId: anyone.id });
            revoked++;
          } catch (err) {
            // Already handled via the folder-level fix above (inherited
            // permission, can't be deleted per-file) — not a real failure.
            skipped++;
          }
        }
      }
      pageToken = list.data.nextPageToken;
    } while (pageToken);
    res.json({ ok: true, folderFixed, checked, revoked, skipped });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

// Deletes the training-material PDF from Google Drive itself — admin only.
// The client is responsible for also clearing settings/material in
// Firestore right after this succeeds, which is what actually makes it
// disappear for every candidate (they all read that one shared doc).
app.delete("/material/:fileId", requireAdmin, async (req, res) => {
  try {
    const result = await deleteOrTrashFile(req.params.fileId);
    res.json({ ok: result !== "failed", result });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

// Finds every material-page/material file in the Drive folder that the live
// settings/material doc in Firestore no longer references. Two-step by
// design after an earlier version of this deleted a file that turned out to
// still be in use: without ?apply=true this only LISTS candidates (nothing
// touched), so the admin can see exactly what's about to be removed before
// committing to it. A grace period also skips anything created in the last
// hour, in case Firestore's write and this listing land close enough
// together to disagree about what's "current".
async function findOrphanMaterialFiles() {
  const materialSnap = await db.collection("settings").doc("material").get();
  const material = materialSnap.exists ? materialSnap.data() : {};
  const keepIds = new Set([
    material.fileId,
    ...((material.images || []).map((im) => im.fileId)),
  ].filter(Boolean));

  const graceMs = 60 * 60 * 1000;
  const orphans = [];
  let pageToken;
  do {
    const list = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, createdTime)",
      pageToken,
    });
    for (const file of list.data.files || []) {
      if (!/^(material__|material-page__)/.test(file.name)) continue;
      if (keepIds.has(file.id)) continue;
      if (file.createdTime && Date.now() - new Date(file.createdTime).getTime() < graceMs) continue;
      orphans.push({ id: file.id, name: file.name });
    }
    pageToken = list.data.nextPageToken;
  } while (pageToken);
  return orphans;
}

app.post("/drive/purge-orphans", requireAdmin, async (req, res) => {
  try {
    const orphans = await findOrphanMaterialFiles();
    if (req.query.apply !== "true") {
      // Dry run: report what would be removed, touch nothing.
      return res.json({ ok: true, applied: false, checked: orphans.length, files: orphans });
    }
    let trashed = 0, failed = 0;
    for (const file of orphans) {
      const result = await deleteOrTrashFile(file.id);
      if (result === "trashed") trashed++; else failed++;
    }
    res.json({ ok: true, applied: true, checked: orphans.length, trashed, failed });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

// Undoes a trash — for recovering a file that a delete/purge above was
// wrong to touch. Only works while Drive still has it in the trash (Google
// auto-empties trash after ~30 days); files.delete elsewhere in this file
// no longer performs a hard delete for exactly this reason.
app.post("/drive/restore/:fileId", requireAdmin, async (req, res) => {
  try {
    await drive.files.update({ fileId: req.params.fileId, requestBody: { trashed: false } });
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

// Permanently deletes a candidate/co-admin: their Auth login (freeing the
// phone number/email for reuse) plus their Firestore profile and any exam
// attempt record. Never lets an admin delete themselves or another admin.
app.delete("/users/:uid", requireAdmin, async (req, res) => {
  const { uid } = req.params;
  try {
    const targetSnap = await db.collection("users").doc(uid).get();
    if (!targetSnap.exists) return res.status(404).json({ error: "not found" });
    if (targetSnap.data().role === "admin") {
      return res.status(400).json({ error: "cannot delete an admin account" });
    }
    await auth.deleteUser(uid).catch((err) => {
      // Already gone from Auth (e.g. deleted manually before) — fine,
      // still clean up Firestore below.
      if (err.code !== "auth/user-not-found") throw err;
    });
    await db.collection("users").doc(uid).delete();
    await db.collection("attempts").doc(uid).delete().catch(() => {});
    // The public results board is a separate collection keyed by uid, so it
    // doesn't follow the profile/attempt into the grave on its own — without
    // this, a permanently deleted candidate kept sitting on the board with
    // their name and score, and nothing left in the UI to remove them with.
    await db.collection("leaderboard").doc(uid).delete().catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

// Cleanup escape hatch: deletes an Auth login by phone number even if its
// Firestore profile is already gone (e.g. deleted by an older buggy client
// flow before this server existed). Not used by the main site UI — for
// manual cleanup only.
app.delete("/by-phone/:phone", requireAdmin, async (req, res) => {
  const email = `${req.params.phone}@phone.interview.local`;
  try {
    let uid;
    try {
      uid = (await auth.getUserByEmail(email)).uid;
    } catch (err) {
      if (err.code === "auth/user-not-found") return res.status(404).json({ error: "no auth account for this phone" });
      throw err;
    }
    await auth.deleteUser(uid);
    await db.collection("users").doc(uid).delete().catch(() => {});
    await db.collection("attempts").doc(uid).delete().catch(() => {});
    res.json({ ok: true, uid });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

// ── Automatic Firestore backups ──
// The Spark (free) plan this project runs on has no Cloud Functions, so
// there's no free way to back up "on every write" in real time (that needs
// a Blaze billing account for onWrite triggers). This is the free-tier
// equivalent: a full export of every collection, run on a timer plus a
// manual "نسخة الآن" button, written as one JSON file to the same private
// Drive folder everything else already uses — restorable from the admin
// panel, or by downloading the file and keeping a copy yourself. Exists
// because a full Firestore wipe (accidental, from the console) has no other
// undo — Firestore itself has no trash/undo for deleted documents.
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h
const BACKUP_KEEP = 20; // older backups beyond this are trashed (still recoverable via Drive trash for ~30 days)
const BACKUP_COLLECTIONS = ["users", "attempts", "questions", "questionAnswers", "settings", "leaderboard", "blockedDevices", "meta"];

// Firestore Timestamp fields don't survive JSON.stringify — converted to a
// plain {__ts: epochMillis} marker here and back on restore.
function tsToPlain(v) {
  if (v && typeof v.toDate === "function") return { __ts: v.toDate().getTime() };
  if (Array.isArray(v)) return v.map(tsToPlain);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = tsToPlain(v[k]);
    return out;
  }
  return v;
}
function plainToTs(v) {
  if (v && typeof v === "object" && !Array.isArray(v) && "__ts" in v && Object.keys(v).length === 1) {
    return admin.firestore.Timestamp.fromMillis(v.__ts);
  }
  if (Array.isArray(v)) return v.map(plainToTs);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = plainToTs(v[k]);
    return out;
  }
  return v;
}

// users/{uid}/pastAttempts/{id} and users/{uid}/loginDevices/{id} are the
// only subcollections in firestore.rules — everything else lives at the top
// level, so those two collectionGroup scans plus BACKUP_COLLECTIONS above
// cover the entire database.
async function collectBackup() {
  const data = { exportedAt: new Date().toISOString(), collections: {}, subcollections: { pastAttempts: {}, loginDevices: {} } };
  for (const name of BACKUP_COLLECTIONS) {
    const snap = await db.collection(name).get();
    const obj = {};
    snap.forEach((d) => { obj[d.id] = tsToPlain(d.data()); });
    data.collections[name] = obj;
  }
  const pastSnap = await db.collectionGroup("pastAttempts").get();
  pastSnap.forEach((d) => {
    const uid = d.ref.parent.parent.id;
    data.subcollections.pastAttempts[`${uid}/${d.id}`] = tsToPlain(d.data());
  });
  const loginSnap = await db.collectionGroup("loginDevices").get();
  loginSnap.forEach((d) => {
    const uid = d.ref.parent.parent.id;
    data.subcollections.loginDevices[`${uid}/${d.id}`] = tsToPlain(d.data());
  });
  return data;
}

// Writes every document back exactly as it was exported (set, not merge —
// a restored doc should match the backup exactly, not blend with whatever's
// currently there). Doesn't delete anything not in the backup: the only
// real-world use of this is restoring after data got wiped/lost, where the
// live database is already empty or missing pieces, not pruning it further.
async function restoreBackup(data) {
  const BATCH_LIMIT = 400;
  let batch = db.batch();
  let ops = 0;
  async function stage(ref, docData) {
    batch.set(ref, plainToTs(docData));
    ops++;
    if (ops >= BATCH_LIMIT) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
  for (const name of Object.keys(data.collections || {})) {
    for (const [id, docData] of Object.entries(data.collections[name])) {
      await stage(db.collection(name).doc(id), docData);
    }
  }
  for (const [key, docData] of Object.entries(data.subcollections?.pastAttempts || {})) {
    const [uid, id] = key.split("/");
    await stage(db.collection("users").doc(uid).collection("pastAttempts").doc(id), docData);
  }
  for (const [key, docData] of Object.entries(data.subcollections?.loginDevices || {})) {
    const [uid, id] = key.split("/");
    await stage(db.collection("users").doc(uid).collection("loginDevices").doc(id), docData);
  }
  if (ops > 0) await batch.commit();
}

async function pruneOldBackups() {
  const list = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false and name contains 'backup__'`,
    fields: "files(id,name,createdTime)",
    orderBy: "createdTime desc",
    pageSize: 200,
  });
  const files = list.data.files || [];
  for (const f of files.slice(BACKUP_KEEP)) await deleteOrTrashFile(f.id);
}

async function runBackup() {
  const data = await collectBackup();
  const buffer = Buffer.from(JSON.stringify(data));
  const name = `backup__${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const fileId = await uploadToDrive({ name, mimeType: "application/json", buffer });
  await pruneOldBackups().catch((err) => console.error("prune backups failed", err));
  return { fileId, name };
}

app.post("/backup/run", uploadLimiter, requireAdmin, async (req, res) => {
  try {
    const result = await runBackup();
    res.json({ ok: true, ...result });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

app.get("/backup/list", fileProxyLimiter, requireAdmin, async (req, res) => {
  try {
    const list = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false and name contains 'backup__'`,
      fields: "files(id,name,createdTime,size)",
      orderBy: "createdTime desc",
      pageSize: BACKUP_KEEP,
    });
    res.json({ ok: true, files: list.data.files || [] });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

app.get("/backup/download/:fileId", fileProxyLimiter, requireAdmin, async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!isValidDriveFileId(fileId)) return res.status(400).json({ error: "invalid file id" });
    const driveRes = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", "attachment; filename=\"backup.json\"");
    driveRes.data.pipe(res);
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

// Deletes one backup from Drive (trash, not a hard delete — same
// deleteOrTrashFile every other delete route here uses, recoverable for
// ~30 days from Drive's own trash). Kept in sync with Drive by design: the
// list this button lives next to (/backup/list) reads straight from Drive
// itself, not a separate index, so there's nothing else that could drift.
app.delete("/backup/:fileId", requireAdmin, async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!isValidDriveFileId(fileId)) return res.status(400).json({ error: "invalid file id" });
    const result = await deleteOrTrashFile(fileId);
    res.json({ ok: result !== "failed", result });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

// Restores from a backup already sitting in Drive (one from the /backup/list
// history). Deliberately admin-only and requires no request body beyond the
// fileId — the confirmation UI lives entirely client-side (renderBackupTab).
app.post("/backup/restore/:fileId", uploadLimiter, requireAdmin, async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!isValidDriveFileId(fileId)) return res.status(400).json({ error: "invalid file id" });
    const driveRes = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
    const chunks = [];
    await new Promise((resolve, reject) => {
      driveRes.data.on("data", (c) => chunks.push(c));
      driveRes.data.on("end", resolve);
      driveRes.data.on("error", reject);
    });
    await restoreBackup(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

// Restores from a backup file uploaded straight from the admin's own
// computer — covers the case where Drive itself is unavailable/emptied but
// the admin kept a downloaded copy (the whole point of the download button
// in the same panel).
app.post("/backup/restore-upload", uploadLimiter, requireAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    await restoreBackup(JSON.parse(req.file.buffer.toString("utf8")));
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, err, { exposeDetail: true });
  }
});

if (DRIVE_FOLDER_ID) {
  setInterval(() => { runBackup().catch((err) => console.error("scheduled backup failed", err)); }, BACKUP_INTERVAL_MS);
  // Also once shortly after startup/deploy, so a fresh instance doesn't sit
  // for a full interval with zero backups yet.
  setTimeout(() => { runBackup().catch((err) => console.error("startup backup failed", err)); }, 60 * 1000);
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`interview-admin-server listening on ${port}`));

// Render's free tier spins the whole instance down after ~15 minutes with
// no inbound traffic, and the next real request then eats a ~50s cold
// start — exactly the kind of "slow" a candidate can't tell apart from
// Drive itself being slow. Not a perfect fix (a self-ping only counts as
// activity while the process is already running — it can't wake something
// already asleep, and Render may still recycle it for unrelated reasons),
// but free and meaningfully reduces how often that 50s hit happens.
// RENDER_EXTERNAL_URL is set automatically by Render on every web service;
// this is a no-op with nothing to ping when run anywhere else (e.g. local dev).
const selfUrl = process.env.RENDER_EXTERNAL_URL;
if (selfUrl) {
  setInterval(() => {
    fetch(selfUrl).catch(() => {});
  }, 10 * 60 * 1000);
}
