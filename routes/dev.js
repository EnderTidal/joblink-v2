// Super Admin routes — platform-level dashboard for org management.
// Protected: requireAuth (JWT session) + requireSuperAdmin (org_id === 1).
// FIX: previously dev routes at /dev bypassed /api auth middleware.
// Now the router mounts auth.requireAuth itself so auth works regardless of mount path.

const express = require('express');
const { listOrgs, getOrg, listOrgUsers, updateOrgBilling, toggleOrgTest } = require('../src/system-db');
const { getTenantDb, tenantDbExists } = require('../src/tenant');

function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.org_id !== 1) {
    return res.status(403).json({ error: 'super_admin_only' });
  }
  next();
}

// ---- Staging environment read-only access ----
const { DatabaseSync } = require('node:sqlite');
const stagingPath = require('path');
const stagingFs = require('fs');
const STAGING_DATA = process.env.STAGING_DATA_DIR || '/root/joblink-v2-staging/data';

function openStagingDb(filePath) {
  return new DatabaseSync(filePath, { open: true, readOnly: true });
}

function stagingSystemDb() {
  return openStagingDb(stagingPath.join(STAGING_DATA, 'system.db'));
}

function stagingTenantDb(orgId) {
  return openStagingDb(stagingPath.join(STAGING_DATA, 'org-' + orgId + '.db'));
}

function stagingTenantExists(orgId) {
  return stagingFs.existsSync(stagingPath.join(STAGING_DATA, 'org-' + orgId + '.db'));
}

function listStagingOrgs(sDb) {
  return sDb.prepare('SELECT * FROM orgs ORDER BY id').all();
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
      const allOrgs = listOrgs(sysDb);
      const orgs = allOrgs.filter(o => !o.is_test);
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
        total_orgs: allOrgs.length,
        live_orgs: orgs.length,
        test_orgs: allOrgs.length - orgs.length,
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

  // ---- Toggle test flag ----
  router.post('/api/orgs/:id/toggle-test', (req, res) => {
    try {
      const org = getOrg(sysDb, req.params.id);
      if (!org) return res.status(404).json({ error: 'org not found' });
      if (org.id === 1) return res.status(400).json({ error: 'cannot mark platform org as test' });
      const updated = toggleOrgTest(sysDb, org.id);
      res.json({ ok: true, is_test: updated.is_test });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Pipeline funnel (platform-wide) ----
  router.get('/api/pipeline', (_req, res) => {
    try {
      const orgs = listOrgs(sysDb).filter(o => !o.is_test);
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
      const orgs = listOrgs(sysDb).filter(o => !o.is_test);
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

  // ---- Staging read-only endpoints ----
  // These open the staging data directory's SQLite files directly (read-only).
  // No HTTP proxy needed — both envs are on the same machine.

  router.get('/api/staging/metrics', (_req, res) => {
    let sDb;
    try {
      sDb = stagingSystemDb();
      const orgs = listStagingOrgs(sDb);
      const active = orgs.filter(o => o.subscription_status === 'active');
      const trialing = orgs.filter(o => o.subscription_status === 'trialing');
      const suspended = orgs.filter(o => o.subscription_status === 'suspended');
      const churned = orgs.filter(o => o.subscription_status === 'canceled' || o.subscription_status === 'past_due');
      const mrrCents = active.reduce((sum, o) => sum + (o.plan_price_cents || 39900), 0);

      let totalCandidates = 0, totalJOs = 0, totalBlasts = 0;
      for (const org of orgs) {
        try {
          if (stagingTenantExists(org.id)) {
            const db = stagingTenantDb(org.id);
            totalCandidates += db.prepare("SELECT COUNT(*) AS n FROM candidates").get().n;
            totalJOs += db.prepare("SELECT COUNT(*) AS n FROM job_orders").get().n;
            totalBlasts += db.prepare("SELECT COUNT(*) AS n FROM blasts").get().n;
            db.close();
          }
        } catch { /* skip */ }
      }

      sDb.close();
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
      try { if (sDb) sDb.close(); } catch {}
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/staging/orgs', (_req, res) => {
    let sDb;
    try {
      sDb = stagingSystemDb();
      const orgs = listStagingOrgs(sDb);
      const result = orgs.map(org => {
        let candidates = 0, jobOrders = 0, blasts = 0, lastBlast = null, userCount = 0;
        try {
          userCount = sDb.prepare('SELECT COUNT(*) AS n FROM users WHERE org_id = ?').get(org.id).n;
        } catch {}
        try {
          if (stagingTenantExists(org.id)) {
            const db = stagingTenantDb(org.id);
            candidates = db.prepare("SELECT COUNT(*) AS n FROM candidates").get().n;
            jobOrders = db.prepare("SELECT COUNT(*) AS n FROM job_orders").get().n;
            blasts = db.prepare("SELECT COUNT(*) AS n FROM blasts").get().n;
            const lb = db.prepare("SELECT sent_at FROM blasts ORDER BY id DESC LIMIT 1").get();
            lastBlast = lb ? lb.sent_at : null;
            db.close();
          }
        } catch { /* tenant DB may not exist yet */ }
        return {
          ...org,
          user_count: userCount,
          candidate_count: candidates,
          job_order_count: jobOrders,
          blast_count: blasts,
          last_blast: lastBlast,
        };
      });
      sDb.close();
      res.json(result);
    } catch (err) {
      try { if (sDb) sDb.close(); } catch {}
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/staging/pipeline', (_req, res) => {
    let sDb;
    try {
      sDb = stagingSystemDb();
      const orgs = listStagingOrgs(sDb);
      let interested = 0, yesListed = 0, confirmed = 0, filled = 0;
      for (const org of orgs) {
        try {
          if (stagingTenantExists(org.id)) {
            const db = stagingTenantDb(org.id);
            const rows = db.prepare("SELECT status, COUNT(*) AS n FROM interests GROUP BY status").all();
            for (const r of rows) {
              if (r.status === 'interested') interested += r.n;
              else if (r.status === 'yes_listed') yesListed += r.n;
              else if (r.status === 'confirmed') confirmed += r.n;
              else if (r.status === 'filled') filled += r.n;
            }
            db.close();
          }
        } catch { /* skip */ }
      }
      sDb.close();
      const total = interested + yesListed + confirmed + filled;
      res.json({
        interested, yes_listed: yesListed, confirmed, filled, total,
        pct_yes_listed: total ? Math.round((yesListed / total) * 100) : 0,
        pct_confirmed: total ? Math.round((confirmed / total) * 100) : 0,
        pct_filled: total ? Math.round((filled / total) * 100) : 0,
      });
    } catch (err) {
      try { if (sDb) sDb.close(); } catch {}
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/staging/alerts', (_req, res) => {
    let sDb;
    try {
      sDb = stagingSystemDb();
      const orgs = listStagingOrgs(sDb);
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
          if (stagingTenantExists(org.id)) {
            const db = stagingTenantDb(org.id);
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
            db.close();
          }
        } catch { /* skip */ }
      }

      sDb.close();
      res.json(alerts);
    } catch (err) {
      try { if (sDb) sDb.close(); } catch {}
      res.status(500).json({ error: err.message });
    }
  });


  // ======= QBO FINANCIAL ROUTES =======

  // ---- AI Usage Metering ----
  router.get('/api/qbo/ai-usage/:month', async (req, res) => {
    try {
      const { getAllOrgUsage } = require('../lib/ai-metering');
      const usage = getAllOrgUsage(req.params.month);
      const totalCost = usage.reduce((sum, u) => sum + u.estimatedCost, 0);
      const totalCalls = usage.reduce((sum, u) => sum + u.totalCalls, 0);
      res.json({ month: req.params.month, orgs: usage, totalCost, totalCalls });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/qbo/ai-usage/:month/:orgId', async (req, res) => {
    try {
      const { getUsageSummary } = require('../lib/ai-metering');
      const usage = getUsageSummary(parseInt(req.params.orgId), req.params.month);
      res.json({ month: req.params.month, orgId: parseInt(req.params.orgId), ...usage });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });



  // ---- Stripe Activity ----
  router.get('/api/qbo/stripe', async (_req, res) => {
    try {
      const dotenv = require('dotenv');
      dotenv.config({ path: require('path').join(__dirname, '..', '.env') });
      const Stripe = require('stripe');
      const stripe = Stripe(process.env.STRIPE_SK);

      const thirtyDaysAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
      const txns = await stripe.balanceTransactions.list({ limit: 50, created: { gte: thirtyDaysAgo } });

      let charges = 0, refunds = 0, fees = 0;
      const transactions = txns.data.map(t => {
        if (t.type === 'charge') charges += t.amount;
        if (t.type === 'refund') refunds += Math.abs(t.amount);
        if (t.type === 'stripe_fee') fees += Math.abs(t.amount);
        return {
          date: new Date(t.created * 1000).toISOString().slice(0, 10),
          amount: t.amount / 100,
          type: t.type,
          description: t.description || '',
        };
      });

      res.json({
        transactions,
        summary: {
          charges: charges / 100,
          refunds: refunds / 100,
          fees: fees / 100,
          net: (charges - refunds - fees) / 100,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });



  // ---- QBO Health Check ----
  router.get('/api/qbo/health', async (_req, res) => {
    try {
      const qbo = require('../lib/qbo-client');
      const health = await qbo.healthCheck();
      res.json(health);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- COGS Calculator (dry run) ----
  router.get('/api/qbo/cogs/:month', async (req, res) => {
    try {
      const cogs = require('../lib/qbo-cogs');
      const result = await cogs.invoiceMattCogs(req.params.month, { dryRun: true });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Create & send COGS invoice ----
  router.post('/api/qbo/cogs/:month/invoice', async (req, res) => {
    try {
      const cogs = require('../lib/qbo-cogs');
      const { customerId, sendEmail } = req.body || {};
      if (!customerId) return res.status(400).json({ error: 'customerId required' });
      const result = await cogs.invoiceMattCogs(req.params.month, {
        customerId,
        dryRun: false,
        sendEmail: !!sendEmail,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- P&L Summary ----
  router.get('/api/qbo/pnl', async (_req, res) => {
    try {
      const qbo = require('../lib/qbo-client');
      const tokens = await qbo.getValidToken();
      const realmId = tokens.realm_id || '9341457804886708';
      const today = new Date();
      const startOfMonth = today.toISOString().slice(0, 7) + '-01';
      const endOfMonth = today.toISOString().slice(0, 10);

      const url = `https://quickbooks.api.intuit.com/v3/company/${realmId}/reports/ProfitAndLoss?start_date=${startOfMonth}&end_date=${endOfMonth}&minorversion=73`;
      const apiRes = await fetch(url, {
        headers: {
          Authorization: 'Bearer ' + tokens.access_token,
          Accept: 'application/json',
        },
      });

      if (!apiRes.ok) {
        const txt = await apiRes.text();
        return res.status(apiRes.status).json({ error: 'QBO P&L failed', body: txt });
      }

      const report = await apiRes.json();
      const parsed = parseQboPnl(report);
      res.json(parsed);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- COGS summary by org ----
  router.get('/api/qbo/cogs-summary', async (_req, res) => {
    try {
      const cogs = require('../lib/qbo-cogs');
      const today = new Date();
      const month = today.toISOString().slice(0, 7);
      const allCosts = await cogs.getAllResumeLineCosts(month);
      res.json({ month, orgs: allCosts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- QBO Accounts list ----
  router.get('/api/qbo/accounts', async (_req, res) => {
    try {
      const qbo = require('../lib/qbo-client');
      const result = await qbo.qboQuery("SELECT * FROM Account ORDERBY Name");
      const accounts = result.QueryResponse?.Account || [];
      res.json(accounts.map(a => ({
        id: a.Id,
        name: a.Name,
        type: a.AccountType,
        subType: a.AccountSubType,
        balance: a.CurrentBalance,
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- QBO Invoices list ----
  router.get('/api/qbo/invoices', async (_req, res) => {
    try {
      const qbo = require('../lib/qbo-client');
      const result = await qbo.qboQuery("SELECT * FROM Invoice ORDERBY TxnDate DESC MAXRESULTS 20");
      const invoices = result.QueryResponse?.Invoice || [];
      res.json(invoices.map(inv => ({
        id: inv.Id,
        docNumber: inv.DocNumber,
        date: inv.TxnDate,
        dueDate: inv.DueDate,
        total: inv.TotalAmt,
        balance: inv.Balance,
        status: inv.Balance === 0 ? 'paid' : (new Date(inv.DueDate) < new Date() ? 'overdue' : 'open'),
        customer: inv.CustomerRef?.name || 'Unknown',
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}


function parseQboPnl(report) {
  const header = report.Header || {};
  const rows = report.Rows?.Row || [];
  const sections = {};
  for (const row of rows) {
    if (row.group === 'Income' || row.group === 'CostOfGoodsSold' || row.group === 'Expenses') {
      const items = [];
      const subRows = row.Rows?.Row || [];
      for (const sub of subRows) {
        if (sub.ColData) {
          items.push({
            name: sub.ColData[0]?.value || '',
            amount: parseFloat(sub.ColData[1]?.value || '0'),
          });
        }
      }
      const total = row.Summary?.ColData?.[1]?.value || '0';
      sections[row.group] = { items, total: parseFloat(total) };
    }
    if (row.group === 'NetIncome') {
      sections.NetIncome = parseFloat(row.Summary?.ColData?.[1]?.value || '0');
    }
  }
  return {
    period: header.StartPeriod + ' to ' + header.EndPeriod,
    currency: header.Currency || 'USD',
    income: sections.Income || { items: [], total: 0 },
    cogs: sections.CostOfGoodsSold || { items: [], total: 0 },
    expenses: sections.Expenses || { items: [], total: 0 },
    netIncome: sections.NetIncome || 0,
    grossProfit: (sections.Income?.total || 0) - (sections.CostOfGoodsSold?.total || 0),
  };
}

module.exports = { createDevRoutes, requireSuperAdmin };
