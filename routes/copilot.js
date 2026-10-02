// routes/copilot.js — Read-only REST API for Microsoft Copilot integration.
// Auth: session cookie (same as all other /api routes, handled by billing + tenant middleware).
// All endpoints return flat JSON for easy Copilot consumption.

const express = require('express');

function createCopilotRoutes(auth) {
  const router = express.Router();

  // GET /api/copilot/candidates — list candidates with optional filters
  router.get('/api/copilot/candidates', auth.requireApiKeyOrAuth, (req, res) => {
    try {
      const { status, search, limit = 100, offset = 0 } = req.query;
      let q = 'SELECT phone, first_name, last_name, current_category, do_not_contact, last_blast, blast_count, created_at FROM candidates WHERE 1=1';
      const params = [];
      if (status === 'active') { q += ' AND do_not_contact = 0'; }
      if (status === 'dnc') { q += ' AND do_not_contact = 1'; }
      if (search) { q += ' AND (first_name LIKE ? OR last_name LIKE ? OR phone LIKE ?)'; params.push('%' + search + '%', '%' + search + '%', '%' + search + '%'); }
      q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(Number(limit), Number(offset));
      const rows = req.db.prepare(q).all(...params);
      res.json({ candidates: rows, count: rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/copilot/candidates/summary — counts by status
  router.get('/api/copilot/candidates/summary', auth.requireApiKeyOrAuth, (req, res) => {
    try {
      const total = req.db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
      const active = req.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE do_not_contact = 0').get().n;
      const dnc = req.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE do_not_contact = 1').get().n;
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const newThisWeek = req.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE created_at >= ?').get(weekAgo).n;
      const byCategory = req.db.prepare('SELECT current_category AS category, COUNT(*) AS count FROM candidates WHERE current_category IS NOT NULL GROUP BY current_category').all();
      res.json({ total, active, dnc, newThisWeek, byCategory });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/copilot/job-orders — active job orders with fill stats
  router.get('/api/copilot/job-orders', auth.requireApiKeyOrAuth, (req, res) => {
    try {
      const { status = 'Published' } = req.query;
      const q = status === 'all'
        ? 'SELECT id, title, category, status, location, city_state, pay, shift_hours, created_at FROM job_orders ORDER BY created_at DESC'
        : 'SELECT id, title, category, status, location, city_state, pay, shift_hours, created_at FROM job_orders WHERE status = ? ORDER BY created_at DESC';
      const rows = status === 'all' ? req.db.prepare(q).all() : req.db.prepare(q).all(status);
      // Append interest counts
      const withCounts = rows.map(jo => {
        const interested = req.db.prepare("SELECT COUNT(*) AS n FROM interests WHERE job_order_id = ? AND status = 'interested'").get(jo.id).n;
        const yeslisted = req.db.prepare("SELECT COUNT(*) AS n FROM interests WHERE job_order_id = ? AND status = 'yes_listed'").get(jo.id).n;
        return Object.assign({}, jo, { interested_count: interested, yes_listed_count: yeslisted });
      });
      res.json({ job_orders: withCounts, count: withCounts.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/copilot/job-orders/summary — open positions, fill rate
  router.get('/api/copilot/job-orders/summary', auth.requireApiKeyOrAuth, (req, res) => {
    try {
      const published = req.db.prepare("SELECT COUNT(*) AS n FROM job_orders WHERE status = 'Published'").get().n;
      const total = req.db.prepare('SELECT COUNT(*) AS n FROM job_orders').get().n;
      const totalInterested = req.db.prepare("SELECT COUNT(*) AS n FROM interests WHERE status IN ('interested','yes_listed')").get().n;
      res.json({ published_jos: published, total_jos: total, total_active_pipeline: totalInterested });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/copilot/blasts — recent blasts with delivery stats
  router.get('/api/copilot/blasts', auth.requireApiKeyOrAuth, (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const blasts = req.db.prepare(
        'SELECT id, sent_at, category, sent_count, skipped_cooldown_count, skipped_dnc_count, failed_count, sent_by FROM blasts ORDER BY id DESC LIMIT ?'
      ).all(limit);
      const withResponses = blasts.map(b => {
        const responded = req.db.prepare('SELECT COUNT(*) AS n FROM interests WHERE blast_id = ?').get(b.id).n;
        return Object.assign({}, b, { responded });
      });
      res.json({ blasts: withResponses, count: withResponses.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/copilot/placements — interests in yes_listed/confirmed (closest to placements in V2)
  router.get('/api/copilot/placements', auth.requireApiKeyOrAuth, (req, res) => {
    try {
      const { from, to } = req.query;
      let q = "SELECT i.id, i.phone, i.job_order_id, i.status, i.created_at, jo.title AS job_title, jo.category FROM interests i LEFT JOIN job_orders jo ON jo.id = i.job_order_id WHERE i.status IN ('yes_listed','confirmed')";
      const params = [];
      if (from) { q += ' AND i.created_at >= ?'; params.push(from); }
      if (to) { q += ' AND i.created_at <= ?'; params.push(to); }
      q += ' ORDER BY i.created_at DESC LIMIT 200';
      const rows = req.db.prepare(q).all(...params);
      res.json({ placements: rows, count: rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/copilot/metrics — key metrics in one call
  router.get('/api/copilot/metrics', auth.requireApiKeyOrAuth, (req, res) => {
    try {
      const candidates = req.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE do_not_contact = 0').get().n;
      const activeJos = req.db.prepare("SELECT COUNT(*) AS n FROM job_orders WHERE status = 'Published'").get().n;
      const totalSent = req.db.prepare('SELECT COALESCE(SUM(sent_count),0) AS n FROM blasts').get().n;
      const totalInterested = req.db.prepare("SELECT COUNT(*) AS n FROM interests WHERE status = 'interested'").get().n;
      const responseRate = totalSent > 0 ? Math.round((totalInterested / totalSent) * 100 * 10) / 10 : 0;
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
      const newThisWeek = req.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE created_at >= ?').get(weekAgo).n;
      const blastedThisWeek = req.db.prepare("SELECT COALESCE(SUM(sent_count),0) AS n FROM blasts WHERE sent_at >= ?").get(weekAgo).n;
      const placementsThisMonth = req.db.prepare("SELECT COUNT(*) AS n FROM interests WHERE status IN ('yes_listed','confirmed') AND created_at >= ?").get(monthAgo).n;
      res.json({
        active_candidates: candidates,
        published_job_orders: activeJos,
        response_rate_pct: responseRate,
        new_candidates_this_week: newThisWeek,
        messages_sent_this_week: blastedThisWeek,
        placements_this_month: placementsThisMonth,
        total_messages_sent: totalSent
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/copilot/openapi.json — OpenAPI 3.0 spec for Copilot auto-discovery
  router.get('/api/copilot/openapi.json', auth.requireApiKeyOrAuth, (req, res) => {
    const base = req.protocol + '://' + req.get('host');
    res.json({
      openapi: '3.0.0',
      info: { title: 'JobLink Copilot API', version: '1.0.0', description: 'Read-only API for Microsoft Copilot integration. All endpoints require authentication via session cookie.' },
      servers: [{ url: base }],
      security: [{ cookieAuth: [] }],
      components: {
        securitySchemes: {
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'jl_session' }
        }
      },
      paths: {
        '/api/copilot/metrics': {
          get: { summary: 'Key metrics', operationId: 'getMetrics', description: 'Returns active candidates, published JOs, response rate, weekly/monthly activity in one call.', responses: { '200': { description: 'Metrics object', content: { 'application/json': { schema: { type: 'object', properties: { active_candidates: { type: 'integer' }, published_job_orders: { type: 'integer' }, response_rate_pct: { type: 'number' }, new_candidates_this_week: { type: 'integer' }, messages_sent_this_week: { type: 'integer' }, placements_this_month: { type: 'integer' }, total_messages_sent: { type: 'integer' } } } } } } } }
        },
        '/api/copilot/candidates/summary': {
          get: { summary: 'Candidate counts', operationId: 'getCandidateSummary', description: 'Returns total, active, DNC counts and new-this-week.', responses: { '200': { description: 'Summary object' } } }
        },
        '/api/copilot/candidates': {
          get: { summary: 'List candidates', operationId: 'listCandidates', parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'dnc'] } }, { name: 'search', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } }, { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }], responses: { '200': { description: 'Candidate list' } } }
        },
        '/api/copilot/job-orders/summary': {
          get: { summary: 'Job order summary', operationId: 'getJoSummary', description: 'Returns published JO count, total JOs, active pipeline.', responses: { '200': { description: 'Summary object' } } }
        },
        '/api/copilot/job-orders': {
          get: { summary: 'List job orders', operationId: 'listJobOrders', parameters: [{ name: 'status', in: 'query', schema: { type: 'string', default: 'Published' } }], responses: { '200': { description: 'Job order list' } } }
        },
        '/api/copilot/blasts': {
          get: { summary: 'Recent blasts', operationId: 'listBlasts', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } }], responses: { '200': { description: 'Blast list with delivery stats' } } }
        },
        '/api/copilot/placements': {
          get: { summary: 'Placements (yes-listed/confirmed)', operationId: 'listPlacements', parameters: [{ name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }], responses: { '200': { description: 'Placement list' } } }
        }
      }
    });
  });

  return router;
}

module.exports = { createCopilotRoutes };
