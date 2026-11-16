/* ============================================================
 * AndromedaExplorer — Utilities
 * Formatierungen, Geometrie, IDs, Dateinamen
 * ============================================================ */
(function () {
  const R_EARTH = 6371000;

  const AndromedaUtils = {
    $: id => document.getElementById(id),
    $$: sel => Array.from(document.querySelectorAll(sel)),

    escapeHtml(s) {
      return String(s ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;",
        '"': "&quot;", "'": "&#39;",
      }[c]));
    },
    escapeXml(s) {
      return String(s).replace(/[<>&'"]/g, c => ({
        "<": "&lt;", ">": "&gt;", "&": "&amp;",
        "'": "&apos;", '"': "&quot;",
      }[c]));
    },

    fmtDistance(m) {
      if (m == null) return "—";
      return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m";
    },
    /* Kennzahlen für die untere Leiste (Navigator, Viewer):
     * Strecke, Anstieg, Abstieg, Dauer — gleiche Optik auf beiden Seiten. */
    barStatsHtml(stats, durationText) {
      stats = stats || {};
      const esc = AndromedaUtils.escapeHtml;
      const cells = [];
      if (stats.distance_m != null) cells.push([AndromedaUtils.fmtDistance(stats.distance_m), "Strecke"]);
      if (stats.ascent_m) cells.push([Math.round(stats.ascent_m) + " m", "Anstieg"]);
      if (stats.descent_m) cells.push([Math.round(stats.descent_m) + " m", "Abstieg"]);
      if (durationText) cells.push([durationText, "Dauer"]);
      return cells.map(([v, l]) =>
        `<div class="bs"><span class="bs-v">${esc(v)}</span><span class="bs-l">${esc(l)}</span></div>`).join("");
    },
    fmtElevation(m) { return m == null ? "—" : Math.round(m) + " m"; },
    fmtDuration(s) {
      if (s == null || !isFinite(s) || s <= 0) return "—";
      const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
      if (h > 0 && m > 0) return `${h} h ${m} min`;
      if (h > 0) return `${h} h`;
      return `${m} min`;
    },
    fmtSlope(p) {
      if (p == null || !isFinite(p)) return "—";
      return `${p >= 0 ? "+" : ""}${p.toFixed(1)} %`;
    },

    haversineM(lat1, lon1, lat2, lon2) {
      const toRad = Math.PI / 180;
      const dphi = (lat2 - lat1) * toRad;
      const dlam = (lon2 - lon1) * toRad;
      const a = Math.sin(dphi / 2) ** 2 +
        Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dlam / 2) ** 2;
      return 2 * R_EARTH * Math.asin(Math.sqrt(a));
    },
    bearing(lat1, lon1, lat2, lon2) {
      const toRad = Math.PI / 180;
      const phi1 = lat1 * toRad, phi2 = lat2 * toRad;
      const dlon = (lon2 - lon1) * toRad;
      const x = Math.sin(dlon) * Math.cos(phi2);
      const y = Math.cos(phi1) * Math.sin(phi2) -
                Math.sin(phi1) * Math.cos(phi2) * Math.cos(dlon);
      return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
    },

    /* Kumulierter Anstieg/Abstieg aus einer Höhenreihe (Einträge
     * dürfen null sein). 3-Punkte-Glättung nach Punktindex und
     * 1-m-Schwelle. Das ist DIE Höhenmeter-Methode des Projekts —
     * Übersicht, Höhenprofil und Statistik rechnen alle hiermit,
     * damit überall dieselben Werte stehen. */
    ascentDescent(elevations) {
      const smoothed = elevations.map((e, i) => {
        if (e == null) return null;
        let sum = 0, count = 0;
        const from = Math.max(0, i - 1);
        const to = Math.min(elevations.length - 1, i + 1);
        for (let j = from; j <= to; j++) {
          const v = elevations[j];
          if (v != null) { sum += v; count++; }
        }
        return count > 0 ? sum / count : e;
      });
      const THRESHOLD = 1.0;
      let asc = 0, desc = 0, ref = null;
      for (const e of smoothed) {
        if (e == null) continue;
        if (ref == null) { ref = e; continue; }
        const d = e - ref;
        if (d >= THRESHOLD) { asc += d; ref = e; }
        else if (d <= -THRESHOLD) { desc -= d; ref = e; }
      }
      return { ascent: asc, descent: desc };
    },

    uuid() {
      if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
      const b = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
    },

    sanitizeFilename(s) {
      let out = String(s || "").trim();
      out = out.replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "_");
      out = out.replace(/_+/g, "_").replace(/\s+/g, "_");
      out = out.replace(/^[._]+|[._]+$/g, "");
      if (!out) out = "datei";
      return out.slice(0, 100);
    },

    timestampSlug() {
      const d = new Date(), pad = n => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    },
  };
  /* ============================================================
   * Geolocation
   *
   * Normalfall (Chrome, Safari, Edge …): enableHighAccuracy:true,
   * es werden nur Positionen akzeptiert, deren vom Browser gemeldete
   * Genauigkeit auf GPS hindeutet. Netzwerk-Positionen (typisch
   * 300–5000 m) werden verworfen.
   *
   * Firefox auf Android: enableHighAccuracy:true ist dort defekt —
   * Firefox wählt häufig den Netzwerk-Provider an und liefert dann
   * gar keine Position mehr. Deshalb wird für Firefox
   * enableHighAccuracy:false gesetzt und eine größere Toleranz
   * akzeptiert. Firefox liefert dann Positionen mit typisch
   * 100–500 m Genauigkeit. Das reicht für die Tourenplanung und
   * für die Standortanzeige im Viewer.
   * ============================================================ */
  const GPS_MAX_ACCURACY_M = 100;
  const FIREFOX_MAX_ACCURACY_M = 5000;

  const IS_FIREFOX = /firefox/i.test(navigator.userAgent);

  function isGpsFix(acc) {
    return typeof acc === "number"
    && isFinite(acc)
    && acc > 0
    && acc <= GPS_MAX_ACCURACY_M;
  }

  // Firefox: alles bis FIREFOX_MAX_ACCURACY_M ist brauchbar.
  // Andere Browser: nur echte GPS-Fixes.
  function isAcceptableFix(acc) {
    if (typeof acc !== "number" || !isFinite(acc) || acc <= 0) return false;
    if (IS_FIREFOX) return acc <= FIREFOX_MAX_ACCURACY_M;
    return acc <= GPS_MAX_ACCURACY_M;
  }

  /* Einmalige Positionsabfrage.
   *
   * Rückgabe: Promise, das mit einem Position-Objekt auflöst.
   * Rejection trägt einen error.code:
   *   "not-supported"     Geolocation-API fehlt
   *   "permission-denied" Nutzer hat den Zugriff verweigert
   *   "no-gps"            kein brauchbarer Fix innerhalb maxWaitMs
   */
  function getGpsPosition(opts) {
    opts = opts || {};
    const maxWaitMs = opts.maxWaitMs != null ? opts.maxWaitMs : 15000;
    const targetAccuracy = opts.targetAccuracy != null
    ? opts.targetAccuracy
    : (IS_FIREFOX ? FIREFOX_MAX_ACCURACY_M : 60);

    return new Promise((resolve, reject) => {
      if (!("geolocation" in navigator)) {
        const e = new Error(t("geo.notSupported"));
        e.code = "not-supported";
        reject(e); return;
      }

      let watchId = null;
      let best = null;
      let settled = false;

      function finish(pos, err) {
        if (settled) return;
        settled = true;
        if (watchId != null) {
          try { navigator.geolocation.clearWatch(watchId); } catch (e) {}
          watchId = null;
        }
        if (pos) resolve(pos);
        else reject(err);
      }

      const timer = setTimeout(() => {
        if (best) finish(best);
        else {
          const e = new Error(IS_FIREFOX ? t("geo.noPosition") : t("geo.noGps"));
          e.code = "no-gps";
          finish(null, e);
        }
      }, maxWaitMs);

      try {
        watchId = navigator.geolocation.watchPosition(
          (pos) => {
            const acc = pos.coords.accuracy;
            if (!isAcceptableFix(acc)) return;
            if (acc <= targetAccuracy) {
              clearTimeout(timer);
              finish(pos);
            } else if (!best || acc < best.coords.accuracy) {
              best = pos;
            }
          },
          (err) => {
            if (err && err.code === 1) {
              clearTimeout(timer);
              const e = new Error(t("geo.denied"));
              e.code = "permission-denied";
              finish(null, e);
            }
            // Andere Fehler ignorieren und weiter warten.
          },
          {
            enableHighAccuracy: !IS_FIREFOX,
            maximumAge: 0,
            timeout: 12000,
          }
        );
      } catch (e) {
        clearTimeout(timer);
        finish(null, e);
      }
    });
  }

  AndromedaUtils.GPS_MAX_ACCURACY_M = GPS_MAX_ACCURACY_M;
  AndromedaUtils.FIREFOX_MAX_ACCURACY_M = FIREFOX_MAX_ACCURACY_M;
  AndromedaUtils.IS_FIREFOX = IS_FIREFOX;
  AndromedaUtils.isGpsFix = isGpsFix;
  AndromedaUtils.isAcceptableFix = isAcceptableFix;
  AndromedaUtils.getGpsPosition = getGpsPosition;

  window.AndromedaUtils = AndromedaUtils;
})();
