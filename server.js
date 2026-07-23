// JobLink V2.0 — server bootstrap. Multi-tenant: each org gets its own SQLite DB.
// System DB (data/system.db) holds orgs and users. Tenant DBs (data/org-{id}.db)
// hold all business data. See SHAPE.md for the map.

require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { getSetting } = require('./src/db');
const { openSystemDb, listOrgs, updateOrgBilling, cleanExpiredSignups } = require('./src/system-db');
const { getTenantDb, tenantMiddleware } = require('./src/tenant');
const { createAuth, sendEmail } = require('./routes/auth');
const { createTomRoutes } = require('./routes/tom');
const { createAdminRoutes } = require('./routes/admin');
const { createPublicRoutes } = require('./routes/public');
const { createSignupRoutes, createStripeWebhook } = require('./routes/signup');
const { billingMiddleware } = require('./middleware/billing');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// System DB — orgs and users
const sysDb = openSystemDb(process.env.SYSTEM_DB || path.join(DATA_DIR, 'system.db'));

const app = express();

// Stripe webhook needs raw body — mount BEFORE json parser
app.use(createStripeWebhook(sysDb));

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

// Signup routes — public, no auth required
app.use(createSignupRoutes(sysDb));

// Login + session (uses system DB)
app.use(auth.router);

// Everything below requires a logged-in recruiter/admin
app.use('/api', auth.requireAuth);

// Billing middleware — check subscription status after auth
app.use('/api', billingMiddleware(sysDb));

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

// ---- Trial reminder cron (hourly) ----
function checkTrialReminders() {
  try {
    const orgs = listOrgs(sysDb);
    const now = Date.now();
    const twoDaysMs = 48 * 60 * 60 * 1000;

    for (const org of orgs) {
      if (org.reminder_sent || !org.trial_end) continue;
      if (org.subscription_status !== 'trialing') continue;

      const trialEnd = new Date(org.trial_end).getTime();
      const timeLeft = trialEnd - now;

      // Send reminder when trial ends within 48 hours
      if (timeLeft > 0 && timeLeft <= twoDaysMs) {
        const endDate = new Date(org.trial_end).toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric'
        });

        // Find admin email for this org
        const admin = sysDb.prepare(
          "SELECT email FROM users WHERE org_id = ? AND role = 'admin' AND email IS NOT NULL LIMIT 1"
        ).get(org.id);

        if (admin && admin.email) {
          sendEmail(admin.email, 'Your JobLink free trial ends in 2 days',
            '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px">' +
            '<h2 style="color:#6172f7">Trial Ending Soon</h2>' +
            '<p>Your free trial for <strong>' + org.name + '</strong> ends on <strong>' + endDate + '</strong>.</p>' +
            '<p>After that, you will be charged <strong>$399/mo</strong>. Cancel anytime from your account settings or reply to this email.</p>' +
            '<p style="color:#94a3b8;font-size:14px">No action needed if you want to continue — billing starts automatically.</p>' +
            '</div>'
          ).catch(function(e) { console.error('[trial-reminder]', e.message); });

          updateOrgBilling(sysDb, org.id, { reminder_sent: 1 });
          console.log('[trial-reminder] Sent reminder to ' + admin.email + ' for org ' + org.id);
        }
      }
    }

    // Also clean up expired pending signups
    cleanExpiredSignups(sysDb);
  } catch (e) {
    console.error('[trial-cron]', e.message);
  }
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log('JobLink V2.0 (multi-tenant) running -> http://localhost:' + PORT);
    try {
      const db1 = getTenantDb(1);
      console.log('SMS provider (org-1): ' + getSetting(db1, 'sms_provider') + ' (mock = safe, no real texts)');
    } catch { console.log('No tenant DBs yet — first login will create one.'); }
  });

  // Trial reminder check — every hour
  setInterval(checkTrialReminders, 60 * 60 * 1000);
  // Run once at startup after a short delay
  setTimeout(checkTrialReminders, 10000);
}

module.exports = { app, sysDb };
