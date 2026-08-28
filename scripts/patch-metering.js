// Patch parse-job-order.js to log AI usage, and dev.js for usage endpoints
const fs = require('fs');

// 1. Patch parse-job-order.js — add usage logging to parseWithClaude
const aiPath = '/root/joblink-v2/src/ai/parse-job-order.js';
let aiCode = fs.readFileSync(aiPath, 'utf8');

if (aiCode.includes('ai-metering')) {
  console.log('parse-job-order.js already patched — skipping');
} else {
  // Add metering import at top
  aiCode = "const { logUsage } = require('../../lib/ai-metering');\n" + aiCode;

  // Replace parseWithClaude to capture usage from response
  // The key change: msg.usage contains input_tokens and output_tokens
  aiCode = aiCode.replace(
    "  return { fields, engine: 'claude', warnings };",
    `  // Log usage for metering (orgId passed via _meteringOrgId on the function)
  if (parseWithClaude._meteringOrgId) {
    const model = process.env.JOBLINK_PARSE_MODEL || 'claude-haiku-4-5';
    logUsage(parseWithClaude._meteringOrgId, {
      model,
      operation: 'parse_job_order',
      inputTokens: msg.usage?.input_tokens || 0,
      outputTokens: msg.usage?.output_tokens || 0,
    });
  }
  return { fields, engine: 'claude', warnings };`
  );

  // Update parseJobOrderText to accept orgId and pass it through
  aiCode = aiCode.replace(
    'async function parseJobOrderText(text) {',
    'async function parseJobOrderText(text, orgId) {'
  );
  aiCode = aiCode.replace(
    "try { return await parseWithClaude(clean); }",
    "try { parseWithClaude._meteringOrgId = orgId || null; return await parseWithClaude(clean); }"
  );

  fs.writeFileSync(aiPath, aiCode);
  console.log('Patched parse-job-order.js with AI metering');
}

// 2. Patch tom.js to pass orgId to parseJobOrderText
const tomPath = '/root/joblink-v2/src/tom.js';
let tomCode = fs.readFileSync(tomPath, 'utf8');

if (tomCode.includes('_orgId')) {
  console.log('tom.js already patched — skipping');
} else {
  // createTom needs to accept orgId
  tomCode = tomCode.replace(
    'function createTom(db) {',
    'function createTom(db, _orgId) {'
  );

  // Pass orgId to parseJobOrderText
  tomCode = tomCode.replace(
    'const parsed = await parseJobOrderText(docText);',
    'const parsed = await parseJobOrderText(docText, _orgId);'
  );

  fs.writeFileSync(tomPath, tomCode);
  console.log('Patched tom.js to pass orgId to AI parser');
}

// 3. Patch routes/tom.js — getTom passes orgId to createTom
const tomRoutePath = '/root/joblink-v2/routes/tom.js';
let tomRouteCode = fs.readFileSync(tomRoutePath, 'utf8');

if (tomRouteCode.includes('createTom(db, orgId)')) {
  console.log('routes/tom.js already patched — skipping');
} else {
  // getTom(db, orgId) already has orgId — just pass it to createTom
  tomRouteCode = tomRouteCode.replace(
    'const tom = createTom(db);',
    'const tom = createTom(db, orgId);'
  );
  fs.writeFileSync(tomRoutePath, tomRouteCode);
  console.log('Patched routes/tom.js to pass orgId to createTom');
}

// 4. Add usage endpoints to dev.js
const devPath = '/root/joblink-v2/routes/dev.js';
let devCode = fs.readFileSync(devPath, 'utf8');

if (devCode.includes('/api/qbo/ai-usage')) {
  console.log('dev.js already has AI usage endpoints — skipping');
} else {
  const usageRoutes = `
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

`;
  devCode = devCode.replace('  // ======= QBO FINANCIAL ROUTES =======', '  // ======= QBO FINANCIAL ROUTES =======\n' + usageRoutes);
  fs.writeFileSync(devPath, devCode);
  console.log('Patched dev.js with AI usage endpoints');
}

console.log('All metering patches complete.');
