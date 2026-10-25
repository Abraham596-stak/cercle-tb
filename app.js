import { firebaseConfig, vapidKey } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  updateProfile, signOut, sendPasswordResetEmail, sendEmailVerification } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, setDoc, updateDoc, deleteDoc, getDocs, Bytes,
  onSnapshot, query, orderBy, limit, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
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
let comments = [], openCom = new Set(), mediaUrls = {}, mediaPlaying = false;
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
const APP_VERSION = "16";
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
      ${create ? `<input id="lname" class="field" type="text" placeholder="Prénom" required maxlength="30" autocomplete="given-name">` : ""}
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
        const name = $("#lname").value.trim();
        const cred = await createUserWithEmailAndPassword(auth, mail, pass);
        pendingName = name;
        await updateProfile(cred.user, { displayName: name });
        if (me) me.name = name;
      } else await signInWithEmailAndPassword(auth, mail, pass);
    } catch (err) { $("#lerr").textContent = ERR[err.code] || "Une erreur est survenue. Réessaie."; btn.disabled = false; }
  };
}

/* ---------- données ---------- */
let pendingName = null;
function stopData() { dataUnsub.forEach(u => u()); dataUnsub = []; posts = []; members = []; comments = []; }
function startData() {
  if (dataUnsub.length) return;
  dataUnsub.push(onSnapshot(query(collection(db, "posts"), orderBy("ts", "desc"), limit(150)), { includeMetadataChanges: true }, snap => {
    posts = snap.docs.map(d => ({ ...d.data(), _pending: d.metadata.hasPendingWrites }));
    render();
  }, () => {}));
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
      const base = { uid: me.uid, name, email: me.email, joined: Date.now(), warnings: [], badges: [] };
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
  return w.length === 2 && w.every(p => !p.atteint);
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

const TYPES = { objectif: "Objectif de la semaine", matin: "Objectifs du jour", jour: "Bilan du jour", semaine: "Bilan de la semaine", message: "Message" };
async function savePost(p) {
  const ref = doc(collection(db, "posts"));
  p.id = ref.id;
  setDoc(ref, p).catch(() => toast("Envoi refusé. Vérifie ta connexion au compte."));
  toast(online ? "Envoyé au groupe" : "Gardé, envoi dès le retour du réseau");
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
  let tag = `<span class="tag">${TYPES[p.type] || ""}</span>`;
  if (p.type === "semaine") tag = `<span class="tag ${p.atteint ? "ok" : "ko"}">${p.atteint ? "Objectif atteint" : "Objectif non atteint"}</span>`;
  if (p.type === "jour") tag = `<span class="tag ${p.zero ? "ok" : "ko"}">${p.zero ? "0 scroll" : "A scrollé"}</span>`;
  if (p.type === "message") tag = "";
  if (p.type === "matin") tag = "";
  if (p.type === "jour" && p.itemsTotal) tag += ` <span class="tag ${p.doneItems.length === p.itemsTotal ? "ok" : ""}">${p.doneItems.length}/${p.itemsTotal} objectifs du jour</span>`;
  const d = new Date(p.ts);
  const canDel = p.id && !p._pending && (p.uid === me.uid || isAdmin());
  return `<article class="card post">
    <div class="post-head">${canDel ? `<button class="icon-btn dark small-btn post-more" data-p="${esc(p.id)}" aria-label="Options">⋮</button>` : ""}${avatar(p.name, memberOf(p.uid).role === "admin" ? "admin" : "")}
      <div class="meta"><strong>${esc(memberOf(p.uid).name || p.name)} ${nameTags(p.uid)}</strong><small>${fmtDate(d)} à ${fmtTime(d)}${p.type !== "message" ? " · " + TYPES[p.type] : ""}</small></div></div>
    ${p.type === "matin" ? itemsHTML(p) : ""}
    ${p.text ? `<p class="post-text">${esc(p.text)}</p>` : ""}
    ${tag ? `<div class="post-tags">${tag}</div>` : ""}
    ${p.photo ? `<img class="post-img" src="${p.photo}" alt="Objectif écrit sur papier" loading="lazy">` : ""}
    ${mediaHTML(p)}
    ${p._pending ? `<div class="pending">En attente de réseau · envoi automatique</div>` : ""}
    ${p.id && !p._pending ? socialHTML(p) : ""}
  </article>`;
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
      ${cs.map(c => `<div class="comment">${avatar(memberOf(c.uid).name || c.name, "sm")}
        <div class="bubble"><strong>${esc(memberOf(c.uid).name || c.name)}</strong> ${nameTags(c.uid)}<p>${esc(c.text)}</p>
        <small>${fmtDate(new Date(c.ts))} à ${fmtTime(new Date(c.ts))}${c._pending ? " · envoi…" : ""}${(c.uid === me.uid || isAdmin()) && !c._pending ? ` · <button class="link-sm" data-cdel="${esc(c.id)}">Supprimer</button>` : ""}</small></div></div>`).join("")}
      <form class="c-form" data-cform="${esc(p.id)}">${avatar(me.name, "sm")}
        <input class="c-input" id="ci-${esc(p.id)}" maxlength="500" placeholder="Écris un commentaire…" autocomplete="off">
        <button class="c-send" aria-label="Envoyer">➤</button></form>
    </div>` : ""}
  </div>`;
}
function itemsHTML(p) {
  const bilan = posts.find(x => x.uid === p.uid && x.type === "jour" && x.day === p.day && x.itemsTotal);
  return `<ul class="day-items">${(p.items || []).map((it, i) => {
    const st = bilan ? (bilan.doneItems.includes(i) ? "ok" : "ko") : "";
    return `<li class="${st}"><span class="box">${st === "ok" ? "✓" : st === "ko" ? "✕" : ""}</span>${esc(it)}</li>`;
  }).join("")}</ul>${bilan ? `<div class="hint items-sum">${bilan.doneItems.length}/${bilan.itemsTotal} accomplis</div>` : ""}`;
}
function header() {
  return `<header class="topbar"><div class="topbar-in">
    <div class="brandbox"><div class="wordmark small">cercle tb</div><div class="school">École de discipline de ${ADMIN_NAME}</div></div>
    <div class="top-right">
      <span class="net ${online ? "" : "off"}">${online ? "En ligne" : "Hors ligne"}</span>
      <button class="icon-btn" id="menu" aria-label="Menu">⋮</button>
    </div></div></header>`;
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
  if (sun && (now.getHours() * 60 + now.getMinutes()) >= 20 * 60 + 30 && !s.obj) t = ["objectif", "Ton objectif de la semaine n'est pas encore envoyé", "Envoyer mon objectif"];
  else if (sun && (now.getHours() * 60 + now.getMinutes()) < 20 * 60 + 30 && !posts.some(p => p.uid === me.uid && p.type === "semaine" && p.day === dayKey(now))) t = ["semaine", "Fais le bilan de ta semaine", "Faire mon bilan de semaine"];
  else if (!sun && !s.matin && !s.today && now.getHours() >= 4 && now.getHours() < 13) t = ["matin", "Fixe tes objectifs du jour avant de commencer", "Écrire mes objectifs du jour"];
  else if (!sun && !s.today && now.getHours() >= 18) t = ["jour", "Ton bilan du jour t'attend", "Faire mon bilan du jour"];
  else if (!s.obj && !sun) t = ["objectif", "Tu n'as pas encore d'objectif cette semaine", "Fixer mon objectif"];
  if (!t) return s.today ? `<div class="card done">Bilan du jour envoyé. Bravo, continue comme ça !</div>` : "";
  return `<div class="card cta"><span>${t[1]}</span><button class="btn btn-primary btn-sm" data-open="${t[0]}">${t[2]}</button></div>`;
}
function filView() {
  const n = nextReminder(), s = statsFor(me.uid), ws = weekStart(new Date());
  const list = posts.filter(p => filter === "tout" || p.type === filter || (filter === "moi" && p.uid === me.uid));
  const labels = { tout: "Toutes les publications", objectif: "Objectifs", matin: "Objectifs du jour", jour: "Bilans du jour", semaine: "Bilans de semaine", message: "Messages", moi: "Mes publications" };
  const warns = (myDoc && myDoc.warnings) || [];
  const pend = members.filter(m => m.status === "pending").length;
  return `${header()}${ticker()}<main class="page">${notifBanner()}
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
      <small>${s.streak} j 0 scroll · ${s.done} objectif${s.done > 1 ? "s" : ""} atteint${s.done > 1 ? "s" : ""}</small>
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
  if (view === "demandes" && !admin) view = "fil";
  $("#app").innerHTML = view === "membres" ? membresView() : view === "demandes" ? demandesView() : filView();
  const pend = members.filter(m => m.status === "pending").length;
  $("#menu").onclick = () => openMenu([
    ["fil", "Fil du groupe", "Objectifs et bilans de tous"],
    ["membres", "Membres", admin ? "Mises en garde, badges, blocage" : "Qui est dans le cercle"],
    ...(admin ? [["demandes", `Demandes d'accès${pend ? ` (${pend})` : ""}`, "Valider les nouveaux membres"]] : []),
    ["notif", "Activer les rappels", "23h30 et le dimanche"],
    ["install", "Installer l'application", "Icône sur l'écran d'accueil"],
    ["out", "Se déconnecter", esc(me.email)]
  ], k => {
    if (k === "fil" || k === "membres" || k === "demandes") { view = k; render(); scrollTo(0, 0); }
    if (k === "notif") enableNotifs();
    if (k === "install") install();
    if (k === "out") signOut(auth);
  }, $("#menu").parentElement, view);
  if ($("#notif")) $("#notif").onclick = enableNotifs;
  document.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openSheet(b.dataset.open));
  Object.entries(drafts).forEach(([id, v]) => { const i = document.getElementById(id); if (i) i.value = v; });
  if (focusId && document.getElementById(focusId)) document.getElementById(focusId).focus();
  bindSocial();
  if ($("#go-dem")) $("#go-dem").onclick = () => { view = "demandes"; render(); scrollTo(0, 0); };
  if ($("#compose")) $("#compose").onclick = () => openMenu([
    ["objectif", "Objectif de la semaine", "Photo du papier, floutée ou non"],
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
    const id = b.dataset.p;
    openMenu([["del", "Supprimer la publication", "Action définitive"]], () => {
      openMenu([["yes", "Oui, supprimer", ""], ["no", "Annuler", ""]], k => {
        if (k === "yes") deleteDoc(doc(db, "posts", id)).then(() => toast("Publication supprimée")).catch(() => toast("Suppression refusée"));
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
      ["warn", "Mettre en garde", "Message visible uniquement par ce membre"],
      ["badge", "Donner un badge", has.length ? `Actuel : ${esc(has.join(", "))}` : "Récompenser sa discipline"],
      ...(has.length ? [["unbadge", "Retirer les badges", ""]] : []),
      ...((m.warnings || []).length ? [["clear", "Effacer les mises en garde", ""]] : []),
      [blocked ? "unblock" : "block", blocked ? "Débloquer" : "Bloquer l'accès", blocked ? "Le membre revient dans le cercle" : "Le membre ne voit plus le cercle"]
    ], k => {
      if (k === "warn") openWarn(m);
      if (k === "badge") openMenu(BADGES.filter(x => !has.includes(x)).map(x => [x, x, ""]), x => setMember(m.uid, { badges: arrayUnion(x) }).then(() => toast("Badge donné")), b.parentElement);
      if (k === "unbadge") setMember(m.uid, { badges: [] });
      if (k === "clear") setMember(m.uid, { warnings: [] });
      if (k === "block") setMember(m.uid, { status: "blocked", blockedReason: "Décision de l'administrateur", blockedAt: Date.now() });
      if (k === "unblock") setMember(m.uid, { status: "approved", blockedReason: null, unblockedAt: Date.now() });
    }, b.parentElement);
  });
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
    const ref = doc(collection(db, "comments"));
    setDoc(ref, { postId: id, uid: me.uid, name: me.name, text, ts: Date.now() }).catch(() => toast("Commentaire refusé. Vérifie ta connexion."));
  });
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
function openSheet(type) {
  $("#layer").innerHTML = "";
  const wrap = document.createElement("div"); wrap.className = "sheet";
  const yesNo = (q, a, b) => `<span class="label">${q}</span><div class="row"><button class="choice" data-v="1" aria-pressed="false">${a}</button><button class="choice" data-v="0" aria-pressed="false">${b}</button></div>`;
  const body = {
    objectif: `<p class="hint">Écris ton objectif sur un papier, prends-le en photo, puis choisis de flouter ou non.</p>
      <label class="filebtn" id="pick"><input id="file" type="file" accept="image/*" capture="environment"><span id="picktxt">Prendre ou choisir la photo du papier</span></label>
      <div class="photo" id="ph" hidden><canvas id="cv"></canvas>
        <div class="blurctl"><span>Flou</span><input id="blur" type="range" min="0" max="10" value="6" aria-label="Intensité du flou"><span id="bv">6</span></div>
        <span class="hint">0 = sans flou. La photo est réduite pour consommer très peu de données.</span></div>
      <textarea id="txt" maxlength="400" placeholder="Résumé de ton objectif (facultatif)"></textarea>`,
    matin: `<p class="hint">Avant de commencer ta journée, écris ce que tu vas accomplir. Ce soir, tu coches ce qui est fait dans ton bilan.</p>
      <div class="items-in" id="items">${[0, 1, 2].map(i => `<input class="field item" maxlength="120" placeholder="Objectif ${i + 1}">`).join("")}</div>
      <button type="button" class="link" id="addit">+ Ajouter un objectif</button>
      <textarea id="txt" maxlength="400" placeholder="Un mot pour te motiver (facultatif)"></textarea>`,
    jour: `${statsFor(me.uid).matin ? `<span class="label">Coche tes objectifs du jour accomplis</span>
      <div class="checks">${statsFor(me.uid).matin.items.map((it, i) => `<label class="check"><input type="checkbox" class="chk" value="${i}"><span>${esc(it)}</span></label>`).join("")}</div>` : ""}
      ${yesNo("As-tu scrollé aujourd'hui ?", "Non, 0 scroll", "Oui, j'ai scrollé")}
      <textarea id="txt" maxlength="600" placeholder="Qu'as-tu fait pour ton objectif aujourd'hui ?"></textarea>`,
    semaine: `${yesNo("As-tu atteint ton objectif de la semaine ?", "Oui, atteint", "Non, pas atteint")}
      <textarea id="txt" maxlength="600" placeholder="Ce qui a marché, ce qui a bloqué"></textarea>`,
    message: `<textarea id="txt" maxlength="1000" placeholder="Ton message au groupe"></textarea>
      ${isAdmin() ? `<label class="filebtn"><input id="mfile" type="file" accept="image/*,video/*" multiple><span>Ajouter des photos, une vidéo ou un GIF</span></label>
      <div class="media-prev" id="mprev"></div><div class="hint" id="mstat"></div>` : ""}`
  }[type];
  wrap.innerHTML = `<div class="panel" role="dialog" aria-label="${TYPES[type]}">
    <div class="sheet-head"><h2>${TYPES[type]}</h2><button class="icon-btn dark" id="x" aria-label="Fermer">×</button></div>
    ${body}<button class="btn btn-primary" id="send" disabled>Publier</button></div>`;
  $("#layer").appendChild(wrap);
  const close = () => { $("#layer").innerHTML = ""; render(); };
  wrap.addEventListener("click", e => { if (e.target === wrap) close(); });
  $("#x").onclick = close;
  let choice = null, img = null;
  const send = $("#send");
  let mPhotos = [], mVideo = null, busy = false;
  const items = () => [...wrap.querySelectorAll(".item")].map(i => i.value.trim()).filter(Boolean);
  const check = () => { send.disabled = busy || (type === "matin" ? !items().length : (type === "objectif" || type === "message") ? !(img || mPhotos.length || mVideo || $("#txt").value.trim()) : choice === null); };
  wrap.querySelectorAll(".item").forEach(i => i.oninput = check);
  if ($("#addit")) $("#addit").onclick = () => {
    const box = $("#items"), n = box.querySelectorAll(".item").length;
    if (n >= 8) { $("#addit").hidden = true; return; }
    const i = document.createElement("input"); i.className = "field item"; i.maxLength = 120; i.placeholder = `Objectif ${n + 1}`; i.oninput = check;
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
  wrap.querySelectorAll(".choice").forEach(b => b.onclick = () => { choice = b.dataset.v === "1"; wrap.querySelectorAll(".choice").forEach(o => o.setAttribute("aria-pressed", o === b)); check(); });
  $("#txt").oninput = check;
  if (type === "objectif") {
    const cv = $("#cv"), ctx = cv.getContext("2d");
    const draw = () => {
      if (!img) return;
      const W = 480, H = Math.round(img.height * W / img.width); cv.width = W; cv.height = H;
      const b = +$("#blur").value; $("#bv").textContent = b;
      if (b === 0) { ctx.drawImage(img, 0, 0, W, H); return; }
      const f = Math.max(4, Math.round(W / (b * 5 + 2)));
      const sm = document.createElement("canvas"); sm.width = f; sm.height = Math.max(2, Math.round(H * f / W));
      sm.getContext("2d").drawImage(img, 0, 0, sm.width, sm.height);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(sm, 0, 0, W, H);
    };
    $("#blur").oninput = draw;
    $("#file").onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => { const i = new Image(); i.onload = () => { img = i; $("#ph").hidden = false; $("#picktxt").textContent = "Changer la photo"; draw(); check(); }; i.src = r.result; };
      r.readAsDataURL(f);
    };
  }
  send.onclick = async () => {
    const now = new Date();
    const p = { uid: me.uid, name: me.name, type, text: $("#txt").value.trim(), ts: now.getTime(), week: weekKey(now), day: dayKey(now), likes: [] };
    if (mPhotos.length) p.photos = mPhotos;
    if (mVideo) {
      if (!navigator.onLine) { toast("Il faut du réseau pour envoyer une vidéo."); return; }
      busy = true; check(); $("#mstat").textContent = "Envoi de la vidéo…";
      try { const v = await uploadVideo(mVideo.blob); p.video = { ...v, poster: mVideo.poster }; }
      catch (e) { busy = false; check(); $("#mstat").textContent = "Échec de l'envoi de la vidéo. Réessaie."; return; }
    }
    if (type === "objectif" && img) p.photo = $("#cv").toDataURL("image/jpeg", .55);
    if (type === "jour") p.zero = choice;
    if (type === "matin") p.items = items();
    if (type === "jour" && statsFor(me.uid).matin) {
      p.itemsTotal = statsFor(me.uid).matin.items.length;
      p.doneItems = [...wrap.querySelectorAll(".chk:checked")].map(c => +c.value);
    }
    if (type === "semaine") p.atteint = choice;
    $("#layer").innerHTML = "";
    savePost(p); render();
  };
}

/* ---------- réseau / ouverture depuis un rappel ---------- */
addEventListener("online", () => { online = true; render(); });
addEventListener("offline", () => { online = false; render(); });
setInterval(render, 60000);
const want = new URLSearchParams(location.search).get("ouvrir");
if (want && TYPES[want]) { const t = setInterval(() => { if (me && myDoc && myDoc.status === "approved") { clearInterval(t); openSheet(want); } }, 300); }
if (want === "demandes") view = "demandes";
