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

# If a previous run installed Node via nvm, pick it up even though this is a
# fresh, non-interactive shell that never sourced ~/.bashrc.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi

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

install_node_via_nvm() {
  log "No supported system package manager detected — installing Node.js via nvm instead"
  export NVM_DIR="$HOME/.nvm"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
}

if [ "$NEED_NODE" -eq 1 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    log "Installing Node.js 20.x (current LTS) via apt"
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    log "Installing Node.js 20.x (current LTS) via ${PKG:=$(command -v dnf >/dev/null 2>&1 && echo dnf || echo yum)}"
    curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo -E bash -
    sudo "$PKG" install -y nodejs
  elif command -v pacman >/dev/null 2>&1; then
    log "Installing Node.js via pacman"
    sudo pacman -Sy --noconfirm nodejs npm
  elif command -v zypper >/dev/null 2>&1; then
    log "Installing Node.js via zypper"
    sudo zypper --non-interactive install nodejs20 || sudo zypper --non-interactive install nodejs
  else
    install_node_via_nvm
  fi

  # Whatever method just ran, make sure it actually got us to Node 18+
  # (an older distro repo, or an unexpected package name, can still leave
  # us short) before falling back to nvm as a last resort.
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
  else
    NODE_MAJOR=0
  fi
  if [ "$NODE_MAJOR" -lt 18 ]; then
    install_node_via_nvm
  fi
else
  log "Node.js $(node --version) already installed, skipping"
fi

if ! command -v git >/dev/null 2>&1; then
  log "Installing git"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y && sudo apt-get install -y git
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y git
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y git
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm git
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper --non-interactive install git
  else
    echo "git is required and no supported package manager was found — please" >&2
    echo "install git yourself and re-run this script." >&2
    exit 1
  fi
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
