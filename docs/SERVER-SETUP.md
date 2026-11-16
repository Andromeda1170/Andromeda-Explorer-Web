# Server setup

This guide takes a fresh Ubuntu 24.04 server to a running Andromeda-Explorer
instance: hardened base system, Caddy with automatic HTTPS, BRouter with map
data, all services, the admin login and the website.

Commands are meant to be run one block at a time. Lines starting with `#` are
comments. Replace `example.com` with your domain and `<you>` with your GitHub
user name.

---

## Contents

1. [What you need](#1-what-you-need)
2. [Base system](#2-base-system)
3. [Get the code](#3-get-the-code)
4. [Users, directories and services](#4-users-directories-and-services)
5. [BRouter](#5-brouter)
6. [Configuration](#6-configuration)
7. [Admin login](#7-admin-login)
8. [Website](#8-website)
9. [Caddy](#9-caddy)
10. [Start everything](#10-start-everything)
11. [Map data for BRouter](#11-map-data-for-brouter)
12. [Check that it works](#12-check-that-it-works)
13. [Day-to-day operations](#13-day-to-day-operations)
14. [Backups](#14-backups)
15. [Troubleshooting](#15-troubleshooting)
16. [Reference: files, users and permissions](#16-reference-files-users-and-permissions)

---

## 1. What you need

- A server (VPS) with **Ubuntu 24.04 LTS**.
  - **RAM:** BRouter needs about 700 MB–1 GB per routing thread. The default
    configuration uses three threads and a 3.5 GB Java heap, so plan for
    **6 GB RAM** in total. With one thread, 2 GB RAM are enough (see
    [5.4](#54-memory-and-threads)).
  - **Disk:** the BRouter segment files are 5°×5° tiles of 50–400 MB each. A
    region like Austria plus surroundings (3–4 tiles) needs about 1–1.5 GB;
    keep the same amount free for updates. Everything else is small.
  - **CPU:** 2 cores or more.
- A **domain name** with DNS `A` (and optionally `AAAA`) records pointing to
  the server. Caddy needs this to obtain a TLS certificate.
- SSH access with a **key**.

---

## 2. Base system

### 2.1 Updates and an admin user

Log in as the user your provider created (often `ubuntu` or `root`):

```bash
sudo apt update && sudo apt full-upgrade -y

# Optional: your own admin user (skip if you already have one with sudo)
sudo adduser alice
sudo usermod -aG sudo alice
sudo mkdir -p /home/alice/.ssh
sudo cp ~/.ssh/authorized_keys /home/alice/.ssh/
sudo chown -R alice:alice /home/alice/.ssh && sudo chmod 700 /home/alice/.ssh
```

Open a **second** terminal and check that `ssh alice@example.com` works before
continuing.

### 2.2 SSH: keys only

```bash
# A file starting with 00- is read first. In sshd the FIRST value wins,
# so this overrides cloud-init's 50-cloud-init.conf, which often enables passwords.
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' \
  | sudo tee /etc/ssh/sshd_config.d/00-hardening.conf

# Stop cloud-init from turning password login back on
echo 'ssh_pwauth: false' | sudo tee /etc/cloud/cloud.cfg.d/99-no-ssh-password.cfg

sudo sshd -t && echo "config ok"
sudo sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin)'
sudo systemctl restart ssh
```

Expected output: `passwordauthentication no`, `kbdinteractiveauthentication no`,
`permitrootlogin no`. Keep your current session open and test from your own
computer:

```bash
# must fail immediately with "Permission denied (publickey)."
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive alice@example.com
# must work
ssh alice@example.com
```

### 2.3 Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Only these three ports are ever needed from outside. All Andromeda services
and BRouter listen on `127.0.0.1`.

### 2.4 Automatic security updates

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades     # answer "Yes"
systemctl is-enabled unattended-upgrades
```

Because the services use Ubuntu's own `python3` and `python3-pil` (no pip, no
virtualenv), security fixes for Python and Pillow arrive through this
automatically.

### 2.5 Basic tools

```bash
sudo apt install -y git rsync curl unzip
```

---

## 3. Get the code

The repository is cloned to `/opt/andromeda/app` and owned by root, so no
service can modify its own code.

```bash
sudo mkdir -p /opt/andromeda
sudo git clone https://github.com/<you>/andromeda-explorer.git /opt/andromeda/app
```

---

## 4. Users, directories and services

```bash
sudo /opt/andromeda/app/deploy/setup.sh
```

`setup.sh` is idempotent — run it again whenever you like; it only creates
what is missing and repairs ownership and permissions. It:

- installs `python3-pil`, `python3-qrcode` and `openjdk-21-jre-headless` if
  missing,
- creates one system user per service (no login shell, no home directory)
  and the shared group `andromeda-pipeline`,
- creates `/var/lib/andromeda/…` with the right owners and modes,
- creates `/etc/andromeda/` and `/etc/andromeda/andromeda.env` from the
  template,
- creates `/opt/andromeda/www` owned by the user who ran `sudo` (for rsync
  uploads of the website),
- installs the systemd units to `/etc/systemd/system/`.

It does not start anything. Warnings about a missing `brouter.jar`,
`lookups.dat` and `admin.json` are expected at this point — the next steps
fix them.

---

## 5. BRouter

### 5.1 Program and standard profiles

Download the latest release zip from
[github.com/abrensch/brouter/releases](https://github.com/abrensch/brouter/releases)
(at the time of writing v1.7.10). It contains the server JAR
(`brouter-<version>-all.jar`) and the standard profiles including
`lookups.dat`.

```bash
cd /tmp
# Adjust the version / file name to what the releases page offers:
curl -LO https://github.com/abrensch/brouter/releases/download/v1.7.10/brouter-1.7.10.zip
unzip -q brouter-1.7.10.zip -d brouter-release

# The JAR
JAR=$(find brouter-release -name 'brouter-*-all.jar' | head -1); echo "$JAR"
sudo install -o root -g root -m 0644 "$JAR" /opt/andromeda/brouter/brouter.jar

# The standard profiles + lookups.dat
P2=$(find brouter-release -type d -name profiles2 | head -1); echo "$P2"
sudo cp "$P2"/* /var/lib/andromeda/brouter/profiles2/

rm -rf /tmp/brouter-release /tmp/brouter-*.zip
sudo /opt/andromeda/app/deploy/setup.sh       # fixes owners and modes
```

Check that the server class is there and accepts a bind address:

```bash
java -cp /opt/andromeda/brouter/brouter.jar btools.server.RouteServer 2>&1 | grep usage
# usage: java RouteServer <segmentdir> <profiledir> <customprofiledir> <port> <maxthreads> [bindaddress]
```

### 5.2 What goes where

| Path | Content | Owner |
|---|---|---|
| `/opt/andromeda/brouter/brouter.jar` | the program | root |
| `/var/lib/andromeda/brouter/profiles2/` | standard profiles, `lookups.dat`, and the temporary `tourpack_*.brf` that geo-gateway creates | andromeda-geo, group brouter |
| `/var/lib/andromeda/brouter/segments4/` | map data (`*.rd5`) | brouter |
| `/var/lib/andromeda/brouter/segments4_backup/` | previous versions (hard links) | brouter |
| `/opt/andromeda/app/services/profiles/` | Andromeda's profile templates (part of the repo) | root |

The website never asks BRouter for a profile template directly:
`geo-gateway` copies the template (`wandern`, `trekking`, `rennrad`, `laufen`)
with the user's settings into `profiles2/tourpack_<…>.brf` and deletes those
copies after 30 minutes.

### 5.3 lookups.dat and segment versions

`lookups.dat` (from the release) and the segment files (from brouter.de) must
belong to the same format version. The weekly segments on brouter.de are built
for the current release, so use the latest release. If BRouter logs
`lookup version mismatch`, take a current `lookups.dat` from
[misc/profiles2 in the BRouter repository](https://github.com/abrensch/brouter/tree/master/misc/profiles2)
and copy it to `/var/lib/andromeda/brouter/profiles2/`.

### 5.4 Memory and threads

The default in `deploy/systemd/brouter.service` is 3 threads and a 3.5 GB
heap. To change it, use a systemd override (it survives updates of the repo):

```bash
sudo systemctl edit brouter
```

Example for a small server (1 thread, 1 GB heap) — paste between the comment
lines:

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/java -Xms1g -Xmx1g -XX:+UseG1GC -DmaxRunningTime=300 \
  -cp /opt/andromeda/brouter/brouter.jar btools.server.RouteServer \
  /var/lib/andromeda/brouter/segments4 /var/lib/andromeda/brouter/profiles2 \
  /var/lib/andromeda/brouter/customprofiles 17777 1 127.0.0.1
```

and tell geo-gateway about it in `/etc/andromeda/andromeda.env`:

```bash
ANDROMEDA_BROUTER_THREADS=1
```

geo-gateway never sends BRouter more parallel requests than this; additional
requests wait in its fair queue.

---

## 6. Configuration

```bash
sudo nano /etc/andromeda/andromeda.env
```

For your own instance set at least:

```bash
ANDROMEDA_ORIGIN=https://example.com
ANDROMEDA_CONTACT=you@example.com
```

`ANDROMEDA_ORIGIN` is used for CORS and for links in the generated tour pages
and sitemap. `ANDROMEDA_CONTACT` goes into the `User-Agent` sent to Nominatim
and Overpass — their usage policies require a way to reach you. The file
contains no secrets and is readable by all services. The other variables are
described in the file itself and in the README.

---

## 7. Admin login

```bash
sudo /opt/andromeda/app/deploy/admin-init.sh
```

You are asked for a password (at least 12 characters). Then a TOTP secret and
a QR code are shown — add it to an authenticator app (Aegis, 2FAS, Google
Authenticator, 1Password, Bitwarden …) and enter the current code to confirm.
The result is written to `/etc/andromeda/admin.json`
(`root:andromeda-admin`, mode 0640).

Later:

```bash
sudo /opt/andromeda/app/deploy/admin-init.sh password   # change only the password
sudo /opt/andromeda/app/deploy/admin-init.sh --force    # new password and new TOTP secret
sudo systemctl restart tours-admin
```

Make sure the server clock is correct (`timedatectl` should show
`System clock synchronized: yes`), otherwise TOTP codes are rejected.

---

## 8. Website

The static website is served from `/opt/andromeda/www`, which belongs to your
admin user so you can update it with rsync without sudo.

From the copy on the server:

```bash
rsync -a /opt/andromeda/app/www/ /opt/andromeda/www/
```

or from your own computer (inside the repository):

```bash
rsync -av www/ alice@example.com:/opt/andromeda/www/
```

Don't use `--delete` if you keep extra files in `/opt/andromeda/www` that are
not in the repository (e.g. `robots.txt`, downloads).

A minimal `robots.txt` that points crawlers to the sitemap:

```bash
printf 'User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml\n' \
  > /opt/andromeda/www/robots.txt
```

The imprint (`impressum.html`) contains personal data and is therefore not
part of the repository. Create your own from the template:

```bash
cp /opt/andromeda/www/impressum.example.html /opt/andromeda/www/impressum.html
nano /opt/andromeda/www/impressum.html
```

If you use your own domain, adapt the domain-specific texts in the HTML
(legal notice, canonical links) as well.

---

## 9. Caddy

Ubuntu 24.04 ships Caddy in its repositories:

```bash
sudo apt install -y caddy
```

(For the newest version, use the official Caddy repository described at
[caddyserver.com/docs/install](https://caddyserver.com/docs/install).)

Install the configuration from the repository and replace the domain:

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.default
sudo cp /opt/andromeda/app/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/andromeda-explorer\.com/example.com/g' /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

What the Caddyfile does:

| Path | Goes to |
|---|---|
| `/brouter`, `/profile/*`, `/nominatim/*`, `/overpass` | geo-gateway (8080) |
| `/search`, `/thumbnail/*`, `/tourpack/*`, `/touren`, `/touren/*`, `/sitemap.xml` | tours-api (8081) |
| `/upload` (max. 31 MB) | tours-upload (8083) |
| `/admin*` (max. 106 MB) | tours-admin (8082) |
| everything else | static files from `/opt/andromeda/www` |

Use `handle`, not `handle_path` — the services need the full path. Never point
the site root at `/opt/andromeda` itself.

Caddy obtains the TLS certificate automatically on the first request, as soon
as DNS points to the server and ports 80/443 are open.

---

## 10. Start everything

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now brouter brouter-restart.path geo-gateway brouter-updater \
     tours-api tours-upload tours-sanitizer tours-admin

systemctl --no-pager status brouter geo-gateway brouter-updater tours-api \
     tours-upload tours-sanitizer tours-admin | grep -E '●|Active'
```

All should show `active (running)`. BRouter takes a few seconds to start
(it pre-allocates its memory). Without segment files it runs, but cannot
calculate routes yet — that's the next step.

---

## 11. Map data for BRouter

BRouter's map data comes as 5°×5° tiles named after their south-west corner:
`E15_N45.rd5` covers 15°–20° E and 45°–50° N. Find the tiles you need on the
map at [brouter.de/brouter/segments4](https://brouter.de/brouter/segments4/).
Examples:

| Region | Tiles |
|---|---|
| Austria | `E5_N45`, `E10_N45`, `E15_N45` |
| Slovenia | `E10_N45`, `E15_N45` |
| Croatia | `E10_N40`, `E10_N45`, `E15_N40`, `E15_N45` |
| Hungary | `E15_N45`, `E20_N45` |

Register them through brouter-updater (one at a time; the updater downloads
politely, waits until BRouter is idle, then restarts it):

```bash
python3 /opt/andromeda/app/services/brouter-updater.py register E10_N45
python3 /opt/andromeda/app/services/brouter-updater.py register E15_N45
python3 /opt/andromeda/app/services/brouter-updater.py status
journalctl -u brouter-updater -f        # watch progress, Ctrl+C to stop
```

From then on, brouter-updater checks all installed tiles once a week and
downloads only those that changed. After replacing files it writes
`/var/lib/andromeda/brouter/restart-request`; the systemd path unit
`brouter-restart.path` notices this and restarts BRouter (at most four times
per hour). No sudo rule is needed for this.

---

## 12. Check that it works

On the server:

```bash
curl -s 'http://127.0.0.1:8081/search?q=a' | head -c 200; echo
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/touren/
curl -s 'http://127.0.0.1:8080/brouter?lonlats=16.37,48.21|16.40,48.20&profile=trekking&format=geojson' | head -c 200; echo
curl -s http://127.0.0.1:8084/status; echo
```

(Use coordinates inside a tile you installed.)

Only SSH and Caddy may listen on public addresses:

```bash
sudo ss -tlnp | grep -v '127.0.0.1\|127.0.0.5\|\[::1\]'
```

Security rating of the units (values around 1 are very good):

```bash
for u in geo-gateway brouter-updater tours-api tours-upload tours-sanitizer tours-admin brouter; do
  printf '%-16s ' $u; systemd-analyze security $u | tail -1
done
```

In the browser:

- [ ] Home page loads; searching returns nothing yet (no tours published) without errors
- [ ] Route planner: calculate a route with each profile, place search, POI search
- [ ] Navigator: open a planned route
- [ ] TourPack editor: create a tour from a GPX and download the `.tourpack`
- [ ] `/admin/`: log in with password + code, upload your `.tourpack` → it
      appears on the home page, at `/touren/` and in `/sitemap.xml`
- [ ] Upload page: submit a TourPack → it appears in the admin under uploads;
      *Prepare*, view, *Publish* or *Reject*

---

## 13. Day-to-day operations

### Logs

```bash
journalctl -u tours-api -n 100 --no-pager
journalctl -u geo-gateway -f
journalctl -u 'tours-*' -u geo-gateway -u brouter* --since today
```

### Updating the code

```bash
sudo git -C /opt/andromeda/app pull
sudo /opt/andromeda/app/deploy/setup.sh        # applies changed units and permissions
sudo systemctl restart geo-gateway brouter-updater tours-api tours-upload tours-sanitizer tours-admin
rsync -a /opt/andromeda/app/www/ /opt/andromeda/www/
```

After changes to the navigator or viewer, `CACHE_NAME` in
`www/tourpack-nav-sw.js` must be bumped, otherwise installed clients keep the
old files. Reload the page twice to get the new version.

### Updating BRouter

Replace `/opt/andromeda/brouter/brouter.jar` (and `lookups.dat` / standard
profiles if the release changed them) as in [5.1](#51-program-and-standard-profiles),
then `sudo systemctl restart brouter`.

### Managing tours

Everything happens in `/admin/`. Published tours live as plain directories in
`/var/lib/andromeda/tours/published/<id>/`; deleting one there by hand also
works — tours-api notices within ten minutes, immediately after
`sudo touch /var/lib/andromeda/tours/published/.changed`.

To rebuild the search index, thumbnails and pages from scratch:

```bash
sudo systemctl stop tours-api
sudo -u andromeda-tours find /var/lib/andromeda/tours-api -type f -delete
sudo systemctl start tours-api
```

---

## 14. Backups

Only two things are irreplaceable:

| What | Path |
|---|---|
| Admin login | `/etc/andromeda/admin.json` (+ `andromeda.env` if changed) |
| Published tours (+ promoted list) | `/var/lib/andromeda/tours/published/` |

Optional: pending uploads (`/var/lib/andromeda/tours/{inbox,jobs,staging}`)
and files you added to `/opt/andromeda/www` that are not in the repository.
Everything else (index, thumbnails, caches, BRouter segments) is rebuilt or
downloaded automatically.

```bash
sudo tar -czf ~/andromeda-backup-$(date +%F).tar.gz \
     /etc/andromeda /var/lib/andromeda/tours/published
```

Restore on a new server: follow this guide up to step 7 (you can skip
`admin-init.sh`), then

```bash
sudo tar -xzf andromeda-backup-*.tar.gz -C /
sudo /opt/andromeda/app/deploy/setup.sh       # fixes owners and modes
sudo systemctl restart tours-api tours-admin
```

---

## 15. Troubleshooting

**A service doesn't start.** `journalctl -u <name> -n 50 --no-pager` shows
why. "Permission denied" usually means ownership got lost (e.g. after copying
files by hand) — run `sudo /opt/andromeda/app/deploy/setup.sh`.

**BRouter doesn't start, log mentions "bad system call" or "Operation not
permitted".** Some Java versions use system calls outside the filter. Add an
override with `sudo systemctl edit brouter`:

```ini
[Service]
SystemCallFilter=
```

**Routes fail with HTTP 502.** BRouter isn't running or has no segment for
that area: check `systemctl status brouter`, `ls /var/lib/andromeda/brouter/segments4`
and `journalctl -u brouter -n 50`.

**"Routenberechnung ausgelastet" (HTTP 503).** More requests than the queue
accepts. Increase threads/RAM ([5.4](#54-memory-and-threads)) or live with it —
it protects the server.

**Place search or POI search fails.** `journalctl -u geo-gateway` shows the
upstream status. Nominatim and Overpass are volunteer services and are
sometimes overloaded; responses are cached, so repeated searches still work.

**Admin: "Code ungültig oder abgelaufen" with the right code.** Check the
clock (`timedatectl`). Each code works only once — wait for the next one.

**Admin shows "Admin noch nicht eingerichtet".** `/etc/andromeda/admin.json`
is missing or unreadable for `andromeda-admin`; run `admin-init.sh` or
`setup.sh`.

**A new tour doesn't show up.** `journalctl -u tours-api -n 20` — tours with
an invalid `manifest.json`/`route.json` are skipped with a message.

**Caddy has no certificate.** DNS must point to the server, ports 80 and 443
must be open; `journalctl -u caddy -n 50`.

---

## 16. Reference: files, users and permissions

### Users and groups

| User | Runs | Groups |
|---|---|---|
| `andromeda-geo` | geo-gateway | – |
| `andromeda-tours` | tours-api | – |
| `andromeda-upload` | tours-upload | andromeda-pipeline |
| `andromeda-sanitizer` | tours-sanitizer | andromeda-pipeline |
| `andromeda-admin` | tours-admin | andromeda-pipeline |
| `brouter` | BRouter, brouter-updater | – |

All are system users without a login shell or home directory. Your own admin
user needs only `sudo` and ownership of `/opt/andromeda/www`.

### Directories

| Path | Owner : group | Mode | Written by | Read by |
|---|---|---|---|---|
| `/opt/andromeda/app` | root : root | 755 | (git, as root) | all services |
| `/opt/andromeda/www` | your user | 755 | you (rsync) | Caddy |
| `/opt/andromeda/brouter/brouter.jar` | root : root | 644 | – | BRouter |
| `/etc/andromeda/andromeda.env` | root : root | 644 | – | all services |
| `/etc/andromeda/admin.json` | root : andromeda-admin | 640 | admin-init.sh | tours-admin |
| `/var/lib/andromeda/tours/inbox` | andromeda-upload : andromeda-pipeline | 2770 | upload, sanitizer, admin | sanitizer, admin |
| `/var/lib/andromeda/tours/jobs` | andromeda-upload : andromeda-pipeline | 2770 | upload, sanitizer, admin | sanitizer, admin |
| `/var/lib/andromeda/tours/staging` | andromeda-sanitizer : andromeda-pipeline | 2770 | sanitizer, admin | admin |
| `/var/lib/andromeda/tours/published` | andromeda-admin : andromeda-tours | 2750 | admin | tours-api |
| `/var/lib/andromeda/tours-api` | andromeda-tours | 750 | tours-api | – |
| `/var/lib/andromeda/geo-cache` | andromeda-geo | 750 | geo-gateway | – |
| `/var/lib/andromeda/brouter` | brouter | 755 | brouter-updater | BRouter |
| `/var/lib/andromeda/brouter/profiles2` | andromeda-geo : brouter | 2750 | geo-gateway | BRouter |

The 2 in `2770`/`2750` is the setgid bit: new files inherit the directory's
group, so the next service in the chain can read them.

### Ports (all on 127.0.0.1)

| Port | Service |
|---|---|
| 8080 | geo-gateway |
| 8081 | tours-api |
| 8082 | tours-admin |
| 8083 | tours-upload |
| 8084 | brouter-updater (not exposed through Caddy) |
| 17777 | BRouter |
