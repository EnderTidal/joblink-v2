// Admin + Dashboard API: job order actions, candidates, settings, templates,
// users, feedback, changelog, provider test. Multi-tenant: uses req.db for
// tenant data, sysDb for user management.

const express = require('express');
const bcrypt = require('bcryptjs');
const https = require('node:https');
const { listJobOrders, setStatus, updateJobOrder, reorderJobOrders } = require('../src/job-orders');
const { listBlasts, markDoNotContact } = require('../src/blast');
const { getProvider } = require('../src/messaging');
const { getSetting, setSetting, logInterestEvent } = require('../src/db');
const { normalizePhone, formatPhone, toE164 } = require("../src/phone");
const { listOrgUsers, updateUser } = require('../src/system-db');

const SETTING_KEYS = ['cooldown_hours', 'sms_provider', 'whippy_api_key', 'whippy_channel_id', 'whippy_from_number', 'whippy_numbers', 'whippy_channels', 'whippy_users'];

const RESEND_KEY = process.env.RESEND_KEY || '';
const FEEDBACK_EMAIL = 'support@joblinkplatform.com';

/** Fetch Whippy team members from ALL selected channels (or fallback) and cache in settings */
async function syncWhippyUsers(db, preview) {
  const apiKey = getSetting(db, 'whippy_api_key');
  if (!apiKey) return { ok: false, error: 'no_api_key' };

  // Helper: single page fetch
  function fetchPage(urlPath) {
    return new Promise((resolve) => {
      const opts = {
        hostname: 'api.whippy.co',
        port: 443,
        path: urlPath,
        method: 'GET',
        headers: { 'X-WHIPPY-KEY': apiKey, 'Content-Type': 'application/json' },
      };
      const req = https.request(opts, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return resolve({ ok: false, error: 'Whippy ' + res.statusCode + ': ' + out });
            }
            const parsed = JSON.parse(out);
            const users = parsed.data || parsed.users || [];
            resolve({ ok: true, users: Array.isArray(users) ? users : [] });
          } catch (e) {
            resolve({ ok: false, error: e.message });
          }
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.end();
    });
  }

  // Priority 1: Read whippy_channels (JSON array of {id, phone, name})
  let channelIds = [];
  const channelsRaw = getSetting(db, 'whippy_channels');
  if (channelsRaw) {
    try {
      const channels = JSON.parse(channelsRaw);
      if (Array.isArray(channels)) channelIds = channels.map(c => c.id).filter(Boolean);
    } catch { /* ignore parse errors */ }
  }

  // Priority 2: Fall back to single whippy_channel_id
  if (!channelIds.length) {
    const channelId = getSetting(db, 'whippy_channel_id');
    const isValidUuid = channelId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(channelId);
    if (isValidUuid) channelIds = [channelId];
  }

  const allUsers = [];
  const seenIds = new Set();

  if (channelIds.length > 0) {
    // Fetch users from ALL selected channels, deduplicate by user ID
    for (const chId of channelIds) {
      const result = await fetchPage('/v1/channels/' + chId + '/users?limit=200');
      if (!result.ok) {
        console.log('[sync] Warning: failed to fetch users for channel ' + chId + ': ' + result.error);
        continue;
      }
      for (const u of result.users) {
        const uid = String(u.id);
        if (!seenIds.has(uid)) {
          seenIds.add(uid);
          allUsers.push(u);
        }
      }
    }
    console.log('[sync] Multi-channel user sync: ' + allUsers.length + ' unique users from ' + channelIds.length + ' channel(s)');
  } else {
    // No channels configured — require channel setup first
    return { ok: false, error: 'No channels configured. Set up your Whippy channels in Admin settings first.' };
  }

  const mapped = allUsers.map((u) => ({
    id: u.id,
    name: u.name || u.full_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Unknown',
    email: u.email || '',
  }));
  if (!preview) setSetting(db, 'whippy_users', JSON.stringify(mapped));
  return { ok: true, count: mapped.length, users: mapped };
}

/** Send feedback email via Resend */
function sendFeedbackEmail(username, feedbackBody) {
  const now = new Date().toISOString();
  const data = JSON.stringify({
    from: 'JobLink <admin@joblinkplatform.com>',
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

function createAdminRoutes(sysDb, auth) {
  const router = express.Router();

  // ---- Dashboard ----
  router.get('/api/job-orders', (req, res) => {
    res.json(listJobOrders(req.db, { status: req.query.status, category: req.query.category, recruiter: req.query.recruiter }));
  });

  router.post('/api/job-orders/:id/status', (req, res, next) => {
    try { res.json(setStatus(req.db, Number(req.params.id), req.body?.status)); }
    catch (err) { next(err); }
  });

  router.patch('/api/job-orders/:id', (req, res, next) => {
    try { res.json(updateJobOrder(req.db, Number(req.params.id), req.body || {})); }
    catch (err) { next(err); }
  });

  // Reorder job orders (recruiter sets candidate-facing sort order)
  router.post('/api/job-orders/reorder', auth.requireAdmin, (req, res, next) => {
    try {
      const orderings = req.body?.orderings;
      if (!Array.isArray(orderings)) return res.status(400).json({ error: 'orderings array required' });
      reorderJobOrders(req.db, orderings);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

router.delete("/api/job-orders/:id", auth.requireAdmin, (req, res, next) => {
    try {
      const id = Number(req.params.id);
      // Log events for all interests being deleted
      const interests = req.db.prepare("SELECT phone, job_order_id, status FROM interests WHERE job_order_id = ?").all(id);
      for (const interest of interests) {
        logInterestEvent(req.db, interest.phone, interest.job_order_id, interest.status, 'deleted', req.user?.username || 'admin');
      }
      req.db.prepare("DELETE FROM interests WHERE job_order_id = ?").run(id);
      req.db.prepare("DELETE FROM job_orders WHERE id = ?").run(id);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ---- Single Job Order detail with interested candidates grouped by status ----
  router.get('/api/job-orders/:id', (req, res) => {
    const id = Number(req.params.id);
    const jo = req.db.prepare(
      `SELECT jo.*,
        (SELECT COUNT(*) FROM interests i WHERE i.job_order_id = jo.id AND i.status = 'interested') AS interested_count,
        (SELECT COUNT(*) FROM interests i WHERE i.job_order_id = jo.id AND i.status = 'yes_listed') AS yeslisted_count,
        (SELECT COUNT(*) FROM interests i WHERE i.job_order_id = jo.id AND i.status = 'confirmed') AS confirmed_count,
        (SELECT COUNT(*) FROM interests i WHERE i.job_order_id = jo.id AND i.status = 'filled') AS filled_count,
        (SELECT COUNT(*) FROM interests i WHERE i.job_order_id = jo.id AND i.status = 'ruled_out') AS ruled_out_count
       FROM job_orders jo WHERE jo.id = ?`
    ).get(id);
    if (!jo) return res.status(404).json({ error: 'not_found' });
    const allInterests = req.db.prepare(
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
    const interest = req.db.prepare('SELECT * FROM interests WHERE id = ?').get(id);
    if (!interest) return res.status(404).json({ error: 'interest not found' });
    const fromStatus = interest.status;
    req.db.prepare('UPDATE interests SET status = ? WHERE id = ?').run(status, id);
    // Log the status transition
    logInterestEvent(req.db, interest.phone, interest.job_order_id, fromStatus, status, req.user?.username || null);
    res.json({ ok: true, id, status });
  });

  router.get('/api/blasts', (req, res) => res.json(listBlasts(req.db, 50)));

  // ---- Blast Recipients (expandable blast detail) ----
  router.get('/api/blasts/:id/recipients', (req, res) => {
    const blastId = Number(req.params.id);
    const blast = req.db.prepare('SELECT * FROM blasts WHERE id = ?').get(blastId);
    if (!blast) return res.status(404).json({ error: 'not_found' });
    const recipients = req.db.prepare(
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
    const blast = req.db.prepare('SELECT * FROM blasts WHERE id = ?').get(blastId);
    if (!blast) return res.status(404).json({ error: 'not_found' });
    const recipients = req.db.prepare(
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

  router.get('/api/stats', (req, res) => {
    res.json({
      candidates: req.db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n,
      interests: req.db.prepare('SELECT COUNT(*) AS n FROM interests').get().n,
      published: req.db.prepare("SELECT COUNT(*) AS n FROM job_orders WHERE status='Published'").get().n,
      blasts: req.db.prepare('SELECT COUNT(*) AS n FROM blasts').get().n,
      filled: req.db.prepare("SELECT COUNT(*) AS n FROM interests WHERE status='filled'").get().n,
    });
  });

  // ---- Candidates ----
  router.get('/api/candidates', (req, res) => {
    const q = String(req.query.q || '').trim();
    let rows;
    if (q) {
      const phone = normalizePhone(q);
      rows = req.db.prepare(
        `SELECT * FROM candidates WHERE phone = ? OR first_name LIKE ? OR last_name LIKE ? ORDER BY last_name, first_name LIMIT 200`,
      ).all(phone || '', `%${q}%`, `%${q}%`);
    } else {
      rows = req.db.prepare('SELECT * FROM candidates ORDER BY created_at DESC LIMIT 200').all();
    }
    res.json(rows.map((r) => ({ ...r, phone_display: formatPhone(r.phone) })));
  });

  router.post('/api/candidates/:phone/dnc', (req, res) => {
    const phone = normalizePhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'bad_phone' });
    markDoNotContact(req.db, phone, Boolean(req.body?.value ?? true));
    res.json({ ok: true });
  });

  // ---- Interest Events (audit log / analytics) ----
  router.get('/api/interest-events', (req, res) => {
    const phone = req.query.phone ? normalizePhone(req.query.phone) : null;
    const jobOrderId = req.query.job_order_id ? Number(req.query.job_order_id) : null;
    const limit = Math.min(Number(req.query.limit) || 200, 1000);

    let sql = 'SELECT * FROM interest_events WHERE 1=1';
    const params = [];
    if (phone) { sql += ' AND phone = ?'; params.push(phone); }
    if (jobOrderId) { sql += ' AND job_order_id = ?'; params.push(jobOrderId); }
    sql += ' ORDER BY changed_at DESC LIMIT ?';
    params.push(limit);

    try {
      const rows = req.db.prepare(sql).all(...params);
      res.json(rows.map(r => ({ ...r, phone_display: formatPhone(r.phone) })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/api/interest-events/summary', (req, res) => {
    try {
      // Events per day (last 30 days)
      const eventsPerDay = req.db.prepare(
        `SELECT date(changed_at) AS day, COUNT(*) AS event_count
         FROM interest_events
         WHERE changed_at >= datetime('now', '-30 days')
         GROUP BY date(changed_at)
         ORDER BY day DESC`
      ).all();

      // Transition counts (how many of each from->to)
      const transitions = req.db.prepare(
        `SELECT from_status, to_status, COUNT(*) AS count
         FROM interest_events
         GROUP BY from_status, to_status
         ORDER BY count DESC`
      ).all();

      // Triage rate: how many interests moved past 'interested' vs total
      const totalInterested = req.db.prepare(
        `SELECT COUNT(*) AS n FROM interest_events WHERE to_status = 'interested'`
      ).get().n;
      const triaged = req.db.prepare(
        `SELECT COUNT(DISTINCT phone || '-' || job_order_id) AS n
         FROM interest_events
         WHERE from_status = 'interested' AND to_status != 'interested'`
      ).get().n;

      // Avg time-to-triage (interested -> first non-interested status)
      const avgTriageRows = req.db.prepare(
        `SELECT AVG(triage_seconds) AS avg_seconds FROM (
           SELECT ie2.phone, ie2.job_order_id,
             (julianday(ie2.changed_at) - julianday(ie1.changed_at)) * 86400 AS triage_seconds
           FROM interest_events ie1
           JOIN interest_events ie2 ON ie1.phone = ie2.phone AND ie1.job_order_id = ie2.job_order_id
           WHERE ie1.to_status = 'interested'
             AND ie2.from_status = 'interested'
             AND ie2.to_status != 'interested'
             AND ie2.changed_at > ie1.changed_at
           GROUP BY ie2.phone, ie2.job_order_id
         )`
      ).get();

      const avgTriageHours = avgTriageRows.avg_seconds
        ? Math.round((avgTriageRows.avg_seconds / 3600) * 10) / 10
        : null;

      res.json({
        events_per_day: eventsPerDay,
        transitions,
        triage_rate: {
          total_interested: totalInterested,
          triaged,
          pct: totalInterested > 0 ? Math.round((triaged / totalInterested) * 100) : 0,
        },
        avg_time_to_triage_hours: avgTriageHours,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Settings (admin only) ----
  router.get('/api/settings', auth.requireAdmin, (req, res) => {
    const out = {};
    for (const k of SETTING_KEYS) out[k] = getSetting(req.db, k);
    if (out.whippy_api_key) out.whippy_api_key = '\u2022\u2022\u2022\u2022' + String(out.whippy_api_key).slice(-4);
    const wu = getSetting(req.db, 'whippy_users');
    if (wu) { try { out.whippy_users = JSON.parse(wu); } catch { /* ignore */ } }
    const wn = getSetting(req.db, 'whippy_numbers');
    if (wn) { try { out.whippy_numbers = JSON.parse(wn); } catch { /* ignore */ } }
    res.json(out);
  });

  router.post('/api/settings', auth.requireAdmin, (req, res) => {
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!SETTING_KEYS.includes(k)) continue;
      if (k === 'whippy_api_key' && String(v).startsWith('\u2022\u2022\u2022\u2022')) continue;
      if (k === 'cooldown_hours' && (!Number.isFinite(Number(v)) || Number(v) < 0)) continue;
      setSetting(req.db, k, k === "whippy_from_number" ? (toE164(v) || v) : v);
    }
    res.json({ ok: true });
  });

  router.post('/api/settings/test-sms', auth.requireAdmin, async (req, res) => {
    const provider = getProvider(req.db);
    const result = await provider.testConnection();
    res.json({ provider: provider.name, ...result });
  });

  // ---- Multi-Number Management (up to 5) ----
  router.get('/api/settings/numbers', auth.requireAdmin, (req, res) => {
    const raw = getSetting(req.db, 'whippy_numbers');
    let numbers = [];
    if (raw) { try { numbers = JSON.parse(raw); } catch { /* ignore */ } }
    // Backward compat: if no whippy_numbers but single number exists, return it
    if (!numbers.length) {
      const fromNumber = getSetting(req.db, 'whippy_from_number');
      const channelId = getSetting(req.db, 'whippy_channel_id');
      if (fromNumber && channelId) {
        numbers = [{ from_number: fromNumber, channel_id: channelId, label: 'Primary' }];
      }
    }
    res.json(numbers);
  });

  router.post('/api/settings/numbers', auth.requireAdmin, (req, res) => {
    const numbers = req.body?.numbers;
    if (!Array.isArray(numbers)) return res.status(400).json({ error: 'numbers must be an array' });
    if (numbers.length > 5) return res.status(400).json({ error: 'Maximum 5 numbers allowed' });
    // Validate each entry
    for (let i = 0; i < numbers.length; i++) {
      const n = numbers[i];
      if (!n.from_number || !n.channel_id) {
        return res.status(400).json({ error: 'Each number must have from_number and channel_id (entry ' + (i + 1) + ')' });
      }
      // Normalize from_number to E.164
      const e164 = toE164(n.from_number);
      if (e164) n.from_number = e164;
      if (!n.label) n.label = 'Number ' + (i + 1);
    }
    setSetting(req.db, 'whippy_numbers', JSON.stringify(numbers));
    // Also save as whippy_channels (JSON array with id, phone, name) for multi-channel user sync
    const channels = numbers.map(n => ({ id: n.channel_id, phone: n.from_number, name: n.label || '' }));
    setSetting(req.db, 'whippy_channels', JSON.stringify(channels));
    // Keep backward compat: update primary single-number fields with first entry
    if (numbers.length > 0) {
      setSetting(req.db, 'whippy_from_number', numbers[0].from_number);
      setSetting(req.db, 'whippy_channel_id', numbers[0].channel_id);
    }
    res.json({ ok: true, count: numbers.length });
  });

  // ---- Sync Whippy Users ----
  router.post('/api/settings/sync-whippy-users', auth.requireAdmin, async (req, res) => {
    const preview = req.body && req.body.preview;
    const result = await syncWhippyUsers(req.db, preview);
    res.json(result);
  });

  // ---- Fetch Whippy Channels (auto-detect numbers) ----
  router.post('/api/settings/fetch-channels', auth.requireAdmin, async (req, res) => {
    // Use API key from request body (during onboarding) or from saved settings
    const apiKey = req.body?.whippy_api_key || getSetting(req.db, 'whippy_api_key');
    if (!apiKey) return res.status(400).json({ ok: false, error: 'No API key provided' });

    try {
      const channels = await new Promise((resolve, reject) => {
        const opts = {
          hostname: 'api.whippy.co',
          port: 443,
          path: '/v1/channels',
          method: 'GET',
          headers: { 'X-WHIPPY-KEY': apiKey, 'Content-Type': 'application/json' },
        };
        const req = https.request(opts, (httpRes) => {
          let out = '';
          httpRes.on('data', (c) => (out += c));
          httpRes.on('end', () => {
            try {
              if (httpRes.statusCode === 401) return reject(new Error('Invalid API key'));
              if (httpRes.statusCode < 200 || httpRes.statusCode >= 300) {
                return reject(new Error('Whippy returned ' + httpRes.statusCode));
              }
              const parsed = JSON.parse(out);
              const data = parsed.data || parsed.channels || [];
              resolve(Array.isArray(data) ? data : []);
            } catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.end();
      });

      // Map to simplified channel objects
      const mapped = channels
        .filter(c => c.type === 'phone' && c.phone) // only phone channels with a number
        .map(c => ({
          id: c.id,
          phone: c.phone,
          name: c.name || '',
          emoji: c.emoji || '',
          description: c.description || '',
        }));

      res.json({ ok: true, channels: mapped, total: mapped.length });
    } catch (err) {
      res.json({ ok: false, error: err.message || 'Failed to fetch channels', channels: [] });
    }
  });

  // ---- Get Whippy Users ----
  router.get('/api/whippy-users', (req, res) => {
    const wu = getSetting(req.db, 'whippy_users');
    try { res.json(wu ? JSON.parse(wu) : []); } catch { res.json([]); }
  });

  // ---- Remove Whippy User ----
  router.delete('/api/whippy-users/:id', auth.requireAdmin, (req, res) => {
    const wu = getSetting(req.db, 'whippy_users');
    let users = [];
    try { users = wu ? JSON.parse(wu) : []; } catch { users = []; }
    const targetId = req.params.id;
    const before = users.length;
    users = users.filter(u => String(u.id) !== String(targetId));
    if (users.length === before) return res.status(404).json({ error: 'user not found in cached list' });
    setSetting(req.db, 'whippy_users', JSON.stringify(users));
    res.json({ ok: true, remaining: users.length });
  });


  // ---- Templates (admin only) ----
  router.get('/api/templates', (req, res) => {
    res.json(req.db.prepare('SELECT * FROM templates ORDER BY is_default DESC, id').all());
  });
  router.post('/api/templates', auth.requireAdmin, (req, res) => {
    const { name, body, category } = req.body || {};
    if (!name || !body) return res.status(400).json({ error: 'name and body required' });
    if (!String(body).includes('{link}')) return res.status(400).json({ error: 'Template must include {link}' });
    const r = req.db.prepare('INSERT INTO templates (name, body, category) VALUES (?, ?, ?)').run(name, body, category || null);
    res.json({ id: Number(r.lastInsertRowid) });
  });
  router.delete('/api/templates/:id', auth.requireAdmin, (req, res) => {
    const t = req.db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'not_found' });
    if (t.is_default) return res.status(400).json({ error: 'cannot delete the default template' });
    req.db.prepare('DELETE FROM templates WHERE id = ?').run(t.id);
    res.json({ ok: true });
  });

  router.patch('/api/templates/:id', auth.requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const t = req.db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
    if (!t) return res.status(404).json({ error: 'not_found' });
    const { name, body, category } = req.body || {};
    if (name !== undefined) req.db.prepare('UPDATE templates SET name = ? WHERE id = ?').run(String(name), id);
    if (body !== undefined) {
      if (!String(body).includes('{link}')) return res.status(400).json({ error: 'Template must include {link}' });
      req.db.prepare('UPDATE templates SET body = ? WHERE id = ?').run(String(body), id);
    }
    if (category !== undefined) {
      const validCats = ['Industrial', 'Administrative', 'Skilled Trade', ''];
      const cat = category === null ? '' : String(category);
      if (cat && !validCats.includes(cat)) return res.status(400).json({ error: 'Invalid category' });
      req.db.prepare('UPDATE templates SET category = ? WHERE id = ?').run(cat || null, id);
    }
    res.json(req.db.prepare('SELECT * FROM templates WHERE id = ?').get(id));
  });

  router.put('/api/templates/:id/default', auth.requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const t = req.db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
    if (!t) return res.status(404).json({ error: 'not_found' });
    const cat = t.category;
    if (cat) {
      req.db.prepare('UPDATE templates SET is_default = 0 WHERE category = ? AND id != ?').run(cat, id);
    } else {
      req.db.prepare("UPDATE templates SET is_default = 0 WHERE (category IS NULL OR category = '') AND id != ?").run(id);
    }
    req.db.prepare('UPDATE templates SET is_default = 1 WHERE id = ?').run(id);
    res.json(req.db.prepare('SELECT * FROM templates WHERE id = ?').get(id));
  });

  // ---- Users (admin only — reads from SYSTEM DB, scoped to the admin's org) ----
  router.get('/api/users', auth.requireAdmin, (req, res) => {
    res.json(listOrgUsers(sysDb, req.user.org_id));
  });
  router.post('/api/users', auth.requireAdmin, (req, res) => {
    const { username, password, role, email } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    try {
      const r = sysDb.prepare(
        'INSERT INTO users (org_id, username, password_hash, role, email, email_verified) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(req.user.org_id, String(username), bcrypt.hashSync(String(password), 10),
            role === 'admin' ? 'admin' : 'recruiter', email ? String(email) : null, email ? 1 : 0);
      res.json({ id: Number(r.lastInsertRowid) });
    } catch { res.status(400).json({ error: 'username or email taken' }); }
  });
  // PATCH user — edit display_name, username, role, email (in system DB)
  router.patch('/api/users/:id', auth.requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const user = sysDb.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!user) return res.status(404).json({ error: 'not_found' });
    const { display_name, username, role, email } = req.body || {};
    if (display_name !== undefined) updateUser(sysDb, id, { display_name: String(display_name) });
    if (username !== undefined) {
      const existing = sysDb.prepare('SELECT id FROM users WHERE username = ? AND org_id = ? AND id != ?').get(String(username), req.user.org_id, id);
      if (existing) return res.status(400).json({ error: 'username taken' });
      updateUser(sysDb, id, { username: String(username) });
    }
    if (role !== undefined) {
      const validRole = role === 'admin' ? 'admin' : 'recruiter';
      updateUser(sysDb, id, { role: validRole });
    }
    if (email !== undefined) {
      if (email) {
        const existing = sysDb.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(String(email), id);
        if (existing) return res.status(400).json({ error: 'email taken' });
        updateUser(sysDb, id, { email: String(email) });
      } else {
        updateUser(sysDb, id, { email: null });
      }
    }
    const updated = sysDb.prepare('SELECT id, org_id, username, display_name, role, email, email_verified, created_at FROM users WHERE id = ?').get(id);
    res.json(updated);
  });
  router.post('/api/users/:id/password', auth.requireAdmin, (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'password required' });
    // Verify user belongs to admin's org
    const user = sysDb.prepare('SELECT id FROM users WHERE id = ? AND org_id = ?').get(Number(req.params.id), req.user.org_id);
    if (!user) return res.status(404).json({ error: 'not_found' });
    updateUser(sysDb, user.id, { password_hash: bcrypt.hashSync(String(password), 10) });
    res.json({ ok: true });
  });

  // ---- Onboarding (first-login setup wizard) ----
  router.post('/api/onboarding/complete', auth.requireAdmin, (req, res) => {
    setSetting(req.db, 'onboarded', '1');
    res.json({ ok: true });
  });
  router.post('/api/onboarding/reset', auth.requireAdmin, (req, res) => {
    setSetting(req.db, 'onboarded', '0');
    res.json({ ok: true });
  });

  // Change YOUR OWN password (used by the onboarding wizard; requires the current one)
  router.post('/api/me/password', (req, res) => {
    const { current, password } = req.body || {};
    if (!password || String(password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    const user = sysDb.prepare('SELECT * FROM users WHERE id = ?').get(req.user.user_id);
    if (!user || !bcrypt.compareSync(String(current || ''), user.password_hash)) {
      return res.status(401).json({ error: 'current password is wrong' });
    }
    updateUser(sysDb, user.id, { password_hash: bcrypt.hashSync(String(password), 10) });
    res.json({ ok: true });
  });

  // ---- Feedback + Changelog (tenant-scoped) ----
  router.get('/api/feedback', auth.requireAdmin, (req, res) => {
    res.json(req.db.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT 100').all());
  });
  router.post('/api/feedback', (req, res) => {
    const { body, type } = req.body || {};
    if (!body) return res.status(400).json({ error: 'body required' });
    const author = req.user?.username || null;
    const fbType = type || 'general';
    req.db.prepare('INSERT INTO feedback (author, body, type) VALUES (?, ?, ?)').run(author, String(body), fbType);
    sendFeedbackEmail(author, body);
    res.json({ ok: true });
  });
  router.get('/api/changelog', (req, res) => {
    res.json(req.db.prepare('SELECT * FROM changelog ORDER BY id DESC LIMIT 50').all());
  });
  router.post('/api/changelog', auth.requireAdmin, (req, res) => {
    const { version, notes } = req.body || {};
    if (!version || !notes) return res.status(400).json({ error: 'version and notes required' });
    req.db.prepare('INSERT INTO changelog (version, notes) VALUES (?, ?)').run(String(version), String(notes));
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createAdminRoutes };
