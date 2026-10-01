// 서비스 워커: 앱 설치(홈 화면) + 화면이 꺼져 있어도 푸시 알림 표시 (표준 웹 푸시, 외부 서비스 없음)
const CACHE = 'bogo-v5';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/ui.js', '/js/logic.js', '/js/config.js', '/js/api-server.js', '/js/orgs.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
// 화면 파일: 네트워크 우선, 끊기면 저장해 둔 화면. 서버 요청(/api/)은 저장하지 않음.
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)).catch(() => {}); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html'))));
});

// 푸시 받기 → 알림 표시 + 열려 있는 앱 화면에도 전달
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: '보고 대기', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) c.postMessage({ type: 'bogo-push', data: d });
    await self.registration.showNotification(d.title || '보고 대기', {
      body: d.body || '',
      icon: '/icons/icon-192.png', badge: '/icons/badge-72.png',
      tag: d.kind === 'test' ? 'bogo-test' : 'bogo', renotify: true,
      requireInteraction: d.kind === 'call',
      vibrate: [200, 100, 200, 100, 300],
      data: { url: d.kind === 'test' ? '/' : '/#mine' },
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/#mine';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.location.origin) && 'focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
// 브라우저가 구독을 바꾸면 다음에 앱을 열 때 다시 등록됩니다(resumePush).
