// 最小構成のService Worker。アプリシェル（HTML/CSS/JS等）をオフラインでも開けるようにする。
//
// 戦略: ネットワーク優先（オンラインなら常に最新を取得し、キャッシュも更新する）。
// オフライン時のみキャッシュにフォールバックする。開発頻度が高くファイルが
// 頻繁に更新されるこの段階では、キャッシュ優先だと「CACHE_NAMEのバージョンを
// 上げ忘れると古い内容が延々と表示され続ける」という事故が起きやすいため
// （実際に2度発生した）、この戦略に変更した。
const CACHE_NAME = "eigo-shukan-juku-shell-v6";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

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

// ネットワーク優先。取得できたらキャッシュも更新する。オフライン等で失敗した時だけキャッシュを使う。
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
