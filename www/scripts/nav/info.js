/* ============================================================
 * Navigator — Statusleiste, Höhenprofil, Übersicht
 * Teil von navigation.html. Alle Navigator-Dateien teilen sich
 * den globalen Gültigkeitsbereich und werden in fester
 * Reihenfolge geladen (siehe navigation.html).
 * ============================================================ */
"use strict";

// ----- Navigationsinfo / Statusleiste -----
/* Statuszeile unten und Abbiege-Banner nach jedem GPS-Fix.
 * Beide Navigationstypen werden gleich dargestellt:
 *   oben:  „Auf der Route“ bzw. „120 m von der Route entfernt“
 *   unten: Restweg bis zum Ziel (Typ 1 zusätzlich nächster Wegpunkt)
 * Die Sondernavigation (Typ 2) hat Vorrang, solange sie läuft. */
function updateNavigationInfo(lat, lon) {
  const hasMainRoute = app.routeLatLngs.length > 0;
  if (!hasMainRoute && !app.approachRoute.active) {
    setPrimaryLine("Keine Route", ".tourpack oder .gpx öffnen", "");
    return;
  }
  let res = null;
  if (hasMainRoute) {
    res = distanceToRoute(lat, lon);
    if (res) app.lastDistanceToRoute = res.distance;
  }

  if (app.approachRoute.active && !approachArrived(lat, lon, res)) {
    const appRes = distanceToApproachRoute(lat, lon);
    if (appRes) {
      app.lastDistanceToApproach = appRes.distance;
      const total = app.approachRoute.cumDist[app.approachRoute.cumDist.length - 1] || 0;
      showRouteStatus(appRes.distance, `Noch ${fmtKm(Math.max(0, total - appRes.cumDist))} ${approachTargetLabel()}`);
      updateTurnBanner(appRes.cumDist);
      return;
    }
  }

  if (!res) {
    setPrimaryLine("Keine Route", ".tourpack oder .gpx öffnen", "");
    return;
  }
  const total = app.routeCumDist[app.routeCumDist.length - 1] || 0;
  const remainingStr = fmtKm(Math.max(0, total - res.cumDist));
  const nextWp = nextWaypointAhead(lat, lon, res.index);
  const secondary = nextWp
    ? `→ ${nextWp.item.wp.name || "Wegpunkt"} · ${fmtKm(nextWp.dist)} · noch ${remainingStr} bis zum Ziel`
    : `Noch ${remainingStr} bis zum Ziel`;
  showRouteStatus(res.distance, secondary);
  updateTurnBanner(res.cumDist);
}

/* Gemeinsame Statuszeile: Abstand zur Route + Zusatzzeile. */
function showRouteStatus(distance, secondary) {
  if (distance < OFF_ROUTE_THRESHOLD_M) setPrimaryLine("Auf der Route", secondary, "ok");
  else setPrimaryLine(`${fmtOffRouteDistance(distance)} von der Route entfernt`, secondary, "");
}

/* Ziel der Sondernavigation in Worten („bis zum Start“ …). */
function approachTargetLabel() {
  if (app.approachRoute.mode === "custom") return "bis zum gewählten Punkt";
  if (app.approachRoute.targetIsStart) return "bis zum Start";
  return "bis zur Route";
}

/* Ist die Sondernavigation am Ziel? Dann wird sie beendet.
 * res = Projektion auf die Tour (für „zum nächsten Punkt der Route“). */
function approachArrived(lat, lon, res) {
  let arrived = false;
  if (app.approachRoute.mode === "custom") {
    const target = app.approachRoute.finalTarget;
    arrived = !!target && haversineM(lat, lon, target.lat, target.lon) < APPROACH_ARRIVAL_POINT_M;
  } else if (app.approachRoute.targetIsStart) {
    const start = app.routeLatLngs[0];
    arrived = !!start && haversineM(lat, lon, start[0], start[1]) < APPROACH_ARRIVAL_START_M;
  } else {
    arrived = !!res && res.distance < APPROACH_ARRIVAL_M;
  }
  if (arrived) clearApproachRoute(false);
  return arrived;
}

/* Nächster Wegpunkt vor der aktuellen Position (Luftlinie).
 * Liegt keiner mehr vor einem, der nächstgelegene überhaupt. */
function nextWaypointAhead(lat, lon, routeIndex) {
  let best = null;
  for (const item of app.waypointsWithDist) {
    if (item.routeIdx < routeIndex) continue;
    const d = haversineM(lat, lon, item.wp.lat, item.wp.lon);
    if (!best || d < best.dist) best = { item, dist: d };
  }
  if (best || !app.waypointsWithDist.length) return best;
  for (const item of app.waypointsWithDist) {
    const d = haversineM(lat, lon, item.wp.lat, item.wp.lon);
    if (!best || d < best.dist) best = { item, dist: d };
  }
  return best;
}

/* Untere Leiste: Statuszeilen (während der Navigation) … */
function setPrimaryLine(text, secondary, className) {
  $("bottomBar").classList.remove("has-stats");
  const el = $("primaryLine");
  el.textContent = text;
  el.className = "primary-line" + (className ? " " + className : "");
  if (secondary !== undefined && secondary !== null) $("secondaryLine").textContent = secondary;
}

/* … oder Kennzahlen der Tour (geladen, noch keine Navigation). */
function showBarStats() {
  const route = app.tourpackData ? app.tourpackData.route : null;
  const stats = (route && route.stats) || {};
  const html = AndromedaUtils.barStatsHtml(stats, fmtDurationHM(stats.duration_h, stats.duration_min));
  if (!html) return false;
  $("barStats").innerHTML = html;
  $("bottomBar").classList.add("has-stats");
  return true;
}

/* ============================================================
 * Geschwindigkeitsanzeige (km/h)
 * ============================================================ */

/* Berechnet aus zwei aufeinanderfolgenden GPS-Fixes die Geschwindigkeit.
 * Rückgabe: km/h oder null, wenn die Werte unbrauchbar sind. */
function computeSpeedSample() {
  const a = app.userPrevPos;
  const b = app.userLastPos;
  if (!a || !b || a.t == null || b.t == null) return null;
  const dt = (b.t - a.t) / 1000;
  if (dt < 0.5 || dt > 30) return null;
  const d = haversineM(a.lat, a.lon, b.lat, b.lon);
  if (d < 1.5) return 0;
  return (d / dt) * 3.6;
}

/* Welche Aktivität ist gerade aktiv? Sondernavigation schlägt Tour. */
function currentActivityForDisplay() {
  if (app.approachRoute && app.approachRoute.active && app.approachRoute.activity) {
    return app.approachRoute.activity;
  }
  if (app.tourpackData && app.tourpackData.route && app.tourpackData.route.type) {
    return app.tourpackData.route.type;
  }
  return "hiking";
}

/* Ist die Anzeige für die aktuelle Aktivität laut Einstellungen aktiv? */
function isSpeedVisibleForActivity() {
  const act = currentActivityForDisplay();
  if (act === "cycling") return !!settings.showSpeedCycling;
  if (act === "running") return !!settings.showSpeedRunning;
  return !!settings.showSpeedHiking;
}

function updateSpeedDisplay() {
  const el = $("speedDisplay");
  if (!el) return;
  if (!isSpeedVisibleForActivity()) {
    el.classList.remove("show");
    return;
  }
  el.classList.add("show");
  const v = $("speedVal");
  if (!v) return;
  const kmh = app.smoothedSpeedKmh || 0;
  // Bei Werten unter 10 km/h eine Nachkommastelle, darüber gerundet.
  v.textContent = kmh < 10 ? AndromedaI18n.fmtNumber(Math.round(kmh * 10) / 10, 1) : String(Math.round(kmh));
}

// ----- Höhenprofil -----
function setupElevationProfile(route, geometry) {
  const coords = extractLineCoords(geometry);
  const data = AndromedaElevation.computeData(coords);
  if (!data) {
    app.elevationData = null; elevPanel.updateButtons(); return;
  }
  data.coords = coords;
  data.activity = route.type || "hiking";
  app.elevationData = data;
  app.elevationDataType = "tour";
  elevPanel.updateButtons();
}
function setupElevationForApproach() {
  if (!app.approachRoute.active || !app.approachRoute.latlngs.length) return;
  const coords = app.approachRoute.latlngs.map(c =>
    c.length >= 3 ? [c[1], c[0], c[2]] : [c[1], c[0]]
  );
  const data = AndromedaElevation.computeData(coords);
  if (!data) return;
  data.coords = coords;
  data.activity = app.approachRoute.activity || "hiking";
  app.elevationData = data;
  app.elevationDataType = "approach";
  elevPanel.updateButtons();
}
function toggleElevation() {
  if (app.elevationOpen) { elevPanel.hide(); return; }
  const hasTour = app.routeLatLngs.length > 0;
  const hasApproach = app.approachRoute.active && app.approachRoute.latlngs.length > 0;
  if (hasTour && hasApproach) { $("elevPickerModal").classList.add("show"); return; }
  if (hasTour) {
    if (!app.elevationData || app.elevationDataType !== "tour") {
      if (app.tourpackData && app.tourpackData.geometry) {
        setupElevationProfile(app.tourpackData.route, app.tourpackData.geometry);
      }
    }
    app.elevationDataType = "tour";
    elevPanel.show();
    return;
  }
  if (hasApproach) { setupElevationForApproach(); elevPanel.show(); return; }
  toast("Keine Höhendaten verfügbar.", "error");
}
function bindElevPickerModal() {
  $("elevPickTour").addEventListener("click", () => {
    $("elevPickerModal").classList.remove("show");
    if (app.tourpackData && app.tourpackData.geometry) {
      setupElevationProfile(app.tourpackData.route, app.tourpackData.geometry);
    }
    app.elevationDataType = "tour";
    elevPanel.show();
  });
  $("elevPickApproach").addEventListener("click", () => {
    $("elevPickerModal").classList.remove("show");
    setupElevationForApproach();
    elevPanel.show();
  });
  $("elevPickCancel").addEventListener("click", () => {
    $("elevPickerModal").classList.remove("show");
  });
  $("elevPickerModal").addEventListener("click", e => {
    if (e.target === $("elevPickerModal")) $("elevPickerModal").classList.remove("show");
  });
}

// ----- Info-Pane -----
function computeApproachStats() {
  const latlngs = app.approachRoute.latlngs;
  if (!latlngs || latlngs.length < 2) return null;
  const coords = latlngs.map(c =>
    c.length >= 3 ? [c[1], c[0], c[2]] : [c[1], c[0]]
  );
  return computeStats(coords);
}
function refreshInfoPane() {
  const route = app.tourpackData ? app.tourpackData.route : {};
  renderInfoPane(route);
}
/* Woher die Abbiegehinweise stammen. Aus der Geometrie berechnete
 * Hinweise sind ungenauer: Ein Knick im Weg ist nicht immer eine
 * Kreuzung, und an einer Kreuzung ohne Knick gibt es keinen Hinweis. */
function turnSourceNote(source, what) {
  if (!source) return null;
  const div = document.createElement("div");
  if (source === "instructions") {
    div.className = "turn-source-note";
    div.textContent = "Abbiegehinweise aus dem Wegenetz der Routenplanung.";
    return div;
  }
  div.className = "turn-source-note approx";
  const lead = what === "gpx" ? "Diese GPX-Datei enthält keine Abbiegeanweisungen."
    : what === "approach" ? "Der Routenserver hat keine Abbiegeanweisungen geliefert."
    : "Diese Tour enthält keine Abbiegeanweisungen.";
  div.innerHTML = `<b>Abbiegehinweise ungenauer</b><span>${escapeHtml(lead)}</span>` +
    `<span>Sie werden aus der Form der Route berechnet: Ein Knick im Weg kann als Abbiegung gemeldet werden, eine Kreuzung ohne Knick fehlt.</span>`;
  return div;
}

function renderInfoPane(route) {
  const el = $("infoContent");
  el.innerHTML = "";
  const routeData = route || {};
  const isGpx = app.tourpackData && app.tourpackData.isGpx;
  const hasTour = app.routeLatLngs.length > 0;
  const hasType2 = app.approachRoute.active && app.approachRoute.latlngs.length > 0;

  if (hasTour) {
    const h = document.createElement("h3");
    h.className = "settings-heading";
    h.textContent = "Navigation";
    el.appendChild(h);
    const stats = routeData.stats || {};
    const durStr = fmtDurationHM(stats.duration_h, stats.duration_min);
    const cells = [];
    cells.push(`<div class="stat-card"><div class="lbl">Strecke</div><div class="val">${fmtDistance(stats.distance_m)}</div></div>`);
    if (durStr) cells.push(`<div class="stat-card"><div class="lbl">Dauer</div><div class="val">${escapeHtml(durStr)}</div></div>`);
    cells.push(`<div class="stat-card"><div class="lbl">Anstieg</div><div class="val">${stats.ascent_m ? Math.round(stats.ascent_m) + " m" : "—"}</div></div>`);
    cells.push(`<div class="stat-card"><div class="lbl">Abstieg</div><div class="val">${stats.descent_m ? Math.round(stats.descent_m) + " m" : "—"}</div></div>`);
    const grid = document.createElement("div");
    grid.className = "stats-grid";
    grid.style.marginBottom = "20px";
    grid.innerHTML = cells.join("");
    el.appendChild(grid);
    const note = turnSourceNote(app.turnSource, isGpx ? "gpx" : "tour");
    if (note) el.appendChild(note);
  }

  if (hasType2) {
    const h = document.createElement("h3");
    h.className = "settings-heading";
    h.textContent = hasTour ? "Zusätzliche Navigation" : "Navigation";
    if (hasTour) h.style.marginTop = "4px";
    el.appendChild(h);
    const appStats = computeApproachStats();
    const targetName = (app.approachRoute.finalTarget && app.approachRoute.finalTarget.name) || "Ziel";
    const cells = [];
    if (appStats) {
      cells.push(`<div class="stat-card"><div class="lbl">Strecke</div><div class="val">${fmtDistance(appStats.distance_m)}</div></div>`);
      cells.push(`<div class="stat-card"><div class="lbl">Ziel</div><div class="val" style="font-size:14px;">${escapeHtml(targetName)}</div></div>`);
      cells.push(`<div class="stat-card"><div class="lbl">Anstieg</div><div class="val">${appStats.ascent_m ? Math.round(appStats.ascent_m) + " m" : "—"}</div></div>`);
      cells.push(`<div class="stat-card"><div class="lbl">Abstieg</div><div class="val">${appStats.descent_m ? Math.round(appStats.descent_m) + " m" : "—"}</div></div>`);
    }
    const grid = document.createElement("div");
    grid.className = "stats-grid";
    grid.style.marginBottom = "20px";
    grid.innerHTML = cells.join("");
    el.appendChild(grid);
    // Typ 2 kommt direkt von BRouter; nur melden, wenn der Server
    // keine Anweisungen geliefert hat.
    if (app.approachRoute.turnSource === "geometry") {
      const note = turnSourceNote("geometry", "approach");
      if (note) el.appendChild(note);
    }
  }

  if (hasTour && !isGpx) {
    const loc = routeData.location || {};
    const isRoundtrip = !!app._isRoundtrip;
    const isRoadbike = routeData.roadbike === true;
    const placeSeq = fmtPlaceSequence(loc, isRoundtrip);
    const regionList = fmtRegionList(loc);
    if (placeSeq || regionList || isRoundtrip || isRoadbike) {
      const s = document.createElement("div");
      s.style.marginBottom = "20px";
      let html = `<h3 class="settings-heading">Routenverlauf</h3>`;
      if (isRoundtrip) html += `<div style="font-size:12.5px;line-height:1.5;margin-bottom:4px;color:var(--text-muted);">↻ Rundtour</div>`;
      if (isRoadbike)  html += `<div style="font-size:12.5px;line-height:1.5;margin-bottom:4px;color:var(--text-muted);">🚴 Rennradtauglich</div>`;
      if (placeSeq) html += `<div data-no-i18n style="font-size:13.5px;line-height:1.5;margin-bottom:4px;">${escapeHtml(placeSeq)}</div>`;
      if (regionList && regionList !== placeSeq) html += `<div data-no-i18n style="font-size:12.5px;line-height:1.5;color:var(--text-muted);">${escapeHtml(regionList)}</div>`;
      s.innerHTML = html;
      el.appendChild(s);
    }
    const diff = routeData.difficulty || {};
    const ratings = diff.ratings || {};
    const hasAny = Object.values(ratings).some(v => v > 0);
    const hasText = (diff.text || "").trim().length > 0;
    if (hasAny || hasText) {
      const s = document.createElement("div");
      s.style.marginBottom = "20px";
      s.innerHTML = `<h3 class="settings-heading">Schwierigkeit</h3>
        ${ratingRow("Schwierigkeit", ratings.overall)}
        ${ratingRow("Technik", ratings.technique)}
        ${ratingRow("Kondition", ratings.condition)}
        ${hasText ? `<div class="rating-note">${escapeHtml(diff.text)}</div>` : ""}`;
      el.appendChild(s);
    }
    // Tags werden nicht mehr angezeigt. Die Daten bleiben in
    // routeData.tags und werden weiterhin von der Suche genutzt.

    // Wege & Oberflächen (TourPack)
    if (app.tagSegments && app.tagSegments.length > 0) {
      const s = document.createElement("div");
      s.style.marginBottom = "20px";
      AndromedaWayStats.mount(s, app.tagSegments, wayHighlight, { collapsible: true });
      el.appendChild(s);
    }

    const desc = (app.tourpackData && app.tourpackData.description) || "";
    if (desc.trim()) {
      const s = document.createElement("div");
      s.innerHTML = `<h3 class="settings-heading">Beschreibung</h3>
        <div class="description">${renderMarkdown(desc)}</div>`;
      el.appendChild(s);
    }
  }

  if (hasTour && isGpx) {
    // Wege & Oberflächen (GPX)
    if (app.tagSegments && app.tagSegments.length > 0) {
      const s = document.createElement("div");
      s.style.marginBottom = "20px";
      AndromedaWayStats.mount(s, app.tagSegments, wayHighlight, { collapsible: true });
      el.appendChild(s);
    }

    const s = document.createElement("div");
    s.style.cssText = "color:var(--text-muted);font-size:12px;";
    s.textContent = "GPX-Import: nur Streckendaten verfügbar.";
    el.appendChild(s);
  }

  if (!hasTour && !hasType2) {
    el.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:30px 10px;font-size:13px;">Keine Tour geladen.</div>';
  }
}
function ratingRow(label, value) {
  const v = Math.max(0, Math.min(5, parseInt(value) || 0));
  let stars = "";
  for (let i = 1; i <= 5; i++) stars += (i <= v) ? "★" : "☆";
  return `<div class="rating-row"><span>${escapeHtml(label)}</span><span class="stars">${stars}</span><span class="value">${v > 0 ? v + " / 5" : "—"}</span></div>`;
}
function renderWaypointsPane(route) {
  const el = $("waypointsContent");
  el.innerHTML = "";
  const wps = route.waypoints || [];
  if (!wps.length) {
    el.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:30px 10px;font-size:13px;">Keine Wegpunkte.</div>';
    return;
  }
  wps.forEach((wp, i) => {
    const div = document.createElement("div");
    div.className = "wp-item";
    div.dataset.wpId = wp.id;
    const nImg = (wp.images || []).length;
    div.innerHTML = `
      <span class="num">${String(i + 1).padStart(2, "0")}</span>
      <span class="dot"></span>
      <span class="name">${escapeHtml(wp.name || "Wegpunkt")}</span>
      ${nImg ? `<span class="chip">${nImg} 📷</span>` : ""}
      <button class="nav-btn" title="Auf Karte zeigen">🗺</button>`;
    div.onclick = e => {
      if (e.target.closest(".nav-btn")) {
        e.stopPropagation();
        app.followActive = false;
        settings.follow = false;
        $("set_follow").checked = false;
        saveSettings();
        updateFollowButtons();
        app.map.setView([wp.lat, wp.lon], Math.max(app.map.getZoom(), 16), { animate: true });
      } else showWaypointDetail(wp);
    };
    el.appendChild(div);
  });
}
function showWaypointDetail(wp) {
  const imgs = wp.images || [];
  const html = `
    <div style="padding:4px 0;">
      <h2 data-no-i18n style="margin:0 0 6px 0;font-size:18px;">${escapeHtml(wp.name || "Wegpunkt")}</h2>
      <div style="font-size:12px;color:var(--text-muted);font-family:ui-monospace,monospace;margin-bottom:12px;">
        ${wp.lat != null ? wp.lat.toFixed(5) : ""}${wp.lon != null ? ", " + wp.lon.toFixed(5) : ""}
        ${wp.ele != null ? "  ·  " + Math.round(wp.ele) + " m" : ""}
      </div>
      ${wp.note && wp.note.trim() ? `<div data-no-i18n style="background:var(--bg);padding:10px 12px;border-left:3px solid var(--primary);border-radius:4px;margin-bottom:12px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(wp.note)}</div>` : ""}
      ${imgs.length ? `<div class="gallery" style="margin-top:12px;">${imgs.map(rel => `<div class="img-card" data-img-rel="${escapeHtml(rel)}"><div class="thumb-missing">lädt …</div></div>`).join("")}</div>` : ""}
      <button class="btn-full primary" id="showOnMapBtn" style="margin-top:16px;">🗺 Auf Karte zeigen</button>
      <button class="btn-full" id="backToWpListBtn" style="margin-top:8px;">← Zurück zur Liste</button>
    </div>`;
  const el = $("waypointsContent");
  el.innerHTML = html;
  $("showOnMapBtn").onclick = () => {
    app.followActive = false; settings.follow = false;
    $("set_follow").checked = false; saveSettings(); updateFollowButtons();
    resetMapRotation(); closePanel();
    app.map.setView([wp.lat, wp.lon], Math.max(app.map.getZoom(), 16), { animate: true });
  };
  $("backToWpListBtn").onclick = () => renderWaypointsPane(app.tourpackData.route);
  (async () => {
    const rels = wp.images || [];
    if (!rels.length) return;
    const items = [];
    for (let i = 0; i < rels.length; i++) {
      const url = await app.tourpackData.getImageURL(rels[i]);
      items.push({ url: url || null, caption: `${wp.name || "Wegpunkt"} — Bild ${i + 1}` });
    }
    const validItems = items.filter(x => x.url);
    const cards = el.querySelectorAll(".img-card");
    let i = 0;
    for (const item of items) {
      if (i >= cards.length) break;
      const card = cards[i++];
      if (item.url) {
        card.innerHTML = `<img class="thumb" src="${item.url}" alt="">`;
        const li = validItems.indexOf(item);
        card.onclick = () => AndromedaLightbox.open(validItems, li >= 0 ? li : 0);
      } else card.innerHTML = `<div class="thumb-missing">Bild fehlt</div>`;
    }
  })();
}
async function renderImagesPane(route, getImageURL) {
  const el = $("imagesContent");
  el.innerHTML = "";
  const imgs = route.images || [];
  if (!imgs.length) {
    el.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:30px 10px;font-size:13px;">Keine allgemeinen Bilder.</div>';
    return;
  }
  const grid = document.createElement("div");
  grid.className = "gallery";
  el.appendChild(grid);
  const items = [];
  for (const item of imgs) {
    const url = await getImageURL(item.path);
    items.push({ url: url || null, caption: item.caption || "" });
  }
  const validItems = items.filter(x => x.url);
  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "img-card";
    if (item.url) {
      const img = document.createElement("img");
      img.className = "thumb"; img.src = item.url; img.alt = item.caption;
      const li = validItems.indexOf(item);
      img.onclick = () => AndromedaLightbox.open(validItems, li >= 0 ? li : 0);
      card.appendChild(img);
    } else {
      const miss = document.createElement("div");
      miss.className = "thumb-missing"; miss.textContent = "Bild fehlt";
      card.appendChild(miss);
    }
    if (item.caption && item.caption.trim()) {
      const cap = document.createElement("div");
      cap.className = "caption"; cap.textContent = item.caption;
      card.appendChild(cap);
    }
    grid.appendChild(card);
  });
}
