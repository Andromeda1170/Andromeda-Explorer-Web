/* TourPack Navigation — Service Worker
 * Cached die App-Shell (HTML, CSS, JS, Icons der eigenen Origin) sowie
 * Leaflet und JSZip von den CDNs, damit der Navigator offline startet
 * und schnell lädt.
 *
 * WICHTIG: API-Endpunkte werden NICHT angefasst. Sie gehen direkt ans
 * Netz (und durch den Tile-/Nominatim-/BRouter-Cache, der ohnehin auf
 * Server-Ebene existiert). Damit kann der Service Worker keine
 * veralteten Routen- oder Suchantworten ausliefern.
 */

const CACHE_NAME = "tourpack-nav-shell-v98";

// Diese Dateien werden beim Install des Service Workers vorab geladen.
// Sie sind danach offline verfügbar, ohne dass der Nutzer die Seite
// vorher besuchen musste.
// WICHTIG: Neue Dateien, die navigation.html oder tourpack-viewer.html
// laden, hier eintragen — sonst fehlen sie offline.
const PRECACHE_URLS = [
  "./navigation.html",
  "./tourpack-viewer.html",
  "./",

  // Shared CSS
  "./stylesheets/base.css",
  "./stylesheets/layout.css",
  "./stylesheets/components.css",
  "./stylesheets/andromap.css",
  "./stylesheets/map.css",
  "./stylesheets/elevation.css",
  "./stylesheets/tourdetail.css",
  "./stylesheets/navigation.css",

  // Shared JS
  "./scripts/config.js",
  "./scripts/i18n.js",
  "./scripts/lang/de.js",
  "./scripts/lang/en.js",
  "./scripts/lang/en-phrases.js",
  "./scripts/utils.js",
  "./scripts/toast.js",
  "./scripts/darkmode.js",
  "./scripts/modal.js",
  "./scripts/andromap.js",
  "./scripts/mapkit.js",
  "./scripts/elevation.js",
  "./scripts/waystats.js",
  "./scripts/lightbox.js",
  "./scripts/tourdata.js",
  "./scripts/turninstr.js",
  "./scripts/gpx.js",
  "./scripts/directions.js",

  // Navigator (in Ladereihenfolge)
  "./scripts/nav/constants.js",
  "./scripts/nav/osm-labels.js",
  "./scripts/nav/storage.js",
  "./scripts/nav/state.js",
  "./scripts/nav/route-geometry.js",
  "./scripts/nav/turns.js",
  "./scripts/nav/markers.js",
  "./scripts/nav/map.js",
  "./scripts/nav/tour.js",
  "./scripts/nav/gps.js",
  "./scripts/nav/approach.js",
  "./scripts/nav/info.js",
  "./scripts/nav/poi.js",
  "./scripts/nav/search.js",
  "./scripts/nav/gpx-export.js",
  "./scripts/nav/ui.js",

  // Icons / Logo / Favicon
  "./favicon.png",
  "./logo.svg",

  // JSZip (cdnjs)
  "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
];

// Welche Origins dürfen durch den Cache. Alles andere geht direkt ans Netz.
// Wichtig: NICHT tile.openstreetmap.de o. ä. aufnehmen, sonst würde der
// Service Worker die Kacheln cachen und mit dem IndexedDB-Tile-Cache
// der Seite konkurrieren.
const CACHEABLE_ORIGINS = [
  self.location.origin,
  "https://cdnjs.cloudflare.com",
];

// Pfade, die NIE über den Service Worker laufen dürfen.
const API_PREFIXES = [
  "/brouter",
  "/profile",
  "/search",
  "/thumbnail",
  "/tourpack",
  "/upload",
  "/admin",
  "/nominatim",
  "/overpass",
  "/tiles",
  "/refresh",
  "/sitemap.xml",
];

function isApiPath(pathname) {
  for (const p of API_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p + "?")) {
      return true;
    }
  }
  return false;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      for (const url of PRECACHE_URLS) {
        try {
          const res = await fetch(url, { cache: "reload" });
          if (res.ok) await cache.put(url, res);
        } catch (e) {
          // Einzelne fehlende Datei darf den Rest nicht blockieren.
        }
      }
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  if (!CACHEABLE_ORIGINS.includes(url.origin)) return;
  if (isApiPath(url.pathname)) return;

  const isNavigation = req.mode === "navigate";

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // Navigationen: network-first. Die HTML muss immer frisch
      // sein, sonst sieht der Nutzer nach einem Update die alte
      // Version aus dem Cache. Bei Offline greift der Cache.
      if (isNavigation) {
        try {
          const res = await fetch(req);
          if (res && res.ok) {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        } catch (e) {
          const cached =
            (await cache.match(req, { ignoreSearch: true })) ||
            (await cache.match("./navigation.html", { ignoreSearch: true })) ||
            (await cache.match("./", { ignoreSearch: true }));
          if (cached) return cached;
          throw e;
        }
      }

      // Statische Assets (CSS, JS, Bilder): stale-while-revalidate.
      const cached = await cache.match(req);
      if (cached) {
        fetch(req).then((res) => {
          if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        }).catch(() => {});
        return cached;
      }

      const res = await fetch(req);
      if (res && res.ok) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    })()
  );
});
