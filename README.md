# Warplet - Self-Hosted Link Shortener

**This is yours to edit, not just configure.**

## Features

- Custom or random short codes, tags, and expiring links
- Password-protected links (hashed)
- Per-link click analytics - 14-day chart, top referrers, countries, device types
- QR codes generated straight from the dashboard
- Multiple domains, with the admin dashboard restricted to your main one (see [Multiple domains](#multiple-domains))
- Zero dependencies
- Single JSON file storage

## How it works

| File | Purpose |
|---|---|
| `server.js` | The application. |
| `store.js` | JSON-file storage layer. |
| `package.json` | Marks this as an ES module project; no dependencies. |
| `warplet.service` | systemd unit template. Ships with a placeholder token, never a real one. |
| `install.sh` | One-command installer (below). |
| `.gitignore` | Keeps your live `data/` folder out of git. |

`data/links.json` — your link database

## Quick install (recommended)

On a Raspberry Pi or any systemd-based Linux box with SSH access:

```bash
curl -fsSL https://raw.githubusercontent.com/pipchell/WarpletPublic/main/install.sh | bash
```

This installs Node.js if missing, clones the repo, generates a random access token, writes the systemd service, and starts Warplet running permanently in the background. At the end it prints your dashboard URL and access token. The access token is also written to `.access_token.txt` in the install directory as a fallback.

Re-running the command later is safe. It pulls the latest code but won't touch an existing service or token.

Customize with environment variables before piping into `bash`:

| Variable | Default | Purpose |
|---|---|---|
| `WARPLET_REPO` | `https://github.com/pipchell/WarpletPublic.git` | Repo to clone |
| `WARPLET_DIR` | `$HOME/warplet` | Install location |
| `WARPLET_PORT` | `8787` | Listening port |

```bash
WARPLET_PORT=9000 curl -fsSL https://raw.githubusercontent.com/pipchell/WarpletPublic/main/install.sh | bash
```

### Doing it by hand

If you'd rather see every step: install Node 18+, `git clone` this repo, generate a token with `openssl rand -hex 32`, test it with `ACCESS_TOKEN=... node server.js`, then install it as a service:

```bash
sudo cp warplet.service /etc/systemd/system/warplet.service
sudo nano /etc/systemd/system/warplet.service   # set WorkingDirectory, ACCESS_TOKEN, DATA_FILE
sudo systemctl daemon-reload
sudo systemctl enable --now warplet.service
sudo systemctl status warplet                   # confirm it's running
```

## Configuration

All settings are environment variables, set on the command line or in `warplet.service`.

Useful service commands: `sudo systemctl status warplet`, `sudo systemctl restart warplet`, `journalctl -u warplet -f` (live logs).

### Generating an access token

`ACCESS_TOKEN` is your dashboard password. The [quick installer](#quick-install-recommended) generates one for you automatically and prints it at the end, so you only need to do this yourself if you're installing by hand or rotating an existing token.

```bash
openssl rand -hex 32
```

That prints a 64-character string — copy the whole thing. Where it goes depends on how you're running Warplet:

- **As a systemd service**: put it in `warplet.service` as `Environment=ACCESS_TOKEN=<the-string>`, then apply it with `sudo systemctl daemon-reload && sudo systemctl restart warplet`.
- **Running directly** (testing, not as a service): `ACCESS_TOKEN=<the-string> node server.js`.

To rotate a token later, generate a new one the same way, update it wherever it's currently set, restart the service, and the old token stops working immediately.

## Branding

Edit the `BRAND` object near the top of `server.js`:

```js
const BRAND = {
  name: 'Warplet',
  accent: '#902efe',
  logo: '/logo.png',
  wordmark: '/wordmark.png'
};
```

## Multiple domains

If you own more than one domain, point DNS for each at this server, then set:

```bash
Environment=DOMAINS=go.example.com,short.example.org
```

With 2+ domains configured, a domain picker appears when creating links, and the dashboard shows/filters by domain. **The dashboard and its management API (`/api/links*`) only respond on your first listed domain**. Every other domain (and any bare IP) gets a plain "not found. "Short-link redirects and the password-check page are unaffected and work identically on every configured domain. With zero or one domain set, nothing about this changes.

## API reference

Base URL is your server (e.g. `http://<pi-ip>:8787`). Pass the token as a `token` field, `?token=` query param, or `X-Token` header.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /` | — | Dashboard page (main domain only, see above) |
| `GET /api/links` | token | List all links |
| `POST /api/links` | token | Create a link — body: `{url, code?, tags?, domain?, expiresAt?, password?}` |
| `PUT /api/links/:code` | token | Update a link |
| `DELETE /api/links/:code` | token | Delete a link |
| `GET /api/links/:code/stats` | token | Per-link analytics |
| `POST /api/verify/:code` | — | Check a visitor-entered password (public) |
| `GET /:code` | — | The redirect itself (public, works on every domain) |

`password` fields store a SHA-256 hash, never the plaintext. `expiresAt` is a millisecond Unix timestamp. Full request/response shapes are in the code — each handler in `server.js` is short and readable.

## Exposing it outside your home network

- **Cloudflare Tunnel** (recommended) - See [Cloudflare's setup guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).
- **Port forward + Dynamic DNS + reverse proxy** — more manual; [Caddy](https://caddyserver.com/) gives free automatic HTTPS with a two-line config.

## Backups

```bash
cp /home/pi/warplet/data/links.json ~/warplet-backup-$(date +%F).json
```

Automate with `crontab -e`: `0 3 * * * cp /home/pi/warplet/data/links.json /home/pi/backups/warplet-$(date +\%F).json`. Restore by stopping the service, copying a backup over `data/links.json`, and starting it again.

## Updating

```bash
cd /home/pi/warplet && git pull && sudo systemctl restart warplet
```

Re-running `install.sh` does the same thing without touching your token. `data/links.json` is untouched by updates.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE` | Something's already on that port. `sudo lsof -i :8787`, or change `PORT`. |
| "Wrong token" | Typo, or you're pointed at a different instance. |
| Can't reach it from another device | Check `hostname -I`, `sudo systemctl status warplet`, and your firewall. |
| QR codes don't load | They're fetched from `api.qrserver.com` by your *browser*. |
| Country stats always "XX" | Expected unless you're behind a Cloudflare Tunnel, which adds the header that populates this. |

## Hardware notes

A Pi 4 (1GB+) is comfortable; even a Pi Zero 2 W can run it. Use Raspberry Pi OS Lite to keep RAM free. The data file rewrites on every click. A non-issue at personal scale, but consider a USB SSD over the SD card for heavier use or long-term peace of mind.

## Uninstalling

```bash
sudo systemctl stop warplet
sudo systemctl disable warplet
sudo rm /etc/systemd/system/warplet.service
sudo systemctl daemon-reload
rm -rf /home/pi/warplet   # deletes the app AND your link database — back up data/links.json first
```
