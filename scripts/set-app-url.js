#!/usr/bin/env node
/*
 * Tell the pages where an app really lives.
 *
 *   node scripts/set-app-url.js ALERTS https://mbtradedesk.duckdns.org
 *   node scripts/set-app-url.js ALERTS --clear      back to host:port
 *   node scripts/set-app-url.js                     show what is set
 *
 * Both the landing page and every stock card link to the alerts app. Left to
 * themselves they compose that link from the page's OWN protocol and host —
 * http://<ip>:3090 — which is the one address it must not be: a browser refuses
 * Notification.requestPermission() outside a secure context, and that refusal is
 * the entire reason the certificate was obtained. Setting the address here is
 * what points those links at https instead.
 *
 * deploy/setup-https.sh writes this itself after a certificate is confirmed
 * answering. This script exists for the box where https was set up BEFORE that
 * step existed, and for changing the domain later without re-running the whole
 * certificate flow.
 *
 * Written to data/app-urls.json, which is gitignored — a domain belongs to
 * whoever deployed the box, not to the repository, and a tracked file edited on
 * the server makes the next `git pull` refuse to run.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'app-urls.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}

const apps = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8')).apps || [];
const [id, url] = process.argv.slice(2);

// No arguments: report, rather than doing something unasked.
if (!id) {
  const current = read();
  console.log(`data/app-urls.json${fs.existsSync(FILE) ? '' : '  (does not exist)'}`);
  for (const a of apps) {
    console.log(`  ${a.id.padEnd(7)} ${current[a.id] || `http://<this host>:${a.port}   (default)`}`);
  }
  console.log('\nSet one:   node scripts/set-app-url.js ALERTS https://your.domain');
  process.exit(0);
}

const app = apps.find(a => a.id === id.toUpperCase());
if (!app) {
  console.error(`No app "${id}" in tools.config.json. Known: ${apps.map(a => a.id).join(', ')}`);
  process.exit(1);
}

const state = read();
if (url === '--clear') {
  delete state[app.id];
} else {
  // Only http and https. This value ends up in an href, so it is a value the
  // browser will be asked to navigate to; a bare hostname with no scheme
  // silently resolves as a path relative to the page it was written on.
  if (!url || !/^https?:\/\/[^/]+/.test(url)) {
    console.error('Give a full address, starting with https:// or http://');
    console.error('   eg: node scripts/set-app-url.js ALERTS https://mbtradedesk.duckdns.org');
    process.exit(1);
  }
  state[app.id] = url.replace(/\/$/, '');
}

fs.mkdirSync(path.dirname(FILE), { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(state, null, 2) + '\n');
console.log(`${app.id} → ${state[app.id] || `http://<this host>:${app.port} (default)`}`);
console.log();
// The pages read this through /api/tools, served by the screener processes, so
// those are what have to be told. Saying so beats a change that appears not to
// have worked.
console.log('Now reload the screeners so the links pick it up:');
console.log('  pm2 reload /^tool-/');
