// JobLink V2.0 — server bootstrap. "Just a DB and a parser," plus the routes
// that let recruiters talk to both. See SHAPE.md for the map.

require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { openDb } = require('./src/db');
const { createAuth } = require('./routes/auth');
const { createTomRoutes } = require('./routes/tom');
const { createAdminRoutes } = require('./routes/admin');
const { createPublicRoutes } = require('./routes/public');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = openDb(process.env.JOBLINK_DB || path.join(DATA_DIR, 'joblink.db'));
const app = express();
app.use(express.json({ limit: '2mb' }));

const startedAt = Date.now();

// Health check — no auth, always accessible
app.get('/health', (_req, res) => {
  try {
    const joCount = db.prepare("SELECT COUNT(*) AS n FROM job_orders").get().n;
    const candCount = db.prepare("SELECT COUNT(*) AS n FROM candidates").get().n;
    const lastBlast = db.prepare("SELECT sent_at FROM blasts ORDER BY id DESC LIMIT 1").get();
    res.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      db: 'ok',
      jobOrders: joCount,
      candidates: candCount,
      lastBlast: lastBlast ? lastBlast.sent_at : null,
      version: '2.0.0',
    });
  } catch (e) {
    res.status(500).json({
      status: 'error',
      db: 'error',
      error: e.message,
      version: '2.0.0',
    });
  }
});

const auth = createAuth(db);

// Candidate-facing magic link pages — NO auth (token IS the auth), mounted first
app.use(createPublicRoutes(db));

// Login + session
app.use(auth.router);

// Everything below requires a logged-in recruiter/admin
app.use('/api', auth.requireAuth);
app.use(createTomRoutes(db));
app.use(createAdminRoutes(db, auth));

// Static UI (login page is public; app pages check session client-side + APIs are guarded)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.redirect('/tom.html'));

app.use((err, _req, res, _next) => {
  console.error('[joblink]', err.message);
  res.status(500).json({ error: err.message });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`JobLink V2.0 running → http://localhost:${PORT}`);
    console.log(`SMS provider: ${require('./src/db').getSetting(db, 'sms_provider')} (mock = safe, no real texts)`);
  });
}

module.exports = { app, db };
