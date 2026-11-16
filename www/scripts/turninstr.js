/* ============================================================
 * AndromedaExplorer — Abbiegeanweisungen
 *
 * Gemeinsame Sprache für Routenplaner, Editor, Viewer und Navigator.
 * Befehle wie bei OsmAnd (und BRouter im OsmAnd-Stil):
 *   C     geradeaus          KL / KR    links / rechts halten
 *   TSLL  leicht links       TSLR       leicht rechts
 *   TL    links              TR         rechts
 *   TSHL  scharf links       TSHR       scharf rechts
 *   TU    umdrehen (links)   TRU        umdrehen (rechts)
 *   RNDBn Kreisverkehr, n-te Ausfahrt (gegen den Uhrzeigersinn)
 *   RNLBn Kreisverkehr, n-te Ausfahrt (im Uhrzeigersinn, Linksverkehr)
 *
 * Ein Hinweis: { index, lat, lon, turn, angle }
 *   index  Trackpunkt, an dem abgebogen wird (Index in der Geometrie)
 *   angle  Abbiegewinkel in Grad, negativ = links (wie BRouter)
 *
 * In GPX-Dateien stehen die Hinweise als <rte> im OsmAnd-Format
 * (<offset> = Index des Trackpunkts über alle <trkseg> hinweg).
 * So zeigt auch OsmAnd beim Folgen der GPX echte Abbiegehinweise.
 *
 * Voraussetzung: utils.js, i18n.js
 * ============================================================ */
(function () {
  const { haversineM } = AndromedaUtils;

  /* BRouter-GeoJSON: properties.voicehints = [[index, befehl, ausfahrt,
   * distanzZumNächsten, winkel], …]. Befehlsnummern wie in BRouter
   * (VoiceHint.java). Abseits-der-Route und Luftlinie fallen weg. */
  const BROUTER_CMD = {
    1: "C", 2: "TL", 3: "TSLL", 4: "TSHL", 5: "TR", 6: "TSLR", 7: "TSHR",
    8: "KL", 9: "KR", 10: "TU", 11: "TRU", 12: null, 13: "RNDB", 14: "RNLB",
    15: "TU", 16: null, 17: "KL", 18: "KR",
  };
  const VALID = /^(C|TL|TSLL|TSHL|TR|TSLR|TSHR|KL|KR|TU|TRU|RNDB\d{1,2}|RNLB\d{1,2})$/;

  function normalizeTurn(code) {
    const s = String(code || "").trim().toUpperCase();
    if (s === "TLU") return "TU";
    if (s === "EL") return "KL";
    if (s === "ER") return "KR";
    return VALID.test(s) ? s : null;
  }

  function fromBrouterGeojson(geojson) {
    const out = [];
    for (const feat of (geojson && geojson.features) || []) {
      const vh = feat && feat.properties && feat.properties.voicehints;
      if (!Array.isArray(vh)) continue;
      for (const row of vh) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const index = parseInt(row[0], 10);
        let turn = BROUTER_CMD[parseInt(row[1], 10)];
        if (!turn || !(index >= 0)) continue;
        if (turn === "RNDB" || turn === "RNLB") {
          const exit = Math.abs(parseInt(row[2], 10)) || 0;
          if (exit < 1) continue;
          turn += exit;
        }
        const angle = row.length > 4 ? parseFloat(row[4]) : NaN;
        out.push({ index, turn, angle: isFinite(angle) && Math.abs(angle) <= 360 ? Math.round(angle) : null });
      }
      break;   // BRouter liefert genau ein Feature
    }
    out.sort((a, b) => a.index - b.index);
    return out;
  }

  /* ---------- GPX lesen ---------- */
  const childByName = (el, name) => {
    for (const c of el.children) if ((c.localName || c.nodeName).toLowerCase() === name) return c;
    return null;
  };
  function extValue(rtept, name) {
    const ext = childByName(rtept, "extensions");
    if (!ext) return null;
    // auch verschachtelt (z. B. <osmand:…>), daher Suche nach lokalem Namen
    for (const el of ext.getElementsByTagName("*")) {
      if ((el.localName || el.nodeName).toLowerCase() === name) return el.textContent.trim();
    }
    return null;
  }

  /* Liest Hinweise aus dem ersten <rte> mit <offset>-Angaben.
   * Liefert [] wenn keine Abbiegeanweisungen enthalten sind. */
  function parseGpxRte(doc) {
    const rtes = Array.from(doc.getElementsByTagNameNS("*", "rte"));
    for (const rte of rtes) {
      const items = [];
      let hasOffset = false;
      for (const pt of rte.children) {
        if ((pt.localName || pt.nodeName).toLowerCase() !== "rtept") continue;
        const off = extValue(pt, "offset");
        if (off == null || !/^\d+$/.test(off)) continue;
        hasOffset = true;
        const turn = normalizeTurn(extValue(pt, "turn"));
        if (!turn) continue;   // Start, Ziel, unbekannte Befehle
        const lat = parseFloat(pt.getAttribute("lat"));
        const lon = parseFloat(pt.getAttribute("lon"));
        const angle = parseFloat(extValue(pt, "turn-angle"));
        items.push({
          index: parseInt(off, 10),
          lat: isFinite(lat) ? lat : null,
          lon: isFinite(lon) ? lon : null,
          turn,
          angle: isFinite(angle) ? Math.round(angle) : null,
        });
      }
      if (hasOffset) return items.sort((a, b) => a.index - b.index);
    }
    return [];
  }

  /* Hinweise aus route.json (TourPack) prüfen und vereinheitlichen. */
  function fromTourpack(ti) {
    const list = ti && Array.isArray(ti.items) ? ti.items : (Array.isArray(ti) ? ti : []);
    const out = [];
    for (const it of list) {
      const turn = normalizeTurn(it && it.turn);
      const index = it ? parseInt(it.index, 10) : NaN;
      if (!turn || !(index >= 0)) continue;
      out.push({
        index, turn,
        lat: isFinite(it.lat) ? +it.lat : null,
        lon: isFinite(it.lon) ? +it.lon : null,
        angle: isFinite(it.angle) ? Math.round(it.angle) : null,
      });
    }
    return out.sort((a, b) => a.index - b.index);
  }

  /* Für route.json (TourPack). */
  function toTourpack(hints, source) {
    if (!hints || !hints.length) return undefined;
    return {
      format: "osmand",
      source: source || "brouter",
      items: hints.map(h => {
        const o = { index: h.index, turn: h.turn };
        if (h.lat != null) { o.lat = +h.lat.toFixed(6); o.lon = +h.lon.toFixed(6); }
        if (h.angle != null) o.angle = h.angle;
        return o;
      }),
    };
  }

  /* Hinweise passend zu einer Koordinatenliste [lon, lat, …] machen:
   * Liegt der Punkt am Index nicht dort, wo der Hinweis sagt (andere
   * Zählweise, gekürzter Track), wird der nächste Punkt ab dem
   * vorigen Hinweis gesucht. Liefert neue Objekte mit gültigem index. */
  function alignToCoords(hints, coords, toleranceM) {
    const tol = toleranceM || 25;
    const N = coords.length;
    const out = [];
    let from = 0;
    for (const h of hints) {
      let idx = h.index;
      const c = coords[idx];
      const hasPos = h.lat != null && h.lon != null;
      const fits = c && (!hasPos || haversineM(c[1], c[0], h.lat, h.lon) <= tol);
      if (!fits) {
        if (!hasPos) continue;
        let best = -1, bestD = Infinity;
        for (let i = from; i < N; i++) {
          const d = haversineM(coords[i][1], coords[i][0], h.lat, h.lon);
          if (d < bestD) { bestD = d; best = i; }
        }
        if (best < 0 || bestD > tol * 2) continue;
        idx = best;
      }
      if (idx < from) continue;
      from = idx;
      out.push(Object.assign({}, h, { index: idx }));
    }
    return out;
  }

  /* Hinweise (index in coords) auf eine andere Punktfolge umrechnen,
   * z. B. die exportierten Trackpunkte, wenn diese in mehrere <trkseg>
   * mit doppelten Grenzpunkten aufgeteilt sind. */
  function remap(hints, coords, points) {
    const out = [];
    let from = 0;
    for (const h of hints || []) {
      const c = coords[h.index];
      if (!c) continue;
      let found = -1;
      for (let j = from; j < points.length; j++) {
        const p = points[j];
        if (Math.abs(p[0] - c[0]) < 1e-9 && Math.abs(p[1] - c[1]) < 1e-9) { found = j; break; }
      }
      if (found < 0) {
        let bestD = Infinity;
        for (let j = from; j < points.length; j++) {
          const d = haversineM(points[j][1], points[j][0], c[1], c[0]);
          if (d < bestD) { bestD = d; found = j; }
        }
        if (bestD > 25) continue;
      }
      from = found;
      out.push(Object.assign({}, h, { index: found }));
    }
    return out;
  }

  /* ---------- Bedeutung und Text ---------- */
  /* { kind, direction, severity, exit }
   * kind: "straight" | "turn" | "keep" | "uturn" | "roundabout" */
  function describe(turn) {
    const t = normalizeTurn(turn);
    if (!t) return null;
    const rb = t.match(/^RN([DL])B(\d+)$/);
    if (rb) return { kind: "roundabout", direction: rb[1] === "D" ? "ccw" : "cw", severity: null, exit: parseInt(rb[2], 10) };
    switch (t) {
      case "C": return { kind: "straight", direction: null, severity: null };
      case "KL": return { kind: "keep", direction: "left", severity: null };
      case "KR": return { kind: "keep", direction: "right", severity: null };
      case "TU": return { kind: "uturn", direction: "left", severity: "uturn" };
      case "TRU": return { kind: "uturn", direction: "right", severity: "uturn" };
    }
    const direction = t.endsWith("L") ? "left" : "right";
    const severity = t.startsWith("TSL") ? "slight" : t.startsWith("TSH") ? "sharp" : "normal";
    return { kind: "turn", direction, severity };
  }

  /* Kurzer deutscher Text (die Übersetzung erledigt i18n). */
  function text(d) {
    if (!d) return "";
    const side = d.direction === "right" ? "rechts" : "links";
    switch (d.kind) {
      case "straight": return "geradeaus";
      case "keep": return `${side} halten`;
      case "uturn": return "umdrehen";
      case "roundabout": return `Kreisverkehr, ${d.exit}. Ausfahrt`;
    }
    if (d.severity === "slight") return `leicht ${side}`;
    if (d.severity === "sharp") return `scharf ${side}`;
    return `${side} abbiegen`;
  }

  /* OsmAnd-Befehl aus einer Beschreibung (z. B. für geometrisch
   * berechnete Abbiegungen beim GPX-Export). */
  function codeFor(d) {
    if (!d) return null;
    const L = d.direction === "left";
    switch (d.kind) {
      case "straight": return "C";
      case "keep": return L ? "KL" : "KR";
      case "uturn": return L ? "TU" : "TRU";
      case "roundabout": return (d.direction === "cw" ? "RNLB" : "RNDB") + (d.exit || 1);
    }
    if (d.severity === "slight") return L ? "TSLL" : "TSLR";
    if (d.severity === "sharp") return L ? "TSHL" : "TSHR";
    return L ? "TL" : "TR";
  }

  /* ---------- GPX schreiben (OsmAnd-Format) ----------
   * points: alle exportierten Trackpunkte in Reihenfolge, je [lon, lat]
   * hints:  [{ index (in points), turn, angle }]
   * opts.durationS: Gesamtdauer (für <time> je Abschnitt, optional)
   * Liefert den <rte>-Block (GPX 1.1: steht vor <trk>). */
  function gpxRte(points, hints, opts) {
    opts = opts || {};
    const N = points.length;
    if (N < 2 || !hints || !hints.length) return "";
    const cum = [0];
    for (let i = 1; i < N; i++) {
      cum.push(cum[i - 1] + haversineM(points[i - 1][1], points[i - 1][0], points[i][1], points[i][0]));
    }
    const total = cum[N - 1] || 1;
    const dur = opts.durationS > 0 ? opts.durationS : 0;
    const ind = opts.indent == null ? "  " : opts.indent;
    const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const tr = s => (window.AndromedaI18n ? AndromedaI18n.tr(s) : s);
    const rows = [{ index: 0, desc: tr("Start"), turn: null }];
    for (const h of hints) {
      if (!(h.index > 0 && h.index < N - 1)) continue;
      rows.push({ index: h.index, desc: tr(text(describe(h.turn))), turn: h.turn, angle: h.angle });
    }
    rows.push({ index: N - 1, desc: tr("Ziel"), turn: null, last: true });
    let x = `${ind}<rte>\n`;
    rows.forEach((r, k) => {
      const p = points[r.index];
      x += `${ind}  <rtept lat="${p[1].toFixed(6)}" lon="${p[0].toFixed(6)}">\n`;
      x += `${ind}    <desc>${esc(r.desc)}</desc>\n`;
      x += `${ind}    <extensions>\n`;
      if (dur) {
        const next = rows[k + 1];
        const secs = next ? Math.round(dur * (cum[next.index] - cum[r.index]) / total) : 0;
        x += `${ind}      <time>${secs}</time>\n`;
      }
      if (r.turn) {
        x += `${ind}      <turn>${r.turn}</turn>\n`;
        if (r.angle != null) x += `${ind}      <turn-angle>${r.angle}</turn-angle>\n`;
      }
      x += `${ind}      <offset>${r.index}</offset>\n`;
      x += `${ind}    </extensions>\n${ind}  </rtept>\n`;
    });
    x += `${ind}</rte>\n`;
    return x;
  }

  /* OsmAnd liest die Anweisungen nur aus Dateien dieses Erzeugers
   * (so macht es auch BRouter beim Export im OsmAnd-Stil). */
  const OSMAND_CREATOR = "OsmAndRouter";

  window.AndromedaTurns = {
    fromBrouterGeojson, parseGpxRte, fromTourpack, toTourpack, alignToCoords, remap,
    normalizeTurn, describe, text, codeFor, gpxRte, OSMAND_CREATOR,
  };
})();
