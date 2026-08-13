// Candidate-facing routes — the magic link page. Multi-tenant: resolves the
// tenant DB by scanning for the magic token across all org databases.

const express = require('express');
const { renderCandidatePage, markInterest } = require('../src/candidate-page');
const { logInterestEvent } = require('../src/db');
const { listOrgs, findOrgBySlug } = require('../src/system-db');
const { getTenantDb } = require('../src/tenant');

/** Find the candidate and their tenant DB by magic token. */
function findCandidateByToken(sysDb, token) {
  const orgs = listOrgs(sysDb);
  for (const org of orgs) {
    try {
      const db = getTenantDb(org.id);
      const candidate = db.prepare('SELECT * FROM candidates WHERE magic_token = ?').get(token);
      if (candidate) return { candidate, db, org };
    } catch { /* tenant DB might not exist yet */ }
  }
  return { candidate: null, db: null };
}

function createPublicRoutes(sysDb) {
  const router = express.Router();

  // Preview mode — shows all published JOs as a candidate would see them
  // For preview, use org-1 by default (or accept an org query param)
  router.get('/m/preview', (req, res) => {
    if (!req.query.org) return res.status(400).send('<h1>Missing organization</h1><p>Preview requires an <code>?org=</code> parameter.</p>');
    const orgId = Number(req.query.org);
    try {
      const db = getTenantDb(orgId);
      const { renderPreviewPage } = require('../src/candidate-page');
      res.send(renderPreviewPage(db, req.query.category));
    } catch (e) {
      res.status(404).send('<h1>Organization not found</h1>');
    }
  });


  // Fast O(1) lookup: new magic links include the org slug
  router.get('/m/:slug/:token', (req, res) => {
    const org = findOrgBySlug(sysDb, req.params.slug);
    if (!org) return res.status(404).send('<h1>Link not found</h1><p>This link may have expired. Reply to our text and we will send a fresh one.</p>');
    try {
      const db = getTenantDb(org.id);
      const candidate = db.prepare('SELECT * FROM candidates WHERE magic_token = ?').get(req.params.token);
      if (!candidate) return res.status(404).send('<h1>Link not found</h1><p>This link may have expired. Reply to our text and we will send a fresh one.</p>');
      res.send(renderCandidatePage(db, candidate, org.name));
    } catch {
      return res.status(404).send('<h1>Link not found</h1>');
    }
  });

  router.post('/m/:slug/:token/interest', express.json(), (req, res) => {
    const org = findOrgBySlug(sysDb, req.params.slug);
    if (!org) return res.status(404).json({ ok: false, error: 'not_found' });
    try {
      const db = getTenantDb(org.id);
      const candidate = db.prepare('SELECT * FROM candidates WHERE magic_token = ?').get(req.params.token);
      if (!candidate) return res.status(404).json({ ok: false, error: 'not_found' });
      const result = markInterest(db, candidate, Number(req.body?.job_order_id));
      res.status(result.ok ? 200 : 400).json(result);
    } catch {
      res.status(404).json({ ok: false, error: 'not_found' });
    }
  });

  router.delete('/m/:slug/:token/interest', express.json(), (req, res) => {
    const org = findOrgBySlug(sysDb, req.params.slug);
    if (!org) return res.status(404).json({ ok: false, error: 'not_found' });
    try {
      const db = getTenantDb(org.id);
      const candidate = db.prepare('SELECT * FROM candidates WHERE magic_token = ?').get(req.params.token);
      if (!candidate) return res.status(404).json({ ok: false, error: 'not_found' });
      const joId = Number(req.body?.job_order_id);
      // Log the removal event before deleting
      const existing = db.prepare('SELECT status FROM interests WHERE phone = ? AND job_order_id = ?').get(candidate.phone, joId);
      if (existing) {
        logInterestEvent(db, candidate.phone, joId, existing.status, 'withdrawn', 'candidate');
      }
      db.prepare('DELETE FROM interests WHERE phone = ? AND job_order_id = ?').run(candidate.phone, joId);
      res.json({ ok: true });
    } catch {
      res.status(404).json({ ok: false, error: 'not_found' });
    }
  });

  // Backward compat: old links without slug scan all orgs
  router.get('/m/:token', (req, res) => {
    const { candidate, db, org } = findCandidateByToken(sysDb, req.params.token);
    if (!candidate || !db) return res.status(404).send('<h1>Link not found</h1><p>This link may have expired. Reply to our text and we\'ll send a fresh one.</p>');
    res.send(renderCandidatePage(db, candidate, org.name));
  });

  router.post('/m/:token/interest', express.json(), (req, res) => {
    const { candidate, db } = findCandidateByToken(sysDb, req.params.token);
    if (!candidate || !db) return res.status(404).json({ ok: false, error: 'not_found' });
    const result = markInterest(db, candidate, Number(req.body?.job_order_id));
    res.status(result.ok ? 200 : 400).json(result);
  });



  // Remove interest (toggle off)
  router.delete('/m/:token/interest', express.json(), (req, res) => {
    const { candidate, db } = findCandidateByToken(sysDb, req.params.token);
    if (!candidate || !db) return res.status(404).json({ ok: false, error: 'not_found' });
    const joId = Number(req.body?.job_order_id);
    // Log the removal event before deleting
    const existing = db.prepare('SELECT status FROM interests WHERE phone = ? AND job_order_id = ?').get(candidate.phone, joId);
    if (existing) {
      logInterestEvent(db, candidate.phone, joId, existing.status, 'withdrawn', 'candidate');
    }
    db.prepare('DELETE FROM interests WHERE phone = ? AND job_order_id = ?').run(candidate.phone, joId);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createPublicRoutes };
