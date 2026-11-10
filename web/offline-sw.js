// Only public viewer assets are cached. API responses and credentials are excluded.
const CACHE = 'wrench-offline-v2';
const ASSETS = ["/js/offline.js", "/js/offline_store.js", "/js/pcb_color_rules.js", "/js/pcb_library_viewer.js", "/js/shared/render_scheduler.js", "/offline.html", "/styles/pcb_library.css", "/styles/settings.css"];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('wrench-offline-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch', event => {
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||url.origin!==self.location.origin||!ASSETS.includes(url.pathname)) return;
 event.respondWith(fetch(event.request).catch(()=>caches.match(url.pathname)));
});
