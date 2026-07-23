// Candidate-facing routes — the magic link page. The token is the only auth:
// random, unguessable, no PII in the URL.

const express = require('express');
const { renderCandidatePage, markInterest } = require('../src/candidate-page');

function createPublicRoutes(db) {
  const router = express.Router();

  // Preview mode — shows all published JOs as a candidate would see them
  router.get('/m/preview', (req, res) => {
    const { renderPreviewPage } = require('../src/candidate-page');
    res.send(renderPreviewPage(db, req.query.category));
  });

  router.get('/m/:token', (req, res) => {
    const candidate = db.prepare('SELECT * FROM candidates WHERE magic_token = ?').get(req.params.token);
    if (!candidate) return res.status(404).send('<h1>Link not found</h1><p>This link may have expired. Reply to our text and we\'ll send a fresh one.</p>');
    res.send(renderCandidatePage(db, candidate));
  });

  router.post('/m/:token/interest', express.json(), (req, res) => {
    const candidate = db.prepare('SELECT * FROM candidates WHERE magic_token = ?').get(req.params.token);
    if (!candidate) return res.status(404).json({ ok: false, error: 'not_found' });
    const result = markInterest(db, candidate, Number(req.body?.job_order_id));
    res.status(result.ok ? 200 : 400).json(result);
  });

  // Remove interest (toggle off)
  router.delete('/m/:token/interest', express.json(), (req, res) => {
    const candidate = db.prepare('SELECT * FROM candidates WHERE magic_token = ?').get(req.params.token);
    if (!candidate) return res.status(404).json({ ok: false, error: 'not_found' });
    const joId = Number(req.body?.job_order_id);
    db.prepare('DELETE FROM interests WHERE phone = ? AND job_order_id = ?').run(candidate.phone, joId);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createPublicRoutes };
