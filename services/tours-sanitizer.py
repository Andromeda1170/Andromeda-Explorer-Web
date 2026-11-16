#!/usr/bin/env python3
"""
tours-sanitizer — bereitet hochgeladene TourPacks auf
=====================================================

(vorher tourpack-worker.py)

Läuft ohne Netzwerk (systemd PrivateNetwork) als eigener Benutzer.
Wartet auf Aufträge mit Status „requested“ (setzt tours-admin) und
erzeugt aus tours/inbox/<job>.tourpack einen sauberen Ordner
tours/staging/<job>/:

- Jede Datei wird neu geschrieben, nichts wird 1:1 übernommen:
  · manifest.json, route.json, geometry.geojson: geparst, geprüft und
    neu serialisiert; die Tour bekommt eine neue ID (ein Upload kann
    so nie eine bestehende Tour ersetzen).
  · description.md: muss UTF-8 sein, wird neu geschrieben.
  · Bilder: von Pillow dekodiert, gedreht laut EXIF, auf max. 1920 px
    verkleinert und im Format der Dateiendung neu kodiert — ohne EXIF,
    GPS und Kommentare. GIFs werden Bild für Bild neu geschrieben
    (Animationen bleiben erhalten).
- Geschrieben wird nach staging/.tmp-<job>/ und erst am Ende
  umbenannt; halbe Ergebnisse sind nie sichtbar.

Schreibt nur: Paths.staging, Paths.jobs, löscht in Paths.inbox.
"""

import io
import json
import os
import shutil
import signal
import time
import traceback
import uuid
import zipfile
from pathlib import Path

from PIL import Image, ImageFile, ImageOps, ImageSequence, UnidentifiedImageError

from andromeda_lib import (
    IMAGE_PATH_RE, MAX_TOURPACK_BYTES, Paths, atomic_write_json,
    inspect_tourpack, make_logger, read_json_file,
)

Image.MAX_IMAGE_PIXELS = 50_000_000          # Schutz vor Dekompressionsbomben
ImageFile.LOAD_TRUNCATED_IMAGES = False
log = make_logger("tours-sanitizer")

POLL_INTERVAL_S = 2
MAX_EDGE = 1920
JPEG_QUALITY = 82
WEBP_QUALITY = 82
MAX_GIF_FRAMES = 300

# Endung → (Pillow-Format beim Speichern, erlaubte erkannte Formate)
FORMAT_BY_EXT = {
    ".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP", ".gif": "GIF",
}
ACCEPTED_INPUT = {"JPEG", "PNG", "WEBP", "GIF"}


class Reject(Exception):
    """Upload ist ungültig — Auftrag endet mit Fehler."""


# =============================================================================
# BILDER
# =============================================================================
def _fit(img):
    w, h = img.size
    if w > MAX_EDGE or h > MAX_EDGE:
        r = min(MAX_EDGE / w, MAX_EDGE / h)
        img = img.resize((max(1, int(w * r)), max(1, int(h * r))), Image.Resampling.LANCZOS)
    return img


def _recode_gif(img):
    frames, durations = [], []
    for i, frame in enumerate(ImageSequence.Iterator(img)):
        if i >= MAX_GIF_FRAMES:
            raise Reject(f"GIF mit mehr als {MAX_GIF_FRAMES} Bildern")
        durations.append(int(frame.info.get("duration", 100)) or 100)
        clean = _fit(frame.convert("RGBA"))
        clean.info = {}
        frames.append(clean)
    out = io.BytesIO()
    first = frames[0]
    first.save(out, format="GIF", save_all=len(frames) > 1, append_images=frames[1:],
               duration=durations if len(frames) > 1 else durations[0],
               loop=int(img.info.get("loop", 0)), disposal=2, optimize=True)
    return out.getvalue()


def recode_image(data, ext):
    """Dekodiert das Bild und kodiert es im Format der Endung neu.
    Metadaten (EXIF, GPS, XMP, Kommentare) fallen dabei weg."""
    target = FORMAT_BY_EXT.get(ext)
    if not target:
        raise Reject(f"Unerlaubte Endung {ext}")
    try:
        with Image.open(io.BytesIO(data)) as img:
            if (img.format or "").upper() not in ACCEPTED_INPUT:
                raise Reject(f"Unerwartetes Bildformat: {img.format or '?'}")
            if target == "GIF":
                if img.format != "GIF":
                    raise Reject("Endung .gif, Inhalt ist kein GIF")
                return _recode_gif(img)
            img.load()
            icc = img.info.get("icc_profile")   # Farbprofil behalten, sonst nichts
            img = _fit(ImageOps.exif_transpose(img))
            img.info = {}                        # Pillow schreibt sonst z. B. Kommentare mit
            out = io.BytesIO()
            extra = {"icc_profile": icc} if icc else {}
            if target == "JPEG":
                if img.mode not in ("RGB", "L"):
                    img = img.convert("RGB")
                img.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True,
                         progressive=True, **extra)
            elif target == "PNG":
                if img.mode not in ("RGB", "RGBA", "L", "LA", "P"):
                    img = img.convert("RGBA")
                img.save(out, format="PNG", optimize=True, **extra)
            else:
                if img.mode not in ("RGB", "RGBA"):
                    img = img.convert("RGBA")
                img.save(out, format="WEBP", quality=WEBP_QUALITY, method=4, **extra)
            return out.getvalue()
    except Reject:
        raise
    except UnidentifiedImageError:
        raise Reject("kein gültiges Bild") from None
    except Image.DecompressionBombError:
        raise Reject("Bild hat zu viele Pixel") from None
    except (OSError, ValueError, SyntaxError) as e:
        raise Reject(f"Bild nicht ladbar: {e}") from None


# =============================================================================
# TEXTDATEIEN
# =============================================================================
def _reject_constant(name):
    raise ValueError(f"ungültige Zahl {name}")


def parse_json(name, data):
    try:
        obj = json.loads(data.decode("utf-8"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError) as e:
        raise Reject(f"{name} unlesbar: {e}") from None
    if not isinstance(obj, dict):
        raise Reject(f"{name} ist kein Objekt")
    return obj


def dump_json(obj, compact=False):
    if compact:
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":"),
                          allow_nan=False).encode("utf-8")
    return json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")


def clean_markdown(data):
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise Reject("description.md ist kein UTF-8") from None
    text = text.lstrip("﻿").replace("\x00", "").replace("\r\n", "\n")
    return text.encode("utf-8")


# =============================================================================
# TOURPACK → ORDNER
# =============================================================================
def sanitize_tourpack(src_path, dst_dir, new_id):
    if src_path.stat().st_size > MAX_TOURPACK_BYTES:
        raise Reject("Datei zu groß")
    ok, info = inspect_tourpack(src_path)       # Struktur, Whitelist, Größen
    if not ok:
        raise Reject(info)

    stats = {"images": 0, "original_id": None}
    with zipfile.ZipFile(src_path) as zf:
        names = [n for n in zf.namelist() if not n.endswith("/") and n != "mimetype"]
        dst_dir.mkdir(parents=True)
        for name in names:
            data = zf.read(name)
            if name in ("manifest.json", "route.json"):
                obj = parse_json(name, data)
                old = obj.get("id")
                if isinstance(old, str) and (name == "manifest.json" or not stats["original_id"]):
                    stats["original_id"] = old[:64]
                obj["id"] = new_id
                data = dump_json(obj)
            elif name == "geometry.geojson":
                data = dump_json(parse_json(name, data), compact=True)
            elif name == "description.md":
                data = clean_markdown(data)
            elif IMAGE_PATH_RE.match(name):
                try:
                    data = recode_image(data, Path(name).suffix.lower())
                except Reject as e:
                    raise Reject(f"{name}: {e}") from None
                stats["images"] += 1
            else:                                        # durch inspect_tourpack ausgeschlossen
                raise Reject(f"Unerlaubter Eintrag: {name[:60]}")
            out = dst_dir / name
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
    return stats


# =============================================================================
# AUFTRÄGE
# =============================================================================
_running = True


def _stop(signum, frame):
    global _running
    _running = False
    log("Signal empfangen, beende nach aktuellem Auftrag.")


def _rmtree(p):
    if p.exists():
        shutil.rmtree(p, ignore_errors=True)


def process_job(job_path, job):
    job_id = job["id"]
    src = Paths.inbox / f"{job_id}.tourpack"
    tmp_dir = Paths.staging / f".tmp-{job_id}"
    final_dir = Paths.staging / job_id
    if not src.is_file():
        job.update(status="error", error="Quelldatei fehlt")
        atomic_write_json(job_path, job)
        return
    job.update(status="processing", error=None)
    atomic_write_json(job_path, job)
    _rmtree(tmp_dir)
    _rmtree(final_dir)
    new_id = str(uuid.uuid4())
    t0 = time.monotonic()
    try:
        stats = sanitize_tourpack(src, tmp_dir, new_id)
        tmp_dir.rename(final_dir)
    except Exception as e:  # noqa: BLE001 — jeder Fehler beendet nur diesen Auftrag
        _rmtree(tmp_dir)
        msg = str(e) if isinstance(e, Reject) else f"Interner Fehler: {e}"
        if not isinstance(e, Reject):
            traceback.print_exc()
        job.update(status="error", error=msg[:300])
        atomic_write_json(job_path, job)
        log(f"✗ {job_id}: {msg}")
        return
    src.unlink(missing_ok=True)
    job.update(status="done", processed_at=time.time(), images_processed=stats["images"],
               images_replaced=stats["images"], assigned_id=new_id,
               original_id=stats["original_id"])
    atomic_write_json(job_path, job)
    log(f"✓ {job_id}: {stats['images']} Bilder neu kodiert, ID → {new_id} "
        f"({time.monotonic() - t0:.1f}s)")


def poll_once():
    for job_path in sorted(Paths.jobs.glob("*.json")):
        if not _running:
            return
        job = read_json_file(job_path)
        if not isinstance(job, dict) or job.get("status") != "requested":
            continue
        job_id = job.get("id")
        if not isinstance(job_id, str) or job_path.stem != job_id or not job_id.isalnum():
            continue
        log(f"→ {job_id}")
        process_job(job_path, job)


def main():
    os.umask(0o007)              # Gruppe andromeda-pipeline darf lesen/schreiben
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    for tmp in Paths.staging.glob(".tmp-*"):
        _rmtree(tmp)
        log(f"Reste entfernt: {tmp.name}")
    # Aufträge, die beim letzten Beenden mittendrin waren, neu anstoßen
    for job_path in Paths.jobs.glob("*.json"):
        job = read_json_file(job_path)
        if isinstance(job, dict) and job.get("status") == "processing":
            job["status"] = "requested"
            atomic_write_json(job_path, job)
    log(f"Bereit. Eingang {Paths.inbox}, Ausgabe {Paths.staging}")
    while _running:
        try:
            poll_once()
        except Exception:  # noqa: BLE001
            log("! Fehler in der Hauptschleife:")
            traceback.print_exc()
        for _ in range(POLL_INTERVAL_S * 10):
            if not _running:
                break
            time.sleep(0.1)
    log("Beendet.")


if __name__ == "__main__":
    main()
