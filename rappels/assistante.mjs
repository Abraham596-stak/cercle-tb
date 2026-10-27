// Assistante du Cercle TB (lancée toutes les 5 minutes par l'horloge).
//  1. Relance chaque heure ceux qui n'ont pas envoyé ce qui est demandé (message privé + notification ; e-mail au 1er et au 3e rappel)
//  2. Chaque jour, e-mail aux membres qui n'ont pas encore installé l'application, avec le guide en images
//  3. Après l'installation, un guide par jour : objectifs et programme, objectifs du jour, bilan du jour, bilan de la semaine
//  4. Chaque samedi, demande l'avis de chacun sur l'application
//  5. Envoie les notifications des nouveaux messages privés, des j'aime / commentaires et des nouveautés de l'application
import admin from "firebase-admin";
import nodemailer from "nodemailer";
import fs from "fs";

const ADMIN_EMAIL = "denahoueamerveil@gmail.com";
const ADMIN_NAME = "Dénahouéa Merveil";
const APP = "https://cercle-tb.web.app";
const DRY = process.env.DRY === "1";
const journal = []; const note = t => { journal.push(t); console.log(t); };

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

// ---------- heure locale (UTC+1) ----------
const NOW = Date.now();
const L = new Date(NOW + 3600e3);
const key = d => d.toISOString().slice(0, 10);
const jour = key(L), heure = L.getUTCHours(), minute = L.getUTCMinutes(), jSem = L.getUTCDay(); // 0 = dimanche
const minDuJour = heure * 60 + minute;
const hourKey = `${jour}T${String(heure).padStart(2, "0")}`;
const lundiDe = d => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - (x.getUTCDay() + 6) % 7); return x; };
const plusJours = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const debutLocal = k => Date.parse(k + "T00:00:00Z") - 3600e3; // minuit local en temps universel

// ---------- données ----------
const members = (await db.collection("members").get()).docs.map(d => ({ id: d.id, ...d.data() }));
const membres = members.filter(m => m.status === "approved" && m.role !== "admin" && m.email !== ADMIN_EMAIL);
const adminUid = (members.find(m => m.role === "admin" || m.email === ADMIN_EMAIL) || {}).uid;
const posts = (await db.collection("posts").where("ts", ">=", NOW - 10 * 864e5).get()).docs.map(d => d.data());
const tokDocs = (await db.collection("tokens").get()).docs;
const tokensDe = uid => tokDocs.filter(d => d.data().uid === uid).map(d => d.id);
const assistRef = uid => db.collection("assist").doc(uid);
const assist = Object.fromEntries((await db.collection("assist").get()).docs.map(d => [d.id, d.data()]));

// ---------- envois ----------
let mailer = null, mails = 0, pushes = 0, msgs = 0;
if (process.env.GMAIL_APP_PASSWORD) mailer = nodemailer.createTransport({ service: "gmail", auth: { user: ADMIN_EMAIL, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s/g, "") } });
const prenom = m => String(m.name || "").split(" ")[0] || "toi";

async function push(uid, title, body, url = "./", tag = "assistante") {
  const toks = tokensDe(uid); if (!toks.length || DRY) return;
  const r = await admin.messaging().sendEach(toks.map(token => ({ token, data: { title, body: body.slice(0, 230), url, tag }, webpush: { headers: { Urgency: "high", TTL: "21600" } } })));
  pushes += r.successCount;
  await Promise.all(r.responses.map((x, i) => { const c = x.error?.code || ""; if (c.includes("not-registered") || c.includes("invalid-registration")) return db.collection("tokens").doc(toks[i]).delete(); }));
}
async function inbox(m, text) {
  msgs++; if (DRY) { note(`[inbox] ${m.name} · ${text.slice(0, 90)}`); return; }
  const ts = Date.now(), b = db.batch();
  b.set(db.collection("convos").doc(m.uid).collection("msgs").doc(), { from: "assistante", text, ts });
  b.set(db.collection("convos").doc(m.uid), { uid: m.uid, name: m.name, last: text.slice(0, 140), lastTs: ts, lastFrom: "assistante", pushedTs: ts }, { merge: true });
  await b.commit();
}
const btn = (url, label) => `<p style="margin:22px 0"><a href="${url}" style="background:#1D9BF0;color:#fff;text-decoration:none;padding:13px 22px;border-radius:8px;font-weight:700;display:inline-block">${label}</a></p>`;
const imgs = list => list.map((src, i) => `<p style="margin:16px 0 4px;font-weight:700;color:#0B1F3F">Étape ${i + 1}</p><img src="${APP}/guide/${src}.png" alt="Étape ${i + 1}" width="300" style="width:300px;max-width:100%;border:1px solid #E4E6EB;border-radius:12px;display:block">`).join("");
async function mail(m, subject, html, text) {
  if (!mailer || !m.email) return;
  mails++; if (DRY) { note(`[mail] ${m.name} · ${subject}`); return; }
  const page = `<div style="font-family:Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:auto;color:#1C1E21;font-size:16px;line-height:1.55">
    <div style="font-size:26px;font-weight:800;color:#1D9BF0;letter-spacing:-.5px">cercle tb</div>
    <div style="color:#65676B;font-size:13px;margin-bottom:18px">École de discipline de ${ADMIN_NAME}</div>${html}
    <p style="color:#65676B;font-size:13px;margin-top:28px">L'assistante du Cercle TB, pour ${ADMIN_NAME}</p></div>`;
  try { await mailer.sendMail({ from: `Assistante du Cercle TB <${ADMIN_EMAIL}>`, to: m.email, subject, html: page, text }); }
  catch (e) { console.log("E-mail non envoyé à", m.email, ":", e.message); }
}

// ---------- 1. relances chaque heure ----------
const aFait = (m, it) => posts.some(p => p.uid === m.uid && it.fait(p));
const items = [];
// Objectifs et programme : dus le dimanche à 20h30 ; relance dès 21h30 puis chaque heure (7h-22h) jusqu'à l'envoi
{
  const semaine = jSem === 0 && minDuJour >= 21 * 60 + 30 ? key(plusJours(lundiDe(L), 7)) : jSem !== 0 ? key(lundiDe(L)) : null;
  const actif = (jSem === 0 && minDuJour >= 21 * 60 + 30) || (jSem !== 0 && heure >= 7 && heure < 22);
  if (semaine && actif) items.push({ k: "objectif:" + semaine, type: "objectif", fait: p => p.type === "objectif" && p.week === semaine,
    titre: "Objectifs et programme de la semaine",
    texte: (m, n) => n === 0 ? `Bonjour ${prenom(m)} 👋 Tes objectifs et ton programme de la semaine ne sont pas encore envoyés. C'est obligatoire pour avancer dans le cercle. Prends 5 minutes maintenant : ${APP}/?ouvrir=objectif`
      : n < 4 ? `${prenom(m)}, je reviens vers toi : toujours pas d'objectifs ni de programme pour cette semaine. Sans programme, pas de discipline. Envoie-les ici : ${APP}/?ouvrir=objectif`
      : `${prenom(m)}, c'est mon rappel n°${n + 1}. Je continuerai chaque heure tant que ton programme de la semaine n'est pas envoyé 😉 ${APP}/?ouvrir=objectif` });
}
// Objectifs du jour : du lundi au samedi, relance de 10h à 20h
if (jSem >= 1 && jSem <= 6 && heure >= 10 && heure < 20)
  items.push({ k: "matin:" + jour, type: "matin", fait: p => (p.type === "matin" || p.type === "jour") && p.day === jour,
    titre: "Objectifs du jour",
    texte: (m, n) => n === 0 ? `${prenom(m)}, tu n'as pas encore fixé tes objectifs du jour. Qu'est-ce que tu vas accomplir aujourd'hui ? ${APP}/?ouvrir=matin`
      : `Rappel n°${n + 1} : toujours pas d'objectifs pour aujourd'hui, ${prenom(m)}. Même 1 seul objectif, c'est mieux que rien : ${APP}/?ouvrir=matin` });
// Bilan du jour : dû à 23h30 (lundi-samedi) ; relance à 0h30 puis de 7h à 12h le lendemain
{
  const veille = key(plusJours(new Date(Date.UTC(L.getUTCFullYear(), L.getUTCMonth(), L.getUTCDate())), -1)), jVeille = (jSem + 6) % 7;
  const actif = jVeille >= 1 && jVeille <= 6 && ((heure === 0 && minute >= 30) || (heure >= 7 && heure < 12));
  if (actif) {
    const de = debutLocal(veille) + 4 * 3600e3, a = debutLocal(jour) + 12 * 3600e3;
    items.push({ k: "jour:" + veille, type: "jour", fait: p => p.type === "jour" && p.ts >= de && p.ts <= a,
      titre: "Bilan du jour",
      texte: (m, n) => n === 0 ? `${prenom(m)}, ton bilan d'hier n'est pas fait. Coche ce que tu as accompli et dis si tu as scrollé : ${APP}/?ouvrir=jour`
        : `Rappel n°${n + 1} : ton bilan d'hier t'attend toujours, ${prenom(m)}. Une journée sans bilan, c'est une journée perdue : ${APP}/?ouvrir=jour` });
  }
}
// Bilan de la semaine : dû le dimanche à 8h ; relance de 9h à 20h
if (jSem === 0 && heure >= 9 && heure < 20)
  items.push({ k: "semaine:" + jour, type: "semaine", fait: p => p.type === "semaine" && p.day === jour,
    titre: "Bilan de la semaine",
    texte: (m, n) => n === 0 ? `${prenom(m)}, c'est dimanche : as-tu atteint ton objectif de la semaine ? Fais ton bilan : ${APP}/?ouvrir=semaine`
      : `Rappel n°${n + 1} : ton bilan de la semaine n'est pas encore fait, ${prenom(m)}. 2 minutes suffisent : ${APP}/?ouvrir=semaine` });

for (const m of membres) {
  if ((m.approvedAt || 0) > NOW - 6 * 3600e3) continue; // laisse quelques heures aux nouveaux
  const st = assist[m.uid] || {};
  for (const it of items) {
    if (aFait(m, it)) continue;
    const rec = st[it.k] || { n: 0 };
    if (rec.last === hourKey) continue;
    const texte = it.texte(m, rec.n);
    await inbox(m, texte);
    await push(m.uid, `Assistante · ${it.titre}`, texte.replace(/https:\S+/g, "").trim(), `./?ouvrir=${it.type}`, "relance-" + it.type);
    if (rec.n === 0 || rec.n === 2) await mail(m, rec.n === 0 ? `${prenom(m)}, ${it.titre.toLowerCase()} : pas encore envoyé` : `Rappel : ${it.titre.toLowerCase()} toujours pas envoyé`,
      `<p>${texte.replace(/https:\S+/g, "").trim()}</p>${btn(`${APP}/?ouvrir=${it.type}`, "Ouvrir le Cercle TB")}`, texte);
    st[it.k] = { n: rec.n + 1, last: hourKey };
    if (!DRY) await assistRef(m.uid).set({ [it.k]: st[it.k] }, { merge: true });
  }
}

// ---------- 2 et 3. installation, puis un guide par jour ----------
const INSTALL = ["g-install-1", "g-install-2", "g-install-3"];
const TUTOS = [
  ["objectif", "Comment envoyer tes objectifs et ton programme de la semaine", ["g-objectif-1", "g-objectif-2", "g-objectif-3", "g-objectif-4", "g-objectif-5"]],
  ["matin", "Comment envoyer tes objectifs du jour", ["g-matin-1", "g-matin-2"]],
  ["jour", "Comment faire ton bilan du jour", ["g-jour-1", "g-jour-2"]],
  ["semaine", "Comment faire ton bilan de la semaine", ["g-semaine-1"]],
  ["messages", "Où lire tes messages et tes notifications", ["g-messages-1"]]
];
if (heure === 10) {
  for (const m of members.filter(x => x.role !== "admin" && x.email !== ADMIN_EMAIL && (x.status === "approved" || x.status === "pending"))) {
    const st = assist[m.uid] || {};
    if (!m.installed) {
      if (st.installDay === jour || (st.installN || 0) >= 21) continue;
      const n = st.installN || 0;
      await mail(m, n === 0 ? `${prenom(m)}, installe l'application du Cercle TB (2 minutes)` : `${prenom(m)}, as-tu installé l'application du Cercle TB ?`,
        `<p>Bonjour ${prenom(m)},</p><p>${n === 0 ? "Pour ne rien rater dans le cercle, installe l'application sur ton téléphone. C'est gratuit et ça prend 2 minutes." : "Je ne vois pas encore l'application installée sur ton téléphone."}</p>
        <p><b>Déjà installée ?</b> Ouvre-la une fois depuis son icône sur ton écran d'accueil : je ne te relancerai plus.</p>
        <p><b>Pas encore ?</b> Suis ces étapes. La flèche rouge montre où appuyer :</p>
        <ol><li>Ouvre ce lien dans <b>Chrome</b> : <a href="${APP}">${APP}</a></li><li>Touche les <b>3 points ⋮</b> en haut à droite</li><li>Touche <b>« Installer l'application »</b> (ou « Ajouter à l'écran d'accueil »), puis <b>Installer</b></li></ol>
        ${imgs(INSTALL)}
        <p style="margin-top:22px"><b>Ensuite</b>, ouvre l'app depuis son icône et connecte-toi avec ton e-mail et ton mot de passe. Pas encore de compte ? Touche « Créer un nouveau compte » et remplis ton nom, ton numéro WhatsApp, ton e-mail et un mot de passe.</p>
        ${imgs(["g-inscription-1", "g-inscription-2"])}
        ${btn(APP, "Ouvrir le Cercle TB")}
        <p>Tu n'y arrives pas ou tu ne veux pas l'installer ? <a href="${APP}/?ouvrir=pourquoi">Dis-moi pourquoi en 1 clic</a>, je t'aiderai.</p>`,
        `Installe l'application du Cercle TB : ouvre ${APP} dans Chrome, touche ⋮ puis « Installer l'application ». Si tu n'y arrives pas : ${APP}/?ouvrir=pourquoi`);
      if (m.status === "approved" && n === 0) await inbox(m, `Bienvenue ${prenom(m)} ! Pour recevoir les rappels, installe l'application : dans Chrome, touche ⋮ puis « Installer l'application ». Le guide en images est ici : ${APP}/?ouvrir=guide`);
      if (!DRY) await assistRef(m.uid).set({ installDay: jour, installN: n + 1 }, { merge: true });
    } else if (m.status === "approved") {
      const t = st.tuto || 0;
      if (t >= TUTOS.length || st.tutoDay === jour) continue;
      const [type, titre, list] = TUTOS[t];
      await mail(m, `Guide du Cercle TB ${t + 1}/${TUTOS.length} : ${titre.toLowerCase()}`,
        `<p>Bonjour ${prenom(m)},</p><p>Voici, étape par étape, <b>${titre.toLowerCase()}</b>. La flèche rouge montre où appuyer.</p>${imgs(list)}${btn(`${APP}/?ouvrir=guide`, "Voir le guide dans l'app")}`,
        `${titre} : ${APP}/?ouvrir=guide`);
      await inbox(m, `📘 Guide ${t + 1}/${TUTOS.length} : ${titre}. Toutes les étapes en images ici : ${APP}/?ouvrir=guide`);
      if (!DRY) await assistRef(m.uid).set({ tuto: t + 1, tutoDay: jour }, { merge: true });
    }
  }
}

// ---------- 4. avis chaque samedi à midi ----------
if (jSem === 6 && heure === 12) {
  for (const m of membres) {
    const st = assist[m.uid] || {};
    if (st.avisDay === jour) continue;
    const t = `${prenom(m)}, ton avis compte 🙏 Que penses-tu de l'application cette semaine ? Ce qui te plaît, ce qui manque, tes idées : 1 minute ici ${APP}/?ouvrir=avis`;
    await inbox(m, t);
    await push(m.uid, "Ton avis sur l'application", t.replace(/https:\S+/g, "").trim(), "./?ouvrir=avis", "avis");
    await mail(m, `${prenom(m)}, ton avis sur l'application du Cercle TB`, `<p>${t.replace(/https:\S+/g, "").trim()}</p>${btn(`${APP}/?ouvrir=avis`, "Donner mon avis")}`, t);
    if (!DRY) await assistRef(m.uid).set({ avisDay: jour }, { merge: true });
  }
}

// ---------- 5a. nouveautés de l'application ----------
try {
  const news = JSON.parse(fs.readFileSync(new URL("../nouveautes.json", import.meta.url)));
  const metaRef = db.collection("meta").doc("annonces"), deja = ((await metaRef.get()).data() || {}).faites || [];
  for (const n of news.filter(x => !deja.includes(x.v))) {
    for (const m of members.filter(x => x.status === "approved")) {
      if (DRY) { console.log("[maj]", m.name, n.text); continue; }
      await db.collection("notifs").doc(m.uid).collection("items").add({ kind: "maj", text: n.text, from: "systeme", fromName: "Cercle TB", postId: "", ts: Date.now() });
      await db.collection("notifs").doc(m.uid).set({ lastTs: Date.now(), lastText: n.text }, { merge: true });
    }
    if (!DRY) await metaRef.set({ faites: FV.arrayUnion(n.v) }, { merge: true });
    console.log("Nouveauté annoncée :", n.v);
  }
} catch (e) { console.log("Nouveautés :", e.message); }

// ---------- 5b. notifications des messages privés et des j'aime / commentaires ----------
for (const d of (await db.collection("convos").get()).docs) {
  const c = d.data();
  if (!c.lastTs || c.lastTs <= (c.pushedTs || 0)) continue;
  if (c.lastFrom === "admin") await push(c.uid, `Message de ${ADMIN_NAME}`, c.last || "", "./?ouvrir=messages", "msg");
  else if (c.lastFrom === c.uid && adminUid) await push(adminUid, `Message de ${c.name || "un membre"}`, c.last || "", "./?ouvrir=messages", "msg-" + c.uid);
  if (!DRY) await d.ref.set({ pushedTs: c.lastTs }, { merge: true });
}
for (const d of (await db.collection("notifs").get()).docs) {
  const n = d.data();
  if (!n.lastTs || n.lastTs <= (n.pushedTs || 0)) continue;
  if (n.lastTs > (n.seen || 0)) await push(d.id, "Cercle TB", n.lastText || "Tu as une nouvelle notification", "./?ouvrir=notifs", "notif");
  if (!DRY) await d.ref.set({ pushedTs: n.lastTs }, { merge: true });
}

if (process.env.GITHUB_ACTIONS && (DRY || msgs || mails)) journal.slice(0, 12).forEach(t => console.log("::notice::" + t.replace(/[\r\n]/g, " ")));
console.log(`${process.env.GITHUB_ACTIONS ? "::notice::" : ""}Assistante · ${hourKey} · ${items.length} relance(s) active(s) · ${msgs} message(s) · ${pushes} notification(s) · ${mails} e-mail(s)`);
