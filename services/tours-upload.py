#!/usr/bin/env python3
"""
tours-upload — öffentlicher TourPack-Upload
===========================================

(vorher tourpack-upload.py)

    POST /upload   Body: die .tourpack-Datei, Header X-Tourpack-Name

Prüft nur die Struktur (ZIP, Whitelist, Größen, mimetype, manifest,
route) — kein Bild wird hier geöffnet. Gültige Uploads landen in
tours/inbox/<job>.tourpack mit einem Auftragszettel in tours/jobs/.
Erst wenn der Admin „Aufbereiten“ wählt, verarbeitet tours-sanitizer
die Datei.

Schutz: 3 Uploads pro Stunde und IP, max. 30 MB pro Datei, max. 1 GB
im Eingang insgesamt.

Schreibt nur: Paths.inbox, Paths.jobs.
"""

import threading
import time
import uuid
from pathlib import PurePosixPath
from urllib.parse import urlparse

from andromeda_lib import (
    PORT_UPLOAD, SAFE_FILENAME_RE, BaseHandler, Paths, SlidingWindowLimiter,
    atomic_write_bytes, atomic_write_json, inspect_tourpack, make_logger, serve,
)

log = make_logger("tours-upload")

MAX_FILE_BYTES = 30 * 1024 * 1024
MAX_INBOX_BYTES = 1024 * 1024 * 1024
RATE = SlidingWindowLimiter(3, 3600, 3600)

_inbox_lock = threading.Lock()


def inbox_usage_bytes():
    total = 0
    for f in Paths.inbox.glob("*.tourpack"):
        try:
            total += f.stat().st_size
        except OSError:
            pass
    return total


class Handler(BaseHandler):
    timeout = 60
    log = staticmethod(log)
    cors_methods = "POST, OPTIONS"
    cors_headers = "Content-Type, X-Tourpack-Name"

    def do_GET(self):
        self.send_text(405, "Nur POST auf /upload erlaubt.")

    def do_POST(self):
        if urlparse(self.path).path != "/upload":
            return self.send_text(404, "Nicht gefunden.")
        ok, wait = RATE.check(self.client_ip())
        if not ok:
            return self.send_too_many(wait, "Uploads")

        name = PurePosixPath(self.headers.get("X-Tourpack-Name", "").strip()
                             .replace("\\", "/")).name
        if not name:
            return self.send_json(400, {"error": "Dateiname fehlt"})
        if not SAFE_FILENAME_RE.match(name):
            return self.send_json(400, {"error": "Ungültiger Dateiname"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_FILE_BYTES:
            return self.send_json(413, {"error": "Datei zu groß. Maximal 30 MB."})
        data = self.read_body(MAX_FILE_BYTES)
        if data is None:
            return self.send_json(400, {"error": "Konnte Datei nicht lesen"})

        ok, info = inspect_tourpack(data)
        if not ok:
            self.rlog(f"Upload abgelehnt ({info})")
            return self.send_json(400, {"error": f"Ungültiges TourPack: {info}"})

        job_id = uuid.uuid4().hex
        src = Paths.inbox / f"{job_id}.tourpack"
        with _inbox_lock:
            usage = inbox_usage_bytes()
            if usage + len(data) > MAX_INBOX_BYTES:
                self.rlog(f"Upload abgelehnt — Eingang voll ({usage >> 20} MB)")
                return self.send_json(503, {"error": "Der Upload-Bereich ist derzeit "
                                                     "voll. Bitte später erneut versuchen."})
            try:
                atomic_write_bytes(src, data)
                atomic_write_json(Paths.jobs / f"{job_id}.json", {
                    "id": job_id,
                    "original_name": name,
                    "uploaded_at": time.time(),
                    "status": "waiting",
                    "size": len(data),
                    "manifest_preview": info,
                })
            except OSError as e:
                self.rlog(f"! Schreiben fehlgeschlagen: {e}")
                src.unlink(missing_ok=True)
                return self.send_json(500, {"error": "Serverfehler"})
        self.rlog(f"Upload ok: {job_id} ({len(data)} B, {name})")
        self.send_json(200, {"ok": True})


def main():
    for d in (Paths.inbox, Paths.jobs):
        if not d.is_dir():
            log(f"!! Ordner fehlt: {d} (deploy/setup.sh ausführen)")
    serve(Handler, PORT_UPLOAD, log=log, banner_lines=[
        f"Eingang: {Paths.inbox} (max. {MAX_INBOX_BYTES >> 30} GB, "
        f"{MAX_FILE_BYTES >> 20} MB pro Datei)",
        f"Limit:   {RATE.max} Uploads / {RATE.window // 60} min pro IP",
    ])


if __name__ == "__main__":
    main()
