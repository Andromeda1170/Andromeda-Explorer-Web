#!/usr/bin/env bash
# Admin-Zugang (Passwort + TOTP) einrichten oder neu anlegen.
#   sudo /opt/andromeda/app/deploy/admin-init.sh            # erstmalig
#   sudo /opt/andromeda/app/deploy/admin-init.sh --force    # neu (neues TOTP-Secret!)
#   sudo /opt/andromeda/app/deploy/admin-init.sh password   # nur Passwort ändern
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Bitte als root ausführen (sudo)."; exit 1; }
set -a; [[ -f /etc/andromeda/andromeda.env ]] && . /etc/andromeda/andromeda.env; set +a
export PYTHONDONTWRITEBYTECODE=1
ADMIN=/opt/andromeda/app/services/tours-admin.py
if [[ ${1:-} == password ]]; then
  python3 "$ADMIN" set-password
else
  python3 "$ADMIN" init-config "$@"
fi
echo "Jetzt: sudo systemctl restart tours-admin"
