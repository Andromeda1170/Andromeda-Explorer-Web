/* ============================================================
 * Navigator — Abbiegehinweise
 * Teil von navigation.html. Alle Navigator-Dateien teilen sich
 * den globalen Gültigkeitsbereich und werden in fester
 * Reihenfolge geladen (siehe navigation.html).
 * ============================================================ */
"use strict";

function classifyTurn(deltaDeg) {
  const a = Math.abs(deltaDeg);
  if (a < TURN_MIN_ANGLE_DEG) return null;
  if (a >= TURN_MAX_ANGLE_DEG) return null;
  if (a < 60) return "slight";
  if (a < 120) return "normal";
  return "sharp";
}

/* Läuft die Route nach Punkt i auf sich selbst zurück?
 * (Punkte gleich weit vor und nach i liegen fast aufeinander.)
 * Unterscheidet echtes Umdrehen von Serpentinen. */
function isRetrace(latlngs, cumDist, i) {
  const N = latlngs.length;
  for (const off of UTURN_CHECK_M) {
    let b = i, a = i;
    while (b > 0 && cumDist[i] - cumDist[b] < off) b--;
    while (a < N - 1 && cumDist[a] - cumDist[i] < off) a++;
    if (cumDist[i] - cumDist[b] < off * 0.75 || cumDist[a] - cumDist[i] < off * 0.75) return false;
    const d = haversineM(latlngs[b][0], latlngs[b][1], latlngs[a][0], latlngs[a][1]);
    if (d > UTURN_RETRACE_M) return false;
  }
  return true;
}

/* Erkennt Abbiegepunkte einer Route anhand der Geometrie.
 * Nur der Rückfall, wenn die Route keine Abbiegeanweisungen mitbringt
 * (siehe turnsFromInstructions): Knicke im Track sind nicht immer
 * Kreuzungen, und an einer Kreuzung ohne Knick gibt es keinen Hinweis.
 * Liefert [{ index, cumDist, deltaDeg, kind, direction, severity }],
 * severity = "slight" | "normal" | "sharp" | "uturn". */
function computeTurnsForRoute(latlngs, cumDist) {
  const turns = [];
  if (!latlngs || latlngs.length < 5) return turns;
  const N = latlngs.length;
  const totalDist = cumDist[N - 1] || 0;
  if (totalDist < 30) return turns;
  const windowM = Math.max(6, Math.min(TURN_WINDOW_M, totalDist / 8));
  function indexAtOffset(fromIdx, meters) {
    let i = fromIdx;
    if (meters > 0) { while (i < N - 1 && cumDist[i] < cumDist[fromIdx] + meters) i++; }
    else { while (i > 0 && cumDist[i] > cumDist[fromIdx] + meters) i--; }
    return i;
  }
  const deltas = new Array(N).fill(0);
  for (let i = 1; i < N - 1; i++) {
    const iBefore = indexAtOffset(i, -windowM), iAfter = indexAtOffset(i, windowM);
    if (iBefore === i || iAfter === i) continue;
    const bB = bearing(latlngs[iBefore][0], latlngs[iBefore][1], latlngs[i][0], latlngs[i][1]);
    const bA = bearing(latlngs[i][0], latlngs[i][1], latlngs[iAfter][0], latlngs[iAfter][1]);
    let d = bA - bB;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    deltas[i] = d;
  }
  const peaks = [];
  for (let i = 1; i < N - 1; i++) {
    const a = Math.abs(deltas[i]);
    if (a < TURN_MIN_ANGLE_DEG) continue;
    let severity;
    if (a >= UTURN_MIN_ANGLE_DEG && isRetrace(latlngs, cumDist, i)) severity = "uturn";
    else if (a >= TURN_MAX_ANGLE_DEG) continue;
    else severity = classifyTurn(deltas[i]);
    // lokales Maximum (gleiche Richtung) in der Nachbarschaft
    const signI = deltas[i] > 0 ? 1 : -1;
    let isMax = true;
    const jLo = Math.max(1, i - TURN_LOCAL_MAX_IDX), jHi = Math.min(N - 2, i + TURN_LOCAL_MAX_IDX);
    for (let j = jLo; j <= jHi; j++) {
      if (j === i) continue;
      const dj = deltas[j];
      if (severity !== "uturn" && (dj > 0 ? 1 : -1) !== signI) continue;
      if (Math.abs(dj) > a) { isMax = false; break; }
    }
    if (!isMax) continue;
    peaks.push({
      index: i, cumDist: cumDist[i], deltaDeg: deltas[i],
      kind: severity === "uturn" ? "uturn" : "turn",
      direction: deltas[i] > 0 ? "right" : "left",
      severity,
    });
  }
  // Dicht aufeinanderfolgende Knicke in dieselbe Richtung zusammenfassen;
  // ein Umdrehen schluckt alles in seiner Nähe.
  const minSpacing = Math.min(TURN_MIN_SPACING_M, totalDist / 10);
  for (const p of peaks) {
    const last = turns[turns.length - 1];
    const close = last && (p.cumDist - last.cumDist) < minSpacing;
    if (close && (p.severity === "uturn" || last.severity === "uturn")) {
      if (p.severity === "uturn" && last.severity !== "uturn") turns[turns.length - 1] = p;
      continue;
    }
    if (close && p.direction === last.direction) {
      if (Math.abs(p.deltaDeg) > Math.abs(last.deltaDeg)) turns[turns.length - 1] = p;
      continue;
    }
    turns.push(p);
  }
  return turns;
}

/* Abbiegepunkte aus mitgelieferten Abbiegeanweisungen (BRouter bzw.
 * <rte> der GPX / turn_instructions im TourPack).
 *   coords:  Original-Koordinaten [lon, lat, …], auf die sich index bezieht
 *   hints:   [{ index, lat, lon, turn, angle }] (siehe turninstr.js)
 *   latlngs, cumDist: verdichtete Route aus buildNavTrack
 * Liefert dieselbe Form wie computeTurnsForRoute, zusätzlich exit/turn. */
function turnsFromInstructions(coords, hints, latlngs, cumDist) {
  if (!hints || !hints.length || !coords || coords.length < 2) return [];
  const aligned = AndromedaTurns.alignToCoords(hints, coords);
  if (!aligned.length) return [];
  const rawCum = [0];
  for (let i = 1; i < coords.length; i++) {
    rawCum.push(rawCum[i - 1] + haversineM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  }
  const out = [];
  for (const h of aligned) {
    const d = AndromedaTurns.describe(h.turn);
    if (!d) continue;
    const cum = rawCum[h.index];
    let lo = 0, hi = cumDist.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumDist[mid] < cum - 0.05) lo = mid + 1; else hi = mid; }
    out.push({
      index: lo, cumDist: cum,
      deltaDeg: h.angle != null ? h.angle : 0,
      kind: d.kind, direction: d.direction, severity: d.severity || (d.kind === "uturn" ? "uturn" : null),
      exit: d.exit || null, turn: h.turn, angle: h.angle,
    });
  }
  return out;
}

/* ------------------------------------------------------------
 * Darstellung (gleich für Tour- und Sondernavigation)
 * ------------------------------------------------------------ */
const TURN_ICON_ROTATION = { slight: 45, normal: 90, sharp: 135 };

function arrowSvg(deg) {
  return `<svg viewBox="0 0 40 40" style="transform: rotate(${deg}deg);"><path d="M 20 34 L 20 12" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round"/><polygon points="10,14 20,4 30,14" fill="currentColor"/></svg>`;
}

function turnArrowSvg(direction, severity) {
  if (severity === "uturn") return uturnIconSvg(direction);
  return arrowSvg((TURN_ICON_ROTATION[severity] || 90) * (direction === "right" ? 1 : -1));
}

/* U-förmiger Pfeil. Bei Linkskehre gespiegelt. */
function uturnIconSvg(direction) {
  const flip = direction === "left" ? ' style="transform: scaleX(-1);"' : "";
  return `<svg viewBox="0 0 40 40"${flip}><path d="M 12 34 L 12 16 A 8 8 0 0 1 28 16 L 28 26" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round"/><polygon points="20,24 28,36 36,24" fill="currentColor"/></svg>`;
}

/* Gabelung: der gewählte Ast kräftig, der andere blass. */
function keepIconSvg(direction) {
  const flip = direction === "left" ? ' style="transform: scaleX(-1);"' : "";
  return `<svg viewBox="0 0 40 40"${flip}><path d="M 20 23 L 10 10" stroke="currentColor" stroke-width="4" fill="none" stroke-linecap="round" opacity=".35"/><path d="M 20 36 L 20 23 L 26 14.5" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><polygon points="31.5,7 30.3,17.5 21.7,10.7" fill="currentColor"/></svg>`;
}

/* Kreisverkehr: Ring, Zufahrt von unten, Ausfahrt in Abbiegerichtung
 * (Winkel von BRouter, sonst grob aus der Nummer), Nummer im Ring. */
function roundaboutIconSvg(turn) {
  const fallback = { 1: 90, 2: 0, 3: -90 };
  let a = turn.angle != null ? turn.angle : (fallback[turn.exit] != null ? fallback[turn.exit] : -135);
  a = Math.max(-150, Math.min(150, a));
  const cx = 20, cy = 22.5, R = 7.5;
  const rad = a * Math.PI / 180, ux = Math.sin(rad), uy = -Math.cos(rad);
  const at = (k, off) => [cx + ux * k + (off || 0) * -uy, cy + uy * k + (off || 0) * ux];
  const f = p => p[0].toFixed(1) + "," + p[1].toFixed(1);
  const head = [at(18.5), at(11.5, 5.5), at(11.5, -5.5)].map(f).join(" ");
  const n = turn.exit ? `<text x="${cx}" y="${cy}" dy=".36em" text-anchor="middle" font-size="9.5" font-weight="800" fill="currentColor" font-family="system-ui, -apple-system, sans-serif">${turn.exit}</text>` : "";
  return `<svg viewBox="0 0 40 40"><circle cx="${cx}" cy="${cy}" r="${R}" stroke="currentColor" stroke-width="3" fill="none"/>` +
    `<path d="M ${cx} 39 L ${cx} ${cy + R + 1}" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round"/>` +
    `<path d="M ${f(at(R))} L ${f(at(12.5))}" stroke="currentColor" stroke-width="4.5" fill="none" stroke-linecap="round"/>` +
    `<polygon points="${head}" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>${n}</svg>`;
}

function turnIconSvg(turn) {
  switch (turn.kind) {
    case "uturn": return uturnIconSvg(turn.direction);
    case "straight": return arrowSvg(0);
    case "keep": return keepIconSvg(turn.direction);
    case "roundabout": return roundaboutIconSvg(turn);
  }
  return turnArrowSvg(turn.direction, turn.severity);
}

function turnActionText(turn) {
  return AndromedaTurns.text(turn);
}

function hideTurnBanner() {
  const el = $("turnBanner");
  if (el) el.classList.remove("show", "offroute", "wrongway");
}

function offRouteIconSvg() {
  return `<svg viewBox="0 0 40 40" fill="none"><path d="M 20 5 L 37 34 L 3 34 Z" stroke="currentColor" stroke-width="3" stroke-linejoin="round" fill="none"/><line x1="20" y1="15" x2="20" y2="25" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/><circle cx="20" cy="30" r="1.8" fill="currentColor"/></svg>`;
}

/* Abstand zur Route: unter 1 km in Metern, sonst „1,2 km“. */
function fmtOffRouteDistance(m) {
  if (m == null || !isFinite(m)) return "—";
  if (m < 1000) return Math.round(m) + " m";
  return AndromedaI18n.fmtNumber(m / 1000, 1) + " km";
}

/* Welche Navigation gerade die Hinweise bestimmt.
 * Typ 2 (Sondernavigation) hat Vorrang, solange sie aktiv ist.
 * Beide liefern dieselben Felder; sie unterscheiden sich nur in der Farbe. */
function activeNavSource() {
  if (app.approachRoute.active) {
    return {
      kind: "approach",
      color: settings.approachLineColor || APPROACH_COLOR,
      turns: app.approachRoute.turns || [],
      activity: app.approachRoute.activity || "hiking",
      offDist: app.lastDistanceToApproach,
      proj: app._projStateApproach,
    };
  }
  return {
    kind: "tour",
    color: settings.routeColor || "#2a6fbf",
    turns: app.turns || [],
    activity: (app.tourpackData && app.tourpackData.route && app.tourpackData.route.type) || "hiking",
    offDist: app.lastDistanceToRoute,
    proj: app._projStateTour,
  };
}

function showBanner(el, iconSvg, distanceText, actionText, variant) {
  $("turnIcon").innerHTML = iconSvg;
  $("turnDistance").textContent = distanceText || "";
  $("turnDistance").hidden = !distanceText;
  $("turnAction").textContent = actionText;
  el.classList.remove("offroute", "wrongway");
  if (variant) el.classList.add(variant);
  el.classList.add("show");
}

/* Angezeigte Restdistanz zu einem Abbiegepunkt. Pro Fix die echte
 * Distanz, aber kleines Hochzählen durch GPS-Rauschen wird
 * unterdrückt (siehe TURN_JITTER_M). */
function stableTurnDistance(turn, actual) {
  const shown = app._turnShown;
  if (shown && shown.turn === turn && actual > shown.value && actual - shown.value < TURN_JITTER_M) {
    return shown.value;
  }
  app._turnShown = { turn, value: actual };
  return actual;
}

/* Abbiege-Banner für beide Navigationstypen.
 * Reihenfolge: abseits der Route → falsche Richtung → Abbiegen.
 * Die Restdistanz ist die echte Strecke entlang der Route bis zum
 * Abbiegepunkt, bei jedem GPS-Fix neu und metergenau.
 * Ein gerade passierter Hinweis bleibt TURN_HOLD_M sichtbar. */
function updateTurnBanner(currentCum) {
  const el = $("turnBanner");
  if (!el) return;
  if (!settings.turnNotice) { hideTurnBanner(); return; }

  const src = activeNavSource();
  el.style.setProperty("--nav-color", src.color);

  if (src.offDist != null && src.offDist >= OFF_ROUTE_THRESHOLD_M) {
    app._turnShown = null;
    showBanner(el, offRouteIconSvg(), "Achtung",
      `${fmtOffRouteDistance(src.offDist)} von der Route entfernt`, "offroute");
    return;
  }

  if (src.proj && src.proj.wrongWay) {
    showBanner(el, uturnIconSvg("right"), "Falsche Richtung", "umdrehen", "wrongway");
    return;
  }

  const maxShow = TURN_SHOW_DISTANCE_M[src.activity] || TURN_SHOW_DISTANCE_DEFAULT_M;
  let ahead = null, aheadD = Infinity;
  let justPassed = null, passedD = -Infinity;
  for (const turn of src.turns) {
    const d = turn.cumDist - currentCum;
    if (d > 0 && d <= maxShow) {
      if (d < aheadD) { ahead = turn; aheadD = d; }
    } else if (d <= 0 && d >= -TURN_HOLD_M) {
      if (d > passedD) { justPassed = turn; passedD = d; }
    }
  }
  const next = justPassed || ahead;
  if (!next) { app._turnShown = null; hideTurnBanner(); return; }
  const remaining = stableTurnDistance(next, justPassed ? passedD : aheadD);

  const distText = remaining > TURN_NOW_M ? `In ${Math.round(remaining)} m` : "";
  if (next.kind === "roundabout" && next.exit) {
    // „Kreisverkehr“ in die kleine Zeile, damit die Anweisung kurz bleibt
    showBanner(el, turnIconSvg(next), distText ? `${distText} · Kreisverkehr` : "Kreisverkehr",
      `${next.exit}. Ausfahrt`);
    return;
  }
  showBanner(el, turnIconSvg(next), distText, turnActionText(next));
}
