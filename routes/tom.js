// Tom API routes. Multi-tenant: each request uses req.db (the tenant's SQLite DB).
// The Tom state machine is created per-request from req.db.

const express = require('express');
const multer = require('multer');
const { createTom } = require('../src/tom');
const { parseHeadersOnly } = require('../src/importing');
const { getOrg } = require('../src/system-db');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Cache Tom instances per org to preserve session state within a process lifecycle
const tomCache = new Map();

function getTom(db, orgId) {
  if (tomCache.has(orgId)) return tomCache.get(orgId);
  const tom = createTom(db);
  tomCache.set(orgId, tom);
  return tom;
}

function createTomRoutes(sysDb) {
  const router = express.Router();

  router.post('/api/tom/start', async (req, res, next) => {
    try {
      const tom = getTom(req.db, req.user.org_id);
      const { path: tomPath } = req.body || {};
      res.json(await tom.start(tomPath, req.user?.username, req.user?.display_name));
    } catch (err) { next(err); }
  });

  router.post('/api/tom/message', async (req, res, next) => {
    try {
      const tom = getTom(req.db, req.user.org_id);
      const { sessionId, text, action, payload } = req.body || {};
      const org = getOrg(sysDb, req.user.org_id);
      res.json(await tom.message(sessionId, { text, action, payload, user: req.user?.username, reqHost: req.get('host'), reqProto: req.protocol, orgSlug: org?.slug }));
    } catch (err) { next(err); }
  });

  router.post('/api/tom/upload', upload.single('file'), async (req, res, next) => {
    try {
      const tom = getTom(req.db, req.user.org_id);
      const { sessionId } = req.body || {};
      if (!req.file) return res.status(400).json({ error: 'no_file' });
      res.json(await tom.message(sessionId, { file: req.file, user: req.user?.username }));
    } catch (err) { next(err); }
  });

  // Preview headers from uploaded file (for column mapping UI)
  router.post('/api/tom/preview-headers', upload.single('file'), (req, res) => {
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

module.exports = { createTomRoutes };
