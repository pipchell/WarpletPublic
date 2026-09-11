# Warplet — Self-Hosted Link Shortener

A branded, feature-rich personal link shortener that runs entirely on your
own hardware — a Raspberry Pi, a home server, a NAS, an old laptop, whatever
you've got. No cloud account, no external database, no npm dependencies,
no build step. Just Node.js and a single JSON file.

This document covers everything: what the project is, how every file in it
works, how to install and run it, how to expose it to the internet safely,
how to back it up, and how to troubleshoot it when something goes wrong.

---

## Table of contents

1. [What this is](#what-this-is)
2. [Feature list](#feature-list)
3. [How it works (architecture)](#how-it-works-architecture)
4. [Project files](#project-files)
5. [Requirements](#requirements)
6. [Quick start](#quick-start)
7. [Full setup walkthrough](#full-setup-walkthrough)
8. [Configuration reference](#configuration-reference)
9. [Running as a systemd service](#running-as-a-systemd-service)
10. [Branding](#branding)
11. [Multiple domains](#multiple-domains)
12. [Using the dashboard](#using-the-dashboard)
13. [API reference](#api-reference)
14. [Data model](#data-model)
15. [Exposing it outside your home network](#exposing-it-outside-your-home-network)
16. [Security considerations](#security-considerations)
17. [Backups and disaster recovery](#backups-and-disaster-recovery)
18. [Updating](#updating)
19. [Troubleshooting](#troubleshooting)
20. [Hardware notes and performance](#hardware-notes-and-performance)
21. [Frequently asked questions](#frequently-asked-questions)
22. [Uninstalling](#uninstalling)

---

## What this is

Warplet is a single small web app that does two things:

- Visiting `https://your-domain/abc123` **redirects** you to whatever long
  URL you mapped `abc123` to.
- Visiting the root URL (`https://your-domain/`) shows a **password-gated
  dashboard** where you create, organize, and monitor those short links.

It was built to be the personal, self-owned alternative to services like
Bitly or TinyURL — you control the data, there's no usage-based pricing,
and it's small enough to understand top-to-bottom by reading one file.

A companion version of this same project also exists for Cloudflare
Workers (serverless, free tier, zero server maintenance). This README is
for the **self-hosted** edition specifically — the one you run yourself.

## Feature list

- **Custom or random short codes** — let the app generate one, or pick
  your own (`/resume`, `/wifi`, etc.).
- **Tags** — label links (`work`, `demo`, `family`) and filter the
  dashboard by tag with one click.
- **Expiring links** — set a date/time after which a link automatically
  stops redirecting and shows a "this link has expired" page instead.
- **Password-protected links** — require a password before a visitor is
  redirected. Passwords are never stored in plain text (see
  [Security considerations](#security-considerations)).
- **Click analytics per link** — a 14-day bar chart, plus top 5 referrers,
  top 5 countries, and a device breakdown (mobile / desktop / tablet).
- **QR codes** — generate a scannable QR code for any short link directly
  from the dashboard.
- **Multiple domains** — if you own more than one domain, assign each
  link to whichever one it should appear under, filter the dashboard by
  domain, and every copy/QR/link in the table automatically uses the
  right one.
- **Branded, dark-themed dashboard** — works well on both desktop and
  mobile browsers.
- **Zero dependencies** — no `npm install`, nothing to compile, nothing
  that can break on ARM/Raspberry Pi.
- **Single JSON file storage** — your entire link database is one file
  you can copy, inspect, or back up with a single `cp` command.

## How it works (architecture)

There is no framework, no build step, and no external database. The whole
app is two JavaScript files:

- **`server.js`** — a plain Node.js HTTP server. It serves the dashboard
  HTML, exposes a small JSON API, and handles the actual `/:code`
  redirects. All of the dashboard's HTML, CSS, and client-side JavaScript
  live inside this one file as template strings — there's no separate
  frontend build.
- **`store.js`** — a minimal storage layer. On startup it reads
  `data/links.json` into memory as a plain JavaScript object. Every time a
  link is created, updated (e.g. a click increments its counter), or
  deleted, the entire object is serialized back to disk as JSON, written
  to a temporary file, and atomically renamed into place — so a crash or
  power loss mid-write can't corrupt your data file.

Because everything lives in memory and is just a JSON object, there is no
database server to install, configure, or keep running — which is exactly
what makes this practical on something as small as a Raspberry Pi.

Request flow for a redirect (`GET /abc123`):

```
Browser  →  server.js (matches /:code route)
              → store.get("abc123")
              → checks: expired? password-protected?
              → if clear: records the click (day/referrer/country/device)
              → responds with an HTTP 302 redirect
```

Request flow for the dashboard creating a link (`POST /api/links`):

```
Browser  →  server.js
              → checks ACCESS_TOKEN
              → validates the URL and custom code (if any)
              → hashes the password (if one was set) with SHA-256
              → store.put(code, { url, tags, expiresAt, password, ... })
              → responds with the new short code
```

## Project files

| File              | Purpose |
|-------------------|---------|
| `server.js`       | The entire application: HTTP server, dashboard HTML/CSS/JS, API routes, redirect logic. This is the file you'll edit to rebrand or change behavior. |
| `store.js`        | The JSON-file storage layer described above. You generally won't need to touch this. |
| `package.json`    | Declares this as a Node ES module project (`"type": "module"`) and documents the minimum Node version. No dependencies are listed because there are none. |
| `warplet.service`   | A `systemd` unit file template so the server starts automatically on boot and restarts itself if it ever crashes. |
| `README.md`       | This file. |

You will also end up with a `data/` folder once you first run the server
— that's created automatically and holds `links.json`, your link
database. It is *not* included in this download because it starts empty.

## Requirements

- **Node.js 18 or newer.** Check your version with:
  ```bash
  node --version
  ```
  If it's missing or older than 18, install a current LTS release. On
  Raspberry Pi OS / Debian / Ubuntu, the version in `apt` is sometimes
  older than what you want — the
  [NodeSource distributions](https://github.com/nodesource/distributions)
  or [nvm](https://github.com/nvm-sh/nvm) are the easiest ways to get a
  current version.
- **Any machine that can stay on** — a Raspberry Pi, an old laptop, a NAS
  that supports running Node, a home server, a spare mini PC. See
  [Hardware notes](#hardware-notes-and-performance) for sizing guidance.
- **No other software required.** No database, no reverse proxy, no
  Docker — those are all optional extras covered later in this document,
  not requirements.

## Quick start

If you just want to see it running right now:

```bash
cd warplet                      # the folder containing server.js
ACCESS_TOKEN=$(openssl rand -hex 24) node server.js
```

The command above generates a random access token on the fly and prints
nothing — copy it from your shell history if you need it again, or just
set a fixed one instead (recommended, see below). Then visit:

```
http://localhost:8787
```

from a browser on the same machine, or `http://<device-ip>:8787` from
another device on your network. Enter your access token when prompted.

For anything beyond "just trying it out," continue to the full walkthrough
below — in particular you'll want a **fixed** access token and a way for
the server to **survive reboots**.

## Full setup walkthrough

This section assumes a fresh Raspberry Pi, but applies equally to any
Linux home server — just skip the Pi-specific imaging step.

### 1. Prepare the machine (Raspberry Pi only)

If you're starting from a completely bare Pi:

1. Download the [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
2. Flash **Raspberry Pi OS Lite (64-bit)** — the *Lite* version skips the
   desktop environment, which leaves more RAM free for your apps. This
   matters more on a 1GB Pi 4 than on higher-RAM models, but it's a good
   default regardless.
3. In the Imager's advanced options (the gear icon), you can pre-configure
   Wi-Fi, hostname, and SSH access so the Pi is reachable headlessly on
   first boot — no monitor or keyboard needed.
4. Boot the Pi and SSH in: `ssh pi@<pi-ip-or-hostname>`.

### 2. Install Node.js

Check what's already available:
```bash
node --version
```
If it's missing or below v18, install a current LTS build via NodeSource:
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # confirm it's 18+
```

### 3. Copy the project onto the machine

Any of these work — pick whichever is easiest for you:
```bash
# Option A: scp from your computer
scp -r ./warplet pi@<pi-ip>:/home/pi/warplet

# Option B: git, if you've pushed this to a repo you control
git clone <your-repo-url> /home/pi/warplet

# Option C: a USB drive, copied over manually
```

### 4. Generate an access token

This token is your dashboard password — it gates creating, listing, and
deleting links (not visiting them; redirects are always public, that's
the point of a short link). Generate a long, random one:
```bash
openssl rand -hex 32
```
Save this somewhere safe (a password manager is ideal) — you'll need it
every time you log into the dashboard, and you'll paste it into the
service file in the next step.

### 5. Do a test run

```bash
cd /home/pi/warplet
ACCESS_TOKEN=paste-your-generated-token-here node server.js
```
You should see:
```
🔗 Warplet listening on http://localhost:8787
Data file: ./data/links.json
```
From another device on the same network, visit `http://<pi-ip>:8787`,
paste in your token, and confirm the dashboard loads. Press `Ctrl+C` to
stop this test run before moving on — the next step sets it up to run
permanently in the background.

### 6. Install it as a systemd service (auto-start on boot)

```bash
sudo cp warplet.service /etc/systemd/system/warplet.service
sudo nano /etc/systemd/system/warplet.service
```
Inside the editor, update:
- `WorkingDirectory=` to wherever you copied the project (e.g.
  `/home/pi/warplet`)
- `Environment=ACCESS_TOKEN=...` to the token you generated in step 4
- `Environment=DATA_FILE=...` to match your working directory, e.g.
  `/home/pi/warplet/data/links.json`

Save and exit (in `nano`: `Ctrl+O`, Enter, `Ctrl+X`), then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now warplet.service
```
`enable` makes it start on every boot; `--now` also starts it immediately.

### 7. Confirm it's running correctly

```bash
sudo systemctl status warplet
```
Look for `Active: active (running)` in green. To watch live logs:
```bash
journalctl -u warplet -f
```
(`Ctrl+C` to stop watching — this doesn't stop the service itself.)

You're done with core setup. The dashboard is now reachable at
`http://<pi-ip>:8787` from any device on your home network, permanently,
surviving reboots. The [next section](#exposing-it-outside-your-home-network)
covers reaching it from *outside* your home network, which is optional.

## Configuration reference

All configuration is via environment variables, set either directly on
the command line or inside `warplet.service`.

| Variable       | Required | Default              | Description |
|----------------|----------|-----------------------|--------------|
| `ACCESS_TOKEN` | **Yes**  | *(none — app refuses to start without it)* | The dashboard password. Also required as a `token` field/query-param on every write API call. |
| `PORT`         | No       | `8787`                | TCP port the HTTP server listens on. |
| `DATA_FILE`    | No       | `./data/links.json`   | Path to the JSON file where links are stored. The containing folder is created automatically if it doesn't exist. |
| `DOMAINS`      | No       | *(none — single-domain mode)* | Comma-separated list of domains for branded multi-domain short links, e.g. `go.example.com,short.example.org`. See [Multiple domains](#multiple-domains). |

Example setting all three explicitly:
```bash
ACCESS_TOKEN=abc123... PORT=9000 DATA_FILE=/mnt/storage/warplet/links.json node server.js
```

## Running as a systemd service

The provided `warplet.service` file is a standard systemd unit. Here's what
each line does, in case you want to customize it further:

```ini
[Unit]
Description=Warplet link shortener      # Shown in `systemctl status`
After=network.target                  # Wait for networking before starting

[Service]
Type=simple                           # The process itself is the service (no forking)
WorkingDirectory=/home/pi/warplet       # Where `node server.js` runs from
ExecStart=/usr/bin/node server.js     # The actual start command
Restart=on-failure                    # Auto-restart if it crashes
RestartSec=5                          # Wait 5s before restarting

Environment=ACCESS_TOKEN=...          # Your dashboard password
Environment=PORT=8787                 # Listening port
Environment=DATA_FILE=...             # Path to your links database

[Install]
WantedBy=multi-user.target            # Start at normal boot time
```

Useful commands once it's installed:

| Command | Effect |
|---|---|
| `sudo systemctl status warplet` | Check whether it's running |
| `sudo systemctl restart warplet` | Restart it (e.g. after editing `server.js`) |
| `sudo systemctl stop warplet` | Stop it |
| `sudo systemctl disable warplet` | Stop it from starting on future boots |
| `journalctl -u warplet -f` | Follow live logs |
| `journalctl -u warplet --since today` | See today's logs |

If `ExecStart=/usr/bin/node server.js` doesn't work because Node is
installed somewhere else, find its actual path with `which node` and
update that line accordingly.

## Branding

Open `server.js` and find the `BRAND` object near the top of the file:

```js
const BRAND = {
  name: 'Warplet',
  accent: '#4696e5',
  logo: '/favicon.png'
};
```

| Field | What it controls |
|---|---|
| `name` | Shown in the dashboard header, browser tab title, and every branded page (404, expired-link, password-gate pages). |
| `accent` | Any CSS hex color. Used for buttons, links, chart bars, and highlights throughout the dashboard and all branded pages. |
| `logo` | Image path used for the dashboard logo and favicon. The default is `/favicon.png`. |

After editing, restart the service for changes to take effect:
```bash
sudo systemctl restart warplet
```
There is no build step — editing this object and restarting is the
entire rebranding process.

## Multiple domains

If you own more than one domain — say a short, punchy one for public
sharing and your normal one for internal links — Warplet can serve short
links branded under any of them from this same single server and single
link database.

### Setting it up

1. Point DNS for each domain at this server (directly, or via one of the
   [exposure options](#exposing-it-outside-your-home-network) below — a
   Cloudflare Tunnel can carry several hostnames to the same local port,
   and a reverse proxy like Caddy can do the same).
2. Set the `DOMAINS` environment variable to a comma-separated list:
   ```bash
   DOMAINS=go.example.com,short.example.org
   ```
   or, in `warplet.service`:
   ```ini
   Environment=DOMAINS=go.example.com,short.example.org
   ```
3. Restart: `sudo systemctl restart warplet`.

With **zero or one** domain configured, nothing changes — no domain
picker appears anywhere, and the dashboard behaves exactly as it did
before this feature existed. The picker and filter only appear once
**two or more** domains are configured, since below that there's nothing
to choose between.

### How it behaves

- **Creating a link**: once 2+ domains are configured, a domain dropdown
  appears in "More options," defaulting to the first domain in your
  `DOMAINS` list. Pick whichever domain that link should live under.
- **The link table**: each link displays and links to its actual assigned
  domain (e.g. `short.example.org/abc123`), not just whatever domain
  you're currently viewing the dashboard from.
- **Copy / QR / stats**: all automatically use the correct per-link
  domain.
- **Filtering**: a row of domain pills appears above the link table
  (alongside the tag filter) so you can view just the links on one
  domain.
- **Redirects are not domain-restricted.** A short code works the same
  regardless of which of your domains (or even an IP address) is used to
  reach the server — the `domain` field is for display and organization,
  not access control. Every code is globally unique across all domains,
  the same as in single-domain mode.
- **Links created before you set up `DOMAINS`** (or before this feature
  existed) simply have no assigned domain and keep working exactly as
  before — they display using whatever domain/address you're currently
  browsing the dashboard from.

## Using the dashboard

### Logging in
Visit your server's URL and enter your `ACCESS_TOKEN`. It's saved in your
browser's local storage so you won't need to re-enter it every visit on
that device/browser.

### The overview cards
Three stat cards across the top show: total number of links, total clicks
across all of them, and how many links are currently active (not
expired).

### Creating a link
1. Paste the destination URL into the first field.
2. Optionally give it a custom code (letters, numbers, `-`, and `_` only).
   Leave it blank to get a random 4-character code.
3. If the URL does not start with `http://` or `https://`, the app defaults it to `http://` automatically. Sites that support HTTPS can then redirect to their HTTPS version.
4. Click **"More options"** to reveal:
   - **Tags** — comma-separated (e.g. `work, client-x`).
   - **Expiration** — a date/time picker. After this passes, the link
     stops redirecting and shows a branded "expired" page instead.
   - **Domain** — only shown if you've configured 2+ domains (see
     [Multiple domains](#multiple-domains)); picks which domain this
     link's short URL uses.
   - **Password** — if set, visitors must enter this password before
     being redirected.
5. Click **Shorten it**. Pressing Enter in the URL or custom-code field does the same thing.

### The link table
Each row shows the short code, destination (truncated with a hover
tooltip for the full URL), status badges, click count, and action
buttons. If you have 2+ domains configured, the code column shows the
full `domain/code` for that link rather than just the bare code, since
which domain it's on is no longer implied by the page you're viewing.

- **Copy** — copies the full short URL to your clipboard.
- **QR** — opens a modal with a scannable QR code for that link. The QR
  encodes the *short* URL (not the destination), so scanning it and then
  visiting it behaves exactly like clicking the short link.
- **Stats** — opens a modal with:
  - A 14-day bar chart of clicks (hover a bar to see the exact date and
    count).
  - Top 5 referring domains.
  - Top 5 visitor countries (only populated if country data is available
    — see the [API reference](#api-reference) note on the `CF-IPCountry`
    header).
  - A breakdown of clicks by device type.
- **Edit** — loads the existing link into the form so you can update it.
- **Delete** — permanently removes the link (with a confirmation prompt).

### Status badges
- **active** (green) — working normally.
- **expired** (red) — past its expiration date; visitors see the expired
  page instead of being redirected.
- **locked** (yellow) — password-protected; visitors see a password
  prompt before being redirected.

### Filtering by tag
Once any link has a tag, pill buttons appear above the table. Click one
to filter the table to just that tag; click **All** to clear the filter.

### Filtering by domain
If you have 2+ domains configured, a second row of pills appears (one
per configured domain, plus "All domains") so you can view just the
links assigned to one domain. See [Multiple domains](#multiple-domains).

## API reference

All endpoints are relative to your server's base URL (e.g.
`http://<pi-ip>:8787`). All request/response bodies are JSON unless
noted otherwise.

Authentication: pass your access token as **either** a `token` field in
a JSON request body, a `?token=...` query parameter, or an `X-Token`
request header. The dashboard itself uses the query-parameter/body form.

---

**`GET /`**
Returns the dashboard HTML. No authentication needed to *load* the page
— the page itself prompts for the token before it will call any API
below.

---

**`GET /api/links`** — list all links
_Requires token._
```
GET /api/links?token=YOUR_TOKEN
```
Response `200`:
```json
[
  {
    "code": "abc123",
    "url": "https://example.com/some/long/path",
    "tags": ["work", "demo"],
    "domain": "go.example.com",
    "clicks": 42,
    "created": 1735689600000,
    "expiresAt": null,
    "expired": false,
    "hasPassword": false
  }
]
```
Response `401` if the token is missing or wrong.

---

**`POST /api/links`** — create a link
_Requires token._
```json
{
  "url": "https://example.com/destination",
  "code": "optional-custom-code",
  "tags": ["work", "demo"],
  "domain": "go.example.com",
  "expiresAt": 1735689600000,
  "password": "optional-plaintext-password",
  "token": "YOUR_TOKEN"
}
```
Only `url` and `token` are required — everything else may be omitted.
`expiresAt` is a Unix timestamp in **milliseconds**, or `null`/omitted
for no expiration. `domain` only matters if you've configured `DOMAINS`
(see [Multiple domains](#multiple-domains)): if omitted there, it
defaults to the first domain in your `DOMAINS` list; if provided, it
must be one of the configured domains or the request is rejected. With
no `DOMAINS` configured, `domain` is optional and only lightly validated
as a plausible hostname.

Response `200`:
```json
{ "code": "abc123", "url": "https://example.com/destination", "domain": "go.example.com" }
```
Response `400` — invalid URL, invalid custom code format, or (with
`DOMAINS` configured) a `domain` that isn't in the configured list.
Response `401` — bad/missing token.
Response `409` — the requested custom code is already taken.

---

**`GET /api/links/:code/stats`** — analytics for one link
_Requires token._
```
GET /api/links/abc123/stats?token=YOUR_TOKEN
```
Response `200`:
```json
{
  "byDay": { "2026-08-20": 3, "2026-08-21": 7 },
  "referrers": { "google.com": 5, "direct": 12 },
  "countries": { "US": 10, "GB": 2 },
  "devices": { "mobile": 6, "desktop": 8, "tablet": 0, "other": 0 }
}
```
Response `404` if the code doesn't exist.

---

**`DELETE /api/links/:code`** — delete a link
_Requires token._
```
DELETE /api/links/abc123?token=YOUR_TOKEN
```
Response `200`:
```json
{ "deleted": "abc123" }
```

---

**`POST /api/verify/:code`** — check a password for a protected link
_No token required_ — this is called by the public password-gate page
that visitors see, not the dashboard.
```json
{ "password": "the-visitor-entered-password" }
```
Response `200` on correct password:
```json
{ "url": "https://example.com/destination" }
```
(the client-side password page then redirects the browser to this URL)
Response `403` — incorrect password.
Response `404` — code doesn't exist.
Response `410` — link has expired (checked before the password, so an
expired-and-locked link always shows as expired).

---

**`GET /:code`** — the actual redirect
_No token required — this is the public-facing short link itself._
- `302` redirect to the destination URL, if the link is active and has
  no password.
- `200` with an HTML password-entry page, if the link is
  password-protected (and not expired).
- `410` with a branded "expired" HTML page, if past `expiresAt`.
- `404` with a branded "not found" HTML page, if the code doesn't exist.

## Data model

Each link is stored as one JSON object, keyed by its short code, inside
`data/links.json`:

```json
{
  "abc123": {
    "url": "https://example.com/destination",
    "created": 1735689600000,
    "clicks": 42,
    "tags": ["work", "demo"],
    "domain": "go.example.com",
    "expiresAt": null,
    "password": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "stats": {
      "byDay": { "2026-08-20": 3 },
      "referrers": { "direct": 12 },
      "countries": { "US": 10 },
      "devices": { "mobile": 6, "desktop": 8, "tablet": 0, "other": 0 }
    }
  }
}
```

Notes:
- `domain` is `null` unless you've configured `DOMAINS` — see
  [Multiple domains](#multiple-domains). Links created before this
  feature existed simply have no `domain` field, and that's fine.
- `password` is a SHA-256 hex hash, never the plaintext password.
- `stats.byDay` keeps at most the most recent 60 days per link (older
  buckets are pruned automatically) so the file can't grow unbounded.
- `stats.referrers` and `stats.countries` each cap at 25 entries; when a
  new one would exceed that, the entry with the *lowest* count is dropped
  first.
- The whole file is rewritten on every single change (create, click,
  delete). At personal-project scale — even thousands of links — this is
  fast and not something you need to worry about.

Because it's plain JSON, you can inspect or even hand-edit it (while the
server is stopped) with any text editor if you ever need to.

## Exposing it outside your home network

By default, Warplet is only reachable on your home network. If you want to
use your short links from outside (e.g. sharing them publicly, or using
them from your phone on cellular data), here are three options, roughly
easiest to most involved.

If you're setting this up for [multiple domains](#multiple-domains),
all of them need to end up pointing at this same server — both Option A
and Option B below support routing several hostnames to one backend.

### Option A — Cloudflare Tunnel (recommended)

Free, gives you a real domain with automatic HTTPS, and needs **no port
forwarding, no static IP, and no router configuration at all.**

1. Create a free Cloudflare account and add a domain (or use a subdomain
   of one you already manage there).
2. Install `cloudflared` on the Pi:
   ```bash
   curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
   sudo dpkg -i cloudflared.deb
   ```
   (use the `arm` build instead of `arm64` if you're on a 32-bit OS)
3. Authenticate and create a tunnel:
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create warplet
   ```
4. Point the tunnel at your local server and route a hostname to it —
   full step-by-step instructions:
   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
5. Once routed, `https://go.yourdomain.com` (or whatever hostname you
   chose) reaches your Pi securely.

Bonus: traffic through a Cloudflare Tunnel includes a `CF-IPCountry`
header, so the **country stats in your analytics keep working** — same
as they would on the Cloudflare-hosted version of this project.

### Option B — Port forward + Dynamic DNS + reverse proxy

More manual, but doesn't require a Cloudflare account:

1. In your router's admin panel, forward an external port (e.g. 443) to
   your Pi's local IP on port 8787 (or better, to a reverse proxy — see
   step 3).
2. If your home internet doesn't have a static IP, sign up for a dynamic
   DNS service (DuckDNS and No-IP both have free tiers) and run their
   update client on the Pi so your hostname always points at your current
   IP.
3. Install a reverse proxy for free automatic HTTPS —
   [Caddy](https://caddyserver.com/) is the simplest option. A minimal
   `Caddyfile`:
   ```
   go.yourdomain.com {
       reverse_proxy localhost:8787
   }
   ```
   Caddy handles obtaining and renewing the TLS certificate automatically.
4. Consider giving your Pi a static local IP (via a DHCP reservation in
   your router) so the port-forward rule doesn't break if its address
   changes.

### Option C — Home network only

If you mainly want short links for your own devices while at home, you
don't need public access at all. `http://<pi-ip>:8787` (or a local
hostname like `http://warplet.local:8787` if you set up mDNS/Avahi) works
fine as-is, with zero additional setup.

## Security considerations

- **The access token is a shared secret, treat it like a password.**
  Generate it with `openssl rand -hex 32` or similar — don't use anything
  guessable. Anyone with this token can create, list, and delete your
  links.
- **Short link redirects are public by design.** Visiting `/abc123`
  doesn't require the access token — that's what makes it a *usable*
  short link. If a link's destination is sensitive, use the built-in
  password-protection feature for that specific link.
- **Passwords are hashed, not encrypted.** Link passwords are stored as
  SHA-256 hashes, so the plaintext password is never written to disk.
  SHA-256 alone (without a per-link salt or a slow KDF like bcrypt/scrypt)
  is adequate here because these are low-stakes, per-link access codes —
  not account credentials — but don't reuse an important password for a
  link's password field.
- **Use HTTPS if you expose this beyond your home network.** Both
  exposure options above (Cloudflare Tunnel, Caddy) give you free,
  automatic HTTPS — use one of them rather than exposing plain HTTP
  directly to the internet, so your access token isn't sent in the clear.
- **No rate limiting is built in.** For personal use behind a private
  token this is a reasonable tradeoff for simplicity, but if you expose
  this publicly, be aware the `/api/verify/:code` endpoint (password
  checking) has no attempt-limiting. A reverse proxy like Caddy or
  nginx can add basic rate limiting in front of it if you want that extra
  layer.
- **Keep Node.js reasonably current** on whatever machine you're running
  this on, for general platform security patches — this project has no
  dependencies to worry about, so Node itself is the only thing to keep
  updated.

## Backups and disaster recovery

Your entire link database is the single file at `DATA_FILE`
(default `data/links.json`). Backing it up is one command:

```bash
cp /home/pi/warplet/data/links.json ~/warplet-backup-$(date +%F).json
```

**Automating nightly backups with cron:**
```bash
crontab -e
```
Add a line like:
```
0 3 * * * cp /home/pi/warplet/data/links.json /home/pi/backups/warplet-$(date +\%F).json
```
This copies the database every night at 3 AM. Consider also periodically
copying these backups off the Pi itself (to another machine, a USB drive,
or cloud storage) in case the SD card or the whole device fails.

**Restoring from a backup:**
```bash
sudo systemctl stop warplet
cp ~/warplet-backup-2026-08-30.json /home/pi/warplet/data/links.json
sudo systemctl start warplet
```

## Updating

Since there's no build step and no dependencies to update, "updating"
just means changing `server.js` (or replacing it with a newer version)
and restarting:

```bash
sudo systemctl restart warplet
```

If you're pulling changes from a git repo:
```bash
cd /home/pi/warplet
git pull
sudo systemctl restart warplet
```

Your `data/links.json` is untouched by any of this — links, clicks, and
analytics all persist across updates.

## Troubleshooting

| Symptom | Likely cause & fix |
|---|---|
| `Missing ACCESS_TOKEN environment variable` on startup | You started the server without setting `ACCESS_TOKEN`. Set it directly (`ACCESS_TOKEN=... node server.js`) or check the `Environment=` line in `warplet.service` if running as a service. |
| `Error: listen EADDRINUSE` | Something else (possibly a previous instance of this same server) is already using that port. Find it with `sudo lsof -i :8787` and stop it, or set a different `PORT`. |
| Dashboard loads but says "Wrong token" | The token you typed doesn't match `ACCESS_TOKEN` on the server. Double check for typos/extra spaces, and confirm you're pointed at the right server if you run more than one instance. |
| Changes to `server.js` don't seem to take effect | You need to restart the process after editing: `sudo systemctl restart warplet` (or re-run `node server.js` if running it manually). |
| Service won't start / `systemctl status` shows "failed" | Check `journalctl -u warplet -n 50` for the actual error. Common causes: wrong path in `ExecStart`, wrong `WorkingDirectory`, or Node not installed at the path systemd expects (`which node` to check). |
| Can't reach it from another device on the network | Confirm the Pi's IP with `hostname -I`, confirm the server is actually running (`sudo systemctl status warplet`), and check your Pi's firewall (`sudo ufw status` if UFW is installed) isn't blocking the port. |
| Links disappear after a restart | Check that `DATA_FILE` points to a persistent location and that the service has permission to write there. Look at server logs — a JSON parse error on a corrupted file falls back to an empty store and logs a warning. |
| QR codes don't load | QR generation calls out to `api.qrserver.com` from your *browser* (not the server) — if that device has no internet access, or that specific service is unreachable, the QR image won't load. Everything else in the dashboard still works offline on your local network. |
| Country stats are always "XX" | This is expected unless you're behind a Cloudflare Tunnel (see [Exposing it outside your home network](#exposing-it-outside-your-home-network)), which adds the `CF-IPCountry` header automatically. Plain home-network or port-forwarded access has no geolocation data available. |

## Hardware notes and performance

- **Raspberry Pi 4 (1GB RAM) or better is plenty** for personal use. The
  app's idle memory footprint is roughly 40-60MB; even a Pi Zero 2 W can
  technically run it, though a Pi 4 gives more comfortable headroom.
- Use **Raspberry Pi OS Lite** (no desktop environment) to keep the most
  RAM free for the app.
- **SD card wear**: the storage layer rewrites the entire data file on
  every click, which is more write activity than a typical read-mostly
  site. At personal-project traffic levels (a handful to a few hundred
  clicks a day) this is a non-issue over the card's lifetime. If you want
  extra long-term peace of mind, or plan on heavier traffic, booting from
  a USB SSD instead of the SD card (natively supported on Pi 4) is a
  cheap, easy upgrade.
- **Don't co-host many other heavy services** on a 1GB device — this app
  alone is lightweight, but a database server, media server, or other
  Docker containers running alongside it will compete for that same 1GB.
- There is no theoretical limit on link count from the app's design, but
  since the whole file is loaded into memory and rewritten on each
  change, tens of thousands of links would start to notice slower writes.
  For personal use (tens to low thousands of links) this is a total
  non-issue.

## Frequently asked questions

**Can I run more than one instance (e.g. one for personal, one for
work links)?**
Yes — run two copies with different `PORT` and `DATA_FILE` values (and
ideally different `ACCESS_TOKEN`s), each as its own systemd service.

**Can multiple people use the same instance?**
The dashboard uses a single shared access token, not individual user
accounts — so it's designed for one person (or a small group who all
trust each other with the same token), not multi-tenant use with
separate permissions.

**What happens if the Pi loses power mid-write?**
The store writes to a temporary file and atomically renames it into
place, so a power loss can't leave `links.json` half-written or
corrupted — you'll either have the state from just before the crash, or
(rarely) lose only the single in-flight write.

**Can I move this to a different machine later?**
Yes — copy the whole project folder (including `data/links.json`) to the
new machine, install Node, and start it the same way. Nothing is tied to
the specific hardware.

**Does this work without an internet connection?**
Yes, for anything on your local network — creating links, the dashboard,
redirects, and analytics all work fully offline. The one exception is QR
code images, which are fetched from a public QR-generation API by your
browser when you open the QR modal.

## Uninstalling

```bash
sudo systemctl stop warplet
sudo systemctl disable warplet
sudo rm /etc/systemd/system/warplet.service
sudo systemctl daemon-reload
rm -rf /home/pi/warplet          # deletes the app AND your link database — back up data/links.json first if you want to keep it
```

If you use the default branding, place the `favicon.png` image in the same directory as `server.js`; it is served by the app for both the favicon and on-page logo.
