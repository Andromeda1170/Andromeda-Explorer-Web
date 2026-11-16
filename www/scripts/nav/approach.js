/* ============================================================
 * Navigator — Sondernavigation (Zustieg, Ziele)
 * Teil von navigation.html. Alle Navigator-Dateien teilen sich
 * den globalen Gültigkeitsbereich und werden in fester
 * Reihenfolge geladen (siehe navigation.html).
 * ============================================================ */
"use strict";

// ---------------- Sondernavigation ----------------
function showApproachStep(stepId) {
  ["approachStep1", "approachStep2", "approachStep3",
   "approachStepProgress", "approachStepError"].forEach(id => {
    const el = $(id);
    if (el) el.style.display = (id === stepId) ? "" : "none";
  });
  const carBtn = $("approachCarTransit");
  if (carBtn) {
    // Nur bei Navigation zur Route anzeigen, nicht bei Markierung
    carBtn.style.display = app._pendingCustomTarget ? "none" : "";
  }
}
function closeApproachModal() {
  const m = $("approachModal");
  if (m) m.classList.remove("show");
  app._pendingCustomTarget = null;
}
function showApproachPrompt() {
  if (!app.routeLatLngs.length) { toast("Keine Route geladen.", "error"); return; }
  if (app.approachRoute.active) { toast("Zustieg zur Route ist bereits aktiv.", "warn"); return; }
  if (!app.userLastPos) { toast("Noch keine Position verfügbar.", "warn"); return; }
  if (!navigator.onLine) { toast("Für die Zustiegs-Route wird eine Internetverbindung benötigt.", "error"); return; }
  const res = distanceToRoute(app.userLastPos.lat, app.userLastPos.lon);
  if (!res || res.distance < APPROACH_THRESHOLD_M) { toast("Sie sind bereits in der Nähe der Route.", "warn"); return; }
  $("approachDistText").textContent =
    `Sie sind aktuell ${fmtKm(res.distance)} von der Route entfernt. ` +
    `Soll der Weg zur Route berechnet werden?`;
  showApproachStep("approachStep1");
  $("approachModal").classList.add("show");
}
function chooseApproachActivity(activity) {
  app._approachActivity = activity;
  const pending = app._pendingCustomTarget;
  if (pending) {
    app._pendingCustomTarget = null;
    closeApproachModal();
    navigateToTargets(activity, [pending], { mode: "custom", targetIsStart: false });
    return;
  }
  showApproachStep("approachStep3");
}
function chooseApproachTarget(toStart) {
  const activity = app._approachActivity || "hiking";
  closeApproachModal();
  startApproachRoute(activity, toStart);
}
async function startApproachRoute(activity, toStart) {
  if (!app.userLastPos || !app.routeLatLngs.length) return;
  let target;
  if (toStart) {
    target = { lat: app.routeLatLngs[0][0], lon: app.routeLatLngs[0][1], name: "Start" };
  } else {
    const halfIdx = Math.floor(app.routeLatLngs.length / 2);
    let bestD = Infinity, bestIdx = 0;
    for (let i = 0; i <= halfIdx; i++) {
      const d = haversineM(app.userLastPos.lat, app.userLastPos.lon, app.routeLatLngs[i][0], app.routeLatLngs[i][1]);
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    target = { lat: app.routeLatLngs[bestIdx][0], lon: app.routeLatLngs[bestIdx][1], name: "Nächster Punkt" };
  }
  await navigateToTargets(activity, [target], { mode: "approach", targetIsStart: toStart });
}
function pickNavigationStart() {
  const isComplete = (ll) => ll && typeof ll.lat === "number" && typeof ll.lon === "number"
    && isFinite(ll.lat) && isFinite(ll.lon);
  if (isComplete(app.customStart)) return { lat: app.customStart.lat, lon: app.customStart.lon };
  if (isComplete(app.userLastPos)) return { lat: app.userLastPos.lat, lon: app.userLastPos.lon };
  return null;
}
async function navigateToTargets(activity, targets, meta) {
  const silent = !!(meta && meta.silent);
  const startLL = pickNavigationStart();
  if (!startLL) { toast("Kein Ausgangspunkt verfügbar. Standort aktivieren.", "error"); return; }
  if (!targets || !targets.length) return;
  const validTargets = targets.filter(t => t && typeof t.lat === "number" && typeof t.lon === "number"
    && isFinite(t.lat) && isFinite(t.lon));
  if (!validTargets.length) { toast("Keine gültigen Zielpunkte.", "error"); return; }
  if (!silent) {
    showApproachStep("approachStepProgress");
    $("approachModal").classList.add("show");
  }
  try {
    const baseProfile = activity === "cycling" ? (settings.approachCyclingProfile || "trekking")
                       : activity === "running" ? "laufen" : "wandern";
    const changes = { turnInstructionMode: 3 };
    if (activity !== "cycling") {
      changes.SAC_scale_limit = String(settings.approachSacLimit);
      changes.SAC_scale_preferred = String(settings.approachSacPreferred);
      changes.SAC_access_penalty = "100000";
    }
    const prepRes = await fetch(`${Andromeda.PROXY_URL}/profile/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: baseProfile, changes }),
    });
    if (!prepRes.ok) throw new Error("Profil konnte nicht vorbereitet werden.");
    const prepData = await prepRes.json();
    const profileName = prepData.profile_name;

    const points = [`${startLL.lon.toFixed(6)},${startLL.lat.toFixed(6)}`];
    for (const t of validTargets) points.push(`${t.lon.toFixed(6)},${t.lat.toFixed(6)}`);

    const params = new URLSearchParams();
    params.set("lonlats", points.join("|"));
    params.set("alternativeidx", "0");
    params.set("format", "geojson");
    params.set("profile", profileName);
    params.set("timode", "3");   // Abbiegeanweisungen im OsmAnd-Stil

    const r = await fetch(`${Andromeda.PROXY_URL}/brouter?${params.toString()}`);
    if (!r.ok) throw new Error("Route konnte nicht berechnet werden (HTTP " + r.status + ").");
    const geojson = await r.json();
    const coords = [];
    for (const feat of (geojson.features || [])) {
      const g = feat.geometry; if (!g) continue;
      if (g.type === "LineString") coords.push(...g.coordinates);
      else if (g.type === "MultiLineString") for (const line of g.coordinates) coords.push(...line);
    }
    if (coords.length < 2) throw new Error("Keine Route erhalten.");

    // Gleiche Aufbereitung wie die Tour-Route (buildNavTrack):
    // verdichten, Distanzen, Abbiegepunkte.
    let hints = [];
    try { hints = AndromedaTurns.fromBrouterGeojson(geojson); } catch (e) { hints = []; }
    const track = buildNavTrack(coords, hints);
    const { latlngs, cumDist } = track;
    resetProjState(app._projStateApproach);

    app.approachRoute.active = true;
    app.approachRoute.mode = meta.mode;
    app.approachRoute.latlngs = latlngs;
    app.approachRoute.cumDist = cumDist;
    app.approachRoute.activity = activity;
    app.approachRoute.targetIsStart = !!meta.targetIsStart;
    app.approachRoute.targets = validTargets.slice();
    app.approachRoute.finalTarget = validTargets[validTargets.length - 1];
    app.approachRoute.turns = track.turns;
    app.approachRoute.turnSource = track.turnSource;

    renderApproachRoute();
    if (!silent) closeApproachModal();
    if (!silent) toast(`Navigation: ${fmtKm(cumDist[cumDist.length - 1])}`, "success");
    updateApproachButtonVisibility();
    elevPanel.updateButtons();
    updateSpeedDisplay();

    if (app.userLastPos) updateNavigationInfo(app.userLastPos.lat, app.userLastPos.lon);
    refreshInfoPane();

    if (!app.routeLatLngs.length) {
      app.elevationDataType = "approach";
      setupElevationForApproach();
      elevPanel.show();
    }
  } catch (e) {
    console.error("Sondernavigation:", e);
    if (silent) toast("Route konnte nicht berechnet werden: " + e.message, "error");
    else { $("approachErrorText").textContent = e.message || "Unbekannter Fehler."; showApproachStep("approachStepError"); }
  }
}

function setCustomStartFromMarker(entry) {
  if (!entry || entry.lat == null || entry.lon == null) return;
  app.customStart = { lat: entry.lat, lon: entry.lon, name: (entry.tags && entry.tags.name) || "Start" };
  renderCustomStartMarker();
  if (app.approachRoute.active) {
    const activity = app.approachRoute.activity || "hiking";
    const targets = app.approachRoute.targets.length ? app.approachRoute.targets.slice()
      : (app.approachRoute.finalTarget ? [app.approachRoute.finalTarget] : []);
    if (targets.length) {
      closePlaceDetail();
      toast("Start aktualisiert — Navigation wird neu berechnet.", "success");
      navigateToTargets(activity, targets, { mode: "custom", targetIsStart: false });
      return;
    }
  }
  closePlaceDetail();
  toast("Start gesetzt. Jetzt über 'Zu diesem Ort navigieren' ein Ziel wählen.", "success");
}
function renderCustomStartMarker() {
  if (app.customStartMarker && app.map) {
    try { app.map.removeLayer(app.customStartMarker); } catch (e) {}
    app.customStartMarker = null;
  }
  if (!app.customStart || !app.map) return;
  const icon = L.divIcon({
    html: `<div style="width:20px;height:20px;border-radius:50%;background:#2e8b57;border:3px solid white;box-shadow:0 0 0 2px rgba(46,139,87,.5),0 2px 6px rgba(0,0,0,.35);"></div>`,
    className: "", iconSize: [20, 20], iconAnchor: [10, 10],
  });
  app.customStartMarker = L.marker([app.customStart.lat, app.customStart.lon],
    { icon, interactive: false, zIndexOffset: 950 }).addTo(app.map);
}
function clearCustomStart() {
  app.customStart = null;
  if (app.customStartMarker && app.map) {
    try { app.map.removeLayer(app.customStartMarker); } catch (e) {}
    app.customStartMarker = null;
  }
}
function startCustomNavigationFromMarker(entry) {
  if (!entry || entry.lat == null || entry.lon == null) return;
  if (!app.userLastPos && !app.customStart) {
    toast("Noch keine Position verfügbar. Standort aktivieren oder Start festlegen.", "error");
    return;
  }
  if (!navigator.onLine) { toast("Für die Navigation wird eine Internetverbindung benötigt.", "error"); return; }
  const newTarget = {
    lat: entry.lat, lon: entry.lon,
    name: (entry.tags && entry.tags.name) || "Zielpunkt",
  };
  if (app.approachRoute.active) {
    if (app.approachRoute.mode === "custom") {
      const ok = confirm("Zu dieser Navigation einen weiteren Punkt hinzufügen?\n\nDer bisherige Zielpunkt wird zum Zwischenziel, der neue Punkt das endgültige Ziel.");
      if (!ok) return;
      const activity = app.approachRoute.activity || "hiking";
      const targets = app.approachRoute.targets.concat([newTarget]);
      closePlaceDetail();
      navigateToTargets(activity, targets, { mode: "custom", targetIsStart: false });
      return;
    }
    const ok = confirm("Die Navigation zur Route ist aktiv. Sie wird beendet, damit zu diesem Punkt navigiert werden kann.\n\nFortfahren?");
    if (!ok) return;
    clearApproachRoute("manual");
  }
  closePlaceDetail();
  app._pendingCustomTarget = newTarget;
  showApproachStep("approachStep2");
  $("approachModal").classList.add("show");
}

function renderApproachRoute() {
  if (!app.map || !app.approachRoute.latlngs.length) return;
  clearApproachRouteLayers();
  app.approachRoute.layer = L.polyline(app.approachRoute.latlngs, {
    color: settings.approachLineColor || APPROACH_COLOR,
    weight: 6, opacity: settings.approachLineOpacity || 0.9,
    lineJoin: "round", lineCap: "round",
  }).addTo(app.map);
  app.approachRoute.arrowLayer = L.layerGroup().addTo(app.map);
  renderArrowsForRoute(
    app.approachRoute.latlngs,
    app.approachRoute.cumDist,
    app.approachRoute.arrowLayer,
    settings.approachLineColor || APPROACH_COLOR
  );
}

/* Zeichnet die Richtungspfeile beider Navigationsarten neu.
 * Wird aufgerufen, wenn sich die Dichte oder die Anzeige-Einstellung
 * ändert, damit Typ 1 und Typ 2 immer synchron sind. */
function refreshArrowLayers() {
  renderArrows();
  if (app.approachRoute.active && app.approachRoute.arrowLayer) {
    renderArrowsForRoute(
      app.approachRoute.latlngs,
      app.approachRoute.cumDist,
      app.approachRoute.arrowLayer,
      settings.approachLineColor || "#e67e22"
    );
  }
}

function renderArrowsForRoute(latlngs, cumDist, layer, color) {
  if (!layer) return;
  AndromedaMap.drawArrows(layer, latlngs, {
    map: app.map,
    cumDist,
    baseInterval: Math.max(50, settings.arrowDensity || 300),
    size: ARROW_SIZE,
    color,
    minTotal: 50,
  });
}
function clearApproachRouteLayers() {
  if (app.approachRoute.layer && app.map) {
    try { app.map.removeLayer(app.approachRoute.layer); } catch (e) {}
    app.approachRoute.layer = null;
  }
  if (app.approachRoute.arrowLayer && app.map) {
    try { app.approachRoute.arrowLayer.clearLayers(); } catch (e) {}
    try { app.map.removeLayer(app.approachRoute.arrowLayer); } catch (e) {}
    app.approachRoute.arrowLayer = null;
  }
}
function clearApproachRoute(mode) {
  const wasActive = app.approachRoute.active;
  clearApproachRouteLayers();
  app.approachRoute.active = false;
  app.approachRoute.mode = null;
  app.approachRoute.latlngs = [];
  app.approachRoute.cumDist = [];
  app.approachRoute.turns = [];
  app.approachRoute.turnSource = null;
  app.approachRoute.activity = null;
  app.approachRoute.targetIsStart = false;
  app.approachRoute.targets = [];
  app.approachRoute.finalTarget = null;
  resetProjState(app._projStateApproach);
  app.lastDistanceToApproach = null;
  hideTurnBanner();
  updateApproachButtonVisibility();
  elevPanel.updateButtons();
  updateSpeedDisplay();
  refreshInfoPane();
  if (!app.routeLatLngs.length) {
    if (app.elevationOpen && app.elevationDataType === "approach") elevPanel.hide();
  }
  if (!wasActive) return;
  if (mode === true) return;
  if (mode === "manual") toast("Navigation zur Route beendet.", "success");
  else toast("Route erreicht — Navigation zur Tour aktiv.", "success");
}
function endApproachManually() {
  if (!app.approachRoute.active) return;
  clearApproachRoute("manual");
  if (app.userLastPos) updateNavigationInfo(app.userLastPos.lat, app.userLastPos.lon);
  refreshInfoPane();
}
/* Wrapper für Typ 2 (Sondernavigation) — Zugriff auf
   app.approachRoute. Verwendet dieselbe Projektions- und
   Disambiguierungslogik wie Typ 1, aber mit eigenem State. */
function distanceToApproachRoute(lat, lon) {
  return projectOntoRoute(
    app.approachRoute.latlngs, app.approachRoute.cumDist,
    lat, lon, app._projStateApproach
  );
}
function maybeOfferApproachRoute() {
  if (app._promptedForApproach) return;
  if (!app.currentRouteId) return;
  if (!app.userLastPos) return;
  if (app.approachRoute.active) return;
  if (!navigator.onLine) return;
  if (!app.routeLatLngs.length) return;
  const res = distanceToRoute(app.userLastPos.lat, app.userLastPos.lon);
  if (!res || res.distance < APPROACH_THRESHOLD_M) return;
  app._promptedForApproach = true;
  setTimeout(() => {
    if (app.approachRoute.active) return;
    if (!app.userLastPos) return;
    const r2 = distanceToRoute(app.userLastPos.lat, app.userLastPos.lon);
    if (r2 && r2.distance >= APPROACH_THRESHOLD_M) showApproachPrompt();
  }, 1200);
}
function updateApproachButtonVisibility() {
  const hasRoute = !!app.currentRouteId && app.routeLatLngs.length > 0;
  const active = !!app.approachRoute.active;
  const far = !!(hasRoute && app.userLastPos &&
                 app.lastDistanceToRoute != null &&
                 app.lastDistanceToRoute >= APPROACH_THRESHOLD_M &&
                 !active && navigator.onLine);
  const endLabel = app.approachRoute.mode === "custom"
    ? "✕ Navigation zur Markierung beenden"
    : "✕ Navigation zur Route beenden";

  const startInfo = $("approachBtnInfo");
  if (startInfo) startInfo.style.display = far ? "" : "none";
  const endInfo = $("endApproachBtnInfo");
  if (endInfo) {
    endInfo.style.display = active ? "" : "none";
    if (active) endInfo.textContent = endLabel;
  }
  const infoWrap = $("approachButtonsInfo");
  if (infoWrap) infoWrap.style.display = (far || active) ? "" : "none";

  const startSet = $("approachBtnSettings");
  if (startSet) startSet.style.display = far ? "" : "none";
  const endSet = $("endApproachBtnSettings");
  if (endSet) {
    endSet.style.display = active ? "" : "none";
    if (active) endSet.textContent = endLabel;
  }
  const setSection = $("approachSection");
  if (setSection) setSection.style.display = (far || active) ? "" : "none";

  const gpxBtn = $("exportApproachGpxBtn");
  if (gpxBtn) gpxBtn.style.display = active ? "" : "none";
}
function bindApproachModal() {
  $("approachNo1").addEventListener("click", closeApproachModal);
  $("approachYes1").addEventListener("click", () => showApproachStep("approachStep2"));
  $("approachActHiking").addEventListener("click", () => chooseApproachActivity("hiking"));
  $("approachActCycling").addEventListener("click", () => chooseApproachActivity("cycling"));
  $("approachActRunning").addEventListener("click", () => chooseApproachActivity("running"));
  $("approachBack2").addEventListener("click", () => {
    if (app._pendingCustomTarget) closeApproachModal();
    else showApproachStep("approachStep1");
  });
  $("approachToNearest").addEventListener("click", () => chooseApproachTarget(false));
  $("approachToStart").addEventListener("click", () => chooseApproachTarget(true));
  $("approachBack3").addEventListener("click", () => showApproachStep("approachStep2"));
  $("approachErrClose").addEventListener("click", closeApproachModal);
  $("approachModal").addEventListener("click", e => {
    if (e.target === $("approachModal")) closeApproachModal();
  });

  // Anfahrt-Modal
  $("approachCarTransit").addEventListener("click", () => {
    closeApproachModal();
    openDirections();
  });
}

/* Anfahrt-Dialog (Auto/Öffis) zum Startpunkt der Tour */
function openDirections() {
  if (!app.routeLatLngs || !app.routeLatLngs.length) {
    toast(t("dir.noStart"), "error");
    return;
  }
  const [lat, lon] = app.routeLatLngs[0];
  AndromedaDirections.open(lat, lon, { note: t("dir.noteNavigatorActive") });
}

// ----- Long-Press auf Sondernavigations-Route -----
const LONG_PRESS_ROUTE_HIT_PX = 28;
function handleLongPressAt(lat, lng, containerPt) {
  if (app.approachRoute.active && app.approachRoute.latlngs.length >= 2) {
    const hit = findClosestOnApproach(lat, lng, containerPt);
    if (hit && hit.pixelDist <= LONG_PRESS_ROUTE_HIT_PX) { insertViaPointOnApproach(hit); return; }
  }
  openObjectQuery(lat, lng);
}
function findClosestOnApproach(lat, lng, containerPt) {
  const latlngs = app.approachRoute.latlngs;
  if (!latlngs || latlngs.length < 2) return null;
  let bestDistM = Infinity, bestSegIdx = -1, bestLat = 0, bestLng = 0;
  for (let i = 1; i < latlngs.length; i++) {
    const a = latlngs[i - 1], b = latlngs[i];
    const ax = a[1], ay = a[0];
    const bx = b[1], by = b[0];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) {
      t = ((lng - ax) * dx + (lat - ay) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
    }
    const projLng = ax + t * dx, projLat = ay + t * dy;
    const d = haversineM(lat, lng, projLat, projLng);
    if (d < bestDistM) { bestDistM = d; bestSegIdx = i; bestLat = projLat; bestLng = projLng; }
  }
  if (bestSegIdx < 0) return null;
  const projPx = app.map.latLngToContainerPoint(L.latLng(bestLat, bestLng));
  const pixelDist = projPx.distanceTo(containerPt);
  return { segIdx: bestSegIdx, lat: bestLat, lng: bestLng, pixelDist };
}
function insertViaPointOnApproach(hit) {
  const latlngs = app.approachRoute.latlngs;
  const targets = app.approachRoute.targets || [];
  if (!targets.length) return;
  const targetRouteIdxs = targets.map(t => {
    let bestD = Infinity, bestI = 0;
    for (let i = 0; i < latlngs.length; i++) {
      const d = haversineM(t.lat, t.lon, latlngs[i][0], latlngs[i][1]);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    return bestI;
  });
  let insertTargetIdx = targets.length;
  for (let i = 0; i < targetRouteIdxs.length; i++) {
    if (hit.segIdx <= targetRouteIdxs[i]) { insertTargetIdx = i; break; }
  }
  addMarker({ lat: hit.lat, lon: hit.lng });
  const newTarget = { lat: hit.lat, lon: hit.lng, name: "Zwischenpunkt" };
  const newTargets = targets.slice();
  newTargets.splice(insertTargetIdx, 0, newTarget);
  const activity = app.approachRoute.activity || "hiking";
  app.approachRoute.targets = newTargets;
  app.approachRoute.finalTarget = newTargets[newTargets.length - 1];
  toast("Zwischenpunkt eingefügt — Route wird neu berechnet.", "success");
  navigateToTargets(activity, newTargets, { mode: "custom", targetIsStart: false, silent: true });
}
