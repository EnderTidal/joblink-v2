// Admin + Dashboard API: job order actions, candidates, settings, templates,
// users, feedback, changelog, provider test. Dashboard rows get real actions
// (publish / unpublish / complete) — docs/DECISIONS.md.

const express = require('express');
const bcrypt = require('bcryptjs');
const https = require('node:https');
const { listJobOrders, setStatus, updateJobOrder } = require('../src/job-orders');
const { listBlasts, markDoNotContact } = require('../src/blast');
const { getProvider } = require('../src/messaging');
const { toE164 } = require("../src/phone");
const { getSetting, setSetting } = require('../src/db');
const { normalizePhone, formatPhone } = require('../src/phone');

const SETTING_KEYS = ['cooldown_hours', 'sms_provider', 'whippy_api_key', 'whippy_channel_id', 'whippy_from_number'];

const RESEND_KEY = process.env.RESEND_KEY || '';
const FEEDBACK_EMAIL = 'joshuafriends@gmail.com';

/** Fetch Whippy team members and cache in settings */
async function syncWhippyUsers(db) {
  const apiKey = getSetting(db, 'whippy_api_key');
  if (!apiKey) return { ok: false, error: 'no_api_key' };
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.whippy.co',
      port: 443,
      path: '/v1/users',
      method: 'GET',
      headers: { 'X-WHIPPY-KEY': apiKey, 'Content-Type': 'application/json' },
    };
    const req = https.request(opts, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return resolve({ ok: false, error: `Whippy ${res.statusCode}: ${out}` });
          }
          const parsed = JSON.parse(out);
          const users = (parsed.data || parsed.users || parsed || []);
          const mapped = (Array.isArray(users) ? users : []).map((u) => ({
            id: u.id,
            name: u.name || u.full_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Unknown',
            email: u.email || '',
          }));
          setSetting(db, 'whippy_users', JSON.stringify(mapped));
          resolve({ ok: true, count: mapped.length, users: mapped });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

/** Send feedback email via Resend */
function sendFeedbackEmail(username, feedbackBody) {
  const now = new Date().toISOString();
  const data = JSON.stringify({
    from: 'JobLink <resume@thetelosway.com>',
    to: [FEEDBACK_EMAIL],
    subject: `JobLink Feedback from ${username || 'anonymous'}`,
    html: `<p><strong>From:</strong> ${username || 'anonymous'}</p><p><strong>Time:</strong> ${now}</p><hr><p>${String(feedbackBody).replace(/\n/g, '<br>')}</p>`,
  });
  const opts = {
    hostname: 'api.resend.com',
    port: 443,
    path: '/emails',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
  };
  const req = https.request(opts, () => {}); // fire-and-forget
  req.on('error', (e) => console.error('[feedback-email]', e.message));
  req.write(data);
  req.end();
}

function createAdminRoutes(db, auth) {
  const router = express.Router();

  // Migration: add display_name column to users (idempotent)
  try { db.exec("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE feedback ADD COLUMN type TEXT DEFAULT 'general'"); } catch { /* already exists */ }

  // ---- Dashboard ----
  router.get('/api/job-orders', (req, res) => {
    res.json(listJobOrders(db, { status: req.query.status, category: req.query.category, recruiter: req.query.recruiter }));
  });

  router.post('/api/job-orders/:id/status', (req, res, next) => {
    try { res.json(setStatus(db, Number(req.params.id), req.body?.status)); }
    catch (err) { next(err); }
  });

  router.patch('/api/job-orders/:id', (req, res, next) => {
    try { res.json(updateJobOrder(db, Number(req.params.id), req.body || {})); }
    catch (err) { next(err); }
  });

  // ---- Single Job Order detail with interested candidates grouped by status ----
  router.get('/api/job-orders/:id', (req, res) => {
    const id = Number(req.params.id);
    const jo = db.prepare(
      `SELECT jo.*,
        (SELECT COUNT(*) FROM interests i WHERE i.job_order_id = jo.id) AS interested_count,
        (SELECT COUNT(*) FROM interests i WHERE i.job_order_id = jo.id AND i.status = 'yes_listed') AS yeslisted_count,
        (SELECT COUNT(*) FROM interests i WHERE i.job_order_id = jo.id AND i.status = 'confirmed') AS confirmed_count,
        (SELECT COUNT(*) FROM interests i WHERE i.job_order_id = jo.id AND i.status = 'filled') AS filled_count,
        (SELECT COUNT(*) FROM interests i WHERE i.job_order_id = jo.id AND i.status = 'ruled_out') AS ruled_out_count
       FROM job_orders jo WHERE jo.id = ?`
    ).get(id);
    if (!jo) return res.status(404).json({ error: 'not_found' });
    const allInterests = db.prepare(
      `SELECT i.id AS interest_id, i.status AS pipeline_status, c.phone, c.first_name, c.last_name, c.current_category, i.created_at AS interest_date
       FROM interests i
       JOIN candidates c ON c.phone = i.phone
       WHERE i.job_order_id = ?
       ORDER BY i.created_at DESC`
    ).all(id);
    // Group by status
    const grouped = {
      interested: [],
      yes_listed: [],
      confirmed: [],
      filled: [],
      ruled_out: [],
    };
    for (const c of allInterests) {
      const status = c.pipeline_status || 'interested';
      if (grouped[status]) grouped[status].push({ ...c, phone_display: formatPhone(c.phone) });
      else grouped.interested.push({ ...c, phone_display: formatPhone(c.phone) });
    }
    res.json({
      ...jo,
      interested_candidates: allInterests.map(c => ({ ...c, phone_display: formatPhone(c.phone) })),
      pipeline: grouped,
    });
  });

  // ---- Pipeline Actions: move candidate through statuses ----
  router.patch('/api/interests/:id/status', (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body || {};
    const VALID = ['interested', 'yes_listed', 'confirmed', 'filled', 'ruled_out'];
    if (!VALID.includes(status)) return res.status(400).json({ error: `status must be one of: ${VALID.join(', ')}` });
    const interest = db.prepare('SELECT * FROM interests WHERE id = ?').get(id);
    if (!interest) return res.status(404).json({ error: 'interest not found' });
    db.prepare('UPDATE interests SET status = ? WHERE id = ?').run(status, id);
    res.json({ ok: true, id, status });
  });

  router.get('/api/blasts', (_req, res) => res.json(listBlasts(db, 50)));

  // ---- Blast Recipients (expandable blast detail) ----
  router.get('/api/blasts/:id/recipients', (req, res) => {
    const blastId = Number(req.params.id);
    const blast = db.prepare('SELECT * FROM blasts WHERE id = ?').get(blastId);
    if (!blast) return res.status(404).json({ error: 'not_found' });
    const recipients = db.prepare(
      `SELECT br.phone, br.status, br.error, c.first_name, c.last_name
       FROM blast_recipients br
       LEFT JOIN candidates c ON c.phone = br.phone
       WHERE br.blast_id = ?
       ORDER BY br.status, c.last_name, c.first_name`
    ).all(blastId);
    res.json({ blast, recipients: recipients.map(r => ({ ...r, phone_display: formatPhone(r.phone) })) });
  });

  router.get('/api/blasts/:id/recipients/csv', (req, res) => {
    const blastId = Number(req.params.id);
    const blast = db.prepare('SELECT * FROM blasts WHERE id = ?').get(blastId);
    if (!blast) return res.status(404).json({ error: 'not_found' });
    const recipients = db.prepare(
      `SELECT br.phone, br.status, br.error, c.first_name, c.last_name
       FROM blast_recipients br
       LEFT JOIN candidates c ON c.phone = br.phone
       WHERE br.blast_id = ?
       ORDER BY br.status, c.last_name, c.first_name`
    ).all(blastId);
    const header = 'First Name,Last Name,Phone,Status,Error';
    const rows = recipients.map(r =>
      [r.first_name || '', r.last_name || '', formatPhone(r.phone), r.status, r.error || '']
        .map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="blast-' + blastId + '-recipients.csv"');
    res.send([header, ...rows].join('\n'));
  });

  router.get('/api/stats', (_req, res) => {
    res.json({
      candidates: db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n,
      interests: db.prepare('SELECT COUNT(*) AS n FROM interests').get().n,
      published: db.prepare("SELECT COUNT(*) AS n FROM job_orders WHERE status='Published'").get().n,
      blasts: db.prepare('SELECT COUNT(*) AS n FROM blasts').get().n,
      filled: db.prepare("SELECT COUNT(*) AS n FROM interests WHERE status='filled'").get().n,
    });
  });

  // ---- Candidates ----
  router.get('/api/candidates', (req, res) => {
    const q = String(req.query.q || '').trim();
    let rows;
    if (q) {
      const phone = normalizePhone(q);
      rows = db.prepare(
        `SELECT * FROM candidates WHERE phone = ? OR first_name LIKE ? OR last_name LIKE ? ORDER BY last_name, first_name LIMIT 200`,
      ).all(phone || '', `%${q}%`, `%${q}%`);
    } else {
      rows = db.prepare('SELECT * FROM candidates ORDER BY created_at DESC LIMIT 200').all();
    }
    res.json(rows.map((r) => ({ ...r, phone_display: formatPhone(r.phone) })));
  });

  router.post('/api/candidates/:phone/dnc', (req, res) => {
    const phone = normalizePhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'bad_phone' });
    markDoNotContact(db, phone, Boolean(req.body?.value ?? true));
    res.json({ ok: true });
  });

  // ---- Settings (admin only) ----
  router.get('/api/settings', auth.requireAdmin, (_req, res) => {
    const out = {};
    for (const k of SETTING_KEYS) out[k] = getSetting(db, k);
    if (out.whippy_api_key) out.whippy_api_key = '\u2022\u2022\u2022\u2022' + String(out.whippy_api_key).slice(-4);
    // Include whippy_users if cached
    const wu = getSetting(db, 'whippy_users');
    if (wu) { try { out.whippy_users = JSON.parse(wu); } catch { /* ignore */ } }
    res.json(out);
  });

  router.post('/api/settings', auth.requireAdmin, (req, res) => {
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!SETTING_KEYS.includes(k)) continue;
      if (k === 'whippy_api_key' && String(v).startsWith('\u2022\u2022\u2022\u2022')) continue;
      if (k === 'cooldown_hours' && (!Number.isFinite(Number(v)) || Number(v) < 0)) continue;
      setSetting(db, k, k === "whippy_from_number" ? (toE164(v) || v) : v);
    }
    res.json({ ok: true });
  });

  router.post('/api/settings/test-sms', auth.requireAdmin, async (_req, res) => {
    const provider = getProvider(db);
    const result = await provider.testConnection();
    res.json({ provider: provider.name, ...result });
  });

  // ---- Sync Whippy Users (manual trigger from Settings) ----
  router.post('/api/settings/sync-whippy-users', auth.requireAdmin, async (_req, res) => {
    const result = await syncWhippyUsers(db);
    res.json(result);
  });

  // ---- Get Whippy Users (for blast recruiter dropdown) ----
  router.get('/api/whippy-users', (_req, res) => {
    const wu = getSetting(db, 'whippy_users');
    try { res.json(wu ? JSON.parse(wu) : []); } catch { res.json([]); }
  });

  // ---- Remove Whippy User (from cached list) ----
  router.delete('/api/whippy-users/:id', auth.requireAdmin, (req, res) => {
    const wu = getSetting(db, 'whippy_users');
    let users = [];
    try { users = wu ? JSON.parse(wu) : []; } catch { users = []; }
    const targetId = req.params.id;
    const before = users.length;
    users = users.filter(u => String(u.id) !== String(targetId));
    if (users.length === before) return res.status(404).json({ error: 'user not found in cached list' });
    setSetting(db, 'whippy_users', JSON.stringify(users));
    res.json({ ok: true, remaining: users.length });
  });


  // ---- Templates (admin only) ----
  router.get('/api/templates', (_req, res) => {
    res.json(db.prepare('SELECT * FROM templates ORDER BY is_default DESC, id').all());
  });
  router.post('/api/templates', auth.requireAdmin, (req, res) => {
    const { name, body, category } = req.body || {};
    if (!name || !body) return res.status(400).json({ error: 'name and body required' });
    if (!String(body).includes('{link}')) return res.status(400).json({ error: 'Template must include {link}' });
    const r = db.prepare('INSERT INTO templates (name, body, category) VALUES (?, ?, ?)').run(name, body, category || null);
    res.json({ id: Number(r.lastInsertRowid) });
  });
  router.delete('/api/templates/:id', auth.requireAdmin, (req, res) => {
    const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'not_found' });
    if (t.is_default) return res.status(400).json({ error: 'cannot delete the default template' });
    db.prepare('DELETE FROM templates WHERE id = ?').run(t.id);
    res.json({ ok: true });
  });

  router.patch('/api/templates/:id', auth.requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
    if (!t) return res.status(404).json({ error: 'not_found' });
    const { name, body, category } = req.body || {};
    if (name !== undefined) db.prepare('UPDATE templates SET name = ? WHERE id = ?').run(String(name), id);
    if (body !== undefined) {
      if (!String(body).includes('{link}')) return res.status(400).json({ error: 'Template must include {link}' });
      db.prepare('UPDATE templates SET body = ? WHERE id = ?').run(String(body), id);
    }
    if (category !== undefined) {
      const validCats = ['Industrial', 'Administrative', 'Skilled Trade', ''];
      const cat = category === null ? '' : String(category);
      if (cat && !validCats.includes(cat)) return res.status(400).json({ error: 'Invalid category' });
      db.prepare('UPDATE templates SET category = ? WHERE id = ?').run(cat || null, id);
    }
    res.json(db.prepare('SELECT * FROM templates WHERE id = ?').get(id));
  });

  router.put('/api/templates/:id/default', auth.requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
    if (!t) return res.status(404).json({ error: 'not_found' });
    const cat = t.category;
    if (cat) {
      db.prepare('UPDATE templates SET is_default = 0 WHERE category = ? AND id != ?').run(cat, id);
    } else {
      db.prepare("UPDATE templates SET is_default = 0 WHERE (category IS NULL OR category = '') AND id != ?").run(id);
    }
    db.prepare('UPDATE templates SET is_default = 1 WHERE id = ?').run(id);
    res.json(db.prepare('SELECT * FROM templates WHERE id = ?').get(id));
  });

  // ---- Users (admin only) ----
  router.get('/api/users', auth.requireAdmin, (_req, res) => {
    res.json(db.prepare('SELECT id, username, display_name, role, email, email_verified, created_at FROM users').all());
  });
  router.post('/api/users', auth.requireAdmin, (req, res) => {
    const { username, password, role, email } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    try {
      const r = db.prepare('INSERT INTO users (username, password_hash, role, email, email_verified) VALUES (?, ?, ?, ?, ?)')
        .run(String(username), bcrypt.hashSync(String(password), 10), role === 'admin' ? 'admin' : 'recruiter',
             email ? String(email) : null, email ? 1 : 0);
      res.json({ id: Number(r.lastInsertRowid) });
    } catch { res.status(400).json({ error: 'username or email taken' }); }
  });
  // PATCH user — edit display_name, username, role, email
  router.patch('/api/users/:id', auth.requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'not_found' });
    const { display_name, username, role, email } = req.body || {};
    if (display_name !== undefined) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(display_name), id);
    if (username !== undefined) {
      const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(String(username), id);
      if (existing) return res.status(400).json({ error: 'username taken' });
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(String(username), id);
    }
    if (role !== undefined) {
      const validRole = role === 'admin' ? 'admin' : 'recruiter';
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(validRole, id);
    }
    if (email !== undefined) {
      if (email) {
        const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(String(email), id);
        if (existing) return res.status(400).json({ error: 'email taken' });
        db.prepare('UPDATE users SET email = ? WHERE id = ?').run(String(email), id);
      } else {
        db.prepare('UPDATE users SET email = NULL WHERE id = ?').run(id);
      }
    }
    res.json(db.prepare('SELECT id, username, display_name, role, email, email_verified, created_at FROM users WHERE id = ?').get(id));
  });
  router.post('/api/users/:id/password', auth.requireAdmin, (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'password required' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(password), 10), Number(req.params.id));
    res.json({ ok: true });
  });

  // ---- Onboarding (first-login setup wizard) ----
  router.post('/api/onboarding/complete', auth.requireAdmin, (_req, res) => {
    setSetting(db, 'onboarded', '1');
    res.json({ ok: true });
  });
  router.post('/api/onboarding/reset', auth.requireAdmin, (_req, res) => {
    setSetting(db, 'onboarded', '0'); // lets Admin re-run the wizard
    res.json({ ok: true });
  });

  // Change YOUR OWN password (used by the onboarding wizard; requires the current one)
  router.post('/api/me/password', (req, res) => {
    const { current, password } = req.body || {};
    if (!password || String(password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.user.username);
    if (!user || !bcrypt.compareSync(String(current || ''), user.password_hash)) {
      return res.status(401).json({ error: 'current password is wrong' });
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(password), 10), user.id);
    res.json({ ok: true });
  });

  // ---- Feedback + Changelog ----
  router.get('/api/feedback', auth.requireAdmin, (_req, res) => {
    res.json(db.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT 100').all());
  });
  router.post('/api/feedback', (req, res) => {
    const { body, type } = req.body || {};
    if (!body) return res.status(400).json({ error: 'body required' });
    const author = req.user?.username || null;
    const fbType = type || 'general';
    db.prepare('INSERT INTO feedback (author, body, type) VALUES (?, ?, ?)').run(author, String(body), fbType);
    // Send email notification
    sendFeedbackEmail(author, body);
    res.json({ ok: true });
  });
  router.get('/api/changelog', (_req, res) => {
    res.json(db.prepare('SELECT * FROM changelog ORDER BY id DESC LIMIT 50').all());
  });
  router.post('/api/changelog', auth.requireAdmin, (req, res) => {
    const { version, notes } = req.body || {};
    if (!version || !notes) return res.status(400).json({ error: 'version and notes required' });
    db.prepare('INSERT INTO changelog (version, notes) VALUES (?, ?)').run(String(version), String(notes));
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createAdminRoutes };
