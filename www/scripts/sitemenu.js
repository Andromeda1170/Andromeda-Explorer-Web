/* ============================================================
 * AndromedaExplorer — Mobiles Seitenmenü
 * Für Seiten mit #menuBtn, #mobileMenu und #closeMobileMenu
 * (Startseite, Hilfe, Impressum, Rechtliches).
 * AndromedaSiteMenu.bind() einmal beim Start aufrufen.
 * ============================================================ */
(function () {
  const $ = id => document.getElementById(id);

  function open() { $("mobileMenu").classList.add("show"); }
  function close() { $("mobileMenu").classList.remove("show"); }

  function bind() {
    const menu = $("mobileMenu");
    if (!menu) return;
    const btn = $("menuBtn");
    const closeBtn = $("closeMobileMenu");
    if (btn) btn.addEventListener("click", open);
    if (closeBtn) closeBtn.addEventListener("click", close);
    menu.addEventListener("click", e => { if (e.target === menu) close(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  }

  /* Für Seiten, die nur Nachtmodus und Menü brauchen. */
  function initStaticPage() {
    const run = () => { AndromedaDarkmode.init(); bind(); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
    else run();
  }

  window.AndromedaSiteMenu = { open, close, bind, initStaticPage };
})();
