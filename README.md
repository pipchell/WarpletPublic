# Warplet — Self-Hosted Link Shortener

A branded personal link shortener that runs entirely on your own hardware
— a Raspberry Pi, a home server, a NAS, an old laptop. No cloud account,
no external database, no npm dependencies, no build step. Just Node.js
and a single JSON file.

**This is yours to edit, not just configure.** `server.js` is one plain
file with no build step, so open it, read it, and change whatever you
want — the `BRAND` object below covers the common cosmetic tweaks, but
nothing stops you from going further.

## Features

- Custom or random short codes, tags, and expiring links
- Password-protected links (hashed, never stored in plain text)
- Per-link click analytics — 14-day chart, top referrers, countries, device types
- QR codes generated straight from the dashboard
- Multiple domains, with the admin dashboard restricted to your main one (see [Multiple domains](#multiple-domains))
- Zero dependencies, single JSON file storage, dark-themed dashboard

## How it works

Two plain JavaScript files, no framework:

- **`server.js`** — the whole app: HTTP server, dashboard HTML/CSS/JS (as template strings), API routes, redirect logic. This is the file you edit to rebrand or change behavior.
- **`store.js`** — reads `data/links.json` into memory on startup; every change is written to a temp file and atomically renamed into place, so a crash mid-write can't corrupt your data.

| File | Purpose |
|---|---|
| `server.js` | The application. |
| `store.js` | JSON-file storage layer. |
| `package.json` | Marks this as an ES module project; no dependencies. |
| `warplet.service` | systemd unit template — ships with a placeholder token, never a real one. |
| `install.sh` | One-command installer (below). |
| `.gitignore` | Keeps your live `data/` folder out of git. |

`data/links.json` — your link database — is created on first run and is git-ignored on purpose: it's your data, not part of the app.

## Requirements

Node.js 18+ (the installer gets this for you) and any machine that can stay powered on. No database, reverse proxy, or Docker required.

## Quick install (recommended)

On a Raspberry Pi or any systemd-based Linux box with SSH access:

```bash
curl -fsSL https://raw.githubusercontent.com/pipchell/WarpletPublic/main/install.sh | bash
```

This installs Node.js if missing, clones the repo, generates a random access token, writes the systemd service, and starts Warplet running permanently in the background. At the end it prints your dashboard URL and access token — **save the token to a password manager immediately.** It's also written to `.access_token.txt` in the install directory (restricted permissions) as a fallback; delete that file once you've saved the token elsewhere.

Re-running the command later is safe — it pulls the latest code but won't touch an existing service or token.

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

**Never commit a real token or your `data/` folder** — `warplet.service` in this repo is a template for exactly this reason, and `.gitignore` excludes `data/`.

## Configuration

All settings are environment variables, set on the command line or in `warplet.service`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ACCESS_TOKEN` | Yes | *(none)* | Dashboard password; also required on every write API call. |
| `PORT` | No | `8787` | HTTP port. |
| `DATA_FILE` | No | `./data/links.json` | Where links are stored. |
| `DOMAINS` | No | *(single-domain mode)* | Comma-separated domains for branded multi-domain links. |

Useful service commands: `sudo systemctl status warplet`, `sudo systemctl restart warplet`, `journalctl -u warplet -f` (live logs).

### Generating an access token

`ACCESS_TOKEN` is your dashboard password — it gates creating, listing, editing, and deleting links (not visiting them; redirects are always public, that's the point of a short link). The [quick installer](#quick-install-recommended) generates one for you automatically and prints it at the end, so you only need to do this yourself if you're installing by hand or rotating an existing token.

Generate a long, random one:

```bash
openssl rand -hex 32
```

That prints a 64-character string — copy the whole thing. Where it goes depends on how you're running Warplet:

- **As a systemd service**: put it in `warplet.service` as `Environment=ACCESS_TOKEN=<the-string>`, then apply it with `sudo systemctl daemon-reload && sudo systemctl restart warplet`.
- **Running directly** (testing, not as a service): `ACCESS_TOKEN=<the-string> node server.js`.

Save the token itself somewhere durable — a password manager, not a note file next to the project — since it's also what you'll type into the dashboard's login screen on every new browser/device. **Never paste a real token into `warplet.service` and commit that file to git**: the copy in this repo is a placeholder for exactly that reason.

To rotate a token later (e.g. if you suspect it leaked), generate a new one the same way, update it wherever it's currently set, restart the service, and the old token stops working immediately — there's no separate revoke step needed since the server only ever compares against whatever `ACCESS_TOKEN` currently holds.

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

`name` shows in the header, tab title, and every branded page. `accent` is any CSS hex color, used throughout the dashboard. `logo` is the small square icon on the login/password pages; `wordmark` is the wider logo shown in the dashboard header — both are plain image files in the project root, so replace the file to change the image, or point the field at a different filename. The browser tab favicon is separate: it's always served from `favicon.ico` in the project root (a real multi-resolution icon, not derived from `logo`/`wordmark`), regardless of what those two point to — swap that file to change it. Restart the service after editing — there's no build step. The whole dashboard's HTML/CSS/JS lives as template strings just below this object, so anything beyond these fields is a normal JavaScript edit away.

## Multiple domains

If you own more than one domain, point DNS for each at this server, then set:

```bash
Environment=DOMAINS=go.example.com,short.example.org
```

With 2+ domains configured, a domain picker appears when creating links, and the dashboard shows/filters by domain. **The dashboard and its management API (`/api/links*`) only respond on your first listed domain** — every other domain (and any bare IP) gets a plain "not found," keeping the admin surface off vanity domains you hand out more freely. Short-link redirects and the password-check page are unaffected and work identically on every configured domain, since that's the whole point of a short link. With zero or one domain set, nothing about this changes.

## Using the dashboard

Visit your server and enter `ACCESS_TOKEN` (saved in browser local storage after that). Paste a URL, optionally set a custom code, tags, expiry, domain, or password under "More options," and click Shorten. Each link row has Copy, QR, Stats, Edit, and Delete actions, plus status badges: **active** / **expired** / **locked** (password-protected). Tag and domain pills above the table filter the list.

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

- **Cloudflare Tunnel** (recommended) — free, automatic HTTPS, no port forwarding or static IP needed. Also the only option that populates country stats (`CF-IPCountry` header). See [Cloudflare's setup guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).
- **Port forward + Dynamic DNS + reverse proxy** — more manual; [Caddy](https://caddyserver.com/) gives free automatic HTTPS with a two-line config.
- **Home network only** — `http://<pi-ip>:8787` works with zero setup if you don't need public access.

## Security considerations

- Treat `ACCESS_TOKEN` like a password — generate it with `openssl rand -hex 32`, never something guessable, and never commit it to git.
- If a real token ever ends up in a git history (yours or a fork), treat it as compromised: rotate it immediately and scrub the old commit — fixing the file going forward isn't enough, since the old value stays visible in past commits. For a small repo, deleting and recreating it is often simpler than rewriting history.
- Short-link redirects are public by design — that's what makes them usable links. Use the password feature for sensitive destinations.
- Use HTTPS (Cloudflare Tunnel or Caddy) if you expose this beyond your home network, so the token isn't sent in the clear.
- No built-in rate limiting — fine behind a private token, but be aware of it if you expose this publicly.

## Backups

```bash
cp /home/pi/warplet/data/links.json ~/warplet-backup-$(date +%F).json
```

Automate with `crontab -e`: `0 3 * * * cp /home/pi/warplet/data/links.json /home/pi/backups/warplet-$(date +\%F).json`. Restore by stopping the service, copying a backup over `data/links.json`, and starting it again. Keep backups private — they contain your real link data.

## Updating

```bash
cd /home/pi/warplet && git pull && sudo systemctl restart warplet
```

Re-running `install.sh` does the same thing without touching your token. `data/links.json` is untouched by updates.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing ACCESS_TOKEN` on startup | Set the env var, or check `warplet.service`. |
| `EADDRINUSE` | Something's already on that port — `sudo lsof -i :8787`, or change `PORT`. |
| "Wrong token" | Typo, or you're pointed at a different instance. |
| Service shows "failed" | `journalctl -u warplet -n 50` for the real error — usually a bad path or Node not where `ExecStart` expects (`which node`). |
| Can't reach it from another device | Check `hostname -I`, `sudo systemctl status warplet`, and your firewall. |
| QR codes don't load | They're fetched from `api.qrserver.com` by your *browser* — needs internet on that device. Everything else works offline on your LAN. |
| Country stats always "XX" | Expected unless you're behind a Cloudflare Tunnel, which adds the header that populates this. |

## Hardware notes

A Pi 4 (1GB+) is comfortable; even a Pi Zero 2 W can run it. Use Raspberry Pi OS Lite to keep RAM free. The data file rewrites on every click — a non-issue at personal scale, but consider a USB SSD over the SD card for heavier use or long-term peace of mind.

## FAQ

**Multiple instances?** Run separate `PORT`/`DATA_FILE`/`ACCESS_TOKEN` combos, each its own service.
**Multi-user?** One shared token, not per-user accounts — fine for you or a small group who trust each other with it.
**Power loss mid-write?** The atomic rename means you lose at most the single in-flight write, never a corrupted file.
**Offline?** Everything works on your LAN without internet, except QR code images (fetched by your browser).

## Uninstalling

```bash
sudo systemctl stop warplet
sudo systemctl disable warplet
sudo rm /etc/systemd/system/warplet.service
sudo systemctl daemon-reload
rm -rf /home/pi/warplet   # deletes the app AND your link database — back up data/links.json first
```
