// Error Monitor for JobLink V2
// Reads PM2 error log, tracks position, alerts if 5+ new errors.
// Cron: */5 * * * * /opt/node22/bin/node /root/joblink-v2/scripts/error-monitor.js

const fs = require('fs');
const path = require('path');

const LOG_FILE = '/root/.pm2/logs/joblink-v2-error.log';
const STATE_FILE = path.join(__dirname, '..', 'data', 'error-monitor-state.json');
const ERROR_THRESHOLD = 5;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastPosition: 0, lastAlertAt: 0 };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  const state = loadState();
  
  // Check if log file exists
  if (!fs.existsSync(LOG_FILE)) {
    console.log(`${new Date().toISOString()} — No error log file found, skipping`);
    return;
  }

  const stats = fs.statSync(LOG_FILE);
  
  // Log was truncated/rotated — reset position
  if (stats.size < state.lastPosition) {
    state.lastPosition = 0;
  }

  // No new data
  if (stats.size === state.lastPosition) {
    console.log(`${new Date().toISOString()} — No new errors`);
    saveState(state);
    return;
  }

  // Read new content
  const fd = fs.openSync(LOG_FILE, 'r');
  const buf = Buffer.alloc(stats.size - state.lastPosition);
  fs.readSync(fd, buf, 0, buf.length, state.lastPosition);
  fs.closeSync(fd);

  const newContent = buf.toString('utf8');
  const newLines = newContent.split('\n').filter(l => l.trim());
  
  state.lastPosition = stats.size;

  if (newLines.length >= ERROR_THRESHOLD) {
    const now = Date.now();
    if (now - state.lastAlertAt < COOLDOWN_MS) {
      console.log(`${new Date().toISOString()} — ${newLines.length} new errors but in cooldown (${Math.round((COOLDOWN_MS - (now - state.lastAlertAt)) / 60000)}min left)`);
      saveState(state);
      return;
    }

    // Send alert
    const { sendAlert } = require('./send-alert');
    const errorSample = newLines.slice(-20).join('\n');
    const subject = `${newLines.length} errors detected in joblink-v2`;
    const body = `${newLines.length} new error lines found in PM2 error log.\n\nLast ${Math.min(20, newLines.length)} lines:\n\n${errorSample}`;
    
    try {
      await sendAlert(subject, body);
      state.lastAlertAt = now;
      console.log(`${new Date().toISOString()} — Alert sent: ${newLines.length} errors`);
    } catch (e) {
      console.error(`${new Date().toISOString()} — Failed to send alert:`, e.message);
    }
  } else {
    console.log(`${new Date().toISOString()} — ${newLines.length} new error lines (below threshold of ${ERROR_THRESHOLD})`);
  }

  saveState(state);
}

main().catch(e => console.error(e));
