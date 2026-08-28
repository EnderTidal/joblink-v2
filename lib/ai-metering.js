// lib/ai-metering.js — Log AI API usage per org for COGS tracking
// Creates tom_usage table in each tenant's SQLite DB
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Anthropic pricing (per million tokens)
const PRICING = {
  'claude-haiku-4-5':     { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6':    { input: 3.00, output: 15.00 },
  'claude-sonnet-4-5':    { input: 3.00, output: 15.00 },
  'claude-opus-4-6':      { input: 15.00, output: 75.00 },
};

function estimateCost(model, inputTokens, outputTokens) {
  const p = PRICING[model] || PRICING['claude-haiku-4-5'];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tom_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      operation TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/**
 * Log an AI API call to the tenant's SQLite DB.
 * @param {number} orgId - The org that triggered the call
 * @param {object} params - { model, operation, inputTokens, outputTokens }
 */
function logUsage(orgId, { model, operation, inputTokens, outputTokens }) {
  try {
    const dbPath = path.join(DATA_DIR, `org-${orgId}.db`);
    if (!fs.existsSync(dbPath)) return; // tenant DB doesn't exist yet
    const db = new DatabaseSync(dbPath);
    ensureTable(db);
    const cost = estimateCost(model, inputTokens, outputTokens);
    db.prepare(
      'INSERT INTO tom_usage (model, operation, input_tokens, output_tokens, estimated_cost) VALUES (?, ?, ?, ?, ?)'
    ).run(model, operation, inputTokens, outputTokens, cost);
    db.close();
  } catch (err) {
    console.error('[ai-metering] Failed to log usage for org', orgId, err.message);
  }
}

/**
 * Get usage summary for an org and month.
 * @param {number} orgId
 * @param {string} month - YYYY-MM format
 * @returns {{ totalCalls, inputTokens, outputTokens, estimatedCost, byOperation }}
 */
function getUsageSummary(orgId, month) {
  try {
    const dbPath = path.join(DATA_DIR, `org-${orgId}.db`);
    if (!fs.existsSync(dbPath)) return { totalCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, byOperation: [] };
    const db = new DatabaseSync(dbPath);
    ensureTable(db);

    const startDate = `${month}-01`;
    const [y, m] = month.split('-').map(Number);
    const endDate = new Date(y, m, 0).toISOString().split('T')[0];

    const summary = db.prepare(`
      SELECT count(*) as total_calls,
             coalesce(sum(input_tokens), 0) as input_tokens,
             coalesce(sum(output_tokens), 0) as output_tokens,
             coalesce(sum(estimated_cost), 0) as estimated_cost
      FROM tom_usage
      WHERE created_at >= ? AND created_at < date(?, '+1 day')
    `).get(startDate, endDate);

    const byOp = db.prepare(`
      SELECT operation, count(*) as calls,
             sum(input_tokens) as input_tokens,
             sum(output_tokens) as output_tokens,
             sum(estimated_cost) as estimated_cost
      FROM tom_usage
      WHERE created_at >= ? AND created_at < date(?, '+1 day')
      GROUP BY operation
    `).all(startDate, endDate);

    db.close();

    return {
      totalCalls: summary.total_calls,
      inputTokens: summary.input_tokens,
      outputTokens: summary.output_tokens,
      estimatedCost: summary.estimated_cost,
      byOperation: byOp,
    };
  } catch (err) {
    console.error('[ai-metering] Failed to get summary for org', orgId, err.message);
    return { totalCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, byOperation: [] };
  }
}

/**
 * Get usage across ALL orgs for a given month.
 */
function getAllOrgUsage(month) {
  const results = [];
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.match(/^org-\d+\.db$/));
    for (const file of files) {
      const orgId = parseInt(file.match(/org-(\d+)/)[1]);
      const usage = getUsageSummary(orgId, month);
      if (usage.totalCalls > 0) {
        results.push({ orgId, ...usage });
      }
    }
  } catch (err) {
    console.error('[ai-metering] getAllOrgUsage error:', err.message);
  }
  return results;
}

module.exports = { logUsage, getUsageSummary, getAllOrgUsage, estimateCost, PRICING };
