// Add Stripe balance transactions endpoint to dev.js
const fs = require('fs');
const path = '/root/joblink-v2/routes/dev.js';
let code = fs.readFileSync(path, 'utf8');

if (code.includes('/api/qbo/stripe')) {
  console.log('Already patched — skipping');
  process.exit(0);
}

const stripeRoute = `
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

`;

// Insert before the return router
code = code.replace('  // ======= QBO FINANCIAL ROUTES =======', '  // ======= QBO FINANCIAL ROUTES =======\n' + stripeRoute);

fs.writeFileSync(path, code);
console.log('Patched dev.js with Stripe endpoint');
