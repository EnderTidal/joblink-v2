// Uptime Monitor for JobLink V2
// External HTTPS checks against production URLs every 5 minutes.
// Alerts via Telegram if any URL fails.
// Dedup: won't re-alert for same URL within 30 minutes.
// Cron: */5 * * * * /opt/node22/bin/node /root/joblink-v2/scripts/uptime-monitor.js

const https = require('https');
const fs = require('fs');

const URLS = [
  { url: 'https://joblink2.thetelosway.com/health', accept: [200] },
  { url: 'https://app.joblinkplatform.com/', accept: [200, 302] },  // Root redirects to login
  { url: 'https://v2.joblinkplatform.com/login.html', accept: [200] },
];

const TELEGRAM_BOT_TOKEN = '8091869821:AAGy9wbk6PU32ZhTtXQsL6r0GCWp_F_onS0';
const TELEGRAM_CHAT_ID = '7889271703';
const TIMEOUT_MS = 15000;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const STATE_FILE = '/tmp/uptime-monitor-last-alert.json';

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function checkUrl(entry) {
  return new Promise((resolve) => {
    const req = https.get(entry.url, { timeout: TIMEOUT_MS }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({
        url: entry.url,
        status: res.statusCode,
        ok: entry.accept.includes(res.statusCode),
      }));
    });
    req.on('error', (e) => resolve({ url: entry.url, status: 0, ok: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ url: entry.url, status: 0, ok: false, error: 'timeout (15s)' });
    });
  });
}

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`Telegram ${res.statusCode}: ${body}`));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const state = loadState();
  const now = Date.now();
  const results = await Promise.all(URLS.map(checkUrl));
  let alertsSent = 0;

  for (const r of results) {
    if (r.ok) {
      if (state[r.url]) delete state[r.url];
      console.log(`${new Date().toISOString()} — OK: ${r.url} (HTTP ${r.status})`);
      continue;
    }

    const lastAlert = state[r.url] || 0;
    if (now - lastAlert < COOLDOWN_MS) {
      console.log(`${new Date().toISOString()} — FAIL (cooldown): ${r.url} — ${r.error || 'HTTP ' + r.status}`);
      continue;
    }

    const detail = r.error || `HTTP ${r.status}`;
    const msg = `\u{1F6A8} UPTIME ALERT: ${r.url} returned ${detail}`;
    console.log(`${new Date().toISOString()} — ALERT: ${r.url} — ${detail}`);

    try {
      await sendTelegram(msg);
      state[r.url] = now;
      alertsSent++;
    } catch (e) {
      console.error(`${new Date().toISOString()} — Telegram alert failed: ${e.message}`);
      // Fallback: try email via send-alert.js
      try {
        const { sendAlert } = require('./send-alert');
        await sendAlert('UPTIME ALERT', msg);
        state[r.url] = now;
        alertsSent++;
        console.log(`${new Date().toISOString()} — Fallback email alert sent`);
      } catch (e2) {
        console.error(`${new Date().toISOString()} — Email fallback also failed: ${e2.message}`);
      }
    }
  }

  saveState(state);
}

main().catch(e => console.error(e));
