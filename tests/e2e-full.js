// JobLink V2 — Comprehensive E2E Test
// Tests EVERY function via HTTP API using Node's built-in test runner.
// Run: /opt/node22/bin/node tests/e2e-full.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// --- Bootstrap: fresh DB on a test port ---
const DB_PATH = path.join(os.tmpdir(), `joblink-e2e-${Date.now()}.db`);
process.env.JOBLINK_DB = DB_PATH;
process.env.PORT = '3999';
delete process.env.ANTHROPIC_API_KEY; // no external deps

const { app, db } = require('../server');

let server, BASE;
let adminCookie = '';

// HTTP helper
async function http(method, url, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  else if (adminCookie) headers.cookie = adminCookie;
  if (opts.headers) Object.assign(headers, opts.headers);

  const fetchOpts = { method, headers, redirect: 'manual' };
  if (body !== undefined && body !== null) fetchOpts.body = JSON.stringify(body);

  const res = await fetch(BASE + url, fetchOpts);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && opts.cookie === undefined) adminCookie = setCookie.split(';')[0];

  const ct = res.headers.get('content-type') || '';
  let data = null, text = null;
  if (ct.includes('json')) data = await res.json();
  else text = await res.text();
  return { status: res.status, data, text, headers: res.headers };
}

async function httpRaw(method, url, opts = {}) {
  const headers = {};
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  else if (adminCookie) headers.cookie = adminCookie;
  if (opts.headers) Object.assign(headers, opts.headers);

  const fetchOpts = { method, headers, redirect: 'manual' };
  if (opts.body) fetchOpts.body = opts.body;

  const res = await fetch(BASE + url, fetchOpts);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && opts.cookie === undefined) adminCookie = setCookie.split(';')[0];
  return res;
}

// Multipart upload helper
async function uploadCSV(url, csvContent, sessionId) {
  const boundary = '----TestBoundary' + Date.now();
  let body = '';
  body += `--${boundary}\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\n${sessionId}\r\n`;
  body += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="contacts.csv"\r\nContent-Type: text/csv\r\n\r\n${csvContent}\r\n`;
  body += `--${boundary}--\r\n`;

  const res = await fetch(BASE + url, {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  return { status: res.status, data: await res.json() };
}

// ===== Shared state across tests =====
let joId;            // job order ID created via Tom (published)
let joId2;           // job order ID created via blank form (draft)
let blastId;         // blast ID from executing a blast
let interestId;      // interest record ID
let candidateToken;  // magic token for test candidate
let templateId;      // template created in admin tests
let invitedUserId;   // user created via invite
let recruiterCookie = '';

// ===== TESTS =====

describe('JobLink V2 — Full E2E', () => {

  before(async () => {
    server = app.listen(3999);
    await new Promise((r) => server.on('listening', r));
    BASE = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.close();
    try { fs.rmSync(DB_PATH, { force: true }); } catch {}
    try { fs.rmSync(DB_PATH + '-wal', { force: true }); } catch {}
    try { fs.rmSync(DB_PATH + '-shm', { force: true }); } catch {}
  });

  // ============================================================
  // AUTH
  // ============================================================

  describe('Auth', () => {
    it('1. Login with email + password', async () => {
      const r = await http('POST', '/api/login', { email: 'joshuafriends@gmail.com', password: 'joblink2026' });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
      assert.equal(r.data.username, 'admin');
      assert.equal(r.data.role, 'admin');
    });

    it('2. Login with wrong password (expect 401)', async () => {
      const r = await http('POST', '/api/login', { email: 'joshuafriends@gmail.com', password: 'wrong' }, { cookie: '' });
      assert.equal(r.status, 401);
      assert.equal(r.data.error, 'bad_credentials');
    });

    it('3. Login with username fallback', async () => {
      const r = await http('POST', '/api/login', { username: 'admin', password: 'joblink2026' });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
    });

    it('4. Get current user (/api/me)', async () => {
      const r = await http('GET', '/api/me');
      assert.equal(r.status, 200);
      assert.equal(r.data.username, 'admin');
      assert.equal(r.data.role, 'admin');
    });

    it('5. Invite a new user (POST /api/invite)', async () => {
      const r = await http('POST', '/api/invite', { email: 'testrecruiter@example.com', role: 'recruiter' });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
      // Verify user was created in DB
      const user = db.prepare("SELECT * FROM users WHERE email = 'testrecruiter@example.com'").get();
      assert.ok(user, 'Invited user should exist in DB');
      assert.equal(user.role, 'recruiter');
      assert.ok(user.invite_token, 'Should have invite token');
      invitedUserId = user.id;

      // Accept the invitation
      const accept = await http('POST', '/api/invite/accept', {
        token: user.invite_token, password: 'testpass123', display_name: 'Test Recruiter'
      }, { cookie: '' });
      assert.equal(accept.status, 200);
      assert.equal(accept.data.ok, true);
      const sc = accept.headers?.get('set-cookie');
      if (sc) recruiterCookie = sc.split(';')[0];
    });

    it('6. Forgot password (POST /api/forgot-password)', async () => {
      const r = await http('POST', '/api/forgot-password', { email: 'joshuafriends@gmail.com' });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
      // Non-existent email should also return ok (no leak)
      const r2 = await http('POST', '/api/forgot-password', { email: 'noone@nowhere.com' });
      assert.equal(r2.status, 200);
      assert.equal(r2.data.ok, true);
    });
  });

  // ============================================================
  // JOB ORDERS
  // ============================================================

  describe('Job Orders', () => {

    it('7. Create JO via AI parser (POST /api/tom with job_order path + text)', async () => {
      // Complete onboarding first
      await http('POST', '/api/onboarding/complete');

      const s = await http('POST', '/api/tom/start', { path: 'job_order' });
      assert.equal(s.status, 200);
      assert.ok(s.data.sessionId);

      const r = await http('POST', '/api/tom/message', {
        sessionId: s.data.sessionId,
        text: 'Title: Forklift Operator\nCategory: Industrial\nPay: $18/hr\nShift: 1st shift, 6am-2:30pm\nAddress: 123 Warehouse Dr\nCity/State: Waxahachie, TX\nRequirements: 6+ months forklift experience\nDescription: Move palletized goods in a climate-controlled warehouse.\nCompany: Express'
      });
      assert.equal(r.data.state, 'review');
      assert.ok(r.data.draft || r.data.showForm, 'Should show form or draft');
    });

    it('8. Create JO via blank form (POST /api/tom with blank_form action)', async () => {
      const s = await http('POST', '/api/tom/start', { path: 'job_order' });
      const r = await http('POST', '/api/tom/message', {
        sessionId: s.data.sessionId,
        action: 'blank_form'
      });
      assert.equal(r.data.state, 'review');
      assert.ok(r.data.showForm, 'Should show blank form');
      assert.ok(r.data.draft, 'Should have empty draft');

      // Fill in the blank form and save as draft
      const save = await http('POST', '/api/tom/message', {
        sessionId: s.data.sessionId,
        action: 'done',
        payload: {
          draft: {
            title: 'Warehouse Worker',
            category: 'Industrial',
            pay: '$16/hr',
            shift_hours: '2nd shift',
            address: '456 Industrial Blvd',
            city_state: 'Dallas, TX',
            requirements: 'Must lift 50 lbs',
            description: 'General warehouse duties',
            company: 'Express',
            status: 'Unpublished'
          }
        }
      });
      assert.ok(/Saved job order/.test(save.data.text), 'Should confirm save: ' + save.data.text);
      const m = save.data.text.match(/#(\d+)/);
      assert.ok(m, 'Should have JO ID in response');
      joId2 = Number(m[1]);
    });

    it('9. Edit JO field (POST /api/tom with edit_field action)', async () => {
      const s = await http('POST', '/api/tom/start', { path: 'job_order' });
      // Start with blank form
      await http('POST', '/api/tom/message', { sessionId: s.data.sessionId, action: 'blank_form' });
      // Edit a field
      const r = await http('POST', '/api/tom/message', {
        sessionId: s.data.sessionId,
        action: 'edit_field',
        payload: { field: 'title', value: 'Test Edited Title' }
      });
      assert.ok(r.data.draft || r.data.showForm);
    });

    it('10. Publish JO (POST /api/tom with publish action)', async () => {
      const s = await http('POST', '/api/tom/start', { path: 'job_order' });
      await http('POST', '/api/tom/message', { sessionId: s.data.sessionId, action: 'blank_form' });

      const r = await http('POST', '/api/tom/message', {
        sessionId: s.data.sessionId,
        action: 'publish',
        payload: {
          draft: {
            title: 'Published Welder',
            category: 'Skilled Trade',
            pay: '$25/hr',
            shift_hours: '1st shift',
            address: '789 Shop Rd',
            city_state: 'Fort Worth, TX',
            requirements: 'Welding cert required',
            description: 'MIG and TIG welding.',
            company: 'Express',
            status: 'Published'
          }
        }
      });
      assert.ok(/Published job order/.test(r.data.text), 'Should confirm publish: ' + r.data.text);
      const m = r.data.text.match(/#(\d+)/);
      joId = Number(m[1]);
    });

    it('11. Save JO as draft (POST /api/tom with done action)', async () => {
      // Already tested in test 8 — verify the DB state
      const jo = db.prepare('SELECT * FROM job_orders WHERE id = ?').get(joId2);
      assert.ok(jo, 'Draft JO should exist');
      assert.equal(jo.status, 'Unpublished');
    });

    it('12. List JOs on dashboard (GET /api/job-orders)', async () => {
      const r = await http('GET', '/api/job-orders');
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.data));
      assert.ok(r.data.length >= 2, 'Should have at least 2 job orders');

      // Also test /api/stats
      const stats = await http('GET', '/api/stats');
      assert.equal(stats.status, 200);
      assert.ok(stats.data.published >= 1, 'Should have at least 1 published');
    });

    it('13. Get JO detail (GET /api/job-orders/:id)', async () => {
      const r = await http('GET', `/api/job-orders/${joId}`);
      assert.equal(r.status, 200);
      assert.equal(r.data.id, joId);
      assert.equal(r.data.title, 'Published Welder');
      assert.ok(r.data.pipeline, 'Should have pipeline grouping');
    });

    it('14. Update JO via PATCH (PATCH /api/job-orders/:id)', async () => {
      const r = await http('PATCH', `/api/job-orders/${joId}`, { pay: '$27/hr' });
      assert.equal(r.status, 200);
      assert.equal(r.data.pay, '$27/hr');
    });

    it('15. Unpublish JO', async () => {
      const r = await http('POST', `/api/job-orders/${joId}/status`, { status: 'Unpublished' });
      assert.equal(r.status, 200);
      assert.equal(r.data.status, 'Unpublished');
      // Re-publish for later tests
      await http('POST', `/api/job-orders/${joId}/status`, { status: 'Published' });
    });

    it('16. Complete JO', async () => {
      const r = await http('POST', `/api/job-orders/${joId2}/status`, { status: 'Complete' });
      assert.equal(r.status, 200);
      assert.equal(r.data.status, 'Complete');
    });
  });

  // ============================================================
  // CANDIDATES & BLASTS
  // ============================================================

  describe('Candidates & Blasts', () => {
    let blastSessionId;

    it('17. Upload contacts (POST /api/tom/upload with a test CSV)', async () => {
      const s = await http('POST', '/api/tom/start', { path: 'blast' });
      blastSessionId = s.data.sessionId;

      const csv = 'First Name,Last Name,Phone\nAlice,Smith,555-111-2222\nBob,Jones,555-333-4444\nCarol,Williams,555-555-6666\nDave,Brown,555-777-8888\n';
      const r = await uploadCSV('/api/tom/upload', csv, blastSessionId);
      assert.equal(r.status, 200);
      assert.ok(r.data.showBlastForm, 'Should show blast form after upload');
      assert.equal(r.data.contactCount, 4);
    });

    it('18. Parse contacts via tom (POST /api/tom with blast path + contacts text)', async () => {
      const s = await http('POST', '/api/tom/start', { path: 'blast' });
      const r = await http('POST', '/api/tom/message', {
        sessionId: s.data.sessionId,
        text: 'Alice Smith 555-111-2222\nBob Jones 555-333-4444\nEve Adams 555-999-0000'
      });
      assert.equal(r.status, 200);
      assert.ok(r.data.showBlastForm, 'Should show blast form');
      assert.ok(r.data.contactCount >= 3);
    });

    it('19. Preview blast (POST /api/tom with preview_blast action)', async () => {
      const r = await http('POST', '/api/tom/message', {
        sessionId: blastSessionId,
        action: 'preview_blast',
        payload: {
          recipientMode: 'all',
          sortBy: 'most_recent',
          category: 'Skilled Trade',
          templateId: null,
          templateBody: 'Hi {first_name}! Check out jobs: {link}',
          recruiterId: null
        }
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.state, 'preview');
      assert.ok(r.data.text.includes('Blast preview'), 'Should show preview text');
      assert.ok(r.data.confirmButton, 'Should have confirm button');
    });

    it('20. Execute blast (POST /api/tom with confirm_send action)', async () => {
      const r = await http('POST', '/api/tom/message', {
        sessionId: blastSessionId,
        action: 'confirm_send'
      });
      assert.equal(r.status, 200);
      assert.ok(/Blast #\d+ complete/.test(r.data.text), 'Should confirm blast: ' + r.data.text);
      const m = r.data.text.match(/#(\d+)/);
      blastId = Number(m[1]);
      assert.ok(/4 sent/.test(r.data.text), 'Should send to 4 people');
    });

    it('21. Review blasts (POST /api/tom with review path)', async () => {
      const s = await http('POST', '/api/tom/start', { path: 'review' });
      assert.equal(s.status, 200);
      assert.ok(s.data.text.includes('Recent Magic Blasts'), 'Should show blasts');
      assert.ok(s.data.blasts.length >= 1);
    });

    it('22. Get blast recipients (GET /api/blasts/:id/recipients)', async () => {
      const r = await http('GET', `/api/blasts/${blastId}/recipients`);
      assert.equal(r.status, 200);
      assert.ok(r.data.blast, 'Should have blast details');
      assert.ok(Array.isArray(r.data.recipients));
      assert.ok(r.data.recipients.length >= 4, 'Should have 4 recipients');
    });

    it('23. Download blast CSV (GET /api/blasts/:id/recipients/csv)', async () => {
      const res = await httpRaw('GET', `/api/blasts/${blastId}/recipients/csv`);
      assert.equal(res.status, 200);
      const ct = res.headers.get('content-type');
      assert.ok(ct.includes('text/csv'), 'Should be CSV content-type');
      const csvText = await res.text();
      assert.ok(csvText.includes('First Name'), 'Should have CSV header');
      assert.ok(csvText.includes('Alice'), 'Should have recipient data');
    });
  });

  // ============================================================
  // PIPELINE
  // ============================================================

  describe('Pipeline', () => {

    it('24. Mark interest (POST /m/:token/interest)', async () => {
      // Get a candidate's magic token
      const cand = db.prepare("SELECT * FROM candidates WHERE phone = '5551112222'").get();
      assert.ok(cand, 'Candidate Alice should exist');
      candidateToken = cand.magic_token;

      // Interest on the published JO (Skilled Trade category)
      const r = await http('POST', `/m/${candidateToken}/interest`, { job_order_id: joId }, { cookie: '' });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);

      // Verify interest was created
      const interest = db.prepare("SELECT * FROM interests WHERE phone = '5551112222' AND job_order_id = ?").get(joId);
      assert.ok(interest, 'Interest should exist');
      interestId = interest.id;
    });

    it('25. Move to yes-listed (PATCH /api/interests/:id/status)', async () => {
      const r = await http('PATCH', `/api/interests/${interestId}/status`, { status: 'yes_listed' });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
      assert.equal(r.data.status, 'yes_listed');
    });

    it('26. Move to confirmed', async () => {
      const r = await http('PATCH', `/api/interests/${interestId}/status`, { status: 'confirmed' });
      assert.equal(r.status, 200);
      assert.equal(r.data.status, 'confirmed');
    });

    it('27. Move to filled', async () => {
      const r = await http('PATCH', `/api/interests/${interestId}/status`, { status: 'filled' });
      assert.equal(r.status, 200);
      assert.equal(r.data.status, 'filled');
    });

    it('28. Rule out', async () => {
      // Create a second interest for a different candidate to rule out
      const cand2 = db.prepare("SELECT * FROM candidates WHERE phone = '5553334444'").get();
      await http('POST', `/m/${cand2.magic_token}/interest`, { job_order_id: joId }, { cookie: '' });
      const interest2 = db.prepare("SELECT * FROM interests WHERE phone = '5553334444' AND job_order_id = ?").get(joId);

      const r = await http('PATCH', `/api/interests/${interest2.id}/status`, { status: 'ruled_out' });
      assert.equal(r.status, 200);
      assert.equal(r.data.status, 'ruled_out');
    });

    it('29. Undo fill (move back to confirmed)', async () => {
      const r = await http('PATCH', `/api/interests/${interestId}/status`, { status: 'confirmed' });
      assert.equal(r.status, 200);
      assert.equal(r.data.status, 'confirmed');
    });
  });

  // ============================================================
  // MAGIC LINK
  // ============================================================

  describe('Magic Link', () => {

    it('30. Load candidate page (GET /m/:token)', async () => {
      const res = await httpRaw('GET', `/m/${candidateToken}`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Hi Alice'), 'Should greet candidate by name');
      assert.ok(html.includes('Published Welder'), 'Should show published JO');
    });

    it('31. Preview page (GET /m/preview)', async () => {
      const res = await httpRaw('GET', '/m/preview');
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('PREVIEW MODE'), 'Should show preview banner');
      assert.ok(html.includes('Published Welder'), 'Should show published jobs');
    });
  });

  // ============================================================
  // ADMIN
  // ============================================================

  describe('Admin', () => {

    it('32. Get/update settings', async () => {
      const get = await http('GET', '/api/settings');
      assert.equal(get.status, 200);
      assert.equal(get.data.cooldown_hours, '72');

      const set = await http('POST', '/api/settings', { cooldown_hours: '48' });
      assert.equal(set.status, 200);
      assert.equal(set.data.ok, true);

      const get2 = await http('GET', '/api/settings');
      assert.equal(get2.data.cooldown_hours, '48');

      // Reset back
      await http('POST', '/api/settings', { cooldown_hours: '72' });
    });

    it('33. Create template', async () => {
      const r = await http('POST', '/api/templates', {
        name: 'Test Template',
        body: 'Hey {first_name}! Jobs here: {link}',
        category: 'Industrial'
      });
      assert.equal(r.status, 200);
      assert.ok(r.data.id, 'Should return template ID');
      templateId = r.data.id;
    });

    it('34. Set template as default', async () => {
      const r = await http('PUT', `/api/templates/${templateId}/default`);
      assert.equal(r.status, 200);
      assert.equal(r.data.is_default, 1);
    });

    it('35. List users', async () => {
      const r = await http('GET', '/api/users');
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.data));
      assert.ok(r.data.length >= 2, 'Should have admin + invited user');
    });

    it('36. Edit user (PATCH /api/users/:id)', async () => {
      const r = await http('PATCH', `/api/users/${invitedUserId}`, { display_name: 'Updated Name' });
      assert.equal(r.status, 200);
      assert.equal(r.data.display_name, 'Updated Name');
    });

    it('37. Submit feedback', async () => {
      const r = await http('POST', '/api/feedback', { body: 'Great tool, love it!' });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);

      // Verify it's retrievable
      const list = await http('GET', '/api/feedback');
      assert.equal(list.status, 200);
      assert.ok(list.data.some(f => f.body === 'Great tool, love it!'));
    });

    it('38. Post changelog entry', async () => {
      const r = await http('POST', '/api/changelog', { version: 'v2.1.0', notes: 'Added blast form UX' });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);

      const list = await http('GET', '/api/changelog');
      assert.equal(list.status, 200);
      assert.ok(list.data.some(c => c.version === 'v2.1.0'));
    });
  });

  // ============================================================
  // BLAST GUARD
  // ============================================================

  describe('Blast Guard', () => {

    it('39. Verify cooldown prevents re-blast within 72 hours', async () => {
      // Alice was just blasted — try to blast her again immediately
      const s = await http('POST', '/api/tom/start', { path: 'blast' });
      const r = await http('POST', '/api/tom/message', {
        sessionId: s.data.sessionId,
        text: 'Alice Smith 555-111-2222'
      });
      assert.ok(r.data.showBlastForm);

      const preview = await http('POST', '/api/tom/message', {
        sessionId: s.data.sessionId,
        action: 'preview_blast',
        payload: {
          recipientMode: 'all',
          sortBy: 'most_recent',
          category: 'Industrial',
          templateBody: 'Hi {first_name}! {link}',
          recruiterId: null
        }
      });
      // Alice should be skipped due to cooldown
      assert.ok(
        preview.data.text.includes('skipped') || preview.data.text.includes('0 will be sent'),
        'Cooldown should skip Alice: ' + preview.data.text
      );
    });

    it('40. Verify DNC candidates are skipped', async () => {
      // Mark a candidate as DNC
      await http('POST', '/api/candidates/5557778888/dnc', { value: true });

      const s = await http('POST', '/api/tom/start', { path: 'blast' });
      await http('POST', '/api/tom/message', {
        sessionId: s.data.sessionId,
        text: 'Dave Brown 555-777-8888\nNew Person 555-222-3333'
      });

      const preview = await http('POST', '/api/tom/message', {
        sessionId: s.data.sessionId,
        action: 'preview_blast',
        payload: {
          recipientMode: 'all',
          sortBy: 'most_recent',
          category: 'Industrial',
          templateBody: 'Hi {first_name}! {link}',
          recruiterId: null
        }
      });
      // Dave should be skipped (DNC + cooldown), New Person should be sendable
      assert.ok(
        preview.data.text.includes('skipped'),
        'DNC/cooldown candidate should be skipped: ' + preview.data.text
      );
    });
  });

  // ============================================================
  // HELP / FAQ
  // ============================================================

  describe('Help / FAQ', () => {

    it('41. Start help path (POST /api/tom with help path)', async () => {
      const s = await http('POST', '/api/tom/start', { path: 'help' });
      assert.equal(s.status, 200);
      assert.ok(s.data.sessionId);
      assert.ok(s.data.text.includes('Help'), 'Should show help intro');
    });

    it('42. Ask a question', async () => {
      const s = await http('POST', '/api/tom/start', { path: 'help' });
      const r = await http('POST', '/api/tom/message', {
        sessionId: s.data.sessionId,
        text: 'What is the cooldown for blasts?'
      });
      assert.equal(r.status, 200);
      assert.ok(
        r.data.text.includes('72') || r.data.text.includes('cooldown'),
        'Should answer about cooldown: ' + r.data.text
      );
    });
  });

  // ============================================================
  // ADDITIONAL COVERAGE
  // ============================================================

  describe('Additional Coverage', () => {

    it('API returns 401 when not authenticated', async () => {
      const r = await http('GET', '/api/me', null, { cookie: '' });
      assert.equal(r.status, 401);
    });

    it('Non-admin cannot access admin endpoints', async () => {
      if (recruiterCookie) {
        const r = await http('GET', '/api/settings', null, { cookie: recruiterCookie });
        assert.equal(r.status, 403);
      }
    });

    it('Invalid magic token returns 404', async () => {
      const res = await httpRaw('GET', '/m/invalid_token_xyz');
      assert.equal(res.status, 404);
    });

    it('Interest on non-published JO fails', async () => {
      // joId2 was completed earlier, try interest on it
      const cand = db.prepare("SELECT magic_token FROM candidates WHERE phone = '5555556666'").get();
      const r = await http('POST', `/m/${cand.magic_token}/interest`, { job_order_id: joId2 }, { cookie: '' });
      assert.equal(r.data.ok, false);
      assert.equal(r.data.error, 'job_not_available');
    });

    it('Template without {link} is rejected', async () => {
      const r = await http('POST', '/api/templates', {
        name: 'Bad Template',
        body: 'No link placeholder here',
      });
      assert.equal(r.status, 400);
      assert.ok(r.data.error.includes('{link}'));
    });

    it('Candidate search works', async () => {
      const r = await http('GET', '/api/candidates?q=Alice');
      assert.equal(r.status, 200);
      assert.ok(r.data.some(c => c.first_name === 'Alice'));
    });

    it('Candidates list returns all', async () => {
      const r = await http('GET', '/api/candidates');
      assert.equal(r.status, 200);
      assert.ok(r.data.length >= 4, 'Should have at least 4 candidates');
    });

    it('Job orders can be filtered by status', async () => {
      const r = await http('GET', '/api/job-orders?status=Published');
      assert.equal(r.status, 200);
      assert.ok(r.data.every(jo => jo.status === 'Published'));
    });

    it('Blasts list endpoint works', async () => {
      const r = await http('GET', '/api/blasts');
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.data));
      assert.ok(r.data.length >= 1);
    });

    it('Logout works', async () => {
      const r = await http('POST', '/api/logout');
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
      // Verify we are logged out
      const me = await http('GET', '/api/me');
      assert.equal(me.status, 401);
      // Re-login for remaining tests
      await http('POST', '/api/login', { username: 'admin', password: 'joblink2026' });
    });

    it('Typed "yes" at blast gate is rejected', async () => {
      // Start a fresh blast, get to preview, try typing yes
      const s = await http('POST', '/api/tom/start', { path: 'blast' });
      await http('POST', '/api/tom/message', {
        sessionId: s.data.sessionId,
        text: 'New Tester 555-444-5555'
      });
      await http('POST', '/api/tom/message', {
        sessionId: s.data.sessionId,
        action: 'preview_blast',
        payload: {
          recipientMode: 'all',
          sortBy: 'most_recent',
          category: 'Administrative',
          templateBody: 'Hi {first_name}! {link}',
          recruiterId: null
        }
      });
      // Now try typing "yes" instead of button
      const typed = await http('POST', '/api/tom/message', {
        sessionId: s.data.sessionId,
        text: 'yes'
      });
      assert.ok(
        typed.data.text.includes('button') || typed.data.text.includes('Send button'),
        'Typed yes should be rejected: ' + typed.data.text
      );
    });

    it('PATCH template body', async () => {
      const r = await http('PATCH', `/api/templates/${templateId}`, {
        body: 'Updated: {first_name} check {link}'
      });
      assert.equal(r.status, 200);
      assert.ok(r.data.body.includes('Updated'));
    });

    it('Delete template (non-default)', async () => {
      // Create a throwaway template
      const t = await http('POST', '/api/templates', {
        name: 'To Delete', body: 'Delete me {link}'
      });
      const r = await http('DELETE', `/api/templates/${t.data.id}`);
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
    });

    it('Cannot delete default template', async () => {
      const r = await http('DELETE', `/api/templates/${templateId}`);
      assert.equal(r.status, 400);
      assert.ok(r.data.error.includes('default'));
    });

    it('Invite validate endpoint', async () => {
      await http('POST', '/api/invite', { email: 'validate-test@example.com', role: 'recruiter' });
      const user = db.prepare("SELECT invite_token FROM users WHERE email = 'validate-test@example.com'").get();
      const r = await http('GET', `/api/invite/validate?token=${user.invite_token}`, null, { cookie: '' });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
      assert.equal(r.data.email, 'validate-test@example.com');
    });

    it('Reset password flow', async () => {
      await http('POST', '/api/forgot-password', { email: 'joshuafriends@gmail.com' });
      const user = db.prepare("SELECT magic_login_token FROM users WHERE email = 'joshuafriends@gmail.com'").get();
      assert.ok(user.magic_login_token, 'Should have reset token');

      const r = await http('POST', '/api/reset-password', {
        token: user.magic_login_token,
        password: 'newpassword123'
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);

      // Login with new password
      const login = await http('POST', '/api/login', { email: 'joshuafriends@gmail.com', password: 'newpassword123' });
      assert.equal(login.status, 200);
      assert.equal(login.data.ok, true);
    });

    it('Change own password', async () => {
      const r = await http('POST', '/api/me/password', { current: 'newpassword123', password: 'joblink2026' });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
    });

    it('Pipeline status validation rejects bad status', async () => {
      const r = await http('PATCH', `/api/interests/${interestId}/status`, { status: 'invalid_status' });
      assert.equal(r.status, 400);
    });

    it('JO detail includes pipeline counts', async () => {
      const r = await http('GET', `/api/job-orders/${joId}`);
      assert.equal(r.status, 200);
      assert.ok('interested_count' in r.data);
      assert.ok('filled_count' in r.data);
      assert.ok(r.data.pipeline);
    });

    it('Stats endpoint returns all counts', async () => {
      const r = await http('GET', '/api/stats');
      assert.equal(r.status, 200);
      assert.ok('candidates' in r.data);
      assert.ok('interests' in r.data);
      assert.ok('published' in r.data);
      assert.ok('blasts' in r.data);
      assert.ok('filled' in r.data);
    });
  });
});
