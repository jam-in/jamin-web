// ============================================================
// sw.js — minimal offline cache for the app shell.
// YouTube and mic/recording obviously need the network, but the UI itself
// loads offline so an installed PWA opens instantly.
// ============================================================

const CACHE = "jamin-shell-v23";
const SHELL = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/main.js",
  "./js/constants.js",
  "./js/errors.js",
  "./js/ui.js",
  "./js/video.js",
  "./js/latency.js",
  "./js/search-ui.js",
  "./js/recording.js",
  "./js/tracks-ui.js",
  "./js/timeline-playhead.js",
  "./js/history-ui.js",
  "./js/export-import.js",
  "./js/advanced-ui.js",
  "./js/audio-devices.js",
  "./js/pwa.js",
  "./js/db.js",
  "./js/youtube.js",
  "./js/recorder.js",
  "./js/playback.js",
  "./js/waveform.js",
  "./js/zip.js",
  "./js/search.js",
  "./js/core/events.js",
  "./js/core/sync-math.js",
  "./js/core/track-store.js",
  "./js/core/settings-store.js",
  "./js/core/video-store.js",
  "./js/core/recording-session.js",
  "./js/core/timeline-sync.js",
  "./manifest.webmanifest",
  "./icons/jamin_icon.png",
  "./icons/jam-in logo2 alpha.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only handle same-origin GETs; let YouTube/network requests pass through.
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request)
        .then((resp) => {
          // Runtime-cache same-origin assets we fetch.
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return resp;
        })
        .catch(() => cached);
    })
  );
});
