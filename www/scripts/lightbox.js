/* ============================================================
 * AndromedaExplorer — Lightbox mit Galerie-Navigation
 *
 * AndromedaLightbox.open(items, startIndex)
 *   items      = Array von { url: string, caption?: string }
 *   startIndex = Startindex (0-basiert, optional)
 *
 * Navigation:
 *   - Pfeiltasten ← →
 *   - Pfeil-Buttons links/rechts
 *   - Wischen auf Touch-Geräten (nur ungezoomt)
 *   - Zoomen: zwei Finger, Doppeltipp/Doppelklick, Mausrad;
 *     gezoomt lässt sich das Bild mit einem Finger/der Maus verschieben
 *   - Escape oder Klick auf den Hintergrund schließt
 *   - Zirkulär: nach dem letzten Bild kommt wieder das erste
 * ============================================================ */
(function () {
  let overlay = null;
  let imgEl = null;
  let captionEl = null;
  let counterEl = null;
  let items = [];
  let index = 0;
  // Zoom-Zustand des aktuellen Bildes
  const MAX_SCALE = 5;
  let scale = 1, tx = 0, ty = 0;

  function ensureDOM() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.id = "andromedaLightbox";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <button class="alb-close" type="button" aria-label="Schließen">✕</button>
      <button class="alb-prev" type="button" aria-label="Vorheriges Bild">‹</button>
      <button class="alb-next" type="button" aria-label="Nächstes Bild">›</button>
      <div class="alb-stage">
        <img class="alb-img" alt="">
      </div>
      <div class="alb-caption"></div>
      <div class="alb-counter"></div>
    `;
    document.body.appendChild(overlay);

    imgEl = overlay.querySelector(".alb-img");
    captionEl = overlay.querySelector(".alb-caption");
    counterEl = overlay.querySelector(".alb-counter");

    overlay.querySelector(".alb-close").addEventListener("click", (e) => {
      e.stopPropagation(); close();
    });
    overlay.querySelector(".alb-prev").addEventListener("click", (e) => {
      e.stopPropagation(); prev();
    });
    overlay.querySelector(".alb-next").addEventListener("click", (e) => {
      e.stopPropagation(); next();
    });

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && !overlay._wasGesture) close();
    });
    overlay.querySelector(".alb-stage").addEventListener("click", (e) => {
      // Klick neben das (ungezoomte) Bild schließt wie der Hintergrund
      if (e.target !== imgEl && scale === 1 && !overlay._wasGesture) close();
    });

    bindGestures();

    document.addEventListener("keydown", (e) => {
      if (!overlay.classList.contains("show")) return;
      if (e.key === "Escape") { close(); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { prev(); e.preventDefault(); }
      else if (e.key === "ArrowRight") { next(); e.preventDefault(); }
    });
  }

  /* ---------- Zoom ---------- */
  function applyTransform(animate) {
    imgEl.style.transition = animate ? "transform .2s ease-out" : "none";
    imgEl.style.transform = scale === 1 && !tx && !ty ? "" : `translate(${tx}px, ${ty}px) scale(${scale})`;
    overlay.classList.toggle("zoomed", scale > 1.01);
  }
  function resetZoom() { scale = 1; tx = 0; ty = 0; if (imgEl) applyTransform(false); }

  /* Verschiebung so begrenzen, dass kein leerer Rand ins Bild rutscht
   * (ist das Bild kleiner als der Bildschirm, bleibt es mittig). */
  function clampPan() {
    const w = imgEl.offsetWidth * scale, h = imgEl.offsetHeight * scale;
    const vw = overlay.clientWidth, vh = overlay.clientHeight;
    const r = imgEl.getBoundingClientRect();
    // Bildmitte ohne Verschiebung (Bildschirmkoordinaten)
    const cx = r.left + r.width / 2 - tx, cy = r.top + r.height / 2 - ty;
    tx = w <= vw ? 0 : Math.min(w / 2 - cx, Math.max(vw - cx - w / 2, tx));
    ty = h <= vh ? 0 : Math.min(h / 2 - cy, Math.max(vh - cy - h / 2, ty));
  }
  /* Um den Bildschirmpunkt (px, py) auf newScale zoomen. */
  function zoomAt(px, py, newScale, animate) {
    newScale = Math.max(1, Math.min(MAX_SCALE, newScale));
    const r = imgEl.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;   // aktuelle Bildmitte
    const k = newScale / scale;
    tx += (px - cx) * (1 - k);
    ty += (py - cy) * (1 - k);
    scale = newScale;
    if (scale === 1) { tx = 0; ty = 0; }
    clampPan();
    applyTransform(animate);
  }

  function bindGestures() {
    const stage = overlay.querySelector(".alb-stage");
    const pts = new Map();
    let g = null, lastTap = null;

    overlay.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      overlay._wasGesture = false;
      const list = Array.from(pts.values());
      if (list.length === 1) {
        g = { type: "one", sx: e.clientX, sy: e.clientY, tx0: tx, ty0: ty, moved: false, t: Date.now() };
      } else if (list.length === 2) {
        const [a, b] = list;
        g = { type: "pinch", d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, s0: scale,
          mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        overlay._wasGesture = true;
      }
    });
    overlay.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId) || !g) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (g.type === "pinch" && pts.size >= 2) {
        const [a, b] = Array.from(pts.values());
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        // mitziehen, dann um die Fingermitte zoomen
        tx += mx - g.mx; ty += my - g.my; g.mx = mx; g.my = my;
        zoomAt(mx, my, g.s0 * d / g.d0, false);
      } else if (g.type === "one") {
        const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
        if (!g.moved && Math.hypot(dx, dy) > 8) { g.moved = true; overlay._wasGesture = true; }
        if (g.moved && scale > 1) {
          tx = g.tx0 + dx; ty = g.ty0 + dy;
          clampPan(); applyTransform(false);
        }
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (!g) return;
      if (g.type === "pinch") {
        if (pts.size === 1) {
          // ein Finger bleibt liegen: als Verschieben weiter
          const p = Array.from(pts.values())[0];
          g = { type: "one", sx: p.x, sy: p.y, tx0: tx, ty0: ty, moved: true, t: Date.now() };
          return;
        }
        if (scale < 1.05) { scale = 1; tx = 0; ty = 0; applyTransform(true); }
        g = null; return;
      }
      if (pts.size) return;
      const cur = g; g = null;
      if (e.type === "pointercancel") return;
      const dx = e.clientX - cur.sx, dy = e.clientY - cur.sy;
      if (cur.moved) {
        // Wischen zum nächsten Bild nur ungezoomt
        if (scale === 1 && Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) { dx < 0 ? next() : prev(); }
        return;
      }
      // Doppeltipp/Doppelklick: hinein- bzw. herauszoomen
      const now = Date.now();
      if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        lastTap = null;
        overlay._wasGesture = true;
        if (scale > 1) { scale = 1; tx = 0; ty = 0; applyTransform(true); }
        else zoomAt(e.clientX, e.clientY, 2.5, true);
      } else lastTap = { t: now, x: e.clientX, y: e.clientY };
    };
    overlay.addEventListener("pointerup", up);
    overlay.addEventListener("pointercancel", up);
    overlay.addEventListener("wheel", (e) => {
      if (!overlay.classList.contains("show")) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, scale * Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 20 : 1)), false);
    }, { passive: false });
    stage.addEventListener("dragstart", (e) => e.preventDefault());
    window.addEventListener("resize", () => { if (scale > 1) { clampPan(); applyTransform(false); } });
  }

  function render() {
    const it = items[index];
    if (!it) return;
    resetZoom();
    imgEl.src = it.url;
    imgEl.alt = it.caption || "";
    captionEl.textContent = it.caption || "";
    counterEl.textContent = items.length > 1
      ? `${index + 1} / ${items.length}`
      : "";
    const hideArrows = items.length < 2;
    overlay.querySelector(".alb-prev").style.display = hideArrows ? "none" : "";
    overlay.querySelector(".alb-next").style.display = hideArrows ? "none" : "";
  }

  function next() {
    if (items.length < 2) return;
    index = (index + 1) % items.length;
    render();
  }
  function prev() {
    if (items.length < 2) return;
    index = (index - 1 + items.length) % items.length;
    render();
  }

  function open(list, startIdx) {
    if (!Array.isArray(list) || !list.length) return;
    const valid = list.filter(x => x && x.url);
    if (!valid.length) return;
    items = valid;
    index = (typeof startIdx === "number" && startIdx >= 0 && startIdx < items.length)
      ? startIdx
      : 0;
    ensureDOM();
    render();
    overlay.classList.add("show");
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove("show");
    resetZoom();
    setTimeout(() => { if (imgEl) imgEl.src = ""; }, 200);
  }

  window.AndromedaLightbox = { open, close };
})();