// Multi-tenant: verifies org isolation, tenant DB creation, login with org_id,
// and that data in one tenant is invisible to another.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const testId = `joblink-mt-test-${process.pid}`;
const testDir = path.join(os.tmpdir(), testId);
fs.mkdirSync(testDir, { recursive: true });
process.env.SYSTEM_DB = path.join(testDir, 'system.db');
process.env.DATA_DIR = testDir;
delete process.env.ANTHROPIC_API_KEY;
const { app, sysDb } = require('../../server');
const { createTenantDb, getTenantDb } = require('../../src/tenant');
const { createOrg } = require('../../src/system-db');
const bcrypt = require('bcryptjs');

let server, base, cookie1 = '', cookie2 = '';
const http = async (method, url, body, useCookie = cookie1) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', cookie: useCookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data: await res.json().catch(() => null), setCookie };
};

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // Create a second org with its own admin
  const org2 = createOrg(sysDb, { name: 'Acme Corp', slug: 'acme' });
  createTenantDb(org2.id);
  sysDb.prepare(
    'INSERT INTO users (org_id, username, password_hash, role, email, email_verified) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(org2.id, 'acme-admin', bcrypt.hashSync('acmepass123', 10), 'admin', 'admin@acme.test', 1);
});

after(() => {
  server.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('login returns org_id in response', async () => {
  const r = await http('POST', '/api/login', { username: 'admin', password: 'joblink2026' });
  assert.strictEqual(r.data.ok, true);
  assert.strictEqual(r.data.org_id, 1);
  cookie1 = r.setCookie.split(';')[0];
});

test('second org admin can login with their own credentials', async () => {
  const r = await http('POST', '/api/login', { username: 'acme-admin', password: 'acmepass123' }, '');
  assert.strictEqual(r.data.ok, true);
  assert.strictEqual(r.data.org_id, 2);
  cookie2 = r.setCookie.split(';')[0];
});

test('/api/me returns correct org_id per user', async () => {
  const me1 = await http('GET', '/api/me', null, cookie1);
  assert.strictEqual(me1.data.org_id, 1);
  const me2 = await http('GET', '/api/me', null, cookie2);
  assert.strictEqual(me2.data.org_id, 2);
});

test('data is isolated between tenants', async () => {
  // Create a job order in org1 via Tom
  const s1 = await http('POST', '/api/tom/start', { path: 'job_order' }, cookie1);
  await http('POST', '/api/tom/message', {
    sessionId: s1.data.sessionId,
    text: 'Title: Welder\nCategory: Skilled Trade\nPay: $25/hr',
  }, cookie1);
  await http('POST', '/api/tom/message', {
    sessionId: s1.data.sessionId,
    text: 'done',
  }, cookie1);

  // Org1 sees 1 job order
  const jo1 = await http('GET', '/api/job-orders', null, cookie1);
  assert.ok(jo1.data.length >= 1, 'org1 should have at least 1 job order');

  // Org2 sees 0 job orders
  const jo2 = await http('GET', '/api/job-orders', null, cookie2);
  assert.strictEqual(jo2.data.length, 0, 'org2 should have 0 job orders (isolated)');
});

test('stats are tenant-scoped', async () => {
  const stats1 = await http('GET', '/api/stats', null, cookie1);
  const stats2 = await http('GET', '/api/stats', null, cookie2);
  assert.ok(stats1.data.candidates >= 0);
  assert.strictEqual(stats2.data.candidates, 0, 'org2 starts with no candidates');
});

test('user management is org-scoped', async () => {
  // Org1 admin creates a user
  await http('POST', '/api/users', { username: 'recruiter1', password: 'password123', role: 'recruiter' }, cookie1);
  const users1 = await http('GET', '/api/users', null, cookie1);
  const users2 = await http('GET', '/api/users', null, cookie2);

  // Org1 should see their users (admin + recruiter1)
  assert.ok(users1.data.some(u => u.username === 'recruiter1'), 'org1 should see recruiter1');
  // Org2 should NOT see org1 users
  assert.ok(!users2.data.some(u => u.username === 'recruiter1'), 'org2 should not see org1 users');
});

test('settings are tenant-scoped', async () => {
  // Set a different cooldown for each org
  await http('POST', '/api/settings', { cooldown_hours: '48' }, cookie1);
  await http('POST', '/api/settings', { cooldown_hours: '96' }, cookie2);

  const s1 = await http('GET', '/api/settings', null, cookie1);
  const s2 = await http('GET', '/api/settings', null, cookie2);
  assert.strictEqual(s1.data.cooldown_hours, '48');
  assert.strictEqual(s2.data.cooldown_hours, '96');
});
