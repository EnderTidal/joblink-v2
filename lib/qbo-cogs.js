// lib/qbo-cogs.js — COGS calculator for KWF
// Pulls costs from ResumeLine (PostgreSQL on Hostinger) and JobLink (SQLite per-tenant)
const { Client } = require("pg");
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const qbo = require("./qbo-client");

const RESUMELINE_DB = {
  host: "127.0.0.1",
  port: 5432,
  user: "billyfit_admin",
  password: "Kx9mP4vR7nWqY2sL8jF6hT3bA5cE1dG0",
  database: "resumeline_prod",
};

const DATA_DIR = path.join(__dirname, "..", "data");

/**
 * Get ResumeLine Retell costs for a given org and month.
 * @param {number} orgId - ResumeLine org ID
 * @param {string} month - YYYY-MM format
 * @returns {{ count: number, total: number, calls: Array }}
 */
async function getResumeLineCosts(orgId, month) {
  const client = new Client(RESUMELINE_DB);
  try {
    await client.connect();
    const startDate = `${month}-01`;
    // Get last day of month
    const [y, m] = month.split("-").map(Number);
    const endDate = new Date(y, m, 0).toISOString().split("T")[0];

    const result = await client.query(
      `SELECT count(*) as cnt, coalesce(sum(retell_cost), 0) as total
       FROM resumeline_resumes
       WHERE org_id = $1
         AND created_at >= $2::date
         AND created_at < ($3::date + interval '1 day')`,
      [orgId, startDate, endDate]
    );

    return {
      count: parseInt(result.rows[0].cnt),
      total: parseFloat(result.rows[0].total),
    };
  } finally {
    await client.end();
  }
}

/**
 * Get all ResumeLine costs across all orgs for a month.
 */
async function getAllResumeLineCosts(month) {
  const client = new Client(RESUMELINE_DB);
  try {
    await client.connect();
    const startDate = `${month}-01`;
    const [y, m] = month.split("-").map(Number);
    const endDate = new Date(y, m, 0).toISOString().split("T")[0];

    const result = await client.query(
      `SELECT org_id, count(*) as cnt, coalesce(sum(retell_cost), 0) as total
       FROM resumeline_resumes
       WHERE created_at >= $1::date
         AND created_at < ($2::date + interval '1 day')
       GROUP BY org_id
       ORDER BY org_id`,
      [startDate, endDate]
    );

    return result.rows.map((r) => ({
      org_id: r.org_id,
      count: parseInt(r.cnt),
      total: parseFloat(r.total),
    }));
  } finally {
    await client.end();
  }
}

/**
 * Calculate Matt's monthly COGS (org_id=1).
 * Returns a breakdown for invoicing.
 */
async function calculateMattCogs(month) {
  // ResumeLine costs
  const rl = await getResumeLineCosts(1, month);

  // JobLink costs — currently no AI metering, so estimate from blast/parse counts
  // This will be enhanced when tom_usage tracking is added
  const jlCost = 0; // Placeholder until AI metering is built

  const total = rl.total + jlCost;
  const [y, m] = month.split("-").map(Number);
  const dueDate = new Date(y, m, 14).toISOString().split("T")[0]; // Net 15 from month end

  return {
    month,
    org_name: "Express Employment - Waxahachie",
    resumeline: {
      calls: rl.count,
      retell_cost: rl.total,
    },
    joblink: {
      ai_cost: jlCost,
      note: "AI usage metering not yet implemented — $0 until tom_usage tracking is built",
    },
    total,
    doc_number: `KWF-COGS-${month}`,
    due_date: dueDate,
  };
}

/**
 * Calculate and create a QBO invoice for Matt's COGS.
 * @param {string} month - YYYY-MM
 * @param {object} opts - { customerId, dryRun, sendEmail }
 */
async function invoiceMattCogs(month, opts = {}) {
  const { customerId, dryRun = false, sendEmail = false } = opts;

  const cogs = await calculateMattCogs(month);

  if (cogs.total === 0) {
    return { skipped: true, reason: "Zero COGS for " + month, cogs };
  }

  const lineItems = [];

  if (cogs.resumeline.retell_cost > 0) {
    lineItems.push({
      description: `ResumeLine — Retell voice costs (${cogs.resumeline.calls} calls)`,
      amount: Math.round(cogs.resumeline.retell_cost * 100) / 100,
    });
  }

  if (cogs.joblink.ai_cost > 0) {
    lineItems.push({
      description: `JobLink — AI usage (Tom assistant)`,
      amount: Math.round(cogs.joblink.ai_cost * 100) / 100,
    });
  }

  if (dryRun) {
    return {
      dryRun: true,
      cogs,
      lineItems,
      doc_number: cogs.doc_number,
      due_date: cogs.due_date,
    };
  }

  if (!customerId) {
    throw new Error("customerId required for live invoice. Run qbo-setup.js first to create the customer.");
  }

  const invoice = await qbo.createInvoice({
    customerId,
    lineItems,
    docNumber: cogs.doc_number,
    dueDate: cogs.due_date,
    memo: `KWF COGS for ${month} — auto-generated`,
  });

  let emailResult = null;
  if (sendEmail && invoice.Id) {
    emailResult = await qbo.emailInvoice(invoice.Id, "matt.tibbetts@expresspros.com");
  }

  return {
    created: true,
    invoice_id: invoice.Id,
    doc_number: invoice.DocNumber,
    total: invoice.TotalAmt,
    emailed: !!emailResult,
    cogs,
  };
}

module.exports = {
  getResumeLineCosts,
  getAllResumeLineCosts,
  calculateMattCogs,
  invoiceMattCogs,
};
