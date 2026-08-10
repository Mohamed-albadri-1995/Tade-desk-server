#!/usr/bin/env bash
#
# Put the alerts app behind HTTPS, so browser notifications work.
#
#   bash deploy/setup-https.sh trade-desk.duckdns.org
#
# WHAT YOU MUST DO FIRST, because neither can be done from here:
#
#   1. Create the subdomain and point it at this server's public IP.
#      DuckDNS (free, no card): https://duckdns.org — sign in, pick a name,
#      put the IP in the box, press update.
#
#   2. Open ports 80 and 443 in the AWS security group for this instance.
#      Port 80 carries no traffic but Let's Encrypt proves domain control over
#      it, on issue AND on every renewal — closing it later breaks the site
#      ninety days afterwards, which is the hardest kind of outage to connect
#      back to its cause.
#
# The script checks both before touching anything, because a failed certificate
# leaves Caddy running and serving nothing, which reads as "the tool is down".

set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: bash deploy/setup-https.sh <your-domain>"
  echo "   eg: bash deploy/setup-https.sh trade-desk.duckdns.org"
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "── checking before changing anything ────────────────────────────────"

# 1. Does the name point here? A certificate cannot be issued otherwise, and
#    the error from Let's Encrypt is several layers down in a log.
MY_IP="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]' || true)"
DNS_IP="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
echo "  this server : ${MY_IP:-unknown}"
echo "  $DOMAIN → ${DNS_IP:-nothing}"
if [ -z "$DNS_IP" ]; then
  echo
  # No apostrophe inside ${...:-...}: bash reads it as an opening quote and the
  # whole script fails to parse, several lines later, on an unrelated line.
  echo "!! $DOMAIN does not resolve. Create it first and point it at ${MY_IP:-the IP of this server}."
  exit 1
fi
if [ -n "$MY_IP" ] && [ "$DNS_IP" != "$MY_IP" ]; then
  echo
  echo "!! $DOMAIN points at $DNS_IP, not at this server ($MY_IP)."
  echo "   Update it and run this again — a certificate cannot be issued until it matches."
  exit 1
fi

# 2. Is port 80 reachable from outside? Tested from outside rather than with a
#    local listen check, because the security group is the thing that is
#    usually wrong and a local check cannot see it.
echo "  port 80 from the internet…"
if ! (command -v nc >/dev/null && nc -z -w3 "$DNS_IP" 80 2>/dev/null); then
  echo "     unreachable (or nc missing) — continuing, but if the certificate"
  echo "     fails this is the first thing to check in the AWS security group."
fi

echo
echo "── installing Caddy ─────────────────────────────────────────────────"
if command -v caddy >/dev/null; then
  echo "  already installed: $(caddy version | head -1)"
else
  # NOT the COPR repo. COPR is a Fedora build service; Amazon Linux 2023 has no
  # copr plugin and no caddy package, so `dnf install caddy` ends in
  # "Unable to find a match: caddy". The official static binary from GitHub is
  # the supported route on distributions Caddy does not package for.
  case "$(uname -m)" in
    x86_64)  ARCH=amd64 ;;
    aarch64) ARCH=arm64 ;;
    *) echo "!! unsupported CPU: $(uname -m)"; exit 1 ;;
  esac

  # Ask GitHub for the current release; fall back to a known-good pin so a rate
  # limit or an offline moment does not leave the box half-configured.
  VER="$(curl -fsS --max-time 15 https://api.github.com/repos/caddyserver/caddy/releases/latest 2>/dev/null \
         | grep -m1 '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/' || true)"
  case "$VER" in
    ''|*[!0-9.]*) VER=2.8.4 ;;
  esac
  echo "  caddy v$VER ($ARCH)"

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL --max-time 120 \
    "https://github.com/caddyserver/caddy/releases/download/v${VER}/caddy_${VER}_linux_${ARCH}.tar.gz" \
    -o "$TMP/caddy.tar.gz"
  tar -xzf "$TMP/caddy.tar.gz" -C "$TMP" caddy
  sudo install -m 0755 "$TMP/caddy" /usr/bin/caddy

  # The package would have created these. Doing it by hand keeps the rest of the
  # script — chown caddy:caddy, systemctl restart caddy — working unchanged.
  sudo groupadd --system caddy 2>/dev/null || true
  sudo useradd --system --gid caddy --create-home --home-dir /var/lib/caddy \
       --shell /usr/sbin/nologin --comment "Caddy web server" caddy 2>/dev/null || true

  sudo tee /etc/systemd/system/caddy.service >/dev/null <<'UNIT'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
# Ports 80 and 443 are privileged; the service does not run as root, so it is
# granted just the one capability that lets it bind them.
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  echo "  installed: $(caddy version | head -1)"
fi

echo
echo "── writing the config ───────────────────────────────────────────────"
mkdir -p "$ROOT/deploy"
node "$ROOT/scripts/make-caddyfile.js" "$DOMAIN" > "$ROOT/deploy/Caddyfile"
sudo mkdir -p /etc/caddy /var/log/caddy
sudo cp "$ROOT/deploy/Caddyfile" /etc/caddy/Caddyfile
# Not silenced. The service runs as caddy and writes an access log here; if this
# chown fails the service exits immediately with "permission denied" on the log
# file, which reads like a certificate problem and sends you looking in the
# wrong place entirely.
sudo chown -R caddy:caddy /var/log/caddy
sudo chown -R caddy:caddy /var/lib/caddy 2>/dev/null || true
echo "  /etc/caddy/Caddyfile"

# Refuse to start on a config Caddy cannot parse, rather than finding out from
# a dead service afterwards.
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

echo
echo "── starting ─────────────────────────────────────────────────────────"
sudo systemctl enable caddy >/dev/null 2>&1 || true
sudo systemctl restart caddy
sleep 6

# Separate "the service is dead" from "the certificate has not arrived yet".
# Both look identical from curl, and they need opposite responses: one is a
# thing to fix now, the other is a thing to wait out.
if ! sudo systemctl is-active --quiet caddy; then
  echo
  echo "!! Caddy started and exited. The reason is on the Status line below —"
  echo "   read that line, not the stack of INFO messages above it."
  echo
  sudo systemctl status caddy --no-pager | head -12
  exit 1
fi

if curl -fsS --max-time 20 "https://$DOMAIN/health" >/dev/null 2>&1; then
  echo
  echo "  https://$DOMAIN is live."

  # Point the landing page's Alerts card here. Without this it keeps building
  # the link from its own protocol and host — http://<ip>:3090 — which lands on
  # the insecure origin where the notification prompt is refused. The
  # certificate would exist and nothing would use it.
  #
  # Written only now, after the certificate is confirmed working: a landing page
  # linking to an https address that does not answer is worse than one linking
  # to the http address that does. data/ is gitignored, so this survives pulls.
  mkdir -p "$ROOT/data"
  node -e '
    const fs = require("fs"), p = process.argv[1], url = process.argv[2];
    let m = {};
    try { m = JSON.parse(fs.readFileSync(p, "utf8")) || {}; } catch {}
    m.ALERTS = url;
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  ' "$ROOT/data/app-urls.json" "https://$DOMAIN"
  echo "  landing page → data/app-urls.json (Alerts card now opens the https address)"
  # The page reads this through /api/tools, which is served by the screener
  # process, so that process has to be told. Reloading only the tools leaves the
  # alerts app itself alone.
  if command -v pm2 >/dev/null; then
    pm2 reload /^tool-/ >/dev/null 2>&1 || pm2 restart all >/dev/null 2>&1 || true
    echo "  screeners reloaded so the card picks it up"
  fi

  echo
  echo "  Open it on the phone and tap 🔔 Notifications — it should now ASK"
  echo "  rather than refuse. That is the whole point of this."
  echo
  echo "  Then tap 'test' beside it and CLOSE the page. The notification should"
  echo "  still arrive: that is background delivery, and it is the only part"
  echo "  that cannot be checked by looking at the page."
  echo "  On an iPhone: Share -> Add to Home Screen FIRST, and open it from"
  echo "  there. Safari does not deliver background push to a normal tab."
else
  echo
  echo "  Not answering yet. A first certificate can take up to a minute."
  echo "  Watch it:   sudo journalctl -u caddy -f"
  echo "  Then retry: curl -sS https://$DOMAIN/health"
  echo
  echo "  If the log mentions the challenge failing, port 80 is closed in the"
  echo "  AWS security group — that is the usual cause."
fi

echo
echo "  The screeners are unchanged, still on http://<ip>:3000 and friends."
echo "  Moving those to https means migrating their ports; the alerts app was"
echo "  moved first because it is the one that needs a secure origin."
