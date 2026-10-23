// Supprime un seul compte (par e-mail) : son accès, sa fiche membre, ses publications et ses jetons.
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const email = (process.env.EMAIL || "").trim().toLowerCase();
if (!email) { console.log("Aucun e-mail donné"); process.exit(1); }
let uid = null;
try { const u = await admin.auth().getUserByEmail(email); uid = u.uid; await admin.auth().deleteUser(uid); console.log("Compte supprimé :", email); }
catch (e) { console.log("Aucun compte de connexion pour", email); }
const fiches = (await db.collection("members").get()).docs.filter(d => d.id === uid || (d.data().email || "").toLowerCase() === email);
for (const f of fiches) {
  const id = f.id;
  for (const c of ["posts", "tokens"]) {
    const s = await db.collection(c).where("uid", "==", id).get();
    for (const d of s.docs) await d.ref.delete();
    console.log(`${c} supprimé(s) :`, s.size);
  }
  await f.ref.delete(); console.log("Fiche membre supprimée");
}
