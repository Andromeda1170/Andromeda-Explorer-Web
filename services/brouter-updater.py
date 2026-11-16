#!/usr/bin/env python3
"""
brouter-updater — hält die BRouter-Segmente aktuell
===================================================

(vorher brouter-segments.py)

- Prüft wöchentlich alle vorhandenen .rd5-Tiles bei brouter.de und lädt
  nur die herunter, die sich geändert haben (If-Modified-Since).
- Auf Anfrage: einzelnes Tile (E15_N45) oder Sammlung (austria …)
  hinzufügen.
- Downloads nacheinander mit Pause. Vor dem Austausch wird gewartet,
  bis BRouter gerade nichts rechnet; ersetzt wird atomar, die alte
  Version bleibt als Hardlink in segments4_backup/ (kostet keinen Platz
  und keine Kopierzeit).
- Danach wird BRouter neu gestartet, damit er die neuen Dateien sicher
  verwendet. Der Dienst darf das nicht selbst (kein sudo): er legt eine
  Datei „restart-request“ an, die die systemd-Unit brouter-restart.path
  bemerkt und brouter.service neu startet.

HTTP-API (nur 127.0.0.1, nicht über Caddy erreichbar):
    GET  /status                 Zustand
    GET  /tiles                  vorhandene Tiles
    POST /update                 alle Tiles jetzt prüfen
    POST /register {"name": …}   Tile oder Sammlung hinzufügen
    POST /restart-brouter        BRouter kontrolliert neu starten

Kommandozeile (spricht den laufenden Dienst an):
    brouter-updater.py status | update | register austria | serve
"""

import argparse
import datetime
import email.utils
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

from andromeda_lib import (
    PORT_BROUTER_UPDATER, BaseHandler, Paths, atomic_write_json,
    http_request, make_logger, read_json_file, serve,
)

log = make_logger("brouter-updater")

DOWNLOAD_BASE = "https://brouter.de/brouter"
BROUTER_PORT = 17777

WEEKLY_INTERVAL_S = 7 * 24 * 3600
SCHEDULER_CHECK_S = 600
DOWNLOAD_PAUSE_S = 1.0
IDLE_WAIT_S = 5            # so lange ohne Verbindung = „ruhig“
IDLE_TIMEOUT_S = 300
HTTP_TIMEOUT_S = 120
RESTART_AFTER_UPDATE = True

TILE_RE = re.compile(r"^[EW]\d{1,3}_[NS]\d{1,2}$")
COLLECTION_RE = re.compile(r"^[a-z][a-z0-9_]{0,40}$")


# =============================================================================
# HILFSFUNKTIONEN
# =============================================================================
def list_tiles():
    return sorted(p.name for p in Paths.segments.glob("*.rd5") if p.is_file())


def cleanup_tmp():
    for p in Paths.segments.glob("*.tmp"):
        try:
            p.unlink()
            log(f"Reste entfernt: {p.name}")
        except OSError as e:
            log(f"! {p.name}: {e}")


def _copy_stream(r, f):
    while True:
        chunk = r.read(1 << 20)
        if not chunk:
            return
        f.write(chunk)


def download(url, dest, only_if_newer=False):
    """Lädt url nach <dest>.tmp. Liefert den .tmp-Pfad oder None, wenn
    der Server meldet, dass sich nichts geändert hat (304)."""
    headers = {"User-Agent": "Andromeda-Explorer brouter-updater"}
    if only_if_newer and dest.exists():
        headers["If-Modified-Since"] = email.utils.formatdate(
            dest.stat().st_mtime, usegmt=True)
    tmp = dest.with_name(dest.name + ".tmp")
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
            last_mod = r.headers.get("Last-Modified")
            # Falls der Server If-Modified-Since ignoriert: Datum selbst vergleichen,
            # bevor der Inhalt geladen wird.
            if only_if_newer and dest.exists() and last_mod:
                try:
                    if email.utils.parsedate_to_datetime(last_mod).timestamp() \
                            <= dest.stat().st_mtime + 1:
                        return None
                except (TypeError, ValueError, OverflowError):
                    pass
            with open(tmp, "wb") as f:
                _copy_stream(r, f)
    except urllib.error.HTTPError as e:
        try:
            tmp.unlink()
        except OSError:
            pass
        if e.code == 304:
            return None
        raise
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    # Zeitstempel des Servers übernehmen (für das nächste If-Modified-Since)
    if last_mod:
        try:
            ts = email.utils.parsedate_to_datetime(last_mod).timestamp()
            os.utime(tmp, (ts, ts))
        except (TypeError, ValueError, OverflowError):
            pass
    return tmp


def replace_with_backup(tmp, dest):
    """Alte Datei als Hardlink nach segments4_backup/, dann atomar ersetzen."""
    if dest.exists():
        backup = Paths.segments_backup / dest.name
        try:
            Paths.segments_backup.mkdir(parents=True, exist_ok=True)
            if backup.exists():
                backup.unlink()
            os.link(dest, backup)
        except OSError as e:
            log(f"! Backup von {dest.name} fehlgeschlagen: {e}")
    os.replace(tmp, dest)


def active_brouter_connections():
    try:
        r = subprocess.run(["ss", "-tnH", "state", "established",
                            f"( sport = :{BROUTER_PORT} )"],
                           capture_output=True, text=True, timeout=5)
        return sum(1 for line in r.stdout.splitlines() if line.strip()) if r.returncode == 0 else 0
    except (OSError, subprocess.TimeoutExpired):
        return 0


def wait_until_idle():
    start, idle_since = time.monotonic(), None
    while time.monotonic() - start < IDLE_TIMEOUT_S:
        if active_brouter_connections() == 0:
            idle_since = idle_since or time.monotonic()
            if time.monotonic() - idle_since >= IDLE_WAIT_S:
                return True
        else:
            idle_since = None
        time.sleep(1)
    return False


def request_brouter_restart():
    """Signal an brouter-restart.path (systemd startet BRouter neu)."""
    try:
        Paths.restart_request.write_text(str(int(time.time())), encoding="utf-8")
        log("BRouter-Neustart angefordert.")
        return True
    except OSError as e:
        log(f"! Neustart-Anforderung fehlgeschlagen: {e}")
        return False


# =============================================================================
# ZUSTAND
# =============================================================================
_state_lock = threading.Lock()
_update_lock = threading.Lock()


def load_state():
    with _state_lock:
        s = read_json_file(Paths.updater_state)
        if not isinstance(s, dict):
            s = {}
        s.setdefault("last_update", 0)
        s.setdefault("registered_collections", {})
        s.setdefault("last_error", None)
        return s


def save_state(**changes):
    with _state_lock:
        s = read_json_file(Paths.updater_state)
        s = s if isinstance(s, dict) else {}
        s.update(changes)
        atomic_write_json(Paths.updater_state, s)


def fetch_collection_tiles(collection):
    url = f"{DOWNLOAD_BASE}/segments4_{collection}/"
    try:
        status, _, body = http_request(url, timeout=30)
        if status == 200:
            names = re.findall(r'href="([^"?/]+\.rd5)"', body.decode("utf-8", "replace"))
            if names:
                return sorted(set(names))
    except OSError as e:
        log(f"Verzeichnis von {collection} nicht lesbar: {e}")
    raise RuntimeError(f"Keine Tiles für Sammlung {collection!r} gefunden.")


def parse_name(name):
    name = (name or "").strip()
    if TILE_RE.match(name):
        return "tile", name
    if COLLECTION_RE.match(name):
        return "collection", name
    raise ValueError(f"Ungültiger Name {name[:40]!r} (z. B. E15_N45 oder austria).")


def _fetch_and_install(jobs, only_if_newer):
    """jobs: [(tile, url)] → (ersetzt, unverändert, fehlgeschlagen)"""
    downloaded, unchanged, failed = [], [], []
    for i, (tile, url) in enumerate(jobs, 1):
        try:
            tmp = download(url, Paths.segments / tile, only_if_newer)
            if tmp is None:
                unchanged.append(tile)
                log(f"  [{i}/{len(jobs)}] {tile}: unverändert")
            else:
                downloaded.append((tile, tmp))
                log(f"  [{i}/{len(jobs)}] {tile}: neu geladen")
        except urllib.error.HTTPError as e:
            log(f"  [{i}/{len(jobs)}] {tile}: HTTP {e.code}")
            if e.code != 404:
                failed.append(tile)
        except Exception as e:  # noqa: BLE001
            log(f"  [{i}/{len(jobs)}] {tile}: {e}")
            failed.append(tile)
        if i < len(jobs):
            time.sleep(DOWNLOAD_PAUSE_S)

    if downloaded:
        log("Warte, bis BRouter ruhig ist …")
        if not wait_until_idle():
            for _, tmp in downloaded:
                tmp.unlink(missing_ok=True)
            raise RuntimeError("BRouter blieb zu lange beschäftigt. Nichts ersetzt.")
        for tile, tmp in downloaded:
            replace_with_backup(tmp, Paths.segments / tile)
        log(f"{len(downloaded)} Tiles ersetzt.")
        if RESTART_AFTER_UPDATE:
            request_brouter_restart()
    return [t for t, _ in downloaded], unchanged, failed


def run_update():
    tiles = list_tiles()
    log(f"Prüfe {len(tiles)} Tiles …")
    done, same, failed = _fetch_and_install(
        [(t, f"{DOWNLOAD_BASE}/segments4/{t}") for t in tiles], only_if_newer=True)
    if tiles and not done and not same:
        raise RuntimeError("Kein Tile erreichbar.")
    save_state(last_update=time.time(), last_error=None)
    return {"ok": True, "updated": len(done), "unchanged": len(same), "failed": failed}


def run_register(name):
    kind, value = parse_name(name)
    if kind == "tile":
        jobs = [(f"{value}.rd5", f"{DOWNLOAD_BASE}/segments4/{value}.rd5")]
    else:
        jobs = [(t, f"{DOWNLOAD_BASE}/segments4_{value}/{t}")
                for t in fetch_collection_tiles(value)]
    log(f"Registriere {kind} {value}: {len(jobs)} Tiles")
    done, same, failed = _fetch_and_install(jobs, only_if_newer=False)
    if not done:
        raise RuntimeError("Kein Tile heruntergeladen.")
    if kind == "collection":
        s = load_state()
        s["registered_collections"][value] = {"last_updated": time.time(),
                                              "tile_count": len(done)}
        save_state(registered_collections=s["registered_collections"], last_error=None)
    return {"ok": True, "kind": kind, "name": value, "downloaded": len(done),
            "failed": failed}


def start_job(fn, *args):
    """Startet fn im Hintergrund. False, wenn schon ein Job läuft."""
    if not _update_lock.acquire(blocking=False):
        return False

    def run():
        try:
            log(f"fertig: {fn(*args)}")
        except Exception as e:  # noqa: BLE001
            log(f"! Fehler: {e}")
            save_state(last_error=str(e))
        finally:
            _update_lock.release()
    threading.Thread(target=run, daemon=True, name="job").start()
    return True


def scheduler():
    while True:
        try:
            if time.time() - load_state()["last_update"] >= WEEKLY_INTERVAL_S:
                log("Wöchentliche Prüfung fällig.")
                start_job(run_update)
        except Exception as e:  # noqa: BLE001
            log(f"! Scheduler: {e}")
        time.sleep(SCHEDULER_CHECK_S)


# =============================================================================
# HTTP
# =============================================================================
class Handler(BaseHandler):
    log = staticmethod(log)
    cors_origin = None

    def do_GET(self):
        if not self.is_direct_local():
            return self.send_text(403, "Nur lokal.")
        path = urlparse(self.path).path
        if path == "/tiles":
            tiles = list_tiles()
            return self.send_json(200, {"count": len(tiles), "tiles": tiles})
        if path == "/status":
            s = load_state()
            last = s["last_update"]
            return self.send_json(200, {
                "last_update": last,
                "last_update_iso": datetime.datetime.fromtimestamp(
                    last, datetime.timezone.utc).isoformat() if last else None,
                "next_check_in_s": max(0, WEEKLY_INTERVAL_S - (time.time() - last)),
                "last_error": s["last_error"],
                "tile_count": len(list_tiles()),
                "registered_collections": s["registered_collections"],
                "update_in_progress": _update_lock.locked(),
                "brouter_active_connections": active_brouter_connections(),
                "restart_after_update": RESTART_AFTER_UPDATE,
            })
        self.send_json(404, {"error": "Nicht gefunden"})

    def do_POST(self):
        if not self.is_direct_local():
            return self.send_text(403, "Nur lokal.")
        path = urlparse(self.path).path
        if path == "/update":
            if not start_job(run_update):
                return self.send_json(409, {"ok": False, "error": "Es läuft bereits ein Job."})
            return self.send_json(202, {"ok": True, "message": "Prüfung gestartet."})
        if path == "/register":
            body = self.read_json() or {}
            try:
                kind, value = parse_name(body.get("name"))
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            if not start_job(run_register, value):
                return self.send_json(409, {"ok": False, "error": "Es läuft bereits ein Job."})
            return self.send_json(202, {"ok": True, "kind": kind, "name": value})
        if path == "/restart-brouter":
            if _update_lock.locked():
                return self.send_json(409, {"ok": False, "error": "Es läuft gerade ein Job."})
            if not wait_until_idle():
                return self.send_json(503, {"ok": False, "error": "BRouter ist beschäftigt."})
            return self.send_json(200, {"ok": request_brouter_restart()})
        self.send_json(404, {"error": "Nicht gefunden"})


def _cli(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{PORT_BROUTER_UPDATER}{path}",
                                 data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            print(json.dumps(json.loads(r.read()), indent=2, ensure_ascii=False))
    except urllib.error.HTTPError as e:
        print(e.read().decode("utf-8", "replace"))
        sys.exit(1)
    except OSError as e:
        print(f"Dienst nicht erreichbar: {e}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="BRouter-Segmente aktuell halten")
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("serve")
    sub.add_parser("status")
    sub.add_parser("update")
    sub.add_parser("register").add_argument("name")
    args = parser.parse_args()
    if args.cmd == "status":
        return _cli("GET", "/status")
    if args.cmd == "update":
        return _cli("POST", "/update", {})
    if args.cmd == "register":
        return _cli("POST", "/register", {"name": args.name})

    Paths.segments.mkdir(parents=True, exist_ok=True)
    cleanup_tmp()
    threading.Thread(target=scheduler, daemon=True, name="scheduler").start()
    tiles = list_tiles()
    serve(Handler, PORT_BROUTER_UPDATER, log=log, banner_lines=[
        f"Segmente: {Paths.segments} ({len(tiles)} Tiles)",
        f"Prüfung alle {WEEKLY_INTERVAL_S // 86400} Tage, Neustart danach: "
        f"{'ja' if RESTART_AFTER_UPDATE else 'nein'}",
    ])


if __name__ == "__main__":
    main()
