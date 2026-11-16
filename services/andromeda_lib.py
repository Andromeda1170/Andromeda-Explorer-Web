"""
Andromeda-Explorer — gemeinsame Bausteine aller Dienste
=======================================================

Alles, was vorher in jedem Dienst eigens stand: Konfiguration und
Pfade, Logging, Client-IP hinter Caddy, Rate-Limiter, HTTP-Antworten,
Server-Start, das TourPack-Format und kleine Datei-Helfer.

Nur Python-Standardbibliothek. Keine Geheimnisse in diesem Code: alles
Standortspezifische kommt aus Umgebungsvariablen (siehe systemd-Units
unter deploy/systemd/), Geheimnisse liegen unter /etc/andromeda/.

Umgebungsvariablen (alle optional):
    ANDROMEDA_DATA        Datenwurzel           (/var/lib/andromeda)
    ANDROMEDA_CONFIG_DIR  Konfiguration/Secrets (/etc/andromeda)
    ANDROMEDA_ORIGIN      öffentliche Adresse   (https://andromeda-explorer.com)
    ANDROMEDA_CONTACT     Kontakt im User-Agent (support.andromeda-explorer@protonmail.com)
    ANDROMEDA_TRUST_PROXY "1": Client-IP aus X-Forwarded-For (hinter Caddy)
    ANDROMEDA_LISTEN_HOST Adresse der Dienste   (127.0.0.1)
"""

import io
import json
import os
import re
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


# =============================================================================
# KONFIGURATION
# =============================================================================
def _env(name, default):
    v = os.environ.get(name, "").strip()
    return v or default


APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(_env("ANDROMEDA_DATA", "/var/lib/andromeda"))
CONFIG_DIR = Path(_env("ANDROMEDA_CONFIG_DIR", "/etc/andromeda"))
ORIGIN = _env("ANDROMEDA_ORIGIN", "https://andromeda-explorer.com").rstrip("/")
CONTACT = _env("ANDROMEDA_CONTACT", "support.andromeda-explorer@protonmail.com")
TRUST_PROXY = _env("ANDROMEDA_TRUST_PROXY", "1") == "1"
LISTEN_HOST = _env("ANDROMEDA_LISTEN_HOST", "127.0.0.1")

# Ein User-Agent für alle Anfragen an fremde Dienste (Nominatim,
# Overpass, brouter.de). Deren Nutzungsregeln verlangen eine Kennung
# mit Kontakt.
USER_AGENT = f"Andromeda-Explorer/2.0 (+{ORIGIN}; contact: {CONTACT})"

# Ports — dieselben wie bisher, damit Caddy und Website unverändert passen.
PORT_GEO = 8080
PORT_TOURS_API = 8081
PORT_ADMIN = 8082
PORT_UPLOAD = 8083
PORT_BROUTER_UPDATER = 8084
BROUTER_URL = "http://127.0.0.1:17777"


class Paths:
    """Alle Datenordner an einer Stelle. Wer was schreiben darf, steht
    in deploy/setup.sh (Eigentümer/Gruppen) und in den systemd-Units
    (ReadWritePaths)."""
    tours = DATA_DIR / "tours"
    inbox = tours / "inbox"            # tours-upload  → tours-sanitizer, tours-admin
    jobs = tours / "jobs"              # Auftragszettel (upload, admin, sanitizer)
    staging = tours / "staging"        # tours-sanitizer → tours-admin
    published = tours / "published"    # nur tours-admin schreibt; tours-api liest
    promoted_file = published / ".promoted.json"
    changed_file = published / ".changed"   # Signal admin → api

    api = DATA_DIR / "tours-api"       # nur tours-api
    api_index = api / "index"
    api_thumbnails = api / "thumbnails"
    api_pages = api / "pages"

    geo_cache = DATA_DIR / "geo-cache"  # nur geo-gateway

    brouter = DATA_DIR / "brouter"
    segments = brouter / "segments4"           # brouter-updater schreibt
    segments_backup = brouter / "segments4_backup"
    updater_state = brouter / "updater-state.json"
    restart_request = brouter / "restart-request"
    profiles = brouter / "profiles2"           # geo-gateway schreibt Profile
    profiles_src = APP_DIR / "profiles"        # Vorlagen (Teil des Codes)


# =============================================================================
# LOGGING (journald setzt Zeitstempel selbst)
# =============================================================================
def make_logger(tag):
    def log(msg):
        print(f"[{tag}] {msg}", flush=True)
    return log


# =============================================================================
# RATE-LIMITER
# =============================================================================
class SlidingWindowLimiter:
    """Höchstens max_requests je window_s pro Schlüssel (meist IP).
    Wer drüber liegt, ist block_s gesperrt."""

    def __init__(self, max_requests, window_s, block_s):
        self.max = max_requests
        self.window = window_s
        self.block = block_s
        self._lock = threading.Lock()
        self._buckets = defaultdict(deque)
        self._blocked = {}
        self._last_cleanup = time.monotonic()

    def check(self, key):
        """(erlaubt, Wartezeit_s)"""
        now = time.monotonic()
        with self._lock:
            if now - self._last_cleanup > 600:
                self._cleanup(now)
            until = self._blocked.get(key)
            if until and now < until:
                return False, until - now
            bucket = self._buckets[key]
            cutoff = now - self.window
            while bucket and bucket[0] < cutoff:
                bucket.popleft()
            if len(bucket) >= self.max:
                self._blocked[key] = now + self.block
                return False, self.block
            bucket.append(now)
            return True, 0.0

    def _cleanup(self, now):
        self._last_cleanup = now
        cutoff = now - max(self.window, self.block) * 2
        for k in list(self._buckets):
            b = self._buckets[k]
            while b and b[0] < cutoff:
                b.popleft()
            if not b:
                del self._buckets[k]
        for k in list(self._blocked):
            if self._blocked[k] < now:
                del self._blocked[k]


class TokenBucket:
    """Pro-Schlüssel-Token-Bucket: rate Anfragen/s Dauer, burst sofort."""

    def __init__(self, rate, burst):
        self.rate = rate
        self.burst = burst
        self._lock = threading.Lock()
        self._state = {}
        self._last_cleanup = time.monotonic()

    def check(self, key):
        now = time.monotonic()
        with self._lock:
            if now - self._last_cleanup > 600:
                self._last_cleanup = now
                for k in [k for k, v in self._state.items() if v[1] < now - 3600]:
                    del self._state[k]
            tokens, last = self._state.get(key, (float(self.burst), now))
            tokens = min(self.burst, tokens + (now - last) * self.rate)
            if tokens >= 1.0:
                self._state[key] = (tokens - 1.0, now)
                return True, 0.0
            self._state[key] = (tokens, now)
            return False, (1.0 - tokens) / self.rate


class DailyQuota:
    """Zähler pro Schlüssel und UTC-Tag."""

    def __init__(self, max_per_day):
        self.max = max_per_day
        self._lock = threading.Lock()
        self._counts = {}

    def consume(self, key):
        """(erlaubt, verbleibend)"""
        day = int(time.time() // 86400)
        with self._lock:
            if len(self._counts) > 50000:
                self._counts = {k: v for k, v in self._counts.items() if v[0] == day}
            d, n = self._counts.get(key, (day, 0))
            if d != day:
                n = 0
            if n >= self.max:
                self._counts[key] = (day, n)
                return False, 0
            self._counts[key] = (day, n + 1)
            return True, self.max - n - 1


class GlobalPacer:
    """Mindestabstand zwischen zwei Anfragen an einen fremden Dienst,
    über alle Clients. Mehr als queue_max Wartende → sofort ablehnen
    (sonst stauen sich Threads)."""

    def __init__(self, min_interval_s, queue_max):
        self.min_interval = min_interval_s
        self.queue_max = queue_max
        self._lock = threading.Lock()
        self._waiting_lock = threading.Lock()
        self._waiting = 0
        self._last = 0.0

    def acquire(self):
        with self._waiting_lock:
            if self._waiting >= self.queue_max:
                return False
            self._waiting += 1
        try:
            with self._lock:
                wait = self.min_interval - (time.monotonic() - self._last)
                if wait > 0:
                    time.sleep(wait)
                self._last = time.monotonic()
            return True
        finally:
            with self._waiting_lock:
                self._waiting -= 1


# =============================================================================
# HTTP-SERVER
# =============================================================================
class BaseHandler(BaseHTTPRequestHandler):
    """Gemeinsame Antwort-Helfer. Unterklassen setzen log, cors_origin,
    cors_methods, cors_headers und implementieren do_GET/do_POST."""

    server_version = "Andromeda"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = 30
    log = staticmethod(make_logger("http"))
    cors_origin = ORIGIN
    cors_methods = "GET, POST, OPTIONS"
    cors_headers = "Content-Type"
    cors_credentials = False
    _head_only = False

    # --- Allgemeines ---------------------------------------------------------
    def version_string(self):
        return self.server_version

    def client_ip(self):
        """Hinter Caddy steht die echte Client-IP im LETZTEN Eintrag von
        X-Forwarded-For (Caddy hängt an bzw. setzt ihn). Frühere Einträge
        kann der Client frei erfinden."""
        if TRUST_PROXY:
            xff = self.headers.get("X-Forwarded-For", "")
            if xff:
                return xff.split(",")[-1].strip()
        return self.client_address[0]

    def is_direct_local(self):
        """Anfrage kommt direkt vom Server selbst (nicht über Caddy)."""
        return (self.client_address[0] in ("127.0.0.1", "::1")
                and not self.headers.get("X-Forwarded-For"))

    def log_message(self, fmt, *args):
        pass

    def rlog(self, msg):
        self.log(f"{self.client_ip()}  {msg}")

    def send_cors(self):
        if self.cors_origin:
            self.send_header("Access-Control-Allow-Origin", self.cors_origin)
            self.send_header("Access-Control-Allow-Methods", self.cors_methods)
            self.send_header("Access-Control-Allow-Headers", self.cors_headers)
            if self.cors_credentials:
                self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("X-Content-Type-Options", "nosniff")

    # --- Antworten -----------------------------------------------------------
    def send_bytes(self, status, data, content_type, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_cors()
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if not self._head_only and data:
            self.wfile.write(data)

    def send_json(self, status, obj, headers=None):
        self.send_bytes(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                        "application/json; charset=utf-8", headers)

    def send_text(self, status, text, headers=None):
        self.send_bytes(status, text.encode("utf-8"),
                        "text/plain; charset=utf-8", headers)

    def send_too_many(self, wait_s, what="Anfragen"):
        wait = max(1, int(wait_s + 0.999))
        self.rlog(f"RATE-LIMIT — {wait}s")
        self.send_text(429, f"Zu viele {what}. Bitte {wait} Sekunden warten.",
                       {"Retry-After": str(wait)})

    def read_body(self, max_bytes):
        """Body lesen (in Stücken). None bei fehlendem/zu großem Body."""
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0 or length > max_bytes:
            return None
        chunks, remaining = [], length
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 1 << 20))
            if not chunk:
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def read_json(self, max_bytes=64 * 1024):
        raw = self.read_body(max_bytes)
        if raw is None:
            return None
        try:
            obj = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return obj if isinstance(obj, dict) else None

    # --- Methoden ------------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _not_allowed(self):
        self.send_text(405, "Methode nicht erlaubt.")

    do_PUT = do_DELETE = do_PATCH = _not_allowed


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64


def serve(handler_cls, port, banner_lines=(), log=None, on_stop=None):
    """Startet den HTTP-Server und beendet ihn sauber bei SIGTERM."""
    log = log or make_logger("server")
    for line in banner_lines:
        log(line)
    httpd = _Server((LISTEN_HOST, port), handler_cls)
    log(f"lauscht auf http://{LISTEN_HOST}:{port}")

    def stop(signum, frame):
        log(f"Signal {signum}, beende …")
        if on_stop:
            on_stop()
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
        log("beendet")


def run_forever(loop_fn, interval_s, log, name):
    """Hintergrund-Thread, der loop_fn alle interval_s Sekunden ausführt
    und Fehler nur loggt."""
    def run():
        while True:
            try:
                loop_fn()
            except Exception as e:  # noqa: BLE001 — Hintergrundpflege darf nie sterben
                log(f"! {name}: {e}")
            time.sleep(interval_s)
    t = threading.Thread(target=run, daemon=True, name=name)
    t.start()
    return t


# =============================================================================
# HTTP-CLIENT (nur Standardbibliothek)
# =============================================================================
def http_request(url, data=None, headers=None, method=None, timeout=60):
    """Liefert (status, headers, body). HTTP-Fehlerstatus sind keine
    Ausnahme; Netzwerkfehler schon (OSError/URLError)."""
    h = {"User-Agent": USER_AGENT}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        try:
            body = e.read()
        except OSError:
            body = b""
        return e.code, e.headers, body


# =============================================================================
# DATEI-HELFER
# =============================================================================
def atomic_write_bytes(path, data):
    path = Path(path)
    tmp = path.with_name(f".{path.name}.tmp")
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def atomic_write_json(path, obj, indent=2):
    atomic_write_bytes(path, json.dumps(obj, ensure_ascii=False,
                                        indent=indent).encode("utf-8"))


def read_json_file(path, max_bytes=None):
    """JSON-Objekt aus Datei oder None."""
    try:
        p = Path(path)
        if max_bytes is not None and p.stat().st_size > max_bytes:
            return None
        obj = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return obj if isinstance(obj, (dict, list)) else None


def dir_size(path):
    total = 0
    for f in Path(path).rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            pass
    return total


# =============================================================================
# TOURPACK-FORMAT
# =============================================================================
TOURPACK_MIMETYPE = "application/vnd.andromedaexplorer+zip"
TOURPACK_FORMAT = "andromedaexplorer"
ACTIVITIES = {"hiking", "cycling", "running", "skiing"}

SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
SAFE_FILENAME_RE = re.compile(r"^[^/\\\x00-\x1f]{1,200}\.tourpack$", re.IGNORECASE)
# Nur Bild-Endungen. Alles andere (z. B. .html, .svg) wird abgelehnt.
IMAGE_PATH_RE = re.compile(
    r"^media/images/[A-Za-z0-9._-]+\.(?:jpe?g|png|webp|gif)$", re.IGNORECASE)
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
IMAGE_CONTENT_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif",
}
# Dateien in der Wurzel eines entpackten TourPacks
ROOT_FILES = ("manifest.json", "route.json", "geometry.geojson", "description.md")
# Erlaubte Einträge in der ZIP (zusätzlich zu Bildern)
ZIP_FILES = {"mimetype", *ROOT_FILES}

MAX_TOURPACK_BYTES = 100 * 1024 * 1024
MAX_METADATA_BYTES = 4 * 1024 * 1024
MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_ZIP_ENTRIES = 500
MAX_UNCOMPRESSED_BYTES = 150 * 1024 * 1024


def inspect_tourpack(source):
    """Prüft eine TourPack-ZIP (Bytes oder Pfad), ohne etwas zu
    entpacken oder Bilder zu dekodieren. Prüft Struktur, Größen,
    Whitelist, mimetype, manifest.json und route.json.
    Liefert (True, {"id", "title", "activity"}) oder (False, Fehlertext)."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(source) if isinstance(source, (bytes, bytearray))
                             else source, "r")
    except (zipfile.BadZipFile, OSError):
        return False, "Kein gültiges ZIP"
    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_ZIP_ENTRIES:
            return False, "Zu viele Dateien im Archiv"
        total = 0
        seen = set()
        for info in infos:
            name = info.filename
            if name.endswith("/"):
                continue
            if name in seen:
                return False, f"Doppelter Eintrag: {name[:60]}"
            seen.add(name)
            if name not in ZIP_FILES and not IMAGE_PATH_RE.match(name):
                return False, f"Unerlaubter Eintrag: {name[:60]}"
            limit = MAX_IMAGE_BYTES if name.startswith("media/") else MAX_METADATA_BYTES
            if info.file_size > limit:
                return False, f"{name[:60]} zu groß"
            total += info.file_size
            if total > MAX_UNCOMPRESSED_BYTES:
                return False, "Gesamtgröße entpackt zu groß"

        try:
            mime = zf.read("mimetype").decode("utf-8", "ignore").strip()
        except KeyError:
            return False, "mimetype fehlt"
        if mime != TOURPACK_MIMETYPE:
            return False, "mimetype stimmt nicht"

        docs = {}
        for name in ("manifest.json", "route.json"):
            try:
                obj = json.loads(zf.read(name).decode("utf-8"))
            except KeyError:
                return False, f"{name} fehlt"
            except (UnicodeDecodeError, json.JSONDecodeError) as e:
                return False, f"{name} unlesbar: {e}"
            if not isinstance(obj, dict):
                return False, f"{name} ist kein Objekt"
            docs[name] = obj

    manifest, route = docs["manifest.json"], docs["route.json"]
    fmt = manifest.get("format")
    if fmt and fmt != TOURPACK_FORMAT:
        return False, f"Format '{str(fmt)[:40]}' unbekannt"
    tp_id = manifest.get("id") or route.get("id")
    if not isinstance(tp_id, str) or not SAFE_ID_RE.match(tp_id):
        return False, "Keine gültige ID im TourPack"
    title = manifest.get("title") or route.get("title")
    activity = route.get("type")
    return True, {
        "id": tp_id,
        "title": title[:200] if isinstance(title, str) else None,
        "activity": activity if activity in ACTIVITIES else None,
    }


def read_tour_dir_info(dir_path):
    """id/title/activity eines entpackten TourPack-Ordners oder None."""
    manifest = read_json_file(Path(dir_path) / "manifest.json", MAX_METADATA_BYTES)
    if not isinstance(manifest, dict):
        return None
    route = read_json_file(Path(dir_path) / "route.json", MAX_METADATA_BYTES)
    route = route if isinstance(route, dict) else {}
    tp_id = manifest.get("id") or route.get("id")
    title = manifest.get("title") or route.get("title")
    activity = route.get("type")
    return {
        "id": tp_id if isinstance(tp_id, str) else None,
        "title": title if isinstance(title, str) else None,
        "activity": activity if isinstance(activity, str) else None,
    }


def build_tourpack_zip(dir_path):
    """Baut eine TourPack-ZIP aus einem entpackten Ordner. mimetype ist
    der erste Eintrag und unkomprimiert (wichtig für OsmAnd u. a.)."""
    dir_path = Path(dir_path)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zi = zipfile.ZipInfo("mimetype")
        zi.compress_type = zipfile.ZIP_STORED
        zf.writestr(zi, TOURPACK_MIMETYPE)
        for name in ROOT_FILES:
            p = dir_path / name
            if p.is_file():
                zf.write(p, arcname=name)
        media = dir_path / "media" / "images"
        if media.is_dir():
            for p in sorted(media.iterdir()):
                rel = f"media/images/{p.name}"
                if p.is_file() and IMAGE_PATH_RE.match(rel):
                    # Bilder sind schon komprimiert → STORED
                    zf.write(p, arcname=rel, compress_type=zipfile.ZIP_STORED)
    return buf.getvalue()


def write_version_file(dir_path):
    """.version = Zeitstempel; tours-api indexiert neu, wenn er sich ändert."""
    (Path(dir_path) / ".version").write_text(str(int(time.time())), encoding="utf-8")


def signal_published_changed():
    """tours-admin → tours-api: „Bitte neu einlesen.“ tours-api beobachtet
    den Zeitstempel dieser Datei (kein HTTP-Rückkanal nötig)."""
    p = Paths.changed_file
    try:
        p.touch(exist_ok=True)
        now = time.time()
        os.utime(p, (now, now))
    except OSError as e:
        print(f"[lib] ! Änderungssignal fehlgeschlagen: {e}", file=sys.stderr, flush=True)
