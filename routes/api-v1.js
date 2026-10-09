// Public API v1 — REST endpoints for external tools (Grok, Copilot, Claude).
// Auth: X-API-Key header -> SHA-256 hash lookup in api_keys table.
// Rate limit: 60 req/min per API key.

const express = require('express');
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');

function createApiV1Routes(sysDb) {
  const router = express.Router();

  // ---- Rate limiter: 60 req/min per API key ----
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.apiKeyId ? `apikey:${req.apiKeyId}` : `apikey:${req.ip}`,
    validate: { keyGeneratorIpFallback: false },
    message: { error: { code: 'rate_limited', message: 'Rate limit exceeded (60 requests/minute)' } },
  });

  // ---- API Key Auth Middleware ----
  function apiKeyAuth(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!key) return res.status(401).json({ error: { code: 'missing_api_key', message: 'X-API-Key header required' } });
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    const row = sysDb.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash);
    if (!row) return res.status(401).json({ error: { code: 'invalid_api_key', message: 'Invalid API key' } });
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return res.status(401).json({ error: { code: 'expired_api_key', message: 'API key has expired' } });
    }
    req.apiKeyId = row.id;
    req.apiOrgId = row.org_id;
    next();
  }

  router.use(apiKeyAuth);
  router.use(apiLimiter);

  // Helper: get tenant DB for the API key's org
  function getDb(req) {
    const { getTenantDb } = require('../src/tenant');
    return getTenantDb(req.apiOrgId);
  }

  // Helper: standard list response
  function listResponse(rows, total, limit, offset) {
    return { data: rows, meta: { total, limit, offset } };
  }

  // ---- READ: Job Orders ----
  router.get('/jobs', (req, res) => {
    try {
      const db = getDb(req);
      const status = req.query.status;
      const category = req.query.category;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const offset = parseInt(req.query.offset) || 0;

      let where = [];
      let params = [];

      if (status && status !== 'all') {
        where.push('status = ?');
        params.push(status);
      }
      if (category) {
        where.push('category = ?');
        params.push(category);
      }

      const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = db.prepare('SELECT COUNT(*) as cnt FROM job_orders ' + whereClause).get(...params).cnt;
      const rows = db.prepare('SELECT * FROM job_orders ' + whereClause + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...params, limit, offset);
      res.json(listResponse(rows, total, limit, offset));
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  router.get('/jobs/:id', (req, res) => {
    try {
      const db = getDb(req);
      const jo = db.prepare('SELECT * FROM job_orders WHERE id = ?').get(Number(req.params.id));
      if (!jo) return res.status(404).json({ error: { code: 'not_found', message: 'Job order not found' } });
      res.json({ data: jo });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- READ: Candidates (PK = phone) ----
  router.get('/candidates', (req, res) => {
    try {
      const db = getDb(req);
      const search = req.query.search;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const offset = parseInt(req.query.offset) || 0;

      let where = [];
      let params = [];

      if (req.query.status === 'dnc') {
        where.push('do_not_contact = 1');
      }
      if (search) {
        where.push("(first_name LIKE ? OR last_name LIKE ? OR phone LIKE ?)");
        const s = '%' + search + '%';
        params.push(s, s, s);
      }

      const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = db.prepare('SELECT COUNT(*) as cnt FROM candidates ' + whereClause).get(...params).cnt;
      const rows = db.prepare('SELECT phone, first_name, last_name, current_category, blast_count, do_not_contact, created_at FROM candidates ' + whereClause + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params, limit, offset);
      res.json(listResponse(rows, total, limit, offset));
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  router.get('/candidates/:phone', (req, res) => {
    try {
      const db = getDb(req);
      const c = db.prepare('SELECT phone, first_name, last_name, current_category, blast_count, do_not_contact, created_at FROM candidates WHERE phone = ?').get(req.params.phone);
      if (!c) return res.status(404).json({ error: { code: 'not_found', message: 'Candidate not found' } });
      const interests = db.prepare('SELECT * FROM interests WHERE phone = ? ORDER BY created_at DESC').all(c.phone);
      res.json({ data: { ...c, interests } });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- READ: Pipeline ----
  router.get('/pipeline', (req, res) => {
    try {
      const db = getDb(req);
      const jos = db.prepare("SELECT id, title, status, category FROM job_orders WHERE status = 'Published' ORDER BY id DESC").all();
      const pipeline = jos.map(jo => {
        const interests = db.prepare(
          'SELECT i.*, c.first_name, c.last_name FROM interests i JOIN candidates c ON i.phone = c.phone WHERE i.job_order_id = ? ORDER BY i.created_at DESC'
        ).all(jo.id);
        return { job_order: jo, candidates: interests };
      });
      res.json({ data: pipeline });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- READ: Analytics ----
  router.get('/analytics', (req, res) => {
    try {
      const db = getDb(req);
      const totalJOs = db.prepare('SELECT COUNT(*) as cnt FROM job_orders').get().cnt;
      const publishedJOs = db.prepare("SELECT COUNT(*) as cnt FROM job_orders WHERE status = 'Published'").get().cnt;
      const totalCandidates = db.prepare('SELECT COUNT(*) as cnt FROM candidates').get().cnt;
      const totalInterests = db.prepare('SELECT COUNT(*) as cnt FROM interests').get().cnt;
      const totalBlasts = db.prepare('SELECT COUNT(*) as cnt FROM blasts').get().cnt;
      const responseRate = totalCandidates > 0 ? (totalInterests / totalCandidates * 100).toFixed(1) : '0.0';
      res.json({
        data: {
          total_job_orders: totalJOs,
          published_job_orders: publishedJOs,
          total_candidates: totalCandidates,
          total_interests: totalInterests,
          response_rate_pct: parseFloat(responseRate),
          total_blasts: totalBlasts,
        }
      });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- WRITE: Create Job Order ----
  router.post('/jobs', (req, res) => {
    try {
      const db = getDb(req);
      const { title, description, category, location, pay_rate } = req.body || {};
      if (!title) return res.status(400).json({ error: { code: 'validation', message: 'title is required' } });
      const r = db.prepare(
        'INSERT INTO job_orders (title, description, category, location, pay) VALUES (?, ?, ?, ?, ?)'
      ).run(title, description || '', category || '', location || '', pay_rate || '');
      const jo = db.prepare('SELECT * FROM job_orders WHERE id = ?').get(Number(r.lastInsertRowid));
      res.status(201).json({ data: jo });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- WRITE: Update Job Order ----
  router.patch('/jobs/:id', (req, res) => {
    try {
      const db = getDb(req);
      const jo = db.prepare('SELECT * FROM job_orders WHERE id = ?').get(Number(req.params.id));
      if (!jo) return res.status(404).json({ error: { code: 'not_found', message: 'Job order not found' } });
      const allowed = ['title', 'description', 'category', 'location', 'pay', 'shift_hours', 'requirements', 'company', 'status'];
      const sets = [];
      const vals = [];
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          sets.push(key + ' = ?');
          vals.push(req.body[key]);
        }
      }
      if (sets.length === 0) return res.status(400).json({ error: { code: 'validation', message: 'No valid fields to update' } });
      sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      vals.push(jo.id);
      db.prepare('UPDATE job_orders SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
      res.json({ data: db.prepare('SELECT * FROM job_orders WHERE id = ?').get(jo.id) });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- WRITE: Create Candidate ----
  router.post('/candidates', (req, res) => {
    try {
      const db = getDb(req);
      const { name, phone, email, skills } = req.body || {};
      if (!phone) return res.status(400).json({ error: { code: 'validation', message: 'phone is required' } });
      const { normalizePhone } = require('../src/phone');
      const cleanPhone = normalizePhone(phone);
      if (!cleanPhone) return res.status(400).json({ error: { code: 'validation', message: 'Invalid phone number' } });
      const parts = (name || '').trim().split(/\s+/);
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';
      const crypto = require('node:crypto');
      const magicToken = crypto.randomBytes(16).toString('hex');
      db.prepare(
        'INSERT INTO candidates (phone, first_name, last_name, magic_token, current_category) VALUES (?, ?, ?, ?, ?)'
      ).run(cleanPhone, firstName, lastName, magicToken, skills || '');
      const c = db.prepare('SELECT phone, first_name, last_name, current_category, created_at FROM candidates WHERE phone = ?').get(cleanPhone);
      res.status(201).json({ data: c });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) {
        return res.status(409).json({ error: { code: 'duplicate', message: 'Candidate with this phone already exists' } });
      }
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- WRITE: Move candidate pipeline stage ----
  router.patch('/candidates/:phone/stage', (req, res) => {
    try {
      const db = getDb(req);
      const { job_order_id, status } = req.body || {};
      if (!job_order_id || !status) return res.status(400).json({ error: { code: 'validation', message: 'job_order_id and status required' } });
      const validStatuses = ['interested', 'yes_listed', 'confirmed', 'filled', 'ruled_out'];
      if (!validStatuses.includes(status)) return res.status(400).json({ error: { code: 'validation', message: 'Invalid status. Must be: ' + validStatuses.join(', ') } });
      const phone = req.params.phone;
      const candidate = db.prepare('SELECT phone FROM candidates WHERE phone = ?').get(phone);
      if (!candidate) return res.status(404).json({ error: { code: 'not_found', message: 'Candidate not found' } });
      const interest = db.prepare('SELECT * FROM interests WHERE phone = ? AND job_order_id = ?').get(phone, Number(job_order_id));
      if (!interest) {
        db.prepare('INSERT INTO interests (phone, job_order_id, status) VALUES (?, ?, ?)').run(phone, Number(job_order_id), status);
      } else {
        db.prepare('UPDATE interests SET status = ? WHERE id = ?').run(status, interest.id);
      }
      const updated = db.prepare('SELECT * FROM interests WHERE phone = ? AND job_order_id = ?').get(phone, Number(job_order_id));
      res.json({ data: updated });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- WRITE: Blast preview (does NOT send) ----
  router.post('/blasts/preview', (req, res) => {
    try {
      const db = getDb(req);
      const { category } = req.body || {};
      let where = ['do_not_contact = 0'];
      let params = [];
      if (category) { where.push('current_category = ?'); params.push(category); }
      const whereClause = 'WHERE ' + where.join(' AND ');
      const candidates = db.prepare('SELECT phone, first_name, last_name, current_category FROM candidates ' + whereClause + ' ORDER BY phone').all(...params);
      res.json({ data: { count: candidates.length, candidates }, meta: { note: 'Preview only — no messages sent' } });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  return router;
}

module.exports = { createApiV1Routes };
