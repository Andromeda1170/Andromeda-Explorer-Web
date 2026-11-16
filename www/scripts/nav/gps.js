/* ============================================================
 * Navigator — GPS, Kompass, Kartendrehung
 * Teil von navigation.html. Alle Navigator-Dateien teilen sich
 * den globalen Gültigkeitsbereich und werden in fester
 * Reihenfolge geladen (siehe navigation.html).
 * ============================================================ */
"use strict";

// ---------------- GPS / Kompass ----------------
function startGeolocation() {
  if (!("geolocation" in navigator)) { toast("Geolocation wird nicht unterstützt.", "error"); return; }
  if (!window.isSecureContext) { toast("Standort nur über HTTPS möglich.", "error"); return; }
  if (app.geoActive && app.userWatchId != null) { updateGeoStatus(); return; }
  app.geoActive = true;
  app._gpsReady = false;
  _setGpsTimers();
  _startWatch();
  if (settings.compass) startCompass();
  updateGeoStatus();
}
function _setGpsTimers() {
  if (app._gpsHintTimer) clearTimeout(app._gpsHintTimer);
  app._gpsHintTimer = setTimeout(() => {
    app._gpsHintTimer = null;
    if (app.geoActive && !app._gpsReady) toast("GPS sucht noch … (kann bis zu einer Minute dauern)", "warn");
  }, 15000);
  if (app._gpsFailTimer) clearTimeout(app._gpsFailTimer);
  app._gpsFailTimer = setTimeout(() => {
    app._gpsFailTimer = null;
    if (app.geoActive && !app._gpsReady) toast("Kein GPS-Signal. Ist GPS eingeschaltet?", "error");
  }, 90000);
}
function _startWatch() {
  if (!("geolocation" in navigator)) return;
  if (app.userWatchId != null) return;
  const highAccuracy = !IS_FIREFOX;
  try {
    app.userWatchId = navigator.geolocation.watchPosition(
      pos => onUserPositionUpdate(
        pos.coords.latitude, pos.coords.longitude,
        pos.coords.heading, pos.coords.accuracy,
        pos.timestamp, pos.coords.speed
      ),
      err => onGeoError(err),
      { enableHighAccuracy: highAccuracy, maximumAge: 5000, timeout: 30000 }
    );
  } catch (e) { onGeoError(e); }
}
function pauseGeolocation() {
  if (app.userWatchId != null) { try { navigator.geolocation.clearWatch(app.userWatchId); } catch (e) {} app.userWatchId = null; }
  if (app._gpsHintTimer) { clearTimeout(app._gpsHintTimer); app._gpsHintTimer = null; }
  if (app._gpsFailTimer) { clearTimeout(app._gpsFailTimer); app._gpsFailTimer = null; }
  app._unwrappedHeading = null;
  app.userPrevPos = null;
  hideTurnBanner();
  stopCompass();
}
function resumeGeolocation() {
  if (!app.geoActive) return;
  if (app.userWatchId != null) return;
  app._gpsReady = false;
  _setGpsTimers();
  _startWatch();
  if (settings.compass) startCompass();
  updateGeoStatus();
}
function setupCompassGestureStart() {
  const handler = () => {
    if (app.compassActive) return;
    if (!settings.compass) return;
    if (!app.geoActive) return;
    startCompass();
  };
  document.addEventListener("touchend", handler);
  document.addEventListener("click", handler);
}
function applyArrowHeading(headingDeg) {
  if (headingDeg == null || !isFinite(headingDeg)) return;
  if (app._unwrappedHeading == null) { app._unwrappedHeading = headingDeg; }
  else {
    const currentWrapped = ((app._unwrappedHeading % 360) + 360) % 360;
    let delta = headingDeg - currentWrapped;
    if (delta > 180) delta -= 360; else if (delta < -180) delta += 360;
    app._unwrappedHeading += delta;
  }
  const arrow = document.querySelector("#userMarkerInner .arrow");
  if (arrow) {
    arrow.style.transform = `rotate(${app._unwrappedHeading}deg)`;
    arrow.style.transformOrigin = "50% 50%";
  }
}

const MAP_ROTATION_SIGN = 1;
// Kompass reagiert jetzt deutlich flüssiger:
// - THROTTLE auf 100 ms (≈10 Hz) statt 400 ms
// - MIN_DELTA auf 2° statt 7°
// - SMOOTHING auf 0.5 statt 0.15
const MAP_ROTATION_THROTTLE_MS = 100;
const MAP_ROTATION_MIN_DELTA_DEG = 2;
const MAP_ROTATION_SMOOTHING = 0.5;
let _lastBearingSetMs = 0;

/* Drehung läuft über die Karten-Engine (map.setBearing). Die Karte
 * dreht sich so, dass die Blickrichtung oben ist. */
function updateRotationLayerState() {
  // Früher: CSS-Übergang am Dreh-Wrapper. Die Engine animiert selbst.
}
function updateMapBearing() {
  if (!app.map) return;
  if (!settings.rotateMap || !app.followActive) return;
  const heading = (app.userHeading != null && isFinite(app.userHeading)) ? app.userHeading
    : (app.userLastPos && app.userLastPos.heading != null && isFinite(app.userLastPos.heading)) ? app.userLastPos.heading
    : null;
  if (heading == null) return;
  if (app._unwrappedMapBearing == null) {
    let init = heading;
    if (init > 180) init -= 360;
    app._unwrappedMapBearing = init;
  } else {
    const currentWrapped = ((app._unwrappedMapBearing % 360) + 360) % 360;
    let delta = heading - currentWrapped;
    if (delta > 180) delta -= 360; else if (delta < -180) delta += 360;
    if (Math.abs(delta) < MAP_ROTATION_MIN_DELTA_DEG) return;
    app._unwrappedMapBearing += delta * MAP_ROTATION_SMOOTHING;
  }
  const now = Date.now();
  if (now - _lastBearingSetMs < MAP_ROTATION_THROTTLE_MS) return;
  _lastBearingSetMs = now;
  app.map.setBearing(MAP_ROTATION_SIGN * app._unwrappedMapBearing, { duration: 0.3 });
}
function resetMapRotation() {
  app._unwrappedMapBearing = null;
  _lastBearingSetMs = 0;
  if (app.map && app.map.getBearing() !== 0) app.map.resetNorth({ duration: 0.3 });
}

function onUserPositionUpdate(lat, lon, heading, accuracy, timestamp, speed) {
  app._lastAccuracy = accuracy;
  if (!IS_FIREFOX && !AndromedaUtils.isGpsFix(accuracy)) {
    const compassHeading = (app.userHeading != null && isFinite(app.userHeading)) ? app.userHeading : null;
    if (compassHeading != null) {
      const inner = document.getElementById("userMarkerInner");
      if (inner) inner.classList.remove("no-heading");
      applyArrowHeading(compassHeading);
    }
    updateGeoStatus();
    return;
  }
  if (IS_FIREFOX && (typeof accuracy !== "number" || !isFinite(accuracy) || accuracy <= 0)) {
    updateGeoStatus();
    return;
  }
  if (!app._gpsReady) {
    app._gpsReady = true;
    if (app._gpsHintTimer) { clearTimeout(app._gpsHintTimer); app._gpsHintTimer = null; }
    if (app._gpsFailTimer) { clearTimeout(app._gpsFailTimer); app._gpsFailTimer = null; }
  }
  app.userPrevPos = app.userLastPos;
  app.userLastPos = {
    lat, lon,
    heading: heading || null,
    t: (typeof timestamp === "number" && isFinite(timestamp)) ? timestamp : Date.now(),
  };
  rememberTrailPoint(app.userLastPos);

  // Geschwindigkeit: bevorzugt vom GPS gemeldet, sonst aus Positionsdelta
  let kmh = null;
  if (typeof speed === "number" && isFinite(speed) && speed >= 0) {
    kmh = speed * 3.6;
  } else {
    kmh = computeSpeedSample();
  }
  if (kmh != null) {
    if (!app._speedInitialized) {
      app.smoothedSpeedKmh = kmh;
      app._speedInitialized = true;
    } else {
      app.smoothedSpeedKmh = 0.7 * app.smoothedSpeedKmh + 0.3 * kmh;
    }
    if (app.smoothedSpeedKmh < 0.5) app.smoothedSpeedKmh = 0;
    updateSpeedDisplay();
  }
  const compassHeading = (app.userHeading != null && isFinite(app.userHeading)) ? app.userHeading : null;
  const gpsHeading = (heading != null && isFinite(heading)) ? heading : null;
  const headingDeg = compassHeading != null ? compassHeading : gpsHeading;
  if (!app.userMarker) {
    const html = `<div class="user-marker${headingDeg == null ? ' no-heading' : ''}" id="userMarkerInner"><div class="pulse"></div><svg class="arrow" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="11" fill="#1a73e8" stroke="white" stroke-width="2"/><polygon points="12,5 17,17 12,14 7,17" fill="white"/></svg></div>`;
    const icon = L.divIcon({ html, className: "", iconSize: [22, 22], iconAnchor: [11, 11] });
    app.userMarker = L.marker([lat, lon], { icon, interactive: false, zIndexOffset: 1000, rotateWithMap: true }).addTo(app.map);
  } else app.userMarker.setLatLng([lat, lon]);
  const inner = document.getElementById("userMarkerInner");
  if (inner) {
    if (headingDeg != null) { inner.classList.remove("no-heading"); applyArrowHeading(headingDeg); }
    else inner.classList.add("no-heading");
  }
  const circleAcc = (accuracy != null && isFinite(accuracy)) ? accuracy : 0;
  if (!app.userAccuracy) {
    app.userAccuracy = L.circle([lat, lon], {
      radius: circleAcc, color: "#1a73e8", weight: 1, opacity: 0.4,
      fillColor: "#1a73e8", fillOpacity: 0.08, interactive: false,
    }).addTo(app.map);
  } else {
    app.userAccuracy.setLatLng([lat, lon]);
    app.userAccuracy.setRadius(circleAcc);
  }
  if (app.followActive) app.map.setView([lat, lon], settings.zoom, { animate: false });
  updateMapBearing();
  updateNavigationInfo(lat, lon);
  maybeOfferApproachRoute();
  updateApproachButtonVisibility();
  updateFollowButtons();
  updateGeoStatus();
}

function onGeoError(err) {
  if (err && err.code === 1) {
    app.geoActive = false;
    setPrimaryLine("Kein Standort", "In den Einstellungen aktivieren");
    updateGeoStatus();
    return;
  }
  let msg = "Standort konnte nicht ermittelt werden.";
  if (err && err.code === 2) msg = "Standort nicht verfügbar.";
  else if (err && err.code === 3) msg = "Zeitüberschreitung.";
  setPrimaryLine("Standortfehler", msg, "err");
  toast(msg, "error");
  if (!app.userMarker) { app.geoActive = false; updateGeoStatus(); }
}

function updateGeoStatus() {
  const el = $("geoStatusText");
  if (!el) return;
  if (app.geoActive && app.userLastPos) {
    const accStr = app._lastAccuracy != null ? ` · ± ${Math.round(app._lastAccuracy)} m` : "";
    el.textContent = `Aktiv · ${app.userLastPos.lat.toFixed(4)}, ${app.userLastPos.lon.toFixed(4)}${accStr}`;
  } else if (app.geoActive) {
    el.textContent = app._lastAccuracy != null
      ? `Warte auf GPS-Signal … (letzte Messung: ± ${Math.round(app._lastAccuracy)} m)`
      : "Warte auf GPS-Signal …";
  } else el.textContent = "Falls der Zugriff verweigert wurde oder ausgeschaltet ist";
}

let waypointBannerTimer = null;
function hideWaypointBanner() {
  const el = $("waypointBanner");
  el.classList.remove("show");
  if (waypointBannerTimer) { clearTimeout(waypointBannerTimer); waypointBannerTimer = null; }
}

async function startCompass() {
  if (app.compassActive) return;
  if (typeof DeviceOrientationEvent === "undefined") { app.compassSupported = false; return; }
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== "granted") { app.compassSupported = false; return; }
    } catch (e) { app.compassSupported = false; return; }
  }
  let lastAbsoluteMs = 0;
  const applyHeading = (h) => {
    app.userHeading = h;
    // Heading im DOM aktualisieren, auch wenn keine neue GPS-Position
    // kommt. So bleibt der Kompass auch bei Stillstand reagibel.
    const inner = document.getElementById("userMarkerInner");
    if (inner && h != null && isFinite(h)) {
      inner.classList.remove("no-heading");
      applyArrowHeading(h);
    }
    updateMapBearing();
  };
  const extractHeading = (e) => {
    if (e.webkitCompassHeading != null && isFinite(e.webkitCompassHeading)) return e.webkitCompassHeading;
    if (e.alpha != null && isFinite(e.alpha)) return (360 - e.alpha) % 360;
    return null;
  };
  app.compassAbsoluteHandler = (e) => {
    const h = extractHeading(e);
    if (h == null) return;
    lastAbsoluteMs = Date.now();
    applyHeading(h);
  };
  app.compassOrientationHandler = (e) => {
    if (Date.now() - lastAbsoluteMs < 2000) return;
    const h = extractHeading(e);
    if (h == null) return;
    applyHeading(h);
  };
  window.addEventListener("deviceorientationabsolute", app.compassAbsoluteHandler, true);
  window.addEventListener("deviceorientation", app.compassOrientationHandler, true);
  app.compassSupported = true;
  app.compassActive = true;
}
function stopCompass() {
  if (app.compassOrientationHandler) window.removeEventListener("deviceorientation", app.compassOrientationHandler, true);
  if (app.compassAbsoluteHandler) window.removeEventListener("deviceorientationabsolute", app.compassAbsoluteHandler, true);
  app.compassOrientationHandler = null;
  app.compassAbsoluteHandler = null;
  app.compassActive = false;
}
