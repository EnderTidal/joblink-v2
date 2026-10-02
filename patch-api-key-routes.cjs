// Patch 2: Add API key endpoints to routes/admin.js
const fs = require('fs');
const crypto = require('crypto');
const file = '/root/joblink-v2-staging/routes/admin.js';
let src = fs.readFileSync(file, 'utf8');

if (src.includes('/api/settings/api-key/generate')) {
  console.log('✓ API key routes already present — skipping');
  process.exit(0);
}

const API_KEY_ROUTES = `
  // ---- API Key Management ----

  router.post('/api/settings/api-key/generate', auth.requireAdmin, (req, res) => {
    try {
      const { name = 'Default' } = req.body || {};
      const raw = 'jl_' + require('node:crypto').randomBytes(16).toString('hex');
      const prefix = raw.slice(0, 10); // jl_ + 7 chars
      const hash = require('node:crypto').createHash('sha256').update(raw).digest('hex');
      sysDb.prepare(
        'INSERT INTO api_keys (user_id, org_id, key_prefix, key_hash, name) VALUES (?, ?, ?, ?, ?)'
      ).run(req.user.user_id, req.user.org_id, prefix, hash, String(name).slice(0, 64));
      res.json({ ok: true, key: raw, prefix, name });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/api/settings/api-keys', auth.requireAuth, (req, res) => {
    try {
      const keys = sysDb.prepare(
        'SELECT id, key_prefix, name, created_at, last_used_at, revoked_at FROM api_keys WHERE org_id = ? ORDER BY id DESC'
      ).all(req.user.org_id);
      res.json({ keys });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/settings/api-key/:id', auth.requireAdmin, (req, res) => {
    try {
      const result = sysDb.prepare(
        "UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND org_id = ? AND revoked_at IS NULL"
      ).run(Number(req.params.id), req.user.org_id);
      if (result.changes === 0) return res.status(404).json({ error: 'key not found or already revoked' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

`;

// Inject before the final "return router;" line
src = src.replace(
  /(\s+return router;\s*\}\s*\nmodule\.exports)/,
  API_KEY_ROUTES + '\n  return router;\n}\n\nmodule.exports'
);

fs.writeFileSync(file, src);
console.log('✓ API key routes added to admin.js');
