/* ============================================================
 * AndromedaExplorer — GPX lesen
 * AndromedaGpx.parse(xmlText) liefert
 *   {
 *     coords:      [[lon, lat, ele?], …]   alle Trackpunkte
 *     tagSegments: [{ coords, length_m, properties: { wayTags } }]
 *                  aus <trkseg> mit <andromeda:way-tags> (Wege-Statistik)
 *     waypoints:   [{ id, name, lat, lon, ele, note, images: [] }]
 *     trackName:   Name aus <trk><name> oder ""
 *     activity:    "hiking" | "cycling" | "running" (aus <trk><type>)
 *     turnInstructions: [{ index, lat, lon, turn, angle }] aus <rte>
 *                  im OsmAnd-Format, sonst [] (siehe turninstr.js)
 *   }
 * Wirft einen Error, wenn das XML ungültig ist.
 *
 * Voraussetzung: utils.js, i18n.js, turninstr.js
 * ============================================================ */
(function () {
  const { haversineM, uuid } = AndromedaUtils;

  const findTags = (parent, tag) => Array.from(parent.getElementsByTagNameNS("*", tag));

  function readPoint(pt) {
    const lat = parseFloat(pt.getAttribute("lat"));
    const lon = parseFloat(pt.getAttribute("lon"));
    if (isNaN(lat) || isNaN(lon)) return null;
    const eleEl = findTags(pt, "ele")[0];
    return eleEl ? [lon, lat, parseFloat(eleEl.textContent)] : [lon, lat];
  }

  function segmentLength(coords) {
    let len = 0;
    for (let i = 1; i < coords.length; i++) {
      len += haversineM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    }
    return len;
  }

  function detectActivity(trkEl) {
    const typeEl = trkEl && findTags(trkEl, "type")[0];
    if (!typeEl) return "hiking";
    const s = typeEl.textContent.toLowerCase();
    if (s.includes("cycl") || s.includes("bike")) return "cycling";
    if (s.includes("run") || s.includes("jog")) return "running";
    return "hiking";
  }

  function parse(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error(t("gpx.invalid"));

    const coords = [];
    const tagSegments = [];
    const trksegEls = findTags(doc, "trkseg");

    if (trksegEls.length > 0) {
      for (const seg of trksegEls) {
        const segCoords = [];
        for (const pt of findTags(seg, "trkpt")) {
          const c = readPoint(pt);
          if (c) { segCoords.push(c); coords.push(c); }
        }
        // Wege-Tags aus unseren GPX-Extensions (letzter Eintrag gewinnt)
        let wayTags = "";
        for (const ext of findTags(seg, "extensions")) {
          for (const wt of findTags(ext, "way-tags")) wayTags = wt.textContent;
        }
        if (segCoords.length > 0 && wayTags) {
          tagSegments.push({
            coords: segCoords,
            length_m: segmentLength(segCoords),
            properties: { wayTags },
          });
        }
      }
    } else {
      // Flache GPX ohne Segmente, notfalls Routenpunkte
      const trkpts = findTags(doc, "trkpt");
      for (const pt of (trkpts.length ? trkpts : findTags(doc, "rtept"))) {
        const c = readPoint(pt);
        if (c) coords.push(c);
      }
    }

    const waypoints = [];
    for (const wpt of findTags(doc, "wpt")) {
      const c = readPoint(wpt);
      if (!c) continue;
      const nameEl = findTags(wpt, "name")[0];
      const descEl = findTags(wpt, "desc")[0];
      waypoints.push({
        id: uuid(),
        name: (nameEl && nameEl.textContent.trim()) || t("wp.default"),
        lat: c[1], lon: c[0],
        ele: c.length >= 3 ? c[2] : null,
        note: descEl ? descEl.textContent.trim() : "",
        images: [],
      });
    }

    const trkEl = findTags(doc, "trk")[0];
    let trackName = "";
    if (trkEl) {
      const tn = findTags(trkEl, "name")[0];
      if (tn) trackName = tn.textContent.trim();
    }

    // Abbiegeanweisungen (Offsets zählen über alle <trkseg> hinweg,
    // genau wie coords oben). Nur sinnvoll, wenn es Trackpunkte gibt.
    let turnInstructions = [];
    if (trksegEls.length > 0 && coords.length > 1 && window.AndromedaTurns) {
      try { turnInstructions = AndromedaTurns.alignToCoords(AndromedaTurns.parseGpxRte(doc), coords); }
      catch (e) { turnInstructions = []; }
    }

    return { coords, tagSegments, waypoints, trackName, activity: detectActivity(trkEl), turnInstructions };
  }

  window.AndromedaGpx = { parse };
})();
