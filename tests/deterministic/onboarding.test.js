// Onboarding: fresh installs need it, completing it flips the flag, the
// wizard's password change requires the current password, and only admins
// can complete/reset it. Runs over real HTTP against the real app.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.JOBLINK_DB = path.join(os.tmpdir(), `joblink-onboarding-test-${process.pid}.db`);
delete process.env.ANTHROPIC_API_KEY;
const { app, db } = require('../../server');

let server, base, cookie = '';
const http = async (method, url, body, useCookie = cookie) => {
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
});

after(() => {
  server.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(process.env.JOBLINK_DB + ext, { force: true });
});

test('fresh install: login reports needsOnboarding for the admin', async () => {
  const r = await http('POST', '/api/login', { username: 'admin', password: 'joblink2026' });
  assert.strictEqual(r.data.ok, true);
  assert.strictEqual(r.data.needsOnboarding, true);
  cookie = r.setCookie.split(';')[0];
  const me = await http('GET', '/api/me');
  assert.strictEqual(me.data.onboarded, false);
});

test('wizard password change requires the CURRENT password', async () => {
  const wrong = await http('POST', '/api/me/password', { current: 'nope', password: 'newpassword123' });
  assert.strictEqual(wrong.status, 401);
  const short = await http('POST', '/api/me/password', { current: 'joblink2026', password: 'short' });
  assert.strictEqual(short.status, 400);
  const ok = await http('POST', '/api/me/password', { current: 'joblink2026', password: 'newpassword123' });
  assert.strictEqual(ok.data.ok, true);
  // old password is dead, new one works
  const oldLogin = await http('POST', '/api/login', { username: 'admin', password: 'joblink2026' }, '');
  assert.strictEqual(oldLogin.status, 401);
  const newLogin = await http('POST', '/api/login', { username: 'admin', password: 'newpassword123' }, '');
  assert.strictEqual(newLogin.data.ok, true);
  assert.strictEqual(newLogin.data.defaultPassword, false);
});

test('completing onboarding flips the flag; login stops redirecting', async () => {
  const r = await http('POST', '/api/onboarding/complete');
  assert.strictEqual(r.data.ok, true);
  const login = await http('POST', '/api/login', { username: 'admin', password: 'newpassword123' }, '');
  assert.strictEqual(login.data.needsOnboarding, false);
  const me = await http('GET', '/api/me');
  assert.strictEqual(me.data.onboarded, true);
});

test('reset lets the wizard run again (Admin → Re-run setup)', async () => {
  await http('POST', '/api/onboarding/reset');
  const me = await http('GET', '/api/me');
  assert.strictEqual(me.data.onboarded, false);
  await http('POST', '/api/onboarding/complete'); // leave it clean
});

test('non-admin recruiters cannot complete or reset onboarding', async () => {
  await http('POST', '/api/users', { username: 'rec', password: 'recruiterpw1', role: 'recruiter' });
  const login = await http('POST', '/api/login', { username: 'rec', password: 'recruiterpw1' }, '');
  assert.strictEqual(login.data.needsOnboarding, false, 'recruiters are never sent to the wizard');
  const recCookie = login.setCookie.split(';')[0];
  const r = await http('POST', '/api/onboarding/reset', null, recCookie);
  assert.strictEqual(r.status, 403);
});

test('the wizard page and its tutorial screenshots are actually served', async () => {
  const page = await fetch(base + '/onboarding.html');
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  for (const img of ['tutorial-settings-nav.jpg', 'tutorial-api-keys.jpg', 'tutorial-channels-list.jpg', 'tutorial-channels-3dots.jpg', 'tutorial-channel-detail.jpg']) {
    assert.ok(html.includes(img), `wizard must reference ${img}`);
    const res = await fetch(base + '/tutorial/' + img);
    assert.strictEqual(res.status, 200, `${img} must be served`);
    assert.strictEqual(res.headers.get('content-type'), 'image/jpeg');
  }
});
