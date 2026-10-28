// Wizard API routes. Multi-tenant: each request uses req.db (the tenant's SQLite DB).
// The Wizard state machine is created per-request from req.db.

const express = require('express');
const multer = require('multer');
const { createWizard } = require('../src/wizard');
const { parseHeadersOnly } = require('../src/importing');
const { getOrg } = require('../src/system-db');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Cache Wizard instances per org to preserve session state within a process lifecycle
const wizardCache = new Map();

function getWizard(db, orgId) {
  if (wizardCache.has(orgId)) return wizardCache.get(orgId);
  const wizard = createWizard(db);
  wizardCache.set(orgId, wizard);
  return wizard;
}

function createWizardRoutes(sysDb) {
  const router = express.Router();

  router.post('/api/wizard/start', async (req, res, next) => {
    try {
      const wizard = getWizard(req.db, req.user.org_id);
      const { path: wizardPath } = req.body || {};
      res.json(await wizard.start(wizardPath, req.user?.username, req.user?.display_name));
    } catch (err) { next(err); }
  });

  router.post('/api/wizard/message', async (req, res, next) => {
    try {
      const wizard = getWizard(req.db, req.user.org_id);
      const { sessionId, text, action, payload } = req.body || {};
      const org = getOrg(sysDb, req.user.org_id);
      res.json(await wizard.message(sessionId, { text, action, payload, user: req.user?.username, reqHost: req.get('host'), reqProto: req.protocol, orgSlug: org?.slug }));
    } catch (err) { next(err); }
  });

  router.post('/api/wizard/upload', upload.single('file'), async (req, res, next) => {
    try {
      const wizard = getWizard(req.db, req.user.org_id);
      const { sessionId } = req.body || {};
      if (!req.file) return res.status(400).json({ error: 'no_file' });
      res.json(await wizard.message(sessionId, { file: req.file, user: req.user?.username }));
    } catch (err) { next(err); }
  });

  // Preview headers from uploaded file (for column mapping UI)
  router.post('/api/wizard/preview-headers', upload.single('file'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'no_file' });
      const result = parseHeadersOnly(req.file.buffer, req.file.originalname);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: 'parse_error', message: err.message });
    }
  });

  return router;
}

module.exports = { createWizardRoutes };
