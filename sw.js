// sw.js —— 离线缓存（PWA）
const CACHE = 'chan-m-v123';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './css/m.css?v=20260725r',
  './js/app.js?v=20260725q', './js/gesture.js?v=20260725f', './js/fetcher.js?v=20260725i', './js/adjust.js?v=20260725b', './js/macd.js?v=20260725f', './js/model.js?v=20260725f',
  './js/algo.js?v=20260725f', './js/store.js?v=20260725f', './js/table.js?v=20260725v', './js/editor.js?v=20260725f', './js/sync.js?v=20260725g',
  './js/klinechart.js?v=20260804a',
  './data/manifest.json',
];

function networkFirst(req) {
  return caches.open(CACHE).then((cache) =>
    fetch(req)
      .then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => cache.match(req))
  );
}

// data/ 下的 JSON（manifest + 各证券画线）走网络优先，并用去掉 query 的 URL 作为缓存 key，
// 避免 ?v=Date.now() 每次都产生一份无意义的缓存；服务端删除后 404 时同步清掉旧缓存。
function dataFetch(req) {
  const cacheUrl = new URL(req.url);
  cacheUrl.search = '';
  const cacheReq = new Request(cacheUrl.toString(), { mode: 'same-origin' });
  return caches.open(CACHE).then((cache) =>
    fetch(req)
      .then((res) => {
        if (res.ok) {
          cache.put(cacheReq, res.clone());
        } else if (res.status === 404) {
          cache.delete(cacheReq);
        }
        return res;
      })
      .catch(() => cache.match(cacheReq))
  );
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 只拦截 http/https 请求，跳过 chrome-extension:// 等（Cache API 不支持非 http 请求）
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  // JS/CSS/HTML/manifest 网络优先，保证代码更新立即生效
  const isAppAsset = url.pathname.match(/\.(js|css|html|webmanifest|svg)$/);
  // data/ 下的 JSON 也网络优先，避免 PC 端删除/精简周期后手机仍看到旧数据
  const isData = url.pathname.endsWith('.json');

  if (isAppAsset) {
    e.respondWith(networkFirst(e.request));
  } else if (isData) {
    e.respondWith(dataFetch(e.request));
  } else {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
  }
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
