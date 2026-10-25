// Mon Argent : garde l'app en mémoire pour l'ouvrir sans réseau, et affiche les rappels.
const CACHE = "mon-argent-v1";
const FILES = ["./", "index.html", "style.css", "app.js", "firebase-config.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const same = url.origin === location.origin;
  const lib = url.hostname === "www.gstatic.com" || url.hostname.startsWith("fonts.");
  if (!same && !lib) return; // les données passent par Firebase, qui gère lui-même le hors ligne
  const fresh = new Request(req, { cache: "no-store" });
  const save = res => { if (res.ok || res.type === "opaque") { const c = res.clone(); caches.open(CACHE).then(x => x.put(req, c)); } return res; };
  if (same) {
    // Réseau d'abord : les mises à jour apparaissent tout de suite ; la copie sert hors ligne
    e.respondWith(fetch(fresh).then(save).catch(() => caches.match(req).then(r => r || caches.match("./"))));
  } else {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(save)));
  }
});

// Rappels envoyés par le planning (GitHub Actions → Firebase Cloud Messaging)
self.addEventListener("push", e => {
  let d = {};
  try { const j = e.data.json(); d = j.data || j.notification || j; } catch (_) {}
  const title = d.title || "Mon Argent";
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: d.tag || "rappel",
    data: { url: d.url || "./" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL(e.notification.data.url, self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) { c.navigate(target); return c.focus(); }
    return self.clients.openWindow(target);
  }));
});
