// Patch 3: Add Bearer token auth middleware to auth.js, update copilot.js security scheme
const fs = require('fs');
const crypto = require('crypto');

// --- Patch auth.js ---
const authFile = '/root/joblink-v2-staging/routes/auth.js';
let authSrc = fs.readFileSync(authFile, 'utf8');

if (authSrc.includes('requireApiKeyOrAuth')) {
  console.log('✓ Bearer auth already present in auth.js — skipping');
} else {
  // Add requireApiKeyOrAuth after requireAdmin function
  const BEARER_MIDDLEWARE = `
  function requireApiKeyOrAuth(req, res, next) {
    // Check Bearer token first
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      const raw = authHeader.slice(7).trim();
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      // sysDb is in closure scope
      const key = sysDb.prepare(
        'SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL'
      ).get(hash);
      if (!key) return res.status(401).json({ error: 'invalid_api_key' });
      // Update last_used_at async (don't block)
      try { sysDb.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(key.id); } catch {}
      // Load user to populate req.user in the same shape as session auth
      const user = sysDb.prepare('SELECT * FROM users WHERE id = ?').get(key.user_id);
      if (!user) return res.status(401).json({ error: 'invalid_api_key' });
      req.user = { username: user.username, role: user.role, email: user.email || '', display_name: user.display_name || '', org_id: key.org_id, user_id: user.id };
      return next();
    }
    // Fall back to session cookie
    return requireAuth(req, res, next);
  }

`;

  // Inject after requireAdmin
  authSrc = authSrc.replace(
    /(function requireAdmin\(req, res, next\) \{[^}]+\})/,
    '$1' + BEARER_MIDDLEWARE
  );

  // Expose it in the return value
  authSrc = authSrc.replace(
    /return \{ router, requireAuth, requireAdmin, sysDb \}/,
    'return { router, requireAuth, requireAdmin, requireApiKeyOrAuth, sysDb }'
  );

  fs.writeFileSync(authFile, authSrc);
  console.log('✓ requireApiKeyOrAuth added to auth.js');
}

// --- Patch copilot.js: use requireApiKeyOrAuth ---
const copilotFile = '/root/joblink-v2-staging/routes/copilot.js';
let copilotSrc = fs.readFileSync(copilotFile, 'utf8');

if (copilotSrc.includes('requireApiKeyOrAuth')) {
  console.log('✓ copilot.js already uses requireApiKeyOrAuth — skipping');
} else {
  copilotSrc = copilotSrc.replace(/auth\.requireAuth/g, 'auth.requireApiKeyOrAuth');
  fs.writeFileSync(copilotFile, copilotSrc);
  console.log('✓ copilot.js updated to use requireApiKeyOrAuth');
}

// --- Patch copilot.js openapi security schemes ---
if (!copilotSrc.includes('bearerAuth')) {
  const SECURITY_SCHEMES = `"securitySchemes": {
        "bearerAuth": { "type": "http", "scheme": "bearer" },
        "cookieAuth": { "type": "apiKey", "in": "cookie", "name": "jl_session" }
      },`;
  const copilotSrc2 = fs.readFileSync(copilotFile, 'utf8');
  const updated = copilotSrc2.replace(
    /("paths":\s*\{)/,
    SECURITY_SCHEMES + '\n      $1'
  );
  if (updated !== copilotSrc2) {
    fs.writeFileSync(copilotFile, updated);
    console.log('✓ securitySchemes added to copilot.js openapi spec');
  }
}
