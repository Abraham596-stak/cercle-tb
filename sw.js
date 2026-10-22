// Le Cercle TB : garde l'app en mémoire pour l'ouvrir sans réseau, et affiche les rappels.
const CACHE = "cercle-tb-v5";
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
  const ours = url.origin === location.origin || url.hostname === "www.gstatic.com" || url.hostname.startsWith("fonts.");
  if (!ours) return; // les données passent par Firebase, qui gère lui-même le hors ligne
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

// Rappels envoyés par le planning (GitHub Actions → Firebase Cloud Messaging)
self.addEventListener("push", e => {
  let d = {};
  try { const j = e.data.json(); d = j.data || j.notification || j; } catch (_) {}
  const title = d.title || "Le Cercle TB";
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
