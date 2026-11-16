#!/usr/bin/env bash
# =============================================================================
# setup.sh — Benutzer, Ordner, Rechte und systemd-Units einrichten
# =============================================================================
# Als root ausführen, aus dem Code-Ordner heraus:
#
#     sudo /opt/andromeda/app/deploy/setup.sh
#
# Das Skript ist idempotent: es kann jederzeit erneut laufen und stellt
# dabei Besitzer und Rechte wieder her. Es startet keine Dienste und
# löscht nichts.
# =============================================================================
set -euo pipefail

APP=/opt/andromeda/app
WWW=/opt/andromeda/www
DATA=/var/lib/andromeda
CONF=/etc/andromeda
JAR_DIR=/opt/andromeda/brouter
WWW_OWNER="${WWW_OWNER:-${SUDO_USER:-root}}"   # wer per rsync die Website hochlädt

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Bitte als root ausführen (sudo)."; exit 1; }
[[ -f $APP/services/andromeda_lib.py ]] || { echo "Code nicht in $APP gefunden."; exit 1; }

# -----------------------------------------------------------------------------
say "Pakete (python3-pil für Bilder, python3-qrcode für die Admin-Einrichtung)"
# -----------------------------------------------------------------------------
missing=()
for pkg in python3 python3-pil python3-qrcode; do
  dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
done
command -v java >/dev/null || missing+=("openjdk-21-jre-headless")
if ((${#missing[@]})); then
  apt-get update -q
  apt-get install -y -q "${missing[@]}"
fi

# -----------------------------------------------------------------------------
say "Gruppen und Benutzer (System-Konten ohne Login und ohne Home)"
# -----------------------------------------------------------------------------
ensure_group() { getent group "$1" >/dev/null || groupadd --system "$1"; }
ensure_user() {  # name [zusatzgruppen]
  local name=$1 groups=${2:-}
  if ! id "$name" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent \
            --shell /usr/sbin/nologin "$name"
  fi
  usermod --shell /usr/sbin/nologin "$name" 2>/dev/null || true
  usermod --groups "$groups" "$name" 2>/dev/null || true
}

ensure_group andromeda-pipeline          # upload, sanitizer, admin: Eingang/Aufträge/staging
ensure_user andromeda-geo
ensure_user andromeda-tours
ensure_user andromeda-upload    andromeda-pipeline
ensure_user andromeda-sanitizer andromeda-pipeline
ensure_user andromeda-admin     andromeda-pipeline
ensure_user brouter

# -----------------------------------------------------------------------------
say "Code: $APP gehört root und ist für Dienste nur lesbar"
# -----------------------------------------------------------------------------
chown -R root:root "$APP"
chmod -R u=rwX,go=rX "$APP"
chmod 0755 "$APP"/deploy/*.sh

# -----------------------------------------------------------------------------
say "Datenordner unter $DATA"
# -----------------------------------------------------------------------------
mkd() {  # pfad besitzer:gruppe modus
  install -d -o "${2%%:*}" -g "${2##*:}" -m "$3" "$1"
  chown "$2" "$1"; chmod "$3" "$1"
}
mkd "$DATA"                          root:root                         0755
mkd "$DATA/tours"                    root:root                         0755
mkd "$DATA/tours/inbox"              andromeda-upload:andromeda-pipeline    2770
mkd "$DATA/tours/jobs"               andromeda-upload:andromeda-pipeline    2770
mkd "$DATA/tours/staging"            andromeda-sanitizer:andromeda-pipeline 2770
mkd "$DATA/tours/published"          andromeda-admin:andromeda-tours        2750
mkd "$DATA/tours-api"                andromeda-tours:andromeda-tours        0750
mkd "$DATA/tours-api/index"          andromeda-tours:andromeda-tours        0750
mkd "$DATA/tours-api/thumbnails"     andromeda-tours:andromeda-tours        0750
mkd "$DATA/tours-api/pages"          andromeda-tours:andromeda-tours        0750
mkd "$DATA/geo-cache"                andromeda-geo:andromeda-geo            0750
mkd "$DATA/brouter"                  brouter:brouter                        0755
mkd "$DATA/brouter/segments4"        brouter:brouter                        0755
mkd "$DATA/brouter/segments4_backup" brouter:brouter                        0750
mkd "$DATA/brouter/customprofiles"   brouter:brouter                        0750
mkd "$DATA/brouter/profiles2"        andromeda-geo:brouter                  2750
mkd "$DATA/archive"                  root:root                              0700

# Bestehende Inhalte reparieren (z. B. nach Migration oder Handarbeit)
fix_tree() {  # pfad besitzer:gruppe dirmodus filemodus
  [[ -d $1 ]] || return 0
  chown -R "$2" "$1"
  find "$1" -mindepth 1 -type d -exec chmod "$3" {} +
  find "$1" -type f -exec chmod "$4" {} +
}
fix_tree "$DATA/tours/inbox"     andromeda-upload:andromeda-pipeline    2770 0660
fix_tree "$DATA/tours/jobs"      andromeda-upload:andromeda-pipeline    2770 0660
fix_tree "$DATA/tours/staging"   andromeda-sanitizer:andromeda-pipeline 2770 0660
fix_tree "$DATA/tours/published" andromeda-admin:andromeda-tours        0750 0640
fix_tree "$DATA/tours-api"       andromeda-tours:andromeda-tours        0750 0640
fix_tree "$DATA/geo-cache"       andromeda-geo:andromeda-geo            0750 0640
fix_tree "$DATA/brouter/profiles2" andromeda-geo:brouter                2750 0640
for d in segments4 segments4_backup customprofiles; do
  fix_tree "$DATA/brouter/$d" brouter:brouter 0755 0644
done
for f in updater-state.json restart-request; do
  [[ -e $DATA/brouter/$f ]] && chown brouter:brouter "$DATA/brouter/$f"
done

[[ -f $DATA/brouter/profiles2/lookups.dat ]] || \
  warn "profiles2/lookups.dat fehlt — BRouter-Standardprofile aus dem BRouter-Release nach $DATA/brouter/profiles2 kopieren (docs/SERVER-SETUP.md)."

# -----------------------------------------------------------------------------
say "BRouter-Programm: $JAR_DIR/brouter.jar"
# -----------------------------------------------------------------------------
install -d -o root -g root -m 0755 "$JAR_DIR"
if [[ ! -f $JAR_DIR/brouter.jar ]]; then
  jar=$(ls "$JAR_DIR"/brouter-*-all.jar 2>/dev/null | sort -V | tail -1 || true)
  if [[ -n $jar ]]; then cp "$jar" "$JAR_DIR/brouter.jar"
  else warn "Kein brouter.jar in $JAR_DIR — von github.com/abrensch/brouter/releases holen."; fi
fi
[[ -f $JAR_DIR/brouter.jar ]] && { chown root:root "$JAR_DIR/brouter.jar"; chmod 0644 "$JAR_DIR/brouter.jar"; }

# -----------------------------------------------------------------------------
say "Konfiguration: $CONF"
# -----------------------------------------------------------------------------
# Ordner lesbar (andromeda.env brauchen alle Dienste), admin.json nicht.
install -d -o root -g root -m 0755 "$CONF"
chown root:root "$CONF"; chmod 0755 "$CONF"
if [[ -f $CONF/admin.json ]]; then
  chown root:andromeda-admin "$CONF/admin.json"; chmod 0640 "$CONF/admin.json"
else
  warn "$CONF/admin.json fehlt — einrichten mit: sudo $APP/deploy/admin-init.sh"
fi
if [[ ! -f $CONF/andromeda.env ]]; then
  install -o root -g root -m 0644 "$APP/deploy/andromeda.env.example" "$CONF/andromeda.env"
fi

# -----------------------------------------------------------------------------
say "Website-Ordner $WWW (gehört $WWW_OWNER, Upload per rsync)"
# -----------------------------------------------------------------------------
if id "$WWW_OWNER" >/dev/null 2>&1; then
  install -d -o "$WWW_OWNER" -g "$WWW_OWNER" -m 0755 "$WWW"
else
  warn "Benutzer $WWW_OWNER fehlt — WWW_OWNER=… setzen."
fi

# -----------------------------------------------------------------------------
say "systemd-Units installieren"
# -----------------------------------------------------------------------------
for f in "$APP"/deploy/systemd/*.service "$APP"/deploy/systemd/*.path; do
  install -o root -g root -m 0644 "$f" /etc/systemd/system/
done
systemctl daemon-reload || warn "systemctl daemon-reload fehlgeschlagen"

cat <<EOF

Fertig. Nächste Schritte (siehe docs/SERVER-SETUP.md):
  - Admin-Zugang (falls nötig):   sudo $APP/deploy/admin-init.sh
  - Dienste starten:
      sudo systemctl enable --now brouter brouter-restart.path geo-gateway \\
           brouter-updater tours-api tours-upload tours-sanitizer tours-admin
EOF
