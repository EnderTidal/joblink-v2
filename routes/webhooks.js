// Whippy inbound webhook handler — processes STOP/opt-out messages and logs
// inbound SMS. Multi-tenant: searches all org DBs for the phone number since
// Whippy doesn't send an org_id.

const express = require('express');
const { normalizePhone } = require('../src/phone');
const { markDoNotContact } = require('../src/blast');
const { getTenantDb } = require('../src/tenant');

const WEBHOOK_SECRET = 'whk_8f3a2c9d4e1b6075';
const STOP_WORDS = /^(stop|unsubscribe|cancel|quit|end)$/i;

function ts() {
  return new Date().toISOString();
}

/**
 * Search all tenant DBs for a candidate by normalized phone.
 * Returns { orgId, candidate } or null.
 */
function findCandidateAcrossOrgs(sysDb, phone) {
  const orgs = sysDb.prepare('SELECT id FROM orgs ORDER BY id').all();
  for (const org of orgs) {
    try {
      const db = getTenantDb(org.id);
      const candidate = db.prepare('SELECT * FROM candidates WHERE phone = ?').get(phone);
      if (candidate) return { orgId: org.id, candidate, db };
    } catch (e) {
      // Tenant DB might not exist yet for new orgs — skip
      continue;
    }
  }
  return null;
}

function createWebhookRoutes(sysDb) {
  const router = express.Router();

  router.post('/webhooks/whippy/inbound', express.json(), (req, res) => {
    // 1. Verify secret
    if (req.query.secret !== WEBHOOK_SECRET) {
      console.log(`[webhook] ${ts()} REJECTED — invalid secret`);
      return res.status(401).json({ error: 'invalid_secret' });
    }

    // Respond 200 immediately — Whippy retries on timeout
    res.json({ received: true });

    // 2. Parse payload
    const event = req.body.event;
    const data = req.body.data || {};
    const contact = data.contact || {};
    const message = data.message || {};
    const rawPhone = contact.phone || data.from || '';
    const body = (message.body || '').trim();

    const phone = normalizePhone(rawPhone);

    console.log(`[webhook] ${ts()} event=${event} phone=${rawPhone} normalized=${phone} body="${body}"`);

    if (!phone) {
      console.log(`[webhook] ${ts()} SKIP — could not normalize phone: ${rawPhone}`);
      return;
    }

    // 3. Process STOP/opt-out
    if (STOP_WORDS.test(body)) {
      const match = findCandidateAcrossOrgs(sysDb, phone);
      if (match) {
        markDoNotContact(match.db, phone, true);
        console.log(`[webhook] ${ts()} DNC — marked ${phone} as do_not_contact in org ${match.orgId}`);
      } else {
        console.log(`[webhook] ${ts()} DNC — phone ${phone} not found in any org DB`);
      }
    } else {
      console.log(`[webhook] ${ts()} LOGGED — inbound message from ${phone}, no action taken`);
    }
  });

  return router;
}

module.exports = { createWebhookRoutes };
