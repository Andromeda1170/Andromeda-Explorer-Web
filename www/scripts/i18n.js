/* ============================================================
 * AndromedaExplorer — Übersetzungen (i18n)
 *
 * Nur die Oberfläche wird übersetzt. Inhalte von Touren (Titel,
 * Beschreibung, Wegpunkte) bleiben in der Sprache, in der sie
 * erstellt wurden.
 *
 * Zwei Wege, Texte zu übersetzen:
 *
 * 1. Sätze (empfohlen für alles im HTML und in Meldungen)
 *    Der deutsche Text im Code ist zugleich der Schlüssel. Die Seite
 *    wird beim Laden und bei jeder Änderung (MutationObserver)
 *    automatisch übersetzt. Die englische Fassung steht in
 *    scripts/lang/en-phrases.js:
 *      "Tour geladen.": "Tour loaded.",
 *      "In {0} m": "In {0} m",              ← {0}, {1}: Platzhalter
 *      "<b>Karte antippen</b>, um …": "…"   ← ganze Absätze mit Tags
 *    Neue deutsche Texte → einfach dort ergänzen. Fehlt ein Eintrag,
 *    bleibt der deutsche Text stehen.
 *
 * 2. Schlüssel (für Texte, die im Code zusammengebaut werden)
 *      t("elev.show")               → "Höhenprofil anzeigen"
 *      t("tour.points", { n: 12 })  → "12 Punkte"
 *    Wörterbücher: scripts/lang/de.js, scripts/lang/en.js
 *    Im HTML: data-i18n, data-i18n-placeholder, data-i18n-title,
 *    data-i18n-aria-label.
 *
 * Nicht übersetzt wird alles innerhalb von [data-no-i18n] (Tour-
 * Inhalte) sowie <script>, <style>, <textarea>, <code>, <pre>.
 * Längere Seiten (Hilfe, Impressum) haben eigene Sprachblöcke:
 *   <div data-lang-block="de"> … </div>
 *   <div data-lang-block="en"> … </div>
 *
 * Sprachwahl (Reihenfolge):
 *   1. URL-Parameter ?lang=en (wird gespeichert)
 *   2. gespeicherte Wahl (localStorage)
 *   3. Browsersprache: Deutsch → Deutsch, sonst Englisch
 *
 * Umschalten: AndromedaI18n.setLang("en") — ohne Neuladen. Knöpfe:
 *   <button class="lang-btn"></button>     (Kopfzeile, Desktop)
 *   <div class="lang-seg"></div>           (Menü / Einstellungen)
 * Danach wird das Ereignis "andromeda:langchange" ausgelöst.
 *
 * Ladereihenfolge: config.js → i18n.js → lang/de.js → lang/en.js →
 * lang/en-phrases.js → alle anderen Skripte.
 * ============================================================ */
(function () {
  "use strict";
  const SUPPORTED = ["de", "en"];
  const DEFAULT_LANG = "de";
  const STORAGE_KEY = (window.Andromeda && Andromeda.LANG_KEY) || "andromeda_lang_v1";
  const LOCALES = { de: "de-AT", en: "en-GB" };
  const NAMES = { de: "Deutsch", en: "English" };

  const dicts = {};                    // Schlüssel-Wörterbücher
  const phrases = { en: new Map() };   // deutscher Satz → Übersetzung
  const htmlPhrases = { en: new Map() };
  const patterns = { en: [] };         // Sätze mit Platzhaltern
  let reverse = null;                  // Übersetzung → deutsch (beim Zurückschalten)

  const norm = s => String(s).replace(/\s+/g, " ").trim();

  function normalize(lang) {
    const l = String(lang || "").toLowerCase().slice(0, 2);
    return SUPPORTED.includes(l) ? l : null;
  }

  /* Browsersprache: wer Deutsch eingestellt hat (Österreich, Deutschland,
   * Schweiz …), bekommt Deutsch, alle anderen Englisch. Eine Ortung über
   * die IP-Adresse gibt es bewusst nicht (Datenschutz, kein Fremddienst). */
  function detectBrowser() {
    const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
    for (const l of langs) {
      const n = normalize(l);
      if (n) return n;
    }
    return "en";
  }

  function detect() {
    try {
      const fromUrl = normalize(new URLSearchParams(location.search).get("lang"));
      if (fromUrl) {
        try { localStorage.setItem(STORAGE_KEY, fromUrl); } catch (e) {}
        return fromUrl;
      }
    } catch (e) {}
    try {
      const stored = normalize(localStorage.getItem(STORAGE_KEY));
      if (stored) return stored;
    } catch (e) {}
    return detectBrowser();
  }

  let current = detect();

  /* ---------- Schlüssel ---------- */
  function lookup(lang, key) {
    const d = dicts[lang];
    return d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
  }
  function t(key, params) {
    let s = lookup(current, key);
    if (s === undefined) s = lookup(DEFAULT_LANG, key);
    if (s === undefined) s = current === DEFAULT_LANG ? key : tr(key);
    if (params) {
      s = s.replace(/\{(\w+)\}/g, (m, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m);
    }
    return s;
  }

  /* ---------- Sätze ---------- */
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  /* Platzhalter in Sätzen:
   *   {0}    am Satzanfang: Zahl (mit Einheit), z. B. „{0} Bilder“
   *          sonst: kurzer Text ohne „·“
   *   {0:t}  Text, auch am Satzanfang (z. B. Tourname)
   * So verschluckt „{0} Bilder“ keinen ganzen Satz, der auf „Bilder“ endet. */
  const NUM = "([-+±]?\\d[\\d.,:/\\s–%]*(?:\\s?(?:km|m|h|min|s|MB|%))?)";
  const TXT = "([^·\\n]{1,80}?)";
  function addPattern(lang, de, out) {
    const names = [];
    let first = true;
    const src = escapeRe(norm(de)).replace(/\\\{(\d+)(:t)?\\\}|[^\\{]+|\\\{/g, (m, n, txt, off) => {
      if (n === undefined) { if (m.trim()) first = false; return m; }
      names.push(n);
      const leading = first;
      first = false;
      return txt || !leading ? TXT : NUM;
    });
    out = out.replace(/\{(\d+):t\}/g, "{$1}");
    patterns[lang].push({ re: new RegExp("^" + src + "$"), names, out, weight: de.replace(/\{\d+(:t)?\}/g, "").length });
  }
  function addPhrases(lang, obj) {
    phrases[lang] = phrases[lang] || new Map();
    htmlPhrases[lang] = htmlPhrases[lang] || new Map();
    patterns[lang] = patterns[lang] || [];
    for (const [de, out] of Object.entries(obj)) {
      if (out == null || out === "") continue;
      if (/<[a-z][^>]*>/i.test(de)) htmlPhrases[lang].set(norm(de), out);
      else if (/\{\d+(:t)?\}/.test(de)) addPattern(lang, de, out);
      else phrases[lang].set(norm(de), out);
    }
    patterns[lang].sort((a, b) => b.weight - a.weight);
    reverse = null;
  }
  /* Einzelnen Text übersetzen (Leerraum am Rand bleibt erhalten). */
  function trCore(core, lang) {
    const map = phrases[lang];
    if (!map) return null;
    const direct = map.get(core);
    if (direct != null) return direct;
    for (const p of patterns[lang]) {
      const m = core.match(p.re);
      if (!m) continue;
      const vals = {};
      p.names.forEach((n, i) => {
        const v = m[i + 1];
        vals[n] = map.has(norm(v)) ? map.get(norm(v)) : v;   // Platzhalter selbst übersetzen
      });
      return p.out.replace(/\{(\d+)\}/g, (x, n) => (n in vals ? vals[n] : x));
    }
    return null;
  }
  function tr(s, lang) {
    lang = lang || current;
    if (lang === DEFAULT_LANG || s == null) return s;
    s = String(s);
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const core = norm(m[2]);
    if (!/[A-Za-zÄÖÜäöüß]/.test(core)) return s;
    let out = trCore(core, lang);
    if (out == null) {
      // mehrzeilige Meldungen (confirm/alert): zeilenweise
      if (/\n/.test(m[2])) {
        const lines = m[2].split("\n").map(l => (l.trim() ? (trCore(norm(l), lang) ?? l) : l));
        return m[1] + lines.join("\n") + m[3];
      }
      return s;
    }
    return m[1] + out + m[3];
  }
  function reverseMap() {
    if (reverse) return reverse;
    reverse = new Map();
    for (const lang of Object.keys(phrases)) {
      for (const [de, out] of phrases[lang]) {
        const k = norm(out);
        if (/[A-Za-z]/.test(k) && !reverse.has(k)) reverse.set(k, de);
      }
    }
    const deD = dicts.de || {};
    for (const lang of Object.keys(dicts)) {
      if (lang === "de") continue;
      for (const [k, v] of Object.entries(dicts[lang])) if (deD[k] != null) reverse.set(norm(v), deD[k]);
    }
    return reverse;
  }

  /* ---------- Seite übersetzen ---------- */
  // Nicht übersetzen: Technik und Tour-Inhalte (Titel, Beschreibung,
  // Wegpunkte, Bildunterschriften, Orte). Neue Inhalts-Container am
  // besten direkt mit data-no-i18n markieren.
  const SKIP = [
    "script", "style", "noscript", "textarea", "pre",
    "[data-no-i18n]", "[contenteditable='']", "[contenteditable='true']",
    "#routeTitle", ".description", ".rating-note",
    ".wp-item .name", ".wp-inline h2", ".wp-inline-note", "#wpdTitle", ".wpd-note",
    ".wp-title", ".wp-note", ".img-card .caption", ".alb-caption",
    ".tour-card .title", ".tour-card .loc", ".tour-card .tag", ".tour-popup h4",
  ].join(",");
  const ATTRS = ["title", "placeholder", "aria-label"];
  const RICH_TAGS = /^(P|LI|DIV|SPAN|LABEL|SMALL|TD|TH|H1|H2|H3|H4|H5|DT|DD|BUTTON|A|STRONG|B)$/;
  const orig = new WeakMap();      // Textknoten → deutscher Text
  const shown = new WeakMap();     // Textknoten → von uns gesetzter Text
  let observer = null;
  let busy = false;

  const skipped = el => !el || (el.closest && !!el.closest(SKIP));

  function doText(n) {
    const v = n.nodeValue;
    if (shown.get(n) === v) return;
    orig.set(n, v);
    const out = tr(v);
    if (out !== v) { shown.set(n, out); n.nodeValue = out; }
    else shown.delete(n);
  }
  function doAttrs(el) {
    if (!el.getAttribute) return;
    const st = el.__i18nA || (el.__i18nA = {});
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v == null) continue;
      if (st[a] && st[a].shown === v) continue;
      const out = tr(v);
      st[a] = { orig: v, shown: out };
      if (out !== v) el.setAttribute(a, out);
    }
    if (el.tagName === "INPUT" && /^(button|submit)$/.test(el.type) && el.value) {
      if (!(st.value && st.value.shown === el.value)) {
        const out = tr(el.value);
        st.value = { orig: el.value, shown: out };
        if (out !== el.value) el.value = out;
      }
    }
  }
  /* Absätze mit Formatierung (<b>, <a> …) als Ganzes übersetzen. */
  function doRich(el) {
    const map = htmlPhrases[current];
    if (!map || !map.size || !RICH_TAGS.test(el.tagName)) return false;
    if (el.__i18nH && el.__i18nH.shown === el.innerHTML) return true;
    const out = map.get(norm(el.innerHTML));
    if (out == null) return false;
    el.__i18nH = { orig: el.innerHTML };
    el.innerHTML = out;
    el.__i18nH.shown = el.innerHTML;
    return true;
  }
  function walk(n) {
    if (n.nodeType === 3) { if (/[A-Za-zÄÖÜäöü]/.test(n.nodeValue)) doText(n); return; }
    if (n.nodeType !== 1 || n.matches(SKIP)) return;
    doAttrs(n);
    if (doRich(n)) return;          // ganzer Absatz übersetzt
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  }
  function translateTree(root) {
    if (current === DEFAULT_LANG || !root) return;
    if (root.nodeType === 9) root = root.documentElement;
    const parent = root.nodeType === 3 ? root.parentElement : root.parentElement;
    if (parent && skipped(parent)) return;
    walk(root);
  }
  function restoreTree() {
    const rev = reverseMap();
    const all = document.documentElement.querySelectorAll("*");
    for (const el of all) {
      if (el.__i18nH && el.__i18nH.shown === el.innerHTML) { el.innerHTML = el.__i18nH.orig; el.__i18nH = null; }
    }
    const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (skipped(n.parentElement)) continue;
      if (shown.get(n) === n.nodeValue && orig.has(n)) n.nodeValue = orig.get(n);
      else {
        // über Schlüssel/JS erzeugter englischer Text
        const k = norm(n.nodeValue);
        const back = k && rev.get(k);
        if (back) n.nodeValue = n.nodeValue.replace(k, back);
      }
      shown.delete(n);
    }
    for (const el of document.documentElement.querySelectorAll("*")) {
      const st = el.__i18nA;
      if (!st) continue;
      for (const a of Object.keys(st)) {
        if (a === "value") { if (el.value === st.value.shown) el.value = st.value.orig; continue; }
        if (el.getAttribute(a) === st[a].shown) el.setAttribute(a, st[a].orig);
      }
      el.__i18nA = null;
    }
  }

  function observe() {
    if (observer || !window.MutationObserver) return;
    observer = new MutationObserver(records => {
      if (busy || current === DEFAULT_LANG) return;
      busy = true;
      try {
        for (const r of records) {
          if (r.type === "childList") r.addedNodes.forEach(n => translateTree(n));
          else if (r.type === "characterData") { if (!skipped(r.target.parentElement)) doText(r.target); }
          else if (r.type === "attributes") { if (!skipped(r.target)) doAttrs(r.target); }
        }
      } finally { busy = false; }
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS,
    });
  }

  /* Dialoge des Browsers ebenfalls übersetzen */
  for (const fn of ["alert", "confirm", "prompt"]) {
    const native = window[fn];
    if (typeof native !== "function") continue;
    window[fn] = function (msg, ...rest) { return native.call(window, tr(msg), ...rest); };
  }

  /* Schlüssel-Elemente (data-i18n …) */
  function apply(root) {
    root = root || document;
    const MAP = [["data-i18n-placeholder", "placeholder"], ["data-i18n-title", "title"], ["data-i18n-aria-label", "aria-label"]];
    root.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.getAttribute("data-i18n")); });
    for (const [dataAttr, attr] of MAP) {
      root.querySelectorAll(`[${dataAttr}]`).forEach(el => el.setAttribute(attr, t(el.getAttribute(dataAttr))));
    }
  }

  /* ---------- Sprachumschalter ---------- */
  let flagId = 0;
  function flagSvg(lang) {
    if (lang === "de") {
      // Österreich
      return '<svg class="flag" viewBox="0 0 30 20" aria-hidden="true"><rect width="30" height="20" fill="#C8102E"/><rect y="6.667" width="30" height="6.667" fill="#fff"/></svg>';
    }
    // Vereinigtes Königreich
    const id = "ukclip" + (++flagId);
    return `<svg class="flag" viewBox="0 0 60 30" aria-hidden="true"><clipPath id="${id}"><path d="M30,15h30v15zv15h-30zh-30v-15zv-15h30z"/></clipPath>` +
      '<path d="M0,0v30h60v-30z" fill="#012169"/><path d="M0,0L60,30M60,0L0,30" stroke="#fff" stroke-width="6"/>' +
      `<path d="M0,0L60,30M60,0L0,30" clip-path="url(#${id})" stroke="#C8102E" stroke-width="4"/>` +
      '<path d="M30,0v30M0,15h60" stroke="#fff" stroke-width="10"/><path d="M30,0v30M0,15h60" stroke="#C8102E" stroke-width="6"/></svg>';
  }
  function renderSwitchers() {
    document.querySelectorAll(".lang-btn").forEach(btn => {
      btn.setAttribute("data-no-i18n", "");
      btn.innerHTML = `${flagSvg(current)}<span class="lang-code">${current.toUpperCase()}</span>`;
      const other = current === "de" ? "en" : "de";
      const label = current === "de" ? "Switch to English" : "Auf Deutsch umstellen";
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.dataset.target = other;
    });
    document.querySelectorAll(".lang-seg").forEach(seg => {
      seg.setAttribute("data-no-i18n", "");
      seg.setAttribute("role", "group");
      seg.innerHTML = SUPPORTED.map(l =>
        `<button type="button" data-lang="${l}" class="${l === current ? "active" : ""}" aria-pressed="${l === current}">${flagSvg(l)}<span>${NAMES[l]}</span></button>`).join("");
    });
  }
  function bindSwitchers() {
    document.addEventListener("click", e => {
      const btn = e.target.closest && e.target.closest(".lang-btn, .lang-seg button");
      if (!btn) return;
      e.preventDefault();
      const l = btn.dataset.target || btn.dataset.lang;
      if (l) AndromedaI18n.setLang(l);
    });
  }

  function setLang(lang) {
    const l = normalize(lang);
    if (!l) return;
    try { localStorage.setItem(STORAGE_KEY, l); } catch (e) {}
    if (l === current) return;
    const prev = current;
    current = l;
    document.documentElement.lang = l;
    busy = true;
    try {
      if (prev !== DEFAULT_LANG) restoreTree();
      apply();
      if (l !== DEFAULT_LANG) translateTree(document);
      renderSwitchers();
    } finally { busy = false; }
    observe();
    window.dispatchEvent(new CustomEvent("andromeda:langchange", { detail: { lang: l } }));
  }

  const AndromedaI18n = {
    SUPPORTED, NAMES, t, tr, apply, setLang,
    add(lang, entries) { dicts[lang] = Object.assign(dicts[lang] || {}, entries); reverse = null; },
    addPhrases,
    lang() { return current; },
    locale() { return LOCALES[current] || LOCALES[DEFAULT_LANG]; },
    /* Zahl im Format der aktuellen Sprache (Dezimaltrennzeichen). */
    fmtNumber(n, digits) {
      return Number(n).toLocaleString(AndromedaI18n.locale(), {
        minimumFractionDigits: digits || 0,
        maximumFractionDigits: digits || 0,
      });
    },
    /* Übersetzt einen Unterbaum sofort (z. B. vor dem Drucken). */
    translate(root) { if (current !== DEFAULT_LANG) translateTree(root || document); },
  };

  document.documentElement.lang = current;
  function start() {
    renderSwitchers();
    if (current !== DEFAULT_LANG) {
      busy = true;
      try { apply(); translateTree(document); } finally { busy = false; }
    }
    observe();
  }
  bindSwitchers();
  // Übersetzt wird bei DOMContentLoaded (alle Wörterbücher sind dann
  // geladen), danach hält der MutationObserver alles aktuell.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.AndromedaI18n = AndromedaI18n;
  window.t = t;
})();
