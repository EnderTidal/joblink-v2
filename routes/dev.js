// Super Admin routes — platform-level dashboard for org management.
// Protected: requireAuth (JWT session) + requireSuperAdmin (org_id === 1).
// FIX: previously dev routes at /dev bypassed /api auth middleware.
// Now the router mounts auth.requireAuth itself so auth works regardless of mount path.

const express = require('express');
const { listOrgs, getOrg, listOrgUsers, updateOrgBilling } = require('../src/system-db');
const { getTenantDb, tenantDbExists } = require('../src/tenant');

function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.org_id !== 1) {
    return res.status(403).json({ error: 'super_admin_only' });
  }
  next();
}

function createDevRoutes(sysDb, auth) {
  const router = express.Router();

  // Auth fix: mount requireAuth here so /dev routes get session parsing
  // regardless of how the router is mounted in server.js
  router.use(auth.requireAuth);
  router.use(requireSuperAdmin);

  // ---- Platform metrics ----
  router.get('/api/metrics', (_req, res) => {
    try {
      const orgs = listOrgs(sysDb);
      const active = orgs.filter(o => o.subscription_status === 'active');
      const trialing = orgs.filter(o => o.subscription_status === 'trialing');
      const suspended = orgs.filter(o => o.subscription_status === 'suspended');
      const churned = orgs.filter(o => o.subscription_status === 'canceled' || o.subscription_status === 'past_due');

      const mrrCents = active.reduce((sum, o) => sum + (o.plan_price_cents || 39900), 0);

      let totalCandidates = 0, totalJOs = 0, totalBlasts = 0;
      for (const org of orgs) {
        try {
          if (tenantDbExists(org.id)) {
            const db = getTenantDb(org.id);
            totalCandidates += db.prepare("SELECT COUNT(*) AS n FROM candidates").get().n;
            totalJOs += db.prepare("SELECT COUNT(*) AS n FROM job_orders").get().n;
            totalBlasts += db.prepare("SELECT COUNT(*) AS n FROM blasts").get().n;
          }
        } catch { /* skip */ }
      }

      res.json({
        mrr_cents: mrrCents,
        mrr_display: '$' + (mrrCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }),
        total_orgs: orgs.length,
        active_orgs: active.length,
        trialing_orgs: trialing.length,
        suspended_orgs: suspended.length,
        churned_orgs: churned.length,
        total_candidates: totalCandidates,
        total_job_orders: totalJOs,
        total_blasts: totalBlasts,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- List all orgs with per-org stats ----
  router.get('/api/orgs', (_req, res) => {
    try {
      const orgs = listOrgs(sysDb);
      const result = orgs.map(org => {
        const users = listOrgUsers(sysDb, org.id);
        let candidates = 0, jobOrders = 0, blasts = 0, lastBlast = null;
        try {
          if (tenantDbExists(org.id)) {
            const db = getTenantDb(org.id);
            candidates = db.prepare("SELECT COUNT(*) AS n FROM candidates").get().n;
            jobOrders = db.prepare("SELECT COUNT(*) AS n FROM job_orders").get().n;
            blasts = db.prepare("SELECT COUNT(*) AS n FROM blasts").get().n;
            const lb = db.prepare("SELECT sent_at FROM blasts ORDER BY id DESC LIMIT 1").get();
            lastBlast = lb ? lb.sent_at : null;
          }
        } catch { /* tenant DB may not exist yet */ }
        return {
          ...org,
          user_count: users.length,
          candidate_count: candidates,
          job_order_count: jobOrders,
          blast_count: blasts,
          last_blast: lastBlast,
        };
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Detailed org info ----
  router.get('/api/orgs/:id', (req, res) => {
    try {
      const org = getOrg(sysDb, req.params.id);
      if (!org) return res.status(404).json({ error: 'org not found' });
      const users = listOrgUsers(sysDb, org.id);
      let candidates = 0, jobOrders = 0, blasts = 0, interests = 0;
      let recentBlasts = [];
      try {
        if (tenantDbExists(org.id)) {
          const db = getTenantDb(org.id);
          candidates = db.prepare("SELECT COUNT(*) AS n FROM candidates").get().n;
          jobOrders = db.prepare("SELECT COUNT(*) AS n FROM job_orders").get().n;
          blasts = db.prepare("SELECT COUNT(*) AS n FROM blasts").get().n;
          interests = db.prepare("SELECT COUNT(*) AS n FROM interests").get().n;
          recentBlasts = db.prepare("SELECT id, sent_at, category, sent_count, message_preview FROM blasts ORDER BY id DESC LIMIT 5").all();
        }
      } catch { /* tenant DB may not exist yet */ }
      res.json({
        ...org,
        users,
        candidate_count: candidates,
        job_order_count: jobOrders,
        blast_count: blasts,
        interest_count: interests,
        recent_blasts: recentBlasts,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Suspend org ----
  router.post('/api/orgs/:id/suspend', (req, res) => {
    try {
      const org = getOrg(sysDb, req.params.id);
      if (!org) return res.status(404).json({ error: 'org not found' });
      if (org.id === 1) return res.status(400).json({ error: 'cannot suspend the platform org' });
      updateOrgBilling(sysDb, org.id, { subscription_status: 'suspended' });
      res.json({ ok: true, subscription_status: 'suspended' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Reactivate org ----
  router.post('/api/orgs/:id/reactivate', (req, res) => {
    try {
      const org = getOrg(sysDb, req.params.id);
      if (!org) return res.status(404).json({ error: 'org not found' });
      updateOrgBilling(sysDb, org.id, { subscription_status: 'active' });
      res.json({ ok: true, subscription_status: 'active' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Pipeline funnel (platform-wide) ----
  router.get('/api/pipeline', (_req, res) => {
    try {
      const orgs = listOrgs(sysDb);
      let interested = 0, yesListed = 0, confirmed = 0, filled = 0;
      for (const org of orgs) {
        try {
          if (tenantDbExists(org.id)) {
            const db = getTenantDb(org.id);
            const rows = db.prepare(
              "SELECT status, COUNT(*) AS n FROM interests GROUP BY status"
            ).all();
            for (const r of rows) {
              if (r.status === 'interested') interested += r.n;
              else if (r.status === 'yes_listed') yesListed += r.n;
              else if (r.status === 'confirmed') confirmed += r.n;
              else if (r.status === 'filled') filled += r.n;
            }
          }
        } catch { /* skip */ }
      }
      const total = interested + yesListed + confirmed + filled;
      res.json({
        interested, yes_listed: yesListed, confirmed, filled, total,
        pct_yes_listed: total ? Math.round((yesListed / total) * 100) : 0,
        pct_confirmed: total ? Math.round((confirmed / total) * 100) : 0,
        pct_filled: total ? Math.round((filled / total) * 100) : 0,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Alerts ----
  router.get('/api/alerts', (_req, res) => {
    try {
      const orgs = listOrgs(sysDb);
      const now = Date.now();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const twoDaysMs = 48 * 60 * 60 * 1000;
      const alerts = [];

      for (const org of orgs) {
        if (org.subscription_status === 'trialing' && org.trial_end) {
          const trialEnd = new Date(org.trial_end).getTime();
          const timeLeft = trialEnd - now;
          if (timeLeft > 0 && timeLeft <= twoDaysMs) {
            alerts.push({ type: 'trial_expiring', org_id: org.id, org_name: org.name, trial_end: org.trial_end });
          }
        }

        try {
          if (tenantDbExists(org.id)) {
            const db = getTenantDb(org.id);
            const candCount = db.prepare("SELECT COUNT(*) AS n FROM candidates").get().n;
            if (candCount === 0 && org.subscription_status !== 'suspended') {
              alerts.push({ type: 'zero_candidates', org_id: org.id, org_name: org.name });
            }
            if (org.subscription_status === 'active' || org.subscription_status === 'trialing') {
              const lastBlast = db.prepare("SELECT sent_at FROM blasts ORDER BY id DESC LIMIT 1").get();
              if (lastBlast) {
                const blastAge = now - new Date(lastBlast.sent_at).getTime();
                if (blastAge > sevenDaysMs) {
                  alerts.push({ type: 'stale_blasts', org_id: org.id, org_name: org.name, last_blast: lastBlast.sent_at });
                }
              } else if (candCount > 0) {
                alerts.push({ type: 'never_blasted', org_id: org.id, org_name: org.name });
              }
            }
          }
        } catch { /* skip */ }
      }

      res.json(alerts);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createDevRoutes, requireSuperAdmin };
