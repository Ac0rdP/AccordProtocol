const CACHE_NAME = "accord-shell-v1";
const APP_SHELL_FILES = [
  "/",
  "/index.html",
  "/app",
  "/manifest.webmanifest",
  "/brands-solid.png",
];

// Install: pre-cache the critical app shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

// Activate: clean up outdated caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
          }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Fetch: serve app shell offline and cache dynamic resources
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Ignore non-GET requests and browser extensions
  if (request.method !== "GET" || !request.url.startsWith("http")) {
    return;
  }

  // Navigation requests: Network-first, fallback to cached index.html shell
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          const shell = await caches.match("/index.html");
          return shell || caches.match("/");
        }),
    );
    return;
  }

  // Static assets & scripts: Cache-first with network fallback
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Refresh cache in the background
        fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches
                .open(CACHE_NAME)
                .then((cache) => cache.put(request, networkResponse));
            }
          })
          .catch(() => {});
        return cachedResponse;
      }

      return fetch(request)
        .then((response) => {
          if (
            response &&
            response.status === 200 &&
            (request.url.includes("/assets/") || request.url.endsWith(".png") || request.url.endsWith(".svg"))
          ) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request));
    }),
  );
});
