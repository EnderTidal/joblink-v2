const fs = require('fs');
const file = '/root/joblink-v2-staging/routes/auth.js';
let src = fs.readFileSync(file, 'utf8');

// Check if FUNCTION is present (not just in return statement)
if ((src.match(/function requireApiKeyOrAuth/g) || []).length > 0) {
  console.log('function already present');
  process.exit(0);
}

const BEARER_FN = `
  function requireApiKeyOrAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      const raw = authHeader.slice(7).trim();
      const hash = require('node:crypto').createHash('sha256').update(raw).digest('hex');
      const key = sysDb.prepare(
        'SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL'
      ).get(hash);
      if (!key) return res.status(401).json({ error: 'invalid_api_key' });
      try { sysDb.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(key.id); } catch {}
      const user = sysDb.prepare('SELECT * FROM users WHERE id = ?').get(key.user_id);
      if (!user) return res.status(401).json({ error: 'invalid_api_key' });
      req.user = { username: user.username, role: user.role, email: user.email || '', display_name: user.display_name || '', org_id: key.org_id, user_id: user.id };
      return next();
    }
    return requireAuth(req, res, next);
  }

`;

// Insert right before the return statement
src = src.replace(
  '  return { router, requireAuth, requireAdmin, requireApiKeyOrAuth, sysDb };',
  BEARER_FN + '  return { router, requireAuth, requireAdmin, requireApiKeyOrAuth, sysDb };'
);

fs.writeFileSync(file, src);
console.log('requireApiKeyOrAuth function injected before return');
