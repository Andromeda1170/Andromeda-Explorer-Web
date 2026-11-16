/* ============================================================
 * Navigator — Panel, Einstellungen, Bedienung, Start
 * Teil von navigation.html. Alle Navigator-Dateien teilen sich
 * den globalen Gültigkeitsbereich und werden in fester
 * Reihenfolge geladen (siehe navigation.html).
 * ============================================================ */
"use strict";

// ----- Panel / Follow / Cache -----
function openPanel() { $("panel").classList.add("show"); }
function closePanel() { $("panel").classList.remove("show"); }
function switchPane(name) {
  $$(".tab-bar button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab-pane").forEach(p => p.classList.toggle("active", p.dataset.pane === name));
}
function updateFollowButtons() { $("followBtn").classList.toggle("active", app.followActive); }
function releaseFollow(opts) {
  if (!app.followActive) return;
  app.followActive = false;
  settings.follow = false;
  const cb = $("set_follow");
  if (cb) cb.checked = false;
  saveSettings();
  updateFollowButtons();
  // Beim Drehen mit zwei Fingern die neue Ausrichtung behalten
  if (opts && opts.keepBearing) { app._unwrappedMapBearing = null; }
  else resetMapRotation();
  updateRotationLayerState();
}
function setViewKeepFollow(latlng, zoom, opts) {
  app._suppressZoomRelease = true;
  app.map.setView(latlng, zoom, opts);
  clearTimeout(app._suppressZoomReleaseTimer);
  app._suppressZoomReleaseTimer = setTimeout(() => { app._suppressZoomRelease = false; }, 500);
}
function bindTitlePopup() {
  const el = $("routeTitle");
  const popup = $("titlePopup");
  let hideTimer = null;
  el.addEventListener("click", e => {
    e.stopPropagation();
    const full = el.dataset.fullTitle || el.textContent;
    if (!full) return;
    popup.textContent = full;
    popup.classList.remove("hidden");
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => popup.classList.add("hidden"), 3500);
  });
  document.addEventListener("click", e => {
    if (!e.target.closest("#titlePopup") && !e.target.closest("#routeTitle")) popup.classList.add("hidden");
  });
}
async function refreshCacheInfo() {
  const count = await countCachedTiles();
  const label = $("cacheCountLabel");
  const sub = $("cacheCountSub");
  const warn = $("cacheWarning");
  if (label) label.textContent = `${count} Kacheln im Cache`;
  if (sub) sub.textContent = count > 0
    ? "Zwischengespeicherte Karten bleiben erhalten"
    : "Noch keine Kacheln gespeichert";
  if (warn) warn.style.display = count > CACHE_WARN_THRESHOLD ? "" : "none";
}

// ----- Settings -----
function refreshSettingsUI() {
  $("set_darkmode").checked = document.body.classList.contains("dark");
  $("set_follow").checked = settings.follow;
  $("set_zoom").value = settings.zoom;
  $("set_zoom_val").textContent = settings.zoom;
  $("set_compass").checked = settings.compass;
  $("set_route_color").value = settings.routeColor;
  $("set_route_opacity").value = settings.routeOpacity;
  $("set_route_opacity_val").textContent = Math.round(settings.routeOpacity * 100) + " %";
  $("set_arrows").checked = settings.arrows;
  $("set_arrow_density").value = settings.arrowDensity;
  $("set_arrow_density_val").textContent = settings.arrowDensity + " m";
  $("set_autocache").checked = settings.autocache;
  $("set_turn_notice").checked = settings.turnNotice;
  $("set_rotate_map").checked = settings.rotateMap;
  $("set_approachSacPreferred").value = String(settings.approachSacPreferred);
  $("set_approachSacLimit").value = String(settings.approachSacLimit);
  $("set_approachCyclingProfile").value = settings.approachCyclingProfile;
  $("set_approach_color").value = settings.approachLineColor || APPROACH_COLOR;
  $("set_approach_opacity").value = settings.approachLineOpacity || 0.9;
  $("set_approach_opacity_val").textContent = Math.round((settings.approachLineOpacity || 0.9) * 100) + " %";
  const sc = $("set_speed_cycling");
  if (sc) sc.checked = settings.showSpeedCycling;
  const sh = $("set_speed_hiking");
  if (sh) sh.checked = settings.showSpeedHiking;
  const sr = $("set_speed_running");
  if (sr) sr.checked = settings.showSpeedRunning;
}
function recalcApproachIfActive(trigger) {
  if (!app.approachRoute.active) return;
  const activity = app.approachRoute.activity || "hiking";
  if (trigger === "cycling" && activity !== "cycling") return;
  if (trigger === "sac" && activity === "cycling") return;
  const targets = app.approachRoute.targets && app.approachRoute.targets.length
    ? app.approachRoute.targets.slice()
    : (app.approachRoute.finalTarget ? [app.approachRoute.finalTarget] : []);
  if (!targets.length) return;
  toast("Einstellung geändert — Route wird neu berechnet.", "success");
  navigateToTargets(activity, targets, {
    mode: app.approachRoute.mode || "custom",
    targetIsStart: !!app.approachRoute.targetIsStart,
    silent: true,
  });
}
function bindSettings() {
  refreshSettingsUI();
  updateGeoStatus();
  const ffHint = $("firefoxHint");
  if (ffHint && IS_FIREFOX) ffHint.style.display = "";
  $("set_follow").addEventListener("change", e => {
    settings.follow = e.target.checked;
    app.followActive = settings.follow;
    updateFollowButtons();
    saveSettings();
    if (app.followActive) updateMapBearing(); else resetMapRotation();
    updateRotationLayerState();
    refreshVisibleTiles();
  });
  $("set_zoom").addEventListener("input", e => {
    settings.zoom = parseInt(e.target.value);
    $("set_zoom_val").textContent = settings.zoom;
    saveSettings();
    if (app.followActive && app.userLastPos && app.geoActive) {
      setViewKeepFollow([app.userLastPos.lat, app.userLastPos.lon], settings.zoom);
    }
  });
  $("set_compass").addEventListener("change", e => {
    settings.compass = e.target.checked;
    saveSettings();
    if (settings.compass && app.geoActive) startCompass(); else stopCompass();
  });
  $("set_turn_notice").addEventListener("change", e => {
    settings.turnNotice = e.target.checked;
    saveSettings();
    if (!settings.turnNotice) hideTurnBanner();
    else if (app.userLastPos && app.routeLatLngs.length) {
      const r = distanceToRoute(app.userLastPos.lat, app.userLastPos.lon);
      if (r) updateTurnBanner(r.cumDist);
    }
  });
  $("set_rotate_map").addEventListener("change", e => {
    settings.rotateMap = e.target.checked;
    saveSettings();
    if (settings.rotateMap && app.followActive) updateMapBearing(); else resetMapRotation();
    updateRotationLayerState();
    refreshVisibleTiles();
  });
  $("set_route_color").addEventListener("input", e => {
    settings.routeColor = e.target.value;
    if (app.routeLayer) app.routeLayer.setStyle({ color: settings.routeColor });
    saveSettings();
  });
  $("set_route_opacity").addEventListener("input", e => {
    settings.routeOpacity = parseFloat(e.target.value);
    $("set_route_opacity_val").textContent = Math.round(settings.routeOpacity * 100) + " %";
    if (app.routeLayer) app.routeLayer.setStyle({ opacity: settings.routeOpacity });
    saveSettings();
  });
  $("set_arrows").addEventListener("change", e => {
    settings.arrows = e.target.checked;
    saveSettings();
    refreshArrowLayers();
  });
  $("set_arrow_density").addEventListener("input", e => {
    settings.arrowDensity = parseInt(e.target.value);
    $("set_arrow_density_val").textContent = settings.arrowDensity + " m";
    saveSettings();
    refreshArrowLayers();
  });
  $("set_autocache").addEventListener("change", e => {
    settings.autocache = e.target.checked;
    saveSettings();
    for (const layer of Object.values(app.baseLayers)) layer._autocache = settings.autocache;
    for (const layer of Object.values(app.overlayLayers)) layer._autocache = settings.autocache;
  });
  $("set_startGeo").addEventListener("click", () => startGeolocation());
  $("set_approachSacPreferred").addEventListener("change", e => {
    settings.approachSacPreferred = parseInt(e.target.value, 10) || 0;
    saveSettings();
    recalcApproachIfActive("sac");
  });
  $("set_approachSacLimit").addEventListener("change", e => {
    settings.approachSacLimit = parseInt(e.target.value, 10) || 0;
    saveSettings();
    recalcApproachIfActive("sac");
  });
  $("set_approachCyclingProfile").addEventListener("change", e => {
    settings.approachCyclingProfile = e.target.value;
    saveSettings();
    recalcApproachIfActive("cycling");
  });
  $("set_approach_color").addEventListener("input", e => {
    settings.approachLineColor = e.target.value;
    saveSettings();
    if (app.approachRoute.active) renderApproachRoute();
  });
  $("set_approach_opacity").addEventListener("input", e => {
    settings.approachLineOpacity = parseFloat(e.target.value);
    $("set_approach_opacity_val").textContent = Math.round(settings.approachLineOpacity * 100) + " %";
    saveSettings();
    if (app.approachRoute.layer) app.approachRoute.layer.setStyle({ opacity: settings.approachLineOpacity });
  });

  const scEl = $("set_speed_cycling");
  if (scEl) scEl.addEventListener("change", e => {
    settings.showSpeedCycling = e.target.checked;
    saveSettings();
    updateSpeedDisplay();
  });
  const shEl = $("set_speed_hiking");
  if (shEl) shEl.addEventListener("change", e => {
    settings.showSpeedHiking = e.target.checked;
    saveSettings();
    updateSpeedDisplay();
  });
  const srEl = $("set_speed_running");
  if (srEl) srEl.addEventListener("change", e => {
    settings.showSpeedRunning = e.target.checked;
    saveSettings();
    updateSpeedDisplay();
  });
  $("approachBtnSettings").addEventListener("click", showApproachPrompt);
  $("endApproachBtnSettings").addEventListener("click", endApproachManually);
  $("approachBtnInfo").addEventListener("click", showApproachPrompt);
  $("endApproachBtnInfo").addEventListener("click", endApproachManually);
  $("exportApproachGpxBtn").addEventListener("click", exportApproachAsGpx);
  $("resetSettingsBtn").addEventListener("click", resetSettingsToDefaults);
  $("moreOptionsBtn").addEventListener("click", openMoreOptions);
  $("moreOptionsClose").addEventListener("click", closeMoreOptions);
  $("moreOptionsModal").addEventListener("click", e => {
    if (e.target === $("moreOptionsModal")) closeMoreOptions();
  });
  $("exportTourGpxBtn").addEventListener("click", exportRouteAsGpx);
  $("clearMarkersBtn").addEventListener("click", () => {
    if (!app.markers.length) { toast("Keine Markierungen vorhanden.", "error"); return; }
    if (!confirm(`Alle ${app.markers.length} Markierungen entfernen?`)) return;
    clearAllMarkers();
    toast("Alle Markierungen entfernt.", "success");
  });
  $("clearCacheBtn").addEventListener("click", async () => {
    if (!confirm("Den gesamten Karten-Cache leeren?\n\nDamit werden alle offline gespeicherten Karten entfernt.")) return;
    await clearTileCache();
    toast("Gesamter Cache geleert.", "success");
    refreshCacheInfo();
  });
}
function openMoreOptions() {
  refreshSettingsUI();
  refreshCacheInfo();
  updateMarkerCountDisplay();
  updateGeoStatus();
  $("moreOptionsModal").classList.add("show");
}
function closeMoreOptions() { $("moreOptionsModal").classList.remove("show"); }
function resetSettingsToDefaults() {
  if (!confirm("Alle Einstellungen auf die Standardwerte zurücksetzen?")) return;
  const def = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const k of Object.keys(settings)) delete settings[k];
  Object.assign(settings, def);
  saveSettings();
  AndromedaDarkmode.apply(settings.darkmode);
  AndromedaDarkmode.save(settings.darkmode);
  refreshSettingsUI();
  if (app.routeLayer) app.routeLayer.setStyle({ color: settings.routeColor, opacity: settings.routeOpacity });
  if (app.approachRoute.layer) app.approachRoute.layer.setStyle({ color: settings.approachLineColor, opacity: settings.approachLineOpacity });
  renderArrows();
  app.followActive = settings.follow;
  updateFollowButtons();
  if (settings.compass && app.geoActive) startCompass(); else stopCompass();
  for (const layer of Object.values(app.baseLayers)) layer._autocache = settings.autocache;
  for (const layer of Object.values(app.overlayLayers)) layer._autocache = settings.autocache;
  if (!settings.turnNotice) hideTurnBanner();
  if (settings.rotateMap && app.followActive) updateMapBearing(); else resetMapRotation();
  app.smoothedSpeedKmh = 0;
  app._speedInitialized = false;
  updateSpeedDisplay();
  toast("Einstellungen zurückgesetzt.", "success");
}

// ----- UI-Bindings -----
function bindUI() {
  bindApproachModal();
  bindPlaceDetail();
  bindElevPickerModal();
  bindPoiModal();
  $("openMenuBtn").addEventListener("click", () => openPanel());
  $("panelClose").addEventListener("click", closePanel);
  $("panel").addEventListener("click", e => { if (e.target === $("panel")) closePanel(); });
  $$(".tab-bar button").forEach(b => {
    b.addEventListener("click", () => {
      switchPane(b.dataset.tab);
      if (b.dataset.tab === "waypoints" && app.tourpackData && !app.tourpackData.isGpx) {
        renderWaypointsPane(app.tourpackData.route);
      }
      if (b.dataset.tab === "settings") {
        refreshCacheInfo();
        updateGeoStatus();
        updateMarkerCountDisplay();
        refreshSettingsUI();
      }
      if (b.dataset.tab === "search") setTimeout(() => $("searchInput").focus(), 120);
    });
  });
  $("openFileBtn").addEventListener("click", () => $("fileInput").click());
  $("endTourNavBtn").addEventListener("click", handleEndNavigation);
  $("fileInput").addEventListener("change", async e => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) await handleFile(f);
  });
  $("followBtn").addEventListener("click", () => {
    if (!app.geoActive) { toast("Standort ist nicht aktiv. In den Optionen aktivieren.", "error"); return; }
    app.followActive = true;
    settings.follow = true;
    $("set_follow").checked = true;
    saveSettings();
    updateFollowButtons();
    if (app.userLastPos) {
      setViewKeepFollow([app.userLastPos.lat, app.userLastPos.lon], settings.zoom, { animate: true });
    }
    updateRotationLayerState();
    updateMapBearing();
  });
  $("elevBtn").addEventListener("click", toggleElevation);
  $("closeElev").addEventListener("click", elevPanel.hide);
  $("searchBtn").addEventListener("click", performSearch);
  $("searchInput").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); performSearch(); }
  });
  const dropOverlay = $("dropOverlay");
  let dragCounter = 0;
  window.addEventListener("dragenter", e => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
      dragCounter++; dropOverlay.classList.add("show");
    }
  });
  window.addEventListener("dragleave", () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove("show"); }
  });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", async e => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove("show");
    const f = e.dataTransfer.files[0];
    if (f) await handleFile(f);
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if ($("poiModal").classList.contains("show")) { closePoiModal(); return; }
      if ($("elevPickerModal").classList.contains("show")) { $("elevPickerModal").classList.remove("show"); return; }
      if ($("moreOptionsModal").classList.contains("show")) { closeMoreOptions(); return; }
      if ($("placeDetail").classList.contains("show")) { closePlaceDetail(); return; }
      closePanel();
      $("titlePopup").classList.add("hidden");
    }
  });
  window.addEventListener("resize", () => {
    if (app.map) app.map.invalidateSize();
    if (app.elevationOpen) elevPanel.redraw();
  });
  window.addEventListener("orientationchange", () => {
    setTimeout(() => {
      if (app.map) app.map.invalidateSize();
      if (app.elevationOpen) elevPanel.redraw();
    }, 300);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { pauseGeolocation(); releaseWakeLock(); }
    else if (document.visibilityState === "visible") { resumeGeolocation(); requestWakeLock(); }
  });
  window.addEventListener("beforeunload", (e) => {
    if (app._endingNavigation) return;
    if (app._restoring) return;
    if (!app.currentRouteId && !app.approachRoute.active) return;
    e.preventDefault();
    e.returnValue = "";
    return "";
  });
}
async function handleFile(f) {
  const name = (f.name || "").toLowerCase();
  if (name.endsWith(".gpx")) await loadGpxFile(f);
  else if (name.endsWith(".tourpack") || name.endsWith(".zip")) await loadTourpackFile(f);
  else toast("Nur .tourpack oder .gpx Dateien werden unterstützt.", "error");
}
function checkSecureContext() {
  const isSecure = window.isSecureContext || location.protocol === "https:" ||
    location.protocol === "file:" || location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" || location.hostname === "::1";
  if (isSecure) return;
  const w = document.createElement("div");
  w.id = "secureWarn";
  w.textContent = "⚠️ Standortzugriff nur über HTTPS möglich. Auf diesem Server wird die Position nicht ermittelt.";
  document.body.appendChild(w);
  setTimeout(() => {
    w.style.transition = "opacity .5s"; w.style.opacity = "0";
    setTimeout(() => w.remove(), 600);
  }, 12000);
}
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (!window.isSecureContext) return;
  try {
    const reg = await navigator.serviceWorker.register("./tourpack-nav-sw.js", { scope: "./" });
    console.log("[SW] Registriert:", reg.scope);
  } catch (e) { console.info("[SW] Nicht registriert:", e.message); }
}
async function requestPersistentStorage() {
  if (!(navigator.storage && navigator.storage.persist)) return;
  try {
    const already = await navigator.storage.persisted();
    if (already) return;
    await navigator.storage.persist();
  } catch (e) {}
}
let wakeLock = null;
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  if (document.visibilityState !== "visible") return;
  if (wakeLock !== null) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (e) { wakeLock = null; }
}
async function releaseWakeLock() {
  if (wakeLock === null) return;
  try { await wakeLock.release(); } catch (e) {}
  wakeLock = null;
}

// ----- Init -----
async function init() {
  checkSecureContext();
  loadSettings();
  AndromedaDarkmode.init();
  initMap();
  bindUI();
  bindSettings();
  bindTitlePopup();
  updateRotationLayerState();
  updateMarkerCountDisplay();
  updateHeaderButtons();
  updateTabsVisibility();
  app.followActive = settings.follow;
  updateFollowButtons();
  refreshCacheInfo();
  requestWakeLock();
  registerServiceWorker();
  requestPersistentStorage();
  setupCompassGestureStart();
  startGeolocation();
  try { await restoreSession(); } catch (e) { console.warn("Restore fehlgeschlagen:", e); }
  updateHeaderButtons();
  refreshInfoPane();
}
document.addEventListener("DOMContentLoaded", init);
