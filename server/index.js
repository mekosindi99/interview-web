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

// ── Google Drive (reuses the same Firebase service account — no second
//    credential to manage). The service account's client_email must be
//    shared as Editor on DRIVE_FOLDER_ID (see server/README.md), and the
//    Google Drive API must be enabled on the backing GCP project. ──
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
if (!DRIVE_FOLDER_ID) console.warn("Missing DRIVE_FOLDER_ID env var — Drive uploads will fail");
const driveAuth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/drive"],
});
const drive = google.drive({ version: "v3", auth: driveAuth });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Finds (or creates) a subfolder by name under parentId — used to namespace
// uploads (speaking/{uid}/, listening/, material/) inside DRIVE_FOLDER_ID.
async function getOrCreateSubfolder(name, parentId) {
  const q = `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const list = await drive.files.list({ q, fields: "files(id)" });
  if (list.data.files.length) return list.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
    fields: "id",
  });
  return created.data.id;
}

// Uploads a buffer to Drive and makes it link-readable (Drive has no
// per-user ACL for files uploaded by a service account without per-candidate
// OAuth — this is a known, accepted trade-off vs. Firebase Storage rules).
async function uploadToDrive({ name, mimeType, buffer, parentId }) {
  const res = await drive.files.create({
    requestBody: { name, parents: [parentId] },
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
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.get("/", (_req, res) => res.json({ ok: true }));

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

// Candidate's own speaking-answer recording — uploaded to
// speaking/{verifiedUid}/{qid}.webm, made link-readable, URL returned for
// the client to store on the attempt doc.
app.post("/uploads/speaking/:qid", requireSignedIn, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const speakingRoot = await getOrCreateSubfolder("speaking", DRIVE_FOLDER_ID);
    const uidFolder = await getOrCreateSubfolder(req.uid, speakingRoot);
    const fileId = await uploadToDrive({
      name: `${req.params.qid}.webm`, mimeType: req.file.mimetype || "audio/webm",
      buffer: req.file.buffer, parentId: uidFolder,
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
    const folderId = await getOrCreateSubfolder("listening", DRIVE_FOLDER_ID);
    const fileId = await uploadToDrive({
      name: `${Date.now()}-${req.file.originalname}`, mimeType: req.file.mimetype || "audio/mpeg",
      buffer: req.file.buffer, parentId: folderId,
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
    const folderId = await getOrCreateSubfolder("material", DRIVE_FOLDER_ID);
    const fileId = await uploadToDrive({
      name: req.file.originalname, mimeType: "application/pdf",
      buffer: req.file.buffer, parentId: folderId,
    });
    res.json({ fileId, fileName: req.file.originalname });
  } catch (err) {
    console.error("material upload failed", err);
    res.status(500).json({ error: err.message });
  }
});

// Proxies a Drive file's bytes through our own CORS-enabled response — pdf.js
// reads this via fetch/XHR, which Drive's own download URL doesn't support
// (no Access-Control-Allow-Origin header). Open to any signed-in user
// (matches the "read: if isSignedIn()" rule on settings/material in
// firestore.rules) — the material is meant to be readable by every candidate.
app.get("/material/:fileId", async (req, res) => {
  try {
    const driveRes = await drive.files.get(
      { fileId: req.params.fileId, alt: "media" },
      { responseType: "stream" }
    );
    res.setHeader("Content-Type", "application/pdf");
    driveRes.data.pipe(res);
  } catch (err) {
    console.error("material proxy failed", err);
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
