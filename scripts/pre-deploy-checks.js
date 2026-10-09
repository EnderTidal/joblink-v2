#!/usr/bin/env node
// JobLink V2 — Pre-deploy checklist
// Runs automated checks before TOTP gate. Exit 1 if any FAIL.
// Called by deploy.sh: node scripts/pre-deploy-checks.js

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROD_DIR = '/root/joblink-v2';
const STAGING_DIR = '/root/joblink-v2-staging';
const results = [];

function check(name, fn) {
  try {
    const r = fn();
    results.push({ name, pass: r.pass, detail: r.detail || '' });
    console.log(`  ${r.pass ? '✓ PASS' : '✗ FAIL'} — ${name}${r.detail ? '\n         ' + r.detail : ''}`);
  } catch (e) {
    results.push({ name, pass: false, detail: e.message });
    console.log(`  ✗ FAIL — ${name}\n         ${e.message}`);
  }
}

console.log('\n--- Pre-deploy checklist ---\n');

// a. Node path check
check('Node path check (/usr/bin/node exists and runs)', () => {
  if (!fs.existsSync('/usr/bin/node')) return { pass: false, detail: '/usr/bin/node not found' };
  try {
    const v = execSync('/usr/bin/node --version', { encoding: 'utf8' }).trim();
    return { pass: true, detail: v };
  } catch {
    return { pass: false, detail: '/usr/bin/node failed to execute' };
  }
});

// b. Schema diff — compare api_keys table schema between staging and prod
check('Schema diff (api_keys table: staging vs prod)', () => {
  const prodDb = path.join(PROD_DIR, 'data/system.db');
  const stagingDb = path.join(STAGING_DIR, 'data/system.db');
  if (!fs.existsSync(prodDb)) return { pass: false, detail: 'prod system.db not found' };
  if (!fs.existsSync(stagingDb)) return { pass: false, detail: 'staging system.db not found' };

  // Use node:sqlite to read schema
  const { DatabaseSync } = require('node:sqlite');
  const pDb = new DatabaseSync(prodDb, { open: true });
  const sDb = new DatabaseSync(stagingDb, { open: true });

  const prodSchema = pDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='api_keys'").get();
  const stagingSchema = sDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='api_keys'").get();
  pDb.close();
  sDb.close();

  const pSql = prodSchema?.sql || '(table not found)';
  const sSql = stagingSchema?.sql || '(table not found)';

  if (pSql === sSql) return { pass: true, detail: 'schemas match' };
  return { pass: false, detail: `DIFFERS\n         prod:    ${pSql}\n         staging: ${sSql}` };
});

// c. Route audit — every api( URL in admin.html must have a backend handler
check('Route audit (admin.html api() URLs vs backend handlers)', () => {
  const adminPath = path.join(PROD_DIR, 'public/admin.html');
  const adminHtml = fs.readFileSync(adminPath, 'utf8');

  // Extract all api('/path...') calls — capture the URL pattern
  const apiCalls = new Set();
  const re = /api\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(adminHtml)) !== null) {
    // Normalize: strip query params, replace variable segments with :param
    let url = m[1].split('?')[0];
    apiCalls.add(url);
  }

  // Also catch template literal patterns like api(`/api/foo/${id}`)
  const re2 = /api\(\s*`([^`]+)`/g;
  while ((m = re2.exec(adminHtml)) !== null) {
    let url = m[1].replace(/\$\{[^}]+\}/g, ':id').split('?')[0];
    apiCalls.add(url);
  }

  // Also catch concatenation patterns like api('/api/foo/' + id, ...)
  const re3 = /api\(\s*['"`]([^'"`]+)['"`]\s*\+/g;
  while ((m = re3.exec(adminHtml)) !== null) {
    let url = m[1].replace(/\/$/, '') + '/:id';
    url = url.split('?')[0];
    apiCalls.add(url);
  }

  // Collect all registered routes from route files + server.js
  const routeFiles = [
    ...fs.readdirSync(path.join(PROD_DIR, 'routes')).map(f => path.join(PROD_DIR, 'routes', f)),
    path.join(PROD_DIR, 'server.js'),
  ].filter(f => f.endsWith('.js'));

  const registeredRoutes = new Set();
  const routeRe = /(?:router|app)\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
  for (const file of routeFiles) {
    const src = fs.readFileSync(file, 'utf8');
    while ((m = routeRe.exec(src)) !== null) {
      registeredRoutes.add(m[2]);
    }
  }

  // Normalize route patterns for matching
  function routeMatches(frontendUrl, routePattern) {
    // Strip trailing slashes for comparison
    const fu = frontendUrl.replace(/\/$/, '');
    const rp = routePattern.replace(/\/$/, '');
    const fParts = fu.split('/');
    const rParts = rp.split('/');
    if (fParts.length !== rParts.length) return false;
    return rParts.every((r, i) => r.startsWith(':') || r === fParts[i] || fParts[i] === ':id');
  }

  const missing = [];
  for (const url of apiCalls) {
    if (!url.startsWith('/api')) continue; // skip non-api calls
    const normalized = url.replace(/\/$/, '');
    if (!normalized || normalized === '/api') continue; // skip bare /api
    const found = [...registeredRoutes].some(r => routeMatches(normalized, r));
    if (!found) missing.push(url);
  }

  if (missing.length === 0) return { pass: true, detail: `${apiCalls.size} frontend URLs, all have handlers` };
  return { pass: false, detail: `Missing handlers for: ${missing.join(', ')}` };
});

// d. Test password compliance — passwords in test files must be 12+ chars with complexity
check('Test password compliance (12+ chars, upper+lower+digit+special)', () => {
  const testDir = path.join(PROD_DIR, 'tests');
  if (!fs.existsSync(testDir)) return { pass: true, detail: 'no tests dir' };

  const testFiles = [];
  function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(dir, f.name));
      else if (f.name.endsWith('.js')) testFiles.push(path.join(dir, f.name));
    }
  }
  walk(testDir);

  // Match password: 'value' or password: "value" patterns — the value after the colon/key
  const passRe = /password['"]?\s*[:=]\s*['"`]([^'"`\n]+)['"`]/gi;
  const weak = [];

  function isStrong(pw) {
    if (pw.length < 12) return false;
    if (!/[A-Z]/.test(pw)) return false;
    if (!/[a-z]/.test(pw)) return false;
    if (!/[0-9]/.test(pw)) return false;
    if (!/[^A-Za-z0-9]/.test(pw)) return false;
    return true;
  }

  for (const file of testFiles) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = passRe.exec(src)) !== null) {
      const pw = m[1].trim();
      // Skip obvious non-password values (deliberate wrong creds for negative tests)
      if (pw === 'wrong' || pw === 'badpassword' || pw === 'short' || pw === 'x' || pw === 'bad') continue;
      // Skip values that look like code fragments, not passwords
      if (pw.includes('{') || pw.includes(',') || pw.includes('(')) continue;
      if (pw.length < 4) continue; // too short to be a real test password
      if (!isStrong(pw)) {
        const rel = path.relative(PROD_DIR, file);
        weak.push(`${rel}: "${pw}"`);
      }
    }
  }

  if (weak.length === 0) return { pass: true, detail: `all test passwords meet complexity requirements` };
  return { pass: false, detail: `Weak passwords found:\n         ${weak.join('\n         ')}` };
});

// e. Staging-prod file diff
check('Staging-prod file diff', () => {
  if (!fs.existsSync(STAGING_DIR)) return { pass: true, detail: 'staging dir not found, skipping' };

  try {
    // Use diff to find changed files, ignore node_modules, data, .git
    const out = execSync(
      `diff -rq "${PROD_DIR}" "${STAGING_DIR}" --exclude=node_modules --exclude=data --exclude=.git --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' 2>/dev/null || true`,
      { encoding: 'utf8', maxBuffer: 1024 * 1024 }
    ).trim();

    if (!out) return { pass: true, detail: 'no differences' };

    // Parse diff output into clean file list
    const lines = out.split('\n').filter(Boolean);
    const files = lines.map(l => {
      // "Files /root/joblink-v2/foo and /root/joblink-v2-staging/foo differ"
      const m = l.match(/^Files (.+) and (.+) differ$/);
      if (m) return path.relative(PROD_DIR, m[1]);
      // "Only in /root/joblink-v2: foo" or "Only in /root/joblink-v2-staging: foo"
      const m2 = l.match(/^Only in (.+?): (.+)$/);
      if (m2) {
        const dir = m2[1].includes('staging') ? 'staging' : 'prod';
        const rel = path.relative(dir === 'staging' ? STAGING_DIR : PROD_DIR, path.join(m2[1], m2[2]));
        return `${rel} (only in ${dir})`;
      }
      return l;
    });

    // This is informational, not a blocker — always pass
    return { pass: true, detail: `${files.length} file(s) differ:\n         ${files.join('\n         ')}` };
  } catch (e) {
    return { pass: true, detail: `diff command error: ${e.message}` };
  }
});

// ── Summary ──
console.log('');
const failed = results.filter(r => !r.pass);
if (failed.length > 0) {
  console.log(`PRE-DEPLOY: ${failed.length} check(s) FAILED — deploy blocked.\n`);
  process.exit(1);
} else {
  console.log(`PRE-DEPLOY: All ${results.length} checks PASSED.\n`);
}
