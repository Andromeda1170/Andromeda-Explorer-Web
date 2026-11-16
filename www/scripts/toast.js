/* ============================================================
 * AndromedaExplorer — Toast
 * AndromedaToast.show(msg, type) mit type = "error" | "success" | "warn"
 * ============================================================ */
(function () {
  let timer = null;
  const AndromedaToast = {
    show(msg, type) {
      let el = document.getElementById("toast");
      if (!el) {
        el = document.createElement("div");
        el.id = "toast";
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.className = "show" + (type ? " " + type : "");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { el.className = ""; }, 3000);
    },
  };
  window.AndromedaToast = AndromedaToast;
  // Kurzform für alle Seiten: toast("Text", "success")
  window.toast = (msg, type) => AndromedaToast.show(msg, type);
})();
