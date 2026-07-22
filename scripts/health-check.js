// Health Check Monitor for JobLink V2
// Curls the /health endpoint, alerts if unhealthy.
// Cron: */5 * * * * /opt/node22/bin/node /root/joblink-v2/scripts/health-check.js

const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3849;
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;
const STATE_FILE = path.join(__dirname, '..', 'data', 'health-check-state.json');
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastAlertAt: 0 }; }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function fetchHealth() {
  return new Promise((resolve, reject) => {
    const req = http.get(HEALTH_URL, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  const state = loadState();
  let healthy = false;
  let detail = '';

  try {
    const res = await fetchHealth();
    if (res.status === 200) {
      const body = JSON.parse(res.data);
      if (body.status === 'ok') {
        healthy = true;
        console.log(`${new Date().toISOString()} — Health OK (uptime: ${body.uptime}s, JOs: ${body.jobOrders}, candidates: ${body.candidates})`);
      } else {
        detail = `Status: ${body.status}, DB: ${body.db}`;
      }
    } else {
      detail = `HTTP ${res.status}: ${res.data.slice(0, 200)}`;
    }
  } catch (e) {
    detail = `Connection failed: ${e.message}`;
  }

  if (!healthy) {
    const now = Date.now();
    if (now - state.lastAlertAt < COOLDOWN_MS) {
      console.log(`${new Date().toISOString()} — UNHEALTHY but in cooldown: ${detail}`);
      saveState(state);
      return;
    }

    const { sendAlert } = require('./send-alert');
    try {
      await sendAlert('Health check FAILED', `JobLink V2 health check failed.\n\n${detail}\n\nURL: ${HEALTH_URL}`);
      state.lastAlertAt = now;
      console.log(`${new Date().toISOString()} — UNHEALTHY, alert sent: ${detail}`);
    } catch (e) {
      console.error(`${new Date().toISOString()} — Failed to send alert:`, e.message);
    }
  }

  saveState(state);
}

main().catch(e => console.error(e));
