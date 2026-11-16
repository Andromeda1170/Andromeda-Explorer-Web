/* ============================================================
 * Navigator — Umgebungssuche (POIs)
 * Teil von navigation.html. Alle Navigator-Dateien teilen sich
 * den globalen Gültigkeitsbereich und werden in fester
 * Reihenfolge geladen (siehe navigation.html).
 * ============================================================ */
"use strict";

/* ============================================================
 * Umgebungssuche (POIs)
 *
 * Nutzt den bestehenden Overpass-Proxy. Ergebnisse werden als
 * Emoji-Marker auf einem eigenen Layer angezeigt — getrennt von den
 * Markierungen (app.markers). POIs sind flüchtig: sie werden nicht
 * persistiert und verschwinden beim Neuladen der Seite.
 *
 * Klick auf einen POI öffnet das bestehende Marker-Detail-Menü
 * (showMarkerDetail) mit denselben Buttons (Auf Karte zentrieren,
 * Zu diesem Ort navigieren).
 * ============================================================ */
function buildPoiGrid() {
  const grid = $("poiGrid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const cat of POI_CATEGORIES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "poi-cat-btn";
    btn.dataset.poiId = cat.id;
    btn.innerHTML = `
      <span class="poi-cat-emoji">${cat.emoji}</span>
      <span class="poi-cat-label">${escapeHtml(cat.label)}</span>
    `;
    btn.addEventListener("click", () => runPoiSearch(cat));
    grid.appendChild(btn);
  }
}

function openPoiModal() {
  buildPoiGrid();
  updatePoiClearBtn();
  const status = $("poiStatus");
  if (status) status.style.display = "none";
  $("poiModal").classList.add("show");
}

function closePoiModal() {
  $("poiModal").classList.remove("show");
}

function updatePoiClearBtn() {
  const btn = $("poiClearBtn");
  if (!btn) return;
  btn.style.display = (app._poiMarkers.length > 0) ? "" : "none";
}

async function runPoiSearch(cat) {
  if (!navigator.onLine) {
    showPoiStatus("Für die Umgebungssuche wird eine Internetverbindung benötigt.", true);
    return;
  }
  const anchor = app.userLastPos
    ? { lat: app.userLastPos.lat, lon: app.userLastPos.lon }
    : (app.map ? { lat: app.map.getCenter().lat, lon: app.map.getCenter().lng } : null);
  if (!anchor) {
    showPoiStatus("Keine Position verfügbar.", true);
    return;
  }

  // Buttons während der Suche sperren
  document.querySelectorAll(".poi-cat-btn").forEach(b => b.classList.add("loading"));
  showPoiStatus(`Suche ${cat.label} im Umkreis von ${POI_RADIUS_M / 1000} km …`, false);

  try {
    const elements = await overpassQueryPoi(cat, anchor.lat, anchor.lon, POI_RADIUS_M);
    document.querySelectorAll(".poi-cat-btn").forEach(b => b.classList.remove("loading"));

    if (!elements.length) {
      showPoiStatus(`Keine ${cat.label} im Umkreis von ${POI_RADIUS_M / 1000} km gefunden.`, false);
      return;
    }

    // Alte POIs ersetzen
    clearPoi();
    app._poiActiveCategory = cat.id;
    renderPoiMarkers(elements, cat);
    updatePoiClearBtn();

    if (elements.length >= POI_MAX_RESULTS) {
      showPoiStatus(
        `${elements.length} ${cat.label} angezeigt (Limit erreicht — ggf. Zoom auf einen kleineren Bereich).`,
        false
      );
    } else {
      showPoiStatus(
        `${elements.length} ${cat.label} im Umkreis von ${POI_RADIUS_M / 1000} km angezeigt.`,
        false
      );
    }
    // Kartenansicht auf den Radius anpassen
    if (app.map) {
      try {
        const bounds = L.latLngBounds(elements.map(e => [e.lat, e.lon]));
        bounds.extend([anchor.lat, anchor.lon]);
        app.map.fitBounds(bounds.pad(0.05), { animate: true });
      } catch (e) {}
    }
    // Modal schließen, damit man die Karte sieht
    closePoiModal();
  } catch (e) {
    document.querySelectorAll(".poi-cat-btn").forEach(b => b.classList.remove("loading"));
    showPoiStatus("Suche fehlgeschlagen: " + e.message, true);
    console.error("POI-Suche:", e);
  }
}

function showPoiStatus(msg, isError) {
  const el = $("poiStatus");
  if (!el) return;
  el.style.display = "block";
  el.style.background = isError ? "#fce8e6" : "var(--primary-soft)";
  el.style.color = isError ? "var(--danger)" : "var(--primary-dark)";
  el.textContent = msg;
}

async function overpassQueryPoi(cat, lat, lon, radiusM) {
  const tagFilter = cat.query;
  const eq = tagFilter.indexOf("=");
  if (eq < 0) throw new Error("Ungültiger Tag-Filter");
  const key = tagFilter.slice(0, eq);
  const val = tagFilter.slice(eq + 1);
  const r = Math.round(radiusM);

  // relation() nur für Kategorien, bei denen es tatsächlich vorkommt.
  // Für Campingplätze, große Hotels, Kliniken und Hütten-Komplexe ist
  // es zwingend nötig — sonst fehlen Treffer wie in dicht gemappten
  // Städten. Bei Trinkwasser, Toiletten, Shops usw. bleibt es draußen.
  const includeRelation = !!cat.useRelation;
  const query =
    `[out:json][timeout:35];` +
    `(` +
      `node(around:${r},${lat},${lon})[${key}=${val}];` +
      `way(around:${r},${lat},${lon})[${key}=${val}];` +
      (includeRelation
        ? `relation(around:${r},${lat},${lon})[${key}=${val}];`
        : ``) +
    `);` +
    `out center tags ${POI_MAX_RESULTS};`;

  async function tryFetchOnce() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50000);
    try {
      const res = await fetch(OVERPASS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: controller.signal,
      });
      if (res.status === 429) {
        const err = new Error("Overpass-Tageslimit erreicht.");
        err.retryable = false;
        throw err;
      }
      if (res.status >= 500) {
        const err = new Error("Overpass HTTP " + res.status);
        err.retryable = true;
        err.httpStatus = res.status;
        throw err;
      }
      if (!res.ok) {
        const err = new Error("HTTP " + res.status);
        err.retryable = false;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Bis zu drei Versuche: sofort, nach 2 s, nach 5 s.
  const waits = [0, 2000, 5000];
  let lastErr = null;
  let data = null;
  for (const wait of waits) {
    if (wait > 0) {
      showPoiStatus(
        `Overpass ist gerade ausgelastet — neuer Versuch in ${wait / 1000} s …`,
        false
      );
      await new Promise(res => setTimeout(res, wait));
    }
    try {
      data = await tryFetchOnce();
      break;
    } catch (e) {
      lastErr = e;
      const isRetryable = e.retryable || e.name === "AbortError"
                          || e.name === "TypeError" || e.name === "NetworkError";
      if (!isRetryable) throw e;
    }
  }
  if (!data) {
    if (lastErr && (lastErr.retryable || lastErr.name === "AbortError")) {
      throw new Error(
        "Overpass ist gerade überlastet. Bitte in ein paar Minuten erneut versuchen."
      );
    }
    throw lastErr || new Error("Overpass nicht erreichbar.");
  }

  const elements = (data && data.elements) || [];
  const out = [];
  for (const el of elements) {
    if (!el.tags || !Object.keys(el.tags).length) continue;
    const elLat = el.lat != null ? el.lat : (el.center && el.center.lat);
    const elLon = el.lon != null ? el.lon : (el.center && el.center.lon);
    if (elLat == null || elLon == null) continue;
    out.push({
      id: el.type + "/" + el.id,
      lat: elLat,
      lon: elLon,
      tags: el.tags,
    });
  }
  out.sort((a, b) => a.lat - b.lat);
  return out;
}

function renderPoiMarkers(elements, cat) {
  clearPoi();
  app._poiActiveCategory = cat.id;
  for (const poi of elements) {
    const icon = L.divIcon({
      html: `<div class="poi-emoji">${cat.emoji}</div>`,
      className: "poi-marker",
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
    const m = L.marker([poi.lat, poi.lon], {
      icon, interactive: true, zIndexOffset: 700,
      keyboard: false,
    });
    m.on("click", () => showPoiDetail(poi, cat));
    m.bindTooltip(
      escapeHtml(osmName(poi.tags) || cat.label),
      { direction: "top", offset: [0, -16] }
    );
    app.poiLayer.addLayer(m);
    app._poiMarkers.push(m);
  }
}

function showPoiDetail(poi, cat) {
  if (!poi || !poi.tags || !Object.keys(poi.tags).length) return;
  app.activeMarkerId = null;
  app.placeDetailLat = poi.lat;
  app.placeDetailLon = poi.lon;
  setPlaceDetailTitle(getObjectTitle(poi.tags), getObjectSubtitle(poi.tags, poi.lat, poi.lon));
  setPlaceDetailBody(renderTagsHtml(poi.tags));

  const entry = {
    id: "poi_" + poi.id,
    lat: poi.lat,
    lon: poi.lon,
    tags: poi.tags,
    color: "#3a7ca5",
    marker: null,
  };

  setPlaceDetailFooter([
    { label: "Auf Karte zentrieren", primary: true, onClick: () => centerPlaceDetail() },
    { label: "Zu diesem Ort navigieren", primary: true, onClick: () => startCustomNavigationFromMarker(entry) },
    { label: "Von diesem Ort navigieren", primary: true, onClick: () => setCustomStartFromMarker(entry) },
    { label: "Markierung hier setzen", primary: true, onClick: () => pinPoiAsMarker(poi) },
  ]);
  $("placeDetail").classList.add("show");
}

/* Übernimmt einen POI als normale Markierung (mit Emoji im Pin).
 * Der POI selbst bleibt auf dem POI-Layer sichtbar; die Markierung
 * wird in app.markers gespeichert und überlebt weitere POI-Suchen. */
function pinPoiAsMarker(poi) {
  if (!poi || poi.lat == null || poi.lon == null) return;
  const exists = app.markers.some(m =>
    haversineM(m.lat, m.lon, poi.lat, poi.lon) < 2
  );
  if (exists) {
    toast("Hier ist bereits eine Markierung.", "warn");
    return;
  }
  const emoji = findPoiEmojiForTags(poi.tags);
  addMarker({ lat: poi.lat, lon: poi.lon, tags: poi.tags, emoji });
  closePlaceDetail();
  toast("Markierung gesetzt.", "success");
}

function clearPoi() {
  if (app.poiLayer) {
    try { app.poiLayer.clearLayers(); } catch (e) {}
  }
  app._poiMarkers = [];
  app._poiActiveCategory = null;
  updatePoiClearBtn();
}

function bindPoiModal() {
  const openBtn = $("poiSearchBtn");
  if (openBtn) openBtn.addEventListener("click", openPoiModal);
  const closeBtn = $("poiModalClose");
  if (closeBtn) closeBtn.addEventListener("click", closePoiModal);
  const clearBtn = $("poiClearBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      clearPoi();
      showPoiStatus("Gefundene Orte von der Karte entfernt.", false);
    });
  }
  const backdrop = $("poiModal");
  if (backdrop) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closePoiModal();
    });
  }
}
