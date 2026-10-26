// Envoie un rappel à tous les membres qui ont activé les notifications.
// Lancé automatiquement par GitHub Actions (.github/workflows/rappels.yml).
import admin from "firebase-admin";

const MESSAGES = {
  objectif: { title: "Objectifs et programme de la semaine", body: "C'est l'heure ! Envoie tes objectifs et ton programme de la semaine, écrits ou en photo.", url: "./?ouvrir=objectif" },
  semaine:  { title: "Bilan de la semaine", body: "As-tu atteint ton objectif de la semaine ? Dis-le au cercle.", url: "./?ouvrir=semaine" },
  jour:     { title: "Bilan du jour", body: "0 scroll aujourd'hui ? Fais ton bilan de la journée.", url: "./?ouvrir=jour" }
};

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

// "auto" : choisit le rappel dû selon l'heure locale (UTC+1) ; chaque rappel part une seule fois par jour
const loc = new Date(Date.now() + 3600e3);
const jourCle = loc.toISOString().slice(0, 10);
const minutes = loc.getUTCHours() * 60 + loc.getUTCMinutes(), jSem = loc.getUTCDay();
let type = process.argv[2];
if (type === "auto") {
  const creneaux = [["jour", jSem >= 1 && jSem <= 6, 23 * 60 + 30], ["semaine", jSem === 0, 8 * 60], ["objectif", jSem === 0, 20 * 60 + 30]];
  const du = creneaux.find(([, ok, m]) => ok && minutes >= m && minutes < m + 90);
  if (!du) { console.log("Aucun rappel à cette heure"); process.exit(0); }
  type = du[0];
}
const msg = MESSAGES[type];
if (!msg) { console.error("Type inconnu :", type); process.exit(1); }
const meta = db.collection("meta").doc("rappels");
if (process.env.FORCE !== "1") {
  const deja = (await meta.get()).data() || {};
  if (deja[type] === jourCle) { console.log("Rappel déjà envoyé aujourd'hui :", type); process.exit(0); }
}
await meta.set({ [type]: jourCle }, { merge: true });

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

// Bilan du jour : chaque membre reçoit la liste de ce qu'il avait prévu aujourd'hui
const parUid = {};
if (type === "jour") {
  const lundi = new Date(Date.UTC(ici.getUTCFullYear(), ici.getUTCMonth(), ici.getUTCDate() - (ici.getUTCDay() + 6) % 7)).toISOString().slice(0, 10);
  const idx = (ici.getUTCDay() + 6) % 7;
  const semaine = (await db.collection("posts").where("ts", ">=", Date.now() - 9 * 864e5).get()).docs.map(d => d.data());
  for (const uid of valides) {
    const mine = semaine.filter(p => p.uid === uid);
    const t = [], vu = new Set();
    const add = (x, h) => { const k = (x || "").trim().toLowerCase(); if (!k || vu.has(k)) return; vu.add(k); t.push((h ? h + " " : "") + x.trim()); };
    const obj = mine.find(p => p.type === "objectif" && p.week === lundi);
    const secret = (await db.collection("prives").doc(uid).collection("semaines").doc(lundi).get()).data();
    const prog = (secret && secret.prog && secret.prog.length ? secret.prog : null) || (obj && obj.prog);
    if (prog) prog.forEach(r => add((r.cells || [])[idx], r.from && r.to ? `${r.from}-${r.to}` : r.from));
    const prev = mine.filter(p => p.type === "jour" && p.day < jour && p.ts > Date.now() - 3 * 864e5 && p.tasks).sort((a, b) => b.ts - a.ts)[0];
    if (prev) prev.tasks.forEach((x, i) => { if (!(prev.doneIdx || []).includes(i)) add(x.t, x.time); });
    const matin = mine.find(p => p.type === "matin" && p.day === jour && p.items);
    if (matin) matin.items.forEach(x => add(x));
    if (t.length) {
      let body = "Tu avais prévu : " + t.join(" · ");
      if (body.length > 220) body = body.slice(0, 217) + "…";
      parUid[uid] = body + " Coche ce qui est fait.";
    }
  }
}
const tokUid = Object.fromEntries(snap.docs.map(d => [d.id, d.data().uid]));
for (let i = 0; i < tokens.length; i += 500) {
  const batch = tokens.slice(i, i + 500);
  const res = await admin.messaging().sendEach(batch.map(tok => ({
    token: tok,
    data: { title: msg.title, body: parUid[tokUid[tok]] || msg.body, url: msg.url, tag: type },
    webpush: { headers: { Urgency: "high", TTL: "21600" } }
  })));
  // On retire les téléphones qui ont désinstallé l'app
  await Promise.all(res.responses.map((r, j) => {
    const code = r.error?.code || "";
    if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
      return db.collection("tokens").doc(batch[j]).delete();
    }
  }));
  console.log(`Envoyés : ${res.successCount}, échecs : ${res.failureCount}`);
}
