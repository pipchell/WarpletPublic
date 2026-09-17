#!/usr/bin/env bash
#
# Warplet installer — Raspberry Pi / any systemd-based Linux box.
#
# Usage (on the target machine):
#   curl -fsSL https://raw.githubusercontent.com/pipchell/warplet/main/install.sh | bash
#
# Re-running this script is safe: it will pull the latest code but will
# NOT overwrite an already-configured warplet.service or regenerate your
# access token.
#
# Override any of these by exporting them before piping into bash, e.g.:
#   WARPLET_PORT=9000 curl -fsSL .../install.sh | bash

set -euo pipefail

REPO_URL="${WARPLET_REPO:-https://github.com/pipchell/WarpletPublic.git}"
INSTALL_DIR="${WARPLET_DIR:-$HOME/warplet}"
PORT="${WARPLET_PORT:-8787}"
SERVICE_FILE="/etc/systemd/system/warplet.service"

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$1"; }

if [ "$(id -u)" -eq 0 ]; then
  warn "Running as root. This script uses sudo internally for the parts that need"
  warn "it (installing packages, writing the systemd unit) and runs the rest as"
  warn "your normal user. Running the whole thing as root is fine but unusual."
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required and was not found. Install sudo or run the equivalent"
  echo "commands as root yourself." >&2
  exit 1
fi

# ---- 1. Node.js ----
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
  if [ "$NODE_MAJOR" -ge 18 ]; then
    NEED_NODE=0
  fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
  log "Installing Node.js 20.x (current LTS)"
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  log "Node.js $(node --version) already installed, skipping"
fi

if ! command -v git >/dev/null 2>&1; then
  log "Installing git"
  sudo apt-get update -y
  sudo apt-get install -y git
fi

# ---- 2. Get the code ----
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Warplet already cloned at $INSTALL_DIR — pulling latest"
  git -C "$INSTALL_DIR" pull --ff-only
else
  log "Cloning Warplet into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

DATA_FILE="$INSTALL_DIR/data/links.json"
mkdir -p "$(dirname "$DATA_FILE")"

# ---- 3. Access token + systemd service ----
if [ -f "$SERVICE_FILE" ]; then
  log "$SERVICE_FILE already exists — leaving your existing token and config alone"
else
  log "Generating a random access token"
  ACCESS_TOKEN=$(openssl rand -hex 32)

  log "Writing $SERVICE_FILE"
  sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Warplet link shortener
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v node) server.js
Restart=on-failure
RestartSec=5

Environment=ACCESS_TOKEN=$ACCESS_TOKEN
Environment=PORT=$PORT
Environment=DATA_FILE=$DATA_FILE

[Install]
WantedBy=multi-user.target
EOF

  echo "$ACCESS_TOKEN" > "$INSTALL_DIR/.access_token.txt"
  chmod 600 "$INSTALL_DIR/.access_token.txt"
fi

# ---- 4. Start it ----
log "Enabling and starting the warplet service"
sudo systemctl daemon-reload
sudo systemctl enable --now warplet.service

sleep 1
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
IP="${IP:-<this-device-ip>}"

log "Done"
echo
echo "  Dashboard:  http://$IP:$PORT"
if [ -f "$INSTALL_DIR/.access_token.txt" ]; then
  echo "  Access token: $(cat "$INSTALL_DIR/.access_token.txt")"
  echo "  (also saved to $INSTALL_DIR/.access_token.txt — move it to a password"
  echo "   manager and delete that file once you have)"
fi
echo
echo "Check status any time with:  sudo systemctl status warplet"
echo "Watch logs with:              journalctl -u warplet -f"
