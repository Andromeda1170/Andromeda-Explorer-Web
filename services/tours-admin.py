#!/usr/bin/env python3
"""
tours-admin — Verwaltung der Touren
===================================

(vorher tourpack-admin.py)

Nur für den Betreiber: Passwort + TOTP. Caddy leitet /admin/* hierher.

- Bestand: auflisten, herunterladen, löschen, „promoted“ markieren,
  eigenes TourPack direkt veröffentlichen.
- Uploads: Aufbereiten anstoßen (→ tours-sanitizer), Ergebnis im
  Viewer ansehen, veröffentlichen oder ablehnen.
- Räumt verwaiste Dateien im Eingang und in staging/ auf.

Veröffentlichen heißt: den Ordner aus staging/ nach
published/.tmp-<id>/ KOPIEREN (mit sauberen Rechten, Gruppe
andromeda-tours, nur lesbar), dann umbenennen. tours-api erfährt davon
über published/.changed.

Einrichtung (als root):
    sudo -u andromeda-admin … tours-admin.py init-config
    (bzw. deploy/setup.sh erklärt es)

Sicherheit:
- Passwort PBKDF2-SHA256 (300 000 Iterationen), TOTP nach RFC 6238,
  ein Code gilt nur einmal.
- Session-Cookie HttpOnly, Secure, SameSite=Strict, 8 h.
- Rate-Limits auf Login und Code-Eingabe.
- CSRF: SameSite=Strict + Pflicht-Header X-Admin-Request + Origin-Prüfung.

Schreibt: Paths.published, Paths.jobs, Paths.staging, Paths.inbox.
Liest:    CONFIG_DIR/admin.json
"""

import argparse
import base64
import getpass
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import shutil
import struct
import sys
import threading
import time
import zipfile
from pathlib import PurePosixPath
from urllib.parse import quote, urlparse

from andromeda_lib import (
    APP_DIR, CONFIG_DIR, IMAGE_PATH_RE, MAX_IMAGE_BYTES, MAX_METADATA_BYTES,
    MAX_TOURPACK_BYTES, ORIGIN, PORT_ADMIN, PORT_TOURS_API, ROOT_FILES,
    SAFE_FILENAME_RE, SAFE_ID_RE, BaseHandler, Paths, SlidingWindowLimiter,
    atomic_write_json, build_tourpack_zip, dir_size, http_request,
    inspect_tourpack, make_logger, read_json_file, read_tour_dir_info,
    run_forever, serve, signal_published_changed, write_version_file,
)

log = make_logger("tours-admin")

CONFIG_FILE = CONFIG_DIR / "admin.json"
ADMIN_HTML_FILE = APP_DIR / "admin.html"

SESSION_HOURS = 8
SESSION_COOKIE = "andromeda_admin_session"
TOTP_STEP_S = 30
TOTP_DIGITS = 6
TOTP_WINDOW = 1
CODE_EXPIRY_S = 300
CODE_MAX_ATTEMPTS = 3
PBKDF2_ITERATIONS = 300_000

LOGIN_LIMIT = SlidingWindowLimiter(5, 900, 900)
VERIFY_LIMIT = SlidingWindowLimiter(10, 900, 900)

# Aufräumen
ORPHAN_INBOX_AGE_S = 24 * 3600      # Upload ohne Auftragszettel
ORPHAN_STAGING_AGE_S = 24 * 3600    # aufbereiteter Ordner ohne Auftragszettel
ORPHAN_JOB_AGE_S = 24 * 3600        # Auftragszettel ohne Datei

# Rechte im veröffentlichten Bereich (tours-api liest über die Gruppe)
PUBLISHED_DIR_MODE = 0o750
PUBLISHED_FILE_MODE = 0o640


# =============================================================================
# PASSWORT, TOTP, KONFIGURATION
# =============================================================================
def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password, stored):
    try:
        algo, iters, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                     bytes.fromhex(salt_hex), int(iters))
        return hmac.compare_digest(bytes.fromhex(hash_hex), actual)
    except (ValueError, AttributeError):
        return False


def generate_totp_secret():
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _totp_code(secret_b32, counter):
    s = secret_b32.upper().strip().replace(" ", "")
    key = base64.b32decode(s + "=" * ((-len(s)) % 8))
    h = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    o = h[-1] & 0x0F
    code = struct.unpack(">I", h[o:o + 4])[0] & 0x7FFFFFFF
    return f"{code % 10 ** TOTP_DIGITS:0{TOTP_DIGITS}d}"


_totp_lock = threading.Lock()
_totp_last_counter = 0


def verify_totp(secret_b32, code, consume=True):
    """Prüft den Code (±1 Zeitfenster). Mit consume gilt jeder Code nur
    einmal: ein Zeitfenster, das schon verwendet wurde, wird abgelehnt."""
    global _totp_last_counter
    if not isinstance(code, str) or not re.fullmatch(r"\d{6}", code):
        return False
    now = int(time.time() // TOTP_STEP_S)
    with _totp_lock:
        for counter in range(now - TOTP_WINDOW, now + TOTP_WINDOW + 1):
            try:
                expected = _totp_code(secret_b32, counter)
            except (ValueError, TypeError):
                return False
            if hmac.compare_digest(expected, code):
                if consume:
                    if counter <= _totp_last_counter:
                        return False
                    _totp_last_counter = counter
                return True
    return False


def make_otpauth_uri(secret, label="admin", issuer="AndromedaExplorer"):
    return (f"otpauth://totp/{quote(issuer)}:{quote(label)}?secret={secret}"
            f"&issuer={quote(issuer)}&algorithm=SHA1&digits={TOTP_DIGITS}"
            f"&period={TOTP_STEP_S}")


_config_cache = {"mtime": None, "data": None}


def load_config():
    try:
        mtime = CONFIG_FILE.stat().st_mtime
    except OSError:
        return None
    if _config_cache["mtime"] != mtime:
        data = read_json_file(CONFIG_FILE)
        _config_cache.update(mtime=mtime, data=data if isinstance(data, dict) else None)
    return _config_cache["data"]


def config_status():
    c = load_config()
    if not c:
        return {"configured": False, "reason": "config_missing"}
    missing = [k for k in ("admin_password_hash", "admin_totp_secret") if not c.get(k)]
    if missing:
        return {"configured": False, "reason": "missing:" + ",".join(missing)}
    return {"configured": True}


# =============================================================================
# SESSIONS UND 2FA-CHALLENGES (im Speicher; Neustart = neu anmelden)
# =============================================================================
_lock = threading.Lock()
_sessions = {}
_challenges = {}


def create_session():
    token = secrets.token_urlsafe(32)
    with _lock:
        _sessions[token] = time.time() + SESSION_HOURS * 3600
    return token


def check_session(token):
    if not token:
        return False
    with _lock:
        exp = _sessions.get(token)
        if exp is None:
            return False
        if exp < time.time():
            del _sessions[token]
            return False
        return True


def create_challenge(password_ok):
    cid = secrets.token_urlsafe(24)
    with _lock:
        _challenges[cid] = {"expires": time.time() + CODE_EXPIRY_S, "attempts": 0,
                            "password_ok": password_ok}
    return cid


def cleanup_auth():
    now = time.time()
    with _lock:
        for d, key in ((_sessions, None), (_challenges, "expires")):
            for k in [k for k, v in d.items() if (v if key is None else v[key]) < now]:
                del d[k]


# =============================================================================
# BESTAND
# =============================================================================
_promoted_lock = threading.Lock()


def load_promoted():
    data = read_json_file(Paths.promoted_file)
    return [x for x in data if isinstance(x, str)] if isinstance(data, list) else []


def save_promoted(ids):
    with _promoted_lock:
        atomic_write_json(Paths.promoted_file, sorted(set(ids)))
        os.chmod(Paths.promoted_file, PUBLISHED_FILE_MODE)


def _flat_location(route):
    loc = route.get("location") if isinstance(route, dict) else None
    if not isinstance(loc, dict):
        return {}
    if isinstance(loc.get("start"), dict):
        loc = loc["start"]
    return {k: str(loc.get(k) or "")[:100]
            for k in ("country", "region", "county", "municipality", "place")}


def indexed_ids():
    """IDs, die tours-api kennt (lokale Abfrage). None = unbekannt."""
    try:
        status, _, body = http_request(f"http://127.0.0.1:{PORT_TOURS_API}/internal/ids",
                                       timeout=3)
        if status == 200:
            return set(json.loads(body))
    except (OSError, ValueError):
        pass
    return None


def list_tourpacks():
    known = indexed_ids()
    promoted = set(load_promoted())
    items = []
    for d in sorted(Paths.published.iterdir()) if Paths.published.is_dir() else []:
        if not d.is_dir() or d.name.startswith(".") or not SAFE_ID_RE.match(d.name):
            continue
        info = read_tour_dir_info(d) or {}
        route = read_json_file(d / "route.json", MAX_METADATA_BYTES)
        route = route if isinstance(route, dict) else {}
        tags = route.get("tags") if isinstance(route.get("tags"), list) else []
        try:
            mtime = d.stat().st_mtime
        except OSError:
            mtime = 0
        items.append({
            "id": d.name,
            "dir_name": d.name,
            "size": dir_size(d),
            "mtime": mtime,
            "title": info.get("title") or d.name,
            "activity": info.get("activity"),
            "location": _flat_location(route),
            "tags": [str(t)[:60] for t in tags[:30] if isinstance(t, (str, int, float))],
            "indexed": True if known is None else d.name in known,
            "promoted": d.name in promoted,
        })
    return items


def published_dir(tp_id):
    if not isinstance(tp_id, str) or not SAFE_ID_RE.match(tp_id):
        return None
    d = Paths.published / tp_id
    return d if d.is_dir() else None


def _normalize_published_tree(root):
    """Rechte so setzen, dass tours-api (Gruppe) lesen, aber nichts
    ändern kann. Symlinks gibt es hier nicht (wir schreiben selbst)."""
    for dirpath, dirnames, filenames in os.walk(root):
        os.chmod(dirpath, PUBLISHED_DIR_MODE)
        for f in filenames:
            os.chmod(os.path.join(dirpath, f), PUBLISHED_FILE_MODE)


def _copy_tour_tree(src, dst):
    """Kopiert nur erlaubte Dateien (Wurzeldateien + media/images/*)."""
    dst.mkdir()
    copied = 0
    for name in ROOT_FILES:
        p = src / name
        if p.is_file() and not p.is_symlink():
            shutil.copyfile(p, dst / name)
            copied += 1
    media = src / "media" / "images"
    if media.is_dir() and not media.is_symlink():
        for p in sorted(media.iterdir()):
            rel = f"media/images/{p.name}"
            if p.is_file() and not p.is_symlink() and IMAGE_PATH_RE.match(rel):
                (dst / "media" / "images").mkdir(parents=True, exist_ok=True)
                shutil.copyfile(p, dst / rel)
                copied += 1
    return copied


def _install_published(tmp_dir, tp_id, replace=False):
    """tmp_dir (in published/) wird zu published/<id>."""
    write_version_file(tmp_dir)
    _normalize_published_tree(tmp_dir)
    target = Paths.published / tp_id
    old = None
    if target.exists():
        if not replace:
            raise FileExistsError(tp_id)
        old = Paths.published / f".old-{tp_id}-{secrets.token_hex(4)}"
        target.rename(old)
    tmp_dir.rename(target)
    if old:
        shutil.rmtree(old, ignore_errors=True)
    signal_published_changed()


def _extract_upload(data, dst):
    """Admin-eigenes TourPack entpacken (bereits mit inspect_tourpack geprüft)."""
    dst.mkdir()
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for info in zf.infolist():
            name = info.filename
            if info.is_dir() or name == "mimetype":
                continue
            if name in ROOT_FILES:
                limit = MAX_METADATA_BYTES
            elif IMAGE_PATH_RE.match(name):
                limit = MAX_IMAGE_BYTES
            else:
                continue
            if info.file_size > limit:
                raise ValueError(f"{name} zu groß")
            out = dst / name
            out.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as r:
                content = r.read(limit + 1)
            if len(content) > limit:
                raise ValueError(f"{name} zu groß")
            out.write_bytes(content)


# =============================================================================
# UPLOADS (Eingang, Aufträge, aufbereitet)
# =============================================================================
def _job_path(job_id):
    return Paths.jobs / f"{job_id}.json"


def load_job(job_id):
    job = read_json_file(_job_path(job_id))
    return job if isinstance(job, dict) else None


def list_quarantine():
    items = []
    for job_path in sorted(Paths.jobs.glob("*.json")):
        job = read_json_file(job_path)
        if not isinstance(job, dict) or not isinstance(job.get("id"), str):
            continue
        status = job.get("status") or "waiting"
        if status == "done":
            continue
        src = Paths.inbox / f"{job['id']}.tourpack"
        try:
            size = src.stat().st_size
        except OSError:
            size = None
        preview = job.get("manifest_preview") or {}
        items.append({
            "id": job["id"],
            "original_name": job.get("original_name") or "",
            "uploaded_at": job.get("uploaded_at"),
            "size": size,
            "status": status,
            "error": job.get("error"),
            "title": preview.get("title"),
            "activity": preview.get("activity"),
            "file_present": size is not None,
        })
    return items


def list_pending():
    items = []
    for p in sorted(Paths.staging.iterdir()) if Paths.staging.is_dir() else []:
        if p.name.startswith(".") or not p.is_dir():
            continue
        info = read_tour_dir_info(p)
        if info is None:
            continue
        job = load_job(p.name) or {}
        try:
            mtime = p.stat().st_mtime
        except OSError:
            mtime = 0
        items.append({
            "id": p.name, "kind": "dir", "size": dir_size(p), "mtime": mtime,
            "title": info.get("title") or p.name, "activity": info.get("activity"),
            "original_name": job.get("original_name"),
        })
    return items


def remove_job(job_id):
    """Auftrag samt Upload und aufbereitetem Ordner entfernen."""
    (Paths.inbox / f"{job_id}.tourpack").unlink(missing_ok=True)
    shutil.rmtree(Paths.staging / job_id, ignore_errors=True)
    _job_path(job_id).unlink(missing_ok=True)


def cleanup_orphans():
    """Verwaiste Dateien entfernen (z. B. nach Abstürzen)."""
    now = time.time()

    def old(p, age):
        try:
            return now - p.stat().st_mtime > age
        except OSError:
            return False

    removed = 0
    jobs = {p.stem for p in Paths.jobs.glob("*.json")}
    for p in Paths.inbox.glob("*"):
        stem = p.name.split(".", 1)[0]
        if p.is_file() and stem not in jobs and old(p, ORPHAN_INBOX_AGE_S):
            p.unlink(missing_ok=True)
            removed += 1
    for p in Paths.staging.iterdir() if Paths.staging.is_dir() else []:
        stem = p.name[5:] if p.name.startswith(".tmp-") else p.name
        if p.is_dir() and stem not in jobs and old(p, ORPHAN_STAGING_AGE_S):
            shutil.rmtree(p, ignore_errors=True)
            removed += 1
    for job_id in jobs:
        job = load_job(job_id)
        if not job:
            continue
        has_file = (Paths.inbox / f"{job_id}.tourpack").exists() \
            or (Paths.staging / job_id).exists()
        if not has_file and job.get("status") in ("waiting", "done") \
                and old(_job_path(job_id), ORPHAN_JOB_AGE_S):
            _job_path(job_id).unlink(missing_ok=True)
            removed += 1
    for p in Paths.published.glob(".tmp-*"):
        if old(p, 3600):
            shutil.rmtree(p, ignore_errors=True)
            removed += 1
    if removed:
        log(f"Aufgeräumt: {removed} verwaiste Einträge")


# =============================================================================
# HTTP
# =============================================================================
class Handler(BaseHandler):
    log = staticmethod(log)
    cors_headers = "Content-Type, X-Admin-Request, X-Tourpack-Name"
    cors_credentials = True

    # --- Auth-Helfer --------------------------------------------------------
    def session_token(self):
        for part in self.headers.get("Cookie", "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == SESSION_COOKIE:
                return v
        return None

    def authed(self):
        if not check_session(self.session_token()):
            self.send_json(401, {"error": "Nicht angemeldet"})
            return False
        if self.command == "POST" and self.headers.get("X-Admin-Request") != "1":
            self.rlog("BLOCK — fehlender X-Admin-Request-Header")
            self.send_json(403, {"error": "Ungültige Anfrage"})
            return False
        return True

    def body_id(self):
        body = self.read_json()
        tp_id = body.get("id") if body else None
        if not isinstance(tp_id, str) or not SAFE_ID_RE.match(tp_id):
            self.send_json(400, {"error": "Ungültige ID"})
            return None, body
        return tp_id, body

    # --- GET ----------------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/admin", "/admin/", "/admin/index.html"):
            try:
                data = ADMIN_HTML_FILE.read_bytes()
            except OSError:
                return self.send_text(500, "admin.html fehlt")
            return self.send_bytes(200, data, "text/html; charset=utf-8",
                                   {"Cache-Control": "no-store"})
        if path == "/admin/api/status":
            cs = config_status()
            return self.send_json(200, {"configured": cs["configured"],
                                        "reason": cs.get("reason"),
                                        "authenticated": check_session(self.session_token())})
        if not path.startswith("/admin/api/"):
            return self.send_text(404, "Nicht gefunden.")
        if not self.authed():
            return
        if path == "/admin/api/tourpacks":
            return self.send_json(200, {"tourpacks": list_tourpacks(),
                                        "promoted": load_promoted()})
        if path == "/admin/api/quarantine":
            return self.send_json(200, {"items": list_quarantine()})
        if path == "/admin/api/pending":
            return self.send_json(200, {"items": list_pending()})
        if path.startswith("/admin/api/pending/") and path.endswith("/raw"):
            job_id = path[len("/admin/api/pending/"):-len("/raw")].strip("/")
            d = Paths.staging / job_id
            if not SAFE_ID_RE.match(job_id) or not d.is_dir():
                return self.send_text(404, "Nicht gefunden.")
            return self.send_bytes(200, build_tourpack_zip(d), "application/zip", {
                "Content-Disposition": f'inline; filename="{job_id}.tourpack"',
                "Cache-Control": "no-store"})
        if path.startswith("/admin/api/download/"):
            tp_id = path[len("/admin/api/download/"):].strip("/")
            d = published_dir(tp_id)
            if not d:
                return self.send_text(404, "Nicht gefunden.")
            data = build_tourpack_zip(d)
            self.rlog(f"download {tp_id} ({len(data)} B)")
            return self.send_bytes(200, data, "application/zip", {
                "Content-Disposition": f'attachment; filename="{tp_id}.tourpack"'})
        self.send_text(404, "Nicht gefunden.")

    # --- POST ---------------------------------------------------------------
    def do_POST(self):
        origin = self.headers.get("Origin")
        if origin and origin != ORIGIN:
            self.rlog(f"BLOCK — falsche Origin: {origin[:80]}")
            return self.send_json(403, {"error": "Ungültige Origin"})
        path = urlparse(self.path).path
        if path == "/admin/api/login":
            ok, wait = LOGIN_LIMIT.check(self.client_ip())
            return self.handle_login() if ok else self.send_too_many(wait, "Versuche")
        if path == "/admin/api/verify":
            ok, wait = VERIFY_LIMIT.check(self.client_ip())
            return self.handle_verify() if ok else self.send_too_many(wait, "Versuche")
        if path == "/admin/api/logout":
            with _lock:
                _sessions.pop(self.session_token() or "", None)
            return self.send_json(200, {"ok": True}, {"Set-Cookie":
                f"{SESSION_COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0"})
        routes = {
            "/admin/api/upload": self.handle_upload,
            "/admin/api/delete": self.handle_delete,
            "/admin/api/promote": self.handle_promote,
            "/admin/api/quarantine/prepare": self.handle_prepare,
            "/admin/api/quarantine/delete": self.handle_quarantine_delete,
            "/admin/api/pending/publish": self.handle_publish,
            "/admin/api/pending/reject": self.handle_reject,
        }
        fn = routes.get(path)
        if not fn:
            return self.send_text(404, "Nicht gefunden.")
        if self.authed():
            fn()

    # --- Anmeldung ----------------------------------------------------------
    def handle_login(self):
        cfg = load_config()
        if not config_status()["configured"]:
            return self.send_json(503, {"error": "Admin nicht eingerichtet."})
        body = self.read_json()
        if not body or not isinstance(body.get("password"), str):
            return self.send_json(400, {"error": "Ungültige Anfrage"})
        ok = verify_password(body["password"], cfg["admin_password_hash"])
        self.rlog(f"login (pw_ok={ok})")
        # Antwort ist immer gleich; ob das Passwort stimmte, zeigt erst der Code.
        self.send_json(200, {"needs_code": True, "challenge_id": create_challenge(ok)})

    def handle_verify(self):
        body = self.read_json() or {}
        cid, code = body.get("challenge_id"), body.get("code")
        if not isinstance(cid, str) or not isinstance(code, str):
            return self.send_json(400, {"error": "Ungültige Anfrage"})
        code = code.strip()
        if not re.fullmatch(r"\d{6}", code):
            return self.send_json(400, {"error": "Ungültiger Code"})
        fail = {"error": "Code ungültig oder abgelaufen."}
        with _lock:
            ch = _challenges.get(cid)
            if not ch or ch["expires"] < time.time():
                _challenges.pop(cid, None)
                ch = None
            else:
                ch["attempts"] += 1
                if ch["attempts"] > CODE_MAX_ATTEMPTS or not ch["password_ok"]:
                    _challenges.pop(cid, None)
                    ch = None
        if not ch:
            self.rlog("verify: ungültige Challenge")
            return self.send_json(401, fail)
        secret = (load_config() or {}).get("admin_totp_secret")
        if not secret or not verify_totp(secret, code):
            self.rlog(f"verify: falscher Code ({ch['attempts']}/{CODE_MAX_ATTEMPTS})")
            return self.send_json(401, fail)
        with _lock:
            _challenges.pop(cid, None)
        token = create_session()
        self.rlog("verify: OK, Session angelegt")
        self.send_json(200, {"ok": True}, {"Set-Cookie":
            f"{SESSION_COOKIE}={token}; Path=/admin; HttpOnly; Secure; SameSite=Strict; "
            f"Max-Age={SESSION_HOURS * 3600}"})

    # --- Bestand ------------------------------------------------------------
    def handle_upload(self):
        name = PurePosixPath(self.headers.get("X-Tourpack-Name", "").strip()
                             .replace("\\", "/")).name
        if not SAFE_FILENAME_RE.match(name or ""):
            return self.send_json(400, {"error": "Ungültiger Dateiname (muss auf "
                                                 ".tourpack enden)"})
        data = self.read_body(MAX_TOURPACK_BYTES)
        if data is None:
            return self.send_json(413, {"error": "Datei größer als 100 MB oder leer"})
        ok, info = inspect_tourpack(data)
        if not ok:
            self.rlog(f"Upload abgelehnt: {info}")
            return self.send_json(400, {"error": f"Ungültiges TourPack: {info}"})
        tp_id = info["id"]
        tmp = Paths.published / f".tmp-{tp_id}-{secrets.token_hex(4)}"
        try:
            _extract_upload(data, tmp)
            _install_published(tmp, tp_id, replace=True)
        except (OSError, ValueError, zipfile.BadZipFile) as e:
            shutil.rmtree(tmp, ignore_errors=True)
            self.rlog(f"! Veröffentlichen fehlgeschlagen: {e}")
            return self.send_json(500, {"error": f"Entpacken fehlgeschlagen: {e}"})
        self.rlog(f"upload {name} → published/{tp_id} ({len(data)} B)")
        self.send_json(200, {"ok": True, "id": tp_id, "title": info.get("title")})

    def handle_delete(self):
        tp_id, _ = self.body_id()
        if not tp_id:
            return
        d = published_dir(tp_id)
        if not d:
            return self.send_json(404, {"error": "Nicht gefunden"})
        trash = Paths.published / f".old-{tp_id}-{secrets.token_hex(4)}"
        try:
            d.rename(trash)
        except OSError as e:
            self.rlog(f"! Löschen fehlgeschlagen: {e}")
            return self.send_json(500, {"error": "Konnte Ordner nicht löschen"})
        shutil.rmtree(trash, ignore_errors=True)
        promoted = load_promoted()
        if tp_id in promoted:
            save_promoted([x for x in promoted if x != tp_id])
        signal_published_changed()
        self.rlog(f"delete {tp_id}")
        self.send_json(200, {"ok": True})

    def handle_promote(self):
        tp_id, body = self.body_id()
        if not tp_id:
            return
        flag = body.get("promoted")
        if not isinstance(flag, bool):
            return self.send_json(400, {"error": "promoted muss bool sein"})
        if not published_dir(tp_id):
            return self.send_json(404, {"error": "Nicht gefunden"})
        ids = set(load_promoted())
        (ids.add if flag else ids.discard)(tp_id)
        save_promoted(ids)
        self.rlog(f"promote {tp_id} = {flag}")
        self.send_json(200, {"ok": True, "promoted": flag})

    # --- Uploads ------------------------------------------------------------
    def handle_prepare(self):
        job_id, _ = self.body_id()
        if not job_id:
            return
        job = load_job(job_id)
        if job is None:
            return self.send_json(404, {"error": "Nicht gefunden"})
        if job.get("status") in ("requested", "processing"):
            return self.send_json(200, {"ok": True, "status": job["status"]})
        job.update(status="requested", error=None)
        try:
            atomic_write_json(_job_path(job_id), job)
        except OSError as e:
            return self.send_json(500, {"error": f"Konnte Status nicht setzen: {e}"})
        self.rlog(f"prepare: {job_id} → requested")
        self.send_json(200, {"ok": True})

    def handle_quarantine_delete(self):
        job_id, _ = self.body_id()
        if not job_id:
            return
        remove_job(job_id)
        self.rlog(f"quarantine delete: {job_id}")
        self.send_json(200, {"ok": True})

    def handle_publish(self):
        job_id, _ = self.body_id()
        if not job_id:
            return
        src = Paths.staging / job_id
        if not src.is_dir():
            return self.send_json(404, {"error": "Nicht gefunden"})
        info = read_tour_dir_info(src)
        tp_id = (info or {}).get("id")
        if not tp_id or not SAFE_ID_RE.match(tp_id):
            return self.send_json(400, {"error": "Kein gültiges Manifest im Ordner."})
        if (Paths.published / tp_id).exists():
            return self.send_json(409, {"error": f"Eine Tour mit der ID {tp_id} ist "
                                                 "bereits veröffentlicht. Nicht überschrieben."})
        tmp = Paths.published / f".tmp-{tp_id}-{secrets.token_hex(4)}"
        try:
            _copy_tour_tree(src, tmp)
            _install_published(tmp, tp_id)
        except (OSError, FileExistsError) as e:
            shutil.rmtree(tmp, ignore_errors=True)
            return self.send_json(500, {"error": f"Veröffentlichen fehlgeschlagen: {e}"})
        remove_job(job_id)
        self.rlog(f"publish: {job_id} → published/{tp_id}")
        self.send_json(200, {"ok": True, "id": tp_id})

    def handle_reject(self):
        job_id, _ = self.body_id()
        if not job_id:
            return
        remove_job(job_id)
        self.rlog(f"reject: {job_id}")
        self.send_json(200, {"ok": True})


# =============================================================================
# KOMMANDOZEILE
# =============================================================================
def _ask_password():
    p1 = getpass.getpass("Admin-Passwort (min. 12 Zeichen): ")
    p2 = getpass.getpass("Wiederholung: ")
    if p1 != p2:
        sys.exit("Passwörter stimmen nicht überein.")
    if len(p1) < 12:
        sys.exit("Passwort muss mindestens 12 Zeichen haben.")
    return p1


def _write_config(cfg):
    """admin.json schreiben: root:andromeda-admin 0640 (wenn als root)."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_name(".admin.json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    if os.geteuid() == 0:
        import grp
        try:
            os.chown(tmp, 0, grp.getgrnam("andromeda-admin").gr_gid)
            os.chmod(tmp, 0o640)
        except KeyError:
            print("Hinweis: Gruppe andromeda-admin fehlt — Datei bleibt 0600.")
    os.replace(tmp, CONFIG_FILE)


def cmd_init_config(force):
    if CONFIG_FILE.exists() and not force:
        sys.exit(f"{CONFIG_FILE} existiert schon. Neu anlegen mit --force.")
    print("Einrichtung des Admin-Bereichs\n" + "=" * 55)
    password = _ask_password()
    secret = generate_totp_secret()
    uri = make_otpauth_uri(secret)
    print("\nIn der Authenticator-App (Aegis, 2FAS, Google Authenticator …)")
    print("einen Eintrag anlegen — Secret manuell eingeben oder QR scannen.\n")
    print("Secret:  " + " ".join(secret[i:i + 4] for i in range(0, len(secret), 4)))
    print(f"URI:     {uri}\n")
    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(uri)
        qr.make(fit=True)
        qr.print_ascii(invert=True)
    except ImportError:
        print("(QR-Code im Terminal: sudo apt install python3-qrcode)")
    for attempt in range(3):
        if verify_totp(secret, input("\nCode aus der App: ").strip(), consume=False):
            break
        if attempt == 2:
            sys.exit("Drei Fehlversuche — abgebrochen. Uhrzeit von Server und "
                     "Handy prüfen und neu starten.")
        print("Code stimmt nicht.")
    _write_config({"admin_password_hash": hash_password(password),
                   "admin_totp_secret": secret})
    print(f"\nGespeichert: {CONFIG_FILE}\nDanach: sudo systemctl restart tours-admin")


def cmd_set_password():
    cfg = read_json_file(CONFIG_FILE)
    if not isinstance(cfg, dict):
        sys.exit(f"{CONFIG_FILE} fehlt — zuerst init-config.")
    cfg["admin_password_hash"] = hash_password(_ask_password())
    _write_config(cfg)
    print("Passwort geändert.")


def main():
    parser = argparse.ArgumentParser(description="Tour-Verwaltung")
    sub = parser.add_subparsers(dest="cmd")
    p = sub.add_parser("init-config", help="Passwort + TOTP einrichten")
    p.add_argument("--force", action="store_true")
    sub.add_parser("set-password", help="nur das Passwort ändern")
    args = parser.parse_args()
    if args.cmd == "init-config":
        return cmd_init_config(args.force)
    if args.cmd == "set-password":
        return cmd_set_password()

    os.umask(0o007)
    run_forever(cleanup_auth, 60, log, "auth-cleanup")
    run_forever(cleanup_orphans, 3600, log, "orphan-cleanup")
    cs = config_status()
    serve(Handler, PORT_ADMIN, log=log, banner_lines=[
        f"Konfiguration: {CONFIG_FILE} "
        f"({'ok' if cs['configured'] else 'FEHLT: ' + str(cs.get('reason'))})",
        f"Veröffentlicht: {Paths.published}",
        f"Uploads: {Paths.inbox} → {Paths.staging}",
    ])


if __name__ == "__main__":
    main()
