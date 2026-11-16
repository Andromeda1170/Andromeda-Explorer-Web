#!/usr/bin/env python3
"""
geo-gateway — Tor zu Routing und Geodaten
=========================================

Ein Dienst für alles, was die Website an Geodaten von anderen Diensten
holt (vorher brouter-proxy.py und andromeda-proxy.py):

    GET  /brouter?lonlats=…&profile=…   → lokaler BRouter (Fair-Queue)
    POST /profile/prepare               → angepasstes BRouter-Profil anlegen
    GET  /nominatim/search|reverse?…    → nominatim.openstreetmap.org (Cache)
    POST /overpass                      → overpass-api.de (Cache)

Schutz:
- Rate-Limits pro IP; globale Taktung für Nominatim (max. 1/s, deren
  Nutzungsregel) und Overpass; Tageskontingente für Overpass.
- BRouter bekommt nie mehr gleichzeitige Anfragen, als er Threads hat
  (Fair-Queue: kurze Routen haben einen eigenen Slot, lange werden
  nach Kosten mit „Altern“ eingereiht). Verlässt der Browser die
  Anfrage (neue Einstellungen im Routenplaner), wird sie verworfen.
- Profilwerte werden streng geprüft, bevor sie in ein .brf geschrieben
  werden.
- Antworten von Nominatim (30 Tage) und Overpass (7 Tage) landen in
  einer SQLite-Datei. Treffer verbrauchen keine Kontingente.

Schreibt nur: Paths.profiles (tourpack_*.brf) und Paths.geo_cache.
"""

import hashlib
import json
import math
import os
import re
import select
import socket
import sqlite3
import threading
import time
import uuid
from urllib.parse import parse_qs, urlencode, urlparse

from andromeda_lib import (
    BROUTER_URL, ORIGIN, PORT_GEO, BaseHandler, DailyQuota, GlobalPacer,
    Paths, SlidingWindowLimiter, TokenBucket, http_request, make_logger,
    run_forever, serve,
)

log = make_logger("geo")

# =============================================================================
# KONFIGURATION
# =============================================================================
# --- BRouter ---
BROUTER_TIMEOUT_S = 30
BROUTER_RATE = SlidingWindowLimiter(120, 60, 180)     # pro IP
MAX_URL_LEN = 8 * 1024
MAX_BODY_BYTES = 16 * 1024
MAX_LONLATS_POINTS = 40
MAX_PROFILE_CHANGES = 40

ALLOWED_BROUTER_PARAMS = {"lonlats", "profile", "format", "alternativeidx", "timode"}
ALLOWED_FORMATS = {"geojson", "gpx", "kml", "csv"}
PROFILE_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
CHANGE_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,60}$")
# Werte landen als Text im Profil: keine Leerzeichen, Zeilenumbrüche,
# Kommentarzeichen o. ä. (sonst ließen sich Profilzeilen einschleusen).
CHANGE_VALUE_RE = re.compile(r"^[A-Za-z0-9_.+-]{1,64}$")
PROFILE_MAX_AGE_S = 30 * 60

# Gleich der Thread-Zahl, mit der BRouter läuft (vorletztes Argument im
# brouter.service). Davon ist ein Slot kurzen Routen vorbehalten.
BROUTER_MAX_CONCURRENT = max(1, int(os.environ.get("ANDROMEDA_BROUTER_THREADS", "3")))
RESERVED_SLOTS = 1 if BROUTER_MAX_CONCURRENT > 1 else 0
SHARED_SLOTS = BROUTER_MAX_CONCURRENT - RESERVED_SLOTS
SHORT_ROUTE_THRESHOLD_M = 50_000.0     # längstes Einzelsegment
SHORT_ROUTE_MAX_TOTAL_M = 200_000.0
BROUTER_QUEUE_TIMEOUT_S = 60
BROUTER_QUEUE_MAX_WAITING = 10
CLIENT_CHECK_INTERVAL_S = 0.25         # Abbruch durch den Browser erkennen
AGING_RATE_MPS = 1000.0                # Wartezeit macht Routen „kürzer“
MAX_COST_M = 500_000.0
DEFAULT_COST_M = 50_000.0

# --- Nominatim / Overpass ---
NOMINATIM_TARGET = "https://nominatim.openstreetmap.org"
NOMINATIM_ENDPOINTS = {"/search", "/reverse"}
OVERPASS_TARGET = "https://overpass-api.de/api/interpreter"
UPSTREAM_TIMEOUT_S = 60
MAX_OVERPASS_BODY = 64 * 1024

CACHE_TTL_NOMINATIM = 30 * 86400
CACHE_TTL_OVERPASS = 7 * 86400

nominatim_pacer = GlobalPacer(1.0, 20)        # Nominatim: max. 1/s gesamt
overpass_pacer = GlobalPacer(1.0, 20)
nominatim_per_ip = TokenBucket(1.0, 5)
overpass_per_ip = TokenBucket(1.0, 10)
overpass_daily_per_ip = DailyQuota(100)
overpass_daily_global = DailyQuota(10_000)


# =============================================================================
# CACHE (SQLite)
# =============================================================================
class ResponseCache:
    def __init__(self, path):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS responses ("
            " key TEXT PRIMARY KEY, body BLOB NOT NULL,"
            " content_type TEXT NOT NULL, created_at REAL NOT NULL)")
        self._db.commit()

    def get(self, key, ttl):
        with self._lock:
            row = self._db.execute(
                "SELECT body, content_type, created_at FROM responses WHERE key=?",
                (key,)).fetchone()
        if not row or time.time() - row[2] > ttl:
            return None
        return row[0], row[1]

    def put(self, key, body, content_type):
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO responses VALUES (?, ?, ?, ?)",
                (key, body, content_type, time.time()))
            self._db.commit()

    def purge(self):
        cutoff_n = time.time() - CACHE_TTL_NOMINATIM
        cutoff_o = time.time() - CACHE_TTL_OVERPASS
        with self._lock:
            cur = self._db.execute(
                "DELETE FROM responses WHERE (key LIKE 'n:%' AND created_at < ?)"
                " OR (key LIKE 'o:%' AND created_at < ?)", (cutoff_n, cutoff_o))
            self._db.commit()
            n = cur.rowcount
        if n:
            log(f"Cache: {n} abgelaufene Einträge entfernt")


cache = None   # wird in main() angelegt


# =============================================================================
# BROUTER: KOSTEN UND FAIR-QUEUE
# =============================================================================
def _approx_distance_m(lon1, lat1, lon2, lat2):
    lat_mid = math.radians((lat1 + lat2) / 2.0)
    dx = (lon2 - lon1) * math.cos(lat_mid) * 111320.0
    dy = (lat2 - lat1) * 110540.0
    return math.hypot(dx, dy)


def parse_lonlats(value):
    """[(lon, lat), …] oder Fehlertext."""
    parts = (value or "").split("|")
    if len(parts) < 2:
        return "mindestens 2 Punkte nötig"
    if len(parts) > MAX_LONLATS_POINTS:
        return f"zu viele Punkte ({len(parts)} > {MAX_LONLATS_POINTS})"
    points = []
    for p in parts:
        try:
            lon_s, lat_s = p.split(",", 1)
            lon, lat = float(lon_s), float(lat_s)
        except ValueError:
            return f"ungültiger Punkt: {p[:40]!r}"
        if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
            return f"Punkt außerhalb des Wertebereichs: {p[:40]!r}"
        points.append((lon, lat))
    return points


def route_cost(points, alternativeidx):
    """(Gesamtkosten in m, längstes Einzelsegment in m)"""
    total, longest = 0.0, 0.0
    for (lon1, lat1), (lon2, lat2) in zip(points, points[1:]):
        seg = _approx_distance_m(lon1, lat1, lon2, lat2)
        total += seg
        longest = max(longest, seg)
    total *= alternativeidx + 1
    return min(total, MAX_COST_M), longest


class FairDispatcher:
    """Vergibt BRouter-Slots. Ein Slot ist kurzen Routen vorbehalten
    (FIFO), die übrigen werden nach Kosten vergeben, wobei Wartezeit
    die Kosten senkt (Altern), damit lange Routen nicht verhungern."""

    def __init__(self, reserved, shared, max_waiting):
        self.reserved, self.shared, self.max_waiting = reserved, shared, max_waiting
        self.cv = threading.Condition()
        self.items = []
        self.reserved_running = 0
        self.shared_running = 0
        threading.Thread(target=self._loop, daemon=True, name="dispatch").start()

    def acquire(self, cost, is_short, timeout, cancelled):
        """(ok, grund, slot)"""
        with self.cv:
            if len(self.items) >= self.max_waiting:
                return False, "queue_full", None
            item = {"cost": cost, "short": is_short, "arrival": time.monotonic(),
                    "event": threading.Event(), "state": "queued", "slot": None}
            self.items.append(item)
            self.cv.notify()
        deadline = time.monotonic() + timeout
        reason = "timeout"
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            if item["event"].wait(min(remaining, CLIENT_CHECK_INTERVAL_S)):
                reason = None
                break
            if cancelled():
                reason = "cancelled"
                break
        with self.cv:
            if item["state"] == "dispatched":
                if reason == "cancelled":
                    self._free(item["slot"])
                    return False, reason, None
                return True, None, item["slot"]
            if item in self.items:
                self.items.remove(item)
            item["state"] = "cancelled"
            return False, reason or "timeout", None

    def release(self, slot):
        with self.cv:
            self._free(slot)

    def _free(self, slot):
        if slot == "reserved":
            self.reserved_running = max(0, self.reserved_running - 1)
        else:
            self.shared_running = max(0, self.shared_running - 1)
        self.cv.notify()

    def _loop(self):
        with self.cv:
            while True:
                if not self._dispatch():
                    self.cv.wait()

    def _give(self, item, slot):
        self.items.remove(item)
        item["state"], item["slot"] = "dispatched", slot
        item["event"].set()

    def _dispatch(self):
        progressed = False
        if self.reserved_running < self.reserved:
            shorts = [i for i in self.items if i["short"]]
            if shorts:
                self.reserved_running += 1
                self._give(min(shorts, key=lambda i: i["arrival"]), "reserved")
                progressed = True
        now = time.monotonic()
        while self.shared_running < self.shared and self.items:
            best = min(self.items, key=lambda i: max(
                0.0, i["cost"] - (now - i["arrival"]) * AGING_RATE_MPS))
            self.shared_running += 1
            self._give(best, "shared")
            progressed = True
        return progressed


dispatcher = FairDispatcher(RESERVED_SLOTS, SHARED_SLOTS, BROUTER_QUEUE_MAX_WAITING)


# =============================================================================
# PROFILE
# =============================================================================
def format_value(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return repr(v)
    return str(v)


def valid_change_value(v):
    if isinstance(v, bool):
        return True
    if isinstance(v, int):
        return abs(v) < 10**12
    if isinstance(v, float):
        return math.isfinite(v)
    return isinstance(v, str) and bool(CHANGE_VALUE_RE.match(v))


def set_profile_value(text, key, value):
    pattern = re.compile(
        rf"^([ \t]*assign[ \t]+{re.escape(key)}[ \t]*=?[ \t]*)([^\n#]*?)([ \t]*)(#.*|$)",
        re.MULTILINE)
    # Ersatz als Funktion: der Wert wird nie als Regex-Ersatzmuster gelesen
    new_text, n = pattern.subn(lambda m: m.group(1) + value + m.group(3) + m.group(4), text)
    return new_text, n > 0


def cleanup_old_profiles(max_age_s=PROFILE_MAX_AGE_S):
    deleted, now = 0, time.time()
    for p in Paths.profiles.glob("tourpack_*.brf"):
        try:
            if max_age_s <= 0 or now - p.stat().st_mtime >= max_age_s:
                p.unlink()
                deleted += 1
        except FileNotFoundError:
            pass
        except OSError as e:
            log(f"! {p.name} nicht löschbar: {e}")
    return deleted


# =============================================================================
# HTTP
# =============================================================================
class Handler(BaseHandler):
    timeout = 20
    log = staticmethod(log)

    def client_gone(self):
        """True, wenn der Browser die Verbindung geschlossen hat."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            if not readable:
                return False
            return self.connection.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/brouter":
            self.cors_origin = ORIGIN
            ok, wait = BROUTER_RATE.check(self.client_ip())
            if not ok:
                return self.send_too_many(wait)
            return self.handle_brouter("GET", None)
        if path.startswith("/nominatim/"):
            self.cors_origin = "*"
            return self.handle_nominatim()
        self.send_text(404, "Nicht gefunden.")

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/overpass":
            self.cors_origin = "*"
            return self.handle_overpass()
        if path not in ("/profile/prepare", "/brouter"):
            return self.send_text(404, "Nicht gefunden.")
        self.cors_origin = ORIGIN
        ok, wait = BROUTER_RATE.check(self.client_ip())
        if not ok:
            return self.send_too_many(wait)
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.send_text(400, "Ungültiger Content-Length-Header.")
        if length < 0 or length > MAX_BODY_BYTES:
            return self.send_text(413, f"Body zu groß (max. {MAX_BODY_BYTES} B).")
        body = self.rfile.read(length) if length else b""
        if path == "/profile/prepare":
            return self.handle_prepare(body)
        return self.handle_brouter("POST", body)

    # --- /profile/prepare ---------------------------------------------------
    def handle_prepare(self, body):
        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self.send_json(400, {"error": "Ungültiges JSON."})
        if not isinstance(data, dict):
            return self.send_json(400, {"error": "Body muss ein JSON-Objekt sein."})
        profile = str(data.get("profile", "")).strip()
        changes = data.get("changes") or {}
        if not PROFILE_NAME_RE.match(profile):
            return self.send_json(400, {"error": "Ungültiger Profilname."})
        if not isinstance(changes, dict) or len(changes) > MAX_PROFILE_CHANGES:
            return self.send_json(400, {"error": "Ungültige oder zu viele Änderungen."})
        for k, v in changes.items():
            if not isinstance(k, str) or not CHANGE_KEY_RE.match(k):
                return self.send_json(400, {"error": f"Ungültiger Schlüssel: {str(k)[:60]!r}"})
            if not valid_change_value(v):
                return self.send_json(400, {"error": f"Ungültiger Wert für {k!r}."})

        src = Paths.profiles_src / f"{profile}.brf"
        if not src.is_file():
            return self.send_json(404, {
                "error": f"Profil nicht gefunden: {profile}",
                "verfügbar": sorted(p.stem for p in Paths.profiles_src.glob("*.brf")),
            })
        deleted = cleanup_old_profiles()
        text = src.read_text(encoding="utf-8")
        applied, not_found = [], []
        for key, value in changes.items():
            text, ok = set_profile_value(text, key, format_value(value))
            (applied if ok else not_found).append(
                f"{key}={format_value(value)}" if ok else key)

        name = f"tourpack_{int(time.time() * 1000)}_{uuid.uuid4().hex[:4]}"
        try:
            (Paths.profiles / f"{name}.brf").write_text(text, encoding="utf-8")
        except OSError as e:
            self.rlog(f"! Profil schreiben fehlgeschlagen: {e}")
            return self.send_json(500, {"error": "Profil konnte nicht angelegt werden."})
        self.rlog(f"prepare: {profile} → {name} ({len(applied)} geändert)")
        self.send_json(200, {"profile_name": name, "base": profile, "applied": applied,
                             "not_found": not_found, "deleted_old": deleted})

    # --- /brouter -----------------------------------------------------------
    def handle_brouter(self, method, body):
        if len(self.path) > MAX_URL_LEN:
            return self.send_text(414, "URL zu lang.")
        qs_raw = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        qs = {k: v[:1] for k, v in qs_raw.items() if k in ALLOWED_BROUTER_PARAMS}

        points = parse_lonlats((qs.get("lonlats") or [""])[0])
        if isinstance(points, str):
            return self.send_json(400, {"error": f"lonlats ungültig: {points}"})
        if "profile" in qs and not PROFILE_NAME_RE.match(qs["profile"][0]):
            return self.send_json(400, {"error": "Ungültiger Profilname."})
        qs.setdefault("format", ["geojson"])
        if qs["format"][0] not in ALLOWED_FORMATS:
            return self.send_json(400, {"error": "Ungültiges Format."})
        try:
            alt = max(0, min(3, int(qs.get("alternativeidx", ["0"])[0])))
            timode = max(0, min(9, int(qs.get("timode", ["1"])[0])))
        except ValueError:
            return self.send_json(400, {"error": "Ungültige Zahl."})
        qs["alternativeidx"], qs["timode"] = [str(alt)], [str(timode)]

        cost, longest = route_cost(points, alt)
        is_short = longest < SHORT_ROUTE_THRESHOLD_M and cost < SHORT_ROUTE_MAX_TOTAL_M
        t0 = time.monotonic()
        ok, reason, slot = dispatcher.acquire(cost, is_short, BROUTER_QUEUE_TIMEOUT_S,
                                              self.client_gone)
        waited = time.monotonic() - t0
        if not ok:
            if reason == "cancelled":
                self.rlog(f"abgebrochen nach {waited:.1f}s in der Warteschlange")
                self.close_connection = True
                return
            self.rlog(f"BLOCK — BRouter ausgelastet ({reason}, {waited:.1f}s)")
            return self.send_text(503, "Routenberechnung ausgelastet. Bitte in wenigen "
                                       "Sekunden erneut versuchen.", {"Retry-After": "5"})
        try:
            self._run_brouter(method, body, qs, cost, waited)
        finally:
            dispatcher.release(slot)

    def _run_brouter(self, method, body, qs, cost, waited):
        url = f"{BROUTER_URL}/brouter?" + urlencode(qs, doseq=True)
        headers = {}
        if body is not None:
            headers["Content-Type"] = self.headers.get("Content-Type", "text/plain")
        # Upstream in eigenem Thread, damit ein Abbruch des Browsers
        # erkannt wird. Eine laufende BRouter-Berechnung lässt sich über
        # HTTP nicht stoppen; der Slot bleibt bis zum Ende belegt, das
        # Ergebnis wird verworfen.
        result = {}

        def fetch():
            try:
                result["r"] = http_request(url, data=body, headers=headers,
                                           method=method, timeout=BROUTER_TIMEOUT_S)
            except Exception as e:  # noqa: BLE001 — wird unten ausgewertet
                result["e"] = e

        worker = threading.Thread(target=fetch, daemon=True, name="brouter-call")
        t0 = time.monotonic()
        worker.start()
        gone = False
        while worker.is_alive():
            worker.join(CLIENT_CHECK_INTERVAL_S)
            if worker.is_alive() and not gone and self.client_gone():
                gone = True
                self.rlog("Browser hat abgebrochen — Ergebnis wird verworfen")
        if gone or self.client_gone():
            self.close_connection = True
            return
        took = time.monotonic() - t0
        if "e" in result:
            self.rlog(f"! BRouter nicht erreichbar: {result['e']}")
            return self.send_text(502, "Routing-Server nicht erreichbar.")
        status, rheaders, data = result["r"]
        if status != 200:
            preview = data[:300].decode("utf-8", "replace").strip()
            self.rlog(f"! BRouter {status}: {preview}")
            return self.send_bytes(502, data or b"BRouter-Fehler",
                                   "text/plain; charset=utf-8")
        self.rlog(f"brouter {cost / 1000:.0f} km → {len(data)} B "
                  f"(gewartet {waited:.1f}s, gerechnet {took:.1f}s)")
        self.send_bytes(200, data, rheaders.get("Content-Type", "application/json"))

    # --- /nominatim ---------------------------------------------------------
    def handle_nominatim(self):
        parsed = urlparse(self.path)
        endpoint = parsed.path[len("/nominatim"):]
        if endpoint not in NOMINATIM_ENDPOINTS or len(self.path) > 2048:
            return self.send_text(404, "Nicht gefunden.")
        url = f"{NOMINATIM_TARGET}{endpoint}" + (f"?{parsed.query}" if parsed.query else "")
        key = "n:" + url

        hit = cache.get(key, CACHE_TTL_NOMINATIM)
        if hit:
            return self.send_bytes(200, hit[0], hit[1])

        ok, wait = nominatim_per_ip.check(self.client_ip())
        if not ok:
            return self.send_too_many(wait)
        if not nominatim_pacer.acquire():
            return self.send_text(503, "Ortssuche ist gerade ausgelastet. Bitte gleich "
                                       "erneut versuchen.", {"Retry-After": "3"})
        try:
            status, h, data = http_request(url, headers={"Referer": ORIGIN + "/",
                                                    "Accept-Language": "de"},
                                           timeout=UPSTREAM_TIMEOUT_S)
        except OSError as e:
            self.rlog(f"! Nominatim nicht erreichbar: {e}")
            return self.send_text(502, "Ortssuche nicht erreichbar.")
        ctype = h.get("Content-Type", "application/json")
        if status == 200:
            cache.put(key, data, ctype)
        else:
            self.rlog(f"! Nominatim {status}")
        self.send_bytes(status, data, ctype)

    # --- /overpass ----------------------------------------------------------
    def handle_overpass(self):
        body = self.read_body(MAX_OVERPASS_BODY)
        if not body:
            return self.send_text(400, "Leerer oder zu großer Body.")
        key = "o:" + hashlib.sha256(body).hexdigest()
        hit = cache.get(key, CACHE_TTL_OVERPASS)
        if hit:
            return self.send_bytes(200, hit[0], hit[1])

        ip = self.client_ip()
        ok, wait = overpass_per_ip.check(ip)
        if not ok:
            return self.send_too_many(wait)
        ok, remaining = overpass_daily_per_ip.consume(ip)
        if not ok:
            return self.send_text(429, "Tageslimit für die POI-Suche erreicht. Bitte "
                                       "morgen erneut versuchen.", {"Retry-After": "3600"})
        if not overpass_daily_global.consume("all")[0]:
            self.rlog("! globales Overpass-Tageslimit erreicht")
            return self.send_text(429, "Tageslimit für die POI-Suche erreicht. Bitte "
                                       "morgen erneut versuchen.", {"Retry-After": "3600"})
        if not overpass_pacer.acquire():
            return self.send_text(503, "POI-Suche ist gerade ausgelastet. Bitte gleich "
                                       "erneut versuchen.", {"Retry-After": "3"})
        try:
            status, h, data = http_request(
                OVERPASS_TARGET, data=body, method="POST", timeout=UPSTREAM_TIMEOUT_S,
                headers={"Referer": ORIGIN + "/",
                         "Content-Type": "application/x-www-form-urlencoded"})
        except OSError as e:
            self.rlog(f"! Overpass nicht erreichbar: {e}")
            return self.send_text(502, "POI-Suche nicht erreichbar.")
        ctype = h.get("Content-Type", "application/json")
        if status == 200:
            cache.put(key, data, ctype)
            self.rlog(f"overpass → {len(data)} B (heute noch {remaining})")
        else:
            self.rlog(f"! Overpass {status}")
        self.send_bytes(status, data, ctype)


def main():
    global cache
    Paths.geo_cache.mkdir(parents=True, exist_ok=True)
    cache = ResponseCache(Paths.geo_cache / "responses.sqlite")
    run_forever(cache.purge, 6 * 3600, log, "cache-purge")
    available = sorted(p.stem for p in Paths.profiles_src.glob("*.brf"))
    if not Paths.profiles.is_dir():
        log(f"!! Profilordner fehlt: {Paths.profiles}")
    n = cleanup_old_profiles(max_age_s=0)
    serve(Handler, PORT_GEO, log=log, banner_lines=[
        f"BRouter:  {BROUTER_URL}, {BROUTER_MAX_CONCURRENT} Slots "
        f"({RESERVED_SLOTS} für kurze Routen)",
        f"Profile:  {', '.join(available) or 'KEINE'} → {Paths.profiles} "
        f"({n} alte gelöscht)",
        f"Cache:    {Paths.geo_cache}",
    ])


if __name__ == "__main__":
    main()
