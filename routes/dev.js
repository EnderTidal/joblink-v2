// Super Admin routes — platform-level dashboard for org management.
// Protected: only users with org_id === 1 can access.

const express = require('express');
const { listOrgs, getOrg, listOrgUsers, updateOrgBilling } = require('../src/system-db');
const { getTenantDb, tenantDbExists } = require('../src/tenant');

function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.org_id !== 1) {
    return res.status(403).json({ error: 'super_admin_only' });
  }
  next();
}

function createDevRoutes(sysDb) {
  const router = express.Router();
  router.use(requireSuperAdmin);

  // List all orgs with per-org counts
  router.get('/api/orgs', (_req, res) => {
    try {
      const orgs = listOrgs(sysDb);
      const result = orgs.map(org => {
        const users = listOrgUsers(sysDb, org.id);
        let candidates = 0, jobOrders = 0, blasts = 0, interests = 0;
        try {
          if (tenantDbExists(org.id)) {
            const db = getTenantDb(org.id);
            candidates = db.prepare("SELECT COUNT(*) AS n FROM candidates").get().n;
            jobOrders = db.prepare("SELECT COUNT(*) AS n FROM job_orders").get().n;
            blasts = db.prepare("SELECT COUNT(*) AS n FROM blasts").get().n;
            interests = db.prepare("SELECT COUNT(*) AS n FROM interests").get().n;
          }
        } catch { /* tenant DB may not exist yet */ }
        return {
          ...org,
          user_count: users.length,
          candidate_count: candidates,
          job_order_count: jobOrders,
          blast_count: blasts,
          interest_count: interests,
        };
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Detailed org info
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

  // Suspend org
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

  // Reactivate org
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

  // Platform metrics
  router.get('/api/metrics', (_req, res) => {
    try {
      const orgs = listOrgs(sysDb);
      const active = orgs.filter(o => o.subscription_status === 'active');
      const trialing = orgs.filter(o => o.subscription_status === 'trialing');
      const suspended = orgs.filter(o => o.subscription_status === 'suspended');
      const churned = orgs.filter(o => o.subscription_status === 'canceled' || o.subscription_status === 'past_due');

      // MRR: active orgs * their plan price
      const mrrCents = active.reduce((sum, o) => sum + (o.plan_price_cents || 39900), 0);

      // Signups by week (last 8 weeks)
      const weeklySignups = [];
      for (let i = 0; i < 8; i++) {
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - (i + 1) * 7);
        const weekEnd = new Date();
        weekEnd.setDate(weekEnd.getDate() - i * 7);
        const count = orgs.filter(o => {
          const d = new Date(o.created_at);
          return d >= weekStart && d < weekEnd;
        }).length;
        weeklySignups.unshift({
          week: weekStart.toISOString().slice(0, 10),
          count,
        });
      }

      // Total candidates and JOs across all orgs
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
        weekly_signups: weeklySignups,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createDevRoutes, requireSuperAdmin };
