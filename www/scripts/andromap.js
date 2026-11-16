/* ============================================================
 * AndroMap — eigene Karten-Engine für AndromedaExplorer
 *
 * Ersetzt Leaflet. Spricht dieselbe Sprache wie die Teile von Leaflet,
 * die das Projekt nutzt (L.map, L.tileLayer, L.marker, L.divIcon,
 * L.polyline, L.circle, L.layerGroup, L.latLngBounds, L.Control …),
 * damit der Seitencode unverändert bleiben kann.
 *
 * Zusätzlich:
 *   - Drehen der Karte (zwei Finger, map.setBearing(), map.resetNorth())
 *   - Kompassnadel oben rechts: erscheint, sobald die Karte gedreht ist;
 *     ein Tipp richtet die Karte wieder nach Norden aus
 *   - Offline: Fehlt eine Kachel (kein Netz, nicht im Cache), wird die
 *     nächstgröbere vorhandene Kachel vergrößert angezeigt statt einer
 *     Lücke. Eigene Kachelquellen über die Option loadTile (z. B.
 *     IndexedDB-Cache im Navigator). Keine externen Abhängigkeiten.
 *
 * Aufbau der Darstellung:
 *   .leaflet-map-pane
 *     .leaflet-world        ← per CSS verschoben, skaliert, gedreht
 *       .leaflet-tile-pane    Kacheln (je Zoomstufe eine Ebene)
 *       .leaflet-overlay-pane SVG mit Linien und Kreisen
 *     .leaflet-marker-pane  ← Marker aufrecht in Bildschirmkoordinaten
 *     .leaflet-tooltip-pane, .leaflet-popup-pane
 *   .leaflet-control-container (Ecken für Bedienelemente)
 *
 * Die Klassennamen entsprechen Leaflet, damit vorhandenes CSS greift.
 * Styles: stylesheets/andromap.css
 * ============================================================ */
(function () {
  "use strict";

  const TILE = 256;
  const TILE_FADE_MS = 220;   // passt zur Einblendung in andromap.css
  const MAX_LAT = 85.0511287798;
  const EARTH_R = 6378137;
  const DEG = Math.PI / 180;

  /* ============================================================
   * Grundtypen
   * ============================================================ */
  class Point {
    constructor(x, y) { this.x = x; this.y = y; }
    add(p) { return new Point(this.x + p.x, this.y + p.y); }
    subtract(p) { return new Point(this.x - p.x, this.y - p.y); }
    multiplyBy(k) { return new Point(this.x * k, this.y * k); }
    divideBy(k) { return new Point(this.x / k, this.y / k); }
    distanceTo(p) { return Math.hypot(this.x - p.x, this.y - p.y); }
    round() { return new Point(Math.round(this.x), Math.round(this.y)); }
    clone() { return new Point(this.x, this.y); }
    equals(p) { return p && this.x === p.x && this.y === p.y; }
  }
  const toPoint = (x, y) => (x instanceof Point ? x
    : Array.isArray(x) ? new Point(x[0], x[1])
    : (x && typeof x === "object") ? new Point(x.x, x.y)
    : new Point(x, y));

  class Bounds {
    constructor(a, b) {
      this.min = null; this.max = null;
      if (a) this.extend(a);
      if (b) this.extend(b);
    }
    extend(p) {
      p = toPoint(p);
      if (!this.min) { this.min = p.clone(); this.max = p.clone(); }
      else {
        this.min.x = Math.min(this.min.x, p.x); this.min.y = Math.min(this.min.y, p.y);
        this.max.x = Math.max(this.max.x, p.x); this.max.y = Math.max(this.max.y, p.y);
      }
      return this;
    }
    getSize() { return this.max.subtract(this.min); }
    getCenter() { return new Point((this.min.x + this.max.x) / 2, (this.min.y + this.max.y) / 2); }
    contains(p) { p = toPoint(p); return p.x >= this.min.x && p.x <= this.max.x && p.y >= this.min.y && p.y <= this.max.y; }
  }

  class LatLng {
    constructor(lat, lng) { this.lat = +lat; this.lng = +lng; }
    distanceTo(o) {
      o = toLatLng(o);
      const dLat = (o.lat - this.lat) * DEG, dLng = (o.lng - this.lng) * DEG;
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(this.lat * DEG) * Math.cos(o.lat * DEG) * Math.sin(dLng / 2) ** 2;
      return 2 * 6371000 * Math.asin(Math.sqrt(a));
    }
    equals(o) { o = toLatLng(o); return !!o && Math.abs(o.lat - this.lat) < 1e-9 && Math.abs(o.lng - this.lng) < 1e-9; }
    clone() { return new LatLng(this.lat, this.lng); }
    toString() { return `LatLng(${this.lat}, ${this.lng})`; }
  }
  function toLatLng(a, b) {
    if (a instanceof LatLng) return a;
    if (Array.isArray(a)) return a.length >= 2 ? new LatLng(a[0], a[1]) : null;
    if (a && typeof a === "object" && "lat" in a) return new LatLng(a.lat, "lng" in a ? a.lng : a.lon);
    if (a == null) return null;
    return new LatLng(a, b);
  }

  class LatLngBounds {
    constructor(a, b) {
      this._sw = null; this._ne = null;
      if (Array.isArray(a) && b === undefined && a.length && (Array.isArray(a[0]) || typeof a[0] === "object")) {
        for (const p of a) this.extend(p);
      } else {
        if (a) this.extend(a);
        if (b) this.extend(b);
      }
    }
    extend(o) {
      if (o instanceof LatLngBounds) {
        if (!o.isValid()) return this;
        this.extend(o._sw); this.extend(o._ne);
        return this;
      }
      const ll = toLatLng(o);
      if (!ll || !isFinite(ll.lat) || !isFinite(ll.lng)) return this;
      if (!this._sw) { this._sw = ll.clone(); this._ne = ll.clone(); }
      else {
        this._sw.lat = Math.min(this._sw.lat, ll.lat); this._sw.lng = Math.min(this._sw.lng, ll.lng);
        this._ne.lat = Math.max(this._ne.lat, ll.lat); this._ne.lng = Math.max(this._ne.lng, ll.lng);
      }
      return this;
    }
    isValid() { return !!this._sw; }
    pad(ratio) {
      const h = (this._ne.lat - this._sw.lat) * ratio, w = (this._ne.lng - this._sw.lng) * ratio;
      return new LatLngBounds([this._sw.lat - h, this._sw.lng - w], [this._ne.lat + h, this._ne.lng + w]);
    }
    getCenter() { return new LatLng((this._sw.lat + this._ne.lat) / 2, (this._sw.lng + this._ne.lng) / 2); }
    getSouthWest() { return this._sw; }
    getNorthEast() { return this._ne; }
    getNorthWest() { return new LatLng(this._ne.lat, this._sw.lng); }
    getSouthEast() { return new LatLng(this._sw.lat, this._ne.lng); }
    getNorth() { return this._ne.lat; }
    getSouth() { return this._sw.lat; }
    getEast() { return this._ne.lng; }
    getWest() { return this._sw.lng; }
    contains(o) {
      if (o instanceof LatLngBounds) return this.contains(o._sw) && this.contains(o._ne);
      const ll = toLatLng(o);
      return ll.lat >= this._sw.lat && ll.lat <= this._ne.lat && ll.lng >= this._sw.lng && ll.lng <= this._ne.lng;
    }
    intersects(o) {
      return !(o._sw.lat > this._ne.lat || o._ne.lat < this._sw.lat || o._sw.lng > this._ne.lng || o._ne.lng < this._sw.lng);
    }
  }
  const toBounds = (a, b) => (a instanceof LatLngBounds ? a : new LatLngBounds(a, b));

  /* ============================================================
   * Projektion (Web-Mercator) und Hilfen
   * ============================================================ */
  const worldSize = z => TILE * Math.pow(2, z);
  function project(ll, z) {
    const s = worldSize(z);
    const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, ll.lat));
    const sin = Math.sin(lat * DEG);
    return new Point((ll.lng + 180) / 360 * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s);
  }
  function unproject(p, z) {
    const s = worldSize(z);
    const lng = p.x / s * 360 - 180;
    const n = Math.PI - 2 * Math.PI * p.y / s;
    return new LatLng(Math.atan(Math.sinh(n)) / DEG, lng);
  }
  /* Vektor um deg Grad drehen (Bildschirm: y nach unten, positiv = im Uhrzeigersinn). */
  function rotate(p, deg) {
    if (!deg) return p;
    const r = deg * DEG, c = Math.cos(r), s = Math.sin(r);
    return new Point(p.x * c - p.y * s, p.x * s + p.y * c);
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const wrapDeg = d => { d = ((d + 180) % 360 + 360) % 360 - 180; return d === -180 ? 180 : d; };
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const now = () => (window.performance ? performance.now() : Date.now());

  function create(tag, className, parent) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (parent) parent.appendChild(el);
    return el;
  }
  function setOptions(obj, opts) {
    obj.options = Object.assign({}, Object.getPrototypeOf(obj).options || {}, obj.options || {}, opts || {});
    return obj.options;
  }

  /* Leaflet-artiges extend(): Klasse mit zusätzlichen Prototyp-Feldern ableiten. */
  function makeExtendable(Base) {
    Base.extend = function (props) {
      const Parent = this;
      class Sub extends Parent {}
      const { options, ...rest } = props || {};
      Object.assign(Sub.prototype, rest);
      Sub.prototype.options = Object.assign({}, Parent.prototype.options || {}, options || {});
      Sub.extend = Parent.extend;
      return Sub;
    };
    return Base;
  }

  /* ============================================================
   * Ereignisse
   * ============================================================ */
  class Evented {
    on(types, fn, ctx) {
      if (types && typeof types === "object") {
        for (const [k, v] of Object.entries(types)) this.on(k, v, fn);
        return this;
      }
      this._events = this._events || {};
      for (const t of String(types).split(/\s+/)) {
        if (!t) continue;
        (this._events[t] = this._events[t] || []).push({ fn, ctx });
      }
      return this;
    }
    off(types, fn) {
      if (!this._events) return this;
      if (!types) { this._events = {}; return this; }
      for (const t of String(types).split(/\s+/)) {
        if (!this._events[t]) continue;
        this._events[t] = fn ? this._events[t].filter(l => l.fn !== fn) : [];
      }
      return this;
    }
    once(types, fn, ctx) {
      const wrap = (e) => { this.off(types, wrap); fn.call(ctx || this, e); };
      return this.on(types, wrap, ctx);
    }
    listens(type) { return !!(this._events && this._events[type] && this._events[type].length); }
    fire(type, data) {
      const ls = this._events && this._events[type];
      const e = Object.assign({}, data || {}, { type, target: this, sourceTarget: (data && data.sourceTarget) || this });
      if (ls && ls.length) {
        for (const l of ls.slice()) {
          try { l.fn.call(l.ctx || this, e); }
          catch (err) { console.error("[AndroMap]", type, err); }
        }
      }
      return e;
    }
  }

  /* ============================================================
   * DOM-Hilfen (L.DomUtil / L.DomEvent)
   * ============================================================ */
  const DomUtil = {
    create,
    addClass: (el, c) => el.classList.add(...c.split(/\s+/).filter(Boolean)),
    removeClass: (el, c) => el.classList.remove(...c.split(/\s+/).filter(Boolean)),
    hasClass: (el, c) => el.classList.contains(c),
  };
  const DomEvent = {
    stopPropagation(e) {
      if (!e) return DomEvent;
      e._stopped = true;
      const oe = e.originalEvent || e;
      if (oe && oe.stopPropagation) oe.stopPropagation();
      return DomEvent;
    },
    preventDefault(e) {
      const oe = (e && e.originalEvent) || e;
      if (oe && oe.preventDefault) oe.preventDefault();
      return DomEvent;
    },
    stop(e) { return DomEvent.stopPropagation(e).preventDefault(e); },
    disableClickPropagation(el) {
      for (const t of ["pointerdown", "click", "dblclick", "contextmenu", "touchstart", "mousedown"]) {
        el.addEventListener(t, ev => ev.stopPropagation());
      }
      el._andromapNoMap = true;
      return DomEvent;
    },
    disableScrollPropagation(el) {
      el.addEventListener("wheel", ev => ev.stopPropagation(), { passive: true });
      return DomEvent;
    },
    on(el, types, fn) { for (const t of types.split(/\s+/)) el.addEventListener(t, fn); return DomEvent; },
    off(el, types, fn) { for (const t of types.split(/\s+/)) el.removeEventListener(t, fn); return DomEvent; },
  };
  /* Klicks auf Marker/Linien werden beim Loslassen (pointerup) ausgelöst.
   * Öffnet der Klick etwas über der Karte (Menü, Dialog), schickt der
   * Browser danach noch ein „click“ an genau diese Stelle — das würde
   * sonst sofort einen Knopf oder ein Bild im neuen Fenster auslösen.
   * Dieses eine nachfolgende click wird deshalb verschluckt. */
  function suppressGhostClick(ev) {
    if (!ev || ev.clientX == null) return;
    const x = ev.clientX, y = ev.clientY, until = now() + 700;
    const handler = e => {
      if (now() > until) { off(); return; }
      if (Math.hypot(e.clientX - x, e.clientY - y) < 40) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        off();
      }
    };
    const off = () => window.removeEventListener("click", handler, true);
    window.addEventListener("click", handler, true);
    setTimeout(off, 750);
  }

  /* Liegt das Ereignis-Ziel in einem Bedienelement (dann nicht an die Karte)? */
  function inControl(target, container) {
    for (let n = target; n && n !== container; n = n.parentNode) {
      if (n._andromapNoMap) return true;
      if (n.classList && (n.classList.contains("leaflet-control") || n.classList.contains("leaflet-popup"))) return true;
    }
    return false;
  }

  /* ============================================================
   * Ebenen (Basis)
   * ============================================================ */
  class Layer extends Evented {
    constructor(options) { super(); setOptions(this, options); }
    addTo(map) { map.addLayer(this); return this; }
    remove() { if (this._map) this._map.removeLayer(this); return this; }
    removeFrom(m) { if (m) m.removeLayer(this); return this; }
    onAdd() {}
    onRemove() {}
    getPane() { return this._map && this._map._panes[this.options.pane || "overlayPane"]; }
  }
  makeExtendable(Layer);

  class LayerGroup extends Layer {
    constructor(layers, options) {
      super(options);
      this._layers = new Set();
      if (Array.isArray(layers)) layers.forEach(l => this.addLayer(l));
    }
    addLayer(l) {
      if (!l || this._layers.has(l)) return this;
      this._layers.add(l);
      l._group = this;
      if (this._map) this._map.addLayer(l);
      return this;
    }
    removeLayer(l) {
      if (!this._layers.has(l)) return this;
      this._layers.delete(l);
      if (this._map) this._map.removeLayer(l);
      l._group = null;
      return this;
    }
    hasLayer(l) { return this._layers.has(l); }
    clearLayers() { for (const l of Array.from(this._layers)) this.removeLayer(l); return this; }
    eachLayer(fn, ctx) { for (const l of Array.from(this._layers)) fn.call(ctx, l); return this; }
    getLayers() { return Array.from(this._layers); }
    onAdd(map) { for (const l of this._layers) map.addLayer(l); }
    onRemove(map) { for (const l of this._layers) map.removeLayer(l); }
    setStyle(s) { for (const l of this._layers) if (l.setStyle) l.setStyle(s); return this; }
    getBounds() {
      const b = new LatLngBounds();
      for (const l of this._layers) {
        if (l.getBounds) b.extend(l.getBounds());
        else if (l.getLatLng) b.extend(l.getLatLng());
      }
      return b;
    }
  }

  /* ============================================================
   * Kachel-Ebene
   * ============================================================ */
  class TileLayer extends Layer {
    constructor(url, options) {
      super(options);
      this._url = url;
      const o = this.options;
      if (o.maxNativeZoom == null) o.maxNativeZoom = o.maxZoom;
      this._levels = new Map();   // z → { el, tiles: Map }
      this._memo = new Map();     // Kachel-URL → true, wenn erfolgreich geladen (für Fallback)
    }
    getTileUrl(c) {
      const o = this.options;
      const subs = typeof o.subdomains === "string" ? o.subdomains.split("") : (o.subdomains || ["a", "b", "c"]);
      const s = subs[Math.abs(c.x + c.y) % subs.length];
      return this._url.replace(/\{(\w+)\}/g, (m, k) =>
        k === "s" ? s : k === "z" ? c.z : k === "x" ? c.x : k === "y" ? c.y : k === "r" ? "" : (o[k] != null ? o[k] : m));
    }
    setUrl(url) { this._url = url; return this.redraw(); }
    setZIndex(z) { this.options.zIndex = z; if (this._container) this._container.style.zIndex = z; return this; }
    setOpacity(o) { this.options.opacity = o; if (this._container) this._container.style.opacity = o; return this; }
    getAttribution() { return this.options.attribution; }
    onAdd(map) {
      this._container = create("div", "leaflet-layer " + (this.options.className || ""), map._panes.tilePane);
      this._container.style.zIndex = this.options.zIndex != null ? this.options.zIndex : 1;
      if (this.options.opacity != null && this.options.opacity !== 1) this._container.style.opacity = this.options.opacity;
      map._requestRender();
      map._updateAttribution();
      if (map._zoom > map.getMaxZoom()) map.setZoom(map.getMaxZoom());
    }
    onRemove(map) {
      for (const z of Array.from(this._levels.keys())) this._removeLevel(z);
      if (this._container) this._container.remove();
      this._container = null;
      map._updateAttribution();
    }
    redraw() {
      if (!this._map) return this;
      for (const z of Array.from(this._levels.keys())) this._removeLevel(z);
      this._map._requestRender();
      return this;
    }

    _targetZoom(mapZoom) {
      const o = this.options;
      return clamp(Math.round(mapZoom), o.minZoom || 0, o.maxNativeZoom != null ? o.maxNativeZoom : 18);
    }
    _level(z) {
      let lvl = this._levels.get(z);
      if (!lvl) {
        lvl = { el: create("div", "leaflet-tile-container", this._container), tiles: new Map(), z };
        this._levels.set(z, lvl);
      }
      return lvl;
    }
    _removeLevel(z) {
      const lvl = this._levels.get(z);
      if (!lvl) return;
      for (const t of lvl.tiles.values()) this._disposeTile(t);
      lvl.el.remove();
      this._levels.delete(z);
    }
    _disposeTile(t) {
      t.dead = true;
      if (t.objectUrl) { try { URL.revokeObjectURL(t.objectUrl); } catch (e) {} }
      t.el.remove();
    }

    /* Wird bei jedem Rendern aufgerufen. Legt fehlende Kacheln an,
     * entfernt überflüssige und positioniert alles in Weltkoordinaten. */
    _update(map, originChanged) {
      if (!this._container) return;
      const z = this._targetZoom(map._zoom);
      const lvl = this._level(z);
      lvl.el.style.zIndex = 100;
      const n = Math.pow(2, z);
      const k = Math.pow(2, map._zoom - z);
      const c = project(map._center, z);
      // Radius über die Diagonale: deckt jede Drehung ab
      const r = Math.hypot(map._size.x, map._size.y) / 2 / k + TILE / 2;
      const x0 = Math.floor((c.x - r) / TILE), x1 = Math.floor((c.x + r) / TILE);
      const y0 = Math.max(0, Math.floor((c.y - r) / TILE)), y1 = Math.min(n - 1, Math.floor((c.y + r) / TILE));
      const wanted = new Set();
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const key = x + ":" + y;
          wanted.add(key);
          if (!lvl.tiles.has(key)) lvl.tiles.set(key, this._createTile(lvl, x, y, z));
        }
      }
      // Kacheln nach Nähe zur Mitte laden (Mitte zuerst)
      let allLoaded = true;
      for (const [key, t] of lvl.tiles) {
        if (!wanted.has(key)) { this._disposeTile(t); lvl.tiles.delete(key); continue; }
        // erst als fertig zählen, wenn die Einblendung abgeschlossen ist
        if (!t.done || (t.readyAt && now() < t.readyAt)) allLoaded = false;
      }
      if (originChanged || lvl._origin !== map._originKey) {
        for (const t of lvl.tiles.values()) this._placeTile(map, t);
        lvl._origin = map._originKey;
      }
      // Andere Zoomstufen: bleiben als Unterlage, bis die aktuelle fertig ist
      for (const [oz, other] of this._levels) {
        if (oz === z) continue;
        other.el.style.zIndex = 50 - Math.abs(oz - z);
        if (allLoaded || Math.abs(oz - z) > 2) { this._removeLevel(oz); continue; }
        if (originChanged || other._origin !== map._originKey) {
          for (const t of other.tiles.values()) this._placeTile(map, t);
          other._origin = map._originKey;
        }
      }
    }
    _placeTile(map, t) {
      // Kachelposition in den Weltkoordinaten der Referenz-Zoomstufe
      const f = Math.pow(2, map._tz - t.z);
      const size = TILE * f;
      t.el.style.width = t.el.style.height = (size + 0.5) + "px";
      t.el.style.transform = `translate(${t.x * size - map._origin.x}px, ${t.y * size - map._origin.y}px)`;
    }
    _createTile(lvl, x, y, z) {
      const n = Math.pow(2, z);
      const wx = ((x % n) + n) % n;     // horizontal umbrechen (Weltkopien)
      const el = create("div", "leaflet-tile", lvl.el);
      const img = create("img", "", el);
      img.alt = ""; img.draggable = false;
      img.setAttribute("role", "presentation");
      if (this.options.crossOrigin) img.crossOrigin = this.options.crossOrigin === true ? "" : this.options.crossOrigin;
      const t = { el, img, x, y, z, coords: { x: wx, y, z }, done: false, dead: false, objectUrl: null };
      if (this._map) this._placeTile(this._map, t);
      this._loadInto(t, t.coords, 0);
      return t;
    }
    /* Kachel laden; schlägt das fehl, die übergeordnete Kachel
     * (eine Zoomstufe gröber) als vergrößerten Ausschnitt zeigen. */
    _loadInto(t, coords, depth) {
      const url = this.getTileUrl(coords);
      const finish = (ok) => {
        if (t.dead) return;
        if (ok) {
          this._memo.set(url, true);
          if (depth === 0) {
            t.img.style.cssText = "";
          } else {
            const f = Math.pow(2, depth);
            const ox = t.coords.x - coords.x * f, oy = t.coords.y - coords.y * f;
            t.img.style.cssText = `width:${f * 100}%;height:${f * 100}%;left:${-ox * 100}%;top:${-oy * 100}%`;
          }
          t.el.classList.add("leaflet-tile-loaded");
          t.done = true;
          // Darunterliegende Zoomstufe bis nach dem Einblenden (0,2 s) halten,
          // sonst blitzt beim Zoomen kurz der graue Hintergrund durch
          t.readyAt = now() + TILE_FADE_MS;
          if (this._map) {
            this._map._requestRender();
            const map = this._map;
            clearTimeout(this._settleTimer);
            this._settleTimer = setTimeout(() => map._requestRender(), TILE_FADE_MS + 20);
          }
        } else if (depth < 5 && coords.z > (this.options.minZoom || 0)) {
          this._loadInto(t, { x: Math.floor(coords.x / 2), y: Math.floor(coords.y / 2), z: coords.z - 1 }, depth + 1);
        } else {
          t.done = true;               // aufgegeben: keine Lücke offen halten
          if (this._map) this._map._requestRender();
        }
      };
      const setSrc = (src, isObjectUrl) => {
        if (t.dead) { if (isObjectUrl) URL.revokeObjectURL(src); return; }
        if (t.objectUrl) { try { URL.revokeObjectURL(t.objectUrl); } catch (e) {} t.objectUrl = null; }
        if (isObjectUrl) t.objectUrl = src;
        t.img.onload = () => finish(true);
        t.img.onerror = () => finish(false);
        t.img.src = src;
      };
      const loader = this.options.loadTile;
      if (typeof loader === "function") {
        Promise.resolve()
          .then(() => loader.call(this, coords, url, { fallback: depth > 0 }))
          .then(res => {
            if (res instanceof Blob) setSrc(URL.createObjectURL(res), true);
            else if (typeof res === "string") setSrc(res, false);
            else finish(false);
          })
          .catch(() => finish(false));
      } else {
        setSrc(url, false);
      }
    }
  }

  /* ============================================================
   * Vektoren (SVG in der Weltebene)
   * ============================================================ */
  const SVG_NS = "http://www.w3.org/2000/svg";
  class Path extends Layer {
    onAdd(map) {
      this._path = document.createElementNS(SVG_NS, this._tag || "path");
      this._path._andromapLayer = this;
      map._svgRoot().appendChild(this._path);
      this._applyStyle();
      this._project(map);
    }
    onRemove() { if (this._path) this._path.remove(); this._path = null; }
    setStyle(style) { Object.assign(this.options, style || {}); this._applyStyle(); return this; }
    bringToFront() { if (this._path && this._path.parentNode) this._path.parentNode.appendChild(this._path); return this; }
    bringToBack() { if (this._path && this._path.parentNode) this._path.parentNode.insertBefore(this._path, this._path.parentNode.firstChild); return this; }
    redraw() { if (this._map) this._project(this._map); return this; }
    getElement() { return this._path; }
    _applyStyle() {
      const p = this._path, o = this.options;
      if (!p) return;
      const attr = (k, v) => (v == null ? p.removeAttribute(k) : p.setAttribute(k, v));
      if (o.stroke !== false) {
        attr("stroke", o.color || "#3388ff");
        attr("stroke-width", o.weight != null ? o.weight : 3);
        attr("stroke-opacity", o.opacity != null ? o.opacity : 1);
        attr("stroke-linecap", o.lineCap || "round");
        attr("stroke-linejoin", o.lineJoin || "round");
        attr("stroke-dasharray", o.dashArray || null);
      } else attr("stroke", "none");
      if (o.fill) {
        attr("fill", o.fillColor || o.color || "#3388ff");
        attr("fill-opacity", o.fillOpacity != null ? o.fillOpacity : 0.2);
      } else attr("fill", "none");
      p.setAttribute("vector-effect", "non-scaling-stroke");
      p.setAttribute("class", "leaflet-path" + (o.interactive !== false ? " leaflet-interactive" : "") + (o.className ? " " + o.className : ""));
      p.style.pointerEvents = o.interactive === false ? "none" : (o.fill ? "auto" : "stroke");
    }
  }

  class Polyline extends Path {
    constructor(latlngs, options) { super(options); this._setLatLngs(latlngs); }
    _setLatLngs(latlngs) {
      const conv = arr => (arr.length && (Array.isArray(arr[0]) && Array.isArray(arr[0][0]) || (Array.isArray(arr[0]) && arr[0].length && typeof arr[0][0] === "object")))
        ? arr.map(conv) : arr.map(p => toLatLng(p)).filter(Boolean);
      this._latlngs = conv(latlngs || []);
    }
    setLatLngs(latlngs) { this._setLatLngs(latlngs); if (this._map) this._project(this._map); return this.fire("redraw"); }
    getLatLngs() { return this._latlngs; }
    addLatLng(ll) { this._latlngs.push(toLatLng(ll)); return this.redraw(); }
    isEmpty() { return !this._latlngs.length; }
    getBounds() { return new LatLngBounds(this._flat()); }
    getCenter() { return this.getBounds().getCenter(); }
    _flat() { const out = []; const walk = a => a.forEach(p => (p instanceof LatLng ? out.push(p) : walk(p))); walk(this._latlngs); return out; }
    _project(map) {
      if (!this._path) return;
      const tz = map._tz, o = map._origin;
      const rings = this._latlngs.length && !(this._latlngs[0] instanceof LatLng) ? this._latlngs : [this._latlngs];
      let d = "";
      for (const ring of rings) {
        let first = true;
        for (const ll of ring) {
          const p = project(ll, tz);
          d += (first ? "M" : "L") + (p.x - o.x).toFixed(1) + " " + (p.y - o.y).toFixed(1);
          first = false;
        }
      }
      this._path.setAttribute("d", d || "M0 0");
    }
  }

  class Circle extends Path {
    constructor(latlng, options) {
      if (typeof options === "number") options = { radius: options };
      super(Object.assign({ fill: true }, options));
      this._tag = "circle";
      this._latlng = toLatLng(latlng);
      this._mRadius = this.options.radius != null ? this.options.radius : 10;
    }
    setLatLng(ll) { this._latlng = toLatLng(ll); return this.redraw(); }
    getLatLng() { return this._latlng; }
    setRadius(r) { this._mRadius = r; return this.redraw(); }
    getRadius() { return this._mRadius; }
    getBounds() {
      const dLat = this._mRadius / 111320, dLng = dLat / Math.max(0.01, Math.cos(this._latlng.lat * DEG));
      return new LatLngBounds([this._latlng.lat - dLat, this._latlng.lng - dLng], [this._latlng.lat + dLat, this._latlng.lng + dLng]);
    }
    _project(map) {
      if (!this._path) return;
      const p = project(this._latlng, map._tz).subtract(map._origin);
      const mPerPx = 2 * Math.PI * EARTH_R * Math.cos(this._latlng.lat * DEG) / worldSize(map._tz);
      this._path.setAttribute("cx", p.x.toFixed(1));
      this._path.setAttribute("cy", p.y.toFixed(1));
      this._path.setAttribute("r", Math.max(0, this._mRadius / mPerPx).toFixed(2));
    }
  }
  class CircleMarker extends Circle {
    // Radius in Pixeln: in Weltkoordinaten umrechnen, damit er beim Zoomen konstant bleibt
    _project(map) {
      if (!this._path) return;
      const p = project(this._latlng, map._tz).subtract(map._origin);
      this._path.setAttribute("cx", p.x.toFixed(1));
      this._path.setAttribute("cy", p.y.toFixed(1));
      this._path.setAttribute("r", (this._mRadius / Math.pow(2, map._zoom - map._tz)).toFixed(2));
    }
  }

  /* ============================================================
   * Icons und Marker (aufrecht, Bildschirmkoordinaten)
   * ============================================================ */
  class DivIcon {
    constructor(options) {
      this.options = Object.assign({ className: "leaflet-div-icon", iconSize: [12, 12], html: "" }, options || {});
    }
    createIcon() {
      const o = this.options;
      const el = create("div", "leaflet-marker-icon " + (o.className || ""));
      if (o.html instanceof Element) el.appendChild(o.html);
      else el.innerHTML = o.html || "";
      const size = o.iconSize ? toPoint(o.iconSize) : null;
      const anchor = o.iconAnchor ? toPoint(o.iconAnchor) : (size ? size.divideBy(2) : new Point(0, 0));
      if (size) { el.style.width = size.x + "px"; el.style.height = size.y + "px"; }
      el.style.marginLeft = -anchor.x + "px";
      el.style.marginTop = -anchor.y + "px";
      el._anchor = anchor;
      return el;
    }
  }
  const DEFAULT_PIN = `<svg width="25" height="41" viewBox="0 0 25 41"><path d="M12.5 0C5.6 0 0 5.6 0 12.5 0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0z" fill="#2a6fbf"/><circle cx="12.5" cy="12.5" r="5" fill="#fff"/></svg>`;
  const defaultIcon = () => new DivIcon({ html: DEFAULT_PIN, className: "andromap-default-icon", iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [0, -34] });

  class Handler {
    constructor(onToggle, on) { this._on = on !== false; this._toggle = onToggle; }
    enable() { if (!this._on) { this._on = true; this._toggle && this._toggle(true); } return this; }
    disable() { if (this._on) { this._on = false; this._toggle && this._toggle(false); } return this; }
    enabled() { return this._on; }
  }

  class Marker extends Layer {
    constructor(latlng, options) {
      super(Object.assign({ interactive: true, zIndexOffset: 0, draggable: false }, options));
      this._latlng = toLatLng(latlng);
      this.dragging = new Handler(null, !!this.options.draggable);
    }
    onAdd(map) {
      this._icon = (this.options.icon || defaultIcon()).createIcon();
      this._icon._andromapLayer = this;
      if (this.options.title) this._icon.title = this.options.title;
      if (this.options.opacity != null) this._icon.style.opacity = this.options.opacity;
      this._icon.classList.toggle("leaflet-interactive", this.options.interactive !== false);
      if (this.options.interactive === false) this._icon.style.pointerEvents = "none";
      map._panes.markerPane.appendChild(this._icon);
      this._bindPointer(map);
      map._markers.add(this);
      this._position(map);
      if (this._tooltip && this._tooltip.options.permanent) this.openTooltip();
    }
    onRemove(map) {
      map._markers.delete(this);
      if (this._icon) this._icon.remove();
      this._icon = null;
      this.closeTooltip();
      if (this._popup && map._openPopup === this._popup) map.closePopup();
    }
    getLatLng() { return this._latlng; }
    setLatLng(ll) {
      const old = this._latlng;
      this._latlng = toLatLng(ll);
      if (this._map) this._position(this._map);
      return this.fire("move", { oldLatLng: old, latlng: this._latlng });
    }
    setIcon(icon) {
      this.options.icon = icon;
      if (this._map) { const m = this._map; m.removeLayer(this); m.addLayer(this); }
      return this;
    }
    setZIndexOffset(z) { this.options.zIndexOffset = z; if (this._map) this._position(this._map); return this; }
    setOpacity(o) { this.options.opacity = o; if (this._icon) this._icon.style.opacity = o; return this; }
    getElement() { return this._icon; }
    getBounds() { return new LatLngBounds(this._latlng, this._latlng); }

    _position(map) {
      if (!this._icon) return;
      const p = map.latLngToContainerPoint(this._latlng);
      this._pos = p;
      const rot = this.options.rotateWithMap && map._bearing ? ` rotate(${-map._bearing}deg)` : "";
      const a = this._icon._anchor || new Point(0, 0);
      this._icon.style.transformOrigin = `${a.x}px ${a.y}px`;
      this._icon.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)${rot}`;
      this._icon.style.zIndex = Math.round(p.y) + (this.options.zIndexOffset || 0);
      if (this._tooltipEl) this._placeTooltip(map);
    }

    /* Klick, Ziehen, Tooltip-Hover */
    _bindPointer(map) {
      const el = this._icon;
      if (this.options.interactive === false) return;
      let start = null, dragging = false, pid = null;
      el.addEventListener("pointerdown", ev => {
        if (ev.button > 0) return;
        if (!this.dragging.enabled()) {
          // Nicht ziehbar: Die Karte übernimmt die Geste (Verschieben,
          // Pinch-Zoom). Ein Klick zählt nur, wenn der Finger/die Maus
          // ohne Bewegung und ohne zweiten Finger wieder losgelassen wird.
          map._markerTap = { marker: this, id: ev.pointerId, x: ev.clientX, y: ev.clientY };
          return;
        }
        ev.stopPropagation();
        map._markerPointer = true;
        start = { x: ev.clientX, y: ev.clientY, ll: this._latlng };
        dragging = false; pid = ev.pointerId;
        try { el.setPointerCapture(pid); } catch (e) {}
      });
      el.addEventListener("pointermove", ev => {
        if (!start || ev.pointerId !== pid || !this.dragging.enabled()) return;
        const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
        if (!dragging && Math.hypot(dx, dy) > 4) {
          dragging = true;
          el.classList.add("leaflet-dragging");
          this.fire("dragstart", { originalEvent: ev });
        }
        if (dragging) {
          const rect = map._container.getBoundingClientRect();
          const ll = map.containerPointToLatLng(new Point(ev.clientX - rect.left, ev.clientY - rect.top));
          this._latlng = ll;
          this._position(map);
          this.fire("drag", { latlng: ll, originalEvent: ev });
        }
      });
      const end = ev => {
        if (!start || ev.pointerId !== pid) return;
        const wasDrag = dragging;
        start = null; dragging = false;
        setTimeout(() => { map._markerPointer = false; }, 0);
        try { el.releasePointerCapture(pid); } catch (e) {}
        el.classList.remove("leaflet-dragging");
        if (ev.type === "pointercancel") return;
        if (wasDrag) {
          this.fire("move", { latlng: this._latlng });
          this.fire("dragend", { originalEvent: ev, distance: 0 });
        } else {
          this._tap(ev);
        }
      };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
      el.addEventListener("click", ev => ev.stopPropagation());
      el.addEventListener("dblclick", ev => { ev.stopPropagation(); this.fire("dblclick", { originalEvent: ev, latlng: this._latlng }); });
      el.addEventListener("contextmenu", ev => {
        ev.preventDefault(); ev.stopPropagation();
        this.fire("contextmenu", { originalEvent: ev, latlng: this._latlng, containerPoint: this._pos });
      });
      el.addEventListener("pointerenter", ev => {
        if (ev.pointerType === "mouse" && this._tooltip && !this._tooltip.options.permanent) this.openTooltip();
        this.fire("mouseover", { originalEvent: ev });
      });
      el.addEventListener("pointerleave", ev => {
        if (this._tooltip && !this._tooltip.options.permanent) this.closeTooltip();
        this.fire("mouseout", { originalEvent: ev });
      });
    }

    /* Klick auf den Marker (Marker-Klicks erreichen die Karte nicht) */
    _tap(ev) {
      suppressGhostClick(ev);
      this.fire("click", { latlng: this._latlng, originalEvent: ev, containerPoint: this._pos });
      if (this._popup) this.togglePopup();
    }

    /* Tooltip */
    bindTooltip(content, options) {
      this.unbindTooltip();
      this._tooltip = { content, options: Object.assign({ direction: "auto", offset: [0, 0] }, options || {}) };
      if (this._map && this._tooltip.options.permanent) this.openTooltip();
      return this;
    }
    unbindTooltip() { this.closeTooltip(); this._tooltip = null; return this; }
    openTooltip() {
      if (!this._tooltip || !this._map || this._tooltipEl) return this;
      const o = this._tooltip.options;
      const el = create("div", "leaflet-tooltip " + (o.className || ""), this._map._panes.tooltipPane);
      const c = typeof this._tooltip.content === "function" ? this._tooltip.content(this) : this._tooltip.content;
      if (c instanceof Element) el.appendChild(c); else el.innerHTML = c;
      this._tooltipEl = el;
      this._placeTooltip(this._map);
      return this;
    }
    closeTooltip() { if (this._tooltipEl) { this._tooltipEl.remove(); this._tooltipEl = null; } return this; }
    _placeTooltip(map) {
      const el = this._tooltipEl, o = this._tooltip.options;
      if (!el || !this._pos) return;
      const off = toPoint(o.offset || [0, 0]);
      let dir = o.direction;
      if (dir === "auto") dir = this._pos.x > map._size.x / 2 ? "left" : "right";
      el.className = el.className.replace(/\s*leaflet-tooltip-(left|right|top|bottom|center)/g, "") + " leaflet-tooltip-" + dir;
      const w = el.offsetWidth, h = el.offsetHeight;
      let x = this._pos.x + off.x, y = this._pos.y + off.y;
      if (dir === "right") { x += 6; y -= h / 2; }
      else if (dir === "left") { x -= w + 6; y -= h / 2; }
      else if (dir === "top") { x -= w / 2; y -= h + 6; }
      else if (dir === "bottom") { x -= w / 2; y += 6; }
      else { x -= w / 2; y -= h / 2; }
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    }

    /* Popup */
    bindPopup(content, options) { this._popup = new Popup(options, this); this._popup._content = content; return this; }
    unbindPopup() { if (this._popup) this.closePopup(); this._popup = null; return this; }
    openPopup() { if (this._popup && this._map) this._map.openPopup(this._popup); return this; }
    closePopup() { if (this._popup && this._map && this._map._openPopup === this._popup) this._map.closePopup(); return this; }
    togglePopup() {
      if (!this._popup || !this._map) return this;
      return this._map._openPopup === this._popup ? this.closePopup() : this.openPopup();
    }
    isPopupOpen() { return !!(this._popup && this._map && this._map._openPopup === this._popup); }
  }

  /* ============================================================
   * Popup (nur an Markern; Startseite)
   * ============================================================ */
  class Popup {
    constructor(options, source) {
      this.options = Object.assign({ maxWidth: 300, minWidth: 50, closeButton: true, autoPan: true }, options || {});
      this._source = source;
    }
    _open(map) {
      const el = create("div", "leaflet-popup " + (this.options.className || ""), map._panes.popupPane);
      if (this.options.closeButton) {
        const close = create("a", "leaflet-popup-close-button", el);
        close.href = "#"; close.innerHTML = "&#215;"; close.setAttribute("role", "button"); close.title = "Schließen";
        close.addEventListener("click", ev => { ev.preventDefault(); map.closePopup(); });
      }
      const wrap = create("div", "leaflet-popup-content-wrapper", el);
      const content = create("div", "leaflet-popup-content", wrap);
      content.style.maxWidth = this.options.maxWidth + "px";
      content.style.minWidth = this.options.minWidth + "px";
      const c = typeof this._content === "function" ? this._content(this._source) : this._content;
      if (c instanceof Element) content.appendChild(c); else content.innerHTML = c;
      const tipC = create("div", "leaflet-popup-tip-container", el);
      create("div", "leaflet-popup-tip", tipC);
      el.addEventListener("pointerdown", ev => ev.stopPropagation());
      el.addEventListener("wheel", ev => ev.stopPropagation(), { passive: true });
      el.addEventListener("click", ev => ev.stopPropagation());
      this._el = el;
      this._place(map);
      if (this.options.autoPan) this._autoPan(map);
    }
    _close() { if (this._el) this._el.remove(); this._el = null; }
    _place(map) {
      if (!this._el) return;
      const src = this._source;
      const p = map.latLngToContainerPoint(src.getLatLng());
      const icon = src.options.icon || defaultIcon();
      const pa = icon.options && icon.options.popupAnchor ? toPoint(icon.options.popupAnchor)
        : new Point(0, -((icon.options && icon.options.iconAnchor ? toPoint(icon.options.iconAnchor).y : 12)));
      const w = this._el.offsetWidth, h = this._el.offsetHeight;
      this._el.style.transform = `translate3d(${Math.round(p.x + pa.x - w / 2)}px, ${Math.round(p.y + pa.y - h - 10)}px, 0)`;
    }
    _autoPan(map) {
      const r = this._el.getBoundingClientRect(), cr = map._container.getBoundingClientRect();
      const pad = 10;
      let dx = 0, dy = 0;
      if (r.top < cr.top + pad) dy = r.top - cr.top - pad;
      if (r.left < cr.left + pad) dx = r.left - cr.left - pad;
      else if (r.right > cr.right - pad) dx = r.right - cr.right + pad;
      if (dx || dy) map.panBy([dx, dy], { animate: true });
    }
  }

  /* ============================================================
   * Bedienelemente
   * ============================================================ */
  class Control {
    constructor(options) { setOptions(this, options); }
    getPosition() { return this.options.position || "topright"; }
    getContainer() { return this._container; }
    addTo(map) {
      this.remove();
      this._map = map;
      const el = this._container = this.onAdd(map);
      el.classList.add("leaflet-control");
      DomEvent.disableClickPropagation(el);
      const corner = map._controlCorners[this.getPosition()] || map._controlCorners.topright;
      if (this.getPosition().indexOf("bottom") !== -1) corner.insertBefore(el, corner.firstChild);
      else corner.appendChild(el);
      return this;
    }
    remove() {
      if (!this._map) return this;
      if (this._container) this._container.remove();
      if (this.onRemove) this.onRemove(this._map);
      this._map = null;
      return this;
    }
    onAdd() { return create("div"); }
  }
  Control.prototype.options = { position: "topright" };
  makeExtendable(Control);

  class ZoomControl extends Control {
    onAdd(map) {
      const bar = create("div", "leaflet-control-zoom leaflet-bar");
      const mk = (cls, html, title, fn) => {
        const a = create("a", cls, bar);
        a.href = "#"; a.innerHTML = html; a.title = title; a.setAttribute("role", "button");
        a.addEventListener("click", ev => { ev.preventDefault(); fn(); });
        return a;
      };
      this._in = mk("leaflet-control-zoom-in", "+", map.options.zoomInTitle || "Hineinzoomen", () => map.zoomIn());
      this._out = mk("leaflet-control-zoom-out", "&#x2212;", map.options.zoomOutTitle || "Herauszoomen", () => map.zoomOut());
      this._upd = () => {
        this._in.classList.toggle("leaflet-disabled", map._zoom >= map.getMaxZoom());
        this._out.classList.toggle("leaflet-disabled", map._zoom <= map.getMinZoom());
      };
      map.on("zoomend", this._upd); this._upd();
      return bar;
    }
    onRemove(map) { map.off("zoomend", this._upd); }
  }
  ZoomControl.prototype.options = { position: "topleft" };

  class AttributionControl extends Control {
    onAdd(map) { this._el = create("div", "leaflet-control-attribution"); map._attributionControl = this; this.update(map); return this._el; }
    update(map) {
      if (!this._el) return;
      const parts = [];
      for (const l of map._layers) {
        const a = l.getAttribution && l.getAttribution();
        if (a && !parts.includes(a)) parts.push(a);
      }
      this._el.innerHTML = parts.join(" | ");
      this._el.style.display = parts.length ? "" : "none";
    }
  }
  AttributionControl.prototype.options = { position: "bottomright" };

  class ScaleControl extends Control {
    onAdd(map) {
      const el = create("div", "leaflet-control-scale");
      this._line = create("div", "leaflet-control-scale-line", el);
      this._upd = () => this._update(map);
      map.on("move zoomend resize", this._upd); this._update(map);
      return el;
    }
    onRemove(map) { map.off("move zoomend resize", this._upd); }
    _update(map) {
      const maxW = this.options.maxWidth || 100;
      const mPerPx = 2 * Math.PI * EARTH_R * Math.cos(map._center.lat * DEG) / worldSize(map._zoom);
      const maxM = mPerPx * maxW;
      const pow = Math.pow(10, Math.floor(Math.log10(maxM)));
      const d = maxM / pow;
      const nice = (d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1) * pow;
      this._line.style.width = Math.round(maxW * nice / maxM) + "px";
      this._line.textContent = nice >= 1000 ? (nice / 1000) + " km" : nice + " m";
    }
  }
  ScaleControl.prototype.options = { position: "bottomleft", maxWidth: 100, metric: true, imperial: false };

  /* Kompassnadel: zeigt nach Norden, erscheint bei gedrehter Karte.
   * Tipp → Karte wieder nach Norden ausrichten. */
  class CompassControl extends Control {
    onAdd(map) {
      const el = create("div", "leaflet-control-compass");
      const a = create("a", "", el);
      a.href = "#"; a.setAttribute("role", "button");
      a.title = map.options.compassTitle || "Nach Norden ausrichten";
      a.innerHTML = `<svg viewBox="0 0 40 40" aria-hidden="true">
          <polygon points="20,4 25.5,20 14.5,20" fill="#d64545"/>
          <polygon points="20,36 25.5,20 14.5,20" fill="#9aa4b1"/>
          <circle cx="20" cy="20" r="2.6" fill="#fff" stroke="#5b6573" stroke-width="1"/>
        </svg>`;
      this._needle = a.firstElementChild;
      a.addEventListener("click", ev => {
        ev.preventDefault();
        const e = map.fire("compassclick");
        if (!e._prevent) map.resetNorth();
      });
      this._upd = () => {
        this._needle.style.transform = `rotate(${-map._bearing}deg)`;
        el.classList.toggle("is-north", Math.abs(map._bearing) < 0.5 && !this.options.alwaysVisible);
      };
      map.on("rotate", this._upd); this._upd();
      return el;
    }
    onRemove(map) { map.off("rotate", this._upd); }
  }
  CompassControl.prototype.options = { position: "topright", alwaysVisible: false };

  /* ============================================================
   * Karte
   * ============================================================ */
  class AndroMap extends Evented {
    constructor(container, options) {
      super();
      this.options = Object.assign({
        minZoom: 0, maxZoom: undefined, zoomControl: true, attributionControl: true,
        rotate: true, touchRotate: undefined, compassControl: undefined, bearing: 0,
        inertia: true, zoomSnap: 1, worldCopyJump: true, wheelDebounceTime: 40,
        rotateThresholdDeg: 12,
      }, options || {});
      if (this.options.touchRotate === undefined) this.options.touchRotate = this.options.rotate;
      if (this.options.compassControl === undefined) this.options.compassControl = this.options.rotate;

      const el = typeof container === "string" ? document.getElementById(container) : container;
      if (!el) throw new Error("Karten-Container nicht gefunden");
      if (el._andromap) throw new Error("Karte ist bereits initialisiert");
      el._andromap = this;
      this._container = el;
      el.classList.add("leaflet-container", "andromap", "leaflet-touch");
      if (!el.hasAttribute("tabindex")) el.tabIndex = 0;

      this._layers = new Set();
      this._markers = new Set();
      this._center = new LatLng(0, 0);
      this._zoom = 1;
      this._bearing = 0;
      this._tz = 1;
      this._origin = new Point(0, 0);
      this._originKey = 0;
      this._size = new Point(el.clientWidth || 300, el.clientHeight || 300);

      this._initPanes();
      this._initControlCorners();
      this._initHandlers();

      if (this.options.center && this.options.zoom != null) this.setView(this.options.center, this.options.zoom, { animate: false });
      if (this.options.bearing) this.setBearing(this.options.bearing, { animate: false });
      if (this.options.zoomControl) this.zoomControl = new ZoomControl().addTo(this);
      if (this.options.attributionControl) this.attributionControl = new AttributionControl().addTo(this);
      if (this.options.compassControl) this.compassControl = new CompassControl().addTo(this);

      if (window.ResizeObserver) {
        this._ro = new ResizeObserver(() => this.invalidateSize());
        this._ro.observe(el);
      }
    }

    /* ---------- Aufbau ---------- */
    _initPanes() {
      const p = this._panes = {};
      p.mapPane = create("div", "leaflet-pane leaflet-map-pane", this._container);
      p.world = create("div", "leaflet-world", p.mapPane);
      p.tilePane = create("div", "leaflet-pane leaflet-tile-pane", p.world);
      p.overlayPane = create("div", "leaflet-pane leaflet-overlay-pane", p.world);
      p.markerPane = create("div", "leaflet-pane leaflet-marker-pane", p.mapPane);
      p.tooltipPane = create("div", "leaflet-pane leaflet-tooltip-pane", p.mapPane);
      p.popupPane = create("div", "leaflet-pane leaflet-popup-pane", p.mapPane);
    }
    _svgRoot() {
      if (!this._svg) {
        this._svg = document.createElementNS(SVG_NS, "svg");
        this._svg.setAttribute("class", "leaflet-zoom-animated");
        this._svg.setAttribute("width", "1"); this._svg.setAttribute("height", "1");
        this._svg.style.overflow = "visible";
        this._panes.overlayPane.appendChild(this._svg);
      }
      return this._svg;
    }
    _initControlCorners() {
      const c = this._controlCorners = {};
      const box = this._controlContainer = create("div", "leaflet-control-container", this._container);
      for (const v of ["top", "bottom"]) for (const h of ["left", "right"]) {
        c[v + h] = create("div", `leaflet-${v} leaflet-${h}`, box);
      }
    }
    getPane(name) { return this._panes[name]; }
    getContainer() { return this._container; }
    getSize() { return this._size.clone(); }

    /* ---------- Ebenen ---------- */
    addLayer(l) {
      if (this._layers.has(l)) return this;
      this._layers.add(l);
      l._map = this;
      l.onAdd(this);
      l.fire("add");
      return this;
    }
    removeLayer(l) {
      if (!l || !this._layers.has(l)) return this;
      this._layers.delete(l);
      l.onRemove(this);
      l._map = null;
      l.fire("remove");
      return this;
    }
    hasLayer(l) { return this._layers.has(l); }
    eachLayer(fn, ctx) { for (const l of Array.from(this._layers)) fn.call(ctx, l); return this; }
    _updateAttribution() { if (this._attributionControl) this._attributionControl.update(this); }

    /* ---------- Zustand ---------- */
    getCenter() { return this._center.clone(); }
    getZoom() { return this._zoom; }
    getBearing() { return this._bearing; }
    getMinZoom() { return this.options.minZoom || 0; }
    getMaxZoom() {
      if (this.options.maxZoom != null) return this.options.maxZoom;
      let m = -Infinity;
      for (const l of this._layers) if (l instanceof TileLayer && l.options.maxZoom != null) m = Math.max(m, l.options.maxZoom);
      return isFinite(m) ? m : 19;
    }
    getBounds() {
      const b = new LatLngBounds();
      const s = this._size;
      for (const p of [[0, 0], [s.x, 0], [0, s.y], [s.x, s.y]]) b.extend(this.containerPointToLatLng(new Point(p[0], p[1])));
      return b;
    }
    getPixelOrigin() { return this._origin.clone(); }

    /* ---------- Umrechnungen ---------- */
    project(ll, z) { return project(toLatLng(ll), z == null ? this._zoom : z); }
    unproject(p, z) { return unproject(toPoint(p), z == null ? this._zoom : z); }
    latLngToContainerPoint(ll) {
      ll = toLatLng(ll);
      const d = project(ll, this._zoom).subtract(project(this._center, this._zoom));
      // Weltkopie wählen, die der Mitte am nächsten liegt
      const ws = worldSize(this._zoom);
      if (d.x > ws / 2) d.x -= ws; else if (d.x < -ws / 2) d.x += ws;
      return rotate(d, -this._bearing).add(this._size.divideBy(2));
    }
    containerPointToLatLng(p) {
      p = toPoint(p);
      const d = rotate(p.subtract(this._size.divideBy(2)), this._bearing);
      return unproject(project(this._center, this._zoom).add(d), this._zoom);
    }
    latLngToLayerPoint(ll) { return this.latLngToContainerPoint(ll); }
    layerPointToLatLng(p) { return this.containerPointToLatLng(p); }
    mouseEventToContainerPoint(ev) {
      const r = this._container.getBoundingClientRect();
      return new Point(ev.clientX - r.left, ev.clientY - r.top);
    }
    mouseEventToLatLng(ev) { return this.containerPointToLatLng(this.mouseEventToContainerPoint(ev)); }
    distance(a, b) { return toLatLng(a).distanceTo(toLatLng(b)); }

    /* ---------- Ansicht setzen ---------- */
    _clampZoom(z) { return clamp(z, this.getMinZoom(), this.getMaxZoom()); }
    _normalizeCenter(c) {
      let lng = c.lng;
      if (this.options.worldCopyJump) lng = ((lng + 180) % 360 + 360) % 360 - 180;
      return new LatLng(clamp(c.lat, -MAX_LAT, MAX_LAT), lng);
    }

    /* Ansicht direkt setzen (ohne Animation) und Ereignisse auslösen. */
    _setRaw(center, zoom, bearing, opts) {
      opts = opts || {};
      const oldZoom = this._zoom, oldBearing = this._bearing;
      if (center) this._center = this._normalizeCenter(toLatLng(center));
      if (zoom != null) this._zoom = this._clampZoom(zoom);
      if (bearing != null) this._bearing = wrapDeg(bearing);
      if (this._zoom !== oldZoom) {
        if (!this._zooming) { this._zooming = true; this.fire("zoomstart"); }
        this.fire("zoom");
      }
      if (!this._moving) { this._moving = true; this.fire("movestart"); }
      this.fire("move");
      if (this._bearing !== oldBearing) this.fire("rotate", { bearing: this._bearing });
      this._render();
      if (!opts.keepMoving) this._endMove();
      return this;
    }
    _endMove() {
      if (this._zooming) { this._zooming = false; this.fire("zoomend"); }
      if (this._moving) { this._moving = false; this.fire("moveend"); }
    }

    setView(center, zoom, options) {
      options = options || {};
      const z = zoom == null ? this._zoom : this._snap(zoom);
      this.stop();
      if (options.animate === true || (options.animate !== false && options.pan && options.pan.animate)) {
        return this._animate({ center: toLatLng(center), zoom: z, duration: (options.duration || 0.3) * 1000 });
      }
      return this._setRaw(toLatLng(center), z, null);
    }
    setZoom(z, options) { return this.setView(this._center, z, options); }
    zoomIn(d, options) { return this._zoomAround(this._size.divideBy(2), this._zoom + (d || 1), options); }
    zoomOut(d, options) { return this._zoomAround(this._size.divideBy(2), this._zoom - (d || 1), options); }
    setZoomAround(ll, z, options) {
      const p = ll instanceof Point ? ll : this.latLngToContainerPoint(ll);
      return this._zoomAround(p, z, options);
    }
    panTo(ll, options) { return this.setView(ll, this._zoom, Object.assign({ animate: true }, options)); }
    panBy(offset, options) {
      const o = toPoint(offset);
      const c = this.containerPointToLatLng(this._size.divideBy(2).add(o));
      return options && options.animate === false ? this._setRaw(c, null, null) : this._animate({ center: c, duration: 250 });
    }
    flyTo(ll, zoom, options) {
      options = options || {};
      return this._animate({ center: toLatLng(ll), zoom: zoom == null ? this._zoom : this._snap(zoom),
        duration: (options.duration != null ? options.duration : 0.8) * 1000 });
    }
    flyToBounds(b, options) { return this.fitBounds(b, Object.assign({ animate: true, duration: 0.8 }, options)); }

    /* Zoomstufe, bei der bounds (mit Rand) ins Fenster passt — berücksichtigt die Drehung. */
    getBoundsZoom(bounds, inside, padding) {
      bounds = toBounds(bounds);
      const pad = padding ? toPoint(padding) : new Point(0, 0);
      const avail = this._size.subtract(pad.multiplyBy(2));
      const z0 = 0;
      const pts = [bounds.getNorthWest(), bounds.getNorthEast(), bounds.getSouthWest(), bounds.getSouthEast()]
        .map(ll => rotate(project(ll, z0), -this._bearing));
      const bx = new Bounds(); pts.forEach(p => bx.extend(p));
      const sz = bx.getSize();
      const scale = Math.min(avail.x / Math.max(sz.x, 1e-9), avail.y / Math.max(sz.y, 1e-9));
      let z = z0 + Math.log2(Math.max(scale, 1e-9));
      z = this.options.zoomSnap ? Math.floor(z / this.options.zoomSnap) * this.options.zoomSnap : z;
      return this._clampZoom(z);
    }
    fitBounds(bounds, options) {
      options = options || {};
      bounds = toBounds(bounds);
      if (!bounds.isValid()) return this;
      const ptl = toPoint(options.paddingTopLeft || options.padding || [0, 0]);
      const pbr = toPoint(options.paddingBottomRight || options.padding || [0, 0]);
      const pad = new Point(Math.max(ptl.x, pbr.x), Math.max(ptl.y, pbr.y));
      let z = this.getBoundsZoom(bounds, false, pad);
      if (options.maxZoom != null) z = Math.min(z, options.maxZoom);
      // Mitte in Mercator (nicht geografisch), Versatz bei asymmetrischem Rand
      const a = project(bounds.getSouthWest(), z), b = project(bounds.getNorthEast(), z);
      let c = new Point((a.x + b.x) / 2, (a.y + b.y) / 2);
      const shift = rotate(pbr.subtract(ptl).divideBy(2), this._bearing);
      c = c.add(shift);
      const center = unproject(c, z);
      this.stop();
      if (options.animate) return this._animate({ center, zoom: z, duration: (options.duration || 0.35) * 1000 });
      return this._setRaw(center, z, null);
    }
    setBearing(deg, options) {
      options = options || {};
      deg = wrapDeg(deg);
      if (!this.options.rotate && deg !== 0) return this;
      if (options.animate === false || options.duration === 0) { this.stopRotation(); return this._setRaw(null, null, deg); }
      return this._animateBearing(deg, (options.duration != null ? options.duration : 0.3) * 1000);
    }
    resetNorth(options) { return this.setBearing(0, options); }
    _snap(z) { const s = this.options.zoomSnap; return s ? Math.round(z / s) * s : z; }

    _zoomAround(pt, z, options) {
      z = this._clampZoom(this._snap(z));
      const ll = this.containerPointToLatLng(pt);
      // Mitte so wählen, dass ll unter pt bleibt
      const centerFor = zz => unproject(project(ll, zz).subtract(rotate(pt.subtract(this._size.divideBy(2)), this._bearing)), zz);
      if (options && options.animate === false) return this._setRaw(centerFor(z), z, null);
      return this._animate({ zoom: z, around: { ll, pt }, duration: 250 });
    }

    /* ---------- Animation ---------- */
    stop() {
      if (this._anim) { cancelAnimationFrame(this._anim.raf); this._anim = null; this._endMove(); }
      if (this._inertia) { cancelAnimationFrame(this._inertia); this._inertia = null; this._endMove(); }
      return this;
    }
    stopRotation() { if (this._rotAnim) { cancelAnimationFrame(this._rotAnim); this._rotAnim = null; } }
    _animate({ center, zoom, around, duration }) {
      this.stop();
      const z0 = this._zoom, z1 = zoom == null ? z0 : this._clampZoom(zoom);
      const c0 = project(this._center, z0);
      const c1 = center ? project(center, z0) : null;
      const t0 = now(), dur = Math.max(1, duration || 250);
      const anim = this._anim = { raf: 0, targetZoom: z1 };
      const step = () => {
        if (this._anim !== anim) return;
        const t = Math.min(1, (now() - t0) / dur), k = easeOut(t);
        const z = z0 + (z1 - z0) * k;
        let c;
        if (around) {
          c = unproject(project(around.ll, z).subtract(rotate(around.pt.subtract(this._size.divideBy(2)), this._bearing)), z);
        } else if (c1) {
          // Linear in Mercator-Pixeln der Startzoomstufe interpolieren
          c = unproject(new Point(c0.x + (c1.x - c0.x) * k, c0.y + (c1.y - c0.y) * k), z0);
        } else c = this._center;
        this._setRaw(c, z, null, { keepMoving: t < 1 });
        if (t < 1) anim.raf = requestAnimationFrame(step);
        else this._anim = null;
      };
      anim.raf = requestAnimationFrame(step);
      return this;
    }
    _animateBearing(target, duration) {
      this.stopRotation();
      const b0 = this._bearing;
      let d = target - b0;
      if (d > 180) d -= 360; else if (d < -180) d += 360;
      if (Math.abs(d) < 0.01) return this;
      const t0 = now();
      const step = () => {
        const t = Math.min(1, (now() - t0) / duration), k = easeOut(t);
        this._setRaw(null, null, b0 + d * k, { keepMoving: t < 1 });
        if (t < 1) this._rotAnim = requestAnimationFrame(step);
        else { this._rotAnim = null; this.fire("rotateend", { bearing: this._bearing }); }
      };
      this._rotAnim = requestAnimationFrame(step);
      return this;
    }

    /* ---------- Darstellung ---------- */
    invalidateSize() {
      const w = this._container.clientWidth, h = this._container.clientHeight;
      if (!w || !h) return this;
      if (w === this._size.x && h === this._size.y) { this._render(); return this; }
      this._size = new Point(w, h);
      this._render();
      this.fire("resize");
      return this;
    }
    _requestRender() {
      if (this._rafPending) return;
      this._rafPending = true;
      requestAnimationFrame(() => { this._rafPending = false; this._render(); });
    }
    _render() {
      const tz = clamp(Math.round(this._zoom), 0, 30);
      const cTz = project(this._center, tz);
      let originChanged = false;
      if (tz !== this._tz || Math.abs(cTz.x - this._origin.x) > 50000 || Math.abs(cTz.y - this._origin.y) > 50000) {
        this._tz = tz;
        this._origin = cTz.round();
        this._originKey++;
        originChanged = true;
      }
      // Weltebene: verschieben, skalieren, drehen (per GPU)
      const s = Math.pow(2, this._zoom - tz);
      const dx = this._origin.x - cTz.x, dy = this._origin.y - cTz.y;
      this._panes.world.style.transform =
        `translate(${this._size.x / 2}px, ${this._size.y / 2}px) rotate(${-this._bearing}deg) scale(${s}) translate(${dx}px, ${dy}px)`;
      for (const l of this._layers) {
        if (l instanceof TileLayer) l._update(this, originChanged);
        else if (originChanged && l._project) l._project(this);
      }
      for (const m of this._markers) m._position(this);
      if (this._openPopup) this._openPopup._place(this);
    }

    /* ---------- Popups ---------- */
    openPopup(popup) {
      this.closePopup();
      this._openPopup = popup;
      popup._open(this);
      const src = popup._source;
      if (src) src.fire("popupopen", { popup });
      this.fire("popupopen", { popup });
      return this;
    }
    closePopup() {
      const p = this._openPopup;
      if (!p) return this;
      p._close();
      this._openPopup = null;
      if (p._source) p._source.fire("popupclose", { popup: p });
      this.fire("popupclose", { popup: p });
      return this;
    }

    remove() {
      this.stop();
      if (this._ro) this._ro.disconnect();
      for (const l of Array.from(this._layers)) this.removeLayer(l);
      this._container.innerHTML = "";
      this._container._andromap = null;
      return this;
    }

    /* ============================================================
     * Bedienung: Ziehen, Pinch-Zoom, Drehen, Mausrad, Doppelklick
     * ============================================================ */
    _initHandlers() {
      const el = this._container;
      // Ohne Ziehen/Pinch darf der Browser wieder scrollen (wie Leaflet)
      const touchAction = () => {
        const d = this.dragging.enabled(), z = this.touchZoom.enabled();
        el.style.touchAction = d ? "" : z ? "pan-x pan-y" : "auto";
      };
      this.dragging = new Handler(touchAction);
      this.touchZoom = new Handler(touchAction);
      this.scrollWheelZoom = new Handler();
      this.doubleClickZoom = new Handler();
      this.boxZoom = new Handler();
      this.keyboard = new Handler();
      this.touchRotate = new Handler(null, !!this.options.touchRotate);
      if (this.options.dragging === false) this.dragging.disable();
      if (this.options.touchZoom === false) this.touchZoom.disable();
      if (this.options.scrollWheelZoom === false) this.scrollWheelZoom.disable();
      if (this.options.doubleClickZoom === false) this.doubleClickZoom.disable();
      touchAction();

      const pointers = new Map();     // pointerId → {x, y}
      let gesture = null;             // aktuelle Geste
      let lastTap = null;
      const samples = [];             // für Trägheit

      const local = ev => this.mouseEventToContainerPoint(ev);

      const startPan = (p) => ({ type: "pan", start: p, last: p, moved: false, centerPx: project(this._center, this._zoom), zoom: this._zoom });
      const startPinch = () => {
        const [a, b] = Array.from(pointers.values());
        const mid = new Point((a.x + b.x) / 2, (a.y + b.y) / 2);
        return {
          type: "pinch",
          d0: Math.max(10, Math.hypot(b.x - a.x, b.y - a.y)),
          a0: Math.atan2(b.y - a.y, b.x - a.x) / DEG,
          z0: this._zoom, b0: this._bearing,
          ll: this.containerPointToLatLng(mid),
          rotating: false, moved: true, mid,
        };
      };

      el.addEventListener("pointerdown", ev => {
        if (ev.button > 0 && ev.pointerType === "mouse") return;
        if (inControl(ev.target, el) || this._markerPointer) return;
        this.stop();
        this.stopRotation();
        // Klick auf eine Linie/einen Kreis mit eigenem click-Handler?
        const hit = ev.target && ev.target._andromapLayer;
        if (pointers.size === 0) {
          this._pathPointer = (hit instanceof Path && hit.listens("click"))
            ? { layer: hit, x: ev.clientX, y: ev.clientY } : null;
        }
        if (this._markerTap && (this._markerTap.id !== ev.pointerId || pointers.size > 0)) this._markerTap = null;
        pointers.set(ev.pointerId, local(ev));
        try { el.setPointerCapture(ev.pointerId); } catch (e) {}
        samples.length = 0;
        if (pointers.size === 1) gesture = this.dragging.enabled() ? startPan(local(ev)) : { type: "tap", start: local(ev), moved: false };
        else if (pointers.size === 2 && this.touchZoom.enabled()) {
          if (gesture && gesture.type === "pan" && gesture.moved) this.fire("dragend");
          gesture = startPinch();
        }
      });

      el.addEventListener("pointermove", ev => {
        if (!pointers.has(ev.pointerId)) return;
        const p = local(ev);
        pointers.set(ev.pointerId, p);
        if (!gesture) return;
        if (gesture.type === "tap") {
          if (p.distanceTo(gesture.start) > 6) gesture.moved = true;
          return;
        }
        if (gesture.type === "pan" && pointers.size === 1) {
          const dist = p.distanceTo(gesture.start);
          if (!gesture.moved) {
            if (dist < (ev.pointerType === "touch" ? 6 : 3)) return;
            gesture.moved = true;
            el.classList.add("leaflet-dragging");
            this.fire("dragstart");
          }
          // Mitte verschieben: Bildschirmversatz in Welt-Pixel zurückdrehen
          const off = rotate(p.subtract(gesture.start), this._bearing);
          const c = gesture.centerPx.subtract(off);
          samples.push({ t: now(), p });
          while (samples.length > 2 && samples[0].t < now() - 120) samples.shift();
          this._setRaw(unproject(c, gesture.zoom), null, null, { keepMoving: true });
          this.fire("drag");
        } else if (gesture.type === "pinch" && pointers.size >= 2) {
          const [a, b] = Array.from(pointers.values());
          const mid = new Point((a.x + b.x) / 2, (a.y + b.y) / 2);
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          const ang = Math.atan2(b.y - a.y, b.x - a.x) / DEG;
          const z = this._clampZoom(gesture.z0 + Math.log2(d / gesture.d0));
          let bearing = this._bearing;
          if (this.touchRotate.enabled() && this.options.rotate) {
            let da = ang - gesture.a0;
            if (da > 180) da -= 360; else if (da < -180) da += 360;
            if (!gesture.rotating && Math.abs(da) > this.options.rotateThresholdDeg) {
              gesture.rotating = true;
              gesture.a0 = ang; gesture.b0 = this._bearing; da = 0;
              this.fire("rotatestart");
            }
            if (gesture.rotating) bearing = gesture.b0 - da;
          }
          bearing = wrapDeg(bearing);
          // Mitte so, dass der Punkt unter den Fingern bleibt
          const offs = rotate(mid.subtract(this._size.divideBy(2)), bearing);
          const c = unproject(project(gesture.ll, z).subtract(offs), z);
          gesture.mid = mid;
          this._setRaw(c, z, bearing, { keepMoving: true });
        }
      });

      /* Nach Pinch/Drehen: Zoom auf ganze Stufen, Drehung nahe Norden einrasten. */
      const settle = (pt, rotating) => {
        const zt = this._clampZoom(this._snap(this._zoom));
        if (rotating) {
          if (Math.abs(this._bearing) < 7) this._animateBearing(0, 200);
          this.fire("rotateend", { bearing: this._bearing });
        }
        if (Math.abs(zt - this._zoom) > 1e-3) {
          this._animate({ zoom: zt, around: { ll: this.containerPointToLatLng(pt), pt }, duration: 200 });
        } else {
          this._zoom = zt;          // Rundungsrest entfernen
          this._render();
          this._endMove();
        }
      };

      const finish = ev => {
        if (!pointers.has(ev.pointerId)) return;
        const p = pointers.get(ev.pointerId);
        pointers.delete(ev.pointerId);
        try { el.releasePointerCapture(ev.pointerId); } catch (e) {}
        if (!gesture) return;
        const g = gesture;

        if (g.type === "pinch") {
          if (pointers.size === 1) {
            // Ein Finger bleibt: als Verschieben weitermachen, danach einrasten
            gesture = this.dragging.enabled()
              ? Object.assign(startPan(Array.from(pointers.values())[0]), { moved: true, afterPinch: g })
              : null;
            if (!gesture) settle(g.mid, g.rotating);
            return;
          }
          gesture = null;
          settle(g.mid, g.rotating);
          return;
        }
        if (pointers.size > 0) return;
        gesture = null;
        el.classList.remove("leaflet-dragging");

        if (g.type === "pan" && g.afterPinch) {
          settle(p, g.afterPinch.rotating);
          return;
        }
        if (g.type === "pan" && g.moved) {
          this._pathPointer = null;
          this.fire("dragend");
          // Trägheit
          const recent = samples.filter(s => s.t > now() - 100);
          if (this.options.inertia && !g.afterPinch && recent.length >= 2 && ev.type !== "pointercancel") {
            const a = recent[0], b = recent[recent.length - 1];
            const dt = Math.max(1, b.t - a.t);
            let v = b.p.subtract(a.p).divideBy(dt);           // px/ms
            const speed = Math.hypot(v.x, v.y);
            if (speed > 0.25) {
              v = v.multiplyBy(Math.min(1, 2.5 / speed));
              let last = now();
              const step = () => {
                const t = now(), dtt = t - last; last = t;
                v = v.multiplyBy(Math.pow(0.0035, dtt / 1000));
                if (Math.hypot(v.x, v.y) < 0.02) { this._inertia = null; this._endMove(); return; }
                const off = rotate(v.multiplyBy(dtt), this._bearing);
                const c = project(this._center, this._zoom).subtract(off);
                this._setRaw(unproject(c, this._zoom), null, null, { keepMoving: true });
                this._inertia = requestAnimationFrame(step);
              };
              this._inertia = requestAnimationFrame(step);
              return;
            }
          }
          this._endMove();
          return;
        }
        if (g.type === "pan" && !g.moved) this._endMove();
        if (ev.type === "pointercancel") return;
        // Tipp / Klick
        const mt = this._markerTap; this._markerTap = null;
        if (!g.moved && mt && mt.id === ev.pointerId && Math.hypot(ev.clientX - mt.x, ev.clientY - mt.y) < 8) {
          if (mt.marker._map === this) mt.marker._tap(ev);
          lastTap = null; this._pathPointer = null;
          return;
        }
        if (!g.moved) {
          const t = now();
          const isDouble = lastTap && t - lastTap.t < 320 && p.distanceTo(lastTap.p) < 30;
          if (this._pathPointer) {
            const pp = this._pathPointer; this._pathPointer = null;
            if (Math.hypot(ev.clientX - pp.x, ev.clientY - pp.y) < 6) {
              suppressGhostClick(ev);
              const e = pp.layer.fire("click", { latlng: this.containerPointToLatLng(p), containerPoint: p, originalEvent: ev });
              if (e._stopped) { lastTap = null; return; }
            }
          }
          this.fire("click", { latlng: this.containerPointToLatLng(p), containerPoint: p, originalEvent: ev });
          if (this._openPopup) this.closePopup();
          if (isDouble) {
            lastTap = null;
            this.fire("dblclick", { latlng: this.containerPointToLatLng(p), containerPoint: p, originalEvent: ev });
            if (this.doubleClickZoom.enabled()) this._zoomAround(p, this._zoom + (ev.shiftKey ? -1 : 1));
          } else lastTap = { t, p };
        }
      };
      el.addEventListener("pointerup", finish);
      el.addEventListener("pointercancel", finish);

      // Rechtsklick / langes Drücken (Browser-Kontextmenü)
      el.addEventListener("contextmenu", ev => {
        if (inControl(ev.target, el)) return;
        ev.preventDefault();
        const p = local(ev);
        this.fire("contextmenu", { latlng: this.containerPointToLatLng(p), containerPoint: p, originalEvent: ev });
      });

      // Mausrad: entprellt, Zoom um den Mauszeiger
      let wheelDelta = 0, wheelTimer = null, wheelPt = null;
      el.addEventListener("wheel", ev => {
        if (!this.scrollWheelZoom.enabled() || inControl(ev.target, el)) return;
        ev.preventDefault();
        wheelDelta += ev.deltaMode === 1 ? ev.deltaY * 20 : ev.deltaY;
        wheelPt = local(ev);
        if (wheelTimer) return;
        wheelTimer = setTimeout(() => {
          wheelTimer = null;
          const steps = clamp(-wheelDelta / 100, -3, 3);
          wheelDelta = 0;
          const dz = Math.abs(steps) < 1 ? Math.sign(steps) : Math.round(steps);
          if (!dz) return;
          const base = this._anim && this._anim.targetZoom != null ? this._anim.targetZoom : this._zoom;
          this._zoomAround(wheelPt, base + dz);
        }, this.options.wheelDebounceTime);
      }, { passive: false });

      // Doppelklick der Maus wird oben über die Tipp-Erkennung behandelt
      el.addEventListener("dblclick", ev => ev.preventDefault());

      // Tastatur
      el.addEventListener("keydown", ev => {
        if (!this.keyboard.enabled() || ev.target !== el) return;
        const step = 80;
        const k = ev.key;
        if (k === "+" || k === "=") this.zoomIn();
        else if (k === "-" || k === "_") this.zoomOut();
        else if (k.startsWith("Arrow")) {
          const off = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[k];
          this.panBy(off);
        } else return;
        ev.preventDefault();
      });
    }
  }

  /* ============================================================
   * Öffentliche Schnittstelle (Leaflet-kompatibel)
   * ============================================================ */
  const TileLayerCtor = makeExtendable(TileLayer);
  const L = {
    version: "andromap-1.0",
    Point, Bounds, LatLng, LatLngBounds, Evented, Layer, LayerGroup,
    TileLayer: TileLayerCtor, Path, Polyline, Circle, CircleMarker, Marker, DivIcon, Control,
    Map: AndroMap, DomUtil, DomEvent, Popup,
    map: (el, opts) => new AndroMap(el, opts),
    tileLayer: (url, opts) => new TileLayerCtor(url, opts),
    marker: (ll, opts) => new Marker(ll, opts),
    divIcon: opts => new DivIcon(opts),
    polyline: (lls, opts) => new Polyline(lls, opts),
    circle: (ll, opts) => new Circle(ll, opts),
    circleMarker: (ll, opts) => new CircleMarker(ll, Object.assign({ radius: 10 }, opts)),
    layerGroup: (ls, opts) => new LayerGroup(ls, opts),
    featureGroup: (ls, opts) => new LayerGroup(ls, opts),
    latLng: (a, b) => toLatLng(a, b),
    latLngBounds: (a, b) => new LatLngBounds(a, b),
    point: (x, y) => toPoint(x, y),
    bounds: (a, b) => new Bounds(a, b),
    svg: () => ({ _renderer: "svg" }),
    canvas: () => ({ _renderer: "svg" }),
    control: {
      zoom: o => new ZoomControl(o),
      scale: o => new ScaleControl(o),
      attribution: o => new AttributionControl(o),
      compass: o => new CompassControl(o),
    },
    // Hilfen für Tests und eigene Erweiterungen
    _project: project,
    _unproject: unproject,
  };
  L.Control.Zoom = ZoomControl;
  L.Control.Scale = ScaleControl;
  L.Control.Attribution = AttributionControl;
  L.Control.Compass = CompassControl;

  window.AndroMap = L;
  window.L = L;
})();
