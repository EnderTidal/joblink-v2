// Tom API routes. The state machine lives in src/tom.js — these routes just
// carry messages (and file uploads) in and out.

const express = require('express');
const multer = require('multer');
const { createTom } = require('../src/tom');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function createTomRoutes(db) {
  const tom = createTom(db);
  const router = express.Router();

  router.post('/api/tom/start', async (req, res, next) => {
    try {
      const { path: tomPath } = req.body || {};
      res.json(await tom.start(tomPath, req.user?.username));
    } catch (err) { next(err); }
  });

  router.post('/api/tom/message', async (req, res, next) => {
    try {
      const { sessionId, text, action, payload } = req.body || {};
      res.json(await tom.message(sessionId, { text, action, payload, user: req.user?.username }));
    } catch (err) { next(err); }
  });

  router.post('/api/tom/upload', upload.single('file'), async (req, res, next) => {
    try {
      const { sessionId } = req.body || {};
      if (!req.file) return res.status(400).json({ error: 'no_file' });
      res.json(await tom.message(sessionId, { file: req.file, user: req.user?.username }));
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { createTomRoutes };
