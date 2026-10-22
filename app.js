import { firebaseConfig, vapidKey } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  updateProfile, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, setDoc,
  onSnapshot, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMessaging, getToken, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
// Cache local : l'app marche hors ligne et envoie tout au retour du réseau
const db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let me = null, posts = [], members = [], view = "fil", filter = "tout", online = navigator.onLine;
let unsub = [], swReg = null, installEvt = null;

/* ---------- service worker (hors ligne + rappels) ---------- */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then(r => { swReg = r; }).catch(() => {});
}
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; });

/* ---------- dates ---------- */
const JOURS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
function mondayOf(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x; }
function weekStart(d = new Date()) { const m = mondayOf(d); if (d.getDay() === 0 && d.getHours() >= 15) m.setDate(m.getDate() + 7); return m; }
const dayKey = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const weekKey = d => dayKey(weekStart(d));
const fmtDate = d => `${JOURS[d.getDay()]} ${d.getDate()} ${MOIS[d.getMonth()]}`;
const fmtTime = d => `${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;
function nextReminder(now = new Date()) {
  const list = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    const at = (h, m, what) => { const t = new Date(d); t.setHours(h, m, 0, 0); if (t > now) list.push({ t, what }); };
    if (d.getDay() === 0) { at(8, 0, "Bilan de la semaine : objectif atteint ?"); at(15, 0, "Envoie ton objectif de la semaine"); }
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
function loginView(mode = "in") {
  const create = mode === "new";
  $("#app").innerHTML = `<div class="login">
    <div class="ring big">TB</div>
    <h1>Le Cercle TB</h1>
    <p>Le groupe pour tenir ses objectifs et arriver à zéro scroll. Chaque semaine, un objectif écrit sur papier. Chaque soir, un bilan.</p>
    <form id="lf" class="card">
      <span class="label">${create ? "Créer mon compte" : "Se connecter"}</span>
      ${create ? `<input id="lname" type="text" placeholder="Ton prénom" required maxlength="30" autocomplete="given-name">` : ""}
      <input id="lmail" type="email" placeholder="Ton e-mail" required autocomplete="email">
      <input id="lpass" type="password" placeholder="Mot de passe (6 caractères min.)" required minlength="6" autocomplete="${create ? "new-password" : "current-password"}"
        style="width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:12px">
      <div class="err" id="lerr"></div>
      <button class="btn" type="submit">${create ? "Rejoindre le cercle" : "Entrer"}</button>
      <button class="link" type="button" id="swap">${create ? "J'ai déjà un compte" : "Nouveau ? Créer mon compte"}</button>
      ${create ? "" : `<button class="link" type="button" id="forgot">Mot de passe oublié</button>`}
    </form></div>`;
  $("#swap").onclick = () => loginView(create ? "in" : "new");
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
        await updateProfile(cred.user, { displayName: name });
        await setDoc(doc(db, "members", cred.user.uid), { uid: cred.user.uid, name, joined: Date.now() });
        if (me) { me.name = name; render(); } else start(cred.user);
      } else await signInWithEmailAndPassword(auth, mail, pass);
    } catch (err) { $("#lerr").textContent = ERR[err.code] || "Une erreur est survenue. Réessaie."; btn.disabled = false; }
  };
}

/* ---------- données ---------- */
function start(user) {
  if (me && me.uid === user.uid) return;
  me = { uid: user.uid, name: user.displayName || user.email.split("@")[0], email: user.email };
  unsub.forEach(u => u()); unsub = [];
  if (user.displayName) setDoc(doc(db, "members", user.uid), { uid: user.uid, name: user.displayName }, { merge: true }).catch(() => {});
  unsub.push(onSnapshot(query(collection(db, "posts"), orderBy("ts", "desc"), limit(300)), { includeMetadataChanges: true }, snap => {
    posts = snap.docs.map(d => ({ ...d.data(), _pending: d.metadata.hasPendingWrites }));
    render();
  }, () => {}));
  unsub.push(onSnapshot(collection(db, "members"), snap => { members = snap.docs.map(d => d.data()); render(); }, () => {}));
  render();
}
onAuthStateChanged(auth, u => {
  if (u) start(u);
  else { me = null; unsub.forEach(f => f()); unsub = []; loginView(); }
});

const TYPES = { objectif: "Objectif de la semaine", jour: "Bilan du jour", semaine: "Bilan de la semaine", message: "Message" };
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
  return { streak, obj, done, today };
}

/* ---------- vues ---------- */
function postHTML(p) {
  let tag = `<span class="tag">${TYPES[p.type] || ""}</span>`;
  if (p.type === "semaine") tag = `<span class="tag ${p.atteint ? "ok" : "ko"}">${p.atteint ? "Objectif atteint" : "Pas atteint"}</span>`;
  if (p.type === "jour") tag = `<span class="tag ${p.zero ? "ok" : "ko"}">${p.zero ? "0 scroll" : "A scrollé"}</span>`;
  if (p.type === "message") tag = "";
  const d = new Date(p.ts);
  return `<article class="post">
    <div class="who"><div class="av">${esc((p.name || "?")[0].toUpperCase())}</div>
      <div class="meta"><strong>${esc(p.name)}${p.uid === me.uid ? " (toi)" : ""}</strong><small>${fmtDate(d)} à ${fmtTime(d)}</small></div>${tag}</div>
    ${p.photo ? `<img src="${p.photo}" alt="Objectif écrit sur papier" loading="lazy">` : ""}
    ${p.text ? `<p>${esc(p.text)}</p>` : ""}
    ${p._pending ? `<span class="pending">En attente de réseau, sera envoyé automatiquement</span>` : ""}
  </article>`;
}
function header() {
  return `<header class="top"><div class="brand"><div class="ring">TB</div><div><h1>Le Cercle TB</h1>
    <div class="status"><span class="dot ${online ? "" : "off"}"></span>${online ? "En ligne" : "Hors ligne, tout est gardé"} · ${members.length} membre${members.length > 1 ? "s" : ""}</div></div></div>
    <button class="kebab" id="menu" aria-label="Menu">⋮</button></header>`;
}
function notifBanner() {
  if (!("Notification" in window) || Notification.permission === "granted") return "";
  const ios = /iphone|ipad/i.test(navigator.userAgent) && !navigator.standalone;
  return `<div class="banner"><span>${ios ? "Sur iPhone : touche Partager puis « Sur l'écran d'accueil », ouvre l'app depuis l'icône, puis active les rappels." : "Active les rappels pour recevoir les notifications de 23h30 et du dimanche."}</span>
    ${ios ? "" : `<button class="btn" id="notif">Activer</button>`}</div>`;
}
function filView() {
  const n = nextReminder(), s = statsFor(me.uid), ws = weekStart(new Date());
  const list = posts.filter(p => filter === "tout" || p.type === filter || (filter === "moi" && p.uid === me.uid));
  return `${header()}${notifBanner()}
  <section class="card next">
    <span class="label">Prochain rappel</span>
    <div class="when">${fmtDate(n.t)} · ${fmtTime(n.t)}</div>
    <div class="what">${n.what}, ${untilText(n.t)}</div>
    <div class="sched"><span>Lun. → sam. 23h30 : bilan du jour</span><span>Dim. 8h00 : objectif atteint ?</span><span>Dim. 15h00 : nouvel objectif</span></div>
  </section>
  <section class="stats">
    <div class="stat"><b>${s.streak}</b><span>jour${s.streak > 1 ? "s" : ""} 0 scroll d'affilée</span></div>
    <div class="stat"><b>${s.obj ? "✓" : "—"}</b><span>objectif semaine du ${ws.getDate()} ${MOIS[ws.getMonth()]}</span></div>
    <div class="stat"><b>${s.done}</b><span>objectif${s.done > 1 ? "s" : ""} atteint${s.done > 1 ? "s" : ""}</span></div>
  </section>
  <div class="feedhead"><h2>Le groupe</h2><button class="kebab" id="flt" aria-label="Filtrer">⋮</button></div>
  <section style="display:flex;flex-direction:column;gap:12px">
    ${list.length ? list.map(postHTML).join("") : `<div class="empty card">Rien ici pour l'instant.<br>Touche <b>+</b> pour envoyer ton objectif de la semaine.</div>`}
  </section>
  <button class="fab" id="fab" aria-label="Publier">+</button>`;
}
function membresView() {
  const sorted = [...members].sort((a, b) => statsFor(b.uid).streak - statsFor(a.uid).streak);
  return `${header()}
  <div class="feedhead"><h2>Membres du cercle</h2></div>
  <p class="hint" style="margin:0">Classés par jours 0 scroll d'affilée.</p>
  <section style="display:flex;flex-direction:column;gap:10px">
  ${sorted.map(m => { const s = statsFor(m.uid); return `<div class="member">
    <div class="av">${esc((m.name || "?")[0].toUpperCase())}</div>
    <div class="meta"><strong>${esc(m.name)}${m.uid === me.uid ? " (toi)" : ""}</strong>
      <small>${s.streak} j 0 scroll · ${s.done} objectif${s.done > 1 ? "s" : ""} atteint${s.done > 1 ? "s" : ""}</small></div>
    <span class="tag ${s.obj ? "ok" : "ko"}">${s.obj ? "Objectif posté" : "Pas d'objectif"}</span></div>`; }).join("") || `<div class="empty card">Aucun membre pour l'instant.</div>`}
  </section>`;
}
function render() {
  if (!me) return;
  if ($("#layer .sheet")) return; // ne pas effacer une saisie en cours
  $("#app").innerHTML = view === "membres" ? membresView() : filView();
  $("#menu").onclick = () => openMenu([
    ["fil", "Fil du groupe", "Objectifs et bilans de tous"],
    ["membres", "Membres", `${members.length} dans le cercle`],
    ["notif", "Activer les rappels", "23h30 et le dimanche"],
    ["install", "Installer l'application", "Icône sur l'écran d'accueil"],
    ["out", "Se déconnecter", esc(me.email)]
  ], k => {
    if (k === "fil" || k === "membres") { view = k; render(); }
    if (k === "notif") enableNotifs();
    if (k === "install") install();
    if (k === "out") signOut(auth);
  }, $("#menu").parentElement, view);
  if ($("#notif")) $("#notif").onclick = enableNotifs;
  if ($("#fab")) $("#fab").onclick = () => openMenu([
    ["objectif", "Objectif de la semaine", "Photo du papier, floutée ou non"],
    ["jour", "Bilan du jour", "0 scroll ? Ce que tu as fait"],
    ["semaine", "Bilan de la semaine", "Objectif atteint ou pas"],
    ["message", "Message au groupe", "Encourager, poser une question"]
  ], k => openSheet(k), null, null, null, "fabmenu");
  if ($("#flt")) $("#flt").onclick = () => openMenu([
    ["tout", "Tout le groupe", ""], ["objectif", "Objectifs", ""], ["jour", "Bilans du jour", ""],
    ["semaine", "Bilans de semaine", ""], ["message", "Messages", ""], ["moi", "Mes publications", ""]
  ], k => { filter = k; render(); }, $("#flt").parentElement, filter);
}

/* ---------- rappels ---------- */
async function enableNotifs() {
  try {
    if (!(await isSupported())) { toast("Ton téléphone ne gère pas les rappels ici. Installe d'abord l'app."); return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Rappels refusés. Tu peux les autoriser dans les réglages."); return; }
    const reg = swReg || await navigator.serviceWorker.ready;
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
      <label class="filebtn" id="pick"><input id="file" type="file" accept="image/*" capture="environment"><span id="picktxt">📷 Prendre ou choisir la photo du papier</span></label>
      <div class="photo" id="ph" hidden><canvas id="cv"></canvas>
        <div class="blurctl"><span>Flou</span><input id="blur" type="range" min="0" max="10" value="6" aria-label="Intensité du flou"><span id="bv">6</span></div>
        <span class="hint">0 = sans flou. La photo est réduite pour consommer très peu de données.</span></div>
      <textarea id="txt" maxlength="400" placeholder="Résumé de ton objectif (facultatif)"></textarea>`,
    jour: `${yesNo("As-tu scrollé aujourd'hui ?", "Non, 0 scroll", "Oui, j'ai scrollé")}
      <textarea id="txt" maxlength="600" placeholder="Qu'as-tu fait pour ton objectif aujourd'hui ?"></textarea>`,
    semaine: `${yesNo("As-tu atteint ton objectif de la semaine ?", "Oui, atteint", "Non, pas atteint")}
      <textarea id="txt" maxlength="600" placeholder="Ce qui a marché, ce qui a bloqué"></textarea>`,
    message: `<textarea id="txt" maxlength="600" placeholder="Ton message au groupe"></textarea>`
  }[type];
  wrap.innerHTML = `<div class="panel" role="dialog" aria-label="${TYPES[type]}">
    <div class="feedhead"><h2>${TYPES[type]}</h2><button class="kebab" id="x" aria-label="Fermer">×</button></div>
    ${body}<button class="btn" id="send" disabled>Envoyer au groupe</button></div>`;
  $("#layer").appendChild(wrap);
  const close = () => { $("#layer").innerHTML = ""; render(); };
  wrap.addEventListener("click", e => { if (e.target === wrap) close(); });
  $("#x").onclick = close;
  let choice = null, img = null;
  const send = $("#send");
  const check = () => { send.disabled = (type === "objectif" || type === "message") ? !(img || $("#txt").value.trim()) : choice === null; };
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
  send.onclick = () => {
    const now = new Date();
    const p = { uid: me.uid, name: me.name, type, text: $("#txt").value.trim(), ts: now.getTime(), week: weekKey(now), day: dayKey(now) };
    if (type === "objectif" && img) p.photo = $("#cv").toDataURL("image/jpeg", .55);
    if (type === "jour") p.zero = choice;
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
if (want && TYPES[want]) { const t = setInterval(() => { if (me) { clearInterval(t); openSheet(want); } }, 300); }
