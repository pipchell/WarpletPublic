#!/usr/bin/env node
// ============================================================
// Warplet — self-hosted version (plain Node.js, JSON file storage)
// ============================================================
// No dependencies beyond Node itself — safe to run on a Raspberry Pi
// without any native module compilation.
//
// Configure via environment variables (see README):
//   PORT          — defaults to 8787
//   ACCESS_TOKEN  — required, this is your dashboard password
//   DATA_FILE     — defaults to ./data/links.json
//   DOMAINS       — optional, comma-separated list of domains for branded
//                   short links (e.g. go.example.com,short.example.org).
//                   Leave unset for single-domain use — nothing changes.
//
// To rebrand: edit the BRAND object below.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createStore } from './store.js';

const BRAND = {
  name: 'Warplet',
  accent: '#902efe',
  logo: '/logo.png',
  wordmark: '/wordmark.png'
};

const PORT = Number(process.env.PORT) || 8787;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const DATA_FILE = process.env.DATA_FILE || './data/links.json';
const DOMAINS = (process.env.DOMAINS || '').split(',').map(d => d.trim()).filter(Boolean);

if (!ACCESS_TOKEN) {
  console.error('Missing ACCESS_TOKEN environment variable. Set one before starting, e.g.:');
  console.error('  ACCESS_TOKEN=your-long-random-token node server.js');
  process.exit(1);
}

const store = createStore(DATA_FILE);

const MAX_DAY_BUCKETS = 60;
const MAX_TRACKED_KEYS = 25;

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------

function randomCode(len = 4) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function checkToken(req, searchParams, body) {
  const provided = (body && body.token) || (searchParams && searchParams.get('token')) || req.headers['x-token'];
  return Boolean(provided) && provided === ACCESS_TOKEN;
}

// The dashboard itself (the page at "/" plus the token-authenticated
// /api/links* management endpoints) is only ever exposed on the first
// configured domain — the rest of DOMAINS, and short-link redirects on
// every domain, are unaffected. With DOMAINS unset, there's only one
// domain in play and nothing is restricted.
function requestHostname(req) {
  return String(req.headers.host || '').split(':')[0].toLowerCase();
}

function isDashboardRequestAllowed(req) {
  if (DOMAINS.length === 0) return true;
  return requestHostname(req) === DOMAINS[0].toLowerCase();
}

function passwordCookieValue(code) {
  return createHmac('sha256', ACCESS_TOKEN).update('warplet-password:' + code).digest('hex');
}

function hasPasswordCookie(req, code) {
  const cookies = String(req.headers.cookie || '').split(';').map(v => v.trim());
  const wanted = 'warplet_pw_' + code + '=' + passwordCookieValue(code);
  return cookies.includes(wanted);
}

async function validateTargetUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return false;

    // Reject incomplete hostnames such as http://google.
    if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') return false;

    // Confirm that the hostname actually resolves before creating the short link.
    return true;
  } catch {
    return false;
  }
}

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function isExpired(entry) {
  return Boolean(entry.expiresAt) && Date.now() > entry.expiresAt;
}

function deviceFromUA(ua) {
  ua = (ua || '').toLowerCase();
  if (/ipad|tablet/.test(ua)) return 'tablet';
  if (/mobile|iphone|android/.test(ua)) return 'mobile';
  if (ua) return 'desktop';
  return 'other';
}

function isValidDomainFormat(d) {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(d);
}

function refererDomain(referer) {
  if (!referer) return 'direct';
  try {
    return new URL(referer).hostname.replace(/^www\./, '');
  } catch {
    return 'direct';
  }
}

function pruneByCount(obj, maxKeys) {
  const keys = Object.keys(obj);
  if (keys.length <= maxKeys) return obj;
  const sorted = keys.sort((a, b) => obj[a] - obj[b]);
  const toRemove = sorted.slice(0, keys.length - maxKeys);
  toRemove.forEach(k => delete obj[k]);
  return obj;
}

function pruneDays(byDay, maxDays) {
  const keys = Object.keys(byDay);
  if (keys.length <= maxDays) return byDay;
  const sorted = keys.sort();
  const toRemove = sorted.slice(0, keys.length - maxDays);
  toRemove.forEach(k => delete byDay[k]);
  return byDay;
}

function emptyStats() {
  return {
    byDay: {},
    referrers: {},
    countries: {},
    devices: {
      mobile: 0,
      desktop: 0,
      tablet: 0,
      other: 0
    }
  };
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function recordHit(entry, req) {
  entry.clicks = (entry.clicks || 0) + 1;

  if (!entry.stats) entry.stats = emptyStats();

  const day = todayKey();
  entry.stats.byDay[day] = (entry.stats.byDay[day] || 0) + 1;
  pruneDays(entry.stats.byDay, MAX_DAY_BUCKETS);

  const ref = refererDomain(req.headers.referer);
  entry.stats.referrers[ref] = (entry.stats.referrers[ref] || 0) + 1;
  pruneByCount(entry.stats.referrers, MAX_TRACKED_KEYS);

  const country = req.headers['cf-ipcountry'] || req.headers['x-geo-country'] || 'XX';
  entry.stats.countries[country] = (entry.stats.countries[country] || 0) + 1;
  pruneByCount(entry.stats.countries, MAX_TRACKED_KEYS);

  const device = deviceFromUA(req.headers['user-agent']);
  entry.stats.devices[device] = (entry.stats.devices[device] || 0) + 1;

  return entry;
}

// ------------------------------------------------------------
// Branded minimal pages
// ------------------------------------------------------------

function minimalPage(heading, subtext, bodyExtra, cardVariant, logoSrc, hideBrandText) {
  const variantClass = cardVariant ? ' ' + cardVariant : '';
  const logo = logoSrc || BRAND.wordmark;
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>' + BRAND.name + '</title>' +
    '<link rel="icon" type="image/png" href="/favicon.png?v=7">' +
    '<style>' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fbfbfb;color:#3d3d3d;padding:20px;}' +
    '.card{max-width:360px;width:100%;padding:32px 28px;border-radius:10px;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.08);border:1px solid #e9e9e9;text-align:center;}' +
    /* the wordmark image is solid white, so it needs a colored plate behind
       it to stay visible on the plain white card (not just the purple
       "locked" variant below) */
    '.brand-logo{height:30px;width:auto;max-width:80%;object-fit:contain;display:inline-block;margin:0 auto 16px;padding:10px 18px;background:' + BRAND.accent + ';border-radius:10px;}' +
    'h1{font-size:1.3rem;margin:0 0 8px;}' +
    'p{color:#828282;margin:0 0 20px;font-size:0.95rem;}' +
    'input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #ddd;background:#fff;color:#3d3d3d;margin-bottom:10px;font-size:1rem;}' +
    'button{width:100%;padding:10px;border-radius:8px;border:none;background:' + BRAND.accent + ';color:white;font-size:1rem;cursor:pointer;}' +
    'button:hover{filter:brightness(1.05);}' +
    '.brand{font-weight:600;color:#3d3d3d;margin-bottom:18px;}' +
    '#err{color:#d33;font-size:0.85rem;min-height:1.1em;margin-top:8px;}' +
    '.card.locked{background:' + BRAND.accent + ';border-color:' + BRAND.accent + ';color:#fff;}' +
    '.card.locked h1,.card.locked .brand{color:#fff;}' +
    '.card.locked p{color:rgba(255,255,255,.82);}' +
    '.card.locked input{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.4);color:#fff;}' +
    '.card.locked input::placeholder{color:rgba(255,255,255,.65);}' +
    '.card.locked button{background:#fff;color:' + BRAND.accent + ';}' +
    '.card.locked #err{color:#ffd6d6;}' +
    /* on the purple card the logo's own plate is the same color as the
       card, so it just reads as the plain white wordmark sitting on it */
    '.card.locked .brand-logo{background:transparent;padding:0;filter:brightness(0) invert(1);}' +
    '</style></head><body><div class="card' + variantClass + '">' +
    '<img class="brand-logo" src="' + logo + '" alt="' + BRAND.name + '">' +
    (hideBrandText ? '' : '<div class="brand">' + BRAND.name + '</div>') +
    '<h1>' + heading + '</h1><p>' + subtext + '</p>' +
    (bodyExtra || '') +
    '</div></body></html>';
}

function passwordPage(code) {
  const extra =
    /* autocomplete="new-password" (plus a name/id that isn't "password" or
       "pw") stops browsers offering the saved ACCESS_TOKEN as an autofill
       suggestion here - this field is a per-link secret, not a login. */
    '<input type="password" id="linkpw" name="link-password" placeholder="Password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-1p-ignore>' +
    '<button onclick="go()">Continue</button><div id="err"></div>' +
    '<script>' +
    'function go(){' +
    'var pw=document.getElementById("linkpw").value;' +
    'fetch("/api/verify/' + code + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw})})' +
    '.then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});})' +
    '.then(function(res){' +
    'if(res.ok){window.location.href=res.d.url;}' +
    'else{document.getElementById("err").textContent=res.d.error||"Incorrect password";}' +
    '});' +
    '}' +
    'document.getElementById("linkpw").addEventListener("keydown",function(e){if(e.key==="Enter")go();});' +
    '</script>';

  return minimalPage(
    'This link is protected',
    'Enter the password to continue.',
    extra,
    'locked',
    null,
    true
  );
}

// ------------------------------------------------------------
// Dashboard
// ------------------------------------------------------------

const domainOptionsHtml = DOMAINS
  .map(d => '<option value="' + d + '">' + d + '</option>')
  .join('');

const domainSelectHtml = DOMAINS.length >= 2
  ? '<select id="domain" class="domain-filter" style="margin-top:8px;">' + domainOptionsHtml + '</select>'
  : '';

const moreOptionsLabel =
  'More options (tags, expiry, password' +
  (DOMAINS.length >= 2 ? ', domain' : '') +
  ')';

const HTML_PAGE =
  '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
  '<title>' + BRAND.name + '</title>' +
  '<link rel="icon" type="image/png" href="/favicon.png?v=7">' +
  '<style>' +
  ':root{--accent:' + BRAND.accent + ';--bg:#fbfbfb;--card:#fff;--card2:#f7f7f7;--text:#3d3d3d;--muted:#828282;--border:#e4e4e4;}' +
  '*{box-sizing:border-box;}' +
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:var(--bg);color:var(--text);}' +
  '.wrap{max-width:900px;width:100%;margin:0 auto;padding:40px 20px 60px;}' +
  'header{display:flex;align-items:center;gap:12px;margin-bottom:32px;background:var(--accent);padding:14px 18px;border-radius:10px;}' +
  'header{background:var(--accent);padding:14px 18px;border-radius:10px;}' +'header .wordmark{width:150px;height:auto;max-width:70%;max-height:60px;object-fit:contain;object-position:left center;display:block;}' +'header h1{display:none;}' +
  'header h1{display:none;}' +
  'header .logo{width:120px!important;height:auto!important;max-width:120px!important;max-height:40px!important;object-fit:contain;display:block;margin:0 auto;}' +
  '#gate{width:min(320px,calc(100% - 32px));margin:clamp(60px,15vh,130px) auto;text-align:center;}' +
  '#gate .gate-logo{width:56px;height:56px;object-fit:contain;margin:0 auto 16px;display:block;padding:10px;background:var(--accent);border-radius:12px;}' +
  '#gate h1{font-size:1.55rem;margin:0 0 18px;}' +
  '.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px;margin-bottom:18px;box-shadow:0 2px 10px rgba(0,0,0,.03);}' +
  'input,select,button,textarea{font-size:0.95rem;padding:10px 11px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);min-width:0;}' +
  'input,select,textarea{width:100%;}' +
  '#domain,#expiresAt{color:var(--muted);}' +
  'button{cursor:pointer;background:var(--accent);color:white;border:none;font-weight:600;}' +
  'button:hover{filter:brightness(1.05);}' +
  'a{color:var(--accent);}' +
  'input[type="datetime-local"],select{color:var(--muted);}' +
  'button.secondary{background:var(--card2);color:var(--text);border:1px solid var(--border);font-weight:500;}' +
  'button.danger{background:#d33;}' +
  '.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}' +
  '.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:18px;}' +
  '.stat{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center;}' +
  '.stat .n{font-size:1.5rem;font-weight:700;color:var(--accent);}' +
  '.stat .l{font-size:0.75rem;color:var(--muted);margin-top:2px;}' +
  '.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}' +
  '.filter-btn{padding:8px 12px;border-radius:8px;background:var(--card2);border:1px solid var(--border);font-size:0.85rem;cursor:pointer;color:var(--text);}' +
  '.filter-btn.active{background:var(--accent);color:white;border-color:var(--accent);}' +
  '.tag{padding:4px 10px;border-radius:10px;background:var(--card2);border:1px solid var(--border);font-size:0.78rem;cursor:pointer;color:var(--muted);}' +
  '.tag.active{background:var(--accent);color:white;border-color:var(--accent);}' +
  '.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}' +
  'table{width:100%;border-collapse:collapse;font-size:0.85rem;min-width:650px;}' +
  'td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--border);vertical-align:top;}' +
  'th{color:var(--muted);font-weight:600;font-size:0.75rem;text-transform:uppercase;}' +
  '.code{font-family:ui-monospace,monospace;color:var(--accent);}' +
  '.pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.7rem;margin-right:4px;}' +
  '.pill.active{background:#e8f7ed;color:#16843a;}' +
  '.pill.expired{background:#fdeaea;color:#c33;}' +
  '.pill.locked{background:#fff4d8;color:#946d00;}' +
  '.actions button{padding:5px 8px;font-size:0.75rem;margin-right:4px;margin-bottom:4px;}' +
  '.action-menu{display:inline-block;position:relative;}' +
  ' .action-menu summary{list-style:none;cursor:pointer;background:var(--accent);color:white;border-radius:10px;padding:5px 9px;font-size:0.75rem;white-space:nowrap;}' +
  '.action-menu summary::-webkit-details-marker{display:none;}' +
  '.action-menu-items{position:absolute;right:0;top:100%;z-index:20;background:var(--card);border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,.12);padding:4px;min-width:90px;}' +
  '.action-menu-items button{display:block;width:100%;box-sizing:border-box;text-align:left;margin:0 0 4px 0;padding:6px 8px;font-size:0.75rem;border-radius:10px;}.action-menu-items button:last-child{margin-bottom:0;}' +

  '.action-menu{position:relative;display:inline-block;}' +
  ' .action-menu summary{list-style:none;cursor:pointer;background:var(--accent);color:white;border-radius:10px;padding:5px 9px;font-size:0.75rem;}' +
  '.action-menu summary::-webkit-details-marker{display:none;}' +
  '.action-menu button{display:block;width:100%;text-align:left;margin:0 0 4px 0;border-radius:10px;white-space:nowrap;}' +
  ' .action-menu[open]{z-index:50;} .action-menu-items.action-menu-fixed{position:fixed !important;right:auto !important;z-index:9999 !important;opacity:0;transition:opacity .08s ease-out;} ' +
  '.action-menu[open] summary{border-radius:10px;}' +

  '#msg{font-size:0.85rem;color:var(--muted);overflow-wrap:anywhere;}#msg:not(:empty){margin-top:8px;}' +
  '.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);align-items:center;justify-content:center;padding:20px;z-index:10;}' +
  '.modal-bg.show{display:flex;}' +
  '.modal{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:22px;max-width:420px;width:100%;max-height:85vh;overflow:auto;}' +
  '.modal h3{margin-top:0;}' +
  '.close{float:right;cursor:pointer;color:var(--muted);}' +
  '.bars{display:flex;align-items:flex-end;gap:3px;height:80px;margin:14px 0 6px;}' +
  '.bar{flex:1;background:var(--accent);border-radius:2px 2px 0 0;min-height:2px;}' +
  '.miniList{font-size:0.82rem;margin:6px 0;}' +
  '.miniList div{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border);}' +
  '.advanced{margin-top:10px;}button:disabled{opacity:.6;cursor:not-allowed;}' +
  'summary{cursor:pointer;color:var(--muted);font-size:0.85rem;margin-bottom:8px;}' +
  '@media(max-width:640px){.wrap{padding:24px 14px 44px;}header{margin-bottom:22px;}.grid,.grid3{grid-template-columns:1fr;}.card{padding:14px;}#gate{margin-top:70px;}.row button{width:auto;}.table-wrap{overflow-x:auto;}.actions{white-space:normal;vertical-align:top;}.actions button{width:auto;padding:4px 6px;font-size:0.7rem;margin-right:2px;margin-bottom:3px;}td{vertical-align:top;}td:nth-child(2){white-space:normal;overflow-wrap:anywhere;}}' +
  '</style></head><body>' +

  '<div id="gate">' +
  '<img class="gate-logo" src="' + BRAND.logo + '" alt="' + BRAND.name + '">' +
  '<h1>' + BRAND.name + '</h1>' +
  '<form id="gateForm" onsubmit="event.preventDefault();unlock();">' +
  '<input type="password" id="token" placeholder="Access token" style="margin:14px 0 10px;" autocomplete="current-password">' +
  '<button id="unlockBtn" type="submit" style="width:100%">Unlock</button>' +
  '<div id="gateMsg" style="color:#c0392b;font-size:.85rem;margin-top:10px;min-height:1.2em;"></div>' +
  '</form>' +
  '</div>' +

  '<div id="app" style="display:none" class="wrap">' +
  '<header><img class="logo" src="' + BRAND.wordmark + '" alt="' + BRAND.name + '"></header>' +

  '<div class="grid3" id="overview"></div>' +

  '<div class="card">' +
  '<div class="grid">' +
  '<input type="url" id="url" placeholder="https://example.com/long/url">' +
  '<input type="text" id="code" placeholder="custom code (optional)">' +
  '</div>' +
  '<details class="advanced"><summary>' + moreOptionsLabel + '</summary>' +
  '<div class="grid" style="margin-top:8px;">' +
  '<input type="text" id="tags" placeholder="tags, comma-separated">' +
  '<input type="datetime-local" id="expiresAt">' +
  '</div>' +
  domainSelectHtml +
  '<input type="text" id="password" placeholder="password (optional)" style="margin-top:8px;">' +
  '</details>' +
  '<div class="row" style="margin-top:12px;">' +
  '<button id="submitLink" onclick="saveLink()">Shorten it</button>' +
  '<button id="cancelEdit" class="secondary" onclick="cancelEdit()" style="display:none;">Cancel</button>' +
  '</div>' +
  '<div id="msg"></div>' +
  '</div>' +

  '<div class="row" id="tagFilter" style="margin-bottom:10px;"></div>' +
  '<div class="row" id="domainFilter" style="margin-bottom:10px;"></div>' +

  '<div class="card"><div class="table-wrap">' +
  '<table><thead><tr><th>Code</th><th>Destination</th><th>Status</th><th>Clicks</th><th>Actions</th></tr></thead>' +
  '<tbody id="rows"></tbody></table>' +
  '</div></div>' +

  '<div class="modal-bg" id="modalBg"><div class="modal" id="modalBody"></div></div>' +

  '<script>' +
  'var DOMAINS = ' + JSON.stringify(DOMAINS) + ';' +
  'var token = localStorage.getItem("token") || "";' +
  'var allLinks = [];' +
  'var activeTag = null;' +
  'var activeDomain = null;' +
  'var editingCode = null;' +

  'function unlock(){' +
  'var input = document.getElementById("token");' +
  'var msg = document.getElementById("gateMsg");' +
  'var button = document.getElementById("unlockBtn");' +
  'var entered = input.value.trim();' +
  'if(!entered){ msg.textContent = "Enter your access token."; input.focus(); return; }' +
  'token = entered;' +
  'msg.textContent = "Checking...";' +
  'button.disabled = true;' +
  'button.textContent = "Checking...";' +
  'fetch("/api/links", { headers: { "X-Token": token } }).then(function(r){' +
  'return r.json().catch(function(){ return {}; }).then(function(data){' +
  'if(!r.ok) throw new Error(data.error || "Unable to unlock");' +
  'return data;' +
  '});' +
  '}).then(function(links){' +
  'localStorage.setItem("token", token);' +
  'allLinks = links;' +
  'msg.textContent = "";' +
  'document.getElementById("gate").style.display = "none";' +
  'document.getElementById("app").style.display = "block";' +
  'renderOverview();' +
  'renderTagFilter();' +
  'renderDomainFilter();' +
  'renderRows();' +
  '}).catch(function(err){' +
  'localStorage.removeItem("token");' +
  'token = "";' +
  'msg.textContent = err.message || "Unable to unlock";' +
  'input.focus();' +
  '}).finally(function(){' +
  'button.disabled = false;' +
  'button.textContent = "Unlock";' +
  '});' +
  '}' +

  'function showApp(){' +
  'if(!token) return;' +
  'fetch("/api/links", { headers: { "X-Token": token } }).then(function(r){' +
  'return r.json().catch(function(){ return {}; }).then(function(data){' +
  'if(!r.ok) throw new Error(data.error || "Wrong token");' +
  'return data;' +
  '});' +
  '}).then(function(links){' +
  'allLinks = links;' +
  'document.getElementById("gate").style.display = "none";' +
  'document.getElementById("app").style.display = "block";' +
  'renderOverview();' +
  'renderTagFilter();' +
  'renderDomainFilter();' +
  'renderRows();' +
  '}).catch(function(err){' +
  'localStorage.removeItem("token");' +
  'token = "";' +
  'document.getElementById("gateMsg").textContent = err.message || "Wrong token";' +
  '});' +
  '}' +

  'function renderOverview(){' +
  'var totalClicks = allLinks.reduce(function(s,l){return s + (l.clicks||0);}, 0);' +
  'var active = allLinks.filter(function(l){return !l.expired;}).length;' +
  'var el = document.getElementById("overview");' +
  'el.innerHTML = "";' +
  '[["Links", allLinks.length], ["Total clicks", totalClicks], ["Active", active]].forEach(function(pair){' +
  'var d = document.createElement("div"); d.className = "stat";' +
  'd.innerHTML = "<div class=\\"n\\">" + pair[1] + "</div><div class=\\"l\\">" + pair[0] + "</div>";' +
  'el.appendChild(d);' +
  '});' +
  '}' +

  'function renderTagFilter(){' +
  'var tagSet = {};' +
  'allLinks.forEach(function(l){ (l.tags||[]).forEach(function(t){ tagSet[t] = true; }); });' +
  'var tags = Object.keys(tagSet);' +
  'var el = document.getElementById("tagFilter");' +
  'el.innerHTML = "";' +
  'if(tags.length === 0) return;' +
  'var allPill = document.createElement("span");' +
  'allPill.className = "filter-btn" + (activeTag === null ? " active" : "");' +
  'allPill.textContent = "All tags";' +
  'allPill.onclick = function(){ activeTag = null; renderTagFilter(); renderRows(); };' +
  'el.appendChild(allPill);' +
  'tags.forEach(function(t){' +
  'var pill = document.createElement("span");' +
  'pill.className = "filter-btn" + (activeTag === t ? " active" : "");' +
  'pill.textContent = t;' +
  'pill.onclick = function(){ activeTag = t; renderTagFilter(); renderRows(); };' +
  'el.appendChild(pill);' +
  '});' +
  '}' +

  'function renderDomainFilter(){' +
  'var el = document.getElementById("domainFilter");' +
  'el.innerHTML = "";' +
  'if(DOMAINS.length < 2) return;' +
  'var allPill = document.createElement("span");' +
  'allPill.className = "filter-btn" + (activeDomain === null ? " active" : "");' +
  'allPill.textContent = "All domains";' +
  'allPill.onclick = function(){ activeDomain = null; renderDomainFilter(); renderRows(); };' +
  'el.appendChild(allPill);' +
  'DOMAINS.forEach(function(d){' +
  'var pill = document.createElement("span");' +
  'pill.className = "filter-btn" + (activeDomain === d ? " active" : "");' +
  'pill.textContent = d;' +
  'pill.onclick = function(){ activeDomain = d; renderDomainFilter(); renderRows(); };' +
  'el.appendChild(pill);' +
  '});' +
  '}' +

  'function positionActionMenu(d){' +
'var m=d.querySelector(".action-menu-items");if(!m)return;' +
'var r=d.getBoundingClientRect(),w=m.offsetWidth,h=m.offsetHeight,g=4;' +
'var left=r.right-w;if(left<8)left=8;if(left+w>window.innerWidth-8)left=window.innerWidth-w-8;' +
'var top=r.bottom+g;if(top+h>window.innerHeight-8)top=r.top-h-g;if(top<8)top=8;' +
'm.style.left=left+"px";m.style.top=top+"px";m.style.right="auto";' +
'}' +
'document.addEventListener("toggle",function(e){' +
'if(e.target.tagName!=="DETAILS"||!e.target.classList.contains("action-menu"))return;' +
'var d=e.target,m=d.querySelector(".action-menu-items");' +
'if(!d.open){m.classList.remove("action-menu-fixed");m.style.opacity="";m.style.left="";m.style.top="";m.style.right="";return;}' +
'm.classList.add("action-menu-fixed");positionActionMenu(d);requestAnimationFrame(function(){m.style.opacity="1";});' +
'},true);' +
'window.addEventListener("resize",function(){document.querySelectorAll(".action-menu[open]").forEach(positionActionMenu);});' +
'window.addEventListener("scroll",function(){document.querySelectorAll(".action-menu[open]").forEach(positionActionMenu);},true);document.addEventListener("click",function(e){if(e.target.closest(".action-menu"))return;document.querySelectorAll(".action-menu[open]").forEach(function(d){d.removeAttribute("open");});});' +
'function renderRows(){' +
  'var rows = document.getElementById("rows");' +
  'rows.innerHTML = "";' +
  'var list = allLinks.slice().sort(function(a,b){return b.created - a.created;});' +
  'if(activeTag) list = list.filter(function(l){ return (l.tags||[]).indexOf(activeTag) !== -1; });' +
  'if(activeDomain) list = list.filter(function(l){ return l.domain === activeDomain; });' +
  'if(list.length === 0){' +
  'var emptyTr = document.createElement("tr");' +
  'var emptyMsg = (activeTag || activeDomain) ? "No links match this filter." : "No links";' +
  'emptyTr.innerHTML = "<td colspan=\\"5\\" style=\\"text-align:center;color:var(--muted);padding:28px 10px;\\">" + emptyMsg + "</td>";' +
  'rows.appendChild(emptyTr);' +
  'return;' +
  '}' +
  'list.forEach(function(l){' +
  'var tr = document.createElement("tr");' +
  'var short = (l.domain ? "https://" + l.domain : location.origin) + "/" + l.code;' +
  'var codeDisplay = (DOMAINS.length >= 2 && l.domain) ? (l.domain + "/" + l.code) : l.code;' +
  'var displayUrl = l.url.length > 34 ? l.url.slice(0,34) + "…" : l.url;' +
  'var statusHtml = l.expired ? "<span class=\\"pill expired\\">expired</span>" : "<span class=\\"pill active\\">active</span>";' +
  'if(l.hasPassword) statusHtml += "<span class=\\"pill locked\\">locked</span>";' +
  'var tagsHtml = (l.tags||[]).map(function(t){return "<span class=\\"tag\\" style=\\"cursor:default\\">"+t+"</span>";}).join(" ");' +
  'tr.innerHTML = "<td><a class=\\"code\\" href=\\"" + short + "\\" target=\\"_blank\\">" + codeDisplay + "</a></td>" +' +
  '"<td><a href=\\"" + l.url + "\\" target=\\"_blank\\" title=\\"" + l.url + "\\">" + displayUrl + "</a><div style=\\"margin-top:8px;display:flex;flex-wrap:wrap;gap:5px;line-height:1.4;\\">" + tagsHtml + "</div></td>" +' +
  '"<td>" + statusHtml + "</td>" +' +
  '"<td>" + (l.clicks||0) + "</td>" +' +
  '"<td class=\\"actions\\"><details class=\\"action-menu\\"><summary>Actions</summary><div class=\\"action-menu-items\\">" +' +
  '"<button class=\\"secondary\\" data-action=\\"copy\\">Copy</button>" +' +
  '"<button class=\\"secondary\\" data-action=\\"qr\\">QR</button>" +' +
  '"<button class=\\"secondary\\" data-action=\\"edit\\">Edit</button>" +' +
  '"<button class=\\"secondary\\" data-action=\\"stats\\">Stats</button>" +' +
  '"<button class=\\"danger\\" data-action=\\"delete\\">Delete</button>" +' +
  '"</div></details></td>";' +
  'var menu = tr.querySelector(".action-menu");' +
  'menu.querySelector("[data-action=copy]").onclick = function(){copyLink(short);menu.removeAttribute("open");};' +
  'menu.querySelector("[data-action=qr]").onclick = function(){showQr(short);menu.removeAttribute("open");};' +
  'menu.querySelector("[data-action=edit]").onclick = function(){editLink(l.code);menu.removeAttribute("open");};' +
  'menu.querySelector("[data-action=stats]").onclick = function(){showStats(l.code);menu.removeAttribute("open");};' +
  'menu.querySelector("[data-action=delete]").onclick = function(){deleteLink(l.code);menu.removeAttribute("open");};' +
  'rows.appendChild(tr);' +
  '});' +
  '}' +
  'function copyLink(short){' +
  'function ok(){ flash("Copied " + short); }' +
  'function legacyCopy(){' +
  'try{' +
  'var ta=document.createElement("textarea");ta.value=short;ta.setAttribute("readonly","");' +
  'ta.style.position="absolute";ta.style.left="-9999px";document.body.appendChild(ta);ta.select();' +
  'var success=document.execCommand("copy");document.body.removeChild(ta);' +
  'if(success) ok(); else flash("Couldn\\u2019t copy \\u2014 link: " + short);' +
  '}catch(e){ flash("Couldn\\u2019t copy \\u2014 link: " + short); }' +
  '}' +
  '/* navigator.clipboard needs a secure context (HTTPS or localhost) and is simply unavailable over plain http://<lan-ip>, which is how most people reach this dashboard \\u2014 fall back to the older execCommand approach. */' +
  'if(navigator.clipboard && window.isSecureContext){' +
  'navigator.clipboard.writeText(short).then(ok, legacyCopy);' +
  '}else{ legacyCopy(); }' +
  '}' +
  'function flash(text){ var m = document.getElementById("msg"); m.textContent = text; setTimeout(function(){ if(m.textContent===text) m.textContent=""; }, 2500); }' +

  'function saveLink(){' +
  'var url = document.getElementById("url").value.trim();' +
  'var code = document.getElementById("code").value.trim();' +
  'var tags = document.getElementById("tags").value.split(",").map(function(s){return s.trim();}).filter(Boolean);' +
  'var expiresAtLocal = document.getElementById("expiresAt").value;' +
  'var password = document.getElementById("password").value;' +
  'var domainEl = document.getElementById("domain");' +
  'var domain = domainEl ? domainEl.value : null;' +
  'if(!url){ flash("Enter a URL first."); return; }' +
  'var expiresAt = expiresAtLocal ? new Date(expiresAtLocal).getTime() : null;' +
  'var isEdit = Boolean(editingCode);' +
  'var endpoint = isEdit ? "/api/links/" + encodeURIComponent(editingCode) : "/api/links";' +
  'var method = isEdit ? "PUT" : "POST";' +
  'var payload = {url:url, code:code, tags:tags, expiresAt:expiresAt, password:password, domain:domain, token:token};' +
  'fetch(endpoint,{method:method,headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)})' +
  '.then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});})' +
  '.then(function(res){' +
  'if(!res.ok){flash(res.d.error || "Failed");return;}' +
  'var wasEdit=isEdit; clearForm();' +
  'flash(wasEdit ? "Updated " + res.d.code : "Created " + ((res.d.domain ? "https://" + res.d.domain : location.origin) + "/" + res.d.code));' +
  'showApp();' +
  '});' +
  '}' +

  'function editLink(code){' +
  'var l=allLinks.find(function(item){return item.code===code;});' +
  'if(!l)return;' +
  'editingCode=code;' +
  'document.getElementById("url").value=l.url;' +
  'document.getElementById("code").value=l.code;' +
  'document.getElementById("tags").value=(l.tags||[]).join(", ");' +
  'document.getElementById("expiresAt").value=l.expiresAt ? new Date(l.expiresAt-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16) : "";' +
  'document.getElementById("password").value="";' +
  'if(document.getElementById("domain")) document.getElementById("domain").value=l.domain || document.getElementById("domain").value;' +
  'document.getElementById("submitLink").textContent="Save changes";' +
  'document.getElementById("cancelEdit").style.display="inline-block";' +
  'window.scrollTo({top:0,behavior:"smooth"});' +
  '}' +

  'function cancelEdit(){clearForm();}' +

  'function clearForm(){' +
  'editingCode=null;' +
  'document.getElementById("url").value="";' +
  'document.getElementById("code").value="";' +
  'document.getElementById("tags").value="";' +
  'document.getElementById("expiresAt").value="";' +
  'document.getElementById("password").value="";' +
  'document.getElementById("submitLink").textContent="Shorten it";' +
  'document.getElementById("cancelEdit").style.display="none";' +
  '}' +

  'document.getElementById("url").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();saveLink();}});' +
  'document.getElementById("code").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();saveLink();}});' +

  'function deleteLink(code){' +
  'if(!confirm("Delete " + code + "?")) return;' +
  'fetch("/api/links/" + code + "?token=" + encodeURIComponent(token), { method:"DELETE" }).then(function(){ showApp(); });' +
  '}' +

  'function openModal(html){ document.getElementById("modalBody").innerHTML = html; document.getElementById("modalBg").className = "modal-bg show"; }' +
  'function closeModal(){ document.getElementById("modalBg").className = "modal-bg"; }' +
  'document.getElementById("modalBg").addEventListener("click", function(e){ if(e.target.id === "modalBg") closeModal(); });' +

  'function showQr(short){' +
  'var qrSrc = "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=" + encodeURIComponent(short);' +
  'openModal("<span class=\\"close\\" onclick=\\"closeModal()\\">✕</span><h3>QR code</h3>" +' +
  '"<div style=\\"text-align:center\\"><img src=\\""+qrSrc+"\\" width=\\"200\\" height=\\"200\\" style=\\"border-radius:8px;background:white;padding:8px;\\"></div>" +' +
  '"<p style=\\"color:var(--muted);font-size:0.82rem;text-align:center;margin-top:10px;\\">"+short+"</p>");' +
  '}' +

  'function bars(byDay){' +
  'var days = [];' +
  'var d = new Date();' +
  'for(var i = 13; i >= 0; i--){' +
  'var dt = new Date(d); dt.setDate(d.getDate() - i);' +
  'days.push(dt.toISOString().slice(0,10));' +
  '}' +
  'var max = 1;' +
  'days.forEach(function(k){ if((byDay[k]||0) > max) max = byDay[k]; });' +
  'return days.map(function(k){' +
  'var v = byDay[k] || 0;' +
  'var h = Math.max(2, Math.round((v/max)*76));' +
  'return "<div class=\\"bar\\" style=\\"height:"+h+"px\\" title=\\""+k+": "+v+"\\"></div>";' +
  '}).join("");' +
  '}' +

  '/* "XX" is what the server records when no CF-IPCountry header is present (i.e. not behind a Cloudflare Tunnel) \\u2014 shown as "Unknown" here so it reads as expected rather than as a bug. */' +
  'function friendlyCountries(obj){' +
  'var out={};' +
  'Object.keys(obj).forEach(function(k){ out[k==="XX"?"Unknown":k] = obj[k]; });' +
  'return out;' +
  '}' +
  'function miniList(obj){' +
  'var entries = Object.keys(obj).map(function(k){ return [k, obj[k]]; }).sort(function(a,b){return b[1]-a[1];}).slice(0,5);' +
  'if(entries.length === 0) return "<div style=\\"color:var(--muted);font-size:0.82rem;\\">No data yet</div>";' +
  'return "<div class=\\"miniList\\">" + entries.map(function(e){ return "<div><span>"+e[0]+"</span><span>"+e[1]+"</span></div>"; }).join("") + "</div>";' +
  '}' +

  'function showStats(code){' +
  'fetch("/api/links/" + code + "/stats?token=" + encodeURIComponent(token)).then(function(r){ return r.json(); }).then(function(s){' +
  'var devices = s.devices || {mobile:0,desktop:0,tablet:0,other:0};' +
  'openModal(' +
  '"<span class=\\"close\\" onclick=\\"closeModal()\\">✕</span>" +' +
  '"<h3>Stats: " + code + "</h3>" +' +
  '"<div style=\\"color:var(--muted);font-size:0.8rem;margin-bottom:4px;\\">Last 14 days</div>" +' +
  '"<div class=\\"bars\\">" + bars(s.byDay || {}) + "</div>" +' +
  '"<h4 style=\\"margin-bottom:2px;\\">Top referrers</h4>" + miniList(s.referrers || {}) +' +
  '"<h4 style=\\"margin-bottom:2px;\\">Top countries</h4>" + miniList(friendlyCountries(s.countries || {})) +' +
  '"<h4 style=\\"margin-bottom:2px;\\">Devices</h4>" +' +
  '"<div class=\\"miniList\\"><div><span>Mobile</span><span>"+devices.mobile+"</span></div>" +' +
  '"<div><span>Desktop</span><span>"+devices.desktop+"</span></div>" +' +
  '"<div><span>Tablet</span><span>"+devices.tablet+"</span></div></div>"' +
  ');' +
  '});' +
  '}' +

  'if(token) showApp();' +
  '</script>' +
  '</body></html>';

// ------------------------------------------------------------
// HTTP plumbing
// ------------------------------------------------------------

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html' });
  res.end(html);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';

    req.on('data', (c) => {
      chunks += c;
    });

    req.on('end', () => {
      if (!chunks) return resolve({});

      try {
        resolve(JSON.parse(chunks));
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

// ------------------------------------------------------------
// Server
// ------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const { pathname, searchParams } =
      new URL(req.url, 'http://localhost');

    // Serve the brand images referenced by BRAND.logo / BRAND.wordmark,
    // plus the favicon (always favicon.png regardless of what those two
    // point at). All three are plain files in the project root — rename
    // BRAND.logo/wordmark to serve different files, or replace the files
    // in place to change the images without touching this route.
    const STATIC_IMAGE_PATHS = new Set(
      [BRAND.logo, BRAND.wordmark, '/favicon.ico', '/favicon.png'].filter(Boolean)
    );

    if (STATIC_IMAGE_PATHS.has(pathname) &&
        (req.method === 'GET' || req.method === 'HEAD')) {
      const filename =
        (pathname === '/favicon.ico' || pathname === '/favicon.png')
          ? 'favicon.png'
          : pathname.replace(/^\//, '');

      try {
        const image = await readFile(
          new URL('./' + filename, import.meta.url)
        );

        // Short, revalidatable cache - NOT "immutable" with a 1-year
        // max-age. This repo is meant to be rebranded by swapping these
        // files in place (see README), and an immutable year-long cache
        // means a browser that ever fetched the old file (including a
        // broken/placeholder one) would keep it, ignoring every future
        // fix, until that year is up.
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=300, must-revalidate'
        });

        if (req.method === 'HEAD') return res.end();
        return res.end(image);
      } catch {
        return sendJson(res, { error: 'Image not found' }, 404);
      }
    }

    if (pathname === '/' && req.method === 'GET') {
      if (!isDashboardRequestAllowed(req)) {
        return sendHtml(
          res,
          minimalPage('Not found', 'Nothing lives at this address.'),
          404
        );
      }

      return sendHtml(res, HTML_PAGE);
    }

    // ---- API: list links ----

    if (pathname === '/api/links' && req.method === 'GET') {
      if (!isDashboardRequestAllowed(req)) {
        return sendJson(res, { error: 'Not found' }, 404);
      }

      if (!checkToken(req, searchParams)) {
        return sendJson(res, { error: 'Unauthorized' }, 401);
      }

      const codes = await store.list();

      const links = (
        await Promise.all(
          codes.map(async (code) => {
            const val = await store.get(code);
            if (!val) return null;

            return {
              code,
              url: val.url,
              tags: val.tags || [],
              domain: val.domain || null,
              clicks: val.clicks || 0,
              created: val.created,
              expiresAt: val.expiresAt || null,
              expired: isExpired(val),
              hasPassword: Boolean(val.password)
            };
          })
        )
      ).filter(Boolean);

      return sendJson(res, links);
    }

    // ---- API: create link ----

    if (pathname === '/api/links' && req.method === 'POST') {
      if (!isDashboardRequestAllowed(req)) {
        return sendJson(res, { error: 'Not found' }, 404);
      }

      let body;

      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, { error: 'Invalid JSON' }, 400);
      }

      if (!checkToken(req, searchParams, body)) {
        return sendJson(res, { error: 'Unauthorized' }, 401);
      }

      let targetUrl = body.url && body.url.trim();

      if (!targetUrl) {
        return sendJson(res, { error: 'Provide a URL' }, 400);
      }

      if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = 'https://' + targetUrl;
      }

      if (!(await validateTargetUrl(targetUrl))) {
        return sendJson(
          res,
          { error: 'That URL does not appear to be a valid, reachable web address' },
          400
        );
      }

      let code = (body.code || '').trim();

      if (code) {
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(code)) {
          return sendJson(
            res,
            { error: 'Custom code must be alphanumeric (- and _ allowed)' },
            400
          );
        }

        const existing = await store.get(code);

        if (existing) {
          return sendJson(
            res,
            { error: 'That code is already taken' },
            409
          );
        }
      } else {
        do {
          code = randomCode();
        } while (await store.get(code));
      }

      const tags = Array.isArray(body.tags)
        ? body.tags
            .filter(t => typeof t === 'string' && t.trim())
            .slice(0, 10)
        : [];

      const expiresAt =
        Number.isFinite(body.expiresAt) ? body.expiresAt : null;

      const password =
        body.password && String(body.password).trim()
          ? sha256Hex(String(body.password).trim())
          : null;

      let domain = null;

      if (DOMAINS.length > 0) {
        domain =
          (body.domain && String(body.domain).trim()) ||
          DOMAINS[0];

        if (!DOMAINS.includes(domain)) {
          return sendJson(
            res,
            { error: 'Domain must be one of the configured DOMAINS' },
            400
          );
        }
      } else if (body.domain && String(body.domain).trim()) {
        const candidate = String(body.domain).trim();

        if (!isValidDomainFormat(candidate)) {
          return sendJson(
            res,
            { error: 'Invalid domain format' },
            400
          );
        }

        domain = candidate;
      }

      const entry = {
        url: targetUrl,
        created: Date.now(),
        clicks: 0,
        tags,
        domain,
        expiresAt,
        password,
        stats: emptyStats()
      };

      await store.put(code, entry);

      return sendJson(res, {
        code,
        url: targetUrl,
        domain
      });
    }

    // ---- API: update link ----

    let updateMatch =
      pathname.match(/^\/api\/links\/([a-zA-Z0-9_-]{1,32})$/);

    if (updateMatch && req.method === 'PUT') {
      if (!isDashboardRequestAllowed(req)) {
        return sendJson(res, { error: 'Not found' }, 404);
      }

      let body;

      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, { error: 'Invalid JSON' }, 400);
      }

      if (!checkToken(req, searchParams, body)) {
        return sendJson(res, { error: 'Unauthorized' }, 401);
      }

      const code = updateMatch[1];
      const existing = await store.get(code);

      if (!existing) {
        return sendJson(res, { error: 'Link not found' }, 404);
      }

      // A custom code typed in the edit form renames the link: same
      // validation as creating one, and a 409 if it collides with a
      // *different* existing link (renaming to your own current code is a
      // no-op, not a conflict).
      let newCode = code;
      const requestedCode = (body.code || '').trim();

      if (requestedCode && requestedCode !== code) {
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(requestedCode)) {
          return sendJson(
            res,
            { error: 'Custom code must be alphanumeric (- and _ allowed)' },
            400
          );
        }

        if (await store.get(requestedCode)) {
          return sendJson(
            res,
            { error: 'That code is already taken' },
            409
          );
        }

        newCode = requestedCode;
      }

      let targetUrl = body.url && body.url.trim();

      if (!targetUrl) {
        return sendJson(res, { error: 'Provide a URL' }, 400);
      }

      if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = 'https://' + targetUrl;
      }

      if (!(await validateTargetUrl(targetUrl))) {
        return sendJson(
          res,
          { error: 'That URL does not appear to be a valid, reachable web address' },
          400
        );
      }

      const tags = Array.isArray(body.tags)
        ? body.tags
            .filter(t => typeof t === 'string' && t.trim())
            .slice(0, 10)
        : [];

      const expiresAt =
        Number.isFinite(body.expiresAt) ? body.expiresAt : null;

      let password = existing.password || null;

      if (body.password && String(body.password).trim()) {
        password = sha256Hex(String(body.password).trim());
      }

      let domain = existing.domain || null;

      if (DOMAINS.length > 0) {
        domain =
          (body.domain && String(body.domain).trim()) ||
          DOMAINS[0];

        if (!DOMAINS.includes(domain)) {
          return sendJson(
            res,
            { error: 'Domain must be one of the configured DOMAINS' },
            400
          );
        }
      } else if (body.domain && String(body.domain).trim()) {
        const candidate = String(body.domain).trim();

        if (!isValidDomainFormat(candidate)) {
          return sendJson(
            res,
            { error: 'Invalid domain format' },
            400
          );
        }

        domain = candidate;
      }

      await store.put(newCode, {
        ...existing,
        url: targetUrl,
        tags,
        domain,
        expiresAt,
        password
      });

      if (newCode !== code) {
        await store.delete(code);
      }

      return sendJson(res, {
        code: newCode,
        url: targetUrl,
        domain
      });
    }

    // ---- API: per-link stats ----

    let m =
      pathname.match(/^\/api\/links\/([a-zA-Z0-9_-]{1,32})\/stats$/);

    if (m && req.method === 'GET') {
      if (!isDashboardRequestAllowed(req)) {
        return sendJson(res, { error: 'Not found' }, 404);
      }

      if (!checkToken(req, searchParams)) {
        return sendJson(res, { error: 'Unauthorized' }, 401);
      }

      const entry = await store.get(m[1]);

      if (!entry) {
        return sendJson(res, { error: 'Not found' }, 404);
      }

      return sendJson(res, entry.stats || emptyStats());
    }

    // ---- API: delete link ----

    if (pathname.startsWith('/api/links/') && req.method === 'DELETE') {
      if (!isDashboardRequestAllowed(req)) {
        return sendJson(res, { error: 'Not found' }, 404);
      }

      if (!checkToken(req, searchParams)) {
        return sendJson(res, { error: 'Unauthorized' }, 401);
      }

      const code = pathname.replace('/api/links/', '');

      await store.delete(code);

      return sendJson(res, { deleted: code });
    }

    // ---- API: verify password ----

    m =
      pathname.match(/^\/api\/verify\/([a-zA-Z0-9_-]{1,32})$/);

    if (m && req.method === 'POST') {
      const entry = await store.get(m[1]);

      if (!entry) {
        return sendJson(res, { error: 'Not found' }, 404);
      }

      if (isExpired(entry)) {
        return sendJson(
          res,
          { error: 'This link has expired' },
          410
        );
      }

      let body;

      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, { error: 'Invalid JSON' }, 400);
      }

      const hash = sha256Hex(String(body.password || ''));

      if (!entry.password || hash !== entry.password) {
        return sendJson(
          res,
          { error: 'Incorrect password' },
          403
        );
      }

      const updated = recordHit(entry, req);

      await store.put(m[1], updated);

      res.setHeader(
        'Set-Cookie',
        'warplet_pw_' +
          m[1] +
          '=' +
          passwordCookieValue(m[1]) +
          '; Path=/; Max-Age=31536000; SameSite=Lax'
      );

      return sendJson(res, { url: entry.url });
    }

    // ---- Redirect: GET /:code ----

    if (
      req.method === 'GET' &&
      /^\/[a-zA-Z0-9_-]{1,32}$/.test(pathname)
    ) {
      const code = pathname.slice(1);
      const entry = await store.get(code);

      if (!entry) {
        return sendHtml(
          res,
          minimalPage(
            'Link not found',
            'This short link doesn\u2019t exist or was deleted.',
            null,
            null,
            null,
            true
          ),
          404
        );
      }

      if (isExpired(entry)) {
        return sendHtml(
          res,
          minimalPage(
            'This link has expired',
            'The owner set an expiration date that has passed.',
            null,
            null,
            null,
            true
          ),
          410
        );
      }

      if (entry.password && !hasPasswordCookie(req, code)) {
        return sendHtml(res, passwordPage(code));
      }

      const updated = recordHit(entry, req);

      store
        .put(code, updated)
        .catch(err =>
          console.error('Failed to record click for', code, err)
        );

      res.writeHead(302, {
        Location: entry.url
      });

      return res.end();
    }

    return sendHtml(
      res,
      minimalPage(
        'Not found',
        'Nothing lives at this address.'
      ),
      404
    );

  } catch (err) {
    console.error('Request error:', err);

    res.writeHead(500, {
      'Content-Type': 'text/plain'
    });

    res.end('Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log(
    BRAND.name +
      ' listening on http://localhost:' +
      PORT
  );

  console.log(
    'Data file: ' +
      DATA_FILE
  );
});
