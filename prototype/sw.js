// 最小構成のService Worker。アプリシェル（HTML/CSS/JS等）をオフラインでも開けるようにする。
// 問題データ・音声はまだ静的ファイルに埋め込まれているのみ（Stage 1/2/3実装後は別途キャッシュ戦略を見直す）。
const CACHE_NAME = "eigo-shukan-juku-shell-v1";
const SHELL_FILES = ["./", "./index.html", "./style.css", "./app.js", "./manifest.json", "./icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// キャッシュ優先。無ければネットワークに取りに行き、取れたら次回用にキャッシュする。
self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && event.request.method === "GET") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
