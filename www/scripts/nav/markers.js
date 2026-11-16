/* ============================================================
 * Navigator — Markierungen und Ortsdetails
 * Teil von navigation.html. Alle Navigator-Dateien teilen sich
 * den globalen Gültigkeitsbereich und werden in fester
 * Reihenfolge geladen (siehe navigation.html).
 * ============================================================ */
"use strict";

const MARKER_COLORS = [
  "#3a7ca5", "#e67e22", "#8e44ad", "#c0392b", "#16a085",
  "#d35400", "#2c3e50", "#7f8c8d", "#27ae60", "#2980b9",
  "#e91e63", "#9b59b6", "#f39c12", "#1abc9c", "#3498db",
  "#ff5722", "#795548", "#607d8b", "#009688", "#673ab7",
];
function getRandomMarkerColor() {
  const last = app._lastMarkerColor;
  const pool = MARKER_COLORS.filter(x => x !== last);
  const src = pool.length ? pool : MARKER_COLORS;
  const c = src[Math.floor(Math.random() * src.length)];
  app._lastMarkerColor = c;
  return c;
}
function makeMarkerIcon(color, associated, emoji) {
  let inner;
  if (emoji) {
    // Weißer Kreis mit Emoji in der Mitte (für POI-Marker)
    inner =
      `<circle cx="16" cy="16" r="9" fill="white"/>` +
      `<text x="16" y="16" text-anchor="middle" dominant-baseline="central" ` +
      `font-size="15" font-family="sans-serif">${emoji}</text>`;
  } else if (associated) {
    inner = `<circle cx="16" cy="16" r="6" fill="white"/><circle cx="16" cy="16" r="3" fill="${color}"/>`;
  } else {
    inner = `<circle cx="16" cy="16" r="5.5" fill="white"/>`;
  }
  const html = `<svg width="32" height="42" viewBox="0 0 32 42" xmlns="http://www.w3.org/2000/svg"><path d="M16 0 C7.2 0 0 7.2 0 16 C0 28 16 42 16 42 C16 42 32 28 32 16 C32 7.2 24.8 0 16 0 Z" fill="${color}" stroke="white" stroke-width="2.5"/>${inner}</svg>`;
  return L.divIcon({ html, className: "search-marker", iconSize: [32, 42], iconAnchor: [16, 42] });
}

/* Marker hinzufügen. Marker MIT Tags (Lokalität) sind nicht verschiebbar. */
function addMarker({ lat, lon, color, tags, emoji }) {
  const id = ++app._markerIdCounter;
  const c = color || getRandomMarkerColor();
  const hasTags = !!(tags && Object.keys(tags).length);
  // Emoji automatisch aus den Tags ableiten, falls nicht explizit gesetzt.
  const finalEmoji = emoji || (hasTags ? findPoiEmojiForTags(tags) : null);
  const icon = makeMarkerIcon(c, hasTags, finalEmoji);
  const m = L.marker([lat, lon], {
    icon, interactive: true, zIndexOffset: 900, keyboard: false,
    draggable: !hasTags,
  });
  const entry = { id, lat, lon, color: c, tags: tags || null, marker: m, hasTags, emoji: finalEmoji };

  let pendingTap = null;

  m.on("dragstart", () => {
    if (pendingTap) { clearTimeout(pendingTap); pendingTap = null; }
  });

  m.on("dragend", ev => {
    const pos = ev.target.getLatLng();
    const oldLat = entry.lat;
    const oldLon = entry.lon;
    entry.lat = pos.lat;
    entry.lon = pos.lng;

    let startMoved = false;
    if (app.customStart) {
      const dStart = haversineM(oldLat, oldLon, app.customStart.lat, app.customStart.lon);
      if (dStart < 1) {
        app.customStart.lat = entry.lat;
        app.customStart.lon = entry.lon;
        renderCustomStartMarker();
        startMoved = true;
      }
    }

    let targetMoved = false;
    if (app.approachRoute.active && app.approachRoute.mode === "custom") {
      let hitIdx = -1;
      for (let i = 0; i < app.approachRoute.targets.length; i++) {
        const t = app.approachRoute.targets[i];
        if (haversineM(oldLat, oldLon, t.lat, t.lon) < 1) { hitIdx = i; break; }
      }
      if (hitIdx >= 0) {
        app.approachRoute.targets[hitIdx] = {
          lat: entry.lat, lon: entry.lon,
          name: app.approachRoute.targets[hitIdx].name,
        };
        app.approachRoute.finalTarget = app.approachRoute.targets[app.approachRoute.targets.length - 1];
        targetMoved = true;
      }
    }

    if (!app._suppressMarkerSave) saveMarkersToState();

    if (app.approachRoute.active && app.approachRoute.mode === "custom" &&
        (startMoved || targetMoved)) {
      const activity = app.approachRoute.activity || "hiking";
      const targets = app.approachRoute.targets.slice();
      if (targets.length) {
        navigateToTargets(activity, targets, { mode: "custom", targetIsStart: false, silent: true });
        return;
      }
    }
    if (startMoved && !app.approachRoute.active) {
      toast("Start verschoben — jetzt über 'Zu diesem Ort navigieren' ein Ziel wählen.", "success");
    }
  });

  m.on("click", () => {
    if (pendingTap) {
      clearTimeout(pendingTap);
      pendingTap = null;
      removeMarker(entry.id);
      return;
    }
    pendingTap = setTimeout(() => {
      pendingTap = null;
      if (entry.tags && Object.keys(entry.tags).length) showMarkerDetail(entry);
      else showTempMarkerSheet(entry);
    }, 320);
  });

  m.bindTooltip(
    entry.hasTags
      ? "Tippen für Infos · Doppeltippen zum Entfernen"
      : "Tippen für Optionen · Ziehen zum Verschieben · Doppeltippen zum Entfernen",
    { direction: "top", offset: [0, -42] }
  );

  app.searchMarkerLayer.addLayer(m);
  app.markers.push(entry);
  updateMarkerCountDisplay();
  if (!app._suppressMarkerSave) saveMarkersToState();
  return entry;
}

function removeMarker(id) {
  const idx = app.markers.findIndex(e => e.id === id);
  if (idx < 0) return false;
  const entry = app.markers[idx];
  try { app.searchMarkerLayer.removeLayer(entry.marker); } catch (e) {}
  app.markers.splice(idx, 1);
  updateMarkerCountDisplay();
  if (!app._suppressMarkerSave) saveMarkersToState();

  if (app.approachRoute.active && app.approachRoute.mode === "custom") {
    const oldTargets = app.approachRoute.targets;
    const remaining = oldTargets.filter(t =>
      haversineM(entry.lat, entry.lon, t.lat, t.lon) >= 1);
    if (remaining.length !== oldTargets.length) {
      if (remaining.length) {
        app.approachRoute.targets = remaining;
        app.approachRoute.finalTarget = remaining[remaining.length - 1];
        const activity = app.approachRoute.activity || "hiking";
        toast("Ziel entfernt — Navigation wird neu berechnet.", "success");
        setTimeout(() => {
          navigateToTargets(activity, remaining, { mode: "custom", targetIsStart: false, silent: true });
        }, 0);
      } else {
        clearApproachRoute("manual");
        toast("Navigation beendet — keine Ziele mehr.", "success");
      }
    }
  }
  if (app.customStart) {
    const dStart = haversineM(entry.lat, entry.lon, app.customStart.lat, app.customStart.lon);
    if (dStart < 1) clearCustomStart();
  }
  return true;
}
function clearAllMarkers() {
  for (const entry of app.markers) {
    try { app.searchMarkerLayer.removeLayer(entry.marker); } catch (e) {}
  }
  app.markers = [];
  updateMarkerCountDisplay();
  if (!app._suppressMarkerSave) saveMarkersToState();
  if (app.approachRoute.active && app.approachRoute.mode === "custom") {
    clearApproachRoute("manual");
  }
  if (app.customStart) {
    const found = app.markers.some(m =>
      haversineM(m.lat, m.lon, app.customStart.lat, app.customStart.lon) < 1);
    if (!found) clearCustomStart();
  }
}
function updateMarkerCountDisplay() {
  const label = $("markerCountLabel");
  const sub = $("markerCountSub");
  if (!label) return;
  const n = app.markers.length;
  label.textContent = `${n} Markierung${n === 1 ? "" : "en"}`;
  if (sub) sub.textContent = n === 0
    ? "Noch keine Markierungen gesetzt"
    : "Gesetzte Markierungen auf der Karte";
}

function getTagKeyLabel(key) {
  const entry = osmTable()[key];
  if (entry && entry.label) return entry.label;
  return humanizeOsm(key);
}
function getTagValueLabel(key, value) {
  const en = AndromedaI18n.lang() === "en";
  const entry = osmTable()[key];
  if (entry && entry.values && entry.values[value] !== undefined) return entry.values[value];
  if (value === "yes") return en ? "Yes" : "Ja";
  if (value === "no") return en ? "No" : "Nein";
  if (value === "unknown") return en ? "Unknown" : "Unbekannt";
  // Englisch: Rohwert lesbar machen, wenn der Schlüssel bekannt ist
  if (en && OSM_TRANSLATIONS[key] && OSM_TRANSLATIONS[key].values && OSM_TRANSLATIONS[key].values[value] !== undefined) return humanizeOsm(value);
  return value;
}
/* Name eines OSM-Objekts in der Sprache der Oberfläche (name:en …),
 * sonst der örtliche Name. */
function osmName(tags) {
  if (!tags) return "";
  const lang = AndromedaI18n.lang();
  return tags["name:" + lang] || tags.name || tags["name:de"] || "";
}
function getObjectTitle(tags) {
  if (!tags) return "Objekt";
  if (osmName(tags)) return osmName(tags);
  for (const key of ["tourism", "natural", "amenity", "leisure", "historic", "place", "highway", "man_made", "shop", "barrier", "emergency", "route", "boundary", "waterway"]) {
    if (tags[key] !== undefined) {
      const v = getTagValueLabel(key, tags[key]);
      if (v && v !== key) return v;
    }
  }
  return "OSM-Objekt";
}
function getObjectSubtitle(tags, lat, lon) {
  const parts = [];
  if (tags) {
    const addr = [];
    if (tags["addr:street"]) {
      let s = tags["addr:street"];
      if (tags["addr:housenumber"]) s += " " + tags["addr:housenumber"];
      addr.push(s);
    }
    if (tags["addr:postcode"] || tags["addr:city"]) {
      addr.push([tags["addr:postcode"], tags["addr:city"]].filter(Boolean).join(" "));
    }
    if (addr.length) parts.push(addr.join(", "));
  }
  if (lat != null && lon != null) parts.push(lat.toFixed(5) + ", " + lon.toFixed(5));
  return parts.join(" · ");
}
function renderTagsHtml(tags) {
  if (!tags || !Object.keys(tags).length) {
    return '<div style="color:var(--text-muted);text-align:center;padding:20px 10px;font-size:13px;">Keine weiteren Attribute gefunden.</div>';
  }
  const used = new Set();
  const addRow = (key) => {
    const value = tags[key];
    if (value === undefined) return "";
    used.add(key);
    const keyLabel = getTagKeyLabel(key);
    let valLabel;
    if (key === "website" || key === "contact:website") {
      let href = String(value);
      if (!/^https?:\/\//i.test(href)) href = "http://" + href;
      valLabel = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a>`;
    } else valLabel = escapeHtml(getTagValueLabel(key, value));
    return `<div class="tag-row"><div class="tag-key">${escapeHtml(keyLabel)}</div><div class="tag-value">${valLabel}</div></div>`;
  };
  let priorityHtml = "";
  for (const key of TAG_PRIORITY) if (key in tags) priorityHtml += addRow(key);
  const restKeys = Object.keys(tags).filter(k => !used.has(k) && k !== "id" && k !== "type" && !k.startsWith("_") && k !== "source");
  restKeys.sort();
  let extraHtml = "";
  for (const key of restKeys) extraHtml += addRow(key);
  let html = "";
  if (priorityHtml) html += `<div class="tag-category"><h3>Wichtige Informationen</h3>${priorityHtml}</div>`;
  if (extraHtml) html += `<details class="tag-details"><summary>Weitere Attribute (${restKeys.length})</summary><div class="tag-details-body">${extraHtml}</div></details>`;
  return html;
}

function setPlaceDetailFooter(buttons) {
  const footer = $("pdFooter");
  footer.innerHTML = "";
  for (const cfg of buttons) {
    const btn = document.createElement("button");
    btn.className = cfg.primary ? "pd-primary" : "pd-secondary";
    btn.textContent = cfg.label;
    btn.onclick = cfg.onClick;
    footer.appendChild(btn);
  }
}
function setPlaceDetailTitle(title, sub) {
  $("pdTitle").textContent = title || "";
  $("pdSub").textContent = sub || "";
}
function setPlaceDetailBody(html) { $("pdBody").innerHTML = html; }
