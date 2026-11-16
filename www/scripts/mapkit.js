/* ============================================================
 * AndromedaExplorer — Karten-Kit
 * Baut Karte, Basis-Layer, Overlays, Layer-Picker.
 * Voraussetzung: scripts/andromap.js (eigene Karten-Engine) ist geladen.
 * ============================================================ */
(function () {
  const AndromedaMap = {
    // Reihenfolge der Kachel-Ebenen: Grundkarte unten, Overlays darüber.
    Z_BASE: 1,
    Z_OVERLAY: 10,

    BASE_LAYERS: {
      osm: {
        label: "OpenStreetMap",
        // je nach Sprache: deutscher Stil (Beschriftung deutsch) oder der
        // internationale Standardstil von openstreetmap.org
        get url() { return AndromedaMap.osmUrl(); },
        options: {
          maxZoom: 19, crossOrigin: true,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        },
      },
      topo: {
        label: "OpenTopoMap",
        url: "https://tile.opentopomap.org/{z}/{x}/{y}.png",
        options: {
          maxZoom: 17,
          attribution: '&copy; OSM-Mitwirkende · <a href="https://opentopomap.org">OpenTopoMap</a>',
        },
      },
      cyclosm: {
        label: "CyclOSM",
        url: "https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png",
        options: {
          maxZoom: 20, subdomains: "abc",
          attribution: '&copy; OSM · CyclOSM',
        },
      },
    },
    OVERLAYS: {
      hiking: {
        label: "🟢 Wanderwege",
        url: "https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png",
        attribution: '&copy; Waymarked Trails',
      },
      cycling: {
        label: "🔵 Radwege",
        url: "https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png",
        attribution: '&copy; Waymarked Trails',
      },
    },

    /* OpenStreetMap-Kacheln passend zur Sprache.
     * Deutsch: Stil von openstreetmap.de (deutsche Namen und Beschriftung).
     * Englisch: Standardstil von openstreetmap.org. Ortsnamen sind dort
     * die örtlichen Namen (in Österreich also weiterhin deutsch) —
     * eine frei nutzbare OSM-Karte mit englischer Beschriftung gibt es nicht. */
    osmUrl(lang) {
      lang = lang || (window.AndromedaI18n ? AndromedaI18n.lang() : "de");
      return lang === "de"
        ? "https://tile.openstreetmap.de/{z}/{x}/{y}.png"
        : "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
    },
    /* OSM-Ebene beim Umschalten der Sprache mitwechseln. */
    followLanguage(layer, onChange) {
      window.addEventListener("andromeda:langchange", () => {
        if (onChange) onChange(layer);
        layer.setUrl(AndromedaMap.osmUrl());
      });
      return layer;
    },

    /* Karte erstellen. Gespeicherte Ansicht wird berücksichtigt. */
    createMap(containerId, fallbackCenter, fallbackZoom, extraOptions) {
      const key = (window.Andromeda && Andromeda.MAP_VIEW_KEY) || "andromeda_map_view_v1";
      let saved = null;
      try {
        const raw = localStorage.getItem(key);
        if (raw) saved = JSON.parse(raw);
      } catch (e) {}

      const opts = Object.assign({ zoomControl: true }, extraOptions || {});
      const map = L.map(containerId, opts);
      if (saved && typeof saved.lat === "number" && typeof saved.lng === "number") {
        map.setView([saved.lat, saved.lng], saved.zoom);
      } else {
        map.setView(fallbackCenter || [47.5, 11.0], fallbackZoom || 8);
      }

      L.control.scale({ metric: true, imperial: false, position: "bottomleft" }).addTo(map);
      return map;
    },

    /* Basis-Layer und Overlays anlegen (noch nicht hinzufügen). */
    createLayers() {
      const baseLayers = {};
      const overlayLayers = {};
      for (const [k, cfg] of Object.entries(AndromedaMap.BASE_LAYERS)) {
        baseLayers[k] = L.tileLayer(cfg.url, cfg.options);
      }
      AndromedaMap.followLanguage(baseLayers.osm);
      for (const [k, cfg] of Object.entries(AndromedaMap.OVERLAYS)) {
        overlayLayers[k] = L.tileLayer(cfg.url, {
          maxZoom: 18, opacity: 0.9, attribution: cfg.attribution,
        });
      }
      return { baseLayers, overlayLayers };
    },

    /* Kartenansicht speichern (bei jeder moveend/zoomend). */
    bindSaveView(map, key) {
      const k = key || (window.Andromeda && Andromeda.MAP_VIEW_KEY) || "andromeda_map_view_v1";
      const save = () => {
        if (!map) return;
        try {
          const c = map.getCenter();
          localStorage.setItem(k, JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
        } catch (e) {}
      };
      map.on("moveend zoomend", save);
      return save;
    },

    /* Layer-Picker im HTML (siehe Markup) an die Karte binden. */
    bindLayerPicker(map, baseLayers, overlayLayers, state, onChange) {
      const $ = id => document.getElementById(id);
      const $$ = sel => Array.from(document.querySelectorAll(sel));

      function updateUI() {
        $$("#layerPicker button[data-base]").forEach(b => {
          b.classList.toggle("active", state.activeBaseKey === b.dataset.base);
        });
        $$("#layerPicker button[data-overlay]").forEach(b => {
          b.classList.toggle("active", !!state.activeOverlays[b.dataset.overlay]);
        });
      }
      function setBase(key) {
        if (!baseLayers[key]) return;
        if (state.activeBaseLayer) map.removeLayer(state.activeBaseLayer);
        state.activeBaseLayer = baseLayers[key];
        // Grundkarte immer unter die Overlays legen. Ohne festen z-Index
        // landet eine neu hinzugefügte Grundkarte über den Wander-/Radwegen
        // und verdeckt sie, obwohl sie aktiv sind.
        state.activeBaseLayer.setZIndex(AndromedaMap.Z_BASE);
        state.activeBaseLayer.addTo(map);
        state.activeBaseKey = key;
        updateUI();
        onChange && onChange();
      }
      function toggleOverlay(key) {
        const layer = overlayLayers[key];
        if (!layer) return;
        if (state.activeOverlays[key]) {
          map.removeLayer(layer);
          state.activeOverlays[key] = false;
        } else {
          layer.setZIndex(AndromedaMap.Z_OVERLAY);
          layer.addTo(map);
          state.activeOverlays[key] = true;
        }
        updateUI();
        onChange && onChange();
      }

      $("layerBtn") && $("layerBtn").addEventListener("click", e => {
        e.stopPropagation();
        $("layerPicker").classList.toggle("show");
      });
      $$("#layerPicker button[data-base]").forEach(b => {
        b.addEventListener("click", () => {
          setBase(b.dataset.base);
          $("layerPicker").classList.remove("show");
        });
      });
      $$("#layerPicker button[data-overlay]").forEach(b => {
        b.addEventListener("click", () => {
          toggleOverlay(b.dataset.overlay);
          $("layerPicker").classList.remove("show");
        });
      });
      document.addEventListener("click", e => {
        if (!e.target.closest("#layerPicker") && !e.target.closest("#layerBtn")) {
          $("layerPicker").classList.remove("show");
        }
      });

      state.setBaseLayer = setBase;
      state.toggleOverlay = toggleOverlay;
      updateUI();
      return { setBase, toggleOverlay, updateUI };
    },

    /* Fokus-Button 🎯 auf Route. Callback liefert Koordinatenliste. */
    addFocusControl(map, getLatLngs) {
      const FocusControl = L.Control.extend({
        options: { position: "topleft" },
        onAdd() {
          const c = L.DomUtil.create("div", "leaflet-bar leaflet-control");
          const a = L.DomUtil.create("a", "", c);
          a.href = "#"; a.title = t("map.focus"); a.innerHTML = "🎯";
          a.style.cssText = "font-size:17px;line-height:26px;text-align:center;font-weight:bold;";
          a.onclick = e => {
            e.preventDefault();
            const latlngs = getLatLngs();
            if (!latlngs.length) return;
            if (latlngs.length === 1) {
              map.setView(latlngs[0], Math.max(map.getZoom(), 14), { animate: true });
            } else {
              map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], animate: true });
            }
          };
          L.DomEvent.disableClickPropagation(c);
          L.DomEvent.disableScrollPropagation(c);
          return c;
        },
      });
      new FocusControl().addTo(map);
    },

    /* Vollbild-Button ⛶ */
    addFullscreenControl(map, element) {
      const FullscreenControl = L.Control.extend({
        options: { position: "topleft" },
        onAdd() {
          const c = L.DomUtil.create("div", "leaflet-bar leaflet-control");
          const a = L.DomUtil.create("a", "", c);
          a.href = "#"; a.title = t("map.fullscreen"); a.innerHTML = "⛶";
          a.style.cssText = "font-size:19px;line-height:26px;text-align:center;font-weight:bold;";
          a.onclick = e => { e.preventDefault(); AndromedaMap.toggleFullscreen(element); };
          L.DomEvent.disableClickPropagation(c);
          L.DomEvent.disableScrollPropagation(c);
          return c;
        },
      });
      new FullscreenControl().addTo(map);
    },

    toggleFullscreen(el) {
      if (!document.fullscreenElement) {
        const fn = el.requestFullscreen || el.webkitRequestFullscreen;
        if (fn) fn.call(el);
      } else {
        const fn = document.exitFullscreen || document.webkitExitFullscreen;
        if (fn) fn.call(document);
      }
    },

    /* Skaliert ein Pfeil-Intervall mit der aktuellen Zoomstufe.
     *
     * REFERENCE_ZOOM = 14 ist die Bezugsstufe: bei diesem Zoom und
     * allem, was näher dran ist, bleibt `baseIntervalM` unverändert.
     * Erst beim Rauszoomen unter 14 wächst der Abstand — pro Schritt
     * verdoppelt (halbiert die Pfeilzahl). Obergrenze 20 000 m, damit
     * bei sehr weitem Zoom noch etwas sichtbar ist.
     *
     * Die Untergrenze 30 m greift nicht mehr, weil nach innen nicht
     * mehr skaliert wird — bleibt als Sicherheitsnetz für den Fall,
     * dass `baseIntervalM` versehentlich sehr klein übergeben wird.
     *
     * Wird von allen Seiten (Navigator, Routing, Editor, Viewer)
     * verwendet, damit sich das Verhalten überall gleich anfühlt. */
    arrowIntervalForZoom(baseIntervalM, zoom) {
      const REFERENCE_ZOOM = 14;
      // Nur nach außen skalieren: zoom < 14 → Faktor > 1,
      // zoom >= 14 → Faktor 1.
      const stepOut = Math.max(0, REFERENCE_ZOOM - zoom);
      const factor = Math.pow(2, stepOut);
      return Math.max(30, Math.min(20000, baseIntervalM * factor));
    },
  };

  /* ------------------------------------------------------------
   * Richtungspfeile entlang einer Route
   * ------------------------------------------------------------ */

  /* Standard-Abstand nach Routenlänge (wenn die Seite keinen vorgibt). */
  AndromedaMap.defaultArrowInterval = function (totalM) {
    if (totalM < 1500) return 300;
    if (totalM < 5000) return 700;
    if (totalM < 15000) return 1500;
    return 2500;
  };

  /* Kumulierte Distanz zu latlngs ([[lat, lng], …]) in Metern. */
  AndromedaMap.cumulativeDistance = function (latlngs) {
    const H = AndromedaUtils.haversineM;
    const cum = [0];
    for (let i = 1; i < latlngs.length; i++) {
      cum.push(cum[i - 1] + H(latlngs[i - 1][0], latlngs[i - 1][1], latlngs[i][0], latlngs[i][1]));
    }
    return cum;
  };

  /* Positionen der Pfeile im Abstand intervalM.
   * Liefert [{ lat, lng, bearing }]. Läuft in einem Durchgang über
   * die Route (früher pro Pfeil von vorne). */
  AndromedaMap.arrowPositions = function (latlngs, cumDist, intervalM) {
    const out = [];
    const n = latlngs.length;
    if (n < 3 || !(intervalM > 0)) return out;
    const total = cumDist[n - 1] || 0;
    let target = intervalM;
    let i = 1;
    while (target < total - intervalM * 0.4) {
      while (i < n && cumDist[i] < target) i++;
      if (i >= n) break;
      const segLen = cumDist[i] - cumDist[i - 1];
      const f = segLen > 0 ? (target - cumDist[i - 1]) / segLen : 0;
      const lat = latlngs[i - 1][0] + f * (latlngs[i][0] - latlngs[i - 1][0]);
      const lng = latlngs[i - 1][1] + f * (latlngs[i][1] - latlngs[i - 1][1]);
      let j = Math.min(i + 3, n - 1);
      if (j === i) j = Math.min(i + 1, n - 1);
      out.push({ lat, lng, bearing: AndromedaUtils.bearing(lat, lng, latlngs[j][0], latlngs[j][1]) });
      target += intervalM;
    }
    return out;
  };

  /* Pfeil-Icon (gedreht nach bearing). */
  /* Nummerierter Wegpunkt-Marker (Navigator und Viewer gleich). */
  AndromedaMap.waypointMarker = function (latlng, number, name) {
    const size = 22;
    const html = `<div class="wp-num-marker" style="width:${size}px;height:${size}px;line-height:${size - 5}px;">${number}</div>`;
    const icon = L.divIcon({ html, className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    const m = L.marker(latlng, { icon, title: name || "" });
    const label = name || (window.AndromedaI18n ? AndromedaI18n.t("wp.default") : "Wegpunkt");
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    m.bindTooltip(esc(label), { direction: "right", offset: [12, 0] });
    return m;
  };

  AndromedaMap.arrowIcon = function (bearingDeg, size, color) {
    size = size || 24;
    color = color || "#1e5ac8";
    const html = `<div style="transform: rotate(${bearingDeg}deg); width:${size}px; height:${size}px;">` +
      `<svg viewBox="0 0 24 24" style="width:100%;height:100%;display:block;">` +
      `<polygon points="12,2 18,20 12,16 6,20" fill="${color}" stroke="white" stroke-width="1.6" stroke-linejoin="round"/>` +
      `</svg></div>`;
    return L.divIcon({
      html, className: "route-arrow",
      iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    });
  };

  /* Pfeile in layer zeichnen (layer wird vorher geleert).
   * opts: { map, baseInterval, cumDist, size, color, minTotal }
   *   baseInterval: Abstand bei Zoom ≥ 14; fehlt er, wird er aus der
   *                 Routenlänge bestimmt. Beim Rauszoomen wird er über
   *                 arrowIntervalForZoom() vergrößert.
   *   minTotal:     kürzere Routen bekommen keine Pfeile (Standard 100 m) */
  AndromedaMap.drawArrows = function (layer, latlngs, opts) {
    if (!layer) return;
    layer.clearLayers();
    opts = opts || {};
    if (!latlngs || latlngs.length < 3) return;
    const cumDist = opts.cumDist || AndromedaMap.cumulativeDistance(latlngs);
    const total = cumDist[cumDist.length - 1] || 0;
    if (total < (opts.minTotal != null ? opts.minTotal : 100)) return;
    const base = opts.baseInterval || AndromedaMap.defaultArrowInterval(total);
    const zoom = opts.map ? opts.map.getZoom() : 14;
    const interval = AndromedaMap.arrowIntervalForZoom(base, zoom);
    for (const a of AndromedaMap.arrowPositions(latlngs, cumDist, interval)) {
      layer.addLayer(L.marker([a.lat, a.lng], {
        icon: AndromedaMap.arrowIcon(a.bearing, opts.size, opts.color),
        interactive: false,
        rotateWithMap: true,   // Richtung bezieht sich auf die Karte, nicht den Bildschirm
      }));
    }
  };

  /* fn nach dem Zoomen ausführen, kurz entprellt (Scroll-Zoom löst
   * sonst bei jedem Schritt aus). */
  AndromedaMap.onZoomDebounced = function (map, fn, delayMs) {
    let timer = null;
    map.on("zoomend", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; fn(); }, delayMs || 120);
    });
  };

  window.AndromedaMap = AndromedaMap;
})();
