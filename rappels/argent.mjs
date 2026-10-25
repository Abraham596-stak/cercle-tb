// Mon Argent : rappel du soir (21h, heure du Bénin) « As-tu noté tes dépenses ? »
// Envoyé une seule fois par jour, et seulement à ceux qui n'ont rien noté aujourd'hui.
import admin from "firebase-admin";

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const loc = new Date(Date.now() + 3600e3);
const jour = loc.toISOString().slice(0, 10);
const minutes = loc.getUTCHours() * 60 + loc.getUTCMinutes();
if (process.env.FORCE !== "1" && !(minutes >= 21 * 60 && minutes < 22 * 60 + 30)) { console.log("Pas l'heure du rappel Mon Argent"); process.exit(0); }
const meta = db.collection("meta").doc("argent");
if (process.env.FORCE !== "1" && ((await meta.get()).data() || {}).soir === jour) { console.log("Rappel Mon Argent déjà envoyé"); process.exit(0); }
await meta.set({ soir: jour }, { merge: true });

const snap = await db.collection("argentTokens").get();
const parUid = {};
snap.docs.forEach(d => (parUid[d.data().uid] = parUid[d.data().uid] || []).push(d.id));
const msgs = [];
for (const [uid, toks] of Object.entries(parUid)) {
  const n = (await db.collection("users").doc(uid).collection("tx").where("date", "==", jour).get()).size;
  const body = n ? `${n} opération${n > 1 ? "s" : ""} notée${n > 1 ? "s" : ""} aujourd'hui. Rien oublié ? Zem, crédit, petit achat…` : "Tu n'as rien noté aujourd'hui. Prends 1 minute : même 100 F compte.";
  toks.forEach(token => msgs.push({ token, data: { title: "As-tu noté tes dépenses ?", body, url: "./", tag: "argent-soir" }, webpush: { headers: { Urgency: "high", TTL: "21600" } } }));
}
console.log(`${msgs.length} téléphone(s) à prévenir`);
for (let i = 0; i < msgs.length; i += 500) {
  const part = msgs.slice(i, i + 500), res = await admin.messaging().sendEach(part);
  await Promise.all(res.responses.map((r, j) => { const c = r.error?.code || "";
    if (c.includes("not-registered") || c.includes("invalid-registration")) return db.collection("argentTokens").doc(part[j].token).delete(); }));
  console.log(`Envoyés : ${res.successCount}, échecs : ${res.failureCount}`);
}
