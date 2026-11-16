/* ============================================================
 * AndromedaExplorer — Modal-Dialog
 * AndromedaModal.askForName({title, hint, defaultValue, extension, onConfirm})
 * Erzeugt das DOM bei Bedarf selbst — die Seite braucht nur eine
 * leere Seite, kein #nameDialog im HTML.
 * ============================================================ */
(function () {
  function ensureDialog() {
    let dlg = document.getElementById("nameDialog");
    if (dlg) return dlg;
    dlg = document.createElement("div");
    dlg.className = "modal-backdrop";
    dlg.id = "nameDialog";
    dlg.innerHTML = `
      <div class="modal">
        <h3 id="nameDialogTitle">${t("modal.enterName")}</h3>
        <p id="nameDialogHint"></p>
        <input type="text" id="nameDialogInput" autocomplete="off">
        <div class="preview" id="nameDialogPreview"></div>
        <div class="actions">
          <button class="cancel" id="nameDialogCancel">${t("common.cancel")}</button>
          <button class="ok" id="nameDialogOk">${t("common.ok")}</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    return dlg;
  }

  const AndromedaModal = {
    askForName({ title, hint, defaultValue, extension, onConfirm }) {
      const $ = id => document.getElementById(id);
      const sanitize = (window.AndromedaUtils && AndromedaUtils.sanitizeFilename) ||
        (s => String(s || "").trim().replace(/[^\w.-]+/g, "_"));

      const dlg = ensureDialog();
      const input = $("nameDialogInput");
      const preview = $("nameDialogPreview");
      const extLabel = extension || "";
      $("nameDialogTitle").textContent = title;
      $("nameDialogHint").textContent = hint;
      input.value = defaultValue;
      preview.textContent = extLabel
        ? `${t("modal.filename")}: ${sanitize(defaultValue)}${extLabel}` : "";
      dlg.classList.add("show");
      input.focus(); input.select();

      const updatePreview = () => {
        if (extLabel) preview.textContent = `${t("modal.filename")}: ${sanitize(input.value)}${extLabel}`;
      };
      const cleanup = () => {
        dlg.classList.remove("show");
        input.removeEventListener("input", updatePreview);
        $("nameDialogOk").removeEventListener("click", onOk);
        $("nameDialogCancel").removeEventListener("click", onCancel);
        input.removeEventListener("keydown", onKey);
      };
      const onOk = () => {
        const v = input.value.trim() || defaultValue;
        cleanup(); onConfirm(v);
      };
      const onCancel = () => cleanup();
      const onKey = e => {
        if (e.key === "Enter") { e.preventDefault(); onOk(); }
        else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      };
      $("nameDialogOk").addEventListener("click", onOk);
      $("nameDialogCancel").addEventListener("click", onCancel);
      input.addEventListener("keydown", onKey);
      input.addEventListener("input", updatePreview);
    },
  };

  window.AndromedaModal = AndromedaModal;
})();