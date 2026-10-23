// Remet le Cercle TB à zéro : supprime tous les comptes, membres, publications et jetons de notification.
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
for (const c of ["members", "posts", "tokens"]) {
  const snap = await db.collection(c).get();
  for (let i = 0; i < snap.docs.length; i += 400) {
    const b = db.batch(); snap.docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit();
  }
  console.log(`${c} : ${snap.size} supprimé(s)`);
}
let total = 0, token;
do {
  const page = await admin.auth().listUsers(1000, token);
  if (page.users.length) { await admin.auth().deleteUsers(page.users.map(u => u.uid)); total += page.users.length; }
  token = page.pageToken;
} while (token);
console.log(`comptes : ${total} supprimé(s)`);
