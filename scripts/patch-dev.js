// Script to patch /root/joblink-v2/routes/dev.js with QBO financial routes
const fs = require('fs');
const path = '/root/joblink-v2/routes/dev.js';
let code = fs.readFileSync(path, 'utf8');

// Check if already patched
if (code.includes('/api/qbo/health')) {
  console.log('Already patched — skipping');
  process.exit(0);
}

const qboRoutes = `
  // ======= QBO FINANCIAL ROUTES =======

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

      const url = \`https://quickbooks.api.intuit.com/v3/company/\${realmId}/reports/ProfitAndLoss?start_date=\${startOfMonth}&end_date=\${endOfMonth}&minorversion=73\`;
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

`;

const parseFunction = `
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

`;

// Insert QBO routes before "return router;"
code = code.replace('  return router;', qboRoutes + '  return router;');

// Insert parseQboPnl before "module.exports"
code = code.replace('module.exports', parseFunction + 'module.exports');

fs.writeFileSync(path, code);
console.log('Patched dev.js with QBO financial routes');
