// Public API v1 — REST endpoints for external tools (Grok, Copilot, Claude).
// Auth: X-API-Key header -> SHA-256 hash lookup in api_keys table.
// Rate limit: 60 req/min per API key.

const express = require('express');
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { listBlasts, markDoNotContact } = require('../src/blast');
const { getSetting, setSetting } = require('../src/db');
const { normalizePhone } = require('../src/phone');
const { translateAndSave } = require('../src/translate');
const { listOrgUsers } = require('../src/system-db');

// FIX 4: strip HTML tags from user input to prevent XSS
function stripTags(s) { return s == null ? s : String(s).replace(/<[^>]*>/g, ''); }

// Coerce skills/category to string — arrays get joined with ", "
function coerceSkills(v) {
  if (v != null && typeof v === 'object' && !Array.isArray(v)) {
    // Fix #5: plain object is not valid — caller must use string or array
    throw new Error('skills must be a string or array of strings');
  }
  if (Array.isArray(v)) return v.join(', ');
  return v;
}

// Fix #6: derive name from first_name + last_name if name not provided
function resolveName(body) {
  if (body.name) return body.name;
  if (body.first_name || body.last_name) {
    return ((body.first_name || '') + ' ' + (body.last_name || '')).trim();
  }
  return '';
}

// In-memory store for blast preview tokens (15 min expiry)
// ponytail: in-memory Map, move to Redis if multi-process matters
const blastPreviewTokens = new Map();
const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;

function cleanExpiredTokens() {
  const now = Date.now();
  for (const [token, data] of blastPreviewTokens) {
    if (now - data.createdAt > PREVIEW_TOKEN_TTL_MS) blastPreviewTokens.delete(token);
  }
}

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

  // Valid job order statuses
  const VALID_JOB_STATUSES = ['Published', 'Unpublished', 'Complete'];

  // Normalize status string: capitalize first letter, lowercase rest
  function normalizeStatus(s) {
    if (!s || typeof s !== 'string') return s;
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }

  // Fix #5: validate skills field before coercion — returns error string or null
  function validateSkills(body) {
    const v = body.skills !== undefined ? body.skills : body.category;
    if (v === undefined || v === null || typeof v === 'string') return null;
    if (Array.isArray(v)) return null;
    return 'skills must be a string or array of strings';
  }


  // ---- READ: Categories ----
  router.get('/categories', (req, res) => {
    try {
      const db = getDb(req);
      const candidateRows = db.prepare("SELECT DISTINCT current_category FROM candidates WHERE current_category != ''").all();
      const jobOrderRows = db.prepare("SELECT DISTINCT category FROM job_orders WHERE category != ''").all();
      const candidateCategories = candidateRows.map(r => r.current_category);
      const jobOrderCategories = jobOrderRows.map(r => r.category);
      const all = [...new Set([...candidateCategories, ...jobOrderCategories])].sort();
      res.json({ data: { candidate_categories: candidateCategories.sort(), job_order_categories: jobOrderCategories.sort(), all } });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- READ: Job Orders ----
  router.get('/jobs', (req, res) => {
    try {
      const db = getDb(req);
      let status = req.query.status;
      const category = req.query.category;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const offset = parseInt(req.query.offset) || 0;

      let where = [];
      let params = [];

      if (status && status !== 'all') {
        // Bug fix #2: case-insensitive status filter
        status = normalizeStatus(status);
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

  // ---- READ: Export candidates (paginated JSON, must be before :phone route) ----
  router.get('/candidates/export', (req, res) => {
    try {
      const db = getDb(req);
      const limit = Math.min(parseInt(req.query.limit) || 1000, 1000);
      const offset = parseInt(req.query.offset) || 0;
      const total = db.prepare('SELECT COUNT(*) as cnt FROM candidates').get().cnt;
      const rows = db.prepare(
        'SELECT phone, first_name, last_name, current_category AS category, blast_count, do_not_contact, external_id, last_blast, created_at FROM candidates ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(limit, offset);
      res.json(listResponse(rows, total, limit, offset));
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
      if (req.query.external_id) {
        where.push('external_id = ?');
        params.push(req.query.external_id);
      }
      if (search) {
        where.push("(first_name LIKE ? OR last_name LIKE ? OR phone LIKE ?)");
        const s = '%' + search + '%';
        params.push(s, s, s);
      }

      const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = db.prepare('SELECT COUNT(*) as cnt FROM candidates ' + whereClause).get(...params).cnt;
      const rows = db.prepare('SELECT phone, first_name, last_name, current_category AS category, blast_count, do_not_contact, external_id, last_blast, created_at FROM candidates ' + whereClause + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params, limit, offset);
      res.json(listResponse(rows, total, limit, offset));
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  router.get('/candidates/:phone', (req, res) => {
    try {
      // Bug fix #6: validate phone format — reject clearly invalid (< 7 digits)
      const digits = req.params.phone.replace(/\D/g, '');
      if (digits.length < 7) {
        return res.status(400).json({ error: { code: 'validation', message: 'Invalid phone format — must be at least 7 digits' } });
      }
      const db = getDb(req);
      // FIX 5: alias current_category AS category for consistency with write endpoints
      const c = db.prepare('SELECT phone, first_name, last_name, current_category AS category, blast_count, do_not_contact, external_id, last_blast, created_at FROM candidates WHERE phone = ?').get(req.params.phone);
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
      // Bug fix #5: accept `pay` as alias for `pay_rate`; copy `location` to `city_state`
      const _b = req.body || {};
      const title = stripTags(_b.title), description = stripTags(_b.description), category = stripTags(_b.category);
      const location = stripTags(_b.location), assigned_recruiter = stripTags(_b.assigned_recruiter), status = _b.status;
      const resolvedPay = stripTags(_b.pay_rate || _b.pay) || '';
      if (!title) return res.status(400).json({ error: { code: 'validation', message: 'title is required' } });

      // FIX 4: validate and apply status if provided, default to Unpublished
      let resolvedStatus = 'Unpublished';
      if (status !== undefined) {
        const normalized = normalizeStatus(status);
        if (!VALID_JOB_STATUSES.includes(normalized)) {
          return res.status(400).json({ error: { code: 'validation', message: 'Invalid status. Must be one of: ' + VALID_JOB_STATUSES.join(', ') } });
        }
        resolvedStatus = normalized;
      }

      const r = db.prepare(
        'INSERT INTO job_orders (title, description, category, location, city_state, pay, assigned_recruiter, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(title, description || '', category || '', location || '', location || '', resolvedPay, assigned_recruiter || '', resolvedStatus);
      const jo = db.prepare('SELECT * FROM job_orders WHERE id = ?').get(Number(r.lastInsertRowid));
      translateAndSave(db, jo.id).catch(() => {}); // fire-and-forget Spanish translation
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

      // Bug fix #1: validate status before hitting DB
      if (req.body.status !== undefined) {
        const normalized = normalizeStatus(req.body.status);
        if (!VALID_JOB_STATUSES.includes(normalized)) {
          return res.status(400).json({ error: { code: 'validation', message: 'Invalid status. Must be one of: ' + VALID_JOB_STATUSES.join(', ') } });
        }
        req.body.status = normalized;
      }

      // Feature #10: added assigned_recruiter
      const allowed = ['title', 'description', 'category', 'location', 'pay', 'shift_hours', 'requirements', 'company', 'status', 'assigned_recruiter'];
      const sets = [];
      const vals = [];
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          sets.push(key + ' = ?');
          // FIX 4: sanitize string inputs (status already validated above)
          vals.push(typeof req.body[key] === 'string' ? stripTags(req.body[key]) : req.body[key]);
        }
      }
      if (sets.length === 0) return res.status(400).json({ error: { code: 'validation', message: 'No valid fields to update' } });
      sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      vals.push(jo.id);
      db.prepare('UPDATE job_orders SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
      if (['title', 'description', 'requirements'].some(k => req.body[k] !== undefined)) {
        translateAndSave(db, jo.id).catch(() => {}); // fire-and-forget Spanish translation
      }
      res.json({ data: db.prepare('SELECT * FROM job_orders WHERE id = ?').get(jo.id) });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- WRITE: Create Candidate ----
  router.post('/candidates', (req, res) => {
    try {
      const db = getDb(req);
      // Fix #5: validate skills type before coercion
      const skillsErr = validateSkills(req.body || {});
      if (skillsErr) return res.status(400).json({ error: { code: 'validation', message: skillsErr } });

      // Fix #6: accept first_name/last_name as alternative to name
      const name = stripTags(resolveName(req.body || {}));
      const { phone, external_id } = req.body || {};
      const skills = req.body.skills || req.body.category;
      // email silently ignored — column doesn't exist on candidates table
      if (!phone) return res.status(400).json({ error: { code: 'validation', message: 'phone is required' } });
      const cleanPhone = normalizePhone(phone);
      if (!cleanPhone) return res.status(400).json({ error: { code: 'validation', message: 'Invalid phone number' } });
      const parts = (name || '').trim().split(/\s+/);
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';
      const magicToken = crypto.randomBytes(16).toString('hex');
      // Bug fix #3: skills maps to current_category (documented in response as `category`)
      const skillsStr = stripTags(coerceSkills(skills)) || '';
      db.prepare(
        'INSERT INTO candidates (phone, first_name, last_name, magic_token, current_category, external_id) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(cleanPhone, firstName, lastName, magicToken, skillsStr, external_id || null);
      const c = db.prepare('SELECT phone, first_name, last_name, current_category AS category, external_id, last_blast, created_at FROM candidates WHERE phone = ?').get(cleanPhone);
      res.status(201).json({ data: c });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) {
        // Fix #4: distinguish phone duplicate from external_id duplicate
        if (e.message.includes('external_id')) {
          return res.status(409).json({ error: { code: 'duplicate_external_id', message: 'Candidate with this external_id already exists' } });
        }
        return res.status(409).json({ error: { code: 'duplicate', message: 'Candidate with this phone already exists' } });
      }
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- WRITE: Bulk Create Candidates ----
  // Feature #7: POST /candidates/bulk — max 200 per call
  router.post('/candidates/bulk', (req, res) => {
    try {
      const db = getDb(req);
      const candidates = req.body.candidates || req.body;
      if (!Array.isArray(candidates)) return res.status(400).json({ error: { code: 'validation', message: 'Request body must be an array of candidates (or {candidates: [...]})' } });
      if (candidates.length > 200) return res.status(400).json({ error: { code: 'validation', message: 'Maximum 200 candidates per call' } });
      if (candidates.length === 0) return res.status(400).json({ error: { code: 'validation', message: 'Empty candidate array' } });

      let created = 0;
      let duplicates = 0;
      const errors = [];

      const insertStmt = db.prepare('INSERT INTO candidates (phone, first_name, last_name, magic_token, current_category, external_id) VALUES (?, ?, ?, ?, ?, ?)');

      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i] || {};
        // Fix #5: validate skills type
        const skillsErr = validateSkills(cand);
        if (skillsErr) { errors.push({ index: i, message: skillsErr }); continue; }

        // Fix #6: accept first_name/last_name
        const name = stripTags(resolveName(cand));
        const { phone, external_id } = cand;
        // FIX 1: use category as fallback for skills (same pattern as single POST)
        const skills = cand.skills || cand.category;
        // email silently ignored
        if (!phone) { errors.push({ index: i, message: 'phone is required' }); continue; }
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone) { errors.push({ index: i, phone, message: 'Invalid phone number' }); continue; }
        const parts = (name || '').trim().split(/\s+/);
        const firstName = parts[0] || '';
        const lastName = parts.slice(1).join(' ') || '';
        const magicToken = crypto.randomBytes(16).toString('hex');
        let skillsStr;
        try { skillsStr = stripTags(coerceSkills(skills)) || ''; } catch { errors.push({ index: i, message: 'skills must be a string or array of strings' }); continue; }
        try {
          insertStmt.run(cleanPhone, firstName, lastName, magicToken, skillsStr, external_id || null);
          created++;
        } catch (e) {
          if (e.message && e.message.includes('UNIQUE')) {
            if (e.message.includes('external_id')) {
              errors.push({ index: i, phone: cleanPhone, code: 'duplicate_external_id', message: 'Candidate with this external_id already exists' });
            } else {
              duplicates++;
            }
          } else {
            errors.push({ index: i, phone: cleanPhone, message: e.message });
          }
        }
      }

      res.status(201).json({ data: { created, duplicates, errors } });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- WRITE: Upsert Candidate ----
  // Feature #8: PUT /candidates/:phone — create or update
  router.put('/candidates/:phone', (req, res) => {
    try {
      const db = getDb(req);
      const cleanPhone = normalizePhone(req.params.phone);
      if (!cleanPhone) return res.status(400).json({ error: { code: 'validation', message: 'Invalid phone number' } });

      // Fix #5: validate skills type
      const skillsErr = validateSkills(req.body || {});
      if (skillsErr) return res.status(400).json({ error: { code: 'validation', message: skillsErr } });

      // Fix #6: accept first_name/last_name
      const name = stripTags(resolveName(req.body || {}));
      const { external_id } = req.body || {};
      const skills = req.body.skills || req.body.category;
      // email silently ignored — column doesn't exist on candidates table
      const existing = db.prepare('SELECT phone FROM candidates WHERE phone = ?').get(cleanPhone);

      if (existing) {
        // Update
        const sets = [];
        const vals = [];
        if (name) {
          const parts = name.trim().split(/\s+/);
          sets.push('first_name = ?', 'last_name = ?');
          vals.push(parts[0] || '', parts.slice(1).join(' ') || '');
        }
        if (skills !== undefined) { sets.push('current_category = ?'); vals.push(stripTags(coerceSkills(skills))); }
        if (external_id !== undefined) { sets.push('external_id = ?'); vals.push(external_id); }
        if (sets.length > 0) {
          vals.push(cleanPhone);
          db.prepare('UPDATE candidates SET ' + sets.join(', ') + ' WHERE phone = ?').run(...vals);
        }
        const c = db.prepare('SELECT phone, first_name, last_name, current_category AS category, blast_count, do_not_contact, external_id, last_blast, created_at FROM candidates WHERE phone = ?').get(cleanPhone);
        return res.status(200).json({ data: c });
      } else {
        // Create
        const parts = (name || '').trim().split(/\s+/);
        const firstName = parts[0] || '';
        const lastName = parts.slice(1).join(' ') || '';
        const magicToken = crypto.randomBytes(16).toString('hex');
        const skillsStr = stripTags(coerceSkills(skills)) || '';
        db.prepare(
          'INSERT INTO candidates (phone, first_name, last_name, magic_token, current_category, external_id) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(cleanPhone, firstName, lastName, magicToken, skillsStr, external_id || null);
        const c = db.prepare('SELECT phone, first_name, last_name, current_category AS category, external_id, last_blast, created_at FROM candidates WHERE phone = ?').get(cleanPhone);
        return res.status(201).json({ data: c });
      }
    } catch (e) {
      // Fix #4: external_id uniqueness error
      if (e.message && e.message.includes('UNIQUE') && e.message.includes('external_id')) {
        return res.status(409).json({ error: { code: 'duplicate_external_id', message: 'Candidate with this external_id already exists' } });
      }
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- WRITE: Partial Update Candidate ----
  // Feature #9: PATCH /candidates/:phone — update individual fields
  router.patch('/candidates/:phone', (req, res) => {
    try {
      const db = getDb(req);
      const cleanPhone = normalizePhone(req.params.phone);
      if (!cleanPhone) return res.status(400).json({ error: { code: 'validation', message: 'Invalid phone number' } });

      const existing = db.prepare('SELECT phone FROM candidates WHERE phone = ?').get(cleanPhone);
      if (!existing) return res.status(404).json({ error: { code: 'not_found', message: 'Candidate not found' } });

      // Fix #5: validate skills type
      const skillsErr = validateSkills(req.body || {});
      if (skillsErr) return res.status(400).json({ error: { code: 'validation', message: skillsErr } });

      const sets = [];
      const vals = [];

      // Fix #6: accept first_name/last_name in PATCH too
      if (req.body.name !== undefined) {
        const parts = stripTags(req.body.name).trim().split(/\s+/);
        sets.push('first_name = ?', 'last_name = ?');
        vals.push(parts[0] || '', parts.slice(1).join(' ') || '');
      } else if (req.body.first_name !== undefined || req.body.last_name !== undefined) {
        if (req.body.first_name !== undefined) { sets.push('first_name = ?'); vals.push(stripTags(req.body.first_name)); }
        if (req.body.last_name !== undefined) { sets.push('last_name = ?'); vals.push(stripTags(req.body.last_name)); }
      }
      // email silently ignored — column doesn't exist on candidates table
      if (req.body.skills !== undefined) { sets.push('current_category = ?'); vals.push(stripTags(coerceSkills(req.body.skills))); }
      if (req.body.category !== undefined) { sets.push('current_category = ?'); vals.push(stripTags(coerceSkills(req.body.category))); }
      if (req.body.external_id !== undefined) { sets.push('external_id = ?'); vals.push(req.body.external_id); }
      if (req.body.do_not_contact !== undefined) { sets.push('do_not_contact = ?'); vals.push(req.body.do_not_contact ? 1 : 0); }

      if (sets.length === 0) return res.status(400).json({ error: { code: 'validation', message: 'No valid fields to update' } });

      vals.push(cleanPhone);
      db.prepare('UPDATE candidates SET ' + sets.join(', ') + ' WHERE phone = ?').run(...vals);
      const c = db.prepare('SELECT phone, first_name, last_name, current_category AS category, blast_count, do_not_contact, external_id, last_blast, created_at FROM candidates WHERE phone = ?').get(cleanPhone);
      res.json({ data: c });
    } catch (e) {
      // Fix #4: external_id uniqueness error
      if (e.message && e.message.includes('UNIQUE') && e.message.includes('external_id')) {
        return res.status(409).json({ error: { code: 'duplicate_external_id', message: 'Candidate with this external_id already exists' } });
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
      // FIX 3: validate job_order_id is numeric
      if (isNaN(Number(job_order_id))) return res.status(400).json({ error: { code: 'validation', message: 'job_order_id must be a number' } });
      const validStatuses = ['interested', 'yes_listed', 'confirmed', 'filled', 'ruled_out'];
      if (!validStatuses.includes(status)) return res.status(400).json({ error: { code: 'validation', message: 'Invalid status. Must be: ' + validStatuses.join(', ') } });
      // FIX 2: verify job order exists before creating interest
      const jo = db.prepare('SELECT id FROM job_orders WHERE id = ?').get(Number(job_order_id));
      if (!jo) return res.status(400).json({ error: { code: 'validation', message: 'Job order not found' } });
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

  // ---- DELETE: Job Order + associated interests ----
  router.delete('/jobs/:id', (req, res) => {
    try {
      const db = getDb(req);
      const id = Number(req.params.id);
      const jo = db.prepare('SELECT id FROM job_orders WHERE id = ?').get(id);
      if (!jo) return res.status(404).json({ error: { code: 'not_found', message: 'Job order not found' } });
      const interestsRemoved = db.prepare('DELETE FROM interests WHERE job_order_id = ?').run(id).changes;
      db.prepare('DELETE FROM job_orders WHERE id = ?').run(id);
      res.json({ ok: true, deleted: { job_order: id, interests_removed: interestsRemoved } });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- DELETE: Candidate + associated interests ----
  router.delete('/candidates/:phone', (req, res) => {
    try {
      const db = getDb(req);
      const phone = req.params.phone;
      const c = db.prepare('SELECT phone FROM candidates WHERE phone = ?').get(phone);
      if (!c) return res.status(404).json({ error: { code: 'not_found', message: 'Candidate not found' } });
      const interestsRemoved = db.prepare('DELETE FROM interests WHERE phone = ?').run(phone).changes;
      db.prepare('DELETE FROM candidates WHERE phone = ?').run(phone);
      res.json({ ok: true, deleted: { phone, interests_removed: interestsRemoved } });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- WRITE: Blast preview (does NOT send) — generates a lock token ----
  // Accepts EITHER {phones: [...]} or {category: "..."} or both.
  // When phones provided: look up each in candidates table, skip unknowns.
  // When category only: query candidates by category match (original behavior).
  router.post('/blasts/preview', (req, res) => {
    try {
      cleanExpiredTokens();
      const db = getDb(req);
      const { phones, category, job_order_id } = req.body || {};

      // Must provide at least one of phones or category
      if ((!phones || !Array.isArray(phones) || phones.length === 0) && (!category || typeof category !== 'string' || !category.trim())) {
        return res.status(400).json({ error: { code: 'validation', message: 'phones (array) or category (string) is required for blast preview' } });
      }

      let candidates;
      let resolvedCategory = category || null;
      const notFound = [];

      if (phones && Array.isArray(phones) && phones.length > 0) {
        // Phone-based lookup — primary path (matches Wizard flow)
        const get = db.prepare('SELECT phone, first_name, last_name, current_category FROM candidates WHERE phone = ? AND do_not_contact = 0');
        candidates = [];
        for (const raw of phones) {
          const normalized = normalizePhone(raw);
          if (!normalized) { notFound.push(raw); continue; }
          const c = get.get(normalized);
          if (c) candidates.push(c);
          else notFound.push(raw);
        }

        // If no category provided, infer from first candidate for JO warning check
        if (!resolvedCategory && candidates.length > 0) {
          resolvedCategory = candidates[0].current_category || null;
        }
      } else {
        // Category-based lookup — original behavior
        // Fix #3: case-insensitive + comma-split category matching
        const catTerms = category.split(',').map(c => c.trim().toLowerCase()).filter(Boolean);
        let where = ['do_not_contact = 0'];
        let params = [];
        if (catTerms.length === 1) {
          where.push('(LOWER(current_category) = ? OR LOWER(current_category) LIKE ?)');
          params.push(catTerms[0], '%' + catTerms[0] + '%');
        } else {
          const orClauses = catTerms.map(() => '(LOWER(current_category) = ? OR LOWER(current_category) LIKE ?)');
          where.push('(' + orClauses.join(' OR ') + ')');
          for (const term of catTerms) {
            params.push(term, '%' + term + '%');
          }
        }
        const whereClause = 'WHERE ' + where.join(' AND ');
        candidates = db.prepare('SELECT phone, first_name, last_name, current_category FROM candidates ' + whereClause + ' ORDER BY phone').all(...params);
      }

      // Check if any Published job orders match the category
      let warning = undefined;
      if (resolvedCategory) {
        const catCheck = resolvedCategory.split(',')[0].trim().toLowerCase();
        const publishedJoCount = db.prepare("SELECT COUNT(*) as cnt FROM job_orders WHERE status = 'Published' AND LOWER(category) = ?").get(catCheck).cnt;
        if (publishedJoCount === 0) {
          warning = `No published job orders match category '${resolvedCategory}'. Candidates would see an empty page.`;
        }
      }

      // Generate preview-lock token
      const previewToken = crypto.randomBytes(16).toString('hex');
      blastPreviewTokens.set(previewToken, {
        candidatePhones: candidates.map(c => c.phone),
        orgId: req.apiOrgId,
        jobOrderId: job_order_id || null,
        category: resolvedCategory || 'unknown',
        createdAt: Date.now(),
      });

      // Redact phone to last 4 digits in preview
      const redacted = candidates.map(c => ({
        ...c,
        phone: '***' + c.phone.slice(-4),
      }));
      const response = {
        data: { count: candidates.length, candidates: redacted, preview_token: previewToken },
        meta: { note: 'Preview only — no messages sent. Phone numbers redacted. Use preview_token with POST /blasts/send within 15 minutes.' },
      };
      if (warning) response.warning = warning;
      if (notFound.length > 0) response.not_found = notFound;
      res.json(response);
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- WRITE: Blast send — requires preview-lock token ----
  router.post('/blasts/send', async (req, res) => {
    try {
      cleanExpiredTokens();
      const db = getDb(req);
      const { preview_token, job_order_id, message_template, skip_blast_guard } = req.body || {};

      if (!preview_token) return res.status(400).json({ error: { code: 'validation', message: 'preview_token is required' } });
      if (!message_template) return res.status(400).json({ error: { code: 'validation', message: 'message_template is required' } });

      // Fix #1: validate job_order_id exists before consuming token
      if (!job_order_id) {
        return res.status(400).json({ error: { code: 'validation', message: 'job_order_id is required' } });
      }
      const jo = db.prepare('SELECT id FROM job_orders WHERE id = ?').get(Number(job_order_id));
      if (!jo) {
        return res.status(400).json({ error: { code: 'validation', message: 'Job order not found' } });
      }

      const tokenData = blastPreviewTokens.get(preview_token);
      if (!tokenData) return res.status(400).json({ error: { code: 'invalid_token', message: 'Preview token not found or expired (15 min TTL)' } });
      if (tokenData.orgId !== req.apiOrgId) return res.status(403).json({ error: { code: 'forbidden', message: 'Token belongs to a different org' } });
      if (Date.now() - tokenData.createdAt > PREVIEW_TOKEN_TTL_MS) {
        blastPreviewTokens.delete(preview_token);
        return res.status(400).json({ error: { code: 'expired_token', message: 'Preview token expired (15 min TTL)' } });
      }

      // Consume the token — one-time use (AFTER all validation passes)
      blastPreviewTokens.delete(preview_token);

      const { planBlast, executeBlast } = require('../src/blast');
      const { getProvider } = require('../src/messaging');

      // Plan the blast with the locked phones and original category
      const plan = planBlast(db, {
        phones: tokenData.candidatePhones,
        category: tokenData.category,
        skipBlastGuard: Boolean(skip_blast_guard),
      });

      // If plan.sendable is empty after guard, still return success but 0 sent
      const provider = getProvider(db);
      const templateBody = message_template.includes('{link}') ? message_template : message_template + ' {link}';
      const { getOrg } = require('../src/system-db');
      const org = getOrg(sysDb, req.apiOrgId);
      const { getSetting } = require('../src/db');
      const result = await executeBlast(db, plan, {
        templateBody,
        provider,
        sentBy: 'api-v1',
        orgSlug: org ? org.slug : null,
        baseUrl: getSetting(db, 'base_url') || process.env.BASE_URL || 'https://app.joblinkplatform.com',
      });

      res.json({
        ok: true,
        sent: result.sent,
        failed: result.failed,
        skipped_cooldown: result.skippedCooldown,
        skipped_dnc: result.skippedDnc,
        token_used: preview_token,
      });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ========================================================================
  // HEADLESS API EXTENSIONS — Commit 1: Blasts + Templates
  // ========================================================================

  // ---- READ: Templates ----
  router.get('/templates', (req, res) => {
    try {
      const db = getDb(req);
      const rows = db.prepare('SELECT id, name, body, category, is_default FROM templates ORDER BY is_default DESC, id').all();
      res.json({ data: rows });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  router.get('/templates/:id', (req, res) => {
    try {
      const db = getDb(req);
      const t = db.prepare('SELECT id, name, body, category, is_default FROM templates WHERE id = ?').get(Number(req.params.id));
      if (!t) return res.status(404).json({ error: { code: 'not_found', message: 'Template not found' } });
      res.json({ data: t });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  router.post('/templates', (req, res) => {
    try {
      const db = getDb(req);
      const { name, body, category } = req.body || {};
      if (!name || !body) return res.status(400).json({ error: { code: 'validation', message: 'name and body required' } });
      if (!String(body).includes('{link}')) return res.status(400).json({ error: { code: 'validation', message: 'Template must include {link}' } });
      const r = db.prepare('INSERT INTO templates (name, body, category) VALUES (?, ?, ?)').run(stripTags(name), stripTags(body), stripTags(category) || null);
      const created = db.prepare('SELECT id, name, body, category, is_default FROM templates WHERE id = ?').get(Number(r.lastInsertRowid));
      res.status(201).json({ data: created });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  router.patch('/templates/:id', (req, res) => {
    try {
      const db = getDb(req);
      const id = Number(req.params.id);
      const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
      if (!t) return res.status(404).json({ error: { code: 'not_found', message: 'Template not found' } });
      const { name, body, category } = req.body || {};
      if (name !== undefined) db.prepare('UPDATE templates SET name = ? WHERE id = ?').run(stripTags(String(name)), id);
      if (body !== undefined) {
        if (!String(body).includes('{link}')) return res.status(400).json({ error: { code: 'validation', message: 'Template must include {link}' } });
        db.prepare('UPDATE templates SET body = ? WHERE id = ?').run(stripTags(String(body)), id);
      }
      if (category !== undefined) {
        db.prepare('UPDATE templates SET category = ? WHERE id = ?').run(category === null ? null : stripTags(String(category)), id);
      }
      const updated = db.prepare('SELECT id, name, body, category, is_default FROM templates WHERE id = ?').get(id);
      res.json({ data: updated });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  router.delete('/templates/:id', (req, res) => {
    try {
      const db = getDb(req);
      const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(req.params.id));
      if (!t) return res.status(404).json({ error: { code: 'not_found', message: 'Template not found' } });
      if (t.is_default) return res.status(400).json({ error: { code: 'validation', message: 'Cannot delete the default template' } });
      db.prepare('DELETE FROM templates WHERE id = ?').run(t.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- READ: Blasts (history) ----
  router.get('/blasts', (req, res) => {
    try {
      const db = getDb(req);
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const rows = listBlasts(db, limit);
      res.json({ data: rows });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  router.get('/blasts/:id', (req, res) => {
    try {
      const db = getDb(req);
      const blast = db.prepare('SELECT * FROM blasts WHERE id = ?').get(Number(req.params.id));
      if (!blast) return res.status(404).json({ error: { code: 'not_found', message: 'Blast not found' } });
      res.json({ data: blast });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  router.get('/blasts/:id/recipients', (req, res) => {
    try {
      const db = getDb(req);
      const blastId = Number(req.params.id);
      const blast = db.prepare('SELECT id FROM blasts WHERE id = ?').get(blastId);
      if (!blast) return res.status(404).json({ error: { code: 'not_found', message: 'Blast not found' } });
      const recipients = db.prepare(
        `SELECT br.phone, br.status, c.first_name, c.last_name
         FROM blast_recipients br
         LEFT JOIN candidates c ON c.phone = br.phone
         WHERE br.blast_id = ?
         ORDER BY br.status, c.last_name, c.first_name`
      ).all(blastId);
      res.json({ data: recipients });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ========================================================================
  // HEADLESS API EXTENSIONS — Commit 2: Interest Events + DNC + Settings
  // ========================================================================

  // ---- READ: Interest Events (audit log) ----
  router.get('/interest-events', (req, res) => {
    try {
      const db = getDb(req);
      const phone = req.query.phone ? normalizePhone(req.query.phone) : null;
      const jobOrderId = req.query.job_order_id ? Number(req.query.job_order_id) : null;
      const limit = Math.min(Number(req.query.limit) || 200, 1000);

      let sql = 'SELECT * FROM interest_events WHERE 1=1';
      const params = [];
      if (phone) { sql += ' AND phone = ?'; params.push(phone); }
      if (jobOrderId) { sql += ' AND job_order_id = ?'; params.push(jobOrderId); }
      sql += ' ORDER BY changed_at DESC LIMIT ?';
      params.push(limit);

      const rows = db.prepare(sql).all(...params);
      res.json({ data: rows });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- WRITE: Toggle DNC ----
  router.post('/candidates/:phone/dnc', (req, res) => {
    try {
      const db = getDb(req);
      const phone = normalizePhone(req.params.phone);
      if (!phone) return res.status(400).json({ error: { code: 'validation', message: 'Invalid phone number' } });
      const candidate = db.prepare('SELECT phone, first_name, last_name, do_not_contact FROM candidates WHERE phone = ?').get(phone);
      if (!candidate) return res.status(404).json({ error: { code: 'not_found', message: 'Candidate not found' } });
      const value = req.body && req.body.value !== undefined ? Boolean(req.body.value) : true;
      markDoNotContact(db, phone, value);
      const updated = db.prepare('SELECT phone, first_name, last_name, current_category, blast_count, do_not_contact, external_id, last_blast, created_at FROM candidates WHERE phone = ?').get(phone);
      res.json({ data: updated });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- READ: Settings (filtered — no sensitive keys) ----
  router.get('/settings', (req, res) => {
    try {
      const db = getDb(req);
      const SAFE_KEYS = ['cooldown_hours', 'sms_provider', 'onboarded'];
      const out = {};
      for (const k of SAFE_KEYS) {
        const v = getSetting(db, k);
        if (v !== undefined && v !== null) out[k] = v;
      }
      res.json({ data: out });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- WRITE: Update Settings (restricted) ----
  router.patch('/settings', (req, res) => {
    try {
      const db = getDb(req);
      const ALLOWED = ['cooldown_hours'];
      const updates = {};
      for (const [k, v] of Object.entries(req.body || {})) {
        if (!ALLOWED.includes(k)) continue;
        if (k === 'cooldown_hours' && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
          return res.status(400).json({ error: { code: 'validation', message: 'cooldown_hours must be a non-negative number' } });
        }
        setSetting(db, k, v);
        updates[k] = v;
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: { code: 'validation', message: 'No valid settings to update. Allowed: ' + ALLOWED.join(', ') } });
      }
      // Return full safe settings
      const SAFE_KEYS = ['cooldown_hours', 'sms_provider', 'onboarded'];
      const out = {};
      for (const k of SAFE_KEYS) {
        const v = getSetting(db, k);
        if (v !== undefined && v !== null) out[k] = v;
      }
      res.json({ data: out });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ========================================================================
  // HEADLESS API EXTENSIONS — Commit 3: Team + Stats + Export
  // ========================================================================

  // ---- READ: Team (org users) ----
  router.get('/team', (req, res) => {
    try {
      const users = listOrgUsers(sysDb, req.apiOrgId);
      // Strip password_hash and other sensitive fields
      const safe = users.map(u => ({
        id: u.id,
        username: u.username,
        display_name: u.display_name || null,
        role: u.role,
        email: u.email || null,
        created_at: u.created_at,
      }));
      res.json({ data: safe });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- WRITE: Invite (create) user ----
  // FIX 2: accept display_name in request body and include in INSERT
  router.post('/team/invite', (req, res) => {
    try {
      const { email, role, username, password, display_name } = req.body || {};
      if (!email && !username) return res.status(400).json({ error: { code: 'validation', message: 'email or username required' } });
      const resolvedUsername = username || email;
      // Generate a random password if none provided
      const resolvedPassword = password || (crypto.randomBytes(12).toString("base64url") + "A1!");
      const bcrypt = require('bcryptjs');
      const { validatePassword } = require('../lib/password-policy');
      const pwCheck = validatePassword(String(resolvedPassword));
      if (!pwCheck.valid) return res.status(400).json({ error: { code: 'validation', message: pwCheck.error } });
      const r = sysDb.prepare(
        'INSERT INTO users (org_id, username, password_hash, role, email, email_verified, display_name) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(req.apiOrgId, String(resolvedUsername), bcrypt.hashSync(String(resolvedPassword), 10),
            role === 'admin' ? 'admin' : 'recruiter', email ? String(email) : null, email ? 1 : 0,
            display_name ? String(display_name) : '');
      const created = sysDb.prepare('SELECT id, username, display_name, role, email, created_at FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
      // Include the generated password in response so caller can share it
      const response = { data: created };
      if (!password) response.generated_password = resolvedPassword;
      res.status(201).json(response);
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) {
        return res.status(409).json({ error: { code: 'duplicate', message: 'Username or email already taken' } });
      }
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- DELETE: Remove team member ----
  // FIX 3: DELETE /team/:id — remove a user from the org
  router.delete('/team/:id', (req, res) => {
    try {
      const userId = Number(req.params.id);
      const user = sysDb.prepare('SELECT id, username, display_name, role, org_id FROM users WHERE id = ?').get(userId);
      if (!user || user.org_id !== req.apiOrgId) {
        return res.status(404).json({ error: { code: 'not_found', message: 'Team member not found' } });
      }
      // Can't delete the last admin
      if (user.role === 'admin') {
        const adminCount = sysDb.prepare("SELECT COUNT(*) as cnt FROM users WHERE org_id = ? AND role = 'admin'").get(req.apiOrgId).cnt;
        if (adminCount <= 1) {
          return res.status(400).json({ error: { code: 'validation', message: 'Cannot delete the last admin' } });
        }
      }
      sysDb.prepare('DELETE FROM users WHERE id = ?').run(userId);
      res.json({ ok: true, deleted: { id: user.id, username: user.username } });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // ---- READ: Stats (dashboard summary) ----
  router.get('/stats', (req, res) => {
    try {
      const db = getDb(req);
      const candidates = db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
      const interests = db.prepare('SELECT COUNT(*) AS n FROM interests').get().n;
      const published = db.prepare("SELECT COUNT(*) AS n FROM job_orders WHERE status='Published'").get().n;
      const blasts = db.prepare('SELECT COUNT(*) AS n FROM blasts').get().n;
      const filled = db.prepare("SELECT COUNT(*) AS n FROM interests WHERE status='filled'").get().n;
      // Clicks today
      let clicks_today = 0;
      try {
        clicks_today = db.prepare("SELECT COUNT(*) AS n FROM link_clicks WHERE created_at >= date('now')").get().n;
      } catch { /* link_clicks table may not exist */ }
      res.json({
        data: { candidates, interests, published, blasts, filled, clicks_today },
      });
    } catch (e) {
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });


  return router;
}

module.exports = { createApiV1Routes };
