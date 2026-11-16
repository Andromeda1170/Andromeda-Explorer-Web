/* ============================================================
 * AndromedaExplorer — Globaler Nachtmodus
 * AndromedaDarkmode.init() bindet alle Elemente mit Klasse
 * ".darkmode-btn" (Klick-Toggle) und ".darkmode-switch" (Checkbox).
 * ============================================================ */
(function () {
  const AndromedaDarkmode = {
    key() { return (window.Andromeda && window.Andromeda.DARKMODE_KEY) || "andromeda_darkmode_v1"; },

    apply(on) {
      document.body.classList.toggle("dark", on);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", on ? "#14171a" : "#2a6fbf");
      document.querySelectorAll(".darkmode-btn").forEach(btn => {
        btn.textContent = on ? "☀️" : "🌙";
      });
      document.querySelectorAll(".darkmode-switch").forEach(sw => {
        sw.checked = on;
      });
      window.dispatchEvent(new CustomEvent("darkmodechange", { detail: { on } }));
    },
    load() {
      try {
        const v = localStorage.getItem(AndromedaDarkmode.key());
        if (v === "1") return true;
        if (v === "0") return false;
      } catch (e) {}
      return false;   // Standard: Tagmodus (unabhängig von der Systemeinstellung)
    },
    save(on) {
      try { localStorage.setItem(AndromedaDarkmode.key(), on ? "1" : "0"); } catch (e) {}
    },
    toggle() {
      const on = !document.body.classList.contains("dark");
      AndromedaDarkmode.apply(on);
      AndromedaDarkmode.save(on);
    },
    init() {
      AndromedaDarkmode.apply(AndromedaDarkmode.load());
      document.querySelectorAll(".darkmode-btn").forEach(btn => {
        btn.addEventListener("click", AndromedaDarkmode.toggle);
      });
      document.querySelectorAll(".darkmode-switch").forEach(sw => {
        sw.addEventListener("change", e => {
          AndromedaDarkmode.apply(e.target.checked);
          AndromedaDarkmode.save(e.target.checked);
        });
      });
    },
  };
  window.AndromedaDarkmode = AndromedaDarkmode;
})();