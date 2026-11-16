/* ============================================================
 * AndromedaExplorer — Höhenprofil
 * Data-Compute, Chart-Zeichnung, Legende, Hover-Interaktion.
 * Die Seite hält die Daten selbst (state.elevationData), dieses
 * Modul rechnet und zeichnet.
 * ============================================================ */
(function () {
  const COLOR_GOOD = "#2e8b57", COLOR_OK = "#8bc34a", COLOR_MEDIUM = "#f9a825",
        COLOR_STEEP = "#e65100", COLOR_VERY = "#c0392b";

  const AndromedaElevation = {
    COLOR: { GOOD: COLOR_GOOD, OK: COLOR_OK, MEDIUM: COLOR_MEDIUM, STEEP: COLOR_STEEP, VERY: COLOR_VERY },

    slopeColor(pct, activity) {
      const isCycling = activity === "cycling";
      if (isCycling && pct < 0) {
        const a = -pct;
        if (a < 8) return COLOR_GOOD;
        if (a < 15) return COLOR_OK;
        if (a < 25) return COLOR_MEDIUM;
        if (a < 35) return COLOR_STEEP;
        return COLOR_VERY;
      }
      if (isCycling) {
        if (pct < 2) return COLOR_GOOD;
        if (pct < 4) return COLOR_OK;
        if (pct < 7) return COLOR_MEDIUM;
        if (pct < 12) return COLOR_STEEP;
        return COLOR_VERY;
      }
      const a = Math.abs(pct);
      if (a < 5) return COLOR_GOOD;
      if (a < 10) return COLOR_OK;
      if (a < 15) return COLOR_MEDIUM;
      if (a < 25) return COLOR_STEEP;
      return COLOR_VERY;
    },

    /* Kumulierter Anstieg/Abstieg. Rechnet über AndromedaUtils, damit
     * Höhenprofil und Übersicht dieselbe Methode verwenden. */
    computeAscentDescent(elevations) {
      return AndromedaUtils.ascentDescent(elevations);
    },

    /* coords = Array [lon, lat, ele?]. Liefert null, wenn keine Höhen. */
    computeData(coords) {
      if (!coords || coords.length < 2) return null;
      const H = AndromedaUtils.haversineM;
      const distances = [0];
      let cumDist = 0;
      const elevations = [];
      for (let i = 0; i < coords.length; i++) {
        const c = coords[i];
        elevations.push(c.length >= 3 && isFinite(c[2]) ? c[2] : null);
        if (i > 0) {
          cumDist += H(coords[i-1][1], coords[i-1][0], c[1], c[0]);
          distances.push(cumDist);
        }
      }
      if (!elevations.some(e => e != null)) return null;
      return { distances, elevations };
    },

    /* Zeichnet das Chart in das Canvas. Liefert die Chart-Punkte. */
    drawChart(canvas, data, activity, opts) {
      opts = opts || {};
      if (!canvas || !data) return null;
      const wrap = canvas.parentElement;
      const rect = (wrap && wrap.getBoundingClientRect)
      ? wrap.getBoundingClientRect()
      : { width: 400, height: 180 };
      const dpr = window.devicePixelRatio || 1;
      const W = opts.forceWidth || rect.width || 400;
      const H = opts.forceHeight || rect.height || 180;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      const ctx = canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);

      const pad = opts.pad || { top: 16, right: 16, bottom: 26, left: 54 };
      const chartW = W - pad.left - pad.right;
      const chartH = H - pad.top - pad.bottom;
      const { distances, elevations } = data;
      const validElev = elevations.filter(e => e != null);
      const minElev = Math.min(...validElev);
      const maxElev = Math.max(...validElev);
      const elevRange = (maxElev - minElev) || 1;
      const maxDist = distances[distances.length - 1] || 1;

      const isDark = !opts.forceLight && document.body.classList.contains("dark");
      const bgCol = isDark ? "#1a1d21" : "#fafbfc";
      const gridCol = isDark ? "#2a3036" : "#e2e6ea";
      const gridCol2 = isDark ? "#23282d" : "#f0f2f5";
      const textCol = isDark ? "#9aa0a6" : "#667085";

      ctx.fillStyle = bgCol; ctx.fillRect(0, 0, W, H);

      // Y-Achse
      const fontSize = opts.fontSize || 10;
      const lineWidth = opts.lineWidth || 2.5;
      const markerRadius = opts.markerRadius || 3.5;
      ctx.strokeStyle = gridCol; ctx.lineWidth = 1;
      ctx.font = `${fontSize}px -apple-system, sans-serif`;
      ctx.fillStyle = textCol;
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      const nLines = 4;
      for (let i = 0; i <= nLines; i++) {
        const y = pad.top + (chartH / nLines) * i;
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
        const val = maxElev - (elevRange / nLines) * i;
        ctx.fillText(Math.round(val) + " m", pad.left - 6, y);
      }

      // X-Achse
      ctx.textBaseline = "top";
      const nX = 5;
      for (let i = 0; i <= nX; i++) {
        // Rand-Beschriftungen bündig, damit „0 m“ und die Gesamtlänge
        // nicht über den Rand hinausragen.
        ctx.textAlign = i === 0 ? "left" : (i === nX ? "right" : "center");
        const x = pad.left + (chartW / nX) * i;
        const d = (maxDist / nX) * i;
        ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + chartH);
        ctx.strokeStyle = gridCol2; ctx.stroke();
        ctx.fillStyle = textCol;
        const label = d >= 1000 ? (d / 1000).toFixed(1) + " km" : Math.round(d) + " m";
        ctx.fillText(label, x, H - pad.bottom + 6);
      }

      // Chart-Punkte
      const chartPoints = [];
      for (let i = 0; i < elevations.length; i++) {
        if (elevations[i] == null) continue;
        const x = pad.left + (distances[i] / maxDist) * chartW;
        const y = pad.top + chartH - ((elevations[i] - minElev) / elevRange) * chartH;
        chartPoints.push({ x, y, dist: distances[i], elev: elevations[i], index: i });
      }
      if (!chartPoints.length) return null;

      // Füllung
      const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
      grad.addColorStop(0, "rgba(42, 111, 191, 0.18)");
      grad.addColorStop(1, "rgba(42, 111, 191, 0.01)");
      ctx.beginPath();
      ctx.moveTo(chartPoints[0].x, chartPoints[0].y);
      for (let i = 1; i < chartPoints.length; i++) ctx.lineTo(chartPoints[i].x, chartPoints[i].y);
      ctx.lineTo(chartPoints[chartPoints.length - 1].x, pad.top + chartH);
      ctx.lineTo(chartPoints[0].x, pad.top + chartH);
      ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();

      // Linie, segmentweise nach Steigungsfarbe
      ctx.lineWidth = lineWidth; ctx.lineJoin = "round"; ctx.lineCap = "round";
      for (let i = 1; i < chartPoints.length; i++) {
        const prev = chartPoints[i - 1], cur = chartPoints[i];
        const dx = cur.dist - prev.dist, dy = cur.elev - prev.elev;
        const pct = dx > 0 ? (dy / dx) * 100 : 0;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(cur.x, cur.y);
        ctx.strokeStyle = AndromedaElevation.slopeColor(pct, activity);
        ctx.stroke();
      }

      // Min/Max-Marker
      let maxIdx = 0, minIdx = 0;
      for (let i = 0; i < chartPoints.length; i++) {
        if (chartPoints[i].y < chartPoints[maxIdx].y) maxIdx = i;
        if (chartPoints[i].y > chartPoints[minIdx].y) minIdx = i;
      }
      ctx.beginPath(); ctx.arc(chartPoints[maxIdx].x, chartPoints[maxIdx].y, markerRadius, 0, Math.PI * 2);
      ctx.fillStyle = "#2e8b57"; ctx.fill();
      ctx.beginPath(); ctx.arc(chartPoints[minIdx].x, chartPoints[minIdx].y, markerRadius, 0, Math.PI * 2);
      ctx.fillStyle = "#c0392b"; ctx.fill();

      const ad = AndromedaElevation.computeAscentDescent(elevations);
      return {
        chartPoints, pad, chartH, minElev, maxElev, maxDist,
        ascent: ad.ascent, descent: ad.descent,
      };
    },

    /* Legende aktualisieren. activity = "hiking" | "cycling" | "running". */
    updateLegend(legendEl, activity) {
      if (!legendEl) return;
      const C = AndromedaElevation.COLOR;
      const ranges = activity === "cycling"
        ? ["<2 %", "2–4 %", "4–7 %", "7–12 %", ">12 %"]
        : ["<5 %", "5–10 %", "10–15 %", "15–25 %", ">25 %"];
      const items = [
        [C.GOOD, "elev.flat"], [C.OK, "elev.easy"], [C.MEDIUM, "elev.medium"],
        [C.STEEP, "elev.steep"], [C.VERY, "elev.verySteep"],
      ];
      const esc = AndromedaUtils.escapeHtml;
      legendEl.innerHTML = `<span class="legend-title">${esc(t("elev.slope"))}:</span>` +
        items.map(([color, key], i) =>
          `<span class="li"><span class="sw" style="background:${color}"></span>${esc(t(key))} (${esc(ranges[i])})</span>`
        ).join("");
    },

    /* Hover-Interaktion auf dem Chart anbinden.
     * opts = { canvas, tooltip, getData, onRedraw, onIndex, onLeave }
     * onRedraw: zeichnet das Chart neu (vor dem Hover-Overlay).
     * onIndex(coordIndex): optionale Karte-Marker-Aktualisierung. */
    bindHover(opts) {
      const { canvas, tooltip, getData, onRedraw, onIndex, onLeave } = opts;
      if (!canvas) return;

      function handler(e) {
        const data = getData();
        if (!data || !data.chartPoints) return;
        const rect = canvas.getBoundingClientRect();
        let clientX;
        if (e.touches && e.touches.length) clientX = e.touches[0].clientX;
        else if (e.changedTouches && e.changedTouches.length) clientX = e.changedTouches[0].clientX;
        else clientX = e.clientX;
        const mouseX = clientX - rect.left;
        const pts = data.chartPoints;
        let nearest = pts[0], minDx = Math.abs(pts[0].x - mouseX);
        for (let i = 1; i < pts.length; i++) {
          const dx = Math.abs(pts[i].x - mouseX);
          if (dx < minDx) { minDx = dx; nearest = pts[i]; }
        }
        const idx = pts.indexOf(nearest);
        const prev = pts[Math.max(0, idx - 1)];
        const next = pts[Math.min(pts.length - 1, idx + 1)];
        const dx = next.dist - prev.dist, dy = next.elev - prev.elev;
        const slope = dx > 0 ? (dy / dx) * 100 : 0;

        onRedraw && onRedraw();
        const ctx = canvas.getContext("2d");
        const dpr = window.devicePixelRatio || 1;
        ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const { pad, chartH } = data;
        ctx.beginPath();
        ctx.moveTo(nearest.x, pad.top);
        ctx.lineTo(nearest.x, pad.top + chartH);
        ctx.strokeStyle = "rgba(255, 107, 53, 0.55)";
        ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
        ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(nearest.x, nearest.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#ff6b35"; ctx.fill();
        ctx.strokeStyle = "white"; ctx.lineWidth = 2; ctx.stroke();
        ctx.restore();

        if (tooltip) {
          const distLabel = nearest.dist >= 1000
            ? (nearest.dist / 1000).toFixed(2) + " km"
            : Math.round(nearest.dist) + " m";
          tooltip.innerHTML = `${distLabel} · ${Math.round(nearest.elev)} m · ${AndromedaUtils.fmtSlope(slope)}`;
          tooltip.classList.add("show");
          const ttRect = tooltip.getBoundingClientRect();
          let tx = nearest.x + 10;
          let ty = nearest.y - ttRect.height - 8;
          if (tx + ttRect.width > rect.width) tx = rect.width - ttRect.width - 10;
          if (ty < 4) ty = nearest.y + 10;
          tooltip.style.left = tx + "px";
          tooltip.style.top = ty + "px";
        }
        onIndex && onIndex(nearest.index);
      }

      function leave() {
        if (tooltip) tooltip.classList.remove("show");
        onLeave && onLeave();
      }

      canvas.addEventListener("mousemove", handler);
      canvas.addEventListener("mouseleave", leave);
      canvas.addEventListener("touchstart", handler, { passive: true });
      canvas.addEventListener("touchmove", handler, { passive: true });
      canvas.addEventListener("touchend", leave);
    },
  };

  /* ------------------------------------------------------------
   * Höhenprofil-Panel einer Seite
   *
   * Erwartet im HTML: #elevPanel, #elevChart, #elevTooltip,
   * #elevStats, #slopeLegend und optional die Knöpfe #elevBtn
   * (Desktop, mit Text) und #elevBtnM (Mobile, Icon).
   *
   * Der Zustand liegt im übergebenen state-Objekt der Seite:
   *   state.elevationData  { distances, elevations, coords, activity, … }
   *   state.elevationOpen  boolean
   * Damit bleibt bestehender Seitencode, der diese Felder liest, gültig.
   *
   * opts = {
   *   state,                      Pflicht
   *   getMap: () => map,          Pflicht (für Hover-Marker/Resize)
   *   getActivity: () => "…",     optional, sonst data.activity
   *   hasData: () => bool,        optional (z. B. Navigator: Tour ODER Zustieg)
   *   onIndex(i), onLeave()       optional: eigenes Hover-Verhalten
   *   markerClass, markerSize     Hover-Marker (Standard "hover-marker", 16)
   *   extraButtons: ["id", …]     weitere Knöpfe mit Textlabel
   * }
   * ------------------------------------------------------------ */
  AndromedaElevation.createPanel = function (opts) {
    const state = opts.state;
    const $ = id => document.getElementById(id);
    const getMap = opts.getMap;
    const markerClass = opts.markerClass || "hover-marker";
    const markerSize = opts.markerSize || 16;
    let hoverMarker = null;

    const activity = () =>
      (opts.getActivity && opts.getActivity()) ||
      (state.elevationData && state.elevationData.activity) || "hiking";
    const hasData = () => (opts.hasData ? opts.hasData() : !!state.elevationData);

    function invalidateMapSoon() {
      setTimeout(() => { const m = getMap(); if (m) m.invalidateSize(); }, 80);
    }

    function updateButtons() {
      const enabled = hasData();
      const label = state.elevationOpen ? t("elev.hide") : t("elev.show");
      const eb = $("elevBtn");
      if (eb) {
        eb.disabled = !enabled;
        eb.classList.toggle("active", !!state.elevationOpen);
        if (eb.dataset.iconOnly == null) eb.textContent = label;
      }
      const ebm = $("elevBtnM");
      if (ebm) {
        ebm.disabled = !enabled;
        ebm.classList.toggle("active", !!state.elevationOpen);
      }
      for (const id of opts.extraButtons || []) {
        const b = $(id);
        if (b) { b.disabled = !enabled; b.textContent = label; }
      }
    }

    function redraw() {
      const data = state.elevationData;
      if (!data) return;
      const result = AndromedaElevation.drawChart($("elevChart"), data, activity());
      if (result) {
        Object.assign(data, result);
        const stats = $("elevStats");
        if (stats) {
          stats.textContent = `· ↑ ${Math.round(result.ascent)} m · max ${Math.round(result.maxElev)} m`;
        }
      }
    }

    function clearMarker() {
      const map = getMap();
      if (hoverMarker && map) map.removeLayer(hoverMarker);
      hoverMarker = null;
    }

    function setMarker(coordIndex) {
      const data = state.elevationData;
      const map = getMap();
      if (!data || !data.coords || !map) return;
      const c = data.coords[coordIndex];
      if (!c) return;
      const latlng = [c[1], c[0]];
      if (hoverMarker) { hoverMarker.setLatLng(latlng); return; }
      const icon = L.divIcon({
        html: '<div class="dot"></div>', className: markerClass,
        iconSize: [markerSize, markerSize], iconAnchor: [markerSize / 2, markerSize / 2],
      });
      hoverMarker = L.marker(latlng, { icon, interactive: false, zIndexOffset: 5000 }).addTo(map);
    }

    function hideTooltip() {
      const tt = $("elevTooltip");
      if (tt) tt.classList.remove("show");
    }

    function show() {
      if (!state.elevationData) {
        if (window.AndromedaToast) AndromedaToast.show(t("elev.noData"), "error");
        return;
      }
      state.elevationOpen = true;
      $("elevPanel").classList.add("open");
      updateButtons();
      AndromedaElevation.updateLegend($("slopeLegend"), activity());
      requestAnimationFrame(() => requestAnimationFrame(redraw));
      invalidateMapSoon();
    }

    function hide() {
      state.elevationOpen = false;
      $("elevPanel").classList.remove("open");
      updateButtons();
      hideTooltip();
      clearMarker();
      if (opts.onLeave) opts.onLeave();
      invalidateMapSoon();
    }

    function toggle() {
      if (state.elevationOpen) hide();
      else show();
    }

    /* Neue Daten setzen (null = keine Höhendaten). coords werden für
     * den Hover-Marker gebraucht. */
    function setData(data) {
      state.elevationData = data || null;
      if (!data) {
        if (state.elevationOpen) hide();
        updateButtons();
        return;
      }
      updateButtons();
      if (state.elevationOpen) show();
    }

    /* Daten direkt aus Koordinaten [lon, lat, ele?] bauen. */
    function setCoords(coords, act) {
      const data = AndromedaElevation.computeData(coords);
      if (data) {
        data.coords = coords;
        data.activity = act || "hiking";
      }
      setData(data);
    }

    AndromedaElevation.bindHover({
      canvas: $("elevChart"),
      tooltip: $("elevTooltip"),
      getData: () => state.elevationData,
      onRedraw: redraw,
      onIndex: opts.onIndex || setMarker,
      onLeave: () => {
        hideTooltip();
        clearMarker();
        if (opts.onLeave) opts.onLeave();
        redraw();
      },
    });

    window.addEventListener("darkmodechange", () => { if (state.elevationOpen) redraw(); });
    window.addEventListener("andromeda:langchange", () => { if (state.elevationOpen) redraw(); });

    return { show, hide, toggle, redraw, updateButtons, setData, setCoords, clearMarker, setMarker };
  };

  window.AndromedaElevation = AndromedaElevation;
})();
