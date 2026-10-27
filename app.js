import { firebaseConfig, vapidKey } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  updateProfile, signOut, sendPasswordResetEmail, sendEmailVerification } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, setDoc, updateDoc, deleteDoc, getDocs, Bytes,
  onSnapshot, query, orderBy, limit, arrayUnion, arrayRemove, deleteField, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMessaging, getToken, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

if (location.hostname.endsWith("github.io")) location.replace("https://cercle-tb.web.app/" + location.search);
const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
auth.languageCode = "fr";
// Cache local : l'app marche hors ligne et envoie tout au retour du réseau
const db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Administrateur de la communauté
const ADMIN_EMAIL = "denahoueamerveil@gmail.com";
const ADMIN_NAME = "Dénahouéa Merveil";
const BADGES = ["Discipliné(e)", "Zéro scroll", "Objectifs tenus", "Exemple du cercle"];
const INACTIF_JOURS = 14;

let me = null, myDoc = undefined, posts = [], members = [], view = "fil", filter = "tout", online = navigator.onLine;
let priv = {}, privPosts = {}, rawPosts = [], notifs = [], notifMeta = {}, convo = null, msgs = [], convos = [], chatUid = null, chatUnsub = null, comments = [], openCom = new Set(), mediaUrls = {}, mediaPlaying = false;
let unsub = [], dataUnsub = [], swReg = null, installEvt = null, autoChecked = false;
const isAdmin = () => !!me && me.email.toLowerCase() === ADMIN_EMAIL;

/* ---------- service worker (hors ligne + rappels) ---------- */
if ("serviceWorker" in navigator) {
  // Mise à jour automatique : dès qu'une nouvelle version est publiée, la page se recharge toute seule
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(r => {
    swReg = r; r.update().catch(() => {});
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") r.update().catch(() => {}); });
    setInterval(() => r.update().catch(() => {}), 5 * 60 * 1000);
  }).catch(() => {});
}
// Filet de sécurité : compare la version en ligne avec celle affichée
const APP_VERSION = "23";
async function checkVersion() {
  if (!navigator.onLine) return;
  try {
    const v = await (await fetch("version.json?t=" + Date.now(), { cache: "no-store" })).json();
    if (v.v && v.v !== APP_VERSION && sessionStorage.getItem("ctb-reload") !== v.v) {
      sessionStorage.setItem("ctb-reload", v.v);
      const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k)));
      location.reload();
    }
  } catch (e) {}
}
checkVersion();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkVersion(); });
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; });

/* ---------- dates ---------- */
const JOURS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
function mondayOf(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x; }
function weekStart(d = new Date()) { const m = mondayOf(d); if (d.getDay() === 0 && d.getHours() >= 12) m.setDate(m.getDate() + 7); return m; }
const dayKey = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const weekKey = d => dayKey(weekStart(d));
const fmtDate = d => `${JOURS[d.getDay()]} ${d.getDate()} ${MOIS[d.getMonth()]}`;
const fmtTime = d => `${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;
function nextReminder(now = new Date()) {
  const list = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    const at = (h, m, what) => { const t = new Date(d); t.setHours(h, m, 0, 0); if (t > now) list.push({ t, what }); };
    if (d.getDay() === 0) { at(8, 0, "Bilan de la semaine : objectif atteint ?"); at(20, 30, "Envoie ton programme et ton objectif de la semaine"); }
    else at(23, 30, "Bilan de ta journée");
  }
  return list.sort((a, b) => a.t - b.t)[0];
}
function untilText(t) {
  const ms = t - new Date(), h = Math.floor(ms / 3.6e6), m = Math.floor(ms % 3.6e6 / 6e4);
  if (h >= 24) return `dans ${Math.floor(h / 24)} j ${h % 24} h`;
  return h ? `dans ${h} h ${String(m).padStart(2, "0")}` : `dans ${m} min`;
}

/* ---------- connexion ---------- */
const ERR = {
  "auth/invalid-email": "Cet e-mail n'est pas valide.",
  "auth/invalid-credential": "E-mail ou mot de passe incorrect.",
  "auth/wrong-password": "Mot de passe incorrect.",
  "auth/user-not-found": "Aucun compte avec cet e-mail. Crée ton compte.",
  "auth/email-already-in-use": "Ce compte existe déjà. Connecte-toi.",
  "auth/weak-password": "Le mot de passe doit avoir au moins 6 caractères.",
  "auth/network-request-failed": "Pas de réseau. La première connexion a besoin d'internet."
};
const EYE = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-6.5 0-10-7-10-7a18 18 0 0 1 5.1-5.9M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M2 2l20 20"/></svg>`;
const MOTIVATION = [
  "Bienvenue dans le cercle : ici, chacun avance, un jour après l'autre",
  "La discipline, c'est choisir entre ce que tu veux maintenant et ce que tu veux le plus",
  "Chaque soir sans scroll est une victoire sur toi-même",
  "Tu n'as pas besoin d'être parfait, seulement régulier",
  "Pose ton téléphone, prends ton papier, écris ton objectif",
  "Les petits efforts répétés font les grands résultats",
  "Ensemble, on tient bon"
];
const ticker = () => `<div class="ticker" aria-label="Messages de motivation"><div class="ticker-track">${[...MOTIVATION, ...MOTIVATION].map(t => `<span>${t}</span>`).join("")}</div></div>`;
function loginView(mode = "in") {
  const create = mode === "new";
  $("#app").innerHTML = `${ticker()}<div class="login">
    <div class="login-brand">
      <div class="wordmark">cercle tb</div>
      <p class="welcome">Bienvenue à l'école de discipline de <b>${ADMIN_NAME}</b></p>
      <p>Un objectif par semaine. Un bilan chaque soir. Zéro scroll.</p>
    </div>
    <form id="lf" class="login-card">
      <h2>${create ? "Créer un compte" : "Se connecter"}</h2>
      ${create ? `<input id="lname" class="field" type="text" placeholder="Nom et prénom" required maxlength="40" autocomplete="name">
      <input id="lwa" class="field" type="tel" placeholder="Numéro WhatsApp (avec l'indicatif, ex. +229…)" required maxlength="20" autocomplete="tel">` : ""}
      <input id="lmail" class="field" type="email" placeholder="Adresse e-mail" required autocomplete="email">
      <div class="pw"><input id="lpass" class="field" type="password" placeholder="Mot de passe" required minlength="6" autocomplete="${create ? "new-password" : "current-password"}">
        <button type="button" class="eye" id="eye" aria-label="Afficher le mot de passe">${EYE}</button></div>
      <div class="err" id="lerr"></div>
      <button class="btn btn-primary" type="submit">${create ? "S'inscrire" : "Se connecter"}</button>
      ${create ? "" : `<button class="link" type="button" id="forgot">Mot de passe oublié ?</button>`}
      <hr>
      <button class="btn btn-secondary" type="button" id="swap">${create ? "J'ai déjà un compte" : "Créer un nouveau compte"}</button>
    </form></div>`;
  $("#swap").onclick = () => loginView(create ? "in" : "new");
  $("#eye").onclick = () => {
    const f = $("#lpass"), show = f.type === "password";
    f.type = show ? "text" : "password";
    $("#eye").innerHTML = show ? EYE_OFF : EYE;
    $("#eye").setAttribute("aria-label", show ? "Masquer le mot de passe" : "Afficher le mot de passe");
    f.focus();
  };
  if ($("#forgot")) $("#forgot").onclick = async () => {
    const mail = $("#lmail").value.trim();
    if (!mail) { $("#lerr").textContent = "Écris ton e-mail d'abord."; return; }
    try { await sendPasswordResetEmail(auth, mail); $("#lerr").textContent = "Lien envoyé dans ta boîte mail."; }
    catch (e) { $("#lerr").textContent = ERR[e.code] || "Impossible d'envoyer le lien."; }
  };
  $("#lf").onsubmit = async e => {
    e.preventDefault(); const btn = e.submitter; btn.disabled = true; $("#lerr").textContent = "";
    const mail = $("#lmail").value.trim(), pass = $("#lpass").value;
    try {
      if (create) {
        const name = $("#lname").value.trim(), wa = $("#lwa").value.replace(/[^\d+]/g, "");
        if (wa.replace(/\D/g, "").length < 8) { $("#lerr").textContent = "Écris ton numéro WhatsApp complet, avec l'indicatif."; btn.disabled = false; return; }
        pendingWa = wa;
        const cred = await createUserWithEmailAndPassword(auth, mail, pass);
        pendingName = name;
        await updateProfile(cred.user, { displayName: name });
        if (me) me.name = name;
      } else await signInWithEmailAndPassword(auth, mail, pass);
    } catch (err) { $("#lerr").textContent = ERR[err.code] || "Une erreur est survenue. Réessaie."; btn.disabled = false; }
  };
}

/* ---------- données ---------- */
let pendingName = null, pendingWa = null;
function stopData() { dataUnsub.forEach(u => u()); dataUnsub = []; priv = {}; privPosts = {}; rawPosts = []; notifs = []; notifMeta = {}; convo = null; msgs = []; convos = []; if (chatUnsub) chatUnsub(); chatUnsub = null; chatUid = null; posts = []; members = []; comments = []; }
function startData() {
  if (dataUnsub.length) return;
  dataUnsub.push(onSnapshot(query(collection(db, "posts"), orderBy("ts", "desc"), limit(150)), { includeMetadataChanges: true }, snap => {
    rawPosts = snap.docs.map(d => ({ ...d.data(), _pending: d.metadata.hasPendingWrites }));
    mergePosts(); render();
  }, () => {}));
  // Le détail de mes publications privées (bilans, objectifs du jour…) : visible par moi seul
  dataUnsub.push(onSnapshot(collection(db, "prives", me.uid, "posts"), snap => { privPosts = Object.fromEntries(snap.docs.map(d => [d.id, d.data()])); mergePosts(); render(); }, () => {}));
  // Ce que j'ai écrit (objectifs, programme) : visible par moi seul
  dataUnsub.push(onSnapshot(collection(db, "prives", me.uid, "semaines"), snap => { priv = Object.fromEntries(snap.docs.map(d => [d.id, d.data()])); render(); }, () => {}));
  // Notifications et messages privés
  dataUnsub.push(onSnapshot(query(collection(db, "notifs", me.uid, "items"), orderBy("ts", "desc"), limit(80)), snap => { notifs = snap.docs.map(d => ({ id: d.id, ...d.data() })); render(); }, () => {}));
  dataUnsub.push(onSnapshot(doc(db, "notifs", me.uid), snap => { notifMeta = snap.exists() ? snap.data() : {}; render(); }, () => {}));
  if (isAdmin()) dataUnsub.push(onSnapshot(query(collection(db, "convos"), orderBy("lastTs", "desc")), snap => { convos = snap.docs.map(d => ({ id: d.id, ...d.data() })); render(); }, () => {}));
  else {
    dataUnsub.push(onSnapshot(doc(db, "convos", me.uid), snap => { convo = snap.exists() ? snap.data() : null; render(); }, () => {}));
    dataUnsub.push(onSnapshot(query(collection(db, "convos", me.uid, "msgs"), orderBy("ts", "asc"), limit(300)), { includeMetadataChanges: true }, snap => {
      msgs = snap.docs.map(d => ({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites })); render(); }, () => {}));
  }
  dataUnsub.push(onSnapshot(collection(db, "members"), snap => { members = snap.docs.map(d => d.data()); render(); }, () => {}));
  dataUnsub.push(onSnapshot(query(collection(db, "comments"), orderBy("ts", "asc"), limit(1000)), { includeMetadataChanges: true }, snap => {
    comments = snap.docs.map(d => ({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites }));
    render();
  }, () => {}));
}
function start(user) {
  if (me && me.uid === user.uid) return;
  me = { uid: user.uid, name: user.displayName || pendingName || user.email.split("@")[0], email: user.email, verified: user.emailVerified };
  myDoc = undefined;
  unsub.forEach(u => u()); unsub = []; stopData();
  render();
  if (isAdmin() && !user.emailVerified) { myDoc = { status: "verify" }; render(); return; }
  unsub.push(onSnapshot(doc(db, "members", user.uid), snap => {
    if (!snap.exists()) {
      const name = auth.currentUser?.displayName || pendingName || me.name;
      const base = { uid: me.uid, name, email: me.email, joined: Date.now(), warnings: [], badges: [], ...(pendingWa ? { whatsapp: pendingWa } : {}) };
      setDoc(doc(db, "members", me.uid), isAdmin() ? { ...base, status: "approved", role: "admin" } : { ...base, status: "pending", notified: false })
        .catch(() => toast("Impossible d'envoyer ta demande. Vérifie ta connexion."));
      myDoc = { ...base, status: isAdmin() ? "approved" : "pending" };
    } else {
      myDoc = snap.data();
      if (myDoc.name) me.name = myDoc.name;
      if (isAdmin() && (myDoc.role !== "admin" || myDoc.status !== "approved")) {
        setDoc(doc(db, "members", me.uid), { role: "admin", status: "approved", email: me.email }, { merge: true }).catch(() => {});
        myDoc = { ...myDoc, role: "admin", status: "approved" };
      }
    }
    if (myDoc.status === "approved") startData(); else stopData();
    render();
  }, () => { myDoc = { status: "pending" }; render(); }));
}
onAuthStateChanged(auth, u => {
  if (u) start(u);
  else { me = null; myDoc = undefined; unsub.forEach(f => f()); unsub = []; stopData(); loginView(); }
});

// Mes publications privées : je vois leur détail, les autres non
function mergePosts() { posts = rawPosts.map(p => p.uid === me.uid && privPosts[p.id] ? { ...p, ...privPosts[p.id] } : p); }
/* ---------- notifications et messages ---------- */
function notify(uid, kind, text, postId = "") {
  if (!uid || uid === me.uid) return;
  const ts = Date.now();
  setDoc(doc(collection(db, "notifs", uid, "items")), { kind, text: text.slice(0, 300), from: me.uid, fromName: me.name, postId, ts }).catch(() => {});
  setDoc(doc(db, "notifs", uid), { lastTs: ts, lastText: text.slice(0, 200) }, { merge: true }).catch(() => {});
}
const unreadNotifs = () => notifs.filter(n => n.ts > (notifMeta.seen || 0)).length;
const convoUnread = c => c && (isAdmin() ? c.lastFrom === c.uid && c.lastTs > (c.seenAdmin || 0) : c.lastFrom !== me.uid && c.lastTs > (c.seenMember || 0));
const unreadMsgs = () => isAdmin() ? convos.filter(convoUnread).length : convoUnread(convo) ? 1 : 0;
async function sendMsg(uid, text, from) {
  const ts = Date.now(), m = memberOf(uid);
  const b = writeBatch(db);
  b.set(doc(collection(db, "convos", uid, "msgs")), { from, text, ts });
  b.set(doc(db, "convos", uid), { uid, name: m.name || me.name, last: text.slice(0, 140), lastTs: ts, lastFrom: from, ...(from === "admin" ? { seenAdmin: ts } : { seenMember: ts }) }, { merge: true });
  return b.commit();
}
const SENDER = f => f === "admin" ? ADMIN_NAME : f === "assistante" ? "Assistante du cercle" : null;
const PRIV_FIELDS = ["items", "tasks", "doneIdx", "itemsTotal", "doneItems", "zero", "matinOk", "atteint", "text"];
const lockedFor = p => p.prive && p.uid !== me.uid;

/* ---------- administration ---------- */
const adminUid = () => (members.find(m => m.role === "admin") || {}).uid;
const memberOf = uid => members.find(m => m.uid === uid) || {};
function lastJour(uid) { const p = posts.find(x => x.uid === uid && x.type === "jour"); return p ? p.ts : 0; }
function daysInactive(m) {
  const since = Math.max(lastJour(m.uid), m.joined || 0, m.approvedAt || 0, m.unblockedAt || 0);
  return Math.floor((Date.now() - since) / 864e5);
}
function twoWeeksFailed(uid) {
  const w = posts.filter(p => p.uid === uid && p.type === "semaine").slice(0, 2);
  return w.length === 2 && w.every(p => p.atteint === false);
}
async function setMember(uid, data) {
  try { await updateDoc(doc(db, "members", uid), data); } catch (e) { toast("Action refusée. Vérifie ta connexion."); }
}
function autoDiscipline() {
  // L'administrateur bloque automatiquement ceux qui n'envoient plus de bilan depuis 2 semaines
  if (!isAdmin() || autoChecked || !posts.length) return;
  autoChecked = true;
  members.filter(m => m.status === "approved" && m.role !== "admin" && daysInactive(m) >= INACTIF_JOURS)
    .forEach(m => setMember(m.uid, { status: "blocked", blockedReason: `Aucun bilan depuis ${INACTIF_JOURS} jours`, blockedAt: Date.now() }));
}

const TYPES = { objectif: "Objectifs et programme de la semaine", matin: "Objectifs du jour", jour: "Bilan du jour", semaine: "Bilan de la semaine", message: "Message" };
async function savePost(p, prive = false) {
  const ref = doc(collection(db, "posts"));
  p.id = ref.id;
  if (p.type !== "message") {
    p.prive = prive;
    if (prive) {
      const secret = {};
      PRIV_FIELDS.forEach(k => { if (k in p) { secret[k] = p[k]; delete p[k]; } });
      setDoc(doc(db, "prives", me.uid, "posts", ref.id), secret).catch(() => toast("Le détail privé n'a pas pu être gardé."));
    }
  }
  setDoc(ref, p).catch(() => toast("Envoi refusé. Vérifie ta connexion au compte."));
  toast(online ? (prive ? "Publié · détail visible par toi seul" : "Envoyé au groupe") : "Gardé, envoi dès le retour du réseau");
}
async function setVisibility(p, makePublic) {
  try {
    if (makePublic) {
      const secret = privPosts[p.id] || {};
      await updateDoc(doc(db, "posts", p.id), { ...secret, prive: false });
      toast("Publication rendue publique");
    } else {
      const secret = {}, del = { prive: true };
      PRIV_FIELDS.forEach(k => { if (p[k] !== undefined) { secret[k] = p[k]; del[k] = deleteField(); } });
      await setDoc(doc(db, "prives", me.uid, "posts", p.id), secret);
      await updateDoc(doc(db, "posts", p.id), del);
      toast("Publication rendue privée");
    }
  } catch (e) { toast("Changement refusé. Vérifie ta connexion."); }
}

/* ---------- statistiques ---------- */
function statsFor(uid) {
  const mine = posts.filter(p => p.uid === uid);
  const days = new Set(mine.filter(p => p.type === "jour" && p.zero).map(p => p.day));
  let streak = 0; const d = new Date(); if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
  const obj = mine.find(p => p.type === "objectif" && p.week === weekKey(new Date()));
  const done = mine.filter(p => p.type === "semaine" && p.atteint).length;
  const today = mine.find(p => p.type === "jour" && p.day === dayKey(new Date()));
  const matin = mine.find(p => p.type === "matin" && p.day === dayKey(new Date()));
  return { streak, obj, done, today, matin };
}

/* ---------- vues ---------- */
function avatar(name, cls = "") { return `<div class="av ${cls}">${esc((name || "?")[0].toUpperCase())}</div>`; }
function nameTags(uid) {
  const m = memberOf(uid);
  const founder = m.role === "admin" ? `<span class="founder">Fondateur</span>` : "";
  const b = (m.badges || []).map(x => `<span class="badge">★ ${esc(x)}</span>`).join("");
  return founder + b;
}
function postHTML(p) {
  if (lockedFor(p)) return lockedHTML(p);
  let tag = `<span class="tag">${TYPES[p.type] || ""}</span>`;
  if (p.type === "semaine") tag = `<span class="tag ${p.atteint ? "ok" : "ko"}">${p.atteint ? "Objectif atteint" : "Objectif non atteint"}</span>`;
  if (p.type === "jour") tag = `<span class="tag ${p.zero ? "ok" : "ko"}">${p.zero ? "0 scroll" : "A scrollé"}</span>`;
  if (p.type === "message") tag = "";
  if (p.type === "matin") tag = "";
  if (p.type === "objectif") tag = "";
  if (p.type === "jour" && p.matinOk !== undefined) tag += ` <span class="tag ${p.matinOk ? "ok" : "ko"}">${p.matinOk ? "Objectifs du jour tenus" : "Objectifs du jour pas tous tenus"}</span>`;
  if (p.type === "jour" && p.itemsTotal) tag += ` <span class="tag ${p.doneItems.length === p.itemsTotal ? "ok" : p.doneItems.length / p.itemsTotal < .4 ? "ko" : ""}">${p.doneItems.length}/${p.itemsTotal} promesses tenues</span>`;
  const d = new Date(p.ts);
  const canDel = p.id && !p._pending && (p.uid === me.uid || isAdmin());
  return `<article class="card post">
    <div class="post-head">${canDel ? `<button class="icon-btn dark small-btn post-more" data-p="${esc(p.id)}" aria-label="Options">⋮</button>` : ""}${avatar(p.name, memberOf(p.uid).role === "admin" ? "admin" : "")}
      <div class="meta"><strong>${esc(memberOf(p.uid).name || p.name)} ${nameTags(p.uid)}</strong><small>${fmtDate(d)} à ${fmtTime(d)}${p.type !== "message" ? " · " + TYPES[p.type] : ""}</small></div></div>
    ${p.prive && p.type !== "message" ? `<div class="mine-priv">🔒 Détail visible par toi seul · ⋮ pour le rendre public</div>` : ""}
    ${p.type === "matin" ? itemsHTML(p) : ""}

    ${p.type === "jour" && p.tasks ? tasksHTML(p) : ""}
    ${p.text ? `<p class="post-text">${esc(p.text)}</p>` : ""}
    ${tag ? `<div class="post-tags">${tag}</div>` : ""}
    ${p.type === "objectif" ? objHTML(p) : p.photo ? `<img class="post-img" src="${p.photo}" alt="Objectifs écrits sur papier" loading="lazy">` : ""}
    ${mediaHTML(p)}
    ${p._pending ? `<div class="pending">En attente de réseau · envoi automatique</div>` : ""}
    ${p.id && !p._pending ? socialHTML(p) : ""}
  </article>`;
}
// Objectifs et programme de la semaine : uniquement en image (floutée ou non), jamais en texte lisible par les autres
function objHTML(p) {
  const lock = t => `<div class="locked">🔒 ${t}</div>`;
  const part = (title, img, legacy, alt) => `<div class="sec-t">${title}</div>` + (img ? `<img class="post-img" src="${img}" alt="${alt}" loading="lazy">` : legacy || lock("Privé"));
  const mine = p.uid === me.uid;
  return part("Objectifs de la semaine", p.photo, p.objText ? `<p class="post-text">${esc(p.objText)}</p>` : "", "Objectifs de la semaine")
    + part("Programme de la semaine", p.progPhoto, p.prog ? progTable(p.prog) : "", "Programme de la semaine")
    + (p.edited ? `<p class="hint edited">Modifié le ${fmtDate(new Date(p.edited))} à ${fmtTime(new Date(p.edited))}</p>` : "")
    + (mine && p.prive && !p.photo && !p.progPhoto ? `<p class="hint">Toi seul vois ton texte. Touche ⋮ → Modifier pour publier une image floutée ou non.</p>` : "");
}
const HEART = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.2 4.3 2.5h2c.7-1.3 2.2-2.5 4.3-2.5 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z" fill="currentColor"/></svg>`;
const BUBBLE = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>`;
function mediaHTML(p) {
  const imgs = (p.photos || []).map(src => `<img src="${src}" alt="" loading="lazy">`).join("");
  const grid = imgs ? `<div class="post-media n${Math.min(p.photos.length, 4)}">${imgs}</div>` : "";
  let vid = "";
  if (p.video) {
    const url = mediaUrls[p.video.id];
    vid = url
      ? `<video class="post-video" src="${url}" controls playsinline preload="metadata" ${p.video.poster ? `poster="${p.video.poster}"` : ""}></video>`
      : `<button class="post-video-load" data-vid="${esc(p.video.id)}" data-parts="${p.video.parts}" data-mime="${esc(p.video.mime)}" style="${p.video.poster ? `background-image:url('${p.video.poster}')` : ""}"><span class="play">▶</span><span class="vsize">Vidéo · ${(p.video.size / 1e6).toFixed(1)} Mo</span></button>`;
  }
  return grid + vid;
}
function likeLine(likes) {
  if (!likes.length) return "";
  const names = likes.map(u => u === me.uid ? "Toi" : (memberOf(u).name || "Un membre"));
  const txt = names.length <= 2 ? names.join(" et ") : `${names[0]}, ${names[1]} et ${names.length - 2} autre${names.length > 3 ? "s" : ""}`;
  return `<div class="like-line"><span class="heart-dot">${HEART}</span>${esc(txt)}</div>`;
}
function socialHTML(p) {
  const likes = p.likes || [], liked = likes.includes(me.uid);
  const cs = comments.filter(c => c.postId === p.id), open = openCom.has(p.id);
  return `<div class="social">
    ${likeLine(likes)}
    <div class="post-actions">
      <button class="act ${liked ? "on" : ""}" data-like="${esc(p.id)}" aria-pressed="${liked}">${HEART}<span>J'aime</span></button>
      <button class="act" data-com="${esc(p.id)}">${BUBBLE}<span>Commenter${cs.length ? ` · ${cs.length}` : ""}</span></button>
    </div>
    ${open ? `<div class="comments">
      ${cs.filter(c => !c.parentId || !cs.some(x => x.id === c.parentId)).map(c => commentHTML(c, cs.filter(r => r.parentId === c.id))).join("")}
      <form class="c-form" data-cform="${esc(p.id)}">${avatar(me.name, "sm")}
        <input class="c-input" id="ci-${esc(p.id)}" maxlength="500" placeholder="${replyTo[p.id] ? "Répondre à " + esc(firstName(memberOf(replyTo[p.id].uid).name || replyTo[p.id].name)) + "…" : "Écris un commentaire…"}" autocomplete="off">
        ${replyTo[p.id] ? `<button type="button" class="link-sm" data-rcancel="${esc(p.id)}" aria-label="Annuler la réponse">×</button>` : ""}
        <button class="c-send" aria-label="Envoyer">➤</button></form>
    </div>` : ""}
  </div>`;
}
const firstName = n => String(n || "").split(" ")[0];
const replyTo = {};
function commentHTML(c, replies = [], isReply = false) {
  const likes = c.likes || [], liked = likes.includes(me.uid), nm = memberOf(c.uid).name || c.name;
  return `<div class="comment ${isReply ? "reply" : ""}">${avatar(nm, "sm")}
    <div class="cbody"><div class="bubble"><strong>${esc(nm)}</strong> ${nameTags(c.uid)}<p>${esc(c.text)}</p>
      ${likes.length ? `<span class="clikes">${HEART}${likes.length}</span>` : ""}</div>
      <small>${fmtDate(new Date(c.ts))} à ${fmtTime(new Date(c.ts))}${c._pending ? " · envoi…" : ` · <button class="link-sm ${liked ? "on" : ""}" data-clike="${esc(c.id)}">J'aime</button> · <button class="link-sm" data-reply="${esc(c.id)}">Répondre</button>`}${(c.uid === me.uid || isAdmin()) && !c._pending ? ` · <button class="link-sm" data-cdel="${esc(c.id)}">Supprimer</button>` : ""}</small>
      ${replies.map(r => commentHTML(r, [], true)).join("")}</div></div>`;
}
function lockedHTML(p) {
  const d = new Date(p.ts);
  const what = { objectif: "a envoyé ses objectifs et son programme", matin: "a fixé ses objectifs du jour", jour: "a fait son bilan du jour", semaine: "a fait son bilan de la semaine" }[p.type] || "a publié";
  const imgs = p.type === "objectif" ? objHTML(p) : p.photo ? `<img class="post-img" src="${p.photo}" alt="" loading="lazy">` : "";
  return `<article class="card post">
    <div class="post-head">${isAdmin() ? `<button class="icon-btn dark small-btn post-more" data-p="${esc(p.id)}" aria-label="Options">⋮</button>` : ""}${avatar(p.name, memberOf(p.uid).role === "admin" ? "admin" : "")}
      <div class="meta"><strong>${esc(memberOf(p.uid).name || p.name)} ${nameTags(p.uid)}</strong><small>${fmtDate(d)} à ${fmtTime(d)} · ${TYPES[p.type]}</small></div></div>
    ${imgs || `<div class="locked">🔒 ${esc((memberOf(p.uid).name || p.name).split(" ")[0])} ${what}. Le détail est privé.</div>`}
    ${p.id && !p._pending ? socialHTML(p) : ""}
  </article>`;
}
function itemsHTML(p) {
  const bilan = posts.find(x => x.uid === p.uid && x.type === "jour" && x.day === p.day && x.tasks);
  const st = it => { if (!bilan) return ""; const i = bilan.tasks.findIndex(t => t.t.trim().toLowerCase() === it.trim().toLowerCase()); return i < 0 ? "" : (bilan.doneIdx || []).includes(i) ? "ok" : "ko"; };
  return `<ul class="day-items">${(p.items || []).map(it => { const c = st(it); return `<li class="${c}"><span class="box">${c === "ok" ? "✓" : c === "ko" ? "✕" : ""}</span>${esc(it)}</li>`; }).join("")}</ul>`;
}
function tasksHTML(p) {
  return `<ul class="day-items">${p.tasks.map((t, i) => { const c = (p.doneIdx || []).includes(i) ? "ok" : "ko"; return `<li class="${c}"><span class="box">${c === "ok" ? "✓" : "✕"}</span>${t.time ? `<b class="tt">${esc(t.time)}</b>` : ""}${esc(t.t)}</li>`; }).join("")}</ul>`;
}
function tabs() {
  const n = unreadNotifs(), m = unreadMsgs();
  const t = (k, icon, label, badge = 0) => `<button class="tab ${view === k || (k === "messages" && view === "chat") ? "on" : ""}" data-tab="${k}" aria-label="${label}">${icon}${badge ? `<span class="tbadge">${badge > 9 ? "9+" : badge}</span>` : ""}<small>${label}</small></button>`;
  return `<nav class="tabs">${t("fil", ICON.home, "Accueil")}${t("messages", ICON.chat, "Messages", m)}${t("notifs", ICON.bell, "Notifications", n)}${t("membres", ICON.people, "Membres")}${t("guide", ICON.book, "Guide")}</nav>`;
}
const ICON = {
  home: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3C6.5 3 2 6.9 2 11.7c0 2.6 1.3 4.9 3.4 6.5L5 22l3.9-2c1 .3 2 .4 3.1.4 5.5 0 10-3.9 10-8.7S17.5 3 12 3z"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0"/></svg>`,
  people: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14.6c2.6.2 4.4 1.9 5 4.9"/></svg>`,
  book: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z"/></svg>`
};
function messagesView() {
  if (!isAdmin()) return chatView(me.uid);
  const list = members.filter(m => m.status === "approved" && m.role !== "admin");
  const byUid = Object.fromEntries(convos.map(c => [c.uid, c]));
  const sorted = [...list].sort((a, b) => ((byUid[b.uid] || {}).lastTs || 0) - ((byUid[a.uid] || {}).lastTs || 0));
  return `${header()}<main class="page">
  <section class="card pad-in"><button class="btn btn-primary" id="bcast">✉️ Écrire le même message à tous les membres</button>
    <p class="hint">Chaque membre le reçoit dans sa messagerie privée, avec une notification.</p></section>
  <div class="section-head"><h2>Discussions</h2></div>
  <section class="card list">${sorted.map(m => { const c = byUid[m.uid], un = convoUnread(c);
    return `<button class="member convo-row ${un ? "unread" : ""}" data-chat="${m.uid}">${avatar(m.name)}
      <div class="meta"><strong>${esc(m.name)}</strong><small>${c ? `${c.lastFrom === "admin" ? "Toi : " : c.lastFrom === "assistante" ? "Assistante : " : ""}${esc(c.last || "")} · ${fmtTime(new Date(c.lastTs))}` : "Aucun message"}</small></div>
      ${un ? `<span class="dot-un"></span>` : ""}</button>`; }).join("") || `<div class="empty">Aucun membre pour l'instant.</div>`}</section></main>`;
}
function chatView(uid) {
  const admin = isAdmin(), m = memberOf(uid);
  const list = admin ? chatMsgs : msgs;
  const title = admin ? m.name : `${ADMIN_NAME}`;
  return `${header()}<main class="page chat">
  <div class="chat-head card">${admin ? `<button class="icon-btn dark small-btn" id="chat-back" aria-label="Retour">‹</button>` : ""}${avatar(title, admin ? "" : "admin")}
    <div class="meta"><strong>${esc(title)}</strong><small>${admin ? esc(m.email || "") : "Fondateur · et l'assistante du cercle"}</small></div>
    ${admin && m.whatsapp ? `<a class="btn btn-secondary btn-sm" href="${waLink(m.whatsapp, "")}" target="_blank" rel="noopener">WhatsApp</a>` : ""}</div>
  <div class="msgs" id="msgs">${list.map(x => { const mine = admin ? x.from === "admin" : x.from === me.uid;
    return `<div class="msg ${mine ? "me" : ""} ${x.from === "assistante" ? "bot" : ""}">${!mine && SENDER(x.from) ? `<span class="who">${SENDER(x.from)}</span>` : ""}
      <div class="mb">${linkify(x.text)}</div><small>${fmtDate(new Date(x.ts))} à ${fmtTime(new Date(x.ts))}${x._pending ? " · envoi…" : ""}</small></div>`; }).join("") ||
    `<div class="empty">${admin ? "Écris ton premier message à " + esc(firstName(m.name)) + "." : "Ici tu reçois les messages de " + ADMIN_NAME + " et de l'assistante. Tu peux répondre."}</div>`}</div>
  <form class="c-form chat-form" id="chat-form"><input class="c-input" id="chat-in" maxlength="1000" placeholder="Écris un message…" autocomplete="off"><button class="c-send" aria-label="Envoyer">➤</button></form>
  </main>`;
}
let chatMsgs = [];
function openChat(uid) {
  if (chatUnsub) chatUnsub();
  chatUid = uid; chatMsgs = []; view = "chat";
  chatUnsub = onSnapshot(query(collection(db, "convos", uid, "msgs"), orderBy("ts", "asc"), limit(300)), { includeMetadataChanges: true }, snap => {
    chatMsgs = snap.docs.map(d => ({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites })); render(); }, () => {});
  render();
}
const linkify = t => esc(t).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, "<br>");
const waLink = (num, text) => `https://wa.me/${String(num).replace(/\D/g, "")}${text ? "?text=" + encodeURIComponent(text) : ""}`;
const NICON = { like: "❤️", clike: "❤️", comment: "💬", reply: "↩️", maj: "✨", assistante: "🤖", admin: "📣" };
function notifsView() {
  const seen = notifMeta.seen || 0;
  return `${header()}<main class="page"><div class="section-head"><h2>Notifications</h2></div>
  <section class="card list">${notifs.map(n => `<button class="member notif ${n.ts > seen ? "unread" : ""}" data-notif="${esc(n.id)}">
    <span class="nicon">${NICON[n.kind] || "🔔"}</span><div class="meta"><strong class="ntext">${esc(n.text)}</strong><small>${fmtDate(new Date(n.ts))} à ${fmtTime(new Date(n.ts))}</small></div>
    ${n.ts > seen ? `<span class="dot-un"></span>` : ""}</button>`).join("") || `<div class="empty">Aucune notification pour l'instant.</div>`}</section></main>`;
}
function openBroadcast() {
  $("#layer").innerHTML = "";
  const wrap = document.createElement("div"); wrap.className = "sheet";
  const list = members.filter(m => m.status === "approved" && m.role !== "admin");
  wrap.innerHTML = `<div class="panel" role="dialog" aria-label="Message à tous">
    <div class="sheet-head"><h2>Message à tous les membres</h2><button class="icon-btn dark" id="x" aria-label="Fermer">×</button></div>
    <p class="hint">${list.length} membre${list.length > 1 ? "s" : ""} le recevr${list.length > 1 ? "ont" : "a"} dans sa messagerie privée. Écris {prénom} pour mettre le prénom de chacun.</p>
    <textarea id="txt" maxlength="1000" placeholder="Bonjour {prénom}, …"></textarea>
    <button class="btn btn-primary" id="send">Envoyer à tous</button></div>`;
  $("#layer").appendChild(wrap);
  const close = () => { $("#layer").innerHTML = ""; render(); };
  wrap.addEventListener("click", e => { if (e.target === wrap) close(); }); $("#x").onclick = close;
  $("#send").onclick = async () => {
    const t = $("#txt").value.trim(); if (!t) return;
    $("#send").disabled = true;
    try {
      for (let i = 0; i < list.length; i += 200) {
        const b = writeBatch(db), ts = Date.now();
        list.slice(i, i + 200).forEach(m => { const text = t.replace(/\{pr[ée]nom\}/gi, firstName(m.name));
          b.set(doc(collection(db, "convos", m.uid, "msgs")), { from: "admin", text, ts, groupe: true });
          b.set(doc(db, "convos", m.uid), { uid: m.uid, name: m.name, last: text.slice(0, 140), lastTs: ts, lastFrom: "admin", seenAdmin: ts }, { merge: true }); });
        await b.commit();
      }
      toast(`Message envoyé à ${list.length} membre${list.length > 1 ? "s" : ""}`); close();
    } catch (e) { $("#send").disabled = false; toast("Envoi refusé. Vérifie ta connexion."); }
  };
}
function header() {
  return `<header class="topbar"><div class="topbar-in">
    <div class="brandbox"><div class="wordmark small">cercle tb</div><div class="school">École de discipline de ${ADMIN_NAME}</div></div>
    <div class="top-right">
      <span class="net ${online ? "" : "off"}">${online ? "En ligne" : "Hors ligne"}</span>
      <button class="icon-btn" id="menu" aria-label="Menu">⋮</button>
    </div></div>${tabs()}</header>`;
}
function notifBanner() {
  if (!("Notification" in window) || Notification.permission === "granted") return "";
  const ios = /iphone|ipad/i.test(navigator.userAgent) && !navigator.standalone;
  return `<div class="card banner"><span>${ios ? "Sur iPhone : Partager → « Sur l'écran d'accueil », puis ouvre l'app depuis l'icône pour activer les rappels." : "Active les rappels pour être prévenu à 23h30 et le dimanche."}</span>
    ${ios ? "" : `<button class="btn btn-primary btn-sm" id="notif">Activer</button>`}</div>`;
}
function todo(s) {
  const now = new Date(), sun = now.getDay() === 0;
  let t = null;
  if (sun && (now.getHours() * 60 + now.getMinutes()) >= 20 * 60 + 30 && !s.obj) t = ["objectif", "Tes objectifs et ton programme de la semaine ne sont pas encore envoyés", "Les envoyer"];
  else if (sun && (now.getHours() * 60 + now.getMinutes()) < 20 * 60 + 30 && !posts.some(p => p.uid === me.uid && p.type === "semaine" && p.day === dayKey(now))) t = ["semaine", "Fais le bilan de ta semaine", "Faire mon bilan de semaine"];
  else if (!sun && !s.matin && !s.today && now.getHours() >= 4 && now.getHours() < 13) t = ["matin", "Fixe tes objectifs du jour avant de commencer", "Écrire mes objectifs du jour"];
  else if (!sun && !s.today && now.getHours() >= 18) t = ["jour", "Ton bilan du jour t'attend", "Faire mon bilan du jour"];
  else if (!s.obj && !sun) t = ["objectif", "Tu n'as pas encore envoyé tes objectifs et ton programme de la semaine", "Les envoyer"];
  if (!t) return s.today ? `<div class="card done">Bilan du jour envoyé. Bravo, continue comme ça !</div>` : "";
  return `<div class="card cta"><span>${t[1]}</span><button class="btn btn-primary btn-sm" data-open="${t[0]}">${t[2]}</button></div>`;
}
function filView() {
  const n = nextReminder(), s = statsFor(me.uid), ws = weekStart(new Date());
  const list = posts.filter(p => filter === "tout" || p.type === filter || (filter === "moi" && p.uid === me.uid));
  const labels = { tout: "Toutes les publications", objectif: "Objectifs", matin: "Objectifs du jour", jour: "Bilans du jour", semaine: "Bilans de semaine", message: "Messages", moi: "Mes publications" };
  const warns = (myDoc && myDoc.warnings) || [];
  const pend = members.filter(m => m.status === "pending").length;
  const needWa = !myDoc.whatsapp && !isAdmin();
  return `${header()}${ticker()}<main class="page">${notifBanner()}
  ${needWa ? `<form class="card banner wa-ask" id="wa-form"><span>Ajoute ton numéro WhatsApp pour que ${ADMIN_NAME} puisse te joindre.</span>
    <div class="row"><input class="field" id="wa-in" type="tel" placeholder="+229…" maxlength="20"><button class="btn btn-primary btn-sm">OK</button></div></form>` : ""}
  ${isAdmin() && pend ? `<button class="card banner admin-alert" id="go-dem"><span><b>${pend} demande${pend > 1 ? "s" : ""}</b> en attente de ta validation</span><span class="chev">›</span></button>` : ""}
  ${warns.length ? `<div class="card warn"><b>Mise en garde de ${ADMIN_NAME}</b>${warns.slice(-2).map(w => `<p>${esc(w.text)}<small> · ${fmtDate(new Date(w.ts))}</small></p>`).join("")}</div>` : ""}
  <section class="card composer" id="composer">
    ${avatar(me.name)}
    <button class="composer-input" id="compose">Partage ton objectif ou ton bilan…</button>
  </section>
  ${todo(s)}
  <section class="card summary">
    <div class="sum-row">
      <div><b>${s.streak}</b><span>jour${s.streak > 1 ? "s" : ""} 0 scroll</span></div>
      <div><b>${s.obj ? "Envoyé" : "À faire"}</b><span>objectif sem. du ${ws.getDate()} ${MOIS[ws.getMonth()]}</span></div>
      <div><b>${s.done}</b><span>objectif${s.done > 1 ? "s" : ""} atteint${s.done > 1 ? "s" : ""}</span></div>
    </div>
    <div class="next"><span class="next-label">Prochain rappel</span><span>${fmtDate(n.t)} à ${fmtTime(n.t)} · ${n.what}</span></div>
  </section>
  <div class="section-head"><h2>${labels[filter]}</h2><button class="icon-btn dark" id="flt" aria-label="Filtrer">⋮</button></div>
  ${list.length ? list.map(postHTML).join("") : `<div class="card empty">Aucune publication pour l'instant.<br>Partage ton objectif de la semaine pour lancer le groupe.</div>`}
  </main>`;
}
function memberRow(m, admin) {
  const s = statsFor(m.uid), inact = daysInactive(m), fail = twoWeeksFailed(m.uid);
  const flags = admin && m.role !== "admin" ? [
    m.status === "blocked" ? `<span class="tag ko">Bloqué</span>` : "",
    m.status === "approved" && inact >= 7 ? `<span class="tag ko">Inactif ${inact} j</span>` : "",
    fail ? `<span class="tag ko">2 semaines non tenues</span>` : "",
    (m.warnings || []).length ? `<span class="tag">${m.warnings.length} mise${m.warnings.length > 1 ? "s" : ""} en garde</span>` : ""
  ].join("") : "";
  return `<div class="member">
    ${avatar(m.name, m.role === "admin" ? "admin" : "")}
    <div class="meta"><strong>${esc(m.name)}${m.uid === me.uid ? " (toi)" : ""} ${nameTags(m.uid)}</strong>
      <small>${m.uid === me.uid ? `${s.streak} j 0 scroll · ${s.done} objectif${s.done > 1 ? "s" : ""} atteint${s.done > 1 ? "s" : ""}` : lastJour(m.uid) ? `Dernier bilan : ${fmtDate(new Date(lastJour(m.uid)))} · résultats privés` : "Aucun bilan pour l'instant"}</small>
      ${flags ? `<div class="flags">${flags}</div>` : ""}</div>
    ${admin && m.role !== "admin" ? `<button class="icon-btn dark small-btn" data-m="${m.uid}" aria-label="Actions">⋮</button>` :
      m.role === "admin" ? "" : `<span class="tag ${s.obj ? "ok" : "ko"}">${s.obj ? "Objectif envoyé" : "Sans objectif"}</span>`}</div>`;
}
function membresView() {
  const admin = isAdmin();
  const list = members.filter(m => m.status === "approved" || (admin && m.status === "blocked"));
  const founder = list.find(m => m.role === "admin");
  const others = list.filter(m => m.role !== "admin").sort((a, b) => statsFor(b.uid).streak - statsFor(a.uid).streak);
  return `${header()}<main class="page">
  <section class="card founder-card">
    <div class="av admin big">${esc(ADMIN_NAME[0])}</div>
    <div class="meta"><strong>${ADMIN_NAME}</strong><small>Fondateur et responsable de l'école de discipline</small></div>
  </section>
  <div class="section-head"><h2>Membres · ${others.filter(m => m.status === "approved").length}</h2></div>
  <section class="card list">
  ${others.map(m => memberRow(m, admin)).join("") || `<div class="empty">Aucun membre pour l'instant.</div>`}
  </section>${founder ? "" : ""}</main>`;
}
function demandesView() {
  const list = members.filter(m => m.status === "pending" || m.status === "refused").sort((a, b) => (b.joined || 0) - (a.joined || 0));
  return `${header()}<main class="page">
  <div class="section-head"><h2>Demandes d'accès</h2></div>
  <section class="card list">
  ${list.map(m => `<div class="member">${avatar(m.name)}
    <div class="meta"><strong>${esc(m.name)}</strong><small>${esc(m.email || "")} · ${m.joined ? fmtDate(new Date(m.joined)) : ""}</small>
    ${m.status === "refused" ? `<div class="flags"><span class="tag ko">Refusée</span></div>` : ""}</div>
    <button class="icon-btn dark small-btn" data-d="${m.uid}" aria-label="Décider">⋮</button></div>`).join("") || `<div class="empty">Aucune demande en attente.</div>`}
  </section></main>`;
}
function gateView() {
  const st = myDoc ? myDoc.status : "loading";
  const box = (title, text, extra = "") => `<div class="login"><div class="login-brand"><div class="wordmark">cercle tb</div>
    <p class="welcome">Bienvenue à l'école de discipline de <b>${ADMIN_NAME}</b></p></div>
    <div class="login-card gate"><h2>${title}</h2><p>${text}</p>${extra}<hr><button class="btn btn-secondary" id="out">Se déconnecter</button></div></div>`;
  if (st === "loading") return `<div class="splash"><div class="wordmark">cercle tb</div></div>`;
  if (st === "verify") return box("Confirme ton adresse e-mail", `Un lien a été envoyé à <b>${esc(me.email)}</b>. Ouvre-le, puis reviens ici.`,
    `<button class="btn btn-primary" id="verified">J'ai confirmé</button><button class="link" id="resend">Renvoyer le lien</button>`);
  if (st === "pending") return box("Demande envoyée", `Ta demande pour rejoindre le cercle a été envoyée à <b>${ADMIN_NAME}</b>. Tu auras accès dès qu'il l'aura validée.`);
  if (st === "refused") return box("Demande refusée", `${ADMIN_NAME} n'a pas validé ta demande pour le moment.`);
  if (st === "blocked") return box("Accès suspendu", `Ton accès a été suspendu${myDoc.blockedReason ? ` : ${esc(myDoc.blockedReason)}` : ""}. Contacte ${ADMIN_NAME} pour revenir dans le cercle.`);
  return box("Accès en attente", "Patiente quelques instants.");
}
function render() {
  if (!me) return;
  if ($("#layer .sheet") || mediaPlaying) return; // ne pas effacer une saisie ni couper une vidéo
  const drafts = {}; document.querySelectorAll(".c-input").forEach(i => { if (i.value) drafts[i.id] = i.value; });
  const focusId = document.activeElement && document.activeElement.classList.contains("c-input") ? document.activeElement.id : null;
  if (!myDoc || myDoc.status !== "approved") {
    $("#app").innerHTML = gateView();
    if ($("#out")) $("#out").onclick = () => signOut(auth);
    if ($("#resend")) $("#resend").onclick = async () => { try { await sendEmailVerification(auth.currentUser); toast("Lien renvoyé"); } catch (e) { toast("Réessaie dans quelques minutes."); } };
    if ($("#verified")) $("#verified").onclick = async () => {
      await auth.currentUser.reload(); await auth.currentUser.getIdToken(true);
      if (auth.currentUser.emailVerified) { const u = auth.currentUser; me = null; start(u); } else toast("Pas encore confirmé. Ouvre le lien reçu par e-mail.");
    };
    if (myDoc && myDoc.status === "verify" && !me.verifySent) { me.verifySent = true; sendEmailVerification(auth.currentUser).catch(() => {}); }
    return;
  }
  const admin = isAdmin();
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (standalone && !myDoc.installed && !me.instSent) { me.instSent = true; updateDoc(doc(db, "members", me.uid), { installed: true, installedAt: Date.now() }).catch(() => {}); }
  if (view === "demandes" && !admin) view = "fil";
  if (view === "chat" && !admin) view = "messages";
  const V = { membres: membresView, demandes: demandesView, messages: messagesView, notifs: notifsView, chat: () => chatView(chatUid), guide: guideView, avis: avisView };
  $("#app").innerHTML = (V[view] || filView)();
  bindTabs();
  const pend = members.filter(m => m.status === "pending").length;
  $("#menu").onclick = () => openMenu([
    ["fil", "Fil du groupe", "Objectifs et bilans de tous"],
    ["membres", "Membres", admin ? "Mises en garde, badges, blocage" : "Qui est dans le cercle"],
    ...(admin ? [["demandes", `Demandes d'accès${pend ? ` (${pend})` : ""}`, "Valider les nouveaux membres"]] : []),
    ["guide", "Guide en images", "Installer, s'inscrire, publier, faire ses bilans"],
    ["avis", admin ? "Avis des membres" : "Donner mon avis", admin ? "Ce que les membres pensent de l'app" : "Ce qui te plaît, ce qui manque"],
    ["notif", "Activer les rappels", "23h30 et le dimanche"],
    ["install", "Installer l'application", "Icône sur l'écran d'accueil"],
    ["out", "Se déconnecter", esc(me.email)]
  ], k => {
    if (k === "fil" || k === "membres" || k === "demandes" || k === "guide") { view = k; render(); scrollTo(0, 0); }
    if (k === "avis") { if (admin) { view = "avis"; render(); scrollTo(0, 0); } else openAvis(); }
    if (k === "notif") enableNotifs();
    if (k === "install") install();
    if (k === "out") signOut(auth);
  }, $("#menu").parentElement, view);
  if ($("#notif")) $("#notif").onclick = enableNotifs;
  if ($("#wa-form")) $("#wa-form").onsubmit = e => { e.preventDefault(); const v = $("#wa-in").value.replace(/[^\d+]/g, "");
    if (v.replace(/\D/g, "").length < 8) { toast("Numéro incomplet : mets l'indicatif."); return; }
    updateDoc(doc(db, "members", me.uid), { whatsapp: v }).then(() => toast("Numéro enregistré")).catch(() => toast("Enregistrement refusé.")); };
  document.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openSheet(b.dataset.open));
  Object.entries(drafts).forEach(([id, v]) => { const i = document.getElementById(id); if (i) i.value = v; });
  if (focusId && document.getElementById(focusId)) document.getElementById(focusId).focus();
  bindSocial();
  if ($("#go-dem")) $("#go-dem").onclick = () => { view = "demandes"; render(); scrollTo(0, 0); };
  if ($("#compose")) $("#compose").onclick = () => openMenu([
    ["objectif", "Objectifs et programme de la semaine", "Obligatoires en début de semaine"],
    ["matin", "Objectifs du jour", "Ce que tu vas accomplir aujourd'hui"],
    ["jour", "Bilan du jour", "0 scroll ? Ce que tu as fait"],
    ["semaine", "Bilan de la semaine", "Objectif atteint ou pas"],
    ["message", "Message au groupe", "Encourager, poser une question"]
  ], k => openSheet(k), $("#composer"));
  if ($("#flt")) $("#flt").onclick = () => openMenu([
    ["tout", "Toutes les publications", ""], ["objectif", "Objectifs", ""], ["matin", "Objectifs du jour", ""], ["jour", "Bilans du jour", ""],
    ["semaine", "Bilans de semaine", ""], ["message", "Messages", ""], ["moi", "Mes publications", ""]
  ], k => { filter = k; render(); }, $("#flt").parentElement, filter);
  document.querySelectorAll("[data-p]").forEach(b => b.onclick = () => {
    const id = b.dataset.p, post = posts.find(x => x.id === id) || {};
    const canEdit = post.type === "objectif" && post.uid === me.uid;
    const canVis = post.uid === me.uid && post.type !== "message";
    openMenu([...(canEdit ? [["edit", "Modifier", "Objectifs et programme de la semaine"]] : []),
      ...(canVis ? [post.prive ? ["pub", "Rendre public", "Tout le cercle verra le détail"] : ["priv", "Rendre privé", "Le détail ne sera visible que par toi"]] : []),
      ["del", "Supprimer la publication", "Action définitive"]], k => {
      if (k === "edit") { openSheet("objectif", post); return; }
      if (k === "pub" || k === "priv") { setVisibility(post, k === "pub"); return; }
      openMenu([["yes", "Oui, supprimer", ""], ["no", "Annuler", ""]], k => {
        if (k !== "yes") return;
        deleteDoc(doc(db, "posts", id)).then(() => toast("Publication supprimée")).catch(() => toast("Suppression refusée"));
        if (canEdit && post.week) deleteDoc(doc(db, "prives", me.uid, "semaines", post.week)).catch(() => {});
        if (post.uid === me.uid) deleteDoc(doc(db, "prives", me.uid, "posts", id)).catch(() => {});
      }, b.parentElement);
    }, b.parentElement);
  });
  document.querySelectorAll("[data-d]").forEach(b => b.onclick = () => {
    const uid = b.dataset.d;
    openMenu([["ok", "Accepter", "Donner accès au cercle"], ["no", "Refuser", "La personne ne verra rien du cercle"]], k => {
      if (k === "ok") setMember(uid, { status: "approved", approvedAt: Date.now(), unblockedAt: Date.now() }).then(() => toast("Membre accepté"));
      if (k === "no") setMember(uid, { status: "refused" }).then(() => toast("Demande refusée"));
    }, b.parentElement);
  });
  document.querySelectorAll("[data-m]").forEach(b => b.onclick = () => {
    const m = memberOf(b.dataset.m), blocked = m.status === "blocked";
    const has = m.badges || [];
    openMenu([
      ["msg", "Message privé", "Dans sa messagerie de l'app"],
      ...(m.whatsapp ? [["wa", "Écrire sur WhatsApp", esc(m.whatsapp)]] : [["nowa", "WhatsApp", "Numéro pas encore renseigné"]]),
      ["warn", "Mettre en garde", "Message visible uniquement par ce membre"],
      ["badge", "Donner un badge", has.length ? `Actuel : ${esc(has.join(", "))}` : "Récompenser sa discipline"],
      ...(has.length ? [["unbadge", "Retirer les badges", ""]] : []),
      ...((m.warnings || []).length ? [["clear", "Effacer les mises en garde", ""]] : []),
      [blocked ? "unblock" : "block", blocked ? "Débloquer" : "Bloquer l'accès", blocked ? "Le membre revient dans le cercle" : "Le membre ne voit plus le cercle"]
    ], k => {
      if (k === "msg") openChat(m.uid);
      if (k === "wa") window.open(waLink(m.whatsapp, `Bonjour ${firstName(m.name)}, c'est ${ADMIN_NAME} du Cercle TB. `), "_blank");
      if (k === "nowa") toast("Ce membre n'a pas encore ajouté son numéro.");
      if (k === "warn") openWarn(m);
      if (k === "badge") openMenu(BADGES.filter(x => !has.includes(x)).map(x => [x, x, ""]), x => setMember(m.uid, { badges: arrayUnion(x) }).then(() => toast("Badge donné")), b.parentElement);
      if (k === "unbadge") setMember(m.uid, { badges: [] });
      if (k === "clear") setMember(m.uid, { warnings: [] });
      if (k === "block") setMember(m.uid, { status: "blocked", blockedReason: "Décision de l'administrateur", blockedAt: Date.now() });
      if (k === "unblock") setMember(m.uid, { status: "approved", blockedReason: null, unblockedAt: Date.now() });
    }, b.parentElement);
  });
}
function bindTabs() {
  document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { goTab(b.dataset.tab); });
  if (view === "notifs" && unreadNotifs()) setDoc(doc(db, "notifs", me.uid), { seen: Date.now() }, { merge: true }).catch(() => {});
  const markRead = c => { if (convoUnread(c)) setDoc(doc(db, "convos", c.uid), isAdmin() ? { seenAdmin: Date.now() } : { seenMember: Date.now() }, { merge: true }).catch(() => {}); };
  if (view === "messages" && !isAdmin() && convo) markRead({ ...convo, uid: me.uid });
  if (view === "chat" && isAdmin()) { const c = convos.find(x => x.uid === chatUid); if (c) markRead(c); }
  // Fondateur seulement : télécharger ou partager les images du guide (statut WhatsApp, etc.)
  const shareImgs = async (names, title) => {
    try {
      const files = await Promise.all(names.map(async n => new File([await (await fetch(`guide/${n}.jpg`)).blob()], `cercle-tb-${n}.jpg`, { type: "image/jpeg" })));
      if (navigator.canShare && navigator.canShare({ files })) await navigator.share({ files, title, text: `${title} · Cercle TB : https://cercle-tb.web.app` });
      else { files.forEach(f => { const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); }); toast("Images téléchargées dans ta galerie / tes téléchargements"); }
    } catch (e) { if (e.name !== "AbortError") toast("Partage impossible. Utilise « Télécharger » sous chaque image."); }
  };
  if (isAdmin()) {
    document.querySelectorAll("[data-gshare]").forEach(b => b.onclick = () => { const g = GUIDE.find(x => x[0] === b.dataset.gshare); shareImgs(g[2], g[1].replace(/^\d+\.\s*/, "")); });
    document.querySelectorAll("[data-gone]").forEach(b => b.onclick = () => { const g = GUIDE.find(x => x[2].includes(b.dataset.gone)); shareImgs([b.dataset.gone], g ? g[1].replace(/^\d+\.\s*/, "") : "Guide"); });
  }
  document.querySelectorAll("[data-g]").forEach(d => d.ontoggle = () => d.open ? guideOpen.add(d.dataset.g) : guideOpen.delete(d.dataset.g));
  document.querySelectorAll("[data-chat]").forEach(b => b.onclick = () => openChat(b.dataset.chat));
  if ($("#chat-back")) $("#chat-back").onclick = () => { if (chatUnsub) chatUnsub(); chatUnsub = null; view = "messages"; render(); };
  if ($("#bcast")) $("#bcast").onclick = openBroadcast;
  const box = $("#msgs"); if (box) box.lastElementChild?.scrollIntoView({ block: "end" });
  if ($("#chat-form")) $("#chat-form").onsubmit = e => {
    e.preventDefault(); const i = $("#chat-in"), t = i.value.trim(); if (!t) return; i.value = "";
    const uid = isAdmin() ? chatUid : me.uid;
    sendMsg(uid, t, isAdmin() ? "admin" : me.uid).catch(() => toast("Message refusé. Vérifie ta connexion."));
  };
  document.querySelectorAll("[data-notif]").forEach(b => b.onclick = () => {
    const n = notifs.find(x => x.id === b.dataset.notif); if (!n) return;
    if (n.postId) { view = "fil"; filter = "tout"; openCom.add(n.postId); render(); setTimeout(() => document.querySelector(`[data-com="${n.postId}"]`)?.scrollIntoView({ block: "center" }), 50); }
    else if (n.kind === "assistante" || n.kind === "admin") goTab("messages");
    else if (n.kind === "maj") goTab("guide");
  });
}
function goTab(k) { if (k !== "chat" && chatUnsub && k !== "messages") { chatUnsub(); chatUnsub = null; } view = k; render(); scrollTo(0, 0); }
function openAvis(kind = "semaine") {
  $("#layer").innerHTML = "";
  const wrap = document.createElement("div"); wrap.className = "sheet";
  const inst = kind === "installation";
  wrap.innerHTML = `<div class="panel" role="dialog" aria-label="Ton avis">
    <div class="sheet-head"><h2>${inst ? "Pourquoi tu n'as pas installé l'app ?" : "Ton avis sur l'application"}</h2><button class="icon-btn dark" id="x" aria-label="Fermer">×</button></div>
    ${inst ? `<div class="visg">${["Je ne sais pas comment faire", "Je n'ai pas assez d'espace", "Je n'ai pas Chrome", "Ça ne marche pas sur mon téléphone", "Autre raison"].map((r, i) => `<button type="button" class="mode" data-r="${esc(r)}" aria-pressed="${i === 0}"><b>${r}</b></button>`).join("")}</div>
      <textarea id="a3" maxlength="600" placeholder="Explique en quelques mots (facultatif)"></textarea>` :
    `<span class="label">Ta note</span><div class="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="star" data-n="${n}" aria-label="${n} sur 5">★</button>`).join("")}</div>
    <textarea id="a1" maxlength="600" placeholder="Ce qui te plaît dans l'application"></textarea>
    <textarea id="a2" maxlength="600" placeholder="Ce qui manque ou ce qui te gêne"></textarea>
    <textarea id="a3" maxlength="600" placeholder="Tes idées pour la rendre plus agréable"></textarea>`}
    <p class="hint">Seul ${ADMIN_NAME} lit les avis.</p>
    <button class="btn btn-primary" id="send">Envoyer</button></div>`;
  $("#layer").appendChild(wrap);
  const close = () => { $("#layer").innerHTML = ""; render(); };
  wrap.addEventListener("click", e => { if (e.target === wrap) close(); }); $("#x").onclick = close;
  let note = 0, raison = inst ? "Je ne sais pas comment faire" : "";
  wrap.querySelectorAll(".star").forEach(b => b.onclick = () => { note = +b.dataset.n; wrap.querySelectorAll(".star").forEach(o => o.classList.toggle("on", +o.dataset.n <= note)); });
  wrap.querySelectorAll("[data-r]").forEach(b => b.onclick = () => { raison = b.dataset.r; wrap.querySelectorAll("[data-r]").forEach(o => o.setAttribute("aria-pressed", o === b)); });
  $("#send").onclick = () => {
    const a = { uid: me.uid, name: me.name, kind, ts: Date.now(), week: weekKey(new Date()), note, raison,
      plait: $("#a1") ? $("#a1").value.trim() : "", manque: $("#a2") ? $("#a2").value.trim() : "", idees: $("#a3").value.trim() };
    if (!inst && !note && !a.plait && !a.manque && !a.idees) { toast("Donne au moins une note ou un mot."); return; }
    setDoc(doc(collection(db, "avis")), a).then(() => toast("Merci pour ton avis !")).catch(() => toast("Envoi refusé. Vérifie ta connexion."));
    close();
  };
}
let avisList = null;
function avisView() {
  if (avisList === null) { avisList = []; getDocs(query(collection(db, "avis"), orderBy("ts", "desc"), limit(200))).then(sn => { avisList = sn.docs.map(d => d.data()); render(); }).catch(() => {}); }
  const notes = avisList.filter(a => a.note), moy = notes.length ? (notes.reduce((x, a) => x + a.note, 0) / notes.length).toFixed(1) : "–";
  return `${header()}<main class="page"><section class="card pad-in"><div class="sum-row"><div><b>${moy}</b><span>note moyenne / 5</span></div><div><b>${avisList.length}</b><span>avis reçus</span></div></div></section>
  <div class="section-head"><h2>Avis des membres</h2></div>
  ${avisList.map(a => `<article class="card post"><div class="post-head">${avatar(a.name)}<div class="meta"><strong>${esc(a.name)}</strong><small>${fmtDate(new Date(a.ts))} · ${a.kind === "installation" ? "Pas installé : " + esc(a.raison) : a.note ? "★".repeat(a.note) + "☆".repeat(5 - a.note) : "Sans note"}</small></div></div>
    ${a.plait ? `<p class="post-text"><b>👍 </b>${esc(a.plait)}</p>` : ""}${a.manque ? `<p class="post-text"><b>⚠️ </b>${esc(a.manque)}</p>` : ""}${a.idees ? `<p class="post-text"><b>💡 </b>${esc(a.idees)}</p>` : ""}</article>`).join("") || `<div class="card empty">Aucun avis pour l'instant. L'assistante les demande chaque samedi.</div>`}</main>`;
}
const GUIDE = [
  ["installer", "1. Installer l'application", ["g-install-1", "g-install-2", "g-install-3"]],
  ["inscrire", "2. S'inscrire", ["g-inscription-1", "g-inscription-2"]],
  ["objectifs", "3. Envoyer ses objectifs et son programme de la semaine", ["g-objectif-1", "g-objectif-2", "g-objectif-3", "g-objectif-4", "g-objectif-5"]],
  ["matin", "4. Envoyer ses objectifs du jour", ["g-matin-1", "g-matin-2"]],
  ["jour", "5. Faire son bilan du jour", ["g-jour-1", "g-jour-2"]],
  ["semaine", "6. Faire son bilan de la semaine", ["g-semaine-1"]],
  ["messages", "7. Lire ses messages et notifications", ["g-messages-1"]]
];
const guideOpen = new Set(["installer"]);
function guideView() {
  return `${header()}<main class="page"><section class="card pad-in"><h2 class="g-title">Guide en images</h2><p class="hint">Chaque étape, avec une flèche rouge sur l'endroit où appuyer. Touche un titre pour l'ouvrir.</p></section>
  ${GUIDE.map(([k, t, imgs]) => `<details class="card guide" data-g="${k}" ${guideOpen.has(k) ? "open" : ""}><summary>${t}</summary>
    ${isAdmin() ? `<div class="g-admin"><button class="btn btn-primary btn-sm" data-gshare="${k}">Partager les ${imgs.length} image${imgs.length > 1 ? "s" : ""} (statut WhatsApp…)</button></div>` : ""}
    <div class="g-imgs">${imgs.map((im, i) => `<figure><img src="guide/${im}.jpg" alt="${esc(t)} · étape ${i + 1}" loading="lazy"><figcaption>Étape ${i + 1}</figcaption>
      ${isAdmin() ? `<div class="g-acts"><a class="link-sm" href="guide/${im}.jpg" download="cercle-tb-${im}.jpg">⤓ Télécharger</a><button class="link-sm" data-gone="${im}">Partager</button></div>` : ""}</figure>`).join("")}</div></details>`).join("")}
  </main>`;
}
function openWarn(m) {
  $("#layer").innerHTML = "";
  const wrap = document.createElement("div"); wrap.className = "sheet";
  const preset = twoWeeksFailed(m.uid) ? "Tu n'as pas tenu tes objectifs deux semaines de suite. Reprends-toi cette semaine." :
    `Tu n'as pas envoyé ton bilan depuis ${daysInactive(m)} jours. Sans bilan pendant 2 semaines, ton accès sera suspendu.`;
  wrap.innerHTML = `<div class="panel" role="dialog" aria-label="Mise en garde">
    <div class="sheet-head"><h2>Mettre en garde ${esc(m.name)}</h2><button class="icon-btn dark" id="x" aria-label="Fermer">×</button></div>
    <textarea id="txt" maxlength="400">${esc(preset)}</textarea>
    <button class="btn btn-primary" id="send">Envoyer la mise en garde</button></div>`;
  $("#layer").appendChild(wrap);
  const close = () => { $("#layer").innerHTML = ""; render(); };
  wrap.addEventListener("click", e => { if (e.target === wrap) close(); });
  $("#x").onclick = close;
  $("#send").onclick = () => {
    const text = $("#txt").value.trim(); if (!text) return;
    setMember(m.uid, { warnings: arrayUnion({ text, ts: Date.now() }) }).then(() => toast("Mise en garde envoyée"));
    close();
  };
}

/* ---------- j'aime, commentaires, vidéos ---------- */
function bindSocial() {
  document.querySelectorAll("[data-like]").forEach(b => b.onclick = () => {
    const id = b.dataset.like, p = posts.find(x => x.id === id); if (!p) return;
    const liked = (p.likes || []).includes(me.uid);
    p.likes = liked ? (p.likes || []).filter(u => u !== me.uid) : [...(p.likes || []), me.uid];
    render();
    updateDoc(doc(db, "posts", id), { likes: liked ? arrayRemove(me.uid) : arrayUnion(me.uid) }).catch(() => toast("Action refusée. Vérifie ta connexion."));
    if (!liked && p.uid !== me.uid) notify(p.uid, "like", `${firstName(me.name)} aime ta publication (${TYPES[p.type] || "message"})`, id);
  });
  document.querySelectorAll("[data-com]").forEach(b => b.onclick = () => {
    const id = b.dataset.com;
    if (openCom.has(id)) openCom.delete(id); else openCom.add(id);
    render();
    const i = document.getElementById("ci-" + id); if (i && openCom.has(id)) i.focus();
  });
  document.querySelectorAll("[data-cform]").forEach(f => f.onsubmit = e => {
    e.preventDefault();
    const id = f.dataset.cform, input = f.querySelector(".c-input"), text = input.value.trim();
    if (!text) return;
    input.value = "";
    const ref = doc(collection(db, "comments")), to = replyTo[id];
    const c = { postId: id, uid: me.uid, name: me.name, text, ts: Date.now(), likes: [] };
    if (to) c.parentId = to.parentId || to.id; // une réponse à une réponse reste dans le même fil
    delete replyTo[id];
    setDoc(ref, c).catch(() => toast("Commentaire refusé. Vérifie ta connexion."));
    const post = posts.find(x => x.id === id);
    if (to && to.uid !== me.uid) notify(to.uid, "reply", `${firstName(me.name)} a répondu à ton commentaire : « ${text.slice(0, 80)} »`, id);
    if (post && post.uid !== me.uid && (!to || to.uid !== post.uid)) notify(post.uid, "comment", `${firstName(me.name)} a commenté ta publication : « ${text.slice(0, 80)} »`, id);
    render();
  });
  document.querySelectorAll("[data-clike]").forEach(b => b.onclick = () => {
    const c = comments.find(x => x.id === b.dataset.clike); if (!c) return;
    const liked = (c.likes || []).includes(me.uid);
    c.likes = liked ? c.likes.filter(u => u !== me.uid) : [...(c.likes || []), me.uid]; render();
    updateDoc(doc(db, "comments", c.id), { likes: liked ? arrayRemove(me.uid) : arrayUnion(me.uid) }).catch(() => toast("Action refusée. Vérifie ta connexion."));
    if (!liked && c.uid !== me.uid) notify(c.uid, "clike", `${firstName(me.name)} aime ton commentaire : « ${c.text.slice(0, 60)} »`, c.postId);
  });
  document.querySelectorAll("[data-reply]").forEach(b => b.onclick = () => {
    const c = comments.find(x => x.id === b.dataset.reply); if (!c) return;
    replyTo[c.postId] = c; render();
    const i = document.getElementById("ci-" + c.postId); if (i) i.focus();
  });
  document.querySelectorAll("[data-rcancel]").forEach(b => b.onclick = () => { delete replyTo[b.dataset.rcancel]; render(); });
  document.querySelectorAll("[data-cdel]").forEach(b => b.onclick = () => {
    deleteDoc(doc(db, "comments", b.dataset.cdel)).then(() => toast("Commentaire supprimé")).catch(() => toast("Suppression refusée"));
  });
  document.querySelectorAll("[data-vid]").forEach(b => b.onclick = async () => {
    const id = b.dataset.vid;
    if (!navigator.onLine) { toast("La vidéo a besoin du réseau la première fois."); return; }
    b.disabled = true; b.querySelector(".vsize").textContent = "Chargement…";
    try {
      const snap = await getDocs(collection(db, "media", id, "parts"));
      const parts = snap.docs.map(d => d.data()).sort((a, c) => a.n - c.n).map(x => x.data.toUint8Array());
      mediaUrls[id] = URL.createObjectURL(new Blob(parts, { type: b.dataset.mime || "video/mp4" }));
      render();
      const v = document.querySelector(`video[src="${mediaUrls[id]}"]`); if (v) v.play().catch(() => {});
    } catch (e) { b.disabled = false; b.querySelector(".vsize").textContent = "Échec, touche pour réessayer"; }
  });
  document.querySelectorAll("video.post-video").forEach(v => {
    v.onplay = () => { mediaPlaying = true; };
    v.onpause = v.onended = () => { mediaPlaying = false; };
  });
}
const CHUNK = 900000, MAX_RAW = 7e6;
function readURL(f) { return new Promise((r, j) => { const x = new FileReader(); x.onload = () => r(x.result); x.onerror = j; x.readAsDataURL(f); }); }
async function shrinkImage(f) {
  if (f.type === "image/gif") {
    if (f.size > 700000) throw new Error("Ce GIF est trop lourd (700 Ko maximum).");
    return readURL(f);
  }
  const url = await readURL(f);
  const img = await new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = url; });
  const W = Math.min(1080, img.width), H = Math.round(img.height * W / img.width);
  const c = document.createElement("canvas"); c.width = W; c.height = H; c.getContext("2d").drawImage(img, 0, 0, W, H);
  return c.toDataURL("image/jpeg", .72);
}
async function videoPoster(url) {
  const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.src = url;
  await new Promise(r => { v.onloadeddata = r; v.onerror = r; });
  v.currentTime = Math.min(0.5, (v.duration || 1) / 2);
  await new Promise(r => { v.onseeked = r; setTimeout(r, 1500); });
  const W = 480, H = Math.round((v.videoHeight || 270) * W / (v.videoWidth || 480));
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  try { c.getContext("2d").drawImage(v, 0, 0, W, H); return c.toDataURL("image/jpeg", .6); } catch (e) { return ""; }
}
async function compressVideo(file, onProgress) {
  const v = document.createElement("video"); v.playsInline = true; v.src = URL.createObjectURL(file);
  await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error("Vidéo illisible.")); });
  if (v.duration > 120) throw new Error("Vidéo trop longue : 2 minutes maximum.");
  const cap = v.captureStream || v.mozCaptureStream;
  if (!cap || !window.MediaRecorder) throw new Error("Vidéo trop lourde (7 Mo maximum sur ce téléphone).");
  const stream = cap.call(v);
  const mime = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find(m => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 650000, audioBitsPerSecond: 64000 });
  const out = []; rec.ondataavailable = e => { if (e.data.size) out.push(e.data); };
  const done = new Promise(r => { rec.onstop = r; });
  v.ontimeupdate = () => onProgress(Math.min(1, v.currentTime / v.duration));
  v.onended = () => rec.stop();
  rec.start(1000); await v.play(); await done;
  const blob = new Blob(out, { type: mime.split(";")[0] });
  if (blob.size > 12e6) throw new Error("Vidéo encore trop lourde après réduction. Coupe-la en plus court.");
  return blob;
}
async function uploadVideo(blob) {
  const ref = doc(collection(db, "media")), bytes = new Uint8Array(await blob.arrayBuffer());
  const parts = Math.ceil(bytes.length / CHUNK);
  await setDoc(ref, { uid: me.uid, parts, size: bytes.length, mime: blob.type, ts: Date.now() });
  for (let i = 0; i < parts; i++) {
    await setDoc(doc(db, "media", ref.id, "parts", String(i)), { n: i, data: Bytes.fromUint8Array(bytes.slice(i * CHUNK, (i + 1) * CHUNK)) });
  }
  mediaUrls[ref.id] = URL.createObjectURL(blob);
  return { id: ref.id, parts, size: bytes.length, mime: blob.type };
}

/* ---------- rappels ---------- */
async function enableNotifs() {
  try {
    if (!(await isSupported())) { toast("Ton téléphone ne gère pas les rappels ici. Installe d'abord l'app."); return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Rappels refusés. Tu peux les autoriser dans les réglages."); return; }
    const reg = swReg || await navigator.serviceWorker.ready;
    if (!vapidKey || vapidKey === "A_REMPLACER") { toast("Les rappels arrivent bientôt : la configuration est en cours."); return; }
    const token = await getToken(getMessaging(fb), { vapidKey, serviceWorkerRegistration: reg });
    await setDoc(doc(db, "tokens", token), { uid: me.uid, ts: Date.now() });
    toast("Rappels activés"); render();
  } catch (e) { toast("Impossible d'activer les rappels. Réessaie avec du réseau."); }
}
async function install() {
  if (installEvt) { installEvt.prompt(); installEvt = null; return; }
  if (/iphone|ipad/i.test(navigator.userAgent)) toast("Touche Partager puis « Sur l'écran d'accueil »");
  else toast("Ouvre le menu du navigateur puis « Installer l'application »");
}

/* ---------- menus en liste ---------- */
function openMenu(items, onPick, anchor, current, _, cls) {
  document.querySelectorAll(".menu").forEach(m => m.remove());
  const m = document.createElement("div"); m.className = "menu" + (cls ? " " + cls : "");
  m.innerHTML = items.map(([k, t, s]) => `<button data-k="${k}" ${current === k ? 'aria-pressed="true"' : ""}><span>${t}</span>${s ? `<small>${s}</small>` : ""}</button>`).join("");
  if (cls) { m.style.position = "fixed"; document.body.appendChild(m); } else anchor.appendChild(m);
  setTimeout(() => document.addEventListener("click", function h(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener("click", h); } }), 0);
  m.querySelectorAll("button").forEach(b => b.onclick = () => { m.remove(); onPick(b.dataset.k); });
}
function toast(t) { const el = document.createElement("div"); el.className = "toast"; el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 2600); }

/* ---------- publier ---------- */
const JOURS_LONG = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const dayIdx = d => (new Date(d).getDay() + 6) % 7;
// Ce qui est prévu pour un jour : programme de la semaine + ce qui n'a pas été fait la veille + objectifs du matin
function dayPlan(uid, date = new Date()) {
  const dk = dayKey(date), wk = dayKey(mondayOf(date)), mine = posts.filter(p => p.uid === uid);
  const tasks = [], seen = new Set();
  const add = (t, src, time = "") => { const k = t.trim().toLowerCase(); if (!k || seen.has(k)) return; seen.add(k); tasks.push({ t: t.trim(), src, time }); };
  const obj = mine.find(p => p.type === "objectif" && p.week === wk);
  const prog = (uid === me.uid && priv[wk] && priv[wk].prog) || (obj && obj.prog);
  if (prog) prog.forEach(r => { const c = (r.cells || [])[dayIdx(date)]; if (c && c.trim()) add(c, "prog", r.from && r.to ? `${r.from}-${r.to}` : (r.from || "")); });
  const lim = Date.now() - 3 * 864e5;
  const prev = mine.filter(p => p.type === "jour" && p.day < dk && p.ts > lim && p.tasks).sort((a, b) => b.ts - a.ts)[0];
  if (prev) prev.tasks.forEach((t, i) => { if (!(prev.doneIdx || []).includes(i)) add(t.t, "report", t.time || ""); });
  const matin = mine.find(p => p.type === "matin" && p.day === dk && p.items);
  if (matin) matin.items.forEach(t => add(t, "matin"));
  return tasks;
}
function verdict(done, total) {
  const r = total ? done / total : 0;
  if (r === 1) return ["ok", "Sérieux !", "Tu as tenu toutes tes promesses aujourd'hui. Respect."];
  if (r >= .7) return ["ok", "Sérieux", "Tu as tenu l'essentiel de tes promesses. Finis le reste demain."];
  if (r >= .4) return ["mid", "Peut mieux faire", "Tu as fait la moitié du chemin. Demain, pas d'excuse."];
  return ["ko", "Paresseux irresponsable", "Tu ne tiens pas tes promesses. Ce que tu n'as pas fait passe à demain : rattrape-toi."];
}
function showVerdict(done, total) {
  const [cls, title, msg] = verdict(done, total);
  const w = document.createElement("div"); w.className = "sheet";
  w.innerHTML = `<div class="panel verdict ${cls}"><div class="v-score">${done}/${total}</div><h2>${title}</h2><p>${msg}</p>
    ${total - done ? `<p class="hint">${total - done} tâche${total - done > 1 ? "s" : ""} reportée${total - done > 1 ? "s" : ""} aux objectifs de demain.</p>` : ""}
    <button class="btn btn-primary" id="vok">Compris</button></div>`;
  $("#layer").innerHTML = ""; $("#layer").appendChild(w);
  const close = () => { $("#layer").innerHTML = ""; render(); };
  $("#vok").onclick = close; w.addEventListener("click", e => { if (e.target === w) close(); });
}
function progTable(prog) {
  const rows = (prog || []).filter(r => r.from || r.to || (r.cells || []).some(c => c && c.trim()));
  if (!rows.length) return "";
  return `<div class="prog-wrap"><table class="prog"><thead><tr><th>Horaire</th>${JOURS_LONG.map(j => `<th>${j.slice(0, 3)}.</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r => `<tr><th>${esc(r.from || "")}${r.to ? "–" + esc(r.to) : ""}</th>${(r.cells || []).map(c => `<td>${esc(c || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
// Floute (pixelise) une image ou un canvas dans le canvas donné, et renvoie l'image JPEG
function blurTo(cv, src, b) {
  const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
  const W = Math.min(1080, sw), H = Math.round(sh * W / sw); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  if (!b) ctx.drawImage(src, 0, 0, W, H);
  else {
    const f = Math.max(4, Math.round(W / (b * 5 + 2)));
    const sm = document.createElement("canvas"); sm.width = f; sm.height = Math.max(2, Math.round(H * f / W));
    sm.getContext("2d").drawImage(src, 0, 0, sm.width, sm.height);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(sm, 0, 0, W, H);
  }
  return cv.toDataURL("image/jpeg", b ? .5 : .62);
}
function wrapLines(ctx, text, maxW) {
  const out = [];
  String(text).split("\n").forEach(par => {
    let line = "";
    par.split(/\s+/).forEach(w => {
      while (ctx.measureText(w).width > maxW) { // mot trop long
        let i = w.length; while (i > 1 && ctx.measureText(w.slice(0, i)).width > maxW) i--;
        if (line) { out.push(line); line = ""; } out.push(w.slice(0, i)); w = w.slice(i);
      }
      const t = line ? line + " " + w : w;
      if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
    });
    out.push(line);
  });
  return out;
}
const FONT = '"Segoe UI", Roboto, Helvetica, Arial, sans-serif';
function textImage(title, text, name) {
  const W = 1080, M = 70, LH = 54, c = document.createElement("canvas"), x = c.getContext("2d");
  x.font = `38px ${FONT}`; const lines = wrapLines(x, text, W - 2 * M);
  c.width = W; c.height = 230 + lines.length * LH + 60;
  x.fillStyle = "#fff"; x.fillRect(0, 0, W, c.height);
  x.fillStyle = "#1877F2"; x.fillRect(0, 0, W, 14);
  x.fillStyle = "#0B1F3A"; x.font = `bold 50px ${FONT}`; x.fillText(title, M, 110);
  x.fillStyle = "#65676B"; x.font = `30px ${FONT}`; x.fillText(name, M, 160);
  x.fillStyle = "#1C1E21"; x.font = `38px ${FONT}`;
  lines.forEach((l, i) => x.fillText(l, M, 240 + i * LH));
  return c;
}
function progImage(rows, name) {
  const TW = 150, CW = 150, M = 30, W = M * 2 + TW + CW * 7, c = document.createElement("canvas"), x = c.getContext("2d");
  x.font = `21px ${FONT}`;
  const cellLines = rows.map(r => (r.cells || []).map(t => wrapLines(x, t || "", CW - 16).slice(0, 6)));
  const hs = cellLines.map(cl => Math.max(56, ...cl.map(l => l.length * 26 + 22)));
  const top = 170, head = 52;
  c.width = W; c.height = top + head + hs.reduce((a, h) => a + h, 0) + 40;
  x.fillStyle = "#fff"; x.fillRect(0, 0, W, c.height);
  x.fillStyle = "#1877F2"; x.fillRect(0, 0, W, 12);
  x.fillStyle = "#0B1F3A"; x.font = `bold 44px ${FONT}`; x.fillText("Programme de la semaine", M, 85);
  x.fillStyle = "#65676B"; x.font = `26px ${FONT}`; x.fillText(name, M, 128);
  x.fillStyle = "#E7F0FE"; x.fillRect(M, top, W - 2 * M, head);
  x.fillStyle = "#0B1F3A"; x.font = `bold 22px ${FONT}`;
  x.fillText("Horaire", M + 10, top + 33);
  JOURS_LONG.forEach((j, i) => x.fillText(j, M + TW + i * CW + 10, top + 33));
  let y = top + head;
  rows.forEach((r, ri) => {
    const h = hs[ri];
    if (ri % 2) { x.fillStyle = "#F7F9FC"; x.fillRect(M, y, W - 2 * M, h); }
    x.fillStyle = "#0B1F3A"; x.font = `bold 21px ${FONT}`;
    x.fillText(r.from || "", M + 10, y + 30); if (r.to) x.fillText("→ " + r.to, M + 10, y + 56);
    x.fillStyle = "#1C1E21"; x.font = `21px ${FONT}`;
    cellLines[ri].forEach((ls, ci) => ls.forEach((l, li) => x.fillText(l, M + TW + ci * CW + 8, y + 30 + li * 26)));
    y += h;
  });
  x.strokeStyle = "#D0D7E2"; x.lineWidth = 1.5;
  let yy = top; [head, ...hs].forEach(h => { x.strokeRect(M, yy, W - 2 * M, h); yy += h; });
  for (let i = 0; i <= 7; i++) { const xx = M + TW + i * CW; x.beginPath(); x.moveTo(i === 7 ? W - M : xx, top); x.lineTo(i === 7 ? W - M : xx, y); x.stroke(); }
  return c;
}
function openSheet(type, edit = null) {
  $("#layer").innerHTML = "";
  const wrap = document.createElement("div"); wrap.className = "sheet";
  const yesNo = (q, a, b, cls = "choice") => `<span class="label">${q}</span><div class="row"><button type="button" class="${cls}" data-v="1" aria-pressed="false">${a}</button><button type="button" class="${cls}" data-v="0" aria-pressed="false">${b}</button></div>`;
  const modeChoice = (k, q, w) => `<span class="label">${q}</span>
    <div class="modes" data-for="${k}"><button type="button" class="mode" data-mode="ecrire" aria-pressed="true"><b>L'écrire</b><small>${w}</small></button>
    <button type="button" class="mode" data-mode="photo" aria-pressed="false"><b>Envoyer une photo</b><small>Photo du papier, floutée ou non</small></button></div>`;
  const photoBlock = k => `<div class="m-photo ${type === "objectif" ? "noblur" : ""}" id="ph-${k}" hidden><p class="hint">Écris-le sur un papier, prends-le en photo, puis choisis de flouter ou non.</p>
      <label class="filebtn"><input class="pfile" data-k="${k}" type="file" accept="image/*" capture="environment"><span class="picktxt">Prendre ou choisir la photo du papier</span></label>
      <div class="photo" hidden><canvas></canvas>
        <div class="blurctl"><span>Flou</span><input class="pblur" type="range" min="0" max="10" value="6" aria-label="Intensité du flou"><span class="bv">6</span></div>
        <span class="hint">0 = sans flou. La photo est réduite pour consommer très peu de données.</span></div></div>`;
  const progGrid = `<div class="prog-wrap"><table class="prog edit"><thead><tr><th>De</th><th>À</th>${JOURS_LONG.map(j => `<th>${j}</th>`).join("")}</tr></thead>
    <tbody>${Array.from({ length: 9 }, (_, r) => `<tr><td><input type="time" class="pt-from" aria-label="Début ligne ${r + 1}"></td><td><input type="time" class="pt-to" aria-label="Fin ligne ${r + 1}"></td>
      ${JOURS_LONG.map((j, c) => `<td><input class="pt-cell" data-c="${c}" maxlength="60" aria-label="${j}, ligne ${r + 1}"></td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <p class="hint">Fais glisser le tableau vers la gauche pour voir tous les jours. Chaque soir, ce que tu as prévu pour la journée te sera rappelé.</p>`;
  const plan = type === "jour" ? dayPlan(me.uid) : [];
  const matinToday = statsFor(me.uid).matin;
  const report = type === "matin" ? dayPlan(me.uid).filter(t => t.src !== "matin") : [];
  const VIS = `${type !== "message" ? `<div class="block vis"><span class="label">Qui peut voir le détail ?</span><div class="visg">
        <button type="button" class="mode" data-vis="prive" aria-pressed="true"><b>🔒 Moi seul</b><small>Le cercle voit seulement que tu as publié</small></button>
        <button type="button" class="mode" data-vis="public" aria-pressed="false"><b>👥 Tout le cercle</b><small>Tout le monde voit tes réponses et tes résultats</small></button></div>
        <span class="hint">Tu peux changer après : ⋮ sur ta publication.</span></div>` : ""}`;
  const body = {
    objectif: `<div id="step1"><p class="hint">Pour commencer la semaine, deux choses sont obligatoires : tes objectifs et ton programme. Ce que tu écris est transformé en image : tu choisis de la flouter ou non avant de publier.</p>
      <div class="block"><h3>1. Objectifs de la semaine</h3>${modeChoice("obj", "Comment veux-tu les envoyer ?", "Taper mes objectifs directement")}${photoBlock("obj")}
      <div id="ec-obj"><textarea id="wtxt" maxlength="1500" placeholder="Mes objectifs de la semaine…"></textarea></div></div>
      <div class="block"><h3>2. Programme de la semaine</h3>${modeChoice("prog", "Comment veux-tu l'envoyer ?", "Remplir le tableau horaire")}${photoBlock("prog")}
      <div id="ec-prog">${progGrid}</div></div>
      <textarea id="txt" maxlength="400" placeholder="Un mot en plus (facultatif)"></textarea>${edit ? "" : VIS}</div>
      <div id="step2" hidden><p class="hint">Voici ce que le cercle verra. Floute si tu ne veux pas qu'on puisse lire. Le texte, lui, reste visible par toi seul.</p>
        ${["obj", "prog"].map(k => `<div class="block pv" data-pv="${k}"><h3>${k === "obj" ? "Objectifs de la semaine" : "Programme de la semaine"}</h3>
          <div class="photo"><canvas></canvas><div class="blurctl"><span>Flou</span><input class="pvblur" type="range" min="0" max="10" value="6" aria-label="Intensité du flou"><span class="bv">6</span></div>
          <span class="hint">0 = lisible par tous · 10 = illisible</span></div></div>`).join("")}
        <button type="button" class="link" id="back">‹ Revenir modifier</button></div>`,
    matin: `<p class="hint">Avant de commencer ta journée, fixe ce que tu vas accomplir. Ce soir, tu fais le point dans ton bilan.</p>
      ${report.length ? `<div class="carry"><b>Déjà prévu pour aujourd'hui</b>${report.map(t => `<span>${t.src === "report" ? "↻ Reporté d'hier · " : ""}${t.time ? esc(t.time) + " · " : ""}${esc(t.t)}</span>`).join("")}</div>` : ""}
      ${modeChoice("matin", "Comment veux-tu les envoyer ?", "Taper mes objectifs directement")}${photoBlock("matin")}
      <div id="ec-matin"><div class="items-in" id="items">${[0, 1, 2].map(i => `<input class="field item" maxlength="120" placeholder="Objectif ${i + 1}">`).join("")}</div>
      <button type="button" class="link" id="addit">+ Ajouter un objectif</button></div>
      <textarea id="txt" maxlength="400" placeholder="Un mot pour te motiver (facultatif)"></textarea>`,
    jour: `${plan.length ? `<span class="label">Ce que tu avais prévu aujourd'hui : coche ce qui est fait</span>
      <div class="checks">${plan.map((t, i) => `<label class="check"><input type="checkbox" class="chk" value="${i}"><span>${t.time ? `<b>${esc(t.time)}</b> ` : ""}${esc(t.t)}${t.src === "report" ? ` <em class="rep">reporté</em>` : ""}</span></label>`).join("")}</div>
      <p class="hint">Ce qui n'est pas coché sera ajouté à tes objectifs de demain.</p>` : ""}
      ${matinToday && matinToday.photo && !matinToday.items ? yesNo("As-tu accompli tes objectifs du jour (photo) ?", "Oui, tous", "Pas tous", "choice2") : ""}
      ${yesNo("As-tu scrollé aujourd'hui ?", "Non, 0 scroll", "Oui, j'ai scrollé")}
      <textarea id="txt" maxlength="600" placeholder="Qu'as-tu fait pour ton objectif aujourd'hui ?"></textarea>`,
    semaine: `${yesNo("As-tu atteint ton objectif de la semaine ?", "Oui, atteint", "Non, pas atteint")}
      <textarea id="txt" maxlength="600" placeholder="Ce qui a marché, ce qui a bloqué"></textarea>`,
    message: `<textarea id="txt" maxlength="1000" placeholder="Ton message au groupe"></textarea>
      ${isAdmin() ? `<label class="filebtn"><input id="mfile" type="file" accept="image/*,video/*" multiple><span>Ajouter des photos, une vidéo ou un GIF</span></label>
      <div class="media-prev" id="mprev"></div><div class="hint" id="mstat"></div>` : ""}`
  }[type];
  wrap.innerHTML = `<div class="panel" role="dialog" aria-label="${TYPES[type]}">
    <div class="sheet-head"><h2>${type === "objectif" ? (edit ? "Modifier mes objectifs et mon programme" : "Objectifs et programme de la semaine") : TYPES[type]}</h2><button class="icon-btn dark" id="x" aria-label="Fermer">×</button></div>
    ${body}${type !== "objectif" ? VIS : ""}<div class="err" id="serr"></div><button class="btn btn-primary" id="send" disabled>${type === "objectif" ? "Continuer" : "Publier"}</button></div>`;
  $("#layer").appendChild(wrap);
  const close = () => { $("#layer").innerHTML = ""; render(); };
  wrap.addEventListener("click", e => { if (e.target === wrap) close(); });
  $("#x").onclick = close;
  let choice = null, matinOk = null, busy = false, mPhotos = [], mVideo = null, prive = true;
  wrap.querySelectorAll("[data-vis]").forEach(b => b.onclick = () => { prive = b.dataset.vis === "prive"; wrap.querySelectorAll("[data-vis]").forEach(o => o.setAttribute("aria-pressed", o === b)); });
  const modes = { obj: "ecrire", prog: "ecrire", matin: "ecrire" }, imgs = {};
  const send = $("#send");
  const items = () => [...wrap.querySelectorAll(".item")].map(i => i.value.trim()).filter(Boolean);
  const progRows = () => [...wrap.querySelectorAll(".prog.edit tbody tr")].map(tr => ({
    from: tr.querySelector(".pt-from").value, to: tr.querySelector(".pt-to").value,
    cells: [...tr.querySelectorAll(".pt-cell")].map(i => i.value.trim())
  }));
  const progFilled = () => progRows().some(r => r.cells.some(Boolean));
  const check = () => {
    let ok;
    if (type === "matin") ok = modes.matin === "photo" ? !!imgs.matin : items().length > 0;
    else if (type === "objectif") ok = (modes.obj === "photo" ? !!imgs.obj : !!$("#wtxt").value.trim()) && (modes.prog === "photo" ? !!imgs.prog : progFilled());
    else if (type === "message") ok = !!(mPhotos.length || mVideo || $("#txt").value.trim());
    else ok = choice !== null && (!wrap.querySelector(".choice2") || matinOk !== null);
    send.disabled = busy || !ok;
  };
  wrap.addEventListener("input", check);
  wrap.querySelectorAll(".modes").forEach(g => g.querySelectorAll(".mode").forEach(b => b.onclick = () => {
    const k = g.dataset.for; modes[k] = b.dataset.mode;
    g.querySelectorAll(".mode").forEach(o => o.setAttribute("aria-pressed", o === b));
    $("#ph-" + k).hidden = modes[k] !== "photo"; $("#ec-" + k).hidden = modes[k] !== "ecrire";
    check();
  }));
  wrap.querySelectorAll(".m-photo").forEach(box => {
    const k = box.id.slice(3), cv = box.querySelector("canvas"), ctx = cv.getContext("2d"), blur = box.querySelector(".pblur");
    const draw = () => {
      const img = imgs["_" + k]; if (!img) return;
      const W = 720, H = Math.round(img.height * W / img.width); cv.width = W; cv.height = H;
      const b = +blur.value; box.querySelector(".bv").textContent = b;
      if (b === 0) ctx.drawImage(img, 0, 0, W, H);
      else {
        const f = Math.max(4, Math.round(W / (b * 5 + 2)));
        const sm = document.createElement("canvas"); sm.width = f; sm.height = Math.max(2, Math.round(H * f / W));
        sm.getContext("2d").drawImage(img, 0, 0, sm.width, sm.height);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(sm, 0, 0, W, H);
      }
      imgs[k] = cv.toDataURL("image/jpeg", .5);
    };
    blur.oninput = draw;
    box.querySelector(".pfile").onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => { const i = new Image(); i.onload = () => { imgs["_" + k] = i; box.querySelector(".photo").hidden = false; box.querySelector(".picktxt").textContent = "Changer la photo"; draw(); check(); }; i.src = r.result; };
      r.readAsDataURL(f);
    };
  });
  wrap.querySelectorAll(".choice").forEach(b => b.onclick = () => { choice = b.dataset.v === "1"; wrap.querySelectorAll(".choice").forEach(o => o.setAttribute("aria-pressed", o === b)); check(); });
  wrap.querySelectorAll(".choice2").forEach(b => b.onclick = () => { matinOk = b.dataset.v === "1"; wrap.querySelectorAll(".choice2").forEach(o => o.setAttribute("aria-pressed", o === b)); check(); });
  if ($("#addit")) $("#addit").onclick = () => {
    const box = $("#items"), n = box.querySelectorAll(".item").length;
    if (n >= 8) { $("#addit").hidden = true; return; }
    const i = document.createElement("input"); i.className = "field item"; i.maxLength = 120; i.placeholder = `Objectif ${n + 1}`;
    box.appendChild(i); i.focus(); if (n + 1 >= 8) $("#addit").hidden = true;
  };
  if ($("#mfile")) $("#mfile").onchange = async e => {
    const files = [...e.target.files]; e.target.value = "";
    const stat = $("#mstat"); busy = true; check();
    try {
      for (const f of files) {
        if (f.type.startsWith("video/")) {
          if (mVideo) throw new Error("Une seule vidéo par publication.");
          let blob = f;
          if (f.size > MAX_RAW) {
            stat.textContent = "Réduction de la vidéo… (elle se lit pendant la préparation)";
            blob = await compressVideo(f, x => { stat.textContent = `Réduction de la vidéo… ${Math.round(x * 100)} %`; });
          }
          const url = URL.createObjectURL(blob);
          mVideo = { blob, poster: await videoPoster(url), url };
        } else if (f.type.startsWith("image/")) {
          if (mPhotos.length >= 4) throw new Error("4 photos maximum par publication.");
          mPhotos.push(await shrinkImage(f));
        }
      }
      const total = mPhotos.reduce((a, x) => a + x.length, 0);
      if (total > 850000) { mPhotos.pop(); throw new Error("Trop lourd : retire une photo ou un GIF."); }
      stat.textContent = "";
    } catch (err) { stat.textContent = err.message || "Fichier non pris en charge."; }
    busy = false;
    $("#mprev").innerHTML = mPhotos.map((src, i) => `<div class="mp"><img src="${src}" alt=""><button type="button" data-rm="${i}" aria-label="Retirer">×</button></div>`).join("") +
      (mVideo ? `<div class="mp vid"><video src="${mVideo.url}" muted playsinline></video><button type="button" data-rmv aria-label="Retirer">×</button></div>` : "");
    $("#mprev").querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { mPhotos.splice(+b.dataset.rm, 1); $("#mfile").dispatchEvent(new Event("change")); });
    $("#mprev").querySelectorAll("[data-rmv]").forEach(b => b.onclick = () => { mVideo = null; $("#mfile").dispatchEvent(new Event("change")); });
    check();
  };
  // ----- objectifs : prévisualisation en image + modification -----
  let step = 1; const pv = {};
  if (type === "objectif" && edit) {
    const pr = priv[edit.week] || {};
    const setMode = (k, m) => wrap.querySelector(`.modes[data-for="${k}"] [data-mode="${m}"]`).click();
    const txt = pr.objText ?? edit.objText, prog = pr.prog || edit.prog;
    if (txt) $("#wtxt").value = txt;
    else if (edit.photo) { setMode("obj", "photo"); loadInto("obj", edit.photo); }
    if (prog) { const trs = wrap.querySelectorAll(".prog.edit tbody tr"); prog.forEach((r, i) => { const tr = trs[i]; if (!tr) return;
      tr.querySelector(".pt-from").value = r.from || ""; tr.querySelector(".pt-to").value = r.to || "";
      tr.querySelectorAll(".pt-cell").forEach((c, j) => c.value = (r.cells || [])[j] || ""); }); }
    else if (edit.progPhoto) { setMode("prog", "photo"); loadInto("prog", edit.progPhoto); }
    $("#txt").value = edit.text || "";
    check();
  }
  function loadInto(k, src) { const i = new Image(); i.onload = () => { imgs["_" + k] = i; imgs[k] = src; const box = $("#ph-" + k); box.querySelector(".photo").hidden = false;
    box.querySelector(".picktxt").textContent = "Changer la photo"; box.querySelector(".pblur").value = 0; box.querySelector(".pblur").dispatchEvent(new Event("input")); check(); }; i.src = src; }
  const drawPv = k => { const box = wrap.querySelector(`[data-pv="${k}"]`), b = +box.querySelector(".pvblur").value; box.querySelector(".bv").textContent = b; pv[k] = blurTo(box.querySelector("canvas"), pv["_" + k], b); };
  wrap.querySelectorAll(".pvblur").forEach(r => r.oninput = () => drawPv(r.closest("[data-pv]").dataset.pv));
  if ($("#back")) $("#back").onclick = () => { step = 1; $("#step1").hidden = false; $("#step2").hidden = true; send.textContent = "Continuer"; };
  send.onclick = async () => {
    if (type === "objectif" && step === 1) {
      pv._obj = modes.obj === "photo" ? imgs._obj : textImage("Objectifs de la semaine", $("#wtxt").value.trim(), me.name);
      pv._prog = modes.prog === "photo" ? imgs._prog : progImage(progRows().filter(r => r.from || r.to || r.cells.some(Boolean)), me.name);
      ["obj", "prog"].forEach(drawPv);
      step = 2; $("#step1").hidden = true; $("#step2").hidden = false; send.textContent = edit ? "Enregistrer les modifications" : "Publier";
      wrap.querySelector(".panel").scrollTop = 0; return;
    }
    if (type === "objectif") {
      const photo = pv.obj, progPhoto = pv.prog, week = edit ? edit.week : weekKey(new Date());
      if (photo.length + progPhoto.length > 780000) { $("#serr").textContent = "Les images sont trop lourdes : augmente un peu le flou."; return; }
      const secret = { objText: modes.obj === "ecrire" ? $("#wtxt").value.trim() : "", prog: modes.prog === "ecrire" ? progRows().filter(r => r.from || r.to || r.cells.some(Boolean)) : [], ts: Date.now() };
      setDoc(doc(db, "prives", me.uid, "semaines", week), secret).catch(() => toast("Ton texte n'a pas pu être gardé. Vérifie ta connexion."));
      if (edit) {
        const t = $("#txt").value.trim();
        if (edit.prive) setDoc(doc(db, "prives", me.uid, "posts", edit.id), { text: t }, { merge: true }).catch(() => {});
        updateDoc(doc(db, "posts", edit.id), { photo, progPhoto, edited: Date.now(), objText: deleteField(), prog: deleteField(), ...(edit.prive ? {} : { text: t }) })
          .then(() => toast("Modifications enregistrées")).catch(() => toast("Modification refusée. Vérifie ta connexion."));
        $("#layer").innerHTML = ""; render(); return;
      }
    }
    const now = new Date();
    const p = { uid: me.uid, name: me.name, type, text: $("#txt").value.trim(), ts: now.getTime(), week: weekKey(now), day: dayKey(now), likes: [] };
    if (mPhotos.length) p.photos = mPhotos;
    if (mVideo) {
      if (!navigator.onLine) { toast("Il faut du réseau pour envoyer une vidéo."); return; }
      busy = true; check(); $("#mstat").textContent = "Envoi de la vidéo…";
      try { const v = await uploadVideo(mVideo.blob); p.video = { ...v, poster: mVideo.poster }; }
      catch (e) { busy = false; check(); $("#mstat").textContent = "Échec de l'envoi de la vidéo. Réessaie."; return; }
    }
    if (type === "objectif") { p.photo = pv.obj; p.progPhoto = pv.prog; }
    if (type === "matin") { if (modes.matin === "photo") p.photo = imgs.matin; else p.items = items(); }
    let showV = null;
    if (type === "jour") {
      p.zero = choice;
      if (matinOk !== null) p.matinOk = matinOk;
      if (plan.length) {
        p.tasks = plan.map(t => ({ t: t.t, time: t.time, src: t.src }));
        p.doneIdx = [...wrap.querySelectorAll(".chk:checked")].map(c => +c.value);
        p.itemsTotal = plan.length; p.doneItems = p.doneIdx;
        showV = [p.doneIdx.length, plan.length];
      }
    }
    if (type === "semaine") p.atteint = choice;
    $("#layer").innerHTML = "";
    savePost(p, type !== "message" && prive);
    if (showV) showVerdict(...showV); else render();
  };
}

/* ---------- réseau / ouverture depuis un rappel ---------- */
addEventListener("online", () => { online = true; render(); });
addEventListener("offline", () => { online = false; render(); });
setInterval(render, 60000);
const want = new URLSearchParams(location.search).get("ouvrir");
if (want && TYPES[want]) { const t = setInterval(() => { if (me && myDoc && myDoc.status === "approved") { clearInterval(t); openSheet(want); } }, 300); }
if (want === "demandes") view = "demandes";
if (["messages", "notifs", "guide"].includes(want)) view = want;
if (want === "avis" || want === "pourquoi") { const t = setInterval(() => { if (me && myDoc && myDoc.status === "approved") { clearInterval(t); openAvis(want === "pourquoi" ? "installation" : "semaine"); } }, 300); }
