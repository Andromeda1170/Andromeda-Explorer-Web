/* ============================================================
 * AndromedaExplorer — Zentrale Konfiguration
 * Überall anpassbar. Andere Skripte lesen daraus.
 * ============================================================ */
window.Andromeda = window.Andromeda || {};

// Auf einem echten Host (https://…) laufen alle Anfragen relativ zur
// aktuellen Domain. Caddy leitet /brouter/*, /profile/*, /search,
// /thumbnail/*, /tourpack/*, /nominatim/* und /overpass an die lokalen
// Dienste weiter. Damit gibt es weder Mixed-Content-Probleme noch CORS.
// Nur beim Öffnen per file:// oder auf localhost wird direkt auf die
// lokalen Ports gezeigt.
const _useLocalProxy = (typeof location !== "undefined" && (
  location.protocol === "file:" ||
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1"
));

Object.assign(window.Andromeda, {
  PROXY_URL: _useLocalProxy ? "http://localhost:8080" : location.origin,
  TOURPACK_HANDLER_URL: _useLocalProxy ? "http://localhost:8081" : location.origin,

  // geo-gateway (BRouter, Nominatim, Overpass): lokal Port 8080,
  // öffentlich über Caddy unter derselben Domain.
  NOMINATIM_URL: _useLocalProxy
    ? "http://localhost:8080/nominatim"
    : location.origin + "/nominatim",
  OVERPASS_URL: _useLocalProxy
    ? "http://localhost:8080/overpass"
    : location.origin + "/overpass",

  NAV_URL: "navigation.html",

  // localStorage-Schlüssel
  DARKMODE_KEY: "andromeda_darkmode_v1",
  MAP_VIEW_KEY: "andromeda_map_view_v1",
  LANG_KEY: "andromeda_lang_v1",

  PLAN_EXT: ".brouterplan.json",
  TOURPACK_EXT: ".tourpack",
  GPX_EXT: ".gpx",

  NAV_HANDOFF_DB: "tourpack_nav_state_v1",
  NAV_HANDOFF_STORE: "state",
  NAV_HANDOFF_KEY: "route",

  // Aktivitäts-Grundzeiten (relativ zu BRouters 6 km/h Fuß-Basis)
  ACTIVITY_BASE_TIME_MULT: { hiking: 1.0, cycling: 1.0, running: 0.6 },
});
