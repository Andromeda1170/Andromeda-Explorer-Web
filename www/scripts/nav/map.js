/* ============================================================
 * Navigator — Karte
 * Teil von navigation.html. Alle Navigator-Dateien teilen sich
 * den globalen Gültigkeitsbereich und werden in fester
 * Reihenfolge geladen (siehe navigation.html).
 * ============================================================ */
"use strict";

function refreshVisibleTiles() {
  if (!app.map) return;
  for (const layer of Object.values(app.baseLayers)) if (layer && typeof layer.redraw === "function") try { layer.redraw(); } catch (e) {}
  for (const layer of Object.values(app.overlayLayers)) if (layer && typeof layer.redraw === "function") try { layer.redraw(); } catch (e) {}
}

function osmCachePrefix() {
  return AndromedaI18n.lang() === "de" ? "osm" : "osm_" + AndromedaI18n.lang();
}

function initMap() {
  if (app.map) return;
  app.map = AndromedaMap.createMap("map", [47.5, 11.0], 8);
  const layers = AndromedaMap.createLayers();
  for (const [key, cfg] of Object.entries(AndromedaMap.BASE_LAYERS)) {
    // OSM: deutscher und englischer Stil getrennt im Offline-Speicher
    const prefix = key === "osm" ? osmCachePrefix() : key;
    const cached = createCachedTileLayer(cfg.url, cfg.options, prefix);
    layers.baseLayers[key] = cached;
  }
  AndromedaMap.followLanguage(layers.baseLayers.osm, l => { l._cachePrefix = osmCachePrefix(); });
  for (const [key, cfg] of Object.entries(AndromedaMap.OVERLAYS)) {
    const cached = createCachedTileLayer(cfg.url, { maxZoom: 18, opacity: 0.9, attribution: cfg.attribution }, "overlay_" + key);
    layers.overlayLayers[key] = cached;
  }
  app.baseLayers = layers.baseLayers;
  app.overlayLayers = layers.overlayLayers;
  app.activeBaseLayer = app.baseLayers.osm;
  app.activeBaseLayer.addTo(app.map);
  app.activeBaseKey = "osm";
  AndromedaMap.bindLayerPicker(app.map, app.baseLayers, app.overlayLayers, app, () => {});
  AndromedaMap.addFocusControl(app.map, () => {
    // Der Fokus-Button zoomt ausschließlich auf die geladene Tour.
    // Wegpunkte und Markierungen werden bewusst ignoriert, damit die
    // Route bildfüllend erscheint und nicht durch weit entfernte
    // Markierungen herausgezoomt wird.
    return app.routeLatLngs.slice();
  });
  AndromedaMap.addFullscreenControl(app.map, $("mapWrap"));
  app.arrowLayer = L.layerGroup().addTo(app.map);
  app.waypointLayer = L.layerGroup().addTo(app.map);
  app.searchMarkerLayer = L.layerGroup().addTo(app.map);
  app.poiLayer = L.layerGroup().addTo(app.map);
  app.highlightLayer = L.layerGroup().addTo(app.map);
  // Verschieben, Zoomen, Drehen von Hand beenden das Folgen. Die aktuelle
  // Ausrichtung bleibt dabei erhalten; zurück nach Norden geht es über
  // die Kompassnadel oben rechts.
  app.map.on("dragstart", () => { if (app.followActive && app.geoActive) releaseFollow({ keepBearing: true }); });
  // Mit zwei Fingern gedreht: Folgen beenden, Ausrichtung behalten
  app.map.on("rotatestart", () => { if (app.followActive && app.geoActive) releaseFollow({ keepBearing: true }); });
  // Kompassnadel: Folgen beenden, dann richtet die Engine nach Norden aus
  app.map.on("compassclick", () => { if (app.followActive && app.geoActive) releaseFollow({ keepBearing: true }); });
  // Bei jedem Zoom-Wechsel die Pfeile neu berechnen, damit bei weitem
  // Zoom weniger Pfeile sichtbar sind. Kurz debounced, damit
  // Scroll-Zoom nicht bei jedem Schritt rendert.
  let _arrowZoomTimer = null;
  app.map.on("zoomend", () => {
    if (_arrowZoomTimer) clearTimeout(_arrowZoomTimer);
    _arrowZoomTimer = setTimeout(() => {
      _arrowZoomTimer = null;
      refreshArrowLayers();
    }, 120);
  });
  app.map.on("moveend", () => {
    if (!app.followActive || !app.geoActive || !app.userLastPos) return;
    const c = app.map.getCenter();
    const d = haversineM(c.lat, c.lng, app.userLastPos.lat, app.userLastPos.lon);
    if (d > UNLOCK_DISTANCE_M) releaseFollow({ keepBearing: true });
  });
  app.map.on("zoomstart", () => {
    if (app._suppressZoomRelease) return;
    if (app.followActive && app.geoActive) releaseFollow({ keepBearing: true });
  });
  app.map.on("contextmenu", (e) => {
    if (Date.now() < app._suppressContextmenuUntil) return;
    handleLongPressAt(e.latlng.lat, e.latlng.lng, e.containerPoint);
  });
  bindMapLongPress();
  document.addEventListener("fullscreenchange", () => { if (app.map) setTimeout(() => app.map.invalidateSize(), 250); });
  requestAnimationFrame(() => { if (app.map) app.map.invalidateSize(); });
  setTimeout(() => { if (app.map) app.map.invalidateSize(); }, 250);
}

function bindMapLongPress() {
  const container = app.map.getContainer();
  let timer = null, startX = 0, startY = 0;
  container.addEventListener("touchstart", (e) => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (e.touches.length !== 1) return;
    // Auf Markern, Popups und Knöpfen gibt es kein langes Drücken
    if (e.target.closest && e.target.closest(".leaflet-marker-icon, .leaflet-control, .leaflet-popup")) return;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    timer = setTimeout(() => {
      timer = null;
      app._suppressContextmenuUntil = Date.now() + 1000;
      const rect = container.getBoundingClientRect();
      const pt = L.point(t.clientX - rect.left, t.clientY - rect.top);
      const ll = app.map.containerPointToLatLng(pt);
      handleLongPressAt(ll.lat, ll.lng, pt);
    }, 550);
  }, { passive: true });
  container.addEventListener("touchmove", (e) => {
    if (!timer) return;
    const t = e.touches[0];
    const dx = t.clientX - startX, dy = t.clientY - startY;
    if (Math.sqrt(dx*dx + dy*dy) > 12) { clearTimeout(timer); timer = null; }
  }, { passive: true });
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  // Auf document lauschen: Wird das berührte Element (z. B. ein Marker
  // beim Doppeltippen) entfernt, erreicht touchend den Container nicht mehr.
  document.addEventListener("touchend", cancel, { passive: true, capture: true });
  document.addEventListener("touchcancel", cancel, { passive: true, capture: true });
}

function updateHeaderButtons() {
  const hasRoute = !!(app.tourpackData && app.currentRouteId);
  $("openFileBtn").classList.toggle("hidden", hasRoute);
  const endSection = $("endTourNavSection");
  if (endSection) endSection.style.display = hasRoute ? "" : "none";
}
