/* ============================================================
 * Navigator — Einstellungen, Sitzungs-Speicher, Kachel-Cache
 * Teil von navigation.html. Alle Navigator-Dateien teilen sich
 * den globalen Gültigkeitsbereich und werden in fester
 * Reihenfolge geladen (siehe navigation.html).
 * ============================================================ */
"use strict";

const SETTINGS_KEY = "tourpack_nav_settings_v2";
const DEFAULT_SETTINGS = {
  darkmode: false,
  base: "osm",
  overlays: { hiking: false, cycling: false },
  follow: true,
  zoom: 16,
  compass: true,
  routeColor: "#2a6fbf",
  routeOpacity: 0.9,
  arrows: true,
  arrowDensity: 300,
  autocache: true,
  turnNotice: true,
  rotateMap: true,
  approachSacPreferred: 1,
  approachSacLimit: 2,
  approachCyclingProfile: "trekking",
  approachLineColor: "#e67e22",
  approachLineOpacity: 0.9,
  showSpeedHiking: false,
  showSpeedRunning: false,
  showSpeedCycling: true,
};
const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    Object.assign(settings, obj);
    if (obj.overlays) Object.assign(settings.overlays, obj.overlays);
  } catch (e) {}
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
}

// ----- IndexedDB State (Route, Marker) -----
const STATE_DB_NAME = "tourpack_nav_state_v1";
const STATE_STORE = "state";
let _stateDbPromise = null;
function openStateDB() {
  if (_stateDbPromise) return _stateDbPromise;
  _stateDbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("IndexedDB nicht verfügbar")); return; }
    const req = indexedDB.open(STATE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _stateDbPromise;
}
async function stateGet(key) {
  try {
    const db = await openStateDB();
    return new Promise(resolve => {
      const tx = db.transaction(STATE_STORE, "readonly");
      const req = tx.objectStore(STATE_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) { return null; }
}
async function statePut(key, value) {
  try {
    const db = await openStateDB();
    return new Promise(resolve => {
      const tx = db.transaction(STATE_STORE, "readwrite");
      tx.objectStore(STATE_STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) { return false; }
}
async function stateDelete(key) {
  try {
    const db = await openStateDB();
    return new Promise(resolve => {
      const tx = db.transaction(STATE_STORE, "readwrite");
      tx.objectStore(STATE_STORE).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) { return false; }
}
async function saveRouteToState(type, fileName, blob) {
  await statePut("route", { type, fileName, blob, savedAt: new Date().toISOString() });
}
async function saveMarkersToState() {
  const data = app.markers.map(m => ({ lat: m.lat, lon: m.lon, color: m.color, tags: m.tags }));
  await statePut("markers", { data, savedAt: new Date().toISOString() });
}
async function clearSessionState() {
  await stateDelete("route");
  await stateDelete("markers");
}
function loadWaypointNotified(routeId) {
  if (!routeId) return new Set();
  try { const raw = localStorage.getItem(WP_NOTIFIED_KEY_PREFIX + routeId); return new Set(raw ? JSON.parse(raw) : []); }
  catch (e) { return new Set(); }
}

// ----- IndexedDB Tile-Cache -----
const TILE_DB_NAME = "tourpack_nav_tiles_v1";
const TILE_STORE = "tiles";
let _dbPromise = null;
function openTileDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("IndexedDB nicht verfügbar")); return; }
    const req = indexedDB.open(TILE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TILE_STORE)) db.createObjectStore(TILE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}
async function getCachedTile(key) {
  try {
    const db = await openTileDB();
    return new Promise(resolve => {
      const tx = db.transaction(TILE_STORE, "readonly");
      const req = tx.objectStore(TILE_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) { return null; }
}
async function putCachedTile(key, blob) {
  try {
    const db = await openTileDB();
    return new Promise(resolve => {
      const tx = db.transaction(TILE_STORE, "readwrite");
      tx.objectStore(TILE_STORE).put(blob, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) { return false; }
}
async function clearTileCache() {
  try {
    const db = await openTileDB();
    return new Promise(resolve => {
      const tx = db.transaction(TILE_STORE, "readwrite");
      tx.objectStore(TILE_STORE).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) { return false; }
}
async function countCachedTiles() {
  try {
    const db = await openTileDB();
    return new Promise(resolve => {
      const tx = db.transaction(TILE_STORE, "readonly");
      const req = tx.objectStore(TILE_STORE).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    });
  } catch (e) { return 0; }
}

/* Kachelebene mit IndexedDB-Cache (offline). Reihenfolge:
 *   1. Kachel der aktuellen Tour aus dem Cache
 *   2. allgemeine Kachel (__generic__) aus dem Cache
 *   3. Netz (bei Auto-Cache: speichern)
 * Fehlt alles, zeigt die Engine automatisch die nächstgröbere
 * vorhandene Kachel vergrößert an (fragt dazu erneut hier nach). */
function createCachedTileLayer(url, options, cachePrefix) {
  const layer = L.tileLayer(url, Object.assign({}, options, {
    loadTile: async (coords, tileUrl) => {
      const routeId = (window.app && app.currentRouteId) || "__generic__";
      const suffix = "|" + layer._cachePrefix + "|" + coords.z + "|" + coords.x + "|" + coords.y;
      let cached = await getCachedTile(routeId + suffix);
      if (!cached && routeId !== "__generic__") cached = await getCachedTile("__generic__" + suffix);
      if (cached) return cached;
      if (navigator.onLine === false) return null;
      if (!layer._autocache) return tileUrl;
      try {
        const res = await fetch(tileUrl, { mode: "cors" });
        if (!res.ok) return null;
        const blob = await res.blob();
        putCachedTile(routeId + suffix, blob);
        return blob;
      } catch (err) {
        return null;
      }
    },
  }));
  layer._cachePrefix = cachePrefix;
  layer._autocache = settings.autocache;
  return layer;
}

