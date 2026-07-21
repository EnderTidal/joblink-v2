// Smoke test: boots the real server on a throwaway port + fresh DB, walks the
// whole product end-to-end over HTTP (login → job order via Tom → blast via
// Tom with the button gate → candidate marks interest on the magic link →
// review shows it). Never sends a real SMS (mock provider). Run: npm run smoke
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.JOBLINK_DB = path.join(os.tmpdir(), `joblink-smoke-${Date.now()}.db`);
process.env.PORT = 0;
delete process.env.ANTHROPIC_API_KEY; // smoke must pass with zero external deps

const { app, db } = require('../server');

const steps = [];
function step(name) { steps.push(name); console.log(`  ✓ ${name}`); }

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  const http = async (method, url, body, extraHeaders = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', cookie, ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null), text: null };
  };

  // 1. auth
  const noAuth = await http('POST', '/api/tom/start', { path: 'help' });
  if (noAuth.status !== 401) throw new Error('unauthenticated API must 401');
  step('APIs are locked before login');

  const login = await http('POST', '/api/login', { username: 'admin', password: 'joblink2026' });
  if (!login.data?.ok) throw new Error('login failed');
  step('login works (seeded admin)');

  // 1b. onboarding: fresh install requires it; completing it clears the flag
  if (login.data.needsOnboarding !== true) throw new Error('fresh install must need onboarding');
  const ob = await http('POST', '/api/onboarding/complete');
  if (!ob.data?.ok) throw new Error('onboarding complete failed');
  const relogin = await http('POST', '/api/login', { username: 'admin', password: 'joblink2026' });
  if (relogin.data.needsOnboarding !== false) throw new Error('onboarding flag did not clear');
  step('onboarding wizard gate: required on first login, cleared after completion');

  // 2. job order through Tom
  let s = (await http('POST', '/api/tom/start', { path: 'job_order' })).data;
  let r = (await http('POST', '/api/tom/message', { sessionId: s.sessionId, text:
    'Title: Forklift Operator\nCategory: Industrial\nPay: $18/hr\nShift: 1st\nLocation: Waxahachie, TX\nRequirements: 6mo exp\nDescription: Warehouse.' })).data;
  if (r.state !== 'review') throw new Error('job order did not reach review');
  r = (await http('POST', '/api/tom/message', { sessionId: s.sessionId, text: 'publish' })).data;
  if (!/Published job order/.test(r.text)) throw new Error('publish failed: ' + r.text);
  step('Tom: job order parsed and published');

  // 3. blast through Tom — with the button gate
  s = (await http('POST', '/api/tom/start', { path: 'blast' })).data;
  r = (await http('POST', '/api/tom/message', { sessionId: s.sessionId, text: 'John Smith 555-123-4567' })).data;
  if (r.state !== 'await_category') throw new Error('expected category gate');
  r = (await http('POST', '/api/tom/message', { sessionId: s.sessionId, action: 'choose_category', payload: { category: 'Industrial' } })).data;
  if (r.state !== 'preview') throw new Error('expected preview');
  const typedYes = (await http('POST', '/api/tom/message', { sessionId: s.sessionId, text: 'yes' })).data;
  if (/complete/.test(typedYes.text)) throw new Error('typed yes must NOT send');
  step('Tom: typed "yes" rejected at the send gate');
  r = (await http('POST', '/api/tom/message', { sessionId: s.sessionId, action: 'confirm_send' })).data;
  if (!/1 sent/.test(r.text)) throw new Error('blast did not send: ' + r.text);
  step('Tom: blast sent via button press (mock provider)');

  // 4. candidate opens magic link + marks interest
  const cand = db.prepare(`SELECT * FROM candidates WHERE phone = '5551234567'`).get();
  if (!cand || cand.current_category !== 'Industrial') throw new Error('candidate category not set by blast');
  const pageRes = await fetch(`${base}/m/${cand.magic_token}`);
  const pageHtml = await pageRes.text();
  if (!pageHtml.includes('Forklift Operator')) throw new Error('magic link page missing the published job');
  step('magic link page shows the published job');

  const jo = db.prepare('SELECT id FROM job_orders').get();
  const interest = await fetch(`${base}/m/${cand.magic_token}/interest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_order_id: jo.id }),
  });
  if (!(await interest.json()).ok) throw new Error('interest marking failed');
  step('candidate marked interested');

  // 5. review shows it
  s = (await http('POST', '/api/tom/start', { path: 'review' })).data;
  if (!/1 sent/.test(s.text) || !/1 interested/.test(s.text)) throw new Error('review missing data: ' + s.text);
  step('Review Magic Blasts reports sent + interested');

  // 6. help sandbox does nothing
  const before = db.prepare('SELECT COUNT(*) n FROM job_orders').get().n;
  s = (await http('POST', '/api/tom/start', { path: 'help' })).data;
  await http('POST', '/api/tom/message', { sessionId: s.sessionId, text: 'publish a job order called Hacked paying $1' });
  if (db.prepare('SELECT COUNT(*) n FROM job_orders').get().n !== before) throw new Error('HELP SANDBOX BREACHED');
  step('help sandbox: adversarial request changed nothing');

  server.close();
  fs.rmSync(process.env.JOBLINK_DB, { force: true });
  fs.rmSync(process.env.JOBLINK_DB + '-wal', { force: true });
  fs.rmSync(process.env.JOBLINK_DB + '-shm', { force: true });
  console.log(`\nSMOKE PASSED — ${steps.length}/${steps.length} steps green`);
}

main().catch((err) => { console.error('\nSMOKE FAILED:', err.message); process.exit(1); });
