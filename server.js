// JobLink V2.0 — server bootstrap. Multi-tenant: each org gets its own SQLite DB.
// System DB (data/system.db) holds orgs and users. Tenant DBs (data/org-{id}.db)
// hold all business data. See SHAPE.md for the map.

require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { getSetting } = require('./src/db');
const { openSystemDb } = require('./src/system-db');
const { getTenantDb, tenantMiddleware } = require('./src/tenant');
const { createAuth } = require('./routes/auth');
const { createTomRoutes } = require('./routes/tom');
const { createAdminRoutes } = require('./routes/admin');
const { createPublicRoutes } = require('./routes/public');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// System DB — orgs and users
const sysDb = openSystemDb(process.env.SYSTEM_DB || path.join(DATA_DIR, 'system.db'));

const app = express();
app.use(express.json({ limit: '2mb' }));

const startedAt = Date.now();

// Health check — no auth, always accessible. Uses org-1 tenant DB if it exists.
app.get('/health', (_req, res) => {
  try {
    const db = getTenantDb(1);
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
      version: '2.0.0-mt',
    });
  } catch (e) {
    res.status(500).json({
      status: 'error',
      db: 'error',
      error: e.message,
      version: '2.0.0-mt',
    });
  }
});

const auth = createAuth(sysDb);

// Candidate-facing magic link pages — NO auth (token IS the auth), mounted first.
app.use(createPublicRoutes(sysDb));

// Login + session (uses system DB)
app.use(auth.router);

// Everything below requires a logged-in recruiter/admin
app.use('/api', auth.requireAuth);

// Tenant middleware: after auth, attach req.db = the org's tenant DB
app.use('/api', tenantMiddleware);

// Mount routes (they now use req.db instead of a closure db)
app.use(createTomRoutes());
app.use(createAdminRoutes(sysDb, auth));

// Static UI (login page is public; app pages check session client-side + APIs are guarded)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.redirect('/tom.html'));

app.use((err, _req, res, _next) => {
  console.error('[joblink]', err.message);
  res.status(500).json({ error: err.message });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`JobLink V2.0 (multi-tenant) running -> http://localhost:${PORT}`);
    try {
      const db1 = getTenantDb(1);
      console.log(`SMS provider (org-1): ${getSetting(db1, 'sms_provider')} (mock = safe, no real texts)`);
    } catch { console.log('No tenant DBs yet — first login will create one.'); }
  });
}

module.exports = { app, sysDb };
