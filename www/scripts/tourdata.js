/* ============================================================
 * AndromedaExplorer — Tourdaten
 * Gemeinsame Logik rund um route.json / geometry.geojson:
 * Statistik, Migration älterer TourPacks, Orts-Formatierung,
 * Markdown-Darstellung. Wird von Viewer, Navigator und Editor
 * verwendet. Keine DOM- oder Leaflet-Abhängigkeit.
 *
 * Voraussetzung: utils.js, i18n.js
 * ============================================================ */
(function () {
  const { haversineM, escapeHtml, ascentDescent } = AndromedaUtils;

  /* Alle Linienkoordinaten [lon, lat, ele?] aus einer FeatureCollection. */
  function extractLineCoords(geometry) {
    const out = [];
    if (!geometry || !geometry.features) return out;
    for (const feat of geometry.features) {
      const g = feat.geometry;
      if (!g) continue;
      if (g.type === "LineString") out.push(...g.coordinates);
      else if (g.type === "MultiLineString") {
        for (const line of g.coordinates) out.push(...line);
      }
    }
    return out;
  }

  /* Start und Ziel < 70 m auseinander und Höhenunterschied < 40 m. */
  function isRoundtripGeometry(geometry) {
    const coords = extractLineCoords(geometry);
    if (coords.length < 2) return false;
    const first = coords[0], last = coords[coords.length - 1];
    if (!Array.isArray(first) || !Array.isArray(last)) return false;
    if (first.length < 2 || last.length < 2) return false;
    if (haversineM(first[1], first[0], last[1], last[0]) > 70) return false;
    if (first.length >= 3 && last.length >= 3) {
      const e1 = first[2] != null ? parseFloat(first[2]) : NaN;
      const e2 = last[2] != null ? parseFloat(last[2]) : NaN;
      if (isFinite(e1) && isFinite(e2) && Math.abs(e1 - e2) > 40) return false;
    }
    return true;
  }

  /* Distanz, Anstieg und Abstieg aus Koordinaten [lon, lat, ele?].
   * Höhenmeter über AndromedaUtils.ascentDescent (projektweit gleich). */
  function computeStats(coords) {
    let dist = 0;
    for (let i = 1; i < coords.length; i++) {
      dist += haversineM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    }
    const elevs = coords.map(c =>
      (Array.isArray(c) && c.length >= 3 && isFinite(c[2])) ? c[2] : null);
    const { ascent, descent } = ascentDescent(elevs);
    const round1 = v => Math.round(v * 10) / 10;
    return {
      distance_m: round1(dist),
      ascent_m: round1(ascent),
      descent_m: round1(descent),
    };
  }

  /* "3,5 h", "3 h 20 min", "200 min" … → { h, min } */
  function parseDurationText(text) {
    if (!text) return { h: 0, min: 0 };
    const s = String(text).toLowerCase();
    const decimal = s.match(/^[\s\D]*(\d+)[.,](\d+)\s*h/);
    if (decimal) {
      const h = parseInt(decimal[1], 10);
      const frac = parseInt(decimal[2].slice(0, 2).padEnd(2, "0"), 10);
      return { h, min: Math.round(frac * 0.6) };
    }
    if (/min/.test(s) && !/h/.test(s)) {
      const m = parseInt((s.match(/\d+/) || [0])[0], 10);
      return { h: Math.floor(m / 60), min: m % 60 };
    }
    const nums = (s.match(/\d+/g) || []).map(n => parseInt(n, 10));
    if (!nums.length) return { h: 0, min: 0 };
    const h = nums[0];
    const min = (nums[1] != null && nums[1] < 60) ? nums[1] : 0;
    return { h, min };
  }

  /* { h, min } → "3 h 20 min" ("" wenn beides 0) */
  function fmtDurationHM(h, min) {
    h = parseInt(h, 10) || 0;
    min = parseInt(min, 10) || 0;
    if (!h && !min) return "";
    if (h && min) return `${h} h ${min} min`;
    if (h) return `${h} h`;
    return `${min} min`;
  }

  /* Bringt ältere route.json-Varianten auf den aktuellen Stand.
   * Ändert das Objekt direkt. */
  function migrateRoute(route) {
    const diff = route.difficulty;
    if (diff && typeof diff === "object" && "overall" in diff && !("ratings" in diff)) {
      const ov = diff.overall || {};
      const legacy = [ov.system, ov.value].filter(Boolean).join(" ");
      route.difficulty = { text: legacy, ratings: {} };
    }

    if (Array.isArray(route.images)) {
      route.images = route.images.map(it => {
        if (typeof it === "string") return { path: it, caption: "" };
        if (it && typeof it === "object" && it.path) {
          return { path: it.path, caption: it.caption || "" };
        }
        return null;
      }).filter(Boolean);
    }

    const loc = route.location || {};
    if (loc.start || loc.center || loc.end) {
      route.location = {
        start:  loc.start  || loc.center || loc.end || {},
        center: loc.center || loc.start  || loc.end || {},
        end:    loc.end    || loc.center || loc.start || {},
      };
    } else if (loc.country || loc.region || loc.place) {
      route.location = { start: loc, center: loc, end: loc };
    }

    const stats = route.stats || {};
    if (typeof stats.duration_h !== "number" &&
        typeof stats.duration_min !== "number" &&
        typeof stats.duration_text === "string" &&
        stats.duration_text.trim()) {
      const parsed = parseDurationText(stats.duration_text);
      stats.duration_h = parsed.h;
      stats.duration_min = parsed.min;
    }
    return route;
  }

  /* Werte eines Felds (z. B. "region") aus start/center/end,
   * ohne Duplikate, kommagetrennt. Ältere flache location-Objekte
   * werden direkt gelesen. */
  function fmtLocFieldList(loc, field) {
    if (!loc) return "";
    if (!loc.start && !loc.center && !loc.end) return loc[field] || "";
    const seen = new Set();
    const out = [];
    for (const key of ["start", "center", "end"]) {
      const v = (loc[key] && loc[key][field]) || "";
      if (v && !seen.has(v)) { seen.add(v); out.push(v); }
    }
    return out.join(", ");
  }

  /* "A bis B", "A über B bis C", bei Rundtour "A über B zurück nach A". */
  function fmtPlaceSequence(loc, roundtrip) {
    if (!loc) return "";
    const s = (loc.start  && loc.start.place)  || "";
    const c = (loc.center && loc.center.place) || "";
    const e = (loc.end    && loc.end.place)    || "";
    const to = t("place.to"), via = t("place.via"), back = t("place.backTo");

    if (!s && !c && !e) return "";
    if (s && !c && !e) return s;
    if (!s && c && !e) return c;
    if (!s && !c && e) return e;

    if (s === c && c === e) return s;
    if (s === c && c !== e) return `${s} ${to} ${e}`;
    if (s !== c && c === e) return `${s} ${to} ${c}`;
    const connector = (roundtrip && s === e) ? back : to;
    return `${s} ${via} ${c} ${connector} ${e}`;
  }

  /* Minimaler, sicherer Markdown-Renderer: Überschriften, Listen,
   * Absätze, **fett**, *kursiv*, `code`. Alles wird vorher escaped. */
  function inlineMd(text) {
    text = escapeHtml(text);
    text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    return text;
  }

  function renderMarkdown(md) {
    const lines = String(md || "").split(/\r?\n/);
    const out = [];
    let inList = false;
    let para = [];
    const flush = () => {
      if (para.length) { out.push(`<p>${para.map(inlineMd).join(" ")}</p>`); para = []; }
    };
    const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (!line.trim()) { flush(); closeList(); continue; }
      if (line.startsWith("### ")) {
        flush(); closeList(); out.push(`<h5>${inlineMd(line.slice(4))}</h5>`);
      } else if (line.startsWith("## ")) {
        flush(); closeList(); out.push(`<h4>${inlineMd(line.slice(3))}</h4>`);
      } else if (line.startsWith("# ")) {
        flush(); closeList(); out.push(`<h4>${inlineMd(line.slice(2))}</h4>`);
      } else if (/^[-*]\s/.test(line)) {
        flush();
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push(`<li>${inlineMd(line.replace(/^[-*]\s/, ""))}</li>`);
      } else {
        closeList();
        para.push(line.trim());
      }
    }
    flush(); closeList();
    return out.join("");
  }

  window.AndromedaTour = {
    extractLineCoords,
    isRoundtripGeometry,
    computeStats,
    parseDurationText,
    fmtDurationHM,
    migrateRoute,
    fmtLocFieldList,
    fmtRegionList: loc => fmtLocFieldList(loc, "region"),
    fmtCountryList: loc => fmtLocFieldList(loc, "country"),
    fmtPlaceSequence,
    inlineMd,
    renderMarkdown,
  };
})();
