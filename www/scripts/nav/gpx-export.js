/* ============================================================
 * Navigator — GPX-Export
 * Teil von navigation.html. Alle Navigator-Dateien teilen sich
 * den globalen Gültigkeitsbereich und werden in fester
 * Reihenfolge geladen (siehe navigation.html).
 * ============================================================ */
"use strict";

// ----- GPX-Export -----
/* Abbiegeanweisungen kommen als <rte> im OsmAnd-Format mit (siehe
 * turninstr.js) — aber nur echte aus der Routenplanung. Aus der
 * Geometrie berechnete Hinweise kann jede Navigations-App selbst
 * berechnen; als „Anweisungen“ gespeichert würden sie täuschen. */
function gpxHeader(creator) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="${escapeXml(creator)}" xmlns="http://www.topografix.com/GPX/1/1" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n`;
}
function gpxTrk(title, type, points) {
  let gpx = `  <trk>\n    <name>${escapeXml(title)}</name>\n`;
  if (type) gpx += `    <type>${escapeXml(type)}</type>\n`;
  gpx += `    <trkseg>\n`;
  for (const c of points) {
    gpx += `      <trkpt lat="${c[1].toFixed(7)}" lon="${c[0].toFixed(7)}">`;
    if (c.length >= 3 && isFinite(c[2])) gpx += `<ele>${(+c[2]).toFixed(1)}</ele>`;
    gpx += `</trkpt>\n`;
  }
  return gpx + `    </trkseg>\n  </trk>\n`;
}
function downloadGpxText(gpx, title, fallbackName) {
  const filename = (title.replace(/[^a-zA-Z0-9_\-äöüÄÖÜß ]+/g, "_").trim() || fallbackName) + ".gpx";
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportRouteAsGpx() {
  if (!app.tourpackData || !app.routeLatLngs.length) {
    toast("Keine Tour geladen.", "error"); return;
  }
  const route = app.tourpackData.route || {};
  const title = route.title || "Tour";
  const coords = extractLineCoords(app.tourpackData.geometry);
  if (!coords.length) { toast("Keine Routendaten vorhanden.", "error"); return; }
  const hints = app.turnSource === "instructions"
    ? AndromedaTurns.alignToCoords(app.tourpackData.turnHints || [], coords) : [];
  const rte = AndromedaTurns.gpxRte(coords, hints);
  let gpx = gpxHeader(rte ? AndromedaTurns.OSMAND_CREATOR : "Andromeda-Explorer Navigator");
  gpx += `  <metadata>\n    <name>${escapeXml(title)}</name>\n    <time>${new Date().toISOString()}</time>\n  </metadata>\n`;
  for (const wp of route.waypoints || []) {
    if (wp.lat == null || wp.lon == null) continue;
    gpx += `  <wpt lat="${wp.lat.toFixed(7)}" lon="${wp.lon.toFixed(7)}">\n`;
    if (wp.ele != null && isFinite(wp.ele)) gpx += `    <ele>${wp.ele.toFixed(1)}</ele>\n`;
    gpx += `    <name>${escapeXml(wp.name || "Wegpunkt")}</name>\n`;
    if (wp.note && wp.note.trim()) gpx += `    <desc>${escapeXml(wp.note)}</desc>\n`;
    gpx += `  </wpt>\n`;
  }
  gpx += rte;
  gpx += gpxTrk(title, route.type, coords);
  gpx += `</gpx>\n`;
  downloadGpxText(gpx, title, "tour");
  toast("Tour als GPX exportiert.", "success");
}

function exportApproachAsGpx() {
  if (!app.approachRoute.active || !app.approachRoute.latlngs.length) {
    toast("Keine Typ-2-Navigation aktiv.", "error"); return;
  }
  const latlngs = app.approachRoute.latlngs;
  const activity = app.approachRoute.activity || "hiking";
  const title = app.approachRoute.mode === "custom"
    ? "Navigation zur Markierung"
    : (app.approachRoute.targetIsStart ? "Navigation zum Start" : "Navigation zur Route");
  // Exportiert wird die verdichtete Route; turn.index zählt genau darin.
  const points = latlngs.map(ll => (ll.length >= 3 ? [ll[1], ll[0], ll[2]] : [ll[1], ll[0]]));
  const hints = app.approachRoute.turnSource === "instructions"
    ? (app.approachRoute.turns || []).filter(t => t.turn).map(t => ({ index: t.index, turn: t.turn, angle: t.angle }))
    : [];
  const rte = AndromedaTurns.gpxRte(points, hints);
  let gpx = gpxHeader(rte ? AndromedaTurns.OSMAND_CREATOR : "Andromeda-Explorer Navigator");
  gpx += `  <metadata>\n    <name>${escapeXml(title)}</name>\n    <time>${new Date().toISOString()}</time>\n  </metadata>\n`;
  gpx += rte;
  gpx += gpxTrk(title, activity, points);
  gpx += `</gpx>\n`;
  downloadGpxText(gpx, title, "navigation");
  toast("Navigation als GPX exportiert.", "success");
}
