// Signup — self-service org creation via Stripe Checkout.
// Flow: POST /api/signup -> Stripe Checkout -> GET /api/signup/success -> org created
// Webhook: POST /webhooks/stripe -> subscription lifecycle events

const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const {
  findUserByEmail, createOrg, createPendingSignup, findPendingBySession,
  findPendingByEmail, deletePendingSignup, updateOrgBilling, findOrgByStripeCustomer,
} = require('../src/system-db');
const { createTenantDb } = require('../src/tenant');

function createSignupRoutes(sysDb) {
  const Stripe = require('stripe');
  const stripe = new Stripe(process.env.STRIPE_SK);

  const PRICE_ID = process.env.STRIPE_PRICE_ID;
  const BASE_URL = process.env.BASE_URL || 'https://v2.joblinkplatform.com';

  const router = express.Router();

  // ---- POST /api/signup — validate + create Stripe Checkout session ----
  router.post('/api/signup', async (req, res) => {
    try {
      const { org_name, display_name, email, password } = req.body || {};

      // Validate
      if (!org_name || !display_name || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
      }
      if (!String(email).includes('@') || !String(email).includes('.')) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
      if (String(password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      // Check email not taken
      const existing = findUserByEmail(sysDb, email);
      if (existing) {
        return res.status(400).json({ error: 'An account with this email already exists' });
      }

      // Check not already pending — delete old and create fresh
      const pending = findPendingByEmail(sysDb, email);
      if (pending) {
        deletePendingSignup(sysDb, pending.id);
      }

      // Create Stripe customer
      const customer = await stripe.customers.create({
        email: String(email),
        name: String(display_name),
        metadata: { org_name: String(org_name) },
      });

      // Create Stripe Checkout session with 7-day trial
      const session = await stripe.checkout.sessions.create({
        customer: customer.id,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: PRICE_ID, quantity: 1 }],
        subscription_data: {
          trial_period_days: 7,
        },
        success_url: BASE_URL + '/api/signup/success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: BASE_URL + '/signup.html?cancelled=1',
        automatic_tax: { enabled: !process.env.STRIPE_SK.includes("_test_") },
        customer_update: { address: 'auto' },
        allow_promotion_codes: true,
      });

      // Store pending signup (don't create org until payment confirmed)
      const passwordHash = bcrypt.hashSync(String(password), 10);
      createPendingSignup(sysDb, {
        email: String(email),
        org_name: String(org_name),
        display_name: String(display_name),
        password_hash: passwordHash,
        stripe_customer_id: customer.id,
        stripe_session_id: session.id,
      });

      res.json({ url: session.url });
    } catch (err) {
      console.error('[signup]', err.message);
      res.status(500).json({ error: 'Signup failed. Please try again.' });
    }
  });

  // ---- GET /api/signup/success — Stripe redirects here after checkout ----
  router.get('/api/signup/success', async (req, res) => {
    try {
      const { session_id } = req.query;
      if (!session_id) return res.redirect('/signup.html?error=missing_session');

      // Verify Stripe session
      const session = await stripe.checkout.sessions.retrieve(session_id);
      if (!session || (session.payment_status === 'unpaid' && !session.subscription)) {
        return res.redirect('/signup.html?error=payment_failed');
      }

      // Find pending signup
      const pending = findPendingBySession(sysDb, session_id);
      if (!pending) {
        // Already processed or expired — just redirect to login
        return res.redirect('/login.html?signup=already_done');
      }

      // Create org
      const slug = String(pending.org_name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org-' + Date.now();
      let org;
      try {
        org = createOrg(sysDb, { name: pending.org_name, slug });
      } catch (e) {
        // Slug collision — append random suffix
        org = createOrg(sysDb, { name: pending.org_name, slug: slug + '-' + crypto.randomBytes(3).toString('hex') });
      }

      // Update org with Stripe info
      const sub = session.subscription ? await stripe.subscriptions.retrieve(session.subscription) : null;
      updateOrgBilling(sysDb, org.id, {
        stripe_customer_id: pending.stripe_customer_id,
        stripe_subscription_id: session.subscription || null,
        subscription_status: sub ? sub.status : 'trialing',
        trial_end: sub && sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
      });

      // Create admin user
      const username = String(pending.email).split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
      try {
        sysDb.prepare(
          'INSERT INTO users (org_id, username, password_hash, role, email, email_verified, display_name) VALUES (?, ?, ?, ?, ?, 1, ?)'
        ).run(org.id, username, pending.password_hash, 'admin', pending.email, pending.display_name);
      } catch {
        // Username collision — append random
        sysDb.prepare(
          'INSERT INTO users (org_id, username, password_hash, role, email, email_verified, display_name) VALUES (?, ?, ?, ?, ?, 1, ?)'
        ).run(org.id, username + crypto.randomBytes(2).toString('hex'), pending.password_hash, 'admin', pending.email, pending.display_name);
      }

      // Create tenant DB
      createTenantDb(org.id);

      // Delete pending signup
      deletePendingSignup(sysDb, pending.id);

      // Send welcome email
      try {
        const { sendEmail } = require('./auth');
        await sendEmail(pending.email, 'Welcome to JobLink!',
          '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px">' +
          '<h2 style="color:#6172f7">Welcome to JobLink!</h2>' +
          '<p>Your organization <strong>' + pending.org_name + '</strong> is ready to go.</p>' +
          '<p>Your 7-day free trial has started. You will be charged $399/mo after the trial ends.</p>' +
          '<p><a href="' + BASE_URL + '/login.html" style="display:inline-block;background:#6172f7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Log In</a></p>' +
          '<p style="color:#94a3b8;font-size:14px">Questions? Reply to this email or reach out anytime.</p>' +
          '</div>'
        );
      } catch (e) {
        console.error('[signup-welcome-email]', e.message);
      }

      console.log('[signup] New org created: ' + pending.org_name + ' (org ' + org.id + ') - ' + pending.email);
      res.redirect('/login.html?signup=success');
    } catch (err) {
      console.error('[signup-success]', err.message);
      res.redirect('/signup.html?error=processing_failed');
    }
  });

  // ---- GET /api/signup/cancel — redirect back ----
  router.get('/api/signup/cancel', (_req, res) => {
    res.redirect('/signup.html?cancelled=1');
  });

  return router;
}

// ---- Stripe webhook handler (separate — needs raw body) ----
function createStripeWebhook(sysDb) {
  const Stripe = require('stripe');
  const stripe = new Stripe(process.env.STRIPE_SK);
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

  const router = express.Router();

  router.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try {
      if (WEBHOOK_SECRET) {
        event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRET);
      } else {
        event = JSON.parse(req.body.toString());
        console.warn('[stripe-webhook] No STRIPE_WEBHOOK_SECRET - skipping signature verification');
      }
    } catch (err) {
      console.error('[stripe-webhook] Signature verification failed:', err.message);
      return res.status(400).send('Webhook signature verification failed');
    }

    console.log('[stripe-webhook] ' + event.type);

    try {
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const sub = event.data.object;
          const org = findOrgByStripeCustomer(sysDb, sub.customer);
          if (!org) { console.warn('[stripe-webhook] No org for customer', sub.customer); break; }
          updateOrgBilling(sysDb, org.id, {
            stripe_subscription_id: sub.id,
            subscription_status: sub.status,
            trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
          });
          console.log('[stripe-webhook] Org ' + org.id + ' subscription: ' + sub.status);
          break;
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          const org = findOrgByStripeCustomer(sysDb, sub.customer);
          if (!org) break;
          updateOrgBilling(sysDb, org.id, {
            subscription_status: 'canceled',
          });
          console.log('[stripe-webhook] Org ' + org.id + ' subscription canceled');
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const org = findOrgByStripeCustomer(sysDb, invoice.customer);
          if (!org) break;
          updateOrgBilling(sysDb, org.id, {
            subscription_status: 'past_due',
          });
          console.log('[stripe-webhook] Org ' + org.id + ' payment failed - marked past_due');
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('[stripe-webhook] Handler error:', err.message);
    }

    res.json({ received: true });
  });

  return router;
}

module.exports = { createSignupRoutes, createStripeWebhook };
