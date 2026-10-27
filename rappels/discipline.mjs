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

// 1 bis. Confidentialité : le texte des objectifs et programmes déjà publiés devient privé (visible par l'auteur seul)
const anciens = await db.collection("posts").where("type", "==", "objectif").get();
for (const d of anciens.docs) {
  const p = d.data();
  if (p.objText === undefined && p.prog === undefined) continue;
  await db.collection("prives").doc(p.uid).collection("semaines").doc(p.week).set({ objText: p.objText || "", prog: p.prog || [], ts: p.ts }, { merge: true });
  await d.ref.update({ objText: admin.firestore.FieldValue.delete(), prog: admin.firestore.FieldValue.delete(), prive: true });
  console.log("Objectifs rendus privés :", p.name, p.week);
}

// 1 ter. Confidentialité : le détail des bilans et objectifs du jour déjà publiés devient privé (visible par l'auteur seul)
const CHAMPS = ["items", "tasks", "doneIdx", "itemsTotal", "doneItems", "zero", "matinOk", "atteint", "text"];
const aCacher = (await db.collection("posts").where("type", "in", ["matin", "jour", "semaine", "objectif"]).get()).docs.filter(d => d.data().prive === undefined || (d.data().prive === true && CHAMPS.some(k => d.data()[k] !== undefined)));
for (const d of aCacher) {
  const p = d.data(), secret = {}, efface = { prive: true };
  CHAMPS.forEach(k => { if (p[k] !== undefined) { secret[k] = p[k]; efface[k] = admin.firestore.FieldValue.delete(); } });
  if (Object.keys(secret).length) await db.collection("prives").doc(p.uid).collection("posts").doc(d.id).set(secret, { merge: true });
  await d.ref.update(efface);
  console.log("Publication rendue privée :", p.name, p.type, p.day);
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

// 2 bis. E-mail de bienvenue après validation
const ADMIN_NAME = "Dénahouéa Merveil";
function bienvenue(prenom) {
  const sections = [
    ["Le principe", [
      "Le Cercle TB réunit des personnes motivées qui veulent enfin tenir leurs objectifs.",
      "Notre but commun : zéro scroll sur TikTok, Facebook et les autres réseaux, pour mettre ce temps dans nos objectifs.",
      "Personne ne te juge ici. On avance ensemble, un jour après l'autre."
    ]],
    ["Ta semaine dans le cercle", [
      "<b>Dimanche à 20h30</b> : envoie obligatoirement tes <b>objectifs de la semaine</b> et ton <b>programme de la semaine</b>, écrits ou en photo du papier. Ce que tu écris est transformé en image, que tu peux flouter avant de publier : personne ne lit ton texte. Tu peux les modifier après publication (⋮ → Modifier).",
      "<b>Chaque soir</b> : la notification te rappelle tout ce que tu avais prévu dans la journée. Tu coches fait ou non fait : ce qui n'est pas fait passe automatiquement au lendemain, et l'application te dit si tu as été sérieux ou si tu n'as pas tenu tes promesses.",
      "<b>Chaque matin, avant de commencer ta journée</b> : fixe tes objectifs du jour (« Objectifs du jour »). Le soir, tu coches ceux que tu as accomplis.",
      "<b>Du lundi au samedi à 23h30</b> : fais ton bilan du jour (« Bilan du jour ») : as-tu scrollé ou non, et qu'as-tu fait pour ton objectif ?",
      "<b>Dimanche à 8h</b> : fais ton bilan de la semaine (« Bilan de la semaine ») : objectif atteint ou non, ce qui a marché, ce qui a bloqué.",
      "Une notification te rappelle chaque rendez-vous, à condition d'avoir activé les rappels."
    ]],
    ["Bien démarrer", [
      `Ouvre l'application : <a href="${APP_URL}">${APP_URL.replace("https://", "")}</a> dans Chrome.`,
      "Installe-la : menu ⋮ de Chrome, puis « Installer l'application ». Une icône « tb » apparaît sur ton écran d'accueil.",
      "Active les rappels : dans l'application, menu ⋮, puis « Activer les rappels », puis « Autoriser ».",
      "Publie ton premier objectif dès maintenant, sans attendre dimanche."
    ]],
    ["Les règles du cercle", [
      "Un bilan du jour chaque soir, du lundi au samedi. C'est la règle la plus importante.",
      "Un objectif écrit sur papier chaque dimanche : précis, réaliste et mesurable.",
      "L'honnêteté avant tout : si tu as scrollé, dis-le. Un bilan honnête vaut mieux qu'un faux « 0 scroll ».",
      "Le respect de chacun : on encourage, on ne se moque jamais.",
      "Ce qui est partagé dans le cercle reste dans le cercle : aucune capture ni photo d'un membre partagée à l'extérieur."
    ]],
    ["Les erreurs à ne pas faire", [
      "Disparaître sans prévenir : <b>14 jours sans bilan du jour entraînent la suspension automatique de ton accès</b>.",
      "Se fixer un objectif vague (« travailler plus ») : préfère « réviser 2 chapitres » ou « faire 3 séances de sport ».",
      "Mentir dans ses bilans : tu ne trompes que toi-même.",
      "Ne tenir aucun objectif deux semaines de suite sans réagir : tu recevras une mise en garde.",
      "Oublier d'activer les rappels, puis rater les rendez-vous.",
      "Publier des messages sans rapport avec la discipline et les objectifs."
    ]],
    ["Mises en garde, blocage et badges", [
      "Si tu ne respectes pas tes engagements, tu recevras une mise en garde de " + ADMIN_NAME + ", visible par toi seul dans l'application.",
      "Sans bilan pendant 2 semaines, ton accès est suspendu. Pour revenir, contacte " + ADMIN_NAME + ".",
      "Les membres réguliers qui envoient leurs objectifs et les atteignent reçoivent des badges (« Discipliné(e) », « Zéro scroll », « Objectifs tenus »…), visibles par tout le cercle."
    ]]
  ];
  const html = `<div style="font-family:Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;color:#050505;line-height:1.55">
  <div style="background:#1D9BF0;color:#fff;padding:22px 24px;border-radius:8px 8px 0 0">
    <div style="font-size:26px;font-weight:800;letter-spacing:-1px">cercle tb</div>
    <div style="font-size:14px;opacity:.95">École de discipline de ${ADMIN_NAME}</div>
  </div>
  <div style="background:#fff;border:1px solid #E4E6EB;border-top:0;padding:24px;border-radius:0 0 8px 8px">
    <p style="font-size:17px;margin:0 0 12px">Bonjour ${prenom},</p>
    <p style="margin:0 0 12px">Ta demande a été validée : <b>bienvenue dans l'école de discipline</b> ! Voici tout ce qu'il faut savoir pour bien vivre dans le cercle.</p>
    ${sections.map(([t, items]) => `<h2 style="font-size:17px;color:#0B1F3F;margin:22px 0 8px;border-bottom:2px solid #E8F5FE;padding-bottom:4px">${t}</h2>
    <ul style="margin:0;padding-left:20px">${items.map(i => `<li style="margin:0 0 6px">${i}</li>`).join("")}</ul>`).join("")}
    <p style="margin:24px 0 0;text-align:center"><a href="${APP_URL}" style="display:inline-block;background:#1D9BF0;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:6px">Ouvrir le Cercle TB</a></p>
    <p style="margin:24px 0 0">On compte sur toi. Tiens bon !<br><b>${ADMIN_NAME}</b><br><span style="color:#65676B">Fondateur du Cercle TB</span></p>
  </div></div>`;
  const text = `Bonjour ${prenom},\n\nTa demande a été validée : bienvenue dans l'école de discipline de ${ADMIN_NAME} !\n\n` +
    sections.map(([t, items]) => `${t.toUpperCase()}\n` + items.map(i => "- " + i.replace(/<[^>]+>/g, "")).join("\n")).join("\n\n") +
    `\n\nApplication : ${APP_URL}\n\nTiens bon !\n${ADMIN_NAME}`;
  return { html, text };
}
if (process.env.TEST === "1") {
  try {
    const t = nodemailer.createTransport({ service: "gmail", auth: { user: ADMIN_EMAIL, pass: (process.env.GMAIL_APP_PASSWORD || "").replace(/\s/g, "") } });
    const { html, text } = bienvenue("Dénahouéa");
    await t.sendMail({ from: `${ADMIN_NAME} · Le Cercle TB <${ADMIN_EMAIL}>`, to: ADMIN_EMAIL, subject: "[Test] Bienvenue dans le Cercle TB", html, text });
    console.log("::notice::TEST OK : e-mail envoyé");
  } catch (e) { console.log("::error::TEST ECHEC : " + e.message); }
}
const aAccueillir = members.filter(m => m.status === "approved" && m.role !== "admin" && !m.welcomed && m.email);
if (aAccueillir.length && process.env.GMAIL_APP_PASSWORD) {
  const t = nodemailer.createTransport({ service: "gmail", auth: { user: ADMIN_EMAIL, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s/g, "") } });
  for (const m of aAccueillir) {
    try {
      const prenom = (m.name || "").split(" ")[0] || "à toi";
      const { html, text } = bienvenue(prenom);
      await t.sendMail({ from: `${ADMIN_NAME} · Le Cercle TB <${ADMIN_EMAIL}>`, to: m.email, subject: `Bienvenue dans le Cercle TB, ${prenom} : tout ce qu'il faut savoir`, html, text });
      await m.ref.update({ welcomed: true, welcomedAt: now });
      console.log("Bienvenue envoyée à", m.name);
    } catch (e) { console.log("Bienvenue non envoyée à", m.name, ":", e.message); }
  }
} else if (aAccueillir.length) console.log(aAccueillir.length, "bienvenue(s) en attente du mot de passe Gmail");

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
