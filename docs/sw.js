const CACHE = 'mavframe-workbench-2026-11-14-1';
const ASSETS = ['./', 'index.html', 'favicon.svg', 'mavframe.wasm', 'css/ui.css', 'css/inspector.css',
  'css/atkinson-hyperlegible-latin-400-normal.woff2', 'css/atkinson-hyperlegible-latin-700-normal.woff2', 'css/OFL-Atkinson-Hyperlegible.txt', 'LICENSE-MAVLink.txt', 'licenses/lucide-ISC.txt',
  'js/app.js', 'js/core.js', 'js/anatomy.js', 'js/finding.js', 'js/rows.js', 'js/theme.js', 'js/msgdefs.js',
  'js/capture-report.js', 'js/live-core.js', 'js/serial.js', 'js/tools-worker.js', 'js/nav-icons.js',
  'sample/sample-flight.tlog'];
const allowed = new Set(ASSETS.map(path => new URL(path, self.location.href).href));
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([...allowed]))));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('mavframe-workbench-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !allowed.has(event.request.url)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(event.request)) || fetch(event.request)));
});
