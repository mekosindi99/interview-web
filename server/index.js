// Tiny admin-only backend. Its only job is the one thing the browser SDK
// genuinely cannot do: permanently delete a Firebase Auth account. The main
// site works fully without this server (soft-delete/restore); this just
// upgrades "delete" to a real, permanent delete with no orphaned login left
// behind, for admins who want that instead of hide+restore.
import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!serviceAccountJson) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT_JSON env var");
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
});
const db = admin.firestore();
const auth = admin.auth();

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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`interview-admin-server listening on ${port}`));
