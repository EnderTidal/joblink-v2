// Admin + Dashboard API: job order actions, candidates, settings, templates,
// users, feedback, changelog, provider test. Dashboard rows get real actions
// (publish / unpublish / complete) — docs/DECISIONS.md.

const express = require('express');
const bcrypt = require('bcryptjs');
const { listJobOrders, setStatus, updateJobOrder } = require('../src/job-orders');
const { listBlasts, markDoNotContact } = require('../src/blast');
const { getProvider } = require('../src/messaging');
const { getSetting, setSetting } = require('../src/db');
const { normalizePhone, formatPhone } = require('../src/phone');

const SETTING_KEYS = ['cooldown_hours', 'sms_provider', 'whippy_api_key', 'whippy_channel_id', 'whippy_from_number'];

function createAdminRoutes(db, auth) {
  const router = express.Router();

  // ---- Dashboard ----
  router.get('/api/job-orders', (req, res) => {
    res.json(listJobOrders(db, { status: req.query.status, category: req.query.category }));
  });

  router.post('/api/job-orders/:id/status', (req, res, next) => {
    try { res.json(setStatus(db, Number(req.params.id), req.body?.status)); }
    catch (err) { next(err); }
  });

  router.patch('/api/job-orders/:id', (req, res, next) => {
    try { res.json(updateJobOrder(db, Number(req.params.id), req.body || {})); }
    catch (err) { next(err); }
  });



  // ---- Single Job Order detail with interested candidates ----
  router.get('/api/job-orders/:id', (req, res) => {
    const id = Number(req.params.id);
    const jo = db.prepare(
      `SELECT jo.*, (SELECT COUNT(*) FROM interests i WHERE i.job_order_id = jo.id) AS interested_count
       FROM job_orders jo WHERE jo.id = ?`
    ).get(id);
    if (!jo) return res.status(404).json({ error: 'not_found' });
    const interested = db.prepare(
      `SELECT c.phone, c.first_name, c.last_name, c.current_category, i.created_at AS interest_date
       FROM interests i
       JOIN candidates c ON c.phone = i.phone
       WHERE i.job_order_id = ?
       ORDER BY i.created_at DESC`
    ).all(id);
    res.json({ ...jo, interested_candidates: interested.map(c => ({ ...c, phone_display: formatPhone(c.phone) })) });
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
      published: db.prepare(`SELECT COUNT(*) AS n FROM job_orders WHERE status='Published'`).get().n,
      blasts: db.prepare('SELECT COUNT(*) AS n FROM blasts').get().n,
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
    if (out.whippy_api_key) out.whippy_api_key = '••••' + String(out.whippy_api_key).slice(-4);
    res.json(out);
  });

  router.post('/api/settings', auth.requireAdmin, (req, res) => {
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!SETTING_KEYS.includes(k)) continue;
      if (k === 'whippy_api_key' && String(v).startsWith('••••')) continue; // masked value round-trip
      if (k === 'cooldown_hours' && (!Number.isFinite(Number(v)) || Number(v) < 0)) continue;
      setSetting(db, k, v);
    }
    res.json({ ok: true });
  });

  router.post('/api/settings/test-sms', auth.requireAdmin, async (_req, res) => {
    const provider = getProvider(db);
    const result = await provider.testConnection();
    res.json({ provider: provider.name, ...result });
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
    res.json(db.prepare('SELECT id, username, role, created_at FROM users').all());
  });
  router.post('/api/users', auth.requireAdmin, (req, res) => {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    try {
      const r = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
        .run(String(username), bcrypt.hashSync(String(password), 10), role === 'admin' ? 'admin' : 'recruiter');
      res.json({ id: Number(r.lastInsertRowid) });
    } catch { res.status(400).json({ error: 'username taken' }); }
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
    const { body } = req.body || {};
    if (!body) return res.status(400).json({ error: 'body required' });
    db.prepare('INSERT INTO feedback (author, body) VALUES (?, ?)').run(req.user?.username || null, String(body));
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
