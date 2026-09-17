/* AZT service worker
 * - 앱 셸(HTML/CSS/JS/아이콘/규칙 JSON)만 캐시
 * - HTML·엔진·규칙은 network-first (배포 즉시 반영), 그 밖의 정적 파일은 stale-while-revalidate
 * - Firebase / Spotify / Gemini 등 API 요청은 건드리지 않음
 * 배포할 때마다 VERSION 을 올리면 구캐시가 자동 삭제됩니다.
 */
const VERSION = 'azt-v7';
/* [2026-09-17] '/rules.compiled.json' 은 없는 경로였다(실제는 /rules/ 아래). cache.addAll 은 하나라도
   실패하면 전체가 실패하므로, 그동안 앱 셸 사전 캐시가 통째로 조용히 실패하고 있었다(.catch 로 삼켜짐).
   경로를 고치고, 추천에 꼭 필요한 engine.js · pwa.js 를 셸에 넣었다. */
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/rules/rules.compiled.json',
  '/engine/engine.js',
  '/pwa.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
];

// 캐시하지 않을 호스트 (API/실시간 데이터)
const BYPASS_HOSTS = [
  'firestore.googleapis.com',
  'firebase.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'www.googleapis.com',
  'generativelanguage.googleapis.com',
  'api.spotify.com',
  'accounts.spotify.com',
  'open.spotify.com',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL).catch(() => {})) // 일부 파일이 없어도 설치는 진행
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (BYPASS_HOSTS.includes(url.hostname)) return;          // API는 그대로 네트워크
  if (url.origin !== self.location.origin) return;           // CDN 등 외부 정적 파일도 그대로

  const isHTML = req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html');
  /* 추천 알고리즘 파일(엔진·규칙)도 HTML 과 같은 network-first.
     stale-while-revalidate 로 두면 배포 직후 '새 index.html + 옛 engine.js/규칙' 조합으로 한 번 실행된다 —
     화면은 새 버전인데 추천은 옛 규칙으로 나가고, 그 세션 로그가 옛 해시로 찍힌다. */
  const isAlgo = url.pathname.startsWith('/engine/') || url.pathname.startsWith('/rules/');

  if (isHTML || isAlgo) {
    // network-first: 최신 우선, 실패(오프라인) 시 캐시
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();                       // 본문을 쓰기 전에 먼저 복제
          if (res.ok) caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true })
          .then((r) => r || (isHTML ? caches.match('/index.html') : Response.error())))
    );
    return;
  }

  // stale-while-revalidate: 캐시 즉시 응답 + 백그라운드 갱신
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {}); }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// 앱에서 postMessage({type:'SKIP_WAITING'}) 보내면 즉시 새 버전 적용
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// 알림 탭 → 앱 열고 피드백 시트 열기
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) { c.navigate(target); return c.focus(); } }
      return self.clients.openWindow(target);
    })
  );
});
