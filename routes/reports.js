// routes/reports.js — Weekly KWF business report + email delivery
// Mounts at /dev/api/weekly-report, /dev/api/weekly-report/send, /dev/api/weekly-report/config
// Protected by requireAuth + requireSuperAdmin (inherited from dev router parent)

const express = require('express');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const RESEND_API_KEY = process.env.RESEND_KEY || process.env.RESEND_API_KEY || '';

// ResumeLine PostgreSQL connection (local on same server)
const RESUMELINE_DB = {
  host: '127.0.0.1',
  port: 5432,
  user: process.env.RESUMELINE_DB_USER || 'billyfit_admin',
  password: process.env.RESUMELINE_DB_PASSWORD,
  database: 'resumeline_prod',
  max: 2,
};

// ---- helpers ----

function openDb(filePath) {
  return new DatabaseSync(filePath, { open: true, readOnly: true });
}

function systemDb() {
  return openDb(path.join(DATA_DIR, 'system.db'));
}

function tenantDb(orgId) {
  const p = path.join(DATA_DIR, `org-${orgId}.db`);
  if (!fs.existsSync(p)) return null;
  return openDb(p);
}

function safeClose(db) {
  try { if (db) db.close(); } catch {}
}

function weekRange() {
  const now = new Date();
  const end = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    display: start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
             ' – ' + end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
  };
}

function pctChange(current, previous) {
  if (previous === 0) return current > 0 ? '+100%' : '—';
  const pct = Math.round(((current - previous) / previous) * 100);
  return (pct >= 0 ? '+' : '') + pct + '%';
}

function dollars(cents) {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---- data collectors ----

function collectRevenue(sDb) {
  const orgs = sDb.prepare('SELECT * FROM orgs ORDER BY id').all().filter(o => !o.is_test);
  const active = orgs.filter(o => o.subscription_status === 'active');
  const trialing = orgs.filter(o => o.subscription_status === 'trialing');
  const suspended = orgs.filter(o => o.subscription_status === 'suspended');
  const churned = orgs.filter(o => o.subscription_status === 'canceled' || o.subscription_status === 'past_due');

  const mrrCents = active.reduce((sum, o) => sum + (o.plan_price_cents || 39900), 0);

  return {
    mrr_cents: mrrCents,
    mrr_display: dollars(mrrCents),
    active_orgs: active.length,
    trialing_orgs: trialing.length,
    suspended_orgs: suspended.length,
    churned_orgs: churned.length,
    total_live_orgs: orgs.length,
    orgs_detail: orgs.map(o => ({
      id: o.id, name: o.name, status: o.subscription_status,
      plan_price_cents: o.plan_price_cents || 39900,
      trial_end: o.trial_end || null,
    })),
  };
}

function collectOrgActivity(sDb, week) {
  const orgs = sDb.prepare('SELECT * FROM orgs ORDER BY id').all().filter(o => !o.is_test);
  const orgStats = [];

  for (const org of orgs) {
    const db = tenantDb(org.id);
    if (!db) continue;

    try {
      // Candidates added this week
      let candidatesThisWeek = 0;
      try {
        candidatesThisWeek = db.prepare(
          "SELECT COUNT(*) AS n FROM candidates WHERE created_at >= ?"
        ).get(week.start).n;
      } catch { /* created_at might not exist in older DBs */ }

      const totalCandidates = db.prepare("SELECT COUNT(*) AS n FROM candidates").get().n;

      // JOs created this week
      let josThisWeek = 0;
      try {
        josThisWeek = db.prepare(
          "SELECT COUNT(*) AS n FROM job_orders WHERE created_at >= ?"
        ).get(week.start).n;
      } catch {}

      const totalJOs = db.prepare("SELECT COUNT(*) AS n FROM job_orders").get().n;
      const openJOs = db.prepare("SELECT COUNT(*) AS n FROM job_orders WHERE status = 'open'").get().n;

      // Blasts this week
      let blastsThisWeek = 0, blastSentCount = 0;
      try {
        const blastRows = db.prepare(
          "SELECT COUNT(*) AS n, COALESCE(SUM(sent_count), 0) AS sent FROM blasts WHERE sent_at >= ?"
        ).get(week.start);
        blastsThisWeek = blastRows.n;
        blastSentCount = blastRows.sent;
      } catch {}

      const totalBlasts = db.prepare("SELECT COUNT(*) AS n FROM blasts").get().n;

      // Interests this week
      let interestsThisWeek = 0;
      try {
        interestsThisWeek = db.prepare(
          "SELECT COUNT(*) AS n FROM interests WHERE created_at >= ?"
        ).get(week.start).n;
      } catch {}

      const totalInterests = db.prepare("SELECT COUNT(*) AS n FROM interests").get().n;

      // Pipeline status
      let pipeline = { interested: 0, yes_listed: 0, confirmed: 0, filled: 0 };
      try {
        const rows = db.prepare("SELECT status, COUNT(*) AS n FROM interests GROUP BY status").all();
        for (const r of rows) {
          if (pipeline.hasOwnProperty(r.status)) pipeline[r.status] = r.n;
        }
      } catch {}

      // AI costs this week (from tom_usage table)
      let aiCostThisWeek = 0;
      try {
        const usage = db.prepare(
          "SELECT COALESCE(SUM(estimated_cost), 0) AS cost FROM tom_usage WHERE created_at >= ?"
        ).get(week.start);
        aiCostThisWeek = Math.round(usage.cost * 100) / 100;
      } catch { /* tom_usage may not exist */ }

      orgStats.push({
        org_id: org.id,
        org_name: org.name,
        subscription_status: org.subscription_status,
        candidates: { total: totalCandidates, this_week: candidatesThisWeek },
        job_orders: { total: totalJOs, open: openJOs, this_week: josThisWeek },
        blasts: { total: totalBlasts, this_week: blastsThisWeek, texts_sent_this_week: blastSentCount },
        interests: { total: totalInterests, this_week: interestsThisWeek },
        pipeline,
        ai_cost_this_week: aiCostThisWeek,
      });
    } catch (err) {
      orgStats.push({ org_id: org.id, org_name: org.name, error: err.message });
    } finally {
      safeClose(db);
    }
  }

  return orgStats;
}

async function collectResumeLine(week) {
  let pool;
  try {
    const { Pool } = require('pg');
    pool = new Pool(RESUMELINE_DB);

    // Resumes generated this week
    const resumesWeek = await pool.query(
      "SELECT COUNT(*) AS n, COALESCE(SUM(retell_cost), 0) AS cost FROM resumeline_resumes WHERE created_at >= $1",
      [week.startISO]
    );

    // Total resumes all time
    const resumesTotal = await pool.query("SELECT COUNT(*) AS n FROM resumeline_resumes");

    // By org this week
    const byOrg = await pool.query(
      `SELECT o.name, COUNT(r.id) AS resumes, COALESCE(SUM(r.retell_cost), 0) AS cost
       FROM resumeline_resumes r JOIN resumeline_orgs o ON r.org_id = o.id
       WHERE r.created_at >= $1
       GROUP BY o.name ORDER BY resumes DESC`,
      [week.startISO]
    );

    // Active orgs
    const activeOrgs = await pool.query(
      "SELECT COUNT(*) AS n FROM resumeline_orgs WHERE status = 'active'"
    );

    // Gate holds (quality issues)
    const held = await pool.query(
      "SELECT COUNT(*) AS n FROM resumeline_resumes WHERE gate_held = true AND created_at >= $1",
      [week.startISO]
    );

    await pool.end();

    return {
      resumes_this_week: parseInt(resumesWeek.rows[0].n),
      retell_cost_this_week: Math.round(parseFloat(resumesWeek.rows[0].cost || 0) * 100) / 100,
      resumes_total: parseInt(resumesTotal.rows[0].n),
      active_orgs: parseInt(activeOrgs.rows[0].n),
      gate_holds_this_week: parseInt(held.rows[0].n),
      by_org: byOrg.rows.map(r => ({
        org_name: r.name,
        resumes: parseInt(r.resumes),
        retell_cost: Math.round(parseFloat(r.cost || 0) * 100) / 100,
      })),
    };
  } catch (err) {
    if (pool) try { await pool.end(); } catch {}
    return { error: err.message };
  }
}

function collectAICosts(week) {
  // Aggregate AI costs across all tenant DBs
  const orgDirs = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('org-') && f.endsWith('.db'));
  let totalCost = 0, totalCalls = 0;
  const byModel = {};

  for (const file of orgDirs) {
    let db;
    try {
      db = openDb(path.join(DATA_DIR, file));
      const rows = db.prepare(
        "SELECT model, COUNT(*) AS calls, SUM(estimated_cost) AS cost, SUM(input_tokens) AS inp, SUM(output_tokens) AS outp FROM tom_usage WHERE created_at >= ? GROUP BY model"
      ).all(week.start);
      for (const r of rows) {
        totalCost += r.cost || 0;
        totalCalls += r.calls;
        if (!byModel[r.model]) byModel[r.model] = { calls: 0, cost: 0, input_tokens: 0, output_tokens: 0 };
        byModel[r.model].calls += r.calls;
        byModel[r.model].cost += r.cost || 0;
        byModel[r.model].input_tokens += r.inp || 0;
        byModel[r.model].output_tokens += r.outp || 0;
      }
    } catch { /* tom_usage may not exist */ }
    safeClose(db);
  }

  return {
    total_cost: Math.round(totalCost * 100) / 100,
    total_calls: totalCalls,
    by_model: Object.entries(byModel).map(([model, d]) => ({
      model,
      calls: d.calls,
      cost: Math.round(d.cost * 100) / 100,
      input_tokens: d.input_tokens,
      output_tokens: d.output_tokens,
    })),
  };
}

function collectUptime(week) {
  // Read health-alerts.log if it exists
  const logPath = '/root/health-alerts.log';
  const incidents = [];
  try {
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        // Filter to this week's entries
        const dateMatch = line.match(/\d{4}-\d{2}-\d{2}/);
        if (dateMatch && dateMatch[0] >= week.start) {
          incidents.push(line.trim());
        }
      }
    }
  } catch {}

  // Check current health
  let currentHealth = 'unknown';
  try {
    const healthPath = path.join(DATA_DIR, 'health-check-state.json');
    if (fs.existsSync(healthPath)) {
      const state = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
      currentHealth = state.status || 'ok';
    }
  } catch {}

  return {
    current_status: currentHealth,
    incidents_this_week: incidents.length,
    incidents: incidents.slice(-10), // last 10
  };
}

async function collectPnL() {
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

    if (!apiRes.ok) return { error: 'QBO API returned ' + apiRes.status };

    const report = await apiRes.json();
    const rows = report.Rows?.Row || [];
    const sections = {};
    for (const row of rows) {
      if (row.group === 'Income' || row.group === 'CostOfGoodsSold' || row.group === 'Expenses') {
        const total = row.Summary?.ColData?.[1]?.value || '0';
        sections[row.group] = parseFloat(total);
      }
      if (row.group === 'NetIncome') {
        sections.NetIncome = parseFloat(row.Summary?.ColData?.[1]?.value || '0');
      }
    }

    return {
      period: startOfMonth + ' to ' + endOfMonth,
      income: sections.Income || 0,
      cogs: sections.CostOfGoodsSold || 0,
      expenses: sections.Expenses || 0,
      net_income: sections.NetIncome || 0,
      gross_profit: (sections.Income || 0) - (sections.CostOfGoodsSold || 0),
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ---- report config ----

function getReportConfig() {
  const configPath = path.join(DATA_DIR, 'weekly-report-config.json');
  const defaults = {
    recipients: ['joshuafriends@gmail.com', 'matt.tibbetts@expresspros.com'],
    from: 'josh@joblinkplatform.com',
    sections: {
      revenue: true,
      org_activity: true,
      resumeline: true,
      ai_costs: true,
      uptime: true,
      pnl: true,
    },
  };
  try {
    if (fs.existsSync(configPath)) {
      const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { ...defaults, ...stored };
    }
  } catch {}
  return defaults;
}

function saveReportConfig(config) {
  const configPath = path.join(DATA_DIR, 'weekly-report-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// ---- HTML email formatter ----

function formatEmailHTML(report) {
  const week = report.week;
  const rev = report.revenue;
  const rl = report.resumeline;
  const ai = report.ai_costs;
  const up = report.uptime;
  const pnl = report.pnl;

  let html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;margin-top:20px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,0.08)">

<!-- Header -->
<div style="background:#1a1a2e;padding:24px 32px;color:#fff">
  <h1 style="margin:0;font-size:22px;font-weight:600">KWF Weekly Report</h1>
  <p style="margin:4px 0 0;font-size:14px;opacity:0.8">${week.display}</p>
</div>

<div style="padding:24px 32px">`;

  // Revenue section
  if (report.config?.sections?.revenue !== false) {
    html += `
<!-- Revenue -->
<h2 style="font-size:16px;color:#1a1a2e;border-bottom:2px solid #6172f7;padding-bottom:6px;margin-top:0">Revenue</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px">
  <tr><td style="padding:6px 0;color:#555">MRR</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#1a1a2e">${rev.mrr_display}</td></tr>
  <tr><td style="padding:6px 0;color:#555">Active Orgs</td><td style="padding:6px 0;text-align:right;font-weight:600">${rev.active_orgs}</td></tr>
  <tr><td style="padding:6px 0;color:#555">Trialing</td><td style="padding:6px 0;text-align:right">${rev.trialing_orgs}</td></tr>
  <tr><td style="padding:6px 0;color:#555">Suspended</td><td style="padding:6px 0;text-align:right;${rev.suspended_orgs > 0 ? 'color:#e74c3c' : ''}">${rev.suspended_orgs}</td></tr>
  <tr><td style="padding:6px 0;color:#555">Churned</td><td style="padding:6px 0;text-align:right;${rev.churned_orgs > 0 ? 'color:#e74c3c' : ''}">${rev.churned_orgs}</td></tr>
</table>`;
  }

  // Org Activity section
  if (report.config?.sections?.org_activity !== false && report.org_activity) {
    html += `
<h2 style="font-size:16px;color:#1a1a2e;border-bottom:2px solid #6172f7;padding-bottom:6px">JobLink — Per Org Activity</h2>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
  <tr style="background:#f8f9fb">
    <th style="text-align:left;padding:8px 6px;color:#555;font-weight:600">Org</th>
    <th style="text-align:center;padding:8px 4px;color:#555;font-weight:600">Cands</th>
    <th style="text-align:center;padding:8px 4px;color:#555;font-weight:600">JOs</th>
    <th style="text-align:center;padding:8px 4px;color:#555;font-weight:600">Blasts</th>
    <th style="text-align:center;padding:8px 4px;color:#555;font-weight:600">Texts</th>
    <th style="text-align:center;padding:8px 4px;color:#555;font-weight:600">Interests</th>
  </tr>`;

    for (const org of report.org_activity) {
      if (org.error) continue;
      const statusColor = org.subscription_status === 'active' ? '#27ae60' :
                          org.subscription_status === 'trialing' ? '#f39c12' : '#e74c3c';
      html += `
  <tr style="border-bottom:1px solid #eee">
    <td style="padding:6px;font-weight:500">${org.org_name} <span style="color:${statusColor};font-size:11px">${org.subscription_status}</span></td>
    <td style="text-align:center;padding:6px">${org.candidates.this_week} <span style="color:#999;font-size:11px">(${org.candidates.total})</span></td>
    <td style="text-align:center;padding:6px">${org.job_orders.this_week} <span style="color:#999;font-size:11px">(${org.job_orders.open} open)</span></td>
    <td style="text-align:center;padding:6px">${org.blasts.this_week}</td>
    <td style="text-align:center;padding:6px">${org.blasts.texts_sent_this_week}</td>
    <td style="text-align:center;padding:6px">${org.interests.this_week} <span style="color:#999;font-size:11px">(${org.interests.total})</span></td>
  </tr>`;
    }
    html += '</table>';

    // Pipeline summary
    const totals = report.org_activity.reduce((acc, o) => {
      if (o.pipeline) {
        acc.interested += o.pipeline.interested;
        acc.yes_listed += o.pipeline.yes_listed;
        acc.confirmed += o.pipeline.confirmed;
        acc.filled += o.pipeline.filled;
      }
      return acc;
    }, { interested: 0, yes_listed: 0, confirmed: 0, filled: 0 });

    html += `
<div style="background:#f8f9fb;border-radius:6px;padding:12px 16px;margin-bottom:16px">
  <strong style="font-size:13px;color:#1a1a2e">Pipeline Totals</strong>
  <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:13px">
    <span>Interested: <strong>${totals.interested}</strong></span>
    <span>Yes-Listed: <strong>${totals.yes_listed}</strong></span>
    <span>Confirmed: <strong>${totals.confirmed}</strong></span>
    <span>Filled: <strong>${totals.filled}</strong></span>
  </div>
</div>`;
  }

  // ResumeLine section
  if (report.config?.sections?.resumeline !== false && rl) {
    if (rl.error) {
      html += `<h2 style="font-size:16px;color:#1a1a2e;border-bottom:2px solid #6172f7;padding-bottom:6px">ResumeLine</h2>
<p style="color:#e74c3c;font-size:13px">Data unavailable: ${rl.error}</p>`;
    } else {
      html += `
<h2 style="font-size:16px;color:#1a1a2e;border-bottom:2px solid #6172f7;padding-bottom:6px">ResumeLine</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:8px">
  <tr><td style="padding:6px 0;color:#555">Resumes This Week</td><td style="padding:6px 0;text-align:right;font-weight:600">${rl.resumes_this_week}</td></tr>
  <tr><td style="padding:6px 0;color:#555">Retell Cost This Week</td><td style="padding:6px 0;text-align:right">$${rl.retell_cost_this_week.toFixed(2)}</td></tr>
  <tr><td style="padding:6px 0;color:#555">Total Resumes (All Time)</td><td style="padding:6px 0;text-align:right">${rl.resumes_total}</td></tr>
  <tr><td style="padding:6px 0;color:#555">Active Orgs</td><td style="padding:6px 0;text-align:right">${rl.active_orgs}</td></tr>
  <tr><td style="padding:6px 0;color:#555">Gate Holds This Week</td><td style="padding:6px 0;text-align:right;${rl.gate_holds_this_week > 0 ? 'color:#e74c3c' : ''}">${rl.gate_holds_this_week}</td></tr>
</table>`;

      if (rl.by_org && rl.by_org.length > 0) {
        html += `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
  <tr style="background:#f8f9fb">
    <th style="text-align:left;padding:6px;color:#555;font-weight:600">Org</th>
    <th style="text-align:center;padding:6px;color:#555;font-weight:600">Resumes</th>
    <th style="text-align:right;padding:6px;color:#555;font-weight:600">Retell Cost</th>
  </tr>`;
        for (const o of rl.by_org) {
          html += `<tr style="border-bottom:1px solid #eee">
    <td style="padding:6px">${o.org_name}</td>
    <td style="text-align:center;padding:6px">${o.resumes}</td>
    <td style="text-align:right;padding:6px">$${o.retell_cost.toFixed(2)}</td>
  </tr>`;
        }
        html += '</table>';
      }
    }
  }

  // AI Costs section
  if (report.config?.sections?.ai_costs !== false && ai) {
    html += `
<h2 style="font-size:16px;color:#1a1a2e;border-bottom:2px solid #6172f7;padding-bottom:6px">AI Costs (JobLink Tom)</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:8px">
  <tr><td style="padding:6px 0;color:#555">Total Cost This Week</td><td style="padding:6px 0;text-align:right;font-weight:600">$${ai.total_cost.toFixed(2)}</td></tr>
  <tr><td style="padding:6px 0;color:#555">Total API Calls</td><td style="padding:6px 0;text-align:right">${ai.total_calls}</td></tr>
</table>`;

    if (ai.by_model && ai.by_model.length > 0) {
      html += `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
  <tr style="background:#f8f9fb">
    <th style="text-align:left;padding:6px;color:#555;font-weight:600">Model</th>
    <th style="text-align:center;padding:6px;color:#555;font-weight:600">Calls</th>
    <th style="text-align:right;padding:6px;color:#555;font-weight:600">Cost</th>
  </tr>`;
      for (const m of ai.by_model) {
        html += `<tr style="border-bottom:1px solid #eee">
    <td style="padding:6px;font-family:monospace;font-size:12px">${m.model}</td>
    <td style="text-align:center;padding:6px">${m.calls}</td>
    <td style="text-align:right;padding:6px">$${m.cost.toFixed(2)}</td>
  </tr>`;
      }
      html += '</table>';
    }
  }

  // Uptime section
  if (report.config?.sections?.uptime !== false && up) {
    const statusColor = up.current_status === 'ok' || up.current_status === 'unknown' ? '#27ae60' : '#e74c3c';
    html += `
<h2 style="font-size:16px;color:#1a1a2e;border-bottom:2px solid #6172f7;padding-bottom:6px">Uptime &amp; Incidents</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:8px">
  <tr><td style="padding:6px 0;color:#555">Current Status</td><td style="padding:6px 0;text-align:right;font-weight:600;color:${statusColor}">${up.current_status.toUpperCase()}</td></tr>
  <tr><td style="padding:6px 0;color:#555">Incidents This Week</td><td style="padding:6px 0;text-align:right">${up.incidents_this_week}</td></tr>
</table>`;

    if (up.incidents.length > 0) {
      html += '<div style="background:#fff5f5;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:12px;font-family:monospace">';
      for (const inc of up.incidents) {
        html += `<div style="padding:2px 0">${inc}</div>`;
      }
      html += '</div>';
    }
  }

  // P&L section
  if (report.config?.sections?.pnl !== false && pnl) {
    if (pnl.error) {
      html += `<h2 style="font-size:16px;color:#1a1a2e;border-bottom:2px solid #6172f7;padding-bottom:6px">P&amp;L (QBO)</h2>
<p style="color:#999;font-size:13px">Not available: ${pnl.error}</p>`;
    } else {
      html += `
<h2 style="font-size:16px;color:#1a1a2e;border-bottom:2px solid #6172f7;padding-bottom:6px">P&amp;L Snapshot — ${pnl.period}</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px">
  <tr><td style="padding:6px 0;color:#555">Revenue</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#27ae60">$${pnl.income.toFixed(2)}</td></tr>
  <tr><td style="padding:6px 0;color:#555">COGS</td><td style="padding:6px 0;text-align:right">$${pnl.cogs.toFixed(2)}</td></tr>
  <tr><td style="padding:6px 0;color:#555">Gross Profit</td><td style="padding:6px 0;text-align:right;font-weight:600">$${pnl.gross_profit.toFixed(2)}</td></tr>
  <tr><td style="padding:6px 0;color:#555">Operating Expenses</td><td style="padding:6px 0;text-align:right">$${pnl.expenses.toFixed(2)}</td></tr>
  <tr style="border-top:2px solid #1a1a2e"><td style="padding:8px 0;font-weight:700;color:#1a1a2e">Net Income</td><td style="padding:8px 0;text-align:right;font-weight:700;color:${pnl.net_income >= 0 ? '#27ae60' : '#e74c3c'}">$${pnl.net_income.toFixed(2)}</td></tr>
</table>`;
    }
  }

  // Footer
  html += `
</div>

<div style="background:#f8f9fb;padding:16px 32px;text-align:center;font-size:12px;color:#999">
  Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} Pacific<br>
  Kingdom Workforce LLC — JobLink + ResumeLine
</div>

</div>
</body></html>`;

  return html;
}

// ---- route factory ----

function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.org_id !== 1) {
    return res.status(403).json({ error: 'super_admin_only' });
  }
  next();
}

function createReportRoutes(auth) {
  const router = express.Router();
  if (auth) {
    router.use(auth.requireAuth);
  }
  router.use(requireSuperAdmin);

  // GET /api/weekly-report — generate the report JSON
  router.get('/api/weekly-report', async (_req, res) => {
    let sDb;
    try {
      const week = weekRange();
      sDb = systemDb();
      const config = getReportConfig();

      const revenue = collectRevenue(sDb);
      const orgActivity = collectOrgActivity(sDb, week);
      const aiCosts = collectAICosts(week);
      const uptime = collectUptime(week);

      // Async collectors
      const [resumeline, pnl] = await Promise.all([
        config.sections.resumeline ? collectResumeLine(week) : null,
        config.sections.pnl ? collectPnL() : null,
      ]);

      safeClose(sDb);

      const report = {
        generated_at: new Date().toISOString(),
        week,
        config,
        revenue,
        org_activity: orgActivity,
        resumeline,
        ai_costs: aiCosts,
        uptime,
        pnl,
      };

      res.json(report);
    } catch (err) {
      safeClose(sDb);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/weekly-report/send — generate + email the report
  router.post('/api/weekly-report/send', async (req, res) => {
    let sDb;
    try {
      const week = weekRange();
      sDb = systemDb();
      const config = getReportConfig();

      // Allow override recipients from request body
      const recipients = req.body?.recipients || config.recipients;
      const from = req.body?.from || config.from;

      const revenue = collectRevenue(sDb);
      const orgActivity = collectOrgActivity(sDb, week);
      const aiCosts = collectAICosts(week);
      const uptime = collectUptime(week);

      const [resumeline, pnl] = await Promise.all([
        config.sections.resumeline ? collectResumeLine(week) : null,
        config.sections.pnl ? collectPnL() : null,
      ]);

      safeClose(sDb);

      const report = {
        generated_at: new Date().toISOString(),
        week,
        config,
        revenue,
        org_activity: orgActivity,
        resumeline,
        ai_costs: aiCosts,
        uptime,
        pnl,
      };

      const htmlBody = formatEmailHTML(report);
      const subject = `KWF Weekly Report — ${week.display}`;

      // Send via Resend API
      const apiKey = RESEND_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
      }

      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `KWF Reports <${from}>`,
          to: recipients,
          subject,
          html: htmlBody,
        }),
      });

      const emailResult = await emailRes.json();

      if (!emailRes.ok) {
        return res.status(emailRes.status).json({
          error: 'Resend API error',
          detail: emailResult,
        });
      }

      res.json({
        ok: true,
        email_id: emailResult.id,
        sent_to: recipients,
        subject,
        report_summary: {
          mrr: revenue.mrr_display,
          active_orgs: revenue.active_orgs,
          resumeline_this_week: resumeline?.resumes_this_week || 0,
          ai_cost: aiCosts.total_cost,
          incidents: uptime.incidents_this_week,
        },
      });
    } catch (err) {
      safeClose(sDb);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/weekly-report/config — read config
  router.get('/api/weekly-report/config', (_req, res) => {
    try {
      res.json(getReportConfig());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/weekly-report/config — update config
  router.post('/api/weekly-report/config', (req, res) => {
    try {
      const current = getReportConfig();
      const updates = req.body || {};

      if (updates.recipients && Array.isArray(updates.recipients)) {
        current.recipients = updates.recipients;
      }
      if (updates.from) {
        current.from = updates.from;
      }
      if (updates.sections && typeof updates.sections === 'object') {
        current.sections = { ...current.sections, ...updates.sections };
      }

      saveReportConfig(current);
      res.json({ ok: true, config: current });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/weekly-report/preview — HTML preview of the email
  router.get('/api/weekly-report/preview', async (_req, res) => {
    let sDb;
    try {
      const week = weekRange();
      sDb = systemDb();
      const config = getReportConfig();

      const revenue = collectRevenue(sDb);
      const orgActivity = collectOrgActivity(sDb, week);
      const aiCosts = collectAICosts(week);
      const uptime = collectUptime(week);

      const [resumeline, pnl] = await Promise.all([
        config.sections.resumeline ? collectResumeLine(week) : null,
        config.sections.pnl ? collectPnL() : null,
      ]);

      safeClose(sDb);

      const report = {
        generated_at: new Date().toISOString(),
        week,
        config,
        revenue,
        org_activity: orgActivity,
        resumeline,
        ai_costs: aiCosts,
        uptime,
        pnl,
      };

      res.setHeader('Content-Type', 'text/html');
      res.send(formatEmailHTML(report));
    } catch (err) {
      safeClose(sDb);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createReportRoutes };
