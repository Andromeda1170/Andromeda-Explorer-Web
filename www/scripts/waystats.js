/* ============================================================
 * AndromedaExplorer — Wegearten & Oberflächen-Statistik
 * Berechnet Kategorien (Wegeart, Oberfläche, SAC-Skala) aus
 * OSM-Tags, rendert das klickbare Balkendiagramm und hebt eine
 * Kategorie auf der Karte hervor.
 *
 * Die Kategorienamen (z. B. "Bergwanderweg") sind interne
 * Schlüssel. Angezeigt wird die Übersetzung t("waycat.<Name>").
 *
 * Seiten-API:
 *   const hl = AndromedaWayStats.createHighlighter({
 *     getMap, getLayer, getSegments, getColor });
 *   AndromedaWayStats.mount(container, segments, hl, { collapsible });
 *
 * Voraussetzung: utils.js, i18n.js, Leaflet
 * ============================================================ */
(function () {
  const { escapeHtml, haversineM } = AndromedaUtils;

  const CATEGORY_COLORS = {
    "Alpinwanderweg": "#c0392b",
    "Bergwanderweg": "#b07d52",
    "Wanderweg": "#8bc34a",
    "Treppe": "#9b59b6",
    "Weg": "#a0522d",
    "Radweg": "#2980b9",
    "Straße": "#7f8c8d",
    "Asphalt": "#34495e",
    "Kies / Schotter": "#c8ad8d",
    "Naturbelassen": "#8fbc8f",
    "Alpines Gelände": "#95a5a6",
    "Loser Untergrund": "#d4ac0d",
    "Holz": "#8b4513",
    "T1 - Wandern": "#8bc34a",
    "T2 - Bergwandern": "#cddc39",
    "T3 - Anspruchsvolles Bergwandern": "#ffc107",
    "T4 - Alpinwandern": "#ff9800",
    "T5 - Anspruchsvolles Alpinwandern": "#ff5722",
    "T6 - Schwieriges Alpinwandern": "#c0392b",
    "Ohne Angabe": "#bdc3c7",
    "Unbekannt": "#bdc3c7",
  };

  const NO_SAC = "Ohne Angabe";

  function getCategoryColor(name) {
    return CATEGORY_COLORS[name] || "var(--primary)";
  }

  /* Anzeigename einer Kategorie in der aktuellen Sprache. */
  function categoryLabel(name) {
    if (name.startsWith("SAC: ")) return name;
    const key = "waycat." + name;
    const label = t(key);
    return label === key ? name : label;
  }

  function parseWayTags(props) {
    if (!props) return {};
    const tags = {};
    if (typeof props.wayTags === "string" && props.wayTags.length) {
      for (const part of props.wayTags.split(/\s+/)) {
        const eq = part.indexOf("=");
        if (eq > 0) {
          const k = part.slice(0, eq);
          const v = part.slice(eq + 1);
          if (k && v) tags[k] = v;
        }
      }
    }
    for (const k of ["highway", "surface", "sac_scale", "tracktype", "smoothness"]) {
      if (props[k] != null && String(props[k]).length) tags[k] = String(props[k]);
    }
    return tags;
  }

  const ROAD_TYPES = new Set(["residential", "secondary", "tertiary", "primary",
    "unclassified", "living_street", "service", "trunk"]);

  function categorizeWayType(tags) {
    const hw = tags.highway || "";
    const sac = tags.sac_scale || "";
    if (sac === "alpine_hiking" || sac === "demanding_alpine_hiking" || sac === "difficult_alpine_hiking") return "Alpinwanderweg";
    if (sac === "mountain_hiking" || sac === "demanding_mountain_hiking") return "Bergwanderweg";
    if (hw === "path" || hw === "footway" || hw === "bridleway" || hw === "pedestrian") return "Wanderweg";
    if (hw === "steps") return "Treppe";
    if (hw === "track") return "Weg";
    if (hw === "cycleway") return "Radweg";
    if (ROAD_TYPES.has(hw)) return "Straße";
    return "Unbekannt";
  }

  function categorizeSurface(tags) {
    const s = tags.surface || "";
    if (s === "asphalt" || s === "paved" || s === "concrete") return "Asphalt";
    if (["gravel", "fine_gravel", "pebblestone", "unpaved", "cobblestone", "sett", "paving_stones"].includes(s)) return "Kies / Schotter";
    if (["ground", "dirt", "earth", "grass", "soil"].includes(s)) return "Naturbelassen";
    if (["bare_rock", "rock", "scree", "stone"].includes(s)) return "Alpines Gelände";
    if (s === "mud" || s === "sand") return "Loser Untergrund";
    if (s === "wood") return "Holz";
    return "Unbekannt";
  }

  const SAC_NAMES = {
    hiking: "T1 - Wandern",
    mountain_hiking: "T2 - Bergwandern",
    demanding_mountain_hiking: "T3 - Anspruchsvolles Bergwandern",
    alpine_hiking: "T4 - Alpinwandern",
    demanding_alpine_hiking: "T5 - Anspruchsvolles Alpinwandern",
    difficult_alpine_hiking: "T6 - Schwieriges Alpinwandern",
  };

  function categorizeSacScale(tags) {
    const sac = tags.sac_scale || "";
    if (SAC_NAMES[sac]) return SAC_NAMES[sac];
    if (sac) return "SAC: " + sac;
    return NO_SAC;
  }

  const CATEGORIZERS = {
    wayStatsBlock: categorizeWayType,
    surfStatsBlock: categorizeSurface,
    sacStatsBlock: categorizeSacScale,
  };

  function segmentLength(seg) {
    if (typeof seg.length_m === "number" && seg.length_m > 0) return seg.length_m;
    let len = 0;
    const c = seg.coords || [];
    for (let i = 1; i < c.length; i++) {
      len += haversineM(c[i - 1][1], c[i - 1][0], c[i][1], c[i][0]);
    }
    return len;
  }

  function computeCategoryStats(segments, categorizer) {
    const totals = new Map();
    for (const seg of segments) {
      const cat = categorizer(parseWayTags(seg.properties));
      totals.set(cat, (totals.get(cat) || 0) + segmentLength(seg));
    }
    return Array.from(totals.entries())
      .map(([name, length_m]) => ({ name, length_m }))
      .sort((a, b) => b.length_m - a.length_m);
  }

  function fmtLength(m) {
    const km = m / 1000;
    if (km < 0.1) return "< 100 m";
    return AndromedaI18n.fmtNumber(km, km < 10 ? 2 : 1) + " km";
  }

  function renderCategoryStatsHtml(id, title, stats) {
    const head = `<h4 class="stats-block-title">${escapeHtml(title)}</h4>`;
    if (!stats.length) {
      return `<div class="stats-block" id="${id}">${head}
        <div class="stats-empty">${escapeHtml(t("ways.noData"))}</div></div>`;
    }
    const max = stats[0].length_m;
    const rows = stats.map((item, idx) => {
      const pct = max > 0 ? (item.length_m / max) * 100 : 0;
      return `<div class="stats-row" data-cat-id="${id}-${idx}" data-cat-name="${escapeHtml(item.name)}">
          <div class="stats-row-name">${escapeHtml(categoryLabel(item.name))}:</div>
          <div class="stats-row-bar">
            <div class="stats-row-fill" style="width:${pct.toFixed(1)}%; background:${getCategoryColor(item.name)};"></div>
          </div>
          <div class="stats-row-len">${fmtLength(item.length_m)}</div>
        </div>`;
    }).join("");
    return `<div class="stats-block" id="${id}">${head}${rows}</div>`;
  }

  /* HTML aller Blöcke. SAC-Block nur, wenn echte SAC-Daten da sind. */
  function renderHtml(tagSegments) {
    const way = computeCategoryStats(tagSegments, categorizeWayType);
    const surf = computeCategoryStats(tagSegments, categorizeSurface);
    const sac = computeCategoryStats(tagSegments, categorizeSacScale);
    let html = renderCategoryStatsHtml("wayStatsBlock", t("ways.wayTypes"), way) +
               renderCategoryStatsHtml("surfStatsBlock", t("ways.surfaces"), surf);
    if (sac.some(s => s.name !== NO_SAC)) {
      html += renderCategoryStatsHtml("sacStatsBlock", t("ways.sac"), sac);
    }
    return html;
  }

  /* Zeichnet alle Abschnitte der Kategorie catName in layerGroup.
   * Aufeinanderfolgende Segmente derselben Kategorie werden zu einer
   * durchgehenden Linie verbunden, damit an Kreuzungen keine Lücken
   * entstehen. Liefert true, wenn etwas gefunden wurde. */
  function highlightOnMap(map, layerGroup, tagSegments, catId, catName, routeColor) {
    if (layerGroup) layerGroup.clearLayers();
    const blockId = Object.keys(CATEGORIZERS).find(k => catId.startsWith(k));
    if (!blockId) return false;
    const categorizer = CATEGORIZERS[blockId];

    let found = 0;
    let group = [];
    const lineOpts = { opacity: 1, lineJoin: "round", lineCap: "round", interactive: false };

    const flushGroup = () => {
      if (group.length >= 2) {
        const latlngs = group.map(c => [c[1], c[0]]);
        L.polyline(latlngs, Object.assign({ color: routeColor, weight: 12 }, lineOpts)).addTo(layerGroup);
        L.polyline(latlngs, Object.assign({ color: "#ffffff", weight: 5 }, lineOpts)).addTo(layerGroup);
        found++;
      }
      group = [];
    };

    for (const seg of tagSegments) {
      if (!seg.coords || seg.coords.length < 2) continue;
      if (categorizer(parseWayTags(seg.properties)) !== catName) {
        flushGroup();
        continue;
      }
      if (group.length > 0) {
        const last = group[group.length - 1];
        const first = seg.coords[0];
        // Toleranz ca. 1–2 m für Rundungsfehler
        const gap = Math.abs(last[0] - first[0]) + Math.abs(last[1] - first[1]);
        if (gap < 0.00005) {
          group.push(...seg.coords.slice(1));
          continue;
        }
        flushGroup();
      }
      group = [...seg.coords];
    }
    flushGroup();
    return found > 0;
  }

  /* Mobil das Menü schließen (die Karte liegt sonst darunter) und so
   * zoomen, dass alle hervorgehobenen Wege sichtbar sind. */
  function showOnMap(map, layer) {
    const mobile = window.matchMedia && window.matchMedia("(max-width: 900px)").matches;
    // Navigator: Menü ist auch am Desktop ein Dialog über der Karte
    const overMap = mobile || !!document.querySelector("#panel.show");
    if (overMap && typeof window.closePanel === "function") window.closePanel();
    const bounds = layer.getBounds && layer.getBounds();
    if (!bounds || !bounds.isValid()) return;
    // nach dem Schließen, damit die Kartengröße stimmt
    setTimeout(() => {
      map.invalidateSize();
      map.fitBounds(bounds, { padding: mobile ? [50, 50] : [60, 60], maxZoom: 17, animate: true });
    }, overMap ? 60 : 0);
  }

  /* Klick-Hervorhebung für eine Seite. Die Seite liefert über die
   * Getter, wo Karte, Layer, Segmente und Farbe gerade liegen. */
  function createHighlighter({ getMap, getLayer, getSegments, getColor }) {
    let activeId = null;

    function clear() {
      const layer = getLayer();
      if (layer) layer.clearLayers();
      activeId = null;
      document.querySelectorAll(".stats-row.active").forEach(r => r.classList.remove("active"));
    }

    function toggle(catId, catName) {
      if (activeId === catId) { clear(); return; }
      clear();
      const map = getMap();
      const segments = getSegments();
      const layer = getLayer();
      if (!map || !layer || !segments || !segments.length) return;
      const found = highlightOnMap(map, layer, segments, catId, catName, getColor());
      if (found) {
        activeId = catId;
        const row = document.querySelector(`.stats-row[data-cat-id="${catId}"]`);
        if (row) row.classList.add("active");
        showOnMap(map, layer);
      } else {
        clear();
        if (window.AndromedaToast) AndromedaToast.show(t("ways.noneFound"), "warn");
      }
    }

    return { toggle, clear };
  }

  /* Statistik in container rendern und Zeilen klickbar machen.
   * collapsible: true → einklappbarer Abschnitt mit Knopf
   * „Wege & Oberflächenstatistik“ (zu Beginn eingeklappt). */
  function mount(container, segments, highlighter, opts) {
    opts = opts || {};
    if (opts.collapsible) {
      container.innerHTML = `
        <button type="button" class="btn-full stats-toggle">
          <span>${escapeHtml(t("ways.title"))}</span>
          <span class="stats-toggle-icon">▼</span>
        </button>
        <div class="stats-content" hidden>${renderHtml(segments)}</div>`;
      const content = container.querySelector(".stats-content");
      const icon = container.querySelector(".stats-toggle-icon");
      container.querySelector(".stats-toggle").addEventListener("click", () => {
        content.hidden = !content.hidden;
        icon.textContent = content.hidden ? "▼" : "▲";
      });
    } else {
      container.innerHTML = renderHtml(segments);
    }
    container.querySelectorAll(".stats-row").forEach(row => {
      row.addEventListener("click", () => {
        if (highlighter) highlighter.toggle(row.dataset.catId, row.dataset.catName);
      });
    });
    return container;
  }

  window.AndromedaWayStats = {
    parseWayTags,
    categorizeWayType,
    categorizeSurface,
    categorizeSacScale,
    categoryLabel,
    computeCategoryStats,
    renderCategoryStatsHtml,
    renderHtml,
    highlightOnMap,
    createHighlighter,
    mount,
  };
})();
