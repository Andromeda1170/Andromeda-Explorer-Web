# Andromeda-Explorer

**Find, plan and navigate hiking, cycling and running tours — in the browser, without an account.**

Live at **[andromeda-explorer.com](https://andromeda-explorer.com)**

Andromeda-Explorer is a small, self-hosted outdoor platform built on
[OpenStreetMap](https://www.openstreetmap.org) and [BRouter](https://brouter.de).
It combines four things that usually live in separate apps:

1. **A tour library.** Published tours can be searched by title, region, place,
   tags, length, difficulty, round trip or road-bike suitability, viewed with
   description, waypoints, photos and elevation profile, and downloaded.
2. **A route planner.** Plan routes for hiking, trekking/road bike and running
   with BRouter, tweak trail difficulty (SAC scale) and preferences, re-plan a
   recorded GPS track onto the real path network, and export a GPX file that
   contains real turn instructions (OsmAnd format).
3. **A navigator.** A web app that follows your GPS position along a route,
   gives turn notices (junctions, forks, roundabouts), warns when you leave the
   route or walk the wrong way, can route you back to the track, and keeps
   working offline with the map tiles you have already viewed.
4. **TourPacks.** An open, single-file tour format (`.tourpack`) that bundles
   the route, description, waypoints and photos. Tours can be created in the
   browser-based editor, shared as a file, opened offline, and submitted for
   publication.

Everything runs on one small Linux server: a static website, a handful of
Python services using only the standard library (plus Pillow for images), and
a local BRouter instance. There is no database, no build step, no tracking and
no user accounts.

The user interface is available in German and English; tours stay in the
language they were written in.

---

## Contents

- [Features](#features)
- [The TourPack format](#the-tourpack-format)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Services](#services)
- [How an uploaded tour gets published](#how-an-uploaded-tour-gets-published)
- [Security model](#security-model)
- [Being a good OSM citizen](#being-a-good-osm-citizen)
- [Running it yourself](#running-it-yourself)
- [Local development](#local-development)
- [Configuration](#configuration)
- [License and credits](#license-and-credits)

---

## Features

### Home page — tour search (`index.html`)
- Full-text search over title, region, place and tags; detailed filters for
  length, difficulty, region, round trips and road-bike tours.
- "Search nearby" around the map centre or your location.
- Results as cards and as markers on the map. Tapping a marker shows the route
  and a short summary. Tours that lie on top of each other are grouped into a
  stack with a counter; tapping it fans the tours out around the spot.
- Save tours locally (📌) — stored in the browser, no account needed.
- Static, crawlable pages for every tour (`/tourpack/<id>/`), a tour list
  (`/touren/`) and a sitemap for search engines.

### Tour viewer (`tourpack-viewer.html`)
- Route on the map with distance, ascent/descent, duration, difficulty ratings,
  region, Markdown description, waypoints with notes and photos.
- Full-screen image viewer with pinch-zoom and swipe.
- Way-type and surface statistics (e.g. mountain trail vs. asphalt) that
  highlight the matching sections on the map.
- Elevation profile coloured by gradient.
- Directions to the start (Google Maps / OSM), open in the navigator, GPX and
  TourPack download, print / PDF.
- Works offline for `.tourpack` files after the first visit.

### Route planner (`routing.html`)
- Activities: hiking, trekking bike, road bike, running — each backed by a
  tuned BRouter profile (`services/profiles/*.brf`).
- Click to add start/via points, drag to move, tap the route to insert a point,
  mark segments as "off-grid" (straight line, e.g. cross-country).
- Parameters: personal fitness (time estimate), maximum and preferred SAC
  scale, further preferences.
- **GPX re-planning:** import a recorded track and snap it to the path network.
  Waypoints are placed along the track and refined iteratively wherever the
  calculated route still deviates from the recording.
- Result: distance, elevation gain, duration, elevation profile; share as a
  read-only link, open in the navigator, export as GPX with turn instructions
  (`<rte>` in OsmAnd format, so they also work in OsmAnd and similar apps).

### Navigator (`navigation.html`)
- Follows your position, optional "rotate map to heading".
- Turn notices with distance countdown — from BRouter's real turn
  instructions when available (including forks and roundabout exits),
  otherwise derived from the route geometry (with a notice that this is less
  accurate).
- Off-route warning (> 30 m), wrong-direction warning, U-turn notices.
- "Navigate to the route / to the start" with its own BRouter calculation.
- Long-press markers, place search, "things nearby" via Overpass (water,
  huts, supermarkets, car parks …), place details from OpenStreetMap.
- Offline: installable PWA; viewed map tiles are cached on the device, missing
  tiles fall back to an enlarged coarser tile.

### TourPack editor (`tourpack-editor.html`) and upload (`upload.html`)
- Create or edit `.tourpack` files: import GPX, basic data, automatic region
  detection, difficulty ratings and tags, Markdown description, waypoints with
  photos, general photos with captions and cover image.
- A built-in tutorial encourages re-planning recorded tracks in the route
  planner first, so published tours follow the real path network.
- Upload a TourPack for publication; it is reviewed before it goes live.

### Under the hood
- **AndroMap** (`www/scripts/andromap.js`): an own small map engine with a
  Leaflet-compatible API, map rotation, a compass control and offline tile
  fallback — no third-party JavaScript.
- Plain HTML/CSS/JS, no framework and no build step.
- i18n with German source strings and English phrase tables
  (`www/scripts/i18n.js`, `www/scripts/lang/`).
- Dark mode.

---

## The TourPack format

A `.tourpack` is a ZIP file with a fixed structure:

```
mimetype            application/vnd.andromedaexplorer+zip (first entry, stored)
manifest.json       id, title, creation date, format ("andromedaexplorer"), version
route.json          all structured tour data: activity, stats, difficulty,
                    location, tags, waypoints, images, turn instructions, …
geometry.geojson    the route as GeoJSON (LineString / MultiLineString, with elevation)
description.md      Markdown description
media/images/…      photos (JPEG, PNG, WebP, GIF)
```

Only these entries are allowed; anything else is rejected on upload. The format
is designed to be extended: missing fields are filled in when a file is opened,
so older files stay valid.

---

## Architecture

```
                      ┌──────────────────────────── one Linux server ───────────────────────────┐
                      │                                                                         │
 Browser ── HTTPS ──▶ │ Caddy :443 ─┬─ /                       static website  /opt/andromeda/www│
                      │             │                                                           │
                      │             ├─ /brouter  /profile/*  ─▶ geo-gateway :8080 ─▶ BRouter :17777
                      │             │  /nominatim/* /overpass │       (fair queue)   (Java, local) │
                      │             │                         └─▶ Nominatim / Overpass (cached)   │
                      │             │                                                           │
                      │             ├─ /search /thumbnail/*  ─▶ tours-api :8081                   │
                      │             │  /tourpack/* /touren/        reads tours/published         │
                      │             │  /sitemap.xml                                              │
                      │             │                                                           │
                      │             ├─ /upload               ─▶ tours-upload :8083 ─▶ tours/inbox │
                      │             │                              tours-sanitizer (no network)  │
                      │             │                                inbox ─▶ tours/staging      │
                      │             └─ /admin*               ─▶ tours-admin :8082                 │
                      │                                            staging ─▶ tours/published    │
                      │                                                                         │
                      │  brouter-updater :8084 (local only) keeps BRouter's map data current     │
                      └─────────────────────────────────────────────────────────────────────────┘
```

- Map tiles are loaded by the browser directly from the tile providers
  (OpenStreetMap, OpenTopoMap, CyclOSM …); the server never proxies tiles.
- All services listen on `127.0.0.1` only. Caddy is the only thing reachable
  from the internet and handles TLS automatically.
- Services talk to each other through the file system, not over the network:
  `tours-admin` touches `tours/published/.changed`, and `tours-api` notices the
  new timestamp within a few seconds and re-indexes.

---

## Repository layout

```
www/                      the static website (served as-is by Caddy)
  index.html              tour search
  routing.html            route planner
  navigation.html         navigator (PWA, service worker: tourpack-nav-sw.js)
  tourpack-viewer.html    tour viewer
  tourpack-editor.html    TourPack editor
  upload.html             publication form
  impressum.example.html  imprint template (the real impressum.html is not in the repo)
  hilfe.html              help (German/English)
  scripts/                AndroMap, i18n, GPX, turn instructions, navigator modules …
  stylesheets/

services/                 server-side Python services (stdlib + Pillow)
  andromeda_lib.py        shared building blocks: paths, HTTP helpers,
                          rate limiters, TourPack validation
  geo-gateway.py          BRouter proxy with fair queue, custom profiles,
                          Nominatim/Overpass proxy with cache
  brouter-updater.py      weekly update of BRouter segment files
  tours-api.py            search index, tour files, thumbnails, static pages, sitemap
  tours-upload.py         public upload endpoint
  tours-sanitizer.py      rewrites uploaded TourPacks (no network access)
  tours-admin.py          admin interface backend (password + TOTP)
  admin.html              admin interface
  profiles/               BRouter profile templates (wandern, trekking, rennrad, laufen)

deploy/
  setup.sh                creates users, directories, permissions, installs units (idempotent)
  admin-init.sh           sets up the admin password and TOTP
  Caddyfile               reverse-proxy configuration
  andromeda.env.example   optional settings (domain, contact, BRouter threads)
  systemd/                one hardened unit per service + BRouter + restart path unit

docs/
  SERVER-SETUP.md         step-by-step guide for a new server
```

---

## Services

| Service | Port | Purpose |
|---|---|---|
| **geo-gateway** | 8080 | Forwards route requests to the local BRouter through a fair queue: never more concurrent requests than BRouter has threads, one slot reserved for short routes, long routes queued by cost with aging. Requests the browser has abandoned (e.g. after changing settings) are dropped. `POST /profile/prepare` creates a temporary copy of a profile template with validated parameter changes. Proxies Nominatim (`/search`, `/reverse` only) and Overpass with per-IP limits, global pacing (max. 1 request/s to Nominatim), daily quotas and an SQLite cache (Nominatim 30 days, Overpass 7 days); cache hits use no quota. |
| **brouter-updater** | 8084 | Checks all installed `.rd5` segment files weekly with `If-Modified-Since`, downloads only changed ones, waits until BRouter is idle, swaps files atomically (old version kept as a hard link) and asks systemd to restart BRouter. New tiles can be registered via CLI. Local only. |
| **tours-api** | 8081 | Indexes the published tours, answers searches, serves tour files and images, generates thumbnails, static tour pages, the tour list and the sitemap. Supports `Last-Modified`/`304`. Read-only access to published tours. |
| **tours-upload** | 8083 | Public upload. Checks only the structure (ZIP, whitelist, sizes, mimetype, manifest, route) — never opens an image. 3 uploads per hour per IP, 30 MB per file, 1 GB inbox. |
| **tours-sanitizer** | – | Runs without network access. Rewrites every file of an upload: JSON is parsed, validated and re-serialised; Markdown must be UTF-8; every image is decoded, rotated according to EXIF, scaled to max. 1920 px and re-encoded without metadata (EXIF, GPS, XMP, comments). The tour gets a new ID so an upload can never replace an existing tour. |
| **tours-admin** | 8082 | Admin UI backend: list, download, delete, promote tours; publish your own TourPack directly; review uploads (prepare → view → publish or reject). Cleans up orphaned files. |
| **BRouter** | 17777 | The routing engine (Java), bound to `127.0.0.1`, read-only access to its data. |

---

## How an uploaded tour gets published

1. **tours-upload** validates the structure and stores the file in
   `tours/inbox/` together with a job file in `tours/jobs/`.
2. In the admin interface, **Prepare** marks the job; **tours-sanitizer**
   picks it up, rewrites everything into `tours/staging/<job>/` and deletes the
   original upload.
3. The admin opens the result in the viewer and chooses **Publish** or
   **Reject**.
4. **tours-admin** *copies* the tour into `tours/published/<id>/` with clean,
   read-only permissions and signals the change.
5. **tours-api** re-indexes; the tour appears in the search, gets a static page
   and is listed in the sitemap.

---

## Security model

The design assumes the code is public and attackers know it.

- **One system user per service.** Each service can write only its own
  directories — enforced twice, by file ownership/permissions and by systemd
  `ReadWritePaths` with `ProtectSystem=strict`.

  | Service | User | May write | Network |
  |---|---|---|---|
  | geo-gateway | andromeda-geo | `geo-cache/`, `brouter/profiles2/` | internet (OSM services) |
  | brouter-updater | brouter | `brouter/` | internet (brouter.de) |
  | BRouter | brouter | – | localhost only |
  | tours-api | andromeda-tours | `tours-api/` | localhost only |
  | tours-upload | andromeda-upload | `tours/inbox/`, `tours/jobs/` | localhost only |
  | tours-sanitizer | andromeda-sanitizer | `tours/inbox/`, `jobs/`, `staging/` | none (`PrivateNetwork`) |
  | tours-admin | andromeda-admin | `tours/*` | localhost only |

- **systemd hardening** on every unit: `NoNewPrivileges`, empty capability
  set, `PrivateTmp`, `PrivateDevices`, `ProtectHome`, kernel/cgroup/clock
  protection, `RestrictNamespaces`, `SystemCallFilter=@system-service`,
  `MemoryDenyWriteExecute` (except Java), IP allow-lists. `systemd-analyze
  security` rates the units between 0.7 and 1.4 ("SAFE"/"OK").
- **Untrusted images are only decoded** by the sanitizer, which has no network,
  cannot see published tours and runs with memory/CPU limits. Decompression
  bombs are rejected.
- **No secrets in the repository.** The admin password hash and TOTP secret
  live in `/etc/andromeda/admin.json` (`root:andromeda-admin`, mode 0640); all
  data lives under `/var/lib/andromeda`. `.gitignore` excludes these file
  types as a second line of defence.
- **Admin login:** PBKDF2-SHA256 (300,000 iterations) + TOTP (RFC 6238), each
  code usable only once; rate limits on login and code entry; `HttpOnly`,
  `Secure`, `SameSite=Strict` session cookie; CSRF protection via a required
  header plus origin check.
- **Input validation everywhere:** strict whitelists for TourPack entries,
  IDs, file names, BRouter parameters and profile values (no way to inject
  lines into a BRouter profile), path traversal is impossible by construction.
- **Rate limits** per client IP (taken from the last `X-Forwarded-For` entry,
  which Caddy sets — earlier entries can be forged by clients).

---

## Being a good OSM citizen

Andromeda-Explorer relies on free community services. The geo-gateway follows
their usage policies:

- [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/):
  at most one request per second in total, identifying `User-Agent` with a
  contact address, responses cached for 30 days, only `/search` and `/reverse`.
- [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API): pacing,
  per-IP and global daily limits, 7-day cache.
- Map tiles come straight from the providers to the browser; follow the
  [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
  if you run your own instance with heavy traffic.
- BRouter segment files are updated at most weekly, one file at a time, and
  only when they changed.

If you deploy your own copy, set your own contact address
(`ANDROMEDA_CONTACT`, see [Configuration](#configuration)).

---

## Running it yourself

See **[docs/SERVER-SETUP.md](docs/SERVER-SETUP.md)** for a complete,
step-by-step guide (Ubuntu 24.04, from a fresh server to a running site).

Short version:

```bash
sudo git clone https://github.com/<you>/andromeda-explorer.git /opt/andromeda/app
sudo /opt/andromeda/app/deploy/setup.sh
# install brouter.jar + profiles2 (see guide), then:
sudo /opt/andromeda/app/deploy/setup.sh
sudo /opt/andromeda/app/deploy/admin-init.sh
sudo cp /opt/andromeda/app/deploy/Caddyfile /etc/caddy/Caddyfile   # adjust domain
sudo rsync -a /opt/andromeda/app/www/ /opt/andromeda/www/
sudo systemctl enable --now brouter brouter-restart.path geo-gateway \
     brouter-updater tours-api tours-upload tours-sanitizer tours-admin
python3 /opt/andromeda/app/services/brouter-updater.py register E15_N45
```

**Requirements:** Ubuntu 24.04 (or another systemd distribution with
Python ≥ 3.10, Pillow and OpenJDK 17 or newer), about 4 GB RAM for BRouter with three
threads (1–1.5 GB with one thread), a few GB of disk for map segments, a
domain name.

---

## Local development

The website detects `localhost` / `file://` and then talks to the services
directly (`8080` geo-gateway, `8081` tours-api):

```bash
# website
cd www && python3 -m http.server 8000

# services (separate terminals), data goes to a temporary directory
export ANDROMEDA_DATA=/tmp/andromeda-data ANDROMEDA_ORIGIN=http://localhost:8000
python3 services/tours-api.py
python3 services/geo-gateway.py      # needs a BRouter on 127.0.0.1:17777 for routing
```

Python services need no installation besides Pillow
(`apt install python3-pil` or `pip install pillow`). After changes to the
navigator or viewer, bump `CACHE_NAME` in `www/tourpack-nav-sw.js` so
installed clients pick up the new files.

---

## Configuration

Optional settings live in `/etc/andromeda/andromeda.env`
(template: [`deploy/andromeda.env.example`](deploy/andromeda.env.example)):

| Variable | Default | Meaning |
|---|---|---|
| `ANDROMEDA_ORIGIN` | `https://andromeda-explorer.com` | public URL (CORS, links in generated pages, sitemap) |
| `ANDROMEDA_CONTACT` | maintainer's address | contact in the `User-Agent` for Nominatim/Overpass — **change this for your own instance** |
| `ANDROMEDA_DATA` | `/var/lib/andromeda` | data directory |
| `ANDROMEDA_CONFIG_DIR` | `/etc/andromeda` | directory of `admin.json` |
| `ANDROMEDA_TRUST_PROXY` | `1` | take the client IP from `X-Forwarded-For` (behind Caddy) |
| `ANDROMEDA_BROUTER_THREADS` | `3` | concurrent BRouter calculations; must match `brouter.service` |

---

## License and credits

Andromeda-Explorer is free software under the
**GNU General Public License v3.0** — see [LICENSE](LICENSE).

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL)
- Routing: [BRouter](https://github.com/abrensch/brouter) by Arndt Brenschede and contributors (MIT)
- Geocoding: [Nominatim](https://nominatim.org), POI search: [Overpass API](https://overpass-api.de)
- Map styles: OpenStreetMap, [OpenTopoMap](https://opentopomap.org), [CyclOSM](https://www.cyclosm.org); route overlays: [Waymarked Trails](https://waymarkedtrails.org) — each under their own terms
