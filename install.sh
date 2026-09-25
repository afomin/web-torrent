#!/usr/bin/env bash
# One-shot installer for a fresh Ubuntu/Debian server.
# Usage (as root):  git clone <repo> web-torrent && cd web-torrent && ./install.sh
set -euo pipefail

cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo ./install.sh" >&2
  exit 1
fi

say () { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }

# ---------- Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# ---------- .env ----------
if [ ! -f .env ]; then
  say "Configuring"
  IP="$(curl -4 -fsS https://api.ipify.org || curl -4 -fsS https://ifconfig.me || true)"
  DEFAULT_DOMAIN=""
  [ -n "$IP" ] && DEFAULT_DOMAIN="$(echo "$IP" | tr . -).sslip.io"
  read -r -p "Domain [${DEFAULT_DOMAIN}]: " DOMAIN
  DOMAIN="${DOMAIN:-$DEFAULT_DOMAIN}"
  if [ -z "$DOMAIN" ]; then echo "Domain is required" >&2; exit 1; fi

  read -r -p "Username [admin]: " USERNAME
  USERNAME="${USERNAME:-admin}"
  while true; do
    read -r -s -p "Password (min 10 chars): " PASSWORD; echo
    read -r -s -p "Repeat password: " PASSWORD2; echo
    if [ "$PASSWORD" != "$PASSWORD2" ]; then echo "Passwords do not match"; continue; fi
    if [ "${#PASSWORD}" -lt 10 ]; then echo "Too short"; continue; fi
    break
  done

  say "Building image"
  touch .env
  docker compose build app
  HASH="$(docker compose run --rm --no-deps -T -e PASSWORD_TO_HASH="$PASSWORD" app node scripts/hash-password.js | tr -d '\r')"

  umask 077
  cat > .env <<EOF
DOMAIN=${DOMAIN}
AUTH_USERNAME=${USERNAME}
AUTH_PASSWORD_HASH='${HASH}'
SESSION_DAYS=30
TORRENT_PORT=51413
DOWNLOAD_LIMIT_KBPS=-1
MAX_CONNS=100
EOF
  unset PASSWORD PASSWORD2
fi

# ---------- firewall ----------
if command -v ufw >/dev/null 2>&1; then
  say "Opening firewall ports (22, 80, 443, 51413)"
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw allow 51413 >/dev/null
  ufw --force enable >/dev/null
elif command -v iptables >/dev/null 2>&1 && iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
  # Oracle Cloud Ubuntu images ship with a REJECT rule in iptables.
  say "Opening iptables ports (80, 443, 51413)"
  for rule in "-p tcp --dport 80" "-p tcp --dport 443" "-p udp --dport 443" "-p tcp --dport 51413" "-p udp --dport 51413"; do
    # shellcheck disable=SC2086
    iptables -C INPUT $rule -j ACCEPT 2>/dev/null || iptables -I INPUT 5 $rule -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null; fi
fi

mkdir -p data downloads

say "Starting"
docker compose up -d --build

DOMAIN="$(grep '^DOMAIN=' .env | cut -d= -f2-)"
say "Done! Open https://${DOMAIN}"
echo "The certificate is issued on the first visit (may take ~30s)."
echo "If your provider has a cloud firewall (Oracle, AWS, Hetzner...), open TCP 80, 443 and TCP+UDP 51413 there too."
