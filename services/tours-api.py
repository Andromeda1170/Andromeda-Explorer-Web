#!/usr/bin/env python3
"""
tours-api — öffentliche Tour-Schnittstelle
==========================================

(vorher tourpack-handler.py)

Liest die veröffentlichten Touren (Paths.published, nur lesend), hält
einen Suchindex, erzeugt Vorschaubilder und statische Seiten für
Suchmaschinen und liefert alles aus:

    GET /search?…                         Suche
    GET /thumbnail/<id>                   Vorschaubild
    GET /tourpack/<id>/                   statische Tour-Seite
    GET /tourpack/<id>/<datei>            manifest/route/geometry/description/Bilder
    GET /touren/                          Liste aller Touren
    GET /sitemap.xml

Neue, geänderte oder gelöschte Touren bemerkt der Dienst über den
Zeitstempel von published/.changed (setzt tours-admin) und zusätzlich
alle 10 Minuten. Geschrieben wird nur unter Paths.api.

Start:  tours-api.py [--force-rescan]
"""

import argparse
import html
import io
import json
import math
import threading
import time
import unicodedata
from email.utils import formatdate, parsedate_to_datetime
from urllib.parse import parse_qs, urlparse

from PIL import Image, ImageOps

from andromeda_lib import (
    ACTIVITIES, IMAGE_CONTENT_TYPES, IMAGE_PATH_RE, MAX_IMAGE_BYTES,
    ORIGIN, PORT_TOURS_API, SAFE_ID_RE,
    TOURPACK_FORMAT, BaseHandler, Paths, SlidingWindowLimiter,
    atomic_write_bytes, atomic_write_json, make_logger, read_json_file, serve,
)

Image.MAX_IMAGE_PIXELS = 50_000_000
log = make_logger("tours-api")

# =============================================================================
# KONFIGURATION
# =============================================================================
SEARCH_LIMITER = SlidingWindowLimiter(120, 60, 180)    # Suche, Listen
FILE_LIMITER = SlidingWindowLimiter(1500, 60, 120)     # Dateien, Bilder
MAX_URL_LEN = 4 * 1024

SCAN_INTERVAL_S = 600         # Vollscan zur Sicherheit
CHANGE_POLL_S = 2             # published/.changed beobachten

SEARCH_DEFAULT_LIMIT = 20
SEARCH_MAX_LIMIT = 500
SEARCH_HARD_LIMIT = 500
DEFAULT_RADIUS_KM = 100.0
MAX_RADIUS_KM = 100.0
MAX_TOUR_LENGTH_KM = 300.0

ROUNDTRIP_MAX_DISTANCE_M = 70.0     # Start/Ziel so nah …
ROUNDTRIP_MAX_ELE_DIFF_M = 40.0     # … und auf ähnlicher Höhe

ALLOWED_SEARCH_PARAMS = {
    "q", "activity", "limit", "offset", "near", "radius_km",
    "min_km", "max_km", "diff_min", "diff_max", "region",
    "roundtrip", "roadbike",
}

THUMBNAIL_MAX_EDGE = 600
THUMBNAIL_QUALITY = 80

TOUR_LIST_PAGE = Paths.api_pages / "_touren.html"
CONTENT_TYPES = {
    "manifest.json": "application/json; charset=utf-8",
    "route.json": "application/json; charset=utf-8",
    "geometry.geojson": "application/geo+json; charset=utf-8",
    "description.md": "text/markdown; charset=utf-8",
}


# =============================================================================
# INDEX
# =============================================================================
_scan_lock = threading.Lock()
_index_lock = threading.RLock()
_index = {}


def _load_index_from_disk():
    idx = {}
    for p in Paths.api_index.glob("*.json"):
        entry = read_json_file(p)
        if isinstance(entry, dict) and isinstance(entry.get("id"), str) \
                and SAFE_ID_RE.match(entry["id"]):
            idx[entry["id"]] = entry
    return idx


def _write_index_entry(entry):
    atomic_write_json(Paths.api_index / f"{entry['id']}.json", entry)


def _delete_index_entry(tp_id):
    for p in (Paths.api_index / f"{tp_id}.json", Paths.api_pages / f"{tp_id}.html"):
        p.unlink(missing_ok=True)
    _clear_old_thumbnails(tp_id)


# =============================================================================
# HILFSFUNKTIONEN
# =============================================================================
def _normalize_for_search(s):
    if not isinstance(s, str):
        s = str(s or "")
    s = s.lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s


def _num_or_none(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return f


def _int_in_range(v, lo, hi):
    try:
        n = int(v)
    except (TypeError, ValueError):
        return 0
    return max(lo, min(hi, n))


def _coord_or_none(v):
    if not isinstance(v, (list, tuple)) or len(v) < 2:
        return None
    try:
        lon, lat = float(v[0]), float(v[1])
    except (TypeError, ValueError):
        return None
    if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
        return None
    return [lon, lat]


def _haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = (math.sin(dphi / 2) ** 2
         + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(a))


def _parse_near(params):
    near_raw = (params.get("near", [""])[0] or "").strip()
    if not near_raw:
        return None
    parts = near_raw.split(",")
    if len(parts) != 2:
        return None
    try:
        lat = float(parts[0])
        lon = float(parts[1])
    except ValueError:
        return None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return None

    radius_raw = (params.get("radius_km", [str(DEFAULT_RADIUS_KM)])[0] or "").strip()
    try:
        radius_km = float(radius_raw)
    except ValueError:
        radius_km = DEFAULT_RADIUS_KM
    if radius_km != radius_km or radius_km <= 0:
        radius_km = DEFAULT_RADIUS_KM
    radius_km = min(radius_km, MAX_RADIUS_KM)
    return lat, lon, radius_km * 1000.0


# =============================================================================
# THUMBNAIL-ERZEUGUNG
# =============================================================================
def _thumbnail_target_path(tp_id):
    return Paths.api_thumbnails / f"{tp_id}.jpg"


def _clear_old_thumbnails(tp_id):
    for old in Paths.api_thumbnails.glob(f"{tp_id}.*"):
        try:
            old.unlink()
        except OSError:
            pass


def _make_thumbnail(data, src_ext, tp_id):
    """Skaliert das Bild auf THUMBNAIL_MAX_EDGE und speichert es als JPEG.
    Rückgabe: ".jpg" oder None (dann gibt es kein Vorschaubild)."""
    _clear_old_thumbnails(tp_id)
    try:
        with Image.open(io.BytesIO(data)) as img:
            img.load()
            img = ImageOps.exif_transpose(img)
            if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                img = img.convert("RGBA")
                bg = Image.new("RGB", img.size, (255, 255, 255))
                bg.paste(img, mask=img.split()[-1])
                img = bg
            elif img.mode != "RGB":
                img = img.convert("RGB")
            img.thumbnail((THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE), Image.Resampling.LANCZOS)
            img.save(_thumbnail_target_path(tp_id), format="JPEG",
                     quality=THUMBNAIL_QUALITY, optimize=True, progressive=True)
            return ".jpg"
    except Exception as e:  # noqa: BLE001 — kaputtes Bild: einfach kein Vorschaubild
        log(f"  ! Vorschaubild für {tp_id} nicht erzeugbar: {e}")
        return None


def _make_thumbnail_from_dir(dir_path, tp_id, route):
    """Bestimmt den Thumbnail-Kandidaten aus route.json und erzeugt ihn
    aus der Datei im entpackten Ordner."""
    candidate = None

    thumb_rel = route.get("thumbnail_file")
    if isinstance(thumb_rel, str) and IMAGE_PATH_RE.match(thumb_rel):
        candidate = thumb_rel

    if candidate is None:
        imgs = route.get("images") or []
        if isinstance(imgs, list):
            for it in imgs:
                p = it.get("path") if isinstance(it, dict) else it
                if isinstance(p, str) and IMAGE_PATH_RE.match(p):
                    candidate = p
                    break

    if candidate is None:
        wps = route.get("waypoints") or []
        if isinstance(wps, list):
            for wp in wps:
                if not isinstance(wp, dict):
                    continue
                for p in (wp.get("images") or []):
                    if isinstance(p, str) and IMAGE_PATH_RE.match(p):
                        candidate = p
                        break
                if candidate:
                    break

    if candidate is None:
        return None

    src_path = dir_path / candidate
    if not src_path.is_file():
        return None

    try:
        size = src_path.stat().st_size
    except OSError:
        return None
    if size > MAX_IMAGE_BYTES:
        log(f"  ! Thumbnail-Quelle zu groß: {size} B für {tp_id}")
        return None

    try:
        data = src_path.read_bytes()
    except OSError:
        return None

    return _make_thumbnail(data, src_path.suffix.lower(), tp_id)


# =============================================================================
# VERSION / INDEX-EINTRAG
# =============================================================================
def _get_version(dir_path):
    vfile = dir_path / ".version"
    if vfile.is_file():
        try:
            return int(vfile.read_text(encoding="utf-8").strip())
        except (ValueError, OSError):
            pass
    try:
        return int(dir_path.stat().st_mtime)
    except OSError:
        return 0

# =============================================================================
# RUNDTOUR-ERKENNUNG
# =============================================================================
def _extract_start_coord(dir_path):
    """Liest den ersten Punkt der Geometrie (Startpunkt der Tour).
    Liefert [lon, lat] oder None, wenn keine Geometrie vorhanden ist.
    MultiLineString: erster Punkt der ersten Linie."""
    geom_path = dir_path / "geometry.geojson"
    if not geom_path.is_file():
        return None
    try:
        geom = json.loads(geom_path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(geom, dict):
        return None
    for feat in geom.get("features", []):
        g = feat.get("geometry") if isinstance(feat, dict) else None
        if not isinstance(g, dict):
            continue
        gtype = g.get("type")
        if gtype == "LineString":
            coords = g.get("coordinates") or []
            if coords:
                c = coords[0]
                if isinstance(c, (list, tuple)) and len(c) >= 2:
                    try:
                        return [float(c[0]), float(c[1])]
                    except (TypeError, ValueError):
                        return None
        elif gtype == "MultiLineString":
            for line in (g.get("coordinates") or []):
                if line:
                    c = line[0]
                    if isinstance(c, (list, tuple)) and len(c) >= 2:
                        try:
                            return [float(c[0]), float(c[1])]
                        except (TypeError, ValueError):
                            return None
    return None


def _detect_roundtrip(dir_path):
    """Prüft, ob Start und Ziel der Tour nahe beieinander und auf
    ähnlicher Höhe liegen.

    Kriterien:
    - Start- und Endpunkt horizontal < ROUNDTRIP_MAX_DISTANCE_M
    - Falls beide Punkte eine Höhe haben: Höhendifferenz
      < ROUNDTRIP_MAX_ELE_DIFF_M
    - Fehlt die Höhe an einem der Punkte, entscheidet nur die Distanz.

    Rückgabe: True / False.
    """
    geom_path = dir_path / "geometry.geojson"
    if not geom_path.is_file():
        return False
    try:
        geom = json.loads(geom_path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    if not isinstance(geom, dict):
        return False

    features = geom.get("features") or []
    coords = []
    for feat in features:
        if not isinstance(feat, dict):
            continue
        g = feat.get("geometry")
        if not isinstance(g, dict):
            continue
        gtype = g.get("type")
        if gtype == "LineString":
            for c in (g.get("coordinates") or []):
                coords.append(c)
        elif gtype == "MultiLineString":
            for line in (g.get("coordinates") or []):
                for c in (line or []):
                    coords.append(c)

    if len(coords) < 2:
        return False

    first = coords[0]
    last = coords[-1]
    if not (isinstance(first, (list, tuple)) and len(first) >= 2 and
            isinstance(last, (list, tuple)) and len(last) >= 2):
        return False

    try:
        lon1, lat1 = float(first[0]), float(first[1])
        lon2, lat2 = float(last[0]), float(last[1])
    except (TypeError, ValueError):
        return False

    dist = _haversine_m(lat1, lon1, lat2, lon2)
    if dist > ROUNDTRIP_MAX_DISTANCE_M:
        return False

    # Höhen nur dann prüfen, wenn beide Punkte eine sinnvolle Höhe haben.
    if len(first) >= 3 and len(last) >= 3:
        try:
            e1 = float(first[2])
            e2 = float(last[2])
            if abs(e1 - e2) > ROUNDTRIP_MAX_ELE_DIFF_M:
                return False
        except (TypeError, ValueError):
            pass

    return True

def _build_index_entry(tp_id, dir_path, manifest, route, thumb_ext, version,
                       is_roundtrip=False, start_coord=None):
    stats = route.get("stats") or {}
    difficulty = route.get("difficulty") or {}
    ratings = difficulty.get("ratings") or {}
    location = route.get("location") or {}
    if not isinstance(location, dict):
        location = {}
    if not isinstance(ratings, dict):
        ratings = {}

    raw_tags = route.get("tags") or []
    tags = []
    if isinstance(raw_tags, list):
        for t in raw_tags:
            if isinstance(t, (str, int, float)):
                s = str(t).strip()
                if s:
                    tags.append(s[:60])
            if len(tags) >= 30:
                break

    title = manifest.get("title") or route.get("title") or dir_path.name
    if not isinstance(title, str):
        title = str(title)
    title = title.strip()[:200] or dir_path.name

    activity = route.get("type") or "hiking"
    if not isinstance(activity, str) or activity not in ACTIVITIES:
        activity = "hiking"

    wp_list = route.get("waypoints") or []
    img_list = route.get("images") or []

    def _clean_loc(l):
        if not isinstance(l, dict):
            return {}
        return {
            "country":      str(l.get("country")      or "").strip()[:100],
            "country_code": str(l.get("country_code") or "").strip()[:8].lower(),
            "region":       str(l.get("region")       or "").strip()[:100],
            "county":       str(l.get("county")       or "").strip()[:100],
            "municipality": str(l.get("municipality") or "").strip()[:100],
            "place":        str(l.get("place")        or "").strip()[:100],
        }

    if isinstance(location, dict) and (
        "start" in location or "center" in location or "end" in location
    ):
        loc_normalized = {
            "start":  _clean_loc(location.get("start")),
            "center": _clean_loc(location.get("center")),
            "end":    _clean_loc(location.get("end")),
        }
    else:
        flat = _clean_loc(location)
        loc_normalized = {"start": flat, "center": flat, "end": flat}

    return {
        "id": tp_id,
        "dir_name": dir_path.name,
        "version": version,
        "indexed_at": time.time(),
        "title": title,
        "activity": activity,
        "tags": tags,
        "location": loc_normalized,
        "stats": {
            "distance_m":   _num_or_none(stats.get("distance_m")),
            "ascent_m":     _num_or_none(stats.get("ascent_m")),
            "descent_m":    _num_or_none(stats.get("descent_m")),
            "duration_h":   _int_in_range(stats.get("duration_h") or 0, 0, 99),
            "duration_min": _int_in_range(stats.get("duration_min") or 0, 0, 59),
            "duration_text": str(stats.get("duration_text") or "").strip()[:100],
        },
        "difficulty": {
            "overall":   _int_in_range(ratings.get("overall"),   0, 5),
            "technique": _int_in_range(ratings.get("technique"), 0, 5),
            "condition": _int_in_range(ratings.get("condition"), 0, 5),
            "text":      str(difficulty.get("text") or "").strip()[:300],
        },
        "center_coord":   _coord_or_none(route.get("center_coord")),
        "start_coord":    start_coord,
        "thumbnail_ext":  thumb_ext,
        "waypoint_count": len(wp_list) if isinstance(wp_list, list) else 0,
        "image_count":    len(img_list) if isinstance(img_list, list) else 0,
        "is_roundtrip":   bool(is_roundtrip),
        "roadbike":       bool(route.get("roadbike")),
    }


def _index_from_dir(tp_id, dir_path, version):
    mf_path = dir_path / "manifest.json"
    rt_path = dir_path / "route.json"

    if not mf_path.is_file() or not rt_path.is_file():
        log(f"  ! {tp_id}: manifest.json oder route.json fehlt")
        return None

    try:
        manifest = json.loads(mf_path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        log(f"  ! {tp_id}: manifest.json unlesbar: {e}")
        return None
    if not isinstance(manifest, dict):
        return None

    fmt = manifest.get("format")
    if fmt and fmt != TOURPACK_FORMAT:
        log(f"  ! {tp_id}: Format '{fmt}' statt '{TOURPACK_FORMAT}'")
        return None

    try:
        route = json.loads(rt_path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        log(f"  ! {tp_id}: route.json unlesbar: {e}")
        return None
    if not isinstance(route, dict):
        return None

    thumb_ext = _make_thumbnail_from_dir(dir_path, tp_id, route)
    is_roundtrip = _detect_roundtrip(dir_path)
    start_coord = _extract_start_coord(dir_path)

    entry = _build_index_entry(
        tp_id, dir_path, manifest, route, thumb_ext, version, is_roundtrip,
        start_coord
    )
    return entry, manifest, route


# =============================================================================
# STATISCHE HTML-GENERIERUNG (SEO)
# =============================================================================
def _md_to_html(text):
    """Minimalistischer Markdown-Konverter für die statischen Seiten."""
    if not text:
        return ""
    lines = text.split("\n")
    out = []
    in_list = False
    for line in lines:
        line = html.escape(line.strip())
        if not line:
            if in_list: out.append("</ul>"); in_list = False
            continue
        if line.startswith("### "): out.append(f"<h4>{line[4:]}</h4>")
        elif line.startswith("## "): out.append(f"<h3>{line[3:]}</h3>")
        elif line.startswith("# "): out.append(f"<h2>{line[2:]}</h2>")
        elif line.startswith("- ") or line.startswith("* "):
            if not in_list: out.append("<ul>"); in_list = True
            out.append(f"<li>{line[2:]}</li>")
        else:
            if in_list: out.append("</ul>"); in_list = False
            out.append(f"<p>{line}</p>")
    if in_list: out.append("</ul>")
    return "\n".join(out)

def _generate_tour_html(tp_id, dir_path, manifest, route):
    """Erzeugt eine kompakte, statische HTML-Seite für eine Tour."""
    title = html.escape(manifest.get("title") or route.get("title") or "Untitled Tour")
    desc = route.get("description", {})
    desc_text = ""
    if isinstance(desc, str):
        desc_text = desc
    else:
        desc_file = dir_path / "description.md"
        if desc_file.is_file():
            try: desc_text = desc_file.read_text(encoding="utf-8")
            except Exception: pass

    stats = route.get("stats", {})
    dist = f"{stats.get('distance_m', 0) / 1000:.1f} km" if stats.get("distance_m") else ""
    asc = f"{round(stats.get('ascent_m', 0))} m" if stats.get("ascent_m") else ""
    desc_asc = f"{round(stats.get('descent_m', 0))} m" if stats.get("descent_m") else ""
    dur_h = stats.get("duration_h", 0)
    dur_m = stats.get("duration_min", 0)
    dur = f"{dur_h} h {dur_m} min" if dur_h or dur_m else ""

    ratings = route.get("difficulty", {}).get("ratings", {})

    def star_row(label, val):
        val = int(val) if val else 0
        stars = "★" * val + "☆" * (5 - val)
        val_str = f"{val} / 5" if val > 0 else "—"
        return (
            f'<div style="display:grid;grid-template-columns:90px 90px 50px;'
            f'gap:8px;align-items:center;margin-bottom:5px;font-size:13px;">'
            f'<span style="color:var(--text-muted);">{label}:</span>'
            f'<span style="color:var(--gold);letter-spacing:1px;">{stars}</span>'
            f'<span style="color:var(--text);font-weight:bold;">{val_str}</span>'
            f'</div>'
        )

    diff_html = ""
    if any(ratings.values()):
        diff_html = f"""
        <div style="margin-top:15px; border-top:1px solid var(--border); padding-top:10px; max-width:250px;">
            {star_row("Difficulty", ratings.get("overall", 0))}
            {star_row("Technique", ratings.get("technique", 0))}
            {star_row("Condition", ratings.get("condition", 0))}
        </div>
        """

    loc = route.get("location", {}).get("start", {})
    loc_str = ", ".join(filter(None, [loc.get("place"), loc.get("region"), loc.get("country")]))

    activity = route.get("type", "hiking")
    act_label = {"hiking": "Hiking", "cycling": "Cycling", "running": "Running", "skiing": "Ski Tour"}.get(activity, activity)

    imgs = []
    def _safe_img(p):
        return isinstance(p, str) and IMAGE_PATH_RE.match(p)
    for img in route.get("images", []):
        p = img.get("path") if isinstance(img, dict) else img
        if _safe_img(p) and p not in imgs: imgs.append(p)
    for wp in route.get("waypoints", []):
        for p in wp.get("images", []):
            if _safe_img(p) and p not in imgs: imgs.append(p)

    img_html = ""
    if imgs:
        img_html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-top:15px;">'
        for p in imgs:
            img_html += f'<img src="/tourpack/{tp_id}/{html.escape(p)}" loading="lazy" data-lightbox alt="" style="width:100%;height:110px;object-fit:cover;border-radius:6px;border:1px solid var(--border);cursor:zoom-in;">'
        img_html += '</div>'

    viewer_url = f"/tourpack-viewer.html?open={tp_id}"

    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} | Andromeda-Explorer</title>
<meta name="description" content="{act_label} in {html.escape(loc_str)}: {dist}, {asc} ascent. {html.escape(desc_text[:100].replace(chr(10), ' '))}">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/favicon.png">
<link rel="canonical" href="{ORIGIN}/tourpack/{tp_id}/">
<link rel="stylesheet" href="/stylesheets/base.css">
<style>
  /* Überschreibt das overflow:hidden aus der base.css, damit gescrollt werden kann */
  html, body {{ height: auto !important; overflow-y: auto !important; display: block !important; }}
  body {{ background: var(--bg); color: var(--text); font-family: sans-serif; margin: 0; padding: 0; }}
  .container {{ max-width: 800px; margin: 20px auto; padding: 20px 30px; background: var(--panel); min-height: 80vh; box-shadow: var(--shadow-sm); border-radius: var(--radius); }}
  .header {{ display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 15px; margin-bottom: 25px; flex-wrap: wrap; gap: 10px; }}
  .brand {{ display: flex; align-items: center; gap: 10px; text-decoration: none; color: var(--text); font-weight: 700; font-size: 16px; }}
  .brand img {{ width: 32px; height: 32px; }}
  .header-actions {{ display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }}
  .link-home {{ color: var(--text-muted); text-decoration: none; font-size: 13.5px; font-weight: 600; padding: 8px 12px; border-radius: var(--radius-sm); transition: background .12s, color .12s; }}
  .link-home:hover {{ background: var(--primary-soft); color: var(--primary-dark); }}
  .stats {{ display: flex; flex-wrap: wrap; gap: 10px; font-size: 13.5px; color: var(--text-muted); margin-top: 15px; }}
  .stats span {{ background: var(--bg); padding: 5px 10px; border-radius: 4px; font-weight: 500; }}
  .btn {{ display: inline-flex; align-items: center; justify-content: center; background: var(--primary); color: white; text-decoration: none; padding: 10px 18px; border-radius: var(--radius-sm); font-weight: bold; font-size: 14px; transition: background .12s; }}
  .btn:hover {{ background: var(--primary-dark); }}
  @media (max-width: 600px) {{
    .container {{ margin: 0; border-radius: 0; padding: 15px; box-shadow: none; }}
    .header {{ flex-direction: column; align-items: flex-start; }}
    .header-actions {{ width: 100%; }}
    .header-actions .btn {{ width: 100%; }}
  }}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <a href="{ORIGIN}/" class="brand">
      <img src="/logo.svg" alt="Andromeda-Explorer Logo">
      Andromeda-Explorer
    </a>
    <div class="header-actions">
      <a href="/touren/" class="link-home">← Back to all tours</a>
      <a href="{ORIGIN}/" class="btn">Main Page</a>
      <a href="{viewer_url}" class="btn">🗺️ Open Map</a>
    </div>
  </div>

  <div style="border:none; padding:0; margin-bottom:15px;">
    <h1 style="margin: 0 0 10px 0; font-size: 26px; line-height: 1.3;">{title}</h1>
    <div style="font-weight: 700; color: var(--primary); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.05em; font-size: 13px;">{act_label}</div>
    <div class="stats">
      <span>📍 {html.escape(loc_str) if loc_str else 'Unknown'}</span>
      {f'<span>📏 {dist}</span>' if dist else ''}
      {f'<span>↑ {asc} ascent</span>' if asc else ''}
      {f'<span>↓ {desc_asc} descent</span>' if desc_asc else ''}
      {f'<span>⏱ {dur}</span>' if dur else ''}
    </div>

    {diff_html}
  </div>

  <div style="font-size: 15px; line-height: 1.6; margin-top: 25px;">
    {_md_to_html(desc_text)}
  </div>

  {img_html}
</div>

<div id="lightbox" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9999;align-items:center;justify-content:center;cursor:zoom-out;padding:20px;">
  <img id="lightboxImg" alt="" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;">
</div>
<script>
(function() {{
  var lb = document.getElementById('lightbox');
  var lbImg = document.getElementById('lightboxImg');
  document.querySelectorAll('[data-lightbox]').forEach(function(img) {{
    img.addEventListener('click', function() {{
      lbImg.src = img.src;
      lb.style.display = 'flex';
    }});
  }});
  lb.addEventListener('click', function() {{
    lb.style.display = 'none';
    lbImg.src = '';
  }});
  document.addEventListener('keydown', function(e) {{
    if (e.key === 'Escape' && lb.style.display === 'flex') {{
      lb.style.display = 'none';
      lbImg.src = '';
    }}
  }});
}})();
</script>
</body>
</html>"""

    atomic_write_bytes(Paths.api_pages / f"{tp_id}.html", html_content.encode("utf-8"))

def _generate_tour_list():
    """Erzeugt die statische Übersichtsseite /touren/index.html."""
    with _index_lock:
        entries = list(_index.values())

    entries.sort(key=lambda x: x.get("title", ""))

    items_html = ""
    for e in entries:
        tp_id = e.get("id")
        title = html.escape(e.get("title") or "Untitled Tour")
        loc = e.get("location", {}).get("start", {})
        loc_str = ", ".join(filter(None, [loc.get("place"), loc.get("region")]))
        items_html += f'<li style="margin-bottom:8px;"><a href="/tourpack/{tp_id}/" style="color:var(--primary);text-decoration:none;font-size:15px;">{title}</a> <span style="color:var(--text-muted);font-size:12px;">({html.escape(loc_str)})</span></li>'

    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>All Tours | Andromeda-Explorer</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/favicon.png">
<link rel="canonical" href="{ORIGIN}/touren/">
<link rel="stylesheet" href="/stylesheets/base.css">
<style>
  html, body {{ height: auto !important; overflow-y: auto !important; display: block !important; }}
  body {{ background: var(--bg); color: var(--text); font-family: sans-serif; margin: 0; padding: 20px; }}
  .container {{ max-width: 800px; margin: 0 auto; background: var(--panel); padding: 30px; border-radius: 10px; box-shadow: var(--shadow-sm); }}
  .brand {{ display: flex; align-items: center; gap: 10px; text-decoration: none; color: var(--text); font-weight: 700; font-size: 16px; margin-bottom: 20px; }}
  .brand img {{ width: 32px; height: 32px; }}
  ul {{ list-style: none; padding: 0; }}
</style>
</head>
<body>
<div class="container">
  <a href="{ORIGIN}/" class="brand">
    <img src="/logo.svg" alt="Andromeda-Explorer Logo">
    Andromeda-Explorer
  </a>
  <h1 style="font-size: 24px; margin-bottom: 10px;">All published tours</h1>
  <ul>{items_html}</ul>
</div>
</body>
</html>"""

    atomic_write_bytes(TOUR_LIST_PAGE, html_content.encode("utf-8"))
def _generate_sitemap():
    with _index_lock:
        entries = list(_index.values())
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    xml += f'  <url><loc>{ORIGIN}/touren/</loc></url>\n'
    for e in entries:
        xml += f'  <url><loc>{ORIGIN}/tourpack/{e.get("id")}/</loc></url>\n'
    xml += '</urlset>\n'
    return xml

# =============================================================================
# SCAN
# =============================================================================
def _scan_published():
    stats = {"added": 0, "updated": 0, "removed": 0, "skipped": 0}
    seen = set()
    try:
        dirs = sorted(Paths.published.iterdir())
    except FileNotFoundError:
        dirs = []
    for dir_path in dirs:
        if not dir_path.is_dir() or dir_path.name.startswith("."):
            continue
        tp_id = dir_path.name
        if not SAFE_ID_RE.match(tp_id):
            stats["skipped"] += 1
            continue
        version = _get_version(dir_path)
        with _index_lock:
            existing = _index.get(tp_id)
        if existing and existing.get("version") == version \
                and (Paths.api_pages / f"{tp_id}.html").is_file():
            seen.add(tp_id)
            continue
        result = _index_from_dir(tp_id, dir_path, version)
        if result is None:
            stats["skipped"] += 1
            continue
        entry, manifest, route = result
        try:
            _generate_tour_html(tp_id, dir_path, manifest, route)
        except Exception as e:  # noqa: BLE001
            log(f"  ! Tour-Seite für {tp_id} fehlgeschlagen: {e}")
        _write_index_entry(entry)
        with _index_lock:
            _index[tp_id] = entry
        seen.add(tp_id)
        stats["updated" if existing else "added"] += 1

    with _index_lock:
        gone = [t for t in _index if t not in seen]
    for tp_id in gone:
        _delete_index_entry(tp_id)
        with _index_lock:
            _index.pop(tp_id, None)
        stats["removed"] += 1
    return stats


def scan_once():
    with _scan_lock:
        t0 = time.monotonic()
        s = _scan_published()
        if s["added"] or s["updated"] or s["removed"] or not TOUR_LIST_PAGE.is_file():
            try:
                _generate_tour_list()
            except Exception as e:  # noqa: BLE001
                log(f"  ! Tourenliste fehlgeschlagen: {e}")
        with _index_lock:
            total = len(_index)
    if s["added"] or s["updated"] or s["removed"] or s["skipped"]:
        log(f"Scan: +{s['added']} ~{s['updated']} -{s['removed']} "
            f"!{s['skipped']} ({(time.monotonic() - t0) * 1000:.0f} ms, {total} Touren)")
    return s


def _watch_changes():
    """Vollscan beim Start und alle SCAN_INTERVAL_S; zusätzlich sofort,
    wenn tours-admin published/.changed berührt hat."""
    last_seen, last_full = None, 0.0
    while True:
        try:
            mtime = Paths.changed_file.stat().st_mtime
        except OSError:
            mtime = None
        now = time.monotonic()
        if mtime != last_seen or now - last_full >= SCAN_INTERVAL_S:
            last_seen, last_full = mtime, now
            try:
                scan_once()
            except Exception as e:  # noqa: BLE001
                log(f"! Scan-Fehler: {e}")
        time.sleep(CHANGE_POLL_S)


# =============================================================================
# SUCHE
# =============================================================================
def _matches_query(entry, q_norm):
    if q_norm in _normalize_for_search(entry.get("title", "")):
        return True
    # Tags werden nicht mehr durchsucht (bewusst deaktiviert). Die
    # Tag-Daten bleiben im Index und in der API-Response, damit sie
    # später bei Bedarf wieder aktiviert werden können.
    # for tag in entry.get("tags") or []:
    #     if q_norm in _normalize_for_search(tag):
    #         return True
    loc = entry.get("location") or {}
    keys = ("region", "county", "municipality", "place")
    if isinstance(loc, dict):
        if "start" in loc or "center" in loc or "end" in loc:
            for part_key in ("start", "center", "end"):
                part = loc.get(part_key) or {}
                for k in keys:
                    if q_norm in _normalize_for_search(part.get(k, "")):
                        return True
        else:
            for k in keys:
                if q_norm in _normalize_for_search(loc.get(k, "")):
                    return True
    return False


def _matches_region(entry, region_norm):
    loc = entry.get("location") or {}
    keys = ("region", "county", "municipality", "place")
    if isinstance(loc, dict):
        if "start" in loc or "center" in loc or "end" in loc:
            for part_key in ("start", "center", "end"):
                part = loc.get(part_key) or {}
                for k in keys:
                    if region_norm in _normalize_for_search(part.get(k, "")):
                        return True
        else:
            for k in keys:
                if region_norm in _normalize_for_search(loc.get(k, "")):
                    return True
    return False


def _entry_to_response(e):
    version = e.get("version", 0)
    thumb = f"/thumbnail/{e['id']}?v={version}" if e.get("thumbnail_ext") else None
    return {
        "id":       e.get("id"),
        "title":    e.get("title"),
        "activity": e.get("activity"),
        "version":  version,
        "tags":     e.get("tags") or [],
        "location": e.get("location") or {},
        "stats":    e.get("stats") or {},
        "difficulty": e.get("difficulty") or {},
        "center_coord": e.get("center_coord"),
        "thumbnail_url": thumb,
        "waypoint_count": e.get("waypoint_count", 0),
        "image_count":    e.get("image_count", 0),
        "is_roundtrip":   bool(e.get("is_roundtrip")),
        "roadbike":       bool(e.get("roadbike", False)),
    }


def _has_meaningful_filter(params):
    if (params.get("q", [""])[0] or "").strip():
        return True
    if (params.get("near", [""])[0] or "").strip():
        return True
    if (params.get("region", [""])[0] or "").strip():
        return True
    for key in ("min_km", "max_km"):
        raw = (params.get(key, [""])[0] or "").strip()
        if raw:
            try:
                float(raw)
                return True
            except ValueError:
                pass
    raw = (params.get("diff_min", [""])[0] or "").strip()
    if raw:
        try:
            if int(raw) > 0:
                return True
        except ValueError:
            pass
    raw = (params.get("diff_max", [""])[0] or "").strip()
    if raw:
        try:
            if int(raw) < 5:
                return True
        except ValueError:
            pass
    raw = (params.get("roundtrip", [""])[0] or "").strip().lower()
    if raw in ("1", "true", "yes"):
        return True
    raw = (params.get("roadbike", [""])[0] or "").strip().lower()
    if raw in ("1", "true", "yes"):
        return True
    return False


def _parse_float(params, key, default, lo, hi):
    raw_list = params.get(key)
    if not raw_list:
        return default
    raw = (raw_list[0] or "").strip()
    if not raw:
        return default
    try:
        v = float(raw)
    except ValueError:
        return default
    if v != v or v in (float("inf"), float("-inf")):
        return default
    return max(lo, min(hi, v))


def _parse_int(params, key, default, lo, hi):
    raw_list = params.get(key)
    if not raw_list:
        return default
    raw = (raw_list[0] or "").strip()
    if not raw:
        return default
    try:
        v = int(raw)
    except ValueError:
        return default
    return max(lo, min(hi, v))


def do_search(params):
    q_raw = (params.get("q", [""])[0] or "").strip()[:200]
    q_norm = _normalize_for_search(q_raw)

    activity = (params.get("activity", [""])[0] or "").strip().lower()
    if activity and activity not in ACTIVITIES:
        activity = ""

    near = _parse_near(params)

    min_km = _parse_float(params, "min_km", None, 0.0, MAX_TOUR_LENGTH_KM)
    max_km = _parse_float(params, "max_km", None, 0.0, MAX_TOUR_LENGTH_KM)
    if min_km is not None and max_km is not None and min_km > max_km:
        min_km, max_km = max_km, min_km
    diff_min = _parse_int(params, "diff_min", 0, 0, 5)
    diff_max = _parse_int(params, "diff_max", 5, 0, 5)
    if diff_min > diff_max:
        diff_min, diff_max = diff_max, diff_min

    region_raw = (params.get("region", [""])[0] or "").strip()[:100]
    region_norm = _normalize_for_search(region_raw)

    roundtrip_raw = (params.get("roundtrip", [""])[0] or "").strip().lower()
    roundtrip_only = roundtrip_raw in ("1", "true", "yes")

    roadbike_raw = (params.get("roadbike", [""])[0] or "").strip().lower()
    roadbike_only = roadbike_raw in ("1", "true", "yes")

    try:
        limit = int(params.get("limit", [str(SEARCH_DEFAULT_LIMIT)])[0])
    except (ValueError, IndexError):
        limit = SEARCH_DEFAULT_LIMIT
    try:
        offset = int(params.get("offset", ["0"])[0])
    except (ValueError, IndexError):
        offset = 0
    limit = max(1, min(SEARCH_MAX_LIMIT, limit))
    offset = max(0, offset)

    with _index_lock:
        entries = list(_index.values())

    def passes_meta(e):
        if roundtrip_only and not e.get("is_roundtrip"):
            return False
        dist_m = (e.get("stats") or {}).get("distance_m")
        if min_km is not None:
            if dist_m is None or dist_m < min_km * 1000.0:
                return False
        if max_km is not None:
            if dist_m is None or dist_m > max_km * 1000.0:
                return False
        if diff_min > 0 or diff_max < 5:
            diff_val = (e.get("difficulty") or {}).get("overall", 0)
            if diff_val == 0:
                return False
            if diff_val < diff_min or diff_val > diff_max:
                return False
        return True

    matched = []
    for e in entries:
        if activity and e.get("activity") != activity:
            continue
        if roadbike_only and not e.get("roadbike"):
            continue
        if q_norm and not _matches_query(e, q_norm):
            continue
        if region_norm and not _matches_region(e, region_norm):
            continue
        if not passes_meta(e):
            continue

        sort_distance = None
        if near is not None:
            c = e.get("center_coord")
            if not c:
                continue
            lon2, lat2 = c
            lat_n, lon_n, radius_m = near
            distance_m = _haversine_m(lat_n, lon_n, lat2, lon2)
            if distance_m > radius_m:
                continue
            # Filter läuft über den Mittelpunkt (bestehendes Verhalten),
            # Sortierung aber über den Startpunkt der Tour. Touren ohne
            # start_coord fallen auf center_coord zurück.
            sc = e.get("start_coord")
            if sc and isinstance(sc, (list, tuple)) and len(sc) >= 2:
                try:
                    lon_s, lat_s = float(sc[0]), float(sc[1])
                    sort_distance = _haversine_m(lat_n, lon_n, lat_s, lon_s)
                except (TypeError, ValueError):
                    sort_distance = distance_m
            else:
                sort_distance = distance_m

        matched.append((e, sort_distance))

    if near is not None:
        matched.sort(key=lambda pair: (pair[1] is None, pair[1]))
    else:
        def sort_key(pair):
            e = pair[0]
            title_hit = 1 if q_norm and q_norm in _normalize_for_search(e.get("title", "")) else 0
            return (-title_hit, -e.get("indexed_at", 0))
        matched.sort(key=sort_key)

    entries_sorted = [e for e, _ in matched]

    truncated = len(entries_sorted) > SEARCH_HARD_LIMIT
    if truncated:
        entries_sorted = entries_sorted[:SEARCH_HARD_LIMIT]

    total = len(entries_sorted)
    page = entries_sorted[offset:offset + limit]
    return total, limit, offset, [_entry_to_response(e) for e in page], truncated

# =============================================================================
# HTTP
# =============================================================================
class Handler(BaseHandler):
    timeout = 15
    log = staticmethod(log)
    cors_methods = "GET, HEAD, OPTIONS"

    def do_HEAD(self):
        self._head_only = True
        try:
            self.do_GET()
        finally:
            self._head_only = False

    def do_POST(self):
        self.send_text(405, "Methode nicht erlaubt.")

    def do_GET(self):
        if len(self.path) > MAX_URL_LEN:
            return self.send_text(414, "URL zu lang.")
        parsed = urlparse(self.path)
        path = parsed.path
        is_file = path.startswith("/tourpack/") or path.startswith("/thumbnail/")
        ok, wait = (FILE_LIMITER if is_file else SEARCH_LIMITER).check(self.client_ip())
        if not ok:
            return self.send_too_many(wait)

        if path == "/search":
            return self.handle_search(parsed)
        if path == "/internal/ids":
            # nur für tours-admin (direkt, nicht über Caddy)
            if not self.is_direct_local():
                return self.send_text(404, "Nicht gefunden.")
            with _index_lock:
                ids = sorted(_index)
            return self.send_json(200, ids)
        if path == "/sitemap.xml":
            return self.send_bytes(200, _generate_sitemap().encode("utf-8"),
                                   "application/xml; charset=utf-8")
        if path in ("/touren", "/touren/", "/touren/index.html"):
            if path == "/touren":
                return self.send_bytes(301, b"", "text/plain", {"Location": "/touren/"})
            return self.send_file(TOUR_LIST_PAGE, "text/html; charset=utf-8", 300)
        if path.startswith("/thumbnail/"):
            return self.handle_thumbnail(path[len("/thumbnail/"):].strip("/"))
        if path.startswith("/tourpack/"):
            rest = path[len("/tourpack/"):]
            tp_id, _, sub = rest.partition("/")
            if not _:
                return self.send_text(404, "Nicht gefunden.")
            return self.handle_tour_file(tp_id, sub.strip("/"))
        self.send_text(404, "Nicht gefunden.")

    def send_file(self, path, content_type, max_age):
        """Datei mit Last-Modified/If-Modified-Since (304) ausliefern."""
        try:
            st = path.stat()
        except OSError:
            return self.send_text(404, "Nicht gefunden.")
        last_mod = formatdate(int(st.st_mtime), usegmt=True)
        ims = self.headers.get("If-Modified-Since")
        if ims:
            try:
                if int(parsedate_to_datetime(ims).timestamp()) >= int(st.st_mtime):
                    self.send_response(304)
                    self.send_header("Last-Modified", last_mod)
                    self.send_header("Cache-Control", f"public, max-age={max_age}")
                    self.send_cors()
                    self.end_headers()
                    return
            except (TypeError, ValueError, OverflowError):
                pass
        try:
            data = path.read_bytes()
        except OSError:
            return self.send_text(500, "Lesefehler.")
        self.send_bytes(200, data, content_type, {
            "Last-Modified": last_mod, "Cache-Control": f"public, max-age={max_age}"})

    def handle_search(self, parsed):
        qs_raw = parse_qs(parsed.query, keep_blank_values=True)
        qs = {k: v for k, v in qs_raw.items() if k in ALLOWED_SEARCH_PARAMS}
        if not _has_meaningful_filter(qs):
            return self.send_json(200, {"total": 0, "limit": 0, "offset": 0,
                                        "truncated": False, "requires_filter": True,
                                        "results": []})
        try:
            total, limit, offset, results, truncated = do_search(qs)
        except Exception as e:  # noqa: BLE001
            self.rlog(f"! Suchfehler: {e}")
            return self.send_json(500, {"error": "Interner Fehler."})
        self.send_json(200, {"total": total, "limit": limit, "offset": offset,
                             "truncated": truncated, "requires_filter": False,
                             "results": results})

    def handle_thumbnail(self, tp_id):
        if not SAFE_ID_RE.match(tp_id):
            return self.send_text(400, "Ungültige ID.")
        self.send_file(_thumbnail_target_path(tp_id), "image/jpeg", 86400)

    def handle_tour_file(self, tp_id, sub):
        if not SAFE_ID_RE.match(tp_id):
            return self.send_text(400, "Ungültige ID.")
        with _index_lock:
            known = tp_id in _index
        if not known:
            return self.send_text(404, "Unbekannte Tour.")
        if sub in ("", "index.html"):
            return self.send_file(Paths.api_pages / f"{tp_id}.html",
                                  "text/html; charset=utf-8", 300)
        if sub in CONTENT_TYPES:
            ctype = CONTENT_TYPES[sub]
        elif IMAGE_PATH_RE.match(sub):
            ctype = IMAGE_CONTENT_TYPES[sub[sub.rfind("."):].lower()]
        else:
            return self.send_text(404, "Nicht gefunden.")
        # Name ist durch die Whitelist auf Wurzeldateien bzw.
        # media/images/<sicherer Name> beschränkt.
        self.send_file(Paths.published / tp_id / sub, ctype, 86400)


def main():
    parser = argparse.ArgumentParser(description="Öffentliche Tour-Schnittstelle")
    parser.add_argument("--force-rescan", action="store_true",
                        help="Index, Vorschaubilder und Seiten neu erzeugen")
    args = parser.parse_args()

    for d in (Paths.api_index, Paths.api_thumbnails, Paths.api_pages):
        d.mkdir(parents=True, exist_ok=True)
    if args.force_rescan:
        log("--force-rescan: lösche Index, Vorschaubilder und Seiten")
        for d in (Paths.api_index, Paths.api_thumbnails, Paths.api_pages):
            for p in d.iterdir():
                if p.is_file():
                    p.unlink()
    with _index_lock:
        _index.update(_load_index_from_disk())
    threading.Thread(target=_watch_changes, daemon=True, name="scanner").start()
    serve(Handler, PORT_TOURS_API, log=log, banner_lines=[
        f"Touren:   {Paths.published} (nur lesend)",
        f"Eigenes:  {Paths.api}",
        f"Index:    {len(_index)} Touren beim Start",
    ])


if __name__ == "__main__":
    main()
