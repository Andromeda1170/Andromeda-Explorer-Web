/* ============================================================
 * Navigator — Routengeometrie und Projektion
 * Teil von navigation.html. Alle Navigator-Dateien teilen sich
 * den globalen Gültigkeitsbereich und werden in fester
 * Reihenfolge geladen (siehe navigation.html).
 * ============================================================ */
"use strict";

function fmtKm(m) {
  if (m == null || !isFinite(m)) return "—";
  const km = Math.max(0.1, m / 1000);
  return AndromedaI18n.fmtNumber(Math.round(km * 10) / 10, 1) + " km";
}

function interpolateRoute(coords, maxGapM) {
  if (!coords || coords.length < 2) return coords;
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1], curr = coords[i];
    const dist = haversineM(prev[1], prev[0], curr[1], curr[0]);
    if (dist > maxGapM) {
      const steps = Math.ceil(dist / maxGapM);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const lon = prev[0] + t * (curr[0] - prev[0]);
        const lat = prev[1] + t * (curr[1] - prev[1]);
        if (prev.length >= 3 && curr.length >= 3) {
          out.push([lon, lat, prev[2] + t * (curr[2] - prev[2])]);
        } else out.push([lon, lat]);
      }
    }
    out.push(curr);
  }
  return out;
}

/* Baut aus Koordinaten [lon, lat, ele?] die Navigationsdaten einer
 * Route. Dieselbe Funktion für Tour (Typ 1) und Sondernavigation
 * (Typ 2), damit beide exakt gleich rechnen.
 *   hints:   optionale Abbiegeanweisungen [{ index, lat, lon, turn, angle }]
 *            (index bezieht sich auf coords)
 * Rückgabe:
 *   latlngs: [[lat, lon, ele?], …] auf ROUTE_INTERPOLATION_INTERVAL_M verdichtet
 *   cumDist: Meter ab Start je Punkt
 *   turns:   Abbiegepunkte — aus den Anweisungen, sonst aus der Geometrie
 *   turnSource: "instructions" | "geometry" */
function buildNavTrack(coords, hints) {
  const dense = interpolateRoute(coords, ROUTE_INTERPOLATION_INTERVAL_M);
  const latlngs = dense.map(c => (c.length >= 3 ? [c[1], c[0], c[2]] : [c[1], c[0]]));
  const cumDist = [0];
  for (let i = 1; i < latlngs.length; i++) {
    cumDist.push(cumDist[i - 1] +
      haversineM(latlngs[i - 1][0], latlngs[i - 1][1], latlngs[i][0], latlngs[i][1]));
  }
  let turns = [];
  try { turns = turnsFromInstructions(coords, hints, latlngs, cumDist); }
  catch (e) { console.warn("Abbiegeanweisungen nicht verwendbar:", e); turns = []; }
  if (turns.length) return { latlngs, cumDist, turns, turnSource: "instructions" };
  return { latlngs, cumDist, turns: computeTurnsForRoute(latlngs, cumDist), turnSource: "geometry" };
}

/* Frischer Projektions-Zustand (je Navigationstyp einer). */
function newProjState() {
  return { lastIndex: null, lastCum: null, backM: 0, wrongWay: false };
}
function resetProjState(ps) {
  Object.assign(ps, newProjState());
}

/* Richtung der Route ab Punkt idx (über ~20 m gemittelt). */
function routeBearingAt(latlngs, idx) {
  const N = latlngs.length;
  if (N < 2) return null;
  if (idx >= N - 1) {
    const a = latlngs[N - 2], b = latlngs[N - 1];
    return bearing(a[0], a[1], b[0], b[1]);
  }
  const a = latlngs[idx];
  let j = idx + 1;
  while (j < N && haversineM(a[0], a[1], latlngs[j][0], latlngs[j][1]) < 20) j++;
  if (j >= N) j = N - 1;
  if (j === idx) return null;
  return bearing(a[0], a[1], latlngs[j][0], latlngs[j][1]);
}

/* Spur der letzten Fixes (max. 30 s) für die Bewegungsrichtung.
 * Zwei Fixes hintereinander liegen beim Gehen oft nur 1–2 m
 * auseinander; das ist für eine Richtung zu ungenau. */
const TRAIL_MAX_AGE_MS = 30000;
const TRAIL_MIN_DIST_M = 8;

function rememberTrailPoint(pos) {
  const trail = app._trail || (app._trail = []);
  trail.push({ lat: pos.lat, lon: pos.lon, t: pos.t });
  while (trail.length > 2 && pos.t - trail[0].t > TRAIL_MAX_AGE_MS) trail.shift();
  if (trail.length > 40) trail.shift();
}

/* Aktuelle Bewegungsrichtung: vom jüngsten Spurpunkt, der mindestens
 * TRAIL_MIN_DIST_M entfernt ist, zur aktuellen Position. Sonst GPS-Kurs. */
function currentMoveBearing() {
  const c = app.userLastPos;
  if (!c) return null;
  const trail = app._trail || [];
  for (let i = trail.length - 2; i >= 0; i--) {
    const p = trail[i];
    const d = haversineM(p.lat, p.lon, c.lat, c.lon);
    if (d >= TRAIL_MIN_DIST_M) return d <= 300 ? bearing(p.lat, p.lon, c.lat, c.lon) : null;
  }
  if (c.heading != null && isFinite(c.heading)) return c.heading;
  return null;
}

/* Gemeinsame Projektion für beide Navigationstypen.

   1. Die Position wird auf JEDES Segment projiziert (Lot auf die
      Strecke, nicht nur auf den nächsten Punkt). Damit ist die
      Position entlang der Route bei jedem GPS-Fix metergenau.
   2. Alle Segmente bis PROJECTION_TOLERANCE_M weiter weg als das
      nächste sind Kandidaten. Zusammenhängende Kandidaten bilden einen
      „Durchgang“ (z. B. Hinweg und Rückweg auf derselben Straße sind
      zwei Durchgänge). Je Durchgang zählt das nächste Segment.
   3. Durchgänge gegen die Bewegungsrichtung (> 60°) fallen weg, solange
      einer übrig bleibt.
   4. Unter den übrigen gewinnt der, dessen Position am nächsten an der
      vorigen liegt (Kontinuität, bei Gleichstand vorwärts); ohne
      Vorgeschichte der früheste.

   Zusätzlich wird erkannt, ob man netto WRONG_WAY_M entgegen der Route
   geht (ps.wrongWay).

   ps = Zustand aus newProjState(), je Navigationstyp ein eigener.
   Rückgabe: { distance, index, cumDist, wrongWay } */
function projectOntoRoute(latlngs, cumDist, lat, lon, ps) {
  const N = latlngs.length;
  if (!N) return null;
  if (N === 1) {
    ps.lastIndex = 0; ps.lastCum = 0;
    return { distance: haversineM(lat, lon, latlngs[0][0], latlngs[0][1]), index: 0, cumDist: 0, wrongWay: false };
  }

  // Lot auf jedes Segment (lokal eben gerechnet, Abstand per Haversine)
  const cosLat = Math.cos(lat * Math.PI / 180);
  const px = lon * cosLat, py = lat;
  const segD = new Float64Array(N - 1);
  const segC = new Float64Array(N - 1);
  let minD = Infinity;
  for (let i = 0; i < N - 1; i++) {
    const a = latlngs[i], b = latlngs[i + 1];
    const ax = a[1] * cosLat, ay = a[0];
    const dx = b[1] * cosLat - ax, dy = b[0] - ay;
    const lenSq = dx * dx + dy * dy;
    let f = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
    f = Math.max(0, Math.min(1, f));
    const d = haversineM(lat, lon, ay + f * dy, (ax + f * dx) / cosLat);
    segD[i] = d;
    segC[i] = cumDist[i] + f * (cumDist[i + 1] - cumDist[i]);
    if (d < minD) minD = d;
  }

  // Durchgänge bilden: zusammenhängende Kandidaten-Segmente. Kehrt die
  // Route innerhalb davon um (Hin- und Rückweg auf demselben Weg),
  // beginnt dort ein neuer Durchgang.
  const limit = minD + PROJECTION_TOLERANCE_M;
  const passes = [];
  let cur = null, prevBearing = null;
  for (let i = 0; i < N - 1; i++) {
    if (segD[i] > limit) { cur = null; continue; }
    const a = latlngs[i], b = latlngs[i + 1];
    const segBearing = bearing(a[0], a[1], b[0], b[1]);
    let reversed = false;
    if (cur && prevBearing != null) {
      let diff = Math.abs(segBearing - prevBearing);
      if (diff > 180) diff = 360 - diff;
      reversed = diff > 120;
    }
    if (!cur || reversed) { cur = { seg: i }; passes.push(cur); }
    else if (segD[i] < segD[cur.seg]) cur.seg = i;
    prevBearing = segBearing;
  }

  // Richtungsfilter
  let pool = passes;
  const moveBearing = currentMoveBearing();
  if (moveBearing != null && passes.length > 1) {
    const directional = passes.filter(pass => {
      const rb = routeBearingAt(latlngs, pass.seg);
      if (rb == null) return true;
      let diff = Math.abs(moveBearing - rb);
      if (diff > 180) diff = 360 - diff;
      return diff <= 60;
    });
    if (directional.length) pool = directional;
  }

  // Kontinuität: am nächsten zur vorigen Position, bei Gleichstand
  // (z. B. am Wendepunkt von Hin- und Rückweg) vorwärts bevorzugen.
  let chosen = pool[0];
  if (ps.lastCum != null) {
    let best = Infinity;
    for (const pass of pool) {
      const delta = segC[pass.seg] - ps.lastCum;
      const score = Math.abs(delta) + (delta < 0 ? 10 : 0);
      if (score < best) { best = score; chosen = pass; }
    }
  }
  // Ohne Vorgeschichte bleibt der früheste Durchgang (pool[0]): bei
  // Rundtouren, deren Start und Ziel zusammenfallen, also der Start.

  const seg = chosen.seg;
  const cum = segC[seg];
  const distance = segD[seg];

  // Falsche Richtung: Netto-Rückwärtsstrecke auf der Route mitzählen.
  if (ps.lastCum != null && distance < OFF_ROUTE_THRESHOLD_M) {
    const delta = cum - ps.lastCum;
    ps.backM = Math.max(0, ps.backM - delta);
    if (Math.abs(delta) > 500) ps.backM = 0;   // Sprung (GPS-Lücke) → neu anfangen
  } else if (distance >= OFF_ROUTE_THRESHOLD_M) {
    ps.backM = 0;
  }
  ps.wrongWay = ps.backM >= WRONG_WAY_M;
  ps.lastIndex = seg;
  ps.lastCum = cum;
  return { distance, index: seg, cumDist: cum, wrongWay: ps.wrongWay };
}

/* Typ 1 (Tour-Route) */
function distanceToRoute(lat, lon) {
  return projectOntoRoute(app.routeLatLngs, app.routeCumDist, lat, lon, app._projStateTour);
}
