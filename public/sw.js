/* Public application assets only. Financial responses and files never enter this cache. */
const CACHE='below-static-v1.12.0';
const ASSETS=['/index.html','/styles.css','/mobile.css','/app.js','/finance.js','/ui.js','/pwa.js','/manifest.webmanifest','/icons/icon.svg','/icons/icon-192.png','/icons/icon-512.png','/icons/apple-touch-icon.png'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key.startsWith('below-static-') && key!==CACHE).map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('message',event=>{
  if(event.data?.type==='ACTIVATE_UPDATE')self.skipWaiting();
});
self.addEventListener('fetch',event=>{
  const {request}=event,url=new URL(request.url);
  if(request.method!=='GET' || url.origin!==self.location.origin || url.pathname.startsWith('/api/') || url.pathname==='/api')return;
  if(request.mode==='navigate' && (url.pathname==='/' || url.pathname==='/index.html')) {
    event.respondWith((async()=>{
      // Keep HTML and JS on the same asset version until the user accepts an update.
      const cached=await caches.match('/index.html',{cacheName:CACHE});
      return cached || fetch(request);
    })());
    return;
  }
  if(!ASSETS.includes(url.pathname))return;
  event.respondWith((async()=>{
    const cached=await caches.match(url.pathname,{cacheName:CACHE});
    return cached || fetch(request);
  })());
});
