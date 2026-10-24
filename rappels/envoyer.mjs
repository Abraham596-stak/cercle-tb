// Envoie un rappel à tous les membres qui ont activé les notifications.
// Lancé automatiquement par GitHub Actions (.github/workflows/rappels.yml).
import admin from "firebase-admin";

const MESSAGES = {
  objectif: { title: "Objectif de la semaine", body: "C'est l'heure ! Écris ton objectif sur un papier et envoie la photo au cercle.", url: "./?ouvrir=objectif" },
  semaine:  { title: "Bilan de la semaine", body: "As-tu atteint ton objectif de la semaine ? Dis-le au cercle.", url: "./?ouvrir=semaine" },
  jour:     { title: "Bilan du jour", body: "0 scroll aujourd'hui ? Fais ton bilan de la journée.", url: "./?ouvrir=jour" }
};

const type = process.argv[2];
const msg = MESSAGES[type];
if (!msg) { console.error("Type inconnu :", type); process.exit(1); }

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

// Seuls les membres validés sont prévenus, et pas ceux qui ont déjà fait ce qui est demandé
const membres = (await db.collection("members").get()).docs.map(d => d.data());
const valides = new Set(membres.filter(m => m.status === "approved").map(m => m.uid));
const ici = new Date(Date.now() + 3600e3); // heure locale (UTC+1)
const jour = ici.toISOString().slice(0, 10);
const depuis = Date.now() - 20 * 3600e3;
const recents = (await db.collection("posts").where("ts", ">=", depuis).get()).docs.map(d => d.data());
const dejaFait = new Set(recents.filter(p =>
  (type === "jour" && p.type === "jour" && p.day === jour) ||
  (type === "semaine" && p.type === "semaine" && p.day === jour) ||
  (type === "objectif" && p.type === "objectif" && p.day === jour)
).map(p => p.uid));
const snap = await db.collection("tokens").get();
const tokens = snap.docs.filter(d => valides.has(d.data().uid) && !dejaFait.has(d.data().uid)).map(d => d.id);
console.log(`${tokens.length} téléphone(s) à prévenir`);

for (let i = 0; i < tokens.length; i += 500) {
  const batch = tokens.slice(i, i + 500);
  const res = await admin.messaging().sendEachForMulticast({
    tokens: batch,
    data: { title: msg.title, body: msg.body, url: msg.url, tag: type },
    webpush: { headers: { Urgency: "high", TTL: "21600" } }
  });
  // On retire les téléphones qui ont désinstallé l'app
  await Promise.all(res.responses.map((r, j) => {
    const code = r.error?.code || "";
    if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
      return db.collection("tokens").doc(batch[j]).delete();
    }
  }));
  console.log(`Envoyés : ${res.successCount}, échecs : ${res.failureCount}`);
}
