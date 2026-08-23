// Billing middleware — checks org subscription status on authenticated routes.
// Grandfathered orgs (id = 1) skip billing checks entirely.
// Exempt paths: login, logout, signup, billing, webhooks.

const { getOrg } = require('../src/system-db');

const EXEMPT_PATHS = [
  '/api/login', '/api/logout', '/api/signup', '/api/me',
  '/api/billing', '/webhooks/',
  '/api/invite', '/api/forgot-password', '/api/reset-password',
  '/api/magic-login',
];

function billingMiddleware(sysDb) {
  return (req, res, next) => {
    // Skip for non-API routes
    if (!req.path.startsWith('/api/')) return next();

    // Skip exempt paths
    for (const exempt of EXEMPT_PATHS) {
      if (req.path.startsWith(exempt)) return next();
    }

    // Need auth info
    if (!req.user || !req.user.org_id) return next();

    // Grandfathered org — always pass
    if (req.user.org_id === 1) return next();

    const org = getOrg(sysDb, req.user.org_id);
    if (!org) return next();

    const status = org.subscription_status;

    // Active or trialing with valid trial = pass
    if (status === 'active') return next();

    if (status === 'trialing') {
      if (org.trial_end) {
        const trialEnd = new Date(org.trial_end);
        if (trialEnd > new Date()) return next();
        // Trial expired — block
      } else {
        // No trial_end set — allow (legacy org or just created)
        return next();
      }
    }

    // past_due gets a grace period warning but still access (for now)
    if (status === 'past_due') {
      res.setHeader('X-Billing-Warning', 'payment_failed');
      return next();
    }

    // canceled, unpaid, or expired trial — block with 402
    return res.status(402).json({
      error: 'subscription_required',
      message: 'Your subscription is inactive. Please update your billing to continue.',
      billing_url: '/billing.html',
    });
  };
}

module.exports = { billingMiddleware };
