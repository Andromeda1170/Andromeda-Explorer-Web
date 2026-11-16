/* ============================================================
 * AndromedaExplorer — Anfahrt-Dialog
 * AndromedaDirections.open(lat, lon, { note })
 *   Öffnet den Dialog „Anfahrt zum Startpunkt“ mit Links zu
 *   Google Maps (Auto/Öffis) und OpenStreetMap (Auto).
 *   note: optionaler Hinweistext unten (Standard: Hinweis auf den
 *   Navigator).
 * AndromedaDirections.close(), .isOpen()
 *
 * Das DOM wird beim ersten Öffnen erzeugt (Stil des Wegpunkt-Sheets,
 * .wp-backdrop / .wpd-inner). Escape und Klick auf den Hintergrund
 * schließen den Dialog.
 *
 * Voraussetzung: utils.js, i18n.js
 * ============================================================ */
(function () {
  const ID = "directionsModal";
  const { escapeHtml } = AndromedaUtils;

  function ensureDOM() {
    let el = document.getElementById(ID);
    if (el) return el;
    el = document.createElement("div");
    el.className = "wp-backdrop";
    el.id = ID;
    el.innerHTML = `
      <div class="wpd-inner">
        <div class="wpd-head">
          <div class="wpd-head-col"><h2>${escapeHtml(t("dir.title"))}</h2></div>
          <button type="button" data-dir-close title="${escapeHtml(t("common.close"))}">✕</button>
        </div>
        <div class="wpd-body">
          <p class="directions-intro">${escapeHtml(t("dir.intro"))}</p>
          <div class="directions-list">
            ${link("dirGoogleAuto", "🗺️", "Google Maps", t("dir.car"))}
            ${link("dirGoogleTransit", "🚌", "Google Maps", t("dir.transit"))}
            ${link("dirOsmAuto", "🚗", "OpenStreetMap", t("dir.car"))}
          </div>
          <div class="directions-note"><strong>${escapeHtml(t("common.note"))}:</strong> <span data-dir-note></span></div>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector("[data-dir-close]").addEventListener("click", close);
    el.addEventListener("click", e => { if (e.target === el) close(); });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && isOpen()) { e.stopImmediatePropagation(); close(); }
    }, true);
    return el;
  }

  function link(id, icon, label, sub) {
    return `<a href="#" id="${id}" target="_blank" rel="noopener" class="directions-btn">
              <span class="dir-icon">${icon}</span>
              <span class="dir-label">${escapeHtml(label)}<span class="dir-sub">${escapeHtml(sub)}</span></span>
            </a>`;
  }

  function open(lat, lon, opts) {
    opts = opts || {};
    if (!isFinite(lat) || !isFinite(lon)) {
      if (window.AndromedaToast) AndromedaToast.show(t("dir.noStart"), "error");
      return;
    }
    const el = ensureDOM();
    const dest = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    el.querySelector("#dirGoogleAuto").href =
      `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
    el.querySelector("#dirGoogleTransit").href =
      `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=transit`;
    el.querySelector("#dirOsmAuto").href =
      `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=;${dest}`;
    el.querySelector("[data-dir-note]").textContent = opts.note || t("dir.noteNavigator");
    el.classList.add("show");
  }

  function close() {
    const el = document.getElementById(ID);
    if (el) el.classList.remove("show");
  }

  function isOpen() {
    const el = document.getElementById(ID);
    return !!(el && el.classList.contains("show"));
  }

  window.AndromedaDirections = { open, close, isOpen };
})();
