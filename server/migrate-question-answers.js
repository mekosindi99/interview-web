// One-time migration: splits correctAnswer/correctIndex out of every
// existing questions/{qid} doc into questionAnswers/{qid}, then strips them
// from the questions doc. Needed because questions/{qid} is readable by
// every signed-in candidate (they need it to take the exam) — leaving the
// answer key there meant any candidate could read every correct answer
// straight out of devtools before/during their own exam. Safe to run more
// than once (skips docs that no longer have either field).
//
// Usage (same service account the admin server already uses):
//   FIREBASE_SERVICE_ACCOUNT_JSON='<paste the JSON>' node migrate-question-answers.js
import admin from "firebase-admin";

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!serviceAccountJson) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT_JSON env var");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(serviceAccountJson)) });
const db = admin.firestore();

async function main() {
  const snap = await db.collection("questions").get();
  let migrated = 0, skipped = 0;
  const batchSize = 400; // Firestore batch limit is 500 writes; leave headroom (2 writes/doc)
  let batch = db.batch();
  let opsInBatch = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const hasAnswer = "correctAnswer" in data || "correctIndex" in data;
    if (!hasAnswer) { skipped++; continue; }
    const answerData = {};
    if ("correctAnswer" in data) answerData.correctAnswer = data.correctAnswer;
    if ("correctIndex" in data) answerData.correctIndex = data.correctIndex;

    batch.set(db.collection("questionAnswers").doc(doc.id), answerData, { merge: true });
    batch.update(doc.ref, {
      correctAnswer: admin.firestore.FieldValue.delete(),
      correctIndex: admin.firestore.FieldValue.delete(),
    });
    opsInBatch += 2;
    migrated++;

    if (opsInBatch >= batchSize) {
      await batch.commit();
      batch = db.batch();
      opsInBatch = 0;
    }
  }
  if (opsInBatch > 0) await batch.commit();
  console.log(`Done. Migrated: ${migrated}, already clean: ${skipped}, total: ${snap.size}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
