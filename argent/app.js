import { firebaseConfig, vapidKey } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  updateProfile, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, setDoc, updateDoc,
  deleteDoc, onSnapshot, query, orderBy, where, getDocs, writeBatch, increment } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMessaging, getToken, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb); auth.languageCode = "fr";
const db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const F = n => new Intl.NumberFormat("fr-FR").format(Math.round(n || 0)).replace(/ | /g, " ");
const FCFA = n => F(n) + " F";
const W = 52 / 12; // semaines par mois

/* ---------- mises à jour automatiques ---------- */
let swReg = null;
if ("serviceWorker" in navigator) {
  const had = !!navigator.serviceWorker.controller; let re = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (had && !re) { re = true; location.reload(); } });
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(r => { swReg = r; r.update().catch(() => {}); }).catch(() => {});
}
const APP_VERSION = "1";
(async () => { try { const v = await (await fetch("version.json?t=" + Date.now(), { cache: "no-store" })).json();
  if (v.v !== APP_VERSION && sessionStorage.getItem("ma-r") !== v.v) { sessionStorage.setItem("ma-r", v.v); (await caches.keys()).forEach(k => caches.delete(k)); location.reload(); } } catch (e) {} })();

/* ---------- catégories ---------- */
const CAT_OUT = [
  ["nourriture", "Nourriture", "🍲"], ["transport", "Transport", "🛵"], ["data", "Data & crédit", "📶"],
  ["loyer", "Loyer", "🏠"], ["eau", "Eau", "💧"], ["electricite", "Électricité", "⚡"], ["ravitaillement", "Ravitaillement", "🛒"],
  ["parents", "Parents", "👪"], ["famille", "Famille", "🏡"], ["couple", "Couple", "❤️"], ["tontine", "Tontine", "🤝"],
  ["poche", "Argent de poche", "👛"], ["sante", "Santé", "💊"], ["etudes", "Études", "📚"], ["habits", "Habits", "👕"],
  ["loisirs", "Sorties & loisirs", "🎉"], ["dons", "Dons & aides", "🎁"], ["equipement", "Équipement & maison", "🛋️"],
  ["frais", "Frais Mobile Money / banque", "🏧"],
  ["b_stock", "Business · Stock", "📦"], ["b_pub", "Business · Publicité", "📣"], ["b_livraison", "Business · Livraison", "🚚"], ["b_autre", "Business · Autres frais", "🧾"],
  ["autre", "Autres dépenses", "•"]
];
const CAT_IN = [["business", "Business · Ventes", "💼"], ["salaire", "Salaire", "💵"], ["cadeau", "Cadeau reçu", "🎁"], ["rembours", "Remboursement", "↩️"], ["autre_in", "Autres revenus", "•"]];
const CAT = Object.fromEntries([...CAT_OUT, ...CAT_IN].map(([k, n, i]) => [k, { n, i }]));
const isBiz = c => c.startsWith("b_") || c === "business";
const ACC_TYPES = { cash: ["Espèces", "#5F6B66", "€"], mtn: ["MTN MoMo", "#E8B400", "MTN"], moov: ["Moov Money", "#0057B8", "MV"], celtis: ["Celtis Cash", "#6C2DC7", "CT"], banque: ["Banque", "#0B3D2E", "BQ"], autre: ["Autre", "#7A8A83", "•"] };

/* ---------- dates ---------- */
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const dk = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const mk = d => dk(d).slice(0, 7);
const monday = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x; };
const wk = d => dk(monday(d));
const monthStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1);
const daysInMonth = d => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
const prettyDay = s => { const d = new Date(s + "T12:00"); const t = dk(new Date()), y = dk(new Date(Date.now() - 864e5));
  return s === t ? "Aujourd'hui" : s === y ? "Hier" : `${JOURS[d.getDay()]} ${d.getDate()} ${MOIS[d.getMonth()]}`; };
const weeksLeftInMonth = (d = new Date()) => { // lundis restants dans le mois, semaine en cours comprise
  let n = 0; const end = new Date(d.getFullYear(), d.getMonth() + 1, 0); let m = monday(d);
  while (m <= end) { n++; m.setDate(m.getDate() + 7); } return n; };

/* ---------- état ---------- */
let me = null, unsub = [], accounts = [], tx = [], fixed = [], goals = [], settings = null, view = "accueil", online = navigator.onLine;
let bilanMonth = monthStart(), bilanTx = null, unlocked = false;
const col = name => collection(db, "users", me.uid, name);
const ref = (name, id) => doc(db, "users", me.uid, name, id);

/* ---------- connexion ---------- */
const EYE = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ERR = { "auth/invalid-email": "Cet e-mail n'est pas valide.", "auth/invalid-credential": "E-mail ou mot de passe incorrect.", "auth/email-already-in-use": "Ce compte existe déjà : connecte-toi.",
  "auth/weak-password": "Le mot de passe doit avoir au moins 6 caractères.", "auth/network-request-failed": "Pas de réseau. La première connexion a besoin d'internet." };
function loginView(mode = "in") {
  const create = mode === "new";
  $("#app").innerHTML = `<div class="login"><div class="login-brand"><div class="logo">mon<b>argent</b></div>
    <p>Chaque franc compte. Suis tes comptes, tes dépenses, ton budget et ton épargne.</p></div>
    <form class="card-box" id="lf"><h2>${create ? "Créer un compte" : "Se connecter"}</h2>
      ${create ? `<input id="ln" class="field" placeholder="Prénom" required maxlength="30">` : ""}
      <input id="lm" class="field" type="email" placeholder="Adresse e-mail" required autocomplete="email">
      <div class="pw"><input id="lp" class="field" type="password" placeholder="Mot de passe" required minlength="6" autocomplete="${create ? "new-password" : "current-password"}"><button type="button" class="eye" id="eye" aria-label="Afficher le mot de passe">${EYE}</button></div>
      <div class="err" id="le"></div>
      <button class="btn btn-primary">${create ? "Créer mon compte" : "Se connecter"}</button>
      ${create ? "" : `<button type="button" class="link" id="fg">Mot de passe oublié ?</button>`}
      <hr><button type="button" class="btn btn-secondary" id="sw">${create ? "J'ai déjà un compte" : "Créer un nouveau compte"}</button>
      <p class="hint" style="text-align:center">Tes données sont privées : personne d'autre ne peut les voir.</p></form></div>`;
  $("#sw").onclick = () => loginView(create ? "in" : "new");
  $("#eye").onclick = () => { const f = $("#lp"); f.type = f.type === "password" ? "text" : "password"; };
  if ($("#fg")) $("#fg").onclick = async () => { const m = $("#lm").value.trim(); if (!m) { $("#le").textContent = "Écris ton e-mail d'abord."; return; }
    try { await sendPasswordResetEmail(auth, m); $("#le").textContent = "Lien envoyé dans ta boîte mail."; } catch (e) { $("#le").textContent = ERR[e.code] || "Impossible d'envoyer le lien."; } };
  $("#lf").onsubmit = async e => {
    e.preventDefault(); const b = e.submitter; b.disabled = true; $("#le").textContent = "";
    try {
      if (create) { const c = await createUserWithEmailAndPassword(auth, $("#lm").value.trim(), $("#lp").value); await updateProfile(c.user, { displayName: $("#ln").value.trim() }); if (me) { me.name = $("#ln").value.trim(); render(); } }
      else await signInWithEmailAndPassword(auth, $("#lm").value.trim(), $("#lp").value);
    } catch (err) { $("#le").textContent = ERR[err.code] || "Une erreur est survenue. Réessaie."; b.disabled = false; }
  };
}
onAuthStateChanged(auth, u => {
  unsub.forEach(f => f()); unsub = []; accounts = []; tx = []; fixed = []; goals = []; settings = null; bilanTx = null;
  if (!u) { me = null; loginView(); return; }
  me = { uid: u.uid, email: u.email, name: u.displayName || u.email.split("@")[0] };
  unlocked = !localStorage.getItem("ma-pin-" + u.uid);
  const since = dk(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1));
  unsub.push(onSnapshot(doc(db, "users", me.uid), s => { settings = s.exists() ? s.data() : {}; render(); }, () => { settings = {}; render(); }));
  unsub.push(onSnapshot(query(col("accounts"), orderBy("order")), s => { accounts = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); }, () => {}));
  unsub.push(onSnapshot(query(col("tx"), where("date", ">=", since), orderBy("date", "desc")), { includeMetadataChanges: true }, s => {
    tx = s.docs.map(d => ({ id: d.id, ...d.data(), _p: d.metadata.hasPendingWrites })).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts); bilanTx = null; render(); }, () => {}));
  unsub.push(onSnapshot(col("fixed"), s => { fixed = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.amount - a.amount); render(); }, () => {}));
  unsub.push(onSnapshot(col("goals"), s => { goals = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0)); render(); }, () => {}));
  render();
});

/* ---------- calculs ---------- */
const total = () => accounts.reduce((a, c) => a + (c.balance || 0), 0);
const thisMonth = (list = tx, d = new Date()) => list.filter(t => t.date.startsWith(mk(d)));
const sumBy = (list, k) => list.filter(t => t.kind === k).reduce((a, t) => a + t.amount, 0);
const monthlyNeed = () => fixed.reduce((a, f) => a + (f.freq === "semaine" ? f.amount * W : f.amount), 0);
const period = (f, d = new Date()) => f.freq === "semaine" ? "s" + wk(d) : "m" + mk(d);
const paidFixed = f => tx.some(t => t.fixedId === f.id && t.period === period(f));
function remainingFixedMonth() { // ce qu'il reste à payer en charges fixes d'ici la fin du mois
  const wl = weeksLeftInMonth();
  return fixed.reduce((a, f) => a + (f.freq === "semaine" ? f.amount * (wl - (paidFixed(f) ? 1 : 0)) : (paidFixed(f) ? 0 : f.amount)), 0);
}
const savedThisMonth = () => thisMonth().filter(t => t.kind === "epargne").reduce((a, t) => a + t.amount, 0) - thisMonth().filter(t => t.kind === "retrait").reduce((a, t) => a + t.amount, 0);
function resteAVivre() {
  const now = new Date(), left = daysInMonth(now) - now.getDate() + 1;
  const target = settings?.saveMonth || 0, saveLeft = Math.max(0, target - savedThisMonth());
  const libre = total() - remainingFixedMonth() - saveLeft;
  return { libre, perDay: libre / left, left, saveLeft };
}
const weekIncome = () => tx.filter(t => t.kind === "revenu" && t.date >= wk(new Date())).reduce((a, t) => a + t.amount, 0);
const neededWeekly = () => (monthlyNeed() + (settings?.saveMonth || 0)) / W;

/* ---------- écritures ---------- */
function saveTx(t) {
  const b = writeBatch(db), r = doc(col("tx"));
  t = { ...t, ts: Date.now() };
  b.set(r, t);
  applyTx(b, t, 1);
  b.commit().catch(() => toast("Enregistrement refusé. Vérifie ta connexion au compte."));
  return r.id;
}
function applyTx(b, t, s) {
  const acc = id => id && accounts.find(a => a.id === id) ? ref("accounts", id) : null;
  if (t.kind === "depense" && acc(t.account)) b.update(acc(t.account), { balance: increment(-s * t.amount) });
  if (t.kind === "revenu" && acc(t.account)) b.update(acc(t.account), { balance: increment(s * t.amount) });
  if (t.kind === "transfert") {
    if (acc(t.account)) b.update(acc(t.account), { balance: increment(-s * (t.amount + (t.fee || 0))) });
    if (acc(t.to)) b.update(acc(t.to), { balance: increment(s * t.amount) });
  }
  if (t.kind === "epargne") { if (acc(t.account)) b.update(acc(t.account), { balance: increment(-s * t.amount) }); if (t.goal && goals.find(g => g.id === t.goal)) b.update(ref("goals", t.goal), { saved: increment(s * t.amount) }); }
  if (t.kind === "retrait") { if (acc(t.account)) b.update(acc(t.account), { balance: increment(s * t.amount) }); if (t.goal && goals.find(g => g.id === t.goal)) b.update(ref("goals", t.goal), { saved: increment(-s * t.amount) }); }
}
function deleteTx(t) { const b = writeBatch(db); b.delete(ref("tx", t.id)); applyTx(b, t, -1); b.commit().then(() => toast("Opération supprimée")).catch(() => toast("Suppression refusée")); }

/* ---------- vues ---------- */
const VIEWS = { accueil: "Accueil", operations: "Opérations", budget: "Budget & charges", epargne: "Épargne & projets", bilan: "Bilan du mois", comptes: "Mes comptes" };
function header() {
  return `<header class="topbar"><div class="topbar-in"><div class="logo small">mon<b>argent</b></div>
    <div class="top-right"><span class="view-name">${VIEWS[view]}</span><button class="icon-btn" id="menu" aria-label="Menu">⋮</button></div></div></header>`;
}
const accName = id => (accounts.find(a => a.id === id) || {}).name || "Compte supprimé";
function txRow(t) {
  const c = CAT[t.cat] || { n: t.kind === "transfert" ? "Transfert" : t.kind === "epargne" ? "Épargne" : t.kind === "retrait" ? "Retrait d'épargne" : "Opération", i: t.kind === "transfert" ? "⇄" : t.kind === "epargne" ? "🐖" : "↩️" };
  const sign = t.kind === "revenu" || t.kind === "retrait" ? "+" : t.kind === "transfert" ? "" : "−";
  const cls = t.kind === "revenu" || t.kind === "retrait" ? "in" : t.kind === "transfert" ? "tr" : "out";
  const goal = t.goal ? (goals.find(g => g.id === t.goal) || {}).name : "";
  const sub = t.kind === "transfert" ? `${accName(t.account)} → ${accName(t.to)}${t.fee ? ` · frais ${FCFA(t.fee)}` : ""}` : `${accName(t.account)}${goal ? " · " + goal : ""}${t.note ? " · " + t.note : ""}`;
  return `<button class="li btnli" data-tx="${t.id}"><span class="ic">${c.i}</span><span class="mid"><b>${esc(t.note && t.kind !== "transfert" && !goal ? (c.n) : c.n)}</b><small>${esc(sub)}${t._p ? " · en attente de réseau" : ""}</small></span>
    <span class="amt ${cls} num">${sign}${FCFA(t.amount)}</span></button>`;
}
function grouped(list) {
  const by = {}; list.forEach(t => (by[t.date] = by[t.date] || []).push(t));
  return Object.entries(by).map(([d, l]) => { const out = l.filter(t => t.kind === "depense").reduce((a, t) => a + t.amount, 0);
    return `<div class="day-h"><span>${prettyDay(d)}</span><span class="num">${out ? "−" + FCFA(out) : ""}</span></div><div class="card list">${l.map(txRow).join("")}</div>`; }).join("");
}
function accueilView() {
  const m = thisMonth(), out = sumBy(m, "depense"), inc = sumBy(m, "revenu"), r = resteAVivre();
  const today = tx.filter(t => t.date === dk(new Date()));
  const dueNow = fixed.filter(f => !paidFixed(f)).slice(0, 4);
  const need = neededWeekly(), wi = weekIncome();
  const alerts = [];
  const empty = accounts.length && accounts.every(a => !a.balance) && !tx.length;
  if (empty) alerts.push(["warn", "Commence par mettre le solde réel de chaque compte : Menu ⋮ → Mes comptes → ⋮ → Corriger le solde."]);
  else if (r.libre < 0) alerts.push(["ko", `Attention : ton argent ne suffit pas pour tes charges et ton épargne prévues ce mois. Il manque ${FCFA(-r.libre)}.`]);
  const over = budgetsOver(); if (over.length) alerts.push(["warn", `Budget dépassé : ${over.map(o => o.n).join(", ")}.`]);
  if (!today.length && new Date().getHours() >= 19) alerts.push(["warn", "Tu n'as noté aucune dépense aujourd'hui. Même 100 F compte."]);
  return `${header()}<main class="page">
  <section class="hero"><div><div class="k">Solde total · ${accounts.length} compte${accounts.length > 1 ? "s" : ""}</div><div class="big num">${FCFA(total())}</div></div>
    <div class="row3"><div><span>Entrées du mois</span><b class="num">${FCFA(inc)}</b></div><div><span>Sorties du mois</span><b class="num">${FCFA(out)}</b></div><div><span>Épargné ce mois</span><b class="num">${FCFA(savedThisMonth())}</b></div></div></section>
  ${alerts.map(([c, t]) => `<div class="alert ${c}">${esc(t)}</div>`).join("")}
  ${empty ? "" : `<section class="card pad rav ${r.perDay >= 0 ? "ok" : "ko"}"><div><div class="label">Reste à vivre</div><div class="v num">${FCFA(r.perDay)} / jour</div>
    <p class="hint">Pendant ${r.left} jour${r.left > 1 ? "s" : ""}, après tes charges fixes restantes (${FCFA(remainingFixedMonth())}) et l'épargne prévue (${FCFA(r.saveLeft)}).</p></div></section>`}
  ${need ? `<section class="card pad"><div class="label">Revenus de la semaine</div><div class="rav ${wi >= need ? "ok" : "ko"}"><div class="v num">${FCFA(wi)}</div><span class="hint num">objectif ${FCFA(need)}</span></div>
    <div class="bar ${wi >= need ? "" : "warn"}"><i style="width:${Math.min(100, need ? wi / need * 100 : 0)}%"></i></div></section>` : ""}
  <div class="sec"><h2>Mes comptes</h2><button class="link" data-go="comptes">Gérer</button></div>
  <div class="accounts">${accounts.map(a => accCard(a)).join("") || `<div class="card empty">Ajoute tes comptes pour commencer.</div>`}</div>
  ${dueNow.length ? `<div class="sec"><h2>À payer</h2><button class="link" data-go="budget">Tout voir</button></div><div class="card list">${dueNow.map(dueRow).join("")}</div>` : ""}
  <div class="sec"><h2>Aujourd'hui</h2><button class="link" data-go="operations">Historique</button></div>
  ${today.length ? `<div class="card list">${today.map(txRow).join("")}</div>` : `<div class="card empty">Aucune opération aujourd'hui. Touche <b>+</b> pour noter une dépense.</div>`}
  </main>${fab()}`;
}
const accCard = a => { const t = ACC_TYPES[a.type] || ACC_TYPES.autre;
  return `<button class="acc" data-acc="${a.id}"><span class="dot" style="background:${t[1]}">${t[2]}</span><span class="n">${esc(a.name)}</span><span class="s num ${a.balance < 0 ? "neg" : ""}">${FCFA(a.balance)}</span></button>`; };
const fab = () => `<button class="fab" id="fab" aria-label="Nouvelle opération">+</button>`;
const dueRow = f => { const p = paidFixed(f), c = CAT[f.cat] || { i: "•" };
  return `<div class="li due ${p ? "paid" : ""}"><span class="ic">${c.i}</span><span class="mid"><b>${esc(f.name)}</b><small>${FCFA(f.amount)} / ${f.freq}${p ? " · payé" : ""}</small></span>
    ${p ? `<span class="tag ok">Payé</span>` : `<button class="btn btn-primary btn-sm pay" data-pay="${f.id}">Payer</button>`}</div>`; };

function operationsView() {
  return `${header()}<main class="page"><div class="sec"><h2>Historique</h2><span class="hint">depuis le 1er ${MOIS[new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).getMonth()]}</span></div>
  ${tx.length ? grouped(tx) : `<div class="card empty">Aucune opération pour l'instant.</div>`}</main>${fab()}`;
}
function budgetsOver() {
  const m = thisMonth(); return Object.entries(settings?.budgets || {}).map(([k, v]) => ({ k, v, n: (CAT[k] || {}).n || k, s: m.filter(t => t.kind === "depense" && t.cat === k).reduce((a, t) => a + t.amount, 0) })).filter(b => b.v && b.s > b.v);
}
function budgetView() {
  const need = monthlyNeed(), save = settings?.saveMonth || 0, m = thisMonth();
  const budgets = Object.entries(settings?.budgets || {}).filter(([, v]) => v);
  return `${header()}<main class="page">
  <section class="card pad"><div class="label">Besoin mensuel</div><div class="rav"><div class="v num">${FCFA(need + save)}</div><span class="hint">charges ${FCFA(need)} + épargne ${FCFA(save)}</span></div>
    <p class="hint">Pour tout couvrir, il te faut gagner au moins <b class="num">${FCFA((need + save) / W)}</b> par semaine.</p></section>
  <div class="sec"><h2>Charges fixes</h2><button class="icon-btn dark" id="fxm" aria-label="Options">⋮</button></div>
  <div class="card list">${fixed.map(f => `<div class="li due ${paidFixed(f) ? "paid" : ""}"><span class="ic">${(CAT[f.cat] || { i: "•" }).i}</span>
    <span class="mid"><b>${esc(f.name)}</b><small>${FCFA(f.amount)} / ${f.freq} · ${FCFA(f.freq === "semaine" ? f.amount * W : f.amount)} par mois</small></span>
    ${paidFixed(f) ? `<span class="tag ok">Payé</span>` : `<button class="btn btn-primary btn-sm pay" data-pay="${f.id}">Payer</button>`}
    <button class="icon-btn dark" data-fx="${f.id}" aria-label="Modifier">⋮</button></div>`).join("") || `<div class="empty">Ajoute ton loyer, tes factures, ce que tu donnes chaque semaine…</div>`}</div>
  <div class="sec"><h2>Budgets du mois par catégorie</h2><button class="link" id="addb">+ Ajouter</button></div>
  <div class="card list">${budgets.map(([k, v]) => { const s = m.filter(t => t.kind === "depense" && t.cat === k).reduce((a, t) => a + t.amount, 0), r = s / v;
    return `<button class="cat-row btnli li" data-bud="${k}" style="display:grid"><span class="n">${(CAT[k] || {}).i || ""} ${esc((CAT[k] || {}).n || k)}</span><span class="num ${r > 1 ? "amt out" : ""}">${F(s)} / ${FCFA(v)}</span>
      <div class="bar ${r > 1 ? "over" : r > .8 ? "warn" : ""}"><i style="width:${Math.min(100, r * 100)}%"></i></div></button>`; }).join("") || `<div class="empty">Fixe un plafond pour la nourriture, le transport, les sorties… L'appli te prévient avant que tu dépasses.</div>`}</div>
  </main>${fab()}`;
}
function horizon(rest, perMonth) {
  if (rest <= 0) return "Atteint !";
  const m = Math.ceil(rest / perMonth), y = Math.floor(m / 12), mm = m % 12;
  return `À ${FCFA(perMonth)}/mois : ${y ? y + " an" + (y > 1 ? "s" : "") : ""}${y && mm ? " et " : ""}${mm ? mm + " mois" : ""}`;
}
function epargneView() {
  const save = settings?.saveMonth || 0, done = savedThisMonth();
  return `${header()}<main class="page">
  <section class="card pad"><div class="label">Épargne du mois</div><div class="rav ${done >= save ? "ok" : "ko"}"><div class="v num">${FCFA(done)}</div><span class="hint num">objectif ${FCFA(save)}</span></div>
    <div class="bar ${done >= save ? "" : "warn"}"><i style="width:${save ? Math.min(100, done / save * 100) : 0}%"></i></div>
    <button class="link" id="setsave">Modifier l'objectif mensuel</button></section>
  <div class="sec"><h2>Mes projets</h2><button class="link" id="addg">+ Nouveau projet</button></div>
  <div class="card">${goals.map(g => { const r = g.target ? g.saved / g.target : 0, share = g.monthly || 0;
    return `<div class="goal"><div class="top"><b>${esc(g.name)}</b><button class="icon-btn dark" data-g="${g.id}" aria-label="Options">⋮</button></div>
      <div class="rav"><span class="num"><b>${FCFA(g.saved)}</b> / ${g.target ? FCFA(g.target) : "prix à fixer"}</span><span class="tag ${r >= 1 ? "ok" : ""}">${g.target ? Math.floor(r * 100) + " %" : "—"}</span></div>
      <div class="bar"><i style="width:${Math.min(100, r * 100)}%"></i></div>
      <small>${!g.target ? "Touche ⋮ pour fixer le prix." : share || g.saved >= g.target ? horizon(g.target - g.saved, share) : "Touche ⋮ et fixe une part par mois pour savoir quand tu l'atteindras."}</small></div>`; }).join("") || `<div class="empty">Moto, meubles, téléphone, études… Crée un projet et mets de l'argent dedans petit à petit.</div>`}</div>
  </main>${fab()}`;
}
function bilanView() {
  const list = bilanTx || thisMonth(tx, bilanMonth);
  const prevD = new Date(bilanMonth.getFullYear(), bilanMonth.getMonth() - 1, 1), prev = thisMonth(tx, prevD);
  const out = sumBy(list, "depense"), inc = sumBy(list, "revenu"), pOut = sumBy(prev, "depense");
  const sav = list.filter(t => t.kind === "epargne").reduce((a, t) => a + t.amount, 0);
  const byCat = {}; list.filter(t => t.kind === "depense").forEach(t => byCat[t.cat] = (byCat[t.cat] || 0) + t.amount);
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]), max = cats.length ? cats[0][1] : 1;
  const biz = list.filter(t => t.kind === "depense" && isBiz(t.cat)).reduce((a, t) => a + t.amount, 0);
  const isCur = mk(bilanMonth) === mk(new Date());
  const days = daysInMonth(bilanMonth), daily = Array.from({ length: days }, (_, i) => list.filter(t => t.kind === "depense" && +t.date.slice(8) === i + 1).reduce((a, t) => a + t.amount, 0));
  const dmax = Math.max(1, ...daily), cw = 340 / days;
  return `${header()}<main class="page">
  <div class="card pad month-nav"><button class="icon-btn dark" id="mprev" aria-label="Mois précédent">‹</button><b>${MOIS[bilanMonth.getMonth()]} ${bilanMonth.getFullYear()}</b><button class="icon-btn dark" id="mnext" aria-label="Mois suivant" ${isCur ? "disabled" : ""}>›</button></div>
  <div class="kpis">
    <div class="kpi"><span>Entrées</span><b class="num amt in">${FCFA(inc)}</b></div>
    <div class="kpi"><span>Sorties</span><b class="num amt out">${FCFA(out)}</b>${pOut && !bilanTx ? `<span class="d ${out > pOut ? "amt out" : "amt in"}">${out > pOut ? "+" : ""}${Math.round((out - pOut) / pOut * 100)} % vs mois précédent</span>` : ""}</div>
    <div class="kpi"><span>Épargné</span><b class="num">${FCFA(sav)}</b></div>
    <div class="kpi"><span>Solde du mois</span><b class="num amt ${inc - out - sav >= 0 ? "in" : "out"}">${FCFA(inc - out - sav)}</b></div>
  </div>
  <section class="card pad"><div class="label">Dépenses jour par jour</div>
    <svg class="chart" viewBox="0 0 360 120" role="img" aria-label="Dépenses par jour">
      <line x1="10" y1="100" x2="350" y2="100" stroke="#E3E8E5"/>
      ${daily.map((v, i) => `<rect x="${12 + i * cw}" y="${100 - v / dmax * 86}" width="${Math.max(2, cw - 2)}" height="${v / dmax * 86}" rx="2" fill="${v ? "#1FA35B" : "#E3E8E5"}"><title>${i + 1} : ${FCFA(v)}</title></rect>`).join("")}
      <text x="12" y="115" font-size="10" fill="#5F6B66">1</text><text x="${12 + 14 * cw}" y="115" font-size="10" fill="#5F6B66">15</text><text x="${8 + (days - 1) * cw}" y="115" font-size="10" fill="#5F6B66">${days}</text>
      <text x="350" y="12" font-size="10" fill="#5F6B66" text-anchor="end">max ${FCFA(dmax)}</text>
    </svg></section>
  <section class="card"><div class="pad" style="padding-bottom:4px"><div class="label">Où est parti l'argent</div>${biz ? `<p class="hint">Dont business : ${FCFA(biz)} · perso : ${FCFA(out - biz)}</p>` : ""}</div>
    ${cats.map(([k, v]) => `<div class="cat-row"><span class="n">${(CAT[k] || {}).i || ""} ${esc((CAT[k] || {}).n || k)}</span><span class="num"><b>${FCFA(v)}</b> · ${Math.round(v / out * 100)} %</span><div class="bar"><i style="width:${v / max * 100}%"></i></div></div>`).join("") || `<div class="empty">Aucune dépense ce mois-ci.</div>`}
  </section></main>${fab()}`;
}
function comptesView() {
  return `${header()}<main class="page"><div class="sec"><h2>Mes comptes</h2><button class="link" id="adda">+ Ajouter un compte</button></div>
  <div class="card list">${accounts.map(a => { const t = ACC_TYPES[a.type] || ACC_TYPES.autre;
    return `<div class="li"><span class="ic" style="background:${t[1]};color:#fff;font-size:12px;font-weight:800">${t[2]}</span><span class="mid"><b>${esc(a.name)}</b><small>${t[0]}</small></span>
      <span class="amt num ${a.balance < 0 ? "out" : ""}">${FCFA(a.balance)}</span><button class="icon-btn dark" data-ae="${a.id}" aria-label="Options">⋮</button></div>`; }).join("")}</div>
  <p class="hint" style="padding:0 6px">Le solde se met à jour tout seul à chaque opération. Si un solde ne correspond plus à la réalité, utilise « Corriger le solde ».</p>
  <section class="card pad"><div class="label">Sécurité</div><p class="hint">Un code à 4 chiffres protège l'appli sur ce téléphone.</p>
    <button class="btn btn-secondary btn-sm" id="setpin">${localStorage.getItem("ma-pin-" + me.uid) ? "Changer ou retirer le code" : "Mettre un code"}</button></section>
  </main>${fab()}`;
}

/* ---------- premier lancement ---------- */
const PRESET_EMAIL = "denahoueamerveil@gmail.com";
const PRESET = {
  accounts: [["MTN MoMo 1", "mtn"], ["MTN MoMo 2", "mtn"], ["Moov Money", "moov"], ["Celtis Cash", "celtis"], ["UBA", "banque"], ["Espèces", "cash"]],
  fixed: [["Loyer", 45000, "mois", "loyer"], ["Eau", 2000, "mois", "eau"], ["Électricité", 10000, "mois", "electricite"], ["Ravitaillement", 30000, "mois", "ravitaillement"],
    ["Argent de poche", 10500, "semaine", "poche"], ["Tontine familiale (mois)", 52000, "mois", "tontine"], ["Tontine familiale (semaine)", 4000, "semaine", "tontine"],
    ["Parents", 20000, "semaine", "parents"], ["Copine", 15000, "mois", "couple"]],
  goals: [["Spécialisation au Canada", 30000000], ["Moto", 900000], ["Samsung S26 Ultra", 0], ["Armoire", 90000], ["Lit", 45000], ["Table à manger", 50000], ["Divans", 200000], ["Télévision", 200000], ["Formation : investir en bourse", 0]],
  saveMonth: 300000
};
function onboardingView() {
  const preset = me.email.toLowerCase() === PRESET_EMAIL;
  $("#app").innerHTML = `${header()}<main class="page"><section class="card pad onb">
    <h2>Bienvenue ${esc(me.name)} 👋</h2>
    ${preset ? `<p>J'ai préparé ton profil avec ce que tu m'as donné : 6 comptes (2 MTN, Moov, Celtis, UBA, espèces), tes 9 charges fixes, 300 000 F d'épargne par mois et tes 9 projets (Canada, moto, meubles…).</p>
      <button class="btn btn-primary" id="usepreset">Charger mon profil</button><hr style="border:0;border-top:1px solid var(--line);width:100%">` : ""}
    <p>${preset ? "Ou commence à vide : " : ""}coche les comptes que tu utilises. Tu pourras en ajouter d'autres ensuite.</p>
    <div class="chk-list">${Object.entries(ACC_TYPES).map(([k, t]) => `<label class="chk"><input type="checkbox" value="${k}" ${k === "cash" ? "checked" : ""}><span>${t[0]}</span></label>`).join("")}</div>
    <button class="btn ${preset ? "btn-secondary" : "btn-primary"}" id="start">Commencer</button></section></main>`;
  if ($("#usepreset")) $("#usepreset").onclick = async () => {
    $("#usepreset").disabled = true;
    const b = writeBatch(db);
    PRESET.accounts.forEach(([name, type], i) => b.set(doc(col("accounts")), { name, type, balance: 0, order: i }));
    PRESET.fixed.forEach(([name, amount, freq, cat]) => b.set(doc(col("fixed")), { name, amount, freq, cat }));
    PRESET.goals.forEach(([name, target], i) => b.set(doc(col("goals")), { name, target, saved: 0, order: i, monthly: i === 0 ? 250000 : i === 1 ? 50000 : 0 }));
    b.set(doc(db, "users", me.uid), { saveMonth: PRESET.saveMonth, ready: true, name: me.name }, { merge: true });
    view = "comptes";
    await b.commit().catch(() => toast("Échec. Vérifie ta connexion."));
    render(); toast("Profil chargé. Mets maintenant le solde réel de chaque compte.");
  };
  $("#start").onclick = async () => {
    const types = [...document.querySelectorAll(".chk input:checked")].map(i => i.value);
    if (!types.length) { toast("Coche au moins un compte."); return; }
    const b = writeBatch(db);
    types.forEach((t, i) => b.set(doc(col("accounts")), { name: ACC_TYPES[t][0], type: t, balance: 0, order: i }));
    b.set(doc(db, "users", me.uid), { saveMonth: 0, ready: true, name: me.name }, { merge: true });
    view = "comptes";
    await b.commit().catch(() => toast("Échec. Vérifie ta connexion."));
    render(); toast("Mets maintenant le solde réel de chaque compte.");
  };
}

/* ---------- code ---------- */
async function hash(s) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s + me.uid)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join(""); }
function pinView(mode = "unlock", first = "") {
  let v = "";
  const title = { unlock: "Entre ton code", set: "Choisis un code à 4 chiffres", confirm: "Confirme le code" }[mode];
  const draw = () => {
    $("#app").innerHTML = `<div class="login"><div class="logo">mon<b>argent</b></div><div class="card-box" style="align-items:center"><h2>${title}</h2>
      <div class="pin-dots">${[0, 1, 2, 3].map(i => `<i class="${i < v.length ? "f" : ""}"></i>`).join("")}</div><div class="err" id="pe"></div>
      <div class="pad-keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9, "", 0, "⌫"].map(k => k === "" ? "<span></span>" : `<button data-k="${k}">${k}</button>`).join("")}</div>
      ${mode === "unlock" ? `<button class="link" id="pout">Code oublié ? Se déconnecter</button>` : `<button class="link" id="pcancel">Annuler</button>`}</div></div>`;
    document.querySelectorAll("[data-k]").forEach(b => b.onclick = () => press(b.dataset.k));
    if ($("#pout")) $("#pout").onclick = () => { localStorage.removeItem("ma-pin-" + me.uid); signOut(auth); };
    if ($("#pcancel")) $("#pcancel").onclick = () => render();
  };
  const press = async k => {
    if (k === "⌫") v = v.slice(0, -1); else if (v.length < 4) v += k;
    draw();
    if (v.length < 4) return;
    if (mode === "unlock") { if (await hash(v) === localStorage.getItem("ma-pin-" + me.uid)) { unlocked = true; render(); } else { v = ""; draw(); $("#pe").textContent = "Code incorrect."; } }
    else if (mode === "set") pinView("confirm", v);
    else if (v === first) { localStorage.setItem("ma-pin-" + me.uid, await hash(v)); unlocked = true; toast("Code activé"); render(); }
    else { pinView("set"); setTimeout(() => $("#pe").textContent = "Les codes ne correspondent pas.", 0); }
  };
  draw();
}

/* ---------- rendu ---------- */
function render() {
  if (!me) return;
  if (!unlocked) { pinView("unlock"); return; }
  if ($("#layer .sheet")) return;
  if (settings === null) { $("#app").innerHTML = `<div class="splash"><div class="logo">mon<b>argent</b></div></div>`; return; }
  if (!settings.ready && !accounts.length) { onboardingView(); bindCommon(); return; }
  const V = { accueil: accueilView, operations: operationsView, budget: budgetView, epargne: epargneView, bilan: bilanView, comptes: comptesView };
  $("#app").innerHTML = (V[view] || accueilView)();
  bindCommon(); bindView();
}
function bindCommon() {
  if ($("#menu")) $("#menu").onclick = () => openMenu([
    ...Object.entries(VIEWS).map(([k, n]) => [k, n, ""]),
    ["notif", "Activer le rappel du soir", "Chaque soir à 21h : « As-tu noté tes dépenses ? »"],
    ["install", "Installer l'application", "Icône sur l'écran d'accueil"],
    ["out", "Se déconnecter", esc(me.email)]
  ], k => {
    if (VIEWS[k]) { view = k; render(); scrollTo(0, 0); }
    if (k === "notif") enableNotifs();
    if (k === "install") toast("Dans Chrome : ⋮ puis « Installer l'application »");
    if (k === "out") signOut(auth);
  }, $("#menu").parentElement, view);
  if ($("#fab")) $("#fab").onclick = () => openMenu([
    ["depense", "Dépense", "Ce qui sort, même 50 F"], ["revenu", "Entrée d'argent", "Ventes, salaire, cadeau…"],
    ["transfert", "Transfert entre comptes", "MTN → Moov, retrait, dépôt…"], ["epargne", "Mettre de côté", "Pour un projet"]
  ], k => txSheet(k), null, null, true);
}
function bindView() {
  document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => { view = b.dataset.go; render(); scrollTo(0, 0); });
  document.querySelectorAll("[data-tx]").forEach(b => b.onclick = () => { const t = tx.find(x => x.id === b.dataset.tx); if (t) openMenu([["del", "Supprimer cette opération", "Le solde du compte est corrigé automatiquement"]], () => confirmDo("Supprimer cette opération ?", () => deleteTx(t)), b, null); });
  document.querySelectorAll("[data-pay]").forEach(b => b.onclick = () => { const f = fixed.find(x => x.id === b.dataset.pay); txSheet("depense", { amount: f.amount, cat: f.cat, note: f.name, fixedId: f.id, period: period(f) }); });
  document.querySelectorAll("[data-acc]").forEach(b => b.onclick = () => { view = "comptes"; render(); });
  document.querySelectorAll("[data-ae]").forEach(b => b.onclick = () => { const a = accounts.find(x => x.id === b.dataset.ae);
    openMenu([["fix", "Corriger le solde", "Mettre le montant réel affiché sur ton téléphone"], ["ren", "Renommer", ""], ["del", "Supprimer le compte", "L'historique est gardé"]], k => {
      if (k === "fix") formSheet("Solde réel de « " + a.name + " »", [["v", "Montant en FCFA", "number", a.balance]], v => updateDoc(ref("accounts", a.id), { balance: +v.v || 0 }).then(() => toast("Solde corrigé")));
      if (k === "ren") formSheet("Renommer le compte", [["v", "Nom", "text", a.name]], v => v.v.trim() && updateDoc(ref("accounts", a.id), { name: v.v.trim() }));
      if (k === "del") confirmDo(`Supprimer « ${a.name} » ?`, () => deleteDoc(ref("accounts", a.id)));
    }, b.parentElement); });
  if ($("#adda")) $("#adda").onclick = () => openMenu(Object.entries(ACC_TYPES).map(([k, t]) => [k, t[0], ""]), k =>
    formSheet("Nouveau compte " + ACC_TYPES[k][0], [["n", "Nom (ex. MTN MoMo 2)", "text", ACC_TYPES[k][0]], ["b", "Solde actuel en FCFA", "number", ""]], v =>
      setDoc(doc(col("accounts")), { name: v.n.trim() || ACC_TYPES[k][0], type: k, balance: +v.b || 0, order: accounts.length })), $("#adda").parentElement);
  if ($("#fxm")) $("#fxm").onclick = () => openMenu([["add", "Ajouter une charge fixe", "Loyer, facture, somme donnée chaque semaine…"]], () => fixedSheet(), $("#fxm").parentElement);
  document.querySelectorAll("[data-fx]").forEach(b => b.onclick = () => { const f = fixed.find(x => x.id === b.dataset.fx);
    openMenu([["edit", "Modifier", ""], ["del", "Supprimer", ""]], k => { if (k === "edit") fixedSheet(f); if (k === "del") confirmDo(`Supprimer « ${f.name} » ?`, () => deleteDoc(ref("fixed", f.id))); }, b.parentElement); });
  if ($("#addb")) $("#addb").onclick = () => budgetSheet();
  document.querySelectorAll("[data-bud]").forEach(b => b.onclick = () => budgetSheet(b.dataset.bud));
  if ($("#setsave")) $("#setsave").onclick = () => formSheet("Épargne mensuelle visée", [["v", "Montant par mois en FCFA", "number", settings.saveMonth || ""]], v => setDoc(doc(db, "users", me.uid), { saveMonth: +v.v || 0 }, { merge: true }));
  if ($("#addg")) $("#addg").onclick = () => goalSheet();
  document.querySelectorAll("[data-g]").forEach(b => b.onclick = () => { const g = goals.find(x => x.id === b.dataset.g);
    openMenu([["put", "Mettre de l'argent dedans", ""], ["take", "Retirer de l'argent", "Le remettre sur un compte"], ["edit", "Modifier le prix ou la part mensuelle", ""], ["del", "Supprimer le projet", ""]], k => {
      if (k === "put") txSheet("epargne", { goal: g.id });
      if (k === "take") txSheet("retrait", { goal: g.id });
      if (k === "edit") goalSheet(g);
      if (k === "del") confirmDo(`Supprimer « ${g.name} » ?`, () => deleteDoc(ref("goals", g.id)));
    }, b.parentElement); });
  if ($("#setpin")) $("#setpin").onclick = () => { if (localStorage.getItem("ma-pin-" + me.uid)) openMenu([["ch", "Changer le code", ""], ["rm", "Retirer le code", ""]], k => { if (k === "ch") pinView("set"); else { localStorage.removeItem("ma-pin-" + me.uid); toast("Code retiré"); render(); } }, $("#setpin").parentElement); else pinView("set"); };
  if ($("#mprev")) $("#mprev").onclick = () => loadMonth(new Date(bilanMonth.getFullYear(), bilanMonth.getMonth() - 1, 1));
  if ($("#mnext")) $("#mnext").onclick = () => loadMonth(new Date(bilanMonth.getFullYear(), bilanMonth.getMonth() + 1, 1));
}
async function loadMonth(d) {
  bilanMonth = d; const old = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
  if (d >= old) { bilanTx = null; render(); return; }
  const s = await getDocs(query(col("tx"), where("date", ">=", dk(d)), where("date", "<=", mk(d) + "-31"))).catch(() => null);
  bilanTx = s ? s.docs.map(x => x.data()) : []; render();
}

/* ---------- fenêtres ---------- */
function sheet(title, body, onOk, okLabel = "Enregistrer") {
  $("#layer").innerHTML = "";
  const w = document.createElement("div"); w.className = "sheet";
  w.innerHTML = `<div class="panel" role="dialog" aria-label="${esc(title)}"><div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn dark" id="x" aria-label="Fermer">×</button></div>${body}
    <div class="err" id="se"></div><button class="btn btn-primary" id="ok">${okLabel}</button></div>`;
  $("#layer").appendChild(w);
  const close = () => { $("#layer").innerHTML = ""; render(); };
  w.addEventListener("click", e => { if (e.target === w) close(); }); $("#x").onclick = close;
  $("#ok").onclick = () => { if (onOk(w) !== false) close(); };
  return w;
}
function formSheet(title, fields, onSave) {
  const w = sheet(title, fields.map(([k, l, t, v]) => `<label class="fl"><span>${l}</span><input class="field" id="f-${k}" type="${t}" ${t === "number" ? 'inputmode="numeric"' : ""} value="${esc(v)}"></label>`).join(""),
    () => { const v = Object.fromEntries(fields.map(([k]) => [k, $("#f-" + k).value])); onSave(v); });
  setTimeout(() => { const i = w.querySelector("input"); if (i) { i.focus(); i.select(); } }, 50);
}
function confirmDo(q, fn) { sheet(q, `<p class="hint">Cette action est définitive.</p>`, () => { fn(); }, "Oui, confirmer"); }
const accOptions = sel => accounts.map(a => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.name)} · ${FCFA(a.balance)}</option>`).join("");
function txSheet(kind, pre = {}) {
  if (!accounts.length) { toast("Ajoute d'abord un compte."); view = "comptes"; render(); return; }
  const last = JSON.parse(localStorage.getItem("ma-last") || "{}");
  const titles = { depense: "Nouvelle dépense", revenu: "Entrée d'argent", transfert: "Transfert entre comptes", epargne: "Mettre de côté", retrait: "Retirer d'un projet" };
  const cats = kind === "revenu" ? CAT_IN : CAT_OUT;
  const usage = {}; tx.forEach(t => usage[t.cat] = (usage[t.cat] || 0) + 1);
  const sorted = [...cats].sort((a, b) => (usage[b[0]] || 0) - (usage[a[0]] || 0));
  const defCat = pre.cat || (last[kind + "Cat"] && CAT[last[kind + "Cat"]] ? last[kind + "Cat"] : sorted[0][0]);
  const defAcc = last[kind + "Acc"] && accounts.find(a => a.id === last[kind + "Acc"]) ? last[kind + "Acc"] : accounts[0].id;
  const body = `<input class="amount-in ${kind === "revenu" || kind === "retrait" ? "in" : kind === "transfert" ? "" : "out"}" id="amt" inputmode="numeric" placeholder="0" value="${pre.amount || ""}" autocomplete="off"><div class="cur">FCFA</div>
    ${kind === "depense" || kind === "revenu" ? `<label class="fl"><span>Catégorie</span><select class="field" id="cat">${sorted.map(([k, n, i]) => `<option value="${k}" ${k === defCat ? "selected" : ""}>${i} ${n}</option>`).join("")}</select></label>` : ""}
    ${kind === "epargne" || kind === "retrait" ? `<label class="fl"><span>Projet</span><select class="field" id="goal">${goals.map(g => `<option value="${g.id}" ${g.id === pre.goal ? "selected" : ""}>${esc(g.name)} · ${FCFA(g.saved)}</option>`).join("")}</select></label>` : ""}
    <div class="${kind === "transfert" ? "grid2" : ""}"><label class="fl"><span>${kind === "transfert" ? "Depuis" : kind === "revenu" || kind === "retrait" ? "Sur le compte" : "Payé avec"}</span><select class="field" id="acc">${accOptions(defAcc)}</select></label>
    ${kind === "transfert" ? `<label class="fl"><span>Vers</span><select class="field" id="to">${accOptions(accounts[1] ? accounts.find(a => a.id !== defAcc).id : defAcc)}</select></label>` : ""}</div>
    ${kind === "transfert" ? `<label class="fl"><span>Frais de transfert (facultatif)</span><input class="field" id="fee" inputmode="numeric" placeholder="0"></label>` : ""}
    <div class="grid2"><label class="fl"><span>Date</span><input class="field" id="date" type="date" value="${dk(new Date())}" max="${dk(new Date())}"></label>
    <label class="fl"><span>Note (facultatif)</span><input class="field" id="note" maxlength="80" value="${esc(pre.note || "")}" placeholder="ex. zem, pain…"></label></div>`;
  const w = sheet(titles[kind], body, () => {
    const amount = Math.round(+$("#amt").value.replace(/\D/g, ""));
    if (!amount) { $("#se").textContent = "Écris un montant."; return false; }
    const t = { kind, amount, account: $("#acc").value, date: $("#date").value || dk(new Date()), note: $("#note").value.trim() };
    if ($("#cat")) { t.cat = $("#cat").value; t.scope = isBiz(t.cat) ? "business" : "perso"; }
    if ($("#goal")) { if (!goals.length) { $("#se").textContent = "Crée d'abord un projet dans Épargne."; return false; } t.goal = $("#goal").value; }
    if (kind === "transfert") { t.to = $("#to").value; t.fee = Math.round(+($("#fee").value || "0").replace(/\D/g, "")); if (t.to === t.account) { $("#se").textContent = "Choisis deux comptes différents."; return false; } }
    if (pre.fixedId) { t.fixedId = pre.fixedId; t.period = pre.period; }
    const a = accounts.find(x => x.id === t.account);
    if ((kind === "depense" || kind === "transfert" || kind === "epargne") && a && a.balance - amount - (t.fee || 0) < 0 && !w.dataset.forced) {
      w.dataset.forced = "1"; $("#se").textContent = `Le solde de ${a.name} deviendrait négatif (${FCFA(a.balance - amount - (t.fee || 0))}). Vérifie le compte, ou touche encore Enregistrer.`; return false;
    }
    saveTx(t);
    last[kind + "Acc"] = t.account; if (t.cat) last[kind + "Cat"] = t.cat; localStorage.setItem("ma-last", JSON.stringify(last));
    const over = t.cat && settings?.budgets?.[t.cat] ? thisMonth().filter(x => x.kind === "depense" && x.cat === t.cat).reduce((s, x) => s + x.amount, 0) + amount - settings.budgets[t.cat] : 0;
    toast(over > 0 ? `Noté. Budget « ${CAT[t.cat].n} » dépassé de ${FCFA(over)} !` : "Noté ✓");
  });
  setTimeout(() => $("#amt")?.focus(), 60);
  $("#amt").oninput = e => { const d = e.target.value.replace(/\D/g, ""); e.target.value = d ? F(+d) : ""; };
  if (pre.amount) $("#amt").value = F(pre.amount);
}
function fixedSheet(f = {}) {
  sheet(f.id ? "Modifier la charge" : "Nouvelle charge fixe", `<label class="fl"><span>Nom</span><input class="field" id="fn" value="${esc(f.name || "")}" placeholder="ex. Loyer"></label>
    <div class="grid2"><label class="fl"><span>Montant FCFA</span><input class="field" id="fa" inputmode="numeric" value="${f.amount || ""}"></label>
    <label class="fl"><span>Fréquence</span><select class="field" id="ff"><option value="mois" ${f.freq !== "semaine" ? "selected" : ""}>Par mois</option><option value="semaine" ${f.freq === "semaine" ? "selected" : ""}>Par semaine</option></select></label></div>
    <label class="fl"><span>Catégorie</span><select class="field" id="fc">${CAT_OUT.map(([k, n, i]) => `<option value="${k}" ${k === f.cat ? "selected" : ""}>${i} ${n}</option>`).join("")}</select></label>`, () => {
    const d = { name: $("#fn").value.trim(), amount: Math.round(+$("#fa").value.replace(/\D/g, "")), freq: $("#ff").value, cat: $("#fc").value };
    if (!d.name || !d.amount) { $("#se").textContent = "Écris un nom et un montant."; return false; }
    setDoc(f.id ? ref("fixed", f.id) : doc(col("fixed")), d);
  });
}
function goalSheet(g = {}) {
  sheet(g.id ? "Modifier le projet" : "Nouveau projet", `<label class="fl"><span>Nom</span><input class="field" id="gn" value="${esc(g.name || "")}" placeholder="ex. Moto"></label>
    <div class="grid2"><label class="fl"><span>Prix / montant visé</span><input class="field" id="gt" inputmode="numeric" value="${g.target || ""}"></label>
    <label class="fl"><span>Part par mois</span><input class="field" id="gm" inputmode="numeric" value="${g.monthly || ""}" placeholder="facultatif"></label></div>
    <p class="hint">La part par mois sert à calculer quand tu atteindras ce projet.</p>`, () => {
    const d = { name: $("#gn").value.trim(), target: Math.round(+$("#gt").value.replace(/\D/g, "")) || 0, monthly: Math.round(+$("#gm").value.replace(/\D/g, "")) || 0 };
    if (!d.name) { $("#se").textContent = "Écris un nom."; return false; }
    if (g.id) updateDoc(ref("goals", g.id), d); else setDoc(doc(col("goals")), { ...d, saved: 0, order: goals.length });
  });
}
function budgetSheet(cat) {
  const cur = settings?.budgets || {};
  sheet("Budget mensuel par catégorie", `<label class="fl"><span>Catégorie</span><select class="field" id="bc">${CAT_OUT.map(([k, n, i]) => `<option value="${k}" ${k === cat ? "selected" : ""}>${i} ${n}</option>`).join("")}</select></label>
    <label class="fl"><span>Plafond par mois (0 pour retirer)</span><input class="field" id="bv" inputmode="numeric" value="${cat ? cur[cat] || "" : ""}"></label>`, () => {
    const k = $("#bc").value, v = Math.round(+$("#bv").value.replace(/\D/g, "")) || 0;
    setDoc(doc(db, "users", me.uid), { budgets: { ...cur, [k]: v } }, { merge: true });
  });
}
function openMenu(items, onPick, anchor, current, fixedPos) {
  document.querySelectorAll(".menu").forEach(m => m.remove());
  const m = document.createElement("div"); m.className = "menu" + (fixedPos ? " fixed" : "");
  m.innerHTML = items.map(([k, t, s]) => `<button data-k="${k}" class="${k === "del" ? "danger" : ""}" ${current === k ? 'aria-pressed="true"' : ""}><span>${t}</span>${s ? `<small>${s}</small>` : ""}</button>`).join("");
  if (fixedPos || !anchor) document.body.appendChild(m); else { anchor.style.position = anchor.style.position || "relative"; anchor.appendChild(m); }
  setTimeout(() => document.addEventListener("click", function h(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener("click", h); } }), 0);
  m.querySelectorAll("button").forEach(b => b.onclick = ev => { ev.stopPropagation(); m.remove(); onPick(b.dataset.k); });
}
function toast(t) { document.querySelectorAll(".toast").forEach(x => x.remove()); const el = document.createElement("div"); el.className = "toast"; el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 3000); }

/* ---------- rappel du soir ---------- */
async function enableNotifs() {
  try {
    if (!(await isSupported())) { toast("Ce téléphone ne gère pas les rappels ici. Installe d'abord l'application."); return; }
    if (await Notification.requestPermission() !== "granted") { toast("Rappels refusés. Autorise-les dans les réglages du téléphone."); return; }
    const reg = swReg || await navigator.serviceWorker.ready;
    const token = await getToken(getMessaging(fb), { vapidKey, serviceWorkerRegistration: reg });
    await setDoc(doc(db, "argentTokens", token), { uid: me.uid, ts: Date.now() });
    toast("Rappel du soir activé (21h)");
  } catch (e) { toast("Impossible d'activer le rappel. Réessaie avec du réseau."); }
}
addEventListener("online", () => { online = true; });
addEventListener("offline", () => { online = false; });
setInterval(() => { if (!document.hidden) render(); }, 60000);
