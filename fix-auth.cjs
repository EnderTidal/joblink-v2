const fs = require('fs');
const file = '/root/joblink-v2-staging/routes/auth.js';
let src = fs.readFileSync(file, 'utf8');

// Fix the broken requireAdmin + dangling ");\n    next();\n  }" 
// Replace the entire broken block with the correct version
src = src.replace(
  /function requireAdmin\(req, res, next\) \{\s*if \(!req\.user \|\| req\.user\.role !== 'admin'\) return res\.status\(403\)\.json\(\{ error: 'admin_only' \}[\s\S]*?\);\s*next\(\);\s*\}/,
  `function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
    next();
  }`
);

fs.writeFileSync(file, src);
console.log('Fixed requireAdmin');

// Verify no duplicate requireApiKeyOrAuth
const count = (src.match(/function requireApiKeyOrAuth/g) || []).length;
console.log('requireApiKeyOrAuth count:', count);
