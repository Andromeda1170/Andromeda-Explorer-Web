/* ============================================================
 * Navigator — Suche und Objektabfrage
 * Teil von navigation.html. Alle Navigator-Dateien teilen sich
 * den globalen Gültigkeitsbereich und werden in fester
 * Reihenfolge geladen (siehe navigation.html).
 * ============================================================ */
"use strict";

// ----- Suche & Objektabfrage -----
async function performSearch() {
  const input = $("searchInput");
  const q = input.value.trim();
  const resultsBox = $("searchResults");
  if (!q) { resultsBox.innerHTML = '<div class="search-empty">Bitte Suchbegriff eingeben.</div>'; return; }
  const btn = $("searchBtn");
  btn.disabled = true;
  resultsBox.innerHTML = '<div class="search-empty">Suche läuft …</div>';
  if (app.searchAbort) try { app.searchAbort.abort(); } catch (e) {}
  app.searchAbort = new AbortController();
  try {
    // Ergebnisse in der Sprache der Oberfläche (URL-Parameter, der
    // Proxy setzt den Accept-Language-Header fest)
    const url = Andromeda.NOMINATIM_URL + "/search" +
      "?q=" + encodeURIComponent(q) + "&format=json&limit=8&addressdetails=1&extratags=1" +
      "&accept-language=" + AndromedaI18n.lang();
    const res = await fetch(url, {
      signal: app.searchAbort.signal,
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.length) { resultsBox.innerHTML = '<div class="search-empty">Keine Treffer gefunden.</div>'; return; }
    resultsBox.innerHTML = "";
    for (const item of data) {
      const div = document.createElement("div");
      div.className = "search-result";
      const name = item.name || (item.display_name || "").split(",")[0] || "Ort";
      const detail = item.display_name || "";
      div.innerHTML = `<div class="sr-name">${escapeHtml(name)}</div><div class="sr-detail">${escapeHtml(detail)}</div>`;
      div.onclick = () => onSearchResultClick(item);
      resultsBox.appendChild(div);
    }
  } catch (e) {
    if (e.name === "AbortError") return;
    resultsBox.innerHTML = `<div class="search-empty">Fehler bei der Suche: ${escapeHtml(e.message)}</div>`;
  } finally { btn.disabled = false; }
}
function onSearchResultClick(item) {
  const lat = parseFloat(item.lat), lon = parseFloat(item.lon);
  if (!isFinite(lat) || !isFinite(lon)) return;
  const tags = Object.assign({}, item.extratags || {});
  if (item.name) tags.name = item.name;
  if (item.address) {
    const map = {
      house_number: "addr:housenumber", road: "addr:street",
      postcode: "addr:postcode", city: "addr:city", town: "addr:city",
      village: "addr:city", hamlet: "addr:city", state: "addr:state",
      country: "addr:country", suburb: "addr:suburb",
    };
    for (const [k, v] of Object.entries(item.address)) if (map[k] && v) tags[map[k]] = v;
  }
  const entry = addMarker({ lat, lon, tags });
  showMarkerDetail(entry);
  enrichMarkerWithOverpass(entry);
}
function openObjectQuery(lat, lon) {
  const now = Date.now();
  if (app._lastQueryAt && now - app._lastQueryAt < DEDUP_QUERY_WINDOW_MS &&
      app._lastQueryLat != null && app._lastQueryLon != null &&
      haversineM(lat, lon, app._lastQueryLat, app._lastQueryLon) < DEDUP_QUERY_DISTANCE_M) return;
  app._lastQueryAt = now; app._lastQueryLat = lat; app._lastQueryLon = lon;
  const entry = addMarker({ lat, lon });
  showTempMarkerSheet(entry);
}
function showTempMarkerSheet(entry) {
  app.activeMarkerId = entry.id;
  app.placeDetailLat = entry.lat;
  app.placeDetailLon = entry.lon;
  setPlaceDetailTitle("Markierung", entry.lat.toFixed(5) + ", " + entry.lon.toFixed(5));
  setPlaceDetailBody(`
    <div class="marker-info-box">
      <div class="mib-icon">📍</div>
      <div>Neue Markierung gesetzt.</div>
      <div class="mib-coords">${entry.lat.toFixed(5)}, ${entry.lon.toFixed(5)}</div>
    </div>
  `);
  setPlaceDetailFooter([
    { label: "Online Ortsabfrage machen", primary: true, onClick: () => performOnlineQuery(entry.lat, entry.lon, entry.id) },
    { label: "Zu diesem Ort navigieren", primary: true, onClick: () => startCustomNavigationFromMarker(entry) },
    { label: "Von diesem Ort navigieren", primary: true, onClick: () => setCustomStartFromMarker(entry) },
  ]);
  $("placeDetail").classList.add("show");
}
async function performOnlineQuery(lat, lon, markerId) {
  const now = Date.now();
  if (now - app.lastOverpassAt < 800) return;
  app.lastOverpassAt = now;
  setPlaceDetailTitle("Suche Objekt…", lat.toFixed(5) + ", " + lon.toFixed(5));
  setPlaceDetailBody('<div style="text-align:center;padding:30px 10px;color:var(--text-muted);font-size:13px;">Lade OSM-Daten …</div>');
  setPlaceDetailFooter([{ label: "Abbrechen", primary: false, onClick: () => closePlaceDetail() }]);
  try {
    const elements = await overpassQueryElements(lat, lon);
    if (!elements.length) {
      toast("Kein OSM-Objekt in der Nähe gefunden.", "error");
      const entry = app.markers.find(m => m.id === markerId);
      if (entry) showTempMarkerSheet(entry); else closePlaceDetail();
      return;
    }
    app.objectQueryChoices = elements;
    app.objectQueryLat = lat;
    app.objectQueryLon = lon;
    if (elements.length === 1) applyObjectChoice(elements[0], markerId, false);
    else showElementPicker(elements, markerId);
  } catch (e) {
    toast("Objektabfrage fehlgeschlagen: " + e.message, "error");
    const entry = app.markers.find(m => m.id === markerId);
    if (entry) showTempMarkerSheet(entry); else closePlaceDetail();
  }
}
async function overpassQueryElements(lat, lon) {
  const r = OVERPASS_RADIUS_M;
  const query = `[out:json][timeout:15];(node(around:${r},${lat},${lon});way(around:${r},${lat},${lon});relation(around:${r},${lat},${lon}););out center tags;`;
  const res = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  return collectElementsWithTags(data, lat, lon);
}
function collectElementsWithTags(data, lat, lon) {
  const elements = (data && data.elements) || [];
  const out = [];
  for (const el of elements) {
    if (!el.tags || !Object.keys(el.tags).length) continue;
    const elLat = el.lat != null ? el.lat : (el.center && el.center.lat);
    const elLon = el.lon != null ? el.lon : (el.center && el.center.lon);
    if (elLat == null || elLon == null) continue;
    out.push({ tags: el.tags, lat: elLat, lon: elLon, distance: haversineM(lat, lon, elLat, elLon), type: el.type, id: el.id });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}
function getPickerHint(tags) {
  const keys = ["tourism", "natural", "amenity", "leisure", "historic", "man_made", "place", "highway", "shop", "barrier", "emergency", "waterway", "route"];
  for (const k of keys) if (tags[k] !== undefined) return getTagValueLabel(k, tags[k]);
  if (osmName(tags)) return osmName(tags);
  return "OSM-Objekt";
}
function showElementPicker(elements, sourceMarkerId) {
  app.objectQueryChoices = elements;
  setPlaceDetailTitle(`${elements.length} Objekte gefunden`, "Für Details ein Objekt antippen");
  let html = '<div style="display:flex;flex-direction:column;gap:0;padding:8px 0;">';
  elements.forEach((el, idx) => {
    const name = getObjectTitle(el.tags);
    const hint = getPickerHint(el.tags);
    const dist = el.distance < 1 ? "< 1 m" : Math.round(el.distance) + " m";
    html += `<div class="place-pick-item" data-idx="${idx}"><div class="pp-name">${escapeHtml(name)}</div><div class="pp-detail">${escapeHtml(hint)} · ${dist} entfernt</div></div>`;
  });
  html += "</div>";
  setPlaceDetailBody(html);
  setPlaceDetailFooter([{
    label: "Abbrechen", primary: false,
    onClick: () => {
      const entry = app.markers.find(m => m.id === sourceMarkerId);
      if (entry) showTempMarkerSheet(entry); else closePlaceDetail();
    },
  }]);
  $("pdBody").querySelectorAll(".place-pick-item").forEach(node => {
    node.onclick = () => {
      const idx = parseInt(node.dataset.idx, 10);
      const el = elements[idx];
      if (el) applyObjectChoice(el, sourceMarkerId, true);
    };
  });
}
function applyObjectChoice(el, sourceMarkerId, fromPicker) {
  if (sourceMarkerId != null) removeMarker(sourceMarkerId);
  const assoc = addMarker({ lat: el.lat, lon: el.lon, tags: el.tags });
  app.activeMarkerId = assoc.id;
  setPlaceDetailTitle(getObjectTitle(el.tags), getObjectSubtitle(el.tags, el.lat, el.lon));
  setPlaceDetailBody(renderTagsHtml(el.tags));
  const buttons = [];
  if (fromPicker) {
    buttons.push({
      label: "← Zurück", primary: false,
      onClick: () => showElementPicker(app.objectQueryChoices, assoc.id),
    });
  }
  buttons.push({ label: "Auf Karte zentrieren", primary: true, onClick: () => centerPlaceDetail() });
  buttons.push({ label: "Zu diesem Ort navigieren", primary: true, onClick: () => startCustomNavigationFromMarker(assoc) });
  buttons.push({ label: "Von diesem Ort navigieren", primary: true, onClick: () => setCustomStartFromMarker(assoc) });
  setPlaceDetailFooter(buttons);
  app.placeDetailLat = el.lat;
  app.placeDetailLon = el.lon;
  $("placeDetail").classList.add("show");
}
function showMarkerDetail(entry) {
  if (!entry || !entry.tags || !Object.keys(entry.tags).length) return;
  app.activeMarkerId = entry.id;
  app.placeDetailLat = entry.lat;
  app.placeDetailLon = entry.lon;
  setPlaceDetailTitle(getObjectTitle(entry.tags), getObjectSubtitle(entry.tags, entry.lat, entry.lon));
  setPlaceDetailBody(renderTagsHtml(entry.tags));
  setPlaceDetailFooter([
    { label: "Auf Karte zentrieren", primary: true, onClick: () => centerPlaceDetail() },
    { label: "Zu diesem Ort navigieren", primary: true, onClick: () => startCustomNavigationFromMarker(entry) },
    { label: "Von diesem Ort navigieren", primary: true, onClick: () => setCustomStartFromMarker(entry) },
  ]);
  $("placeDetail").classList.add("show");
}
function centerPlaceDetail() {
  const lat = app.placeDetailLat, lon = app.placeDetailLon;
  if (lat == null || lon == null) return;
  closePlaceDetail();
  app.followActive = false;
  settings.follow = false;
  const cb = $("set_follow");
  if (cb) cb.checked = false;
  saveSettings();
  updateFollowButtons();
  resetMapRotation();
  app.map.flyTo([lat, lon], Math.max(app.map.getZoom(), 16), { duration: 1.0 });
}
async function enrichMarkerWithOverpass(entry) {
  const now = Date.now();
  if (now - app.lastOverpassAt < 800) return;
  app.lastOverpassAt = now;
  try {
    const elements = await overpassQueryElements(entry.lat, entry.lon);
    if (!elements.length) return;
    const el = elements[0];
    const merged = Object.assign({}, entry.tags || {});
    for (const [k, v] of Object.entries(el.tags)) if (merged[k] === undefined) merged[k] = v;
    if (Object.keys(merged).length === Object.keys(entry.tags || {}).length) return;
    entry.tags = merged;
    const newEmoji = findPoiEmojiForTags(merged);
    entry.emoji = newEmoji;
    try {
      entry.marker.setIcon(makeMarkerIcon(entry.color, true, newEmoji));
      entry.marker.unbindTooltip();
      entry.marker.bindTooltip("Tippen für Infos · Doppeltippen zum Entfernen", { direction: "top", offset: [0, -42] });
      if (entry.marker.dragging) entry.marker.dragging.disable();
      entry.hasTags = true;
    } catch (e) {}
    saveMarkersToState();
    if ($("placeDetail").classList.contains("show") && app.activeMarkerId === entry.id) {
      setPlaceDetailTitle(getObjectTitle(merged), getObjectSubtitle(merged, entry.lat, entry.lon));
      setPlaceDetailBody(renderTagsHtml(merged));
    }
  } catch (e) {}
}
function closePlaceDetail() {
  $("placeDetail").classList.remove("show");
  app.objectQueryChoices = [];
  app.activeMarkerId = null;
}
function bindPlaceDetail() {
  $("pdClose").addEventListener("click", closePlaceDetail);
  $("placeDetail").addEventListener("click", (e) => {
    if (e.target === $("placeDetail")) closePlaceDetail();
  });
}
