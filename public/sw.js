// 서비스 워커: 앱 설치(홈 화면) + 화면이 꺼져 있을 때 푸시 알림 표시
importScripts('/js/config.js');
const CACHE = 'bogo-v1';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/ui.js', '/js/logic.js', '/js/config.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
// 네트워크 우선, 끊기면 저장해 둔 화면
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)).catch(() => {}); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html'))));
});

// 푸시(Firebase Cloud Messaging)
const cfg = self.BOGO_CONFIG || {};
if (cfg.firebase) {
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js', 'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
  firebase.initializeApp(cfg.firebase);
  firebase.messaging(); // 알림(notification)이 담긴 메시지는 화면이 꺼져 있으면 자동으로 표시됩니다.
}
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.location.origin) && 'focus' in c) return c.focus();
    return self.clients.openWindow('/#mine');
  }));
});
