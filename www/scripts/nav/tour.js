/* ============================================================
 * Navigator — Tour laden, darstellen, beenden
 * Teil von navigation.html. Alle Navigator-Dateien teilen sich
 * den globalen Gültigkeitsbereich und werden in fester
 * Reihenfolge geladen (siehe navigation.html).
 * ============================================================ */
"use strict";

async function loadTourpackFile(file, opts) {
  opts = opts || {};
  try {
    resetTransientState();
    clearRouteUI();
    setPrimaryLine("Lade …", "", "");
    const zip = await JSZip.loadAsync(file);
    const mf = zip.file("manifest.json");
    const manifest = mf ? JSON.parse(await mf.async("string")) : {};
    const rf = zip.file("route.json");
    const route = rf ? JSON.parse(await rf.async("string")) : {};
    const geomName = route.geometry_file || "geometry.geojson";
    const gf = zip.file(geomName);
    const geometry = gf ? JSON.parse(await gf.async("string")) : { features: [] };
    let description = "";
    if (route.description) {
      if (typeof route.description === "string") description = route.description;
      else if (route.description.file) {
        const df = zip.file(route.description.file);
        if (df) description = await df.async("string");
      }
    }
    for (const url of app.imageURLs) try { URL.revokeObjectURL(url); } catch (e) {}
    app.imageURLs = [];
    const imageCache = new Map();
    async function getImageURL(path) {
      if (imageCache.has(path)) return imageCache.get(path);
      const f = zip.file(path);
      if (!f) { imageCache.set(path, null); return null; }
      const blob = await f.async("blob");
      const url = URL.createObjectURL(blob);
      imageCache.set(path, url);
      app.imageURLs.push(url);
      return url;
    }
    migrateRoute(route);
    const routeId = manifest.id || route.id || ("file:" + file.name);
    app.currentRouteId = routeId;
    app.waypointNotified = loadWaypointNotified(routeId);
    app.tagSegments = route.tag_segments || null;
    const turnHints = AndromedaTurns.fromTourpack(route.turn_instructions);
    app.tourpackData = { manifest, route, geometry, description, getImageURL, isGpx: false, turnHints };
    await renderAll();
    setPrimaryLine("Tour geladen", "Bereit zur Navigation");
    showBarStats();
    toast("Tour geladen.", "success");
    if (!opts.fromRestore) try { await saveRouteToState("tourpack", file.name, file); } catch (e) {}
    updateHeaderButtons();
  } catch (e) {
    console.error(e);
    toast("Fehler beim Laden: " + e.message, "error");
    setPrimaryLine("Fehler", e.message, "err");
  }
}

async function loadGpxFile(file, opts) {
  opts = opts || {};
  try {
    resetTransientState();
    clearRouteUI();
    setPrimaryLine("Lade GPX …", "", "");
    const gpx = AndromedaGpx.parse(await file.text());
    const { coords, tagSegments, waypoints } = gpx;
    const trackName = gpx.trackName || file.name.replace(/\.gpx$/i, "");
    const activity = gpx.activity;
    const features = [];
    if (coords.length) {
      features.push({ type: "Feature", properties: { role: "main" }, geometry: { type: "LineString", coordinates: coords } });
    }
    for (const wp of waypoints) {
      const cc = [wp.lon, wp.lat];
      if (wp.ele != null) cc.push(wp.ele);
      features.push({ type: "Feature", properties: { role: "waypoint", waypoint_id: wp.id, name: wp.name }, geometry: { type: "Point", coordinates: cc } });
    }
    const geometry = { type: "FeatureCollection", features };
    const stats = computeStats(coords);
    const route = { id: "gpx_" + file.name, type: activity, title: trackName, stats, waypoints, images: [], tags: [] };
    const getImageURL = async () => null;
    const routeId = "gpx:" + file.name;
    app.currentRouteId = routeId;
    app.waypointNotified = loadWaypointNotified(routeId);
    app.tagSegments = tagSegments.length > 0 ? tagSegments : null;
    app.tourpackData = { manifest: { source: "gpx" }, route, geometry, description: "", getImageURL, isGpx: true,
      turnHints: gpx.turnInstructions || [] };
    await renderAll();
    setPrimaryLine("GPX geladen", "Bereit zur Navigation");
    showBarStats();
    toast(`GPX geladen: ${coords.length} Punkte`, "success");
    if (!opts.fromRestore) try { await saveRouteToState("gpx", file.name, file); } catch (e) {}
    updateHeaderButtons();
  } catch (e) {
    console.error(e);
    toast("Fehler beim GPX-Laden: " + e.message, "error");
    setPrimaryLine("Fehler", e.message, "err");
  }
}

function resetTransientState() {
  elevPanel.hide();
  elevPanel.clearMarker();
  hideWaypointBanner();
  hideTurnBanner();
  app.lastDistanceToRoute = null;
  closePanel();
  closePlaceDetail();
}

async function restoreSession() {
  app._restoring = true;
  try {
    let routeRec = await stateGet("route");
    if (!routeRec) {
      try {
        const lsRaw = localStorage.getItem("brouter_nav_handoff_v1");
        if (lsRaw) {
          const payload = JSON.parse(lsRaw);
          if (payload && payload.gpx_b64 && payload.fileName) {
            const gpxText = decodeURIComponent(escape(atob(payload.gpx_b64)));
            const blob = new Blob([gpxText], { type: "application/gpx+xml" });
            routeRec = { type: "gpx", fileName: payload.fileName, blob };
          }
          localStorage.removeItem("brouter_nav_handoff_v1");
        }
      } catch (e) {}
    }
    if (routeRec && routeRec.blob && routeRec.fileName) {
      try {
        const file = new File([routeRec.blob], routeRec.fileName, { type: routeRec.blob.type || "application/octet-stream" });
        if (routeRec.type === "gpx") await loadGpxFile(file, { fromRestore: true });
        else await loadTourpackFile(file, { fromRestore: true });
        toast("Letzte Tour wiederhergestellt.", "success");
      } catch (e) { await stateDelete("route"); }
    }
    const markersRec = await stateGet("markers");
    if (markersRec && Array.isArray(markersRec.data) && markersRec.data.length) {
      app._suppressMarkerSave = true;
      for (const m of markersRec.data) {
        if (typeof m.lat !== "number" || typeof m.lon !== "number") continue;
        addMarker({ lat: m.lat, lon: m.lon, color: m.color, tags: m.tags });
      }
      app._suppressMarkerSave = false;
    }
  } catch (e) {} finally { app._restoring = false; }
}

function showEndNavConfirm(message) {
  return new Promise((resolve) => {
    const backdrop = $("endNavModal");
    const okBtn = $("endNavModalOk");
    const cancelBtn = $("endNavModalCancel");
    $("endNavModalMsg").textContent = message;
    backdrop.classList.add("show");
    const cleanup = () => {
      backdrop.classList.remove("show");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      backdrop.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onBackdrop = (e) => { if (e.target === backdrop) onCancel(); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "Enter") { e.preventDefault(); onOk(); }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    backdrop.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

async function handleEndNavigation() {
  if (!app.tourpackData && !app.currentRouteId) return;
  const nMarkers = app.markers.length;
  let msg;
  if (nMarkers > 0) {
    msg = `${nMarkers} Markierung${nMarkers === 1 ? " wird" : "en werden"} aus dem Speicher entfernt. Die geladene Route wird ebenfalls entfernt.`;
  } else {
    msg = "Die geladene Route wird aus dem Speicher entfernt.";
  }
  const ok = await showEndNavConfirm(msg);
  if (!ok) return;
  await endNavigationNow();
}

async function endNavigationNow() {
  app._endingNavigation = true;
  app._suppressMarkerSave = true;
  clearAllMarkers();
  app._suppressMarkerSave = false;
  await clearSessionState();
  clearRouteUI();
  updateHeaderButtons();
  toast("Navigation beendet.", "success");
}

function clearRouteUI() {
  wayHighlight.clear();
  app.tagSegments = null;
  for (const url of app.imageURLs) try { URL.revokeObjectURL(url); } catch (e) {}
  app.imageURLs = [];
  if (app.routeLayer) { try { app.map.removeLayer(app.routeLayer); } catch (e) {} app.routeLayer = null; }
  if (app.arrowLayer) app.arrowLayer.clearLayers();
  if (app.waypointLayer) app.waypointLayer.clearLayers();
  app.tourpackData = null;
  app.currentRouteId = null;
  app._isRoundtrip = false;
  app.routeLatLngs = [];
  app.routeCumDist = [];
  app.waypointsWithDist = [];
  app.waypointNotified = new Set();
  app.elevationData = null;
  app.elevationOpen = false;
  app.lastDistanceToRoute = null;
  resetProjState(app._projStateTour);
  app.turns = [];
  app.turnSource = null;
  clearApproachRoute(true);
  app._promptedForApproach = false;
  app._approachActivity = null;
    // Custom-Start ebenfalls aufräumen.
  clearCustomStart();
  clearPoi();
  elevPanel.hide();
  elevPanel.clearMarker();
  hideWaypointBanner();
  hideTurnBanner();
  closePanel();
  closePlaceDetail();
  resetMapRotation();
  setHeaderTitle("Navigation");
  const badge = $("activityBadge");
  if (badge) badge.style.display = "none";
  const info = $("infoContent");
  if (info) info.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:30px 10px;font-size:13px;">Keine Tour geladen.</div>';
  const wpC = $("waypointsContent");
  if (wpC) wpC.innerHTML = "";
  const imgC = $("imagesContent");
  if (imgC) imgC.innerHTML = "";
  setPrimaryLine("Keine Tour geladen", ".tourpack oder .gpx über 📁 öffnen");
  updateTabsVisibility();
  app.smoothedSpeedKmh = 0;
  app._speedInitialized = false;
  updateSpeedDisplay();
}

async function renderAll() {
  const { route, geometry } = app.tourpackData;
  app._isRoundtrip = isRoundtripGeometry(geometry);
  setHeaderTitle(route.title || "Unbenannte Tour");
  const badge = $("activityBadge");
  badge.textContent = ACTIVITY_LABELS[route.type || "hiking"] || (route.type || "hiking");
  badge.style.display = "";
  renderRoute(geometry);
  renderWaypoints(route);
  setupElevationProfile(route, geometry);
  renderInfoPane(route);
  updateTabsVisibility();
  if (app.tourpackData.isGpx) switchPane("info");
  else renderWaypointsPane(route);
  await renderImagesPane(route, app.tourpackData.getImageURL);
  if (!app.followActive || !app.geoActive) fitRoute();
  updateApproachButtonVisibility();
  updateSpeedDisplay();
}

function setHeaderTitle(title) {
  const el = $("routeTitle");
  el.textContent = title;
  el.title = title;
  el.dataset.fullTitle = title;
}

/* Die Tabs "Wegpunkte" und "Bilder" gibt es nur bei einer geladenen
 * TourPack. Bei reiner GPX oder ohne Tour werden sie ausgeblendet. */
function updateTabsVisibility() {
  const hasTourpack = !!app.tourpackData && !app.tourpackData.isGpx;
  $$(".tab-bar button").forEach(b => {
    const tab = b.dataset.tab;
    if ((tab === "waypoints" || tab === "images") && !hasTourpack) b.style.display = "none";
    else b.style.display = "";
  });
}

function renderRoute(geometry) {
  if (app.routeLayer) { app.map.removeLayer(app.routeLayer); app.routeLayer = null; }
  app.arrowLayer.clearLayers();
  app.waypointLayer.clearLayers();
  const rawCoords = extractLineCoords(geometry);
  if (!rawCoords.length) { app.routeLatLngs = []; app.routeCumDist = []; app.turns = []; app.turnSource = null; return; }
  // Gleiche Aufbereitung wie bei der Sondernavigation (buildNavTrack).
  const track = buildNavTrack(rawCoords, app.tourpackData && app.tourpackData.turnHints);
  app.routeLatLngs = track.latlngs;
  app.routeCumDist = track.cumDist;
  app.turns = track.turns;
  app.turnSource = track.turnSource;
  resetProjState(app._projStateTour);
  app.routeLayer = L.polyline(app.routeLatLngs, {
    color: settings.routeColor, weight: 6, opacity: settings.routeOpacity,
    lineJoin: "round", lineCap: "round",
  }).addTo(app.map);
  applyArrowDensityForRoute();
  renderArrows();
}

function computeArrowInterval() {
  const total = app.routeCumDist[app.routeCumDist.length - 1] || 0;
  const km = total / 1000;
  const activity = (app.tourpackData && app.tourpackData.route && app.tourpackData.route.type) || "hiking";
  let base;
  if (km < 2) base = 100;
  else if (km < 5) base = 200;
  else if (km < 15) base = 400;
  else if (km < 30) base = 800;
  else if (km < 60) base = 1500;
  else if (km < 100) base = 2500;
  else base = 4000;
  if (activity === "cycling") base = Math.round(base * 2);
  else if (activity === "running") base = Math.round(base * 1.3);
  return Math.max(50, Math.min(10000, base));
}
function applyArrowDensityForRoute() {
  const interval = computeArrowInterval();
  settings.arrowDensity = interval;
  saveSettings();
  const slider = $("set_arrow_density");
  if (slider) slider.value = interval;
  const label = $("set_arrow_density_val");
  if (label) label.textContent = interval + " m";
  // Wenn eine Sondernavigation läuft, soll sie die neue Dichte sofort
  // übernehmen (z. B. wenn während einer Tour eine andere geladen wird).
  if (app.approachRoute.active) refreshArrowLayers();
}
function renderArrows() {
  if (!settings.arrows) { app.arrowLayer.clearLayers(); return; }
  AndromedaMap.drawArrows(app.arrowLayer, app.routeLatLngs, {
    map: app.map,
    cumDist: app.routeCumDist,
    baseInterval: Math.max(50, settings.arrowDensity),
    size: ARROW_SIZE,
  });
}

function renderWaypoints(route) {
  app.waypointLayer.clearLayers();
  const waypoints = route.waypoints || [];
  if (app.routeLatLngs.length) {
    app.waypointLayer.addLayer(makeCircleMarker(app.routeLatLngs[0], "#2e8b57", "S"));
    app.waypointLayer.addLayer(makeCircleMarker(app.routeLatLngs[app.routeLatLngs.length - 1], "#c0392b", "Z"));
  }
  app.waypointsWithDist = [];
  waypoints.forEach((wp, i) => {
    if (wp.lat == null || wp.lon == null) return;
    let routeIdx = 0, bestD = Infinity;
    for (let k = 0; k < app.routeLatLngs.length; k++) {
      const d = haversineM(wp.lat, wp.lon, app.routeLatLngs[k][0], app.routeLatLngs[k][1]);
      if (d < bestD) { bestD = d; routeIdx = k; }
    }
    const cumDist = app.routeCumDist[routeIdx] || 0;
    app.waypointsWithDist.push({ wp, index: i, routeIdx, cumDist });
    const m = AndromedaMap.waypointMarker([wp.lat, wp.lon], i + 1, wp.name);
    m.on("click", () => openWaypointPopup(wp));
    app.waypointLayer.addLayer(m);
  });
  app.waypointsWithDist.sort((a, b) => a.cumDist - b.cumDist);
}

function openWaypointPopup(wp) { openPanel(); switchPane("waypoints"); showWaypointDetail(wp); }
function makeCircleMarker(latlng, color, letter) {
  const html = `<svg width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="11" fill="${color}" stroke="white" stroke-width="3"/><text x="14" y="19" text-anchor="middle" fill="white" font-family="sans-serif" font-size="14" font-weight="bold">${letter}</text></svg>`;
  const icon = L.divIcon({ html, className: "", iconSize: [28, 28], iconAnchor: [14, 14] });
  return L.marker(latlng, { icon, interactive: false });
}
function fitRoute() {
  if (!app.map) return;
  const pts = [...app.routeLatLngs];
  for (const item of app.waypointsWithDist) pts.push([item.wp.lat, item.wp.lon]);
  if (!pts.length) return;
  if (pts.length === 1) { app.map.setView(pts[0], 14, { animate: true }); return; }
  app.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], animate: true });
}
