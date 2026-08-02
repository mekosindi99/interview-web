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
// didn't create itself) and makes it link-readable. Drive has no per-user
// ACL for files uploaded this way without per-candidate OAuth — an
// accepted trade-off vs. Firebase Storage rules.
async function uploadToDrive({ name, mimeType, buffer }) {
  const res = await drive.files.create({
    requestBody: { name, parents: [DRIVE_FOLDER_ID] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: "id",
  });
  const fileId = res.data.id;
  await drive.permissions.create({ fileId, requestBody: { role: "reader", type: "anyone" } });
  return fileId;
}
const driveDirectUrl = (fileId) => `https://drive.google.com/uc?export=download&id=${fileId}`;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173,https://interview.sonbola.shop")
  .split(",").map((s) => s.trim());

const app = express();
// Render sits behind a reverse proxy — without this, req.ip is the proxy's
// internal address, not the real visitor IP that the "X-Forwarded-For"
// header carries.
app.set("trust proxy", true);
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.get("/", (_req, res) => res.json({ ok: true }));

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

// Records/updates a login-device fingerprint for the signed-in user —
// IP, User-Agent-derived device type/browser, first/last seen, login count.
// Written with the Admin SDK (bypasses Firestore rules entirely), keyed by
// the same client-generated device id already used for the block-list
// feature, under users/{uid}/loginDevices/{deviceId}. The client can't lie
// about its own IP or User-Agent here since both come from the raw HTTP
// request the server itself received, not anything the client claims.
app.post("/log-login", requireSignedIn, async (req, res) => {
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
    console.error("log-login failed", err);
    res.status(500).json({ error: err.message });
  }
});

// Candidate's own speaking-answer recording — flat filename
// speaking__{verifiedUid}__{qid}.webm, made link-readable, URL returned for
// the client to store on the attempt doc.
app.post("/uploads/speaking/:qid", requireSignedIn, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const fileId = await uploadToDrive({
      name: `speaking__${req.uid}__${req.params.qid}.webm`,
      mimeType: req.file.mimetype || "audio/webm", buffer: req.file.buffer,
    });
    res.json({ url: driveDirectUrl(fileId), fileId });
  } catch (err) {
    console.error("speaking upload failed", err);
    res.status(500).json({ error: err.message });
  }
});

// Listening-section prompt audio — admin only.
app.post("/uploads/listening", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const fileId = await uploadToDrive({
      name: `listening__${Date.now()}__${req.file.originalname}`,
      mimeType: req.file.mimetype || "audio/mpeg", buffer: req.file.buffer,
    });
    res.json({ url: driveDirectUrl(fileId), fileId });
  } catch (err) {
    console.error("listening upload failed", err);
    res.status(500).json({ error: err.message });
  }
});

// Training-material PDF — admin only. Returns fileId (not just a URL): the
// client reads it back through GET /material/:fileId below, not Drive's own
// download URL, because pdf.js needs a CORS-enabled response and Drive's
// download endpoint doesn't send those headers.
app.post("/uploads/material", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const fileId = await uploadToDrive({
      name: `material__${req.file.originalname}`,
      mimeType: "application/pdf", buffer: req.file.buffer,
    });
    res.json({ fileId, fileName: req.file.originalname });
  } catch (err) {
    console.error("material upload failed", err);
    res.status(500).json({ error: err.message });
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
app.get("/material/:fileId", requireSignedIn, async (req, res) => {
  try {
    // Fetch the size first so we can set Content-Length — without it,
    // pdf.js (client sends disableRange/disableStream too, belt-and-braces)
    // has nothing to measure a plain proxied stream's progress against and
    // can hang indefinitely instead of erroring.
    const meta = await drive.files.get({ fileId: req.params.fileId, fields: "size" });
    const driveRes = await drive.files.get(
      { fileId: req.params.fileId, alt: "media" },
      { responseType: "stream" }
    );
    res.setHeader("Content-Type", "application/pdf");
    if (meta.data.size) res.setHeader("Content-Length", meta.data.size);
    driveRes.data.pipe(res);
  } catch (err) {
    console.error("material proxy failed", err);
    res.status(500).json({ error: err.message });
  }
});

// Deletes the training-material PDF from Google Drive itself — admin only.
// The client is responsible for also clearing settings/material in
// Firestore right after this succeeds, which is what actually makes it
// disappear for every candidate (they all read that one shared doc).
app.delete("/material/:fileId", requireAdmin, async (req, res) => {
  try {
    await drive.files.delete({ fileId: req.params.fileId });
    res.json({ ok: true });
  } catch (err) {
    console.error("material delete failed", err);
    res.status(500).json({ error: err.message });
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
    res.json({ ok: true });
  } catch (err) {
    console.error("delete-user failed", err);
    res.status(500).json({ error: err.message });
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
    console.error("delete-by-phone failed", err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`interview-admin-server listening on ${port}`));
