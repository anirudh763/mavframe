const CACHE = 'mavframe-workbench-2026-11-15-11';
const ASSETS = [
  './', 'index.html', 'trust.html', 'CLOUD_SYNC.md', 'SUPABASE_SYNC_SETUP.sql', 'dialect-coverage.json', 'manifest.webmanifest', 'favicon.svg', 'og-card.png',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png', 'icons/apple-touch-icon.png',
  'mavframe.wasm', 'css/ui.css', 'css/inspector.css',
  'css/atkinson-hyperlegible-latin-400-normal.woff2', 'css/atkinson-hyperlegible-latin-700-normal.woff2',
  'css/OFL-Atkinson-Hyperlegible.txt', 'css/IBMPlexSans-Regular.woff2', 'css/IBMPlexMono-Regular.woff2', 'licenses/IBM-Plex-OFL.txt', 'LICENSE-MAVLink.txt', 'licenses/lucide-ISC.txt',
  'js/app.js', 'js/core.js', 'js/anatomy.js', 'js/finding.js', 'js/rows.js', 'js/theme.js', 'js/msgdefs.js', 'js/custom-dialect.js',
  'js/capture-report.js', 'js/link-health.js', 'js/live-core.js', 'js/serial.js', 'js/tools-worker.js', 'js/nav-icons.js', 'js/local-profile.js', 'js/pwa.js', 'js/team-config.js', 'js/sync-provider.js',
  'sample/sample-flight.tlog', 'sample/real-flight-redacted.tlog', 'sample/real-flight-provenance.md'
];
const expectedType = path => {
  if (/\.html$/.test(path) || path === './') return 'text/html';
  if (/\.css$/.test(path)) return 'text/css';
  if (/\.js$/.test(path)) return 'javascript';
  if (/\.wasm$/.test(path)) return 'application/wasm';
  if (/\.png$/.test(path)) return 'image/png';
  if (/\.svg$/.test(path)) return 'image/svg+xml';
  if (/\.woff2$/.test(path)) return 'font/woff2';
  if (/\.tlog$/.test(path)) return 'application/octet-stream';
  if (/\.webmanifest$/.test(path)) return 'application/manifest+json';
  if (/\.json$/.test(path)) return 'application/json';
  if (/\.(md|sql)$/.test(path)) return 'text/plain';
  return 'text/plain';
};
const assetURLs = ASSETS.map(path => new URL(path, self.registration.scope).href);
const allowed = new Set(assetURLs);
const canonical = request => { const url = new URL(request.url); url.hash = ''; return url.href; };
const hasExpectedType = (response, path) => {
  const type = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  const expected = expectedType(path);
  return expected === 'javascript' ? /^(text|application)\/(javascript|ecmascript)$/.test(type) : type === expected;
};

self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  try {
    for (let index = 0; index < ASSETS.length; index++) {
      const path = ASSETS[index]; const url = assetURLs[index];
      const response = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
      if (!response.ok || response.type === 'opaque' || !hasExpectedType(response, path)) {
        throw new Error(`Required offline asset failed validation: ${path}`);
      }
      await cache.put(url, response);
    }
  } catch (error) {
    await caches.delete(CACHE);
    throw error;
  }
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  // Keep prior Mavframe versions while other already-open pages may still use them.
  // Site-data cleanup is browser-controlled; unrelated origin caches are never touched.
  await self.clients.claim();
})()));

self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
  if (event.data?.type === 'GET_OFFLINE_STATUS') event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const keys = new Set((await cache.keys()).map(canonical));
    const ready = assetURLs.every(url => keys.has(url));
    event.ports[0]?.postMessage({ type: 'OFFLINE_STATUS', cache: CACHE, ready, assetCount: keys.size, requiredCount: ASSETS.length });
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = canonical(event.request);
  if (!allowed.has(url)) {
    const target = new URL(event.request.url);
    const scope = new URL(self.registration.scope);
    const relative = target.pathname.slice(scope.pathname.length);
    if (event.request.mode === 'navigate' && target.origin === scope.origin && target.pathname.startsWith(scope.pathname) && ['', 'anomalies', 'stream', 'system'].includes(relative)) {
      event.respondWith((async () => {
        try { return await fetch(event.request); }
        catch { return (await caches.open(CACHE)).match(new URL('index.html', scope).href); }
      })());
    }
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(url);
    if (cached) return cached;
    // No runtime caching: only this exact, prevalidated public allowlist is eligible.
    // Failed JS/Wasm/worker requests stay failures; never substitute the HTML shell.
    return fetch(event.request);
  })());
});
