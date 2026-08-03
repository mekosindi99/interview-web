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
  if (digits.length <= 4) return digits;
  return "*".repeat(digits.length - 4) + digits.slice(-4);
}

// Publishes (or removes) one candidate's public leaderboard entry —
// admin-only, called right after the admin saves manual grading. Written
// via the Admin SDK (bypasses Firestore rules) specifically so the
// leaderboard/{uid} collection can stay client-write-disabled in
// firestore.rules — a candidate could otherwise just write themselves a
// fake #1 score directly. The score/section breakdown is read fresh from
// attempts/{uid} here, never trusted from the request body, so there's
// nothing for the client to lie about even indirectly.
app.post("/leaderboard/sync/:uid", requireAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const [userSnap, attemptSnap] = await Promise.all([
      db.collection("users").doc(uid).get(),
      db.collection("attempts").doc(uid).get(),
    ]);
    if (!userSnap.exists || !attemptSnap.exists) return res.status(404).json({ error: "not found" });
    const attempt = attemptSnap.data();
    if (attempt.examStatus !== "graded") {
      // Not (or no longer) graded — make sure any previous entry is gone
      // instead of leaving a stale score on the board.
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
    console.error("leaderboard sync failed", err);
    res.status(500).json({ error: err.message });
  }
});

// Candidate's own speaking-answer recording — flat filename
// speaking__{verifiedUid}__{qid}.webm, made link-readable, URL returned for
// the client to store on the attempt doc.
// Candidate's own voice — the most sensitive file this app ever stores, so
// it stays PRIVATE on Drive; playback only ever goes through the
// authenticated GET /audio/:fileId proxy below, never a public Drive link.
app.post("/uploads/speaking/:qid", requireSignedIn, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const fileId = await uploadToDrive({
      name: `speaking__${req.uid}__${req.params.qid}.webm`,
      mimeType: req.file.mimetype || "audio/webm", buffer: req.file.buffer,
    });
    res.json({ fileId });
  } catch (err) {
    console.error("speaking upload failed", err);
    res.status(500).json({ error: err.message });
  }
});

// Listening-section prompt audio — admin only. Not personal data (same
// admin-authored clip every candidate hears), so it's fine left publicly
// link-readable — the client plays it directly via <audio src>.
app.post("/uploads/listening", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const fileId = await uploadToDrive({
      name: `listening__${Date.now()}__${req.file.originalname}`,
      mimeType: req.file.mimetype || "audio/mpeg", buffer: req.file.buffer, isPublic: true,
    });
    res.json({ url: driveDirectUrl(fileId), fileId });
  } catch (err) {
    console.error("listening upload failed", err);
    res.status(500).json({ error: err.message });
  }
});

// Training-material PDF — admin only. Kept private on Drive; the client
// reads it back through GET /material/:fileId below (both because pdf.js
// needs a CORS-enabled response Drive's own download URL doesn't send, and
// so an un-watermarked copy is never reachable without being signed in).
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

// Training-material pages as images — alternative to the PDF (some PDFs
// have embedded fonts pdf.js can't substitute for and render garbled; a
// straight image renders pixel-perfect regardless). Page ORDER is entirely
// determined by req.files' array order, which multer preserves from the
// order the client appended them to the FormData — the client is
// responsible for sorting before upload, this just doesn't re-shuffle it.
app.post("/uploads/material-images", requireAdmin, upload.array("files", 200), async (req, res) => {
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
    console.error("material images upload failed", err);
    res.status(500).json({ error: err.message });
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
    console.error("material images delete failed", err);
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
    console.error("material proxy failed", err);
    res.status(500).json({ error: err.message });
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
app.get("/material-image/:fileId", requireSignedIn, async (req, res) => {
  try {
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
    console.error("material image proxy failed", err);
    res.status(500).json({ error: err.message });
  }
});

// Streams a candidate's private speaking recording — signed-in only (staff
// grading it, or the candidate reviewing their own before submit). Same
// pattern as the material proxies above: the file itself is never public on
// Drive, only reachable through here.
app.get("/audio/:fileId", requireSignedIn, async (req, res) => {
  try {
    const meta = await drive.files.get({ fileId: req.params.fileId, fields: "size,mimeType" });
    const driveRes = await drive.files.get(
      { fileId: req.params.fileId, alt: "media" },
      { responseType: "stream" }
    );
    res.setHeader("Content-Type", meta.data.mimeType || "audio/webm");
    if (meta.data.size) res.setHeader("Content-Length", meta.data.size);
    driveRes.data.pipe(res);
  } catch (err) {
    console.error("audio proxy failed", err);
    res.status(500).json({ error: err.message });
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
    console.error("revoke-public failed", err);
    res.status(500).json({ error: err.message });
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
    console.error("material delete failed", err);
    res.status(500).json({ error: err.message });
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
    console.error("purge-orphans failed", err);
    res.status(500).json({ error: err.message });
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
    console.error("restore failed", err);
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
