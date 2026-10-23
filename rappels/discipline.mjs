// Tâche de fond du Cercle TB (lancée par GitHub Actions toutes les 15 minutes) :
//  1. Valide automatiquement les membres inscrits avant la mise en place de la validation
//  2. Prévient l'administrateur (e-mail + notification) à chaque nouvelle demande d'accès
//  3. Bloque les membres sans bilan du jour depuis 14 jours
import admin from "firebase-admin";
import nodemailer from "nodemailer";

const ADMIN_EMAIL = "denahoueamerveil@gmail.com";
const APP_URL = "https://cercle-tb.web.app";
const INACTIF_JOURS = 14;

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const now = Date.now();

const members = (await db.collection("members").get()).docs.map(d => ({ ref: d.ref, ...d.data() }));

// 1. Anciens membres (sans statut) : validés d'office
for (const m of members.filter(m => !m.status)) {
  await m.ref.update({ status: "approved", approvedAt: now, warnings: m.warnings || [], badges: m.badges || [], email: m.email || "" });
  m.status = "approved";
  console.log("Ancien membre validé :", m.name);
}

// 2. Nouvelles demandes
const nouvelles = members.filter(m => m.status === "pending" && !m.notified);
if (nouvelles.length) {
  const noms = nouvelles.map(m => `• ${m.name} (${m.email || "e-mail inconnu"})`).join("\n");
  let envoye = false;
  if (process.env.GMAIL_APP_PASSWORD) {
    try {
      const t = nodemailer.createTransport({ service: "gmail", auth: { user: ADMIN_EMAIL, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s/g, "") } });
      await t.sendMail({
        from: `Le Cercle TB <${ADMIN_EMAIL}>`, to: ADMIN_EMAIL,
        subject: `${nouvelles.length} nouvelle${nouvelles.length > 1 ? "s" : ""} demande${nouvelles.length > 1 ? "s" : ""} pour le Cercle TB`,
        text: `Bonjour,\n\nCes personnes demandent à rejoindre l'école de discipline :\n\n${noms}\n\nPour accepter ou refuser : ${APP_URL}/?ouvrir=demandes\n\nLe Cercle TB`
      });
      envoye = true;
      console.log("E-mail envoyé à l'administrateur");
    } catch (e) { console.log("E-mail non envoyé :", e.message); }
  } else console.log("Pas de mot de passe d'application Gmail : e-mail non envoyé");

  // Notification sur le téléphone de l'administrateur
  const adminUids = members.filter(m => m.role === "admin").map(m => m.uid);
  if (adminUids.length) {
    const toks = (await db.collection("tokens").where("uid", "in", adminUids).get()).docs.map(d => d.id);
    if (toks.length) {
      const r = await admin.messaging().sendEachForMulticast({
        tokens: toks,
        data: { title: "Nouvelle demande d'accès", body: nouvelles.map(m => m.name).join(", ") + " veut rejoindre le cercle.", url: "./?ouvrir=demandes", tag: "demande" },
        webpush: { headers: { Urgency: "high", TTL: "86400" } }
      });
      if (r.successCount) envoye = true;
    }
  }
  if (envoye) for (const m of nouvelles) await m.ref.update({ notified: true });
}

// 3. Blocage automatique après 14 jours sans bilan du jour
const actifs = members.filter(m => m.status === "approved" && m.role !== "admin");
for (const m of actifs) {
  const last = await db.collection("posts").where("uid", "==", m.uid).where("type", "==", "jour").orderBy("ts", "desc").limit(1).get()
    .catch(async () => {
      // Sans index : on lit tous les bilans du membre
      const all = await db.collection("posts").where("uid", "==", m.uid).get();
      const jours = all.docs.map(d => d.data()).filter(p => p.type === "jour").sort((a, b) => b.ts - a.ts);
      return { docs: jours.slice(0, 1).map(p => ({ data: () => p })) };
    });
  const lastTs = last.docs.length ? last.docs[0].data().ts : 0;
  const depuis = Math.max(lastTs, m.joined || 0, m.approvedAt || 0, m.unblockedAt || 0);
  if (now - depuis >= INACTIF_JOURS * 864e5) {
    await m.ref.update({ status: "blocked", blockedReason: `Aucun bilan depuis ${INACTIF_JOURS} jours`, blockedAt: now });
    console.log("Bloqué pour inactivité :", m.name);
  }
}
console.log("Terminé");
