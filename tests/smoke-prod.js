#!/usr/bin/env node
// JobLink V2 — Post-deploy production smoke test
// Tests every critical endpoint on the live server. No framework, just fetch + assert.
// Run: node tests/smoke-prod.js

const crypto = require('node:crypto');

const PORT = process.env.PORT || 3849;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'joshuafriends@gmail.com';
const ADMIN_PASS = 'joblink2026';

const results = [];
let cookie = '';
let apiKey = null;
let apiKeyId = null;

async function http(method, url, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  else if (cookie) headers.cookie = cookie;
  if (opts.headers) Object.assign(headers, opts.headers);

  const fetchOpts = { method, headers, redirect: 'manual' };
  if (body !== undefined && body !== null) fetchOpts.body = JSON.stringify(body);

  const res = await fetch(BASE + url, fetchOpts);
  const sc = res.headers.get('set-cookie');
  if (sc && opts.cookie === undefined) cookie = sc.split(';')[0];

  const ct = res.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('json')) data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
}

async function test(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (e) {
    record(name, false, e.message);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  // ── Auth ──
  await test('POST /api/login (valid creds) → 200', async () => {
    const r = await http('POST', '/api/login', { email: ADMIN_EMAIL, password: ADMIN_PASS });
    assert(r.status === 200, `got ${r.status}`);
    assert(r.data?.ok, 'response not ok');
  });

  await test('POST /api/login (wrong password) → 401', async () => {
    const r = await http('POST', '/api/login', { email: ADMIN_EMAIL, password: 'wrong' }, { cookie: '' });
    assert(r.status === 401, `got ${r.status}`);
  });

  await test('GET /api/me → 200', async () => {
    const r = await http('GET', '/api/me');
    assert(r.status === 200, `got ${r.status}`);
    assert(r.data?.username, 'no username in response');
  });

  // ── Unauthenticated → 401 ──
  await test('GET /api/me (no cookie) → 401', async () => {
    const r = await http('GET', '/api/me', null, { cookie: '' });
    assert(r.status === 401, `got ${r.status}`);
  });

  // ── Core data endpoints ──
  await test('GET /api/stats → 200', async () => {
    const r = await http('GET', '/api/stats');
    assert(r.status === 200, `got ${r.status}`);
  });

  await test('GET /api/job-orders → 200', async () => {
    const r = await http('GET', '/api/job-orders');
    assert(r.status === 200, `got ${r.status}`);
  });

  await test('GET /api/blasts → 200', async () => {
    const r = await http('GET', '/api/blasts');
    assert(r.status === 200, `got ${r.status}`);
  });

  await test('GET /api/categories → 200', async () => {
    const r = await http('GET', '/api/categories');
    assert(r.status === 200, `got ${r.status}`);
  });

  await test('GET /api/team → 200', async () => {
    const r = await http('GET', '/api/team');
    assert(r.status === 200, `got ${r.status}`);
  });

  // ── API Key lifecycle ──
  await test('GET /api/settings/api-keys → 200', async () => {
    const r = await http('GET', '/api/settings/api-keys');
    assert(r.status === 200, `got ${r.status}`);
  });

  await test('POST /api/settings/api-key/generate → 200', async () => {
    const r = await http('POST', '/api/settings/api-key/generate', { name: 'smoke-test-key' });
    assert(r.status === 200, `got ${r.status}`);
    assert(r.data?.key, 'no key returned');
    apiKey = r.data.key;
    // We need the ID to delete later — fetch the list
    const list = await http('GET', '/api/settings/api-keys');
    const found = list.data?.keys?.find(k => k.key_prefix === apiKey.substring(0, 8));
    assert(found, 'generated key not found in list');
    apiKeyId = found.id;
  });

  await test('GET /api/v1/analytics (with API key) → 200', async () => {
    const r = await http('GET', '/api/v1/analytics', null, { cookie: '', headers: { 'X-API-Key': apiKey } });
    assert(r.status === 200, `got ${r.status}`);
  });

  await test('GET /api/v1/jobs (with API key) → 200', async () => {
    const r = await http('GET', '/api/v1/jobs', null, { cookie: '', headers: { 'X-API-Key': apiKey } });
    assert(r.status === 200, `got ${r.status}`);
  });

  await test('DELETE /api/settings/api-key/:id → 200 (revoke)', async () => {
    const r = await http('DELETE', `/api/settings/api-key/${apiKeyId}`);
    assert(r.status === 200, `got ${r.status}`);
  });

  await test('GET /api/v1/jobs (revoked key) → 401', async () => {
    const r = await http('GET', '/api/v1/jobs', null, { cookie: '', headers: { 'X-API-Key': apiKey } });
    assert(r.status === 401, `got ${r.status}`);
  });

  await test('GET /api/v1/jobs (no key) → 401', async () => {
    const r = await http('GET', '/api/v1/jobs', null, { cookie: '', headers: {} });
    assert(r.status === 401, `got ${r.status}`);
  });

  // ── Analytics ──
  await test('GET /api/analytics/overview → 200', async () => {
    const r = await http('GET', '/api/analytics/overview');
    assert(r.status === 200, `got ${r.status}`);
  });

  await test('GET /api/analytics/blasts → 200', async () => {
    const r = await http('GET', '/api/analytics/blasts');
    assert(r.status === 200, `got ${r.status}`);
  });

  await test('GET /api/analytics/pipeline → 200', async () => {
    const r = await http('GET', '/api/analytics/pipeline');
    assert(r.status === 200, `got ${r.status}`);
  });

  // ── Report ──
  const pad = (n) => String(n).padStart(2, '0');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const total = results.length;

  console.log('');
  console.log('┌────┬────────────────────────────────────────────────────────┬────────┐');
  console.log('│ #  │ Test                                                   │ Result │');
  console.log('├────┼────────────────────────────────────────────────────────┼────────┤');
  results.forEach((r, i) => {
    const num = String(i + 1).padStart(2);
    const name = r.name.padEnd(54).substring(0, 54);
    const status = r.pass ? ' PASS ' : ' FAIL ';
    console.log(`│ ${num} │ ${name} │${status}│`);
    if (!r.pass && r.detail) console.log(`│    │   → ${r.detail.padEnd(51).substring(0, 51)} │      │`);
  });
  console.log('└────┴────────────────────────────────────────────────────────┴────────┘');
  console.log(`\nSmoke: ${passed}/${total} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('Smoke test crashed:', e.message); process.exit(1); });
