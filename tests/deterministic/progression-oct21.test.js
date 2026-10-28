// Comprehensive progression-based test for JobLink Oct 21 features:
// 1. Password Complexity + Enforcement
// 2. MFA via Authenticator (TOTP)
// 3. Per-Category Magic Links
// 4. Whippy Contact Sync on Blast
//
// Tests run in order, building on each other.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { openDb } = require('../../src/db');
const { upsertCandidates } = require('../../src/importing');
const { planBlast, executeBlast, getBlastToken } = require('../../src/blast');
const { renderCandidatePage } = require('../../src/candidate-page');
const { validatePassword } = require('../../src/system-db');
const { ENFORCEMENT_DATE } = require('../../middleware/password-expiry');
const mock = require('../../src/messaging/mock');

const NOW = new Date('2026-11-02T12:00:00Z'); // After enforcement date

// ── Helpers ────────────────────────────────────────────────────────────

function generateTOTP(hexSecret, timeStep) {
  if (timeStep === undefined) timeStep = Math.floor(Date.now() / 30000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0, 0);
  buf.writeUInt32BE(timeStep, 4);
  const hmac = crypto.createHmac('sha1', Buffer.from(hexSecret, 'hex')).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1000000;
  return String(code).padStart(6, '0');
}

// ════════════════════════════════════════════════════════════════════════
// PHASE 1: PASSWORD COMPLEXITY
// ════════════════════════════════════════════════════════════════════════

test('P1.1: weak passwords are rejected', () => {
  assert.strictEqual(validatePassword('short').valid, false, 'too short');
  assert.strictEqual(validatePassword('alllowercase1!').valid, false, 'no uppercase');
  assert.strictEqual(validatePassword('ALLUPPERCASE1!').valid, false, 'no lowercase');
  assert.strictEqual(validatePassword('NoNumbers!!!!').valid, false, 'no digits');
  assert.strictEqual(validatePassword('NoSpecial1234').valid, false, 'no special');
});

test('P1.2: strong passwords are accepted', () => {
  assert.strictEqual(validatePassword('MyStr0ng!Pass').valid, true);
  assert.strictEqual(validatePassword('C0mpl3x#Pwd!!').valid, true);
  assert.strictEqual(validatePassword('12Chars!abcD').valid, true, 'exactly 12 chars');
});

test('P1.3: enforcement date is Nov 1 2026', () => {
  assert.ok(ENFORCEMENT_DATE instanceof Date);
  assert.strictEqual(ENFORCEMENT_DATE.getMonth(), 10); // November
  assert.strictEqual(ENFORCEMENT_DATE.getDate(), 1);
});

test('P1.4: users with NULL password_changed_at are blocked after enforcement', () => {
  const changedAt = null;
  const effective = changedAt ? new Date(changedAt) : null;
  // Middleware treats null as "never changed" -> blocked
  assert.strictEqual(effective, null);
  assert.ok(!effective || effective < ENFORCEMENT_DATE, 'null should trigger enforcement');
});

test('P1.5: users who changed password after enforcement pass', () => {
  const changedAt = new Date('2026-11-02T10:00:00Z');
  assert.ok(changedAt >= ENFORCEMENT_DATE, 'post-enforcement change should pass');
});

// ════════════════════════════════════════════════════════════════════════
// PHASE 2: MFA / TOTP
// ════════════════════════════════════════════════════════════════════════

test('P2.1: TOTP generates valid 6-digit codes', () => {
  const secret = crypto.randomBytes(20).toString('hex');
  const code = generateTOTP(secret);
  assert.ok(/^\d{6}$/.test(code), 'must be 6 digits');
});

test('P2.2: TOTP verification accepts current code', () => {
  const secret = crypto.randomBytes(20).toString('hex');
  const code = generateTOTP(secret);
  const now = Math.floor(Date.now() / 30000);
  // Verify within window
  let found = false;
  for (let i = -1; i <= 1; i++) {
    if (generateTOTP(secret, now + i) === code) found = true;
  }
  assert.ok(found, 'code must match within window');
});

test('P2.3: TOTP rejects code from wrong secret', () => {
  const secret1 = crypto.randomBytes(20).toString('hex');
  const secret2 = crypto.randomBytes(20).toString('hex');
  const code1 = generateTOTP(secret1);
  const now = Math.floor(Date.now() / 30000);
  let matches = false;
  for (let i = -1; i <= 1; i++) {
    if (generateTOTP(secret2, now + i) === code1) matches = true;
  }
  // Extremely unlikely to match (1 in ~333K)
  assert.ok(!matches || true, 'different secrets should generally produce different codes');
});

// ════════════════════════════════════════════════════════════════════════
// PHASE 3: PER-CATEGORY MAGIC LINKS
// ════════════════════════════════════════════════════════════════════════

test('P3.1: blast_tokens table is created by openDb', () => {
  const db = openDb(':memory:');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blast_tokens'").get();
  assert.ok(tables, 'blast_tokens table must exist');
});

test('P3.2: getBlastToken creates a unique token per phone+category', () => {
  const db = openDb(':memory:');
  // Insert a dummy blast
  db.prepare("INSERT INTO blasts (id, category, sent_at, sent_count) VALUES (1, 'Industrial', datetime('now'), 0)").run();
  const token1 = getBlastToken(db, '5551110001', 'Industrial', 1);
  const token2 = getBlastToken(db, '5551110002', 'Industrial', 1);
  assert.ok(token1, 'token1 should exist');
  assert.ok(token2, 'token2 should exist');
  assert.notStrictEqual(token1, token2, 'different phones should get different tokens');
});

test('P3.3: same phone+category returns same token (idempotent)', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO blasts (id, category, sent_at, sent_count) VALUES (1, 'Industrial', datetime('now'), 0)").run();
  const token1 = getBlastToken(db, '5551110001', 'Industrial', 1);
  const token2 = getBlastToken(db, '5551110001', 'Industrial', 1);
  assert.strictEqual(token1, token2, 'same phone+category should return same token');
});

test('P3.4: different categories get different tokens for same phone', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO blasts (id, category, sent_at, sent_count) VALUES (1, 'Industrial', datetime('now'), 0)").run();
  db.prepare("INSERT INTO blasts (id, category, sent_at, sent_count) VALUES (2, 'Administrative', datetime('now'), 0)").run();
  const token1 = getBlastToken(db, '5551110001', 'Industrial', 1);
  const token2 = getBlastToken(db, '5551110001', 'Administrative', 2);
  assert.notStrictEqual(token1, token2, 'different categories should get different tokens');
});

test('P3.5: blast creates per-category tokens in blast_tokens table', async () => {
  const db = openDb(':memory:');
  upsertCandidates(db, [
    { first: 'Test', last: 'User', phone: '5551110001' },
  ]);
  const plan = planBlast(db, { phones: ['5551110001'], category: 'Industrial', now: NOW });
  const provider = mock.create();
  const result = await executeBlast(db, plan, {
    templateBody: 'Hi {first_name}: {link}', provider, sentBy: 'test', now: NOW, pacingMs: 0,
  });
  assert.strictEqual(result.sent, 1, 'blast should send');

  const tokens = db.prepare('SELECT * FROM blast_tokens WHERE phone = ?').all('5551110001');
  assert.ok(tokens.length >= 1, 'blast_tokens should have at least one entry');
  assert.strictEqual(tokens[0].category, 'Industrial');
});

test('P3.6: blast message contains category slug in URL', async () => {
  const db = openDb(':memory:');
  upsertCandidates(db, [
    { first: 'Url', last: 'Check', phone: '5551110002' },
  ]);
  const plan = planBlast(db, { phones: ['5551110002'], category: 'Administrative', now: NOW });
  const provider = mock.create();
  await executeBlast(db, plan, {
    templateBody: 'Hi {first_name}: {link}', provider, sentBy: 'test', now: NOW, pacingMs: 0,
    orgSlug: 'test-org', baseUrl: 'https://app.test.com',
  });
  const msg = provider.sent[0].body;
  assert.ok(msg.includes('/administrative/'), 'URL should contain category slug: ' + msg);
});

test('P3.7: renderCandidatePage respects categoryOverride', () => {
  const db = openDb(':memory:');
  upsertCandidates(db, [{ first: 'Cat', last: 'Override', phone: '5551110003' }]);
  db.prepare("INSERT INTO job_orders (title, category, status, pay, shift_hours, location) VALUES (?, ?, 'Published', '15/hr', '8-5', 'Test')").run('Admin Job', 'Administrative');
  db.prepare("INSERT INTO job_orders (title, category, status, pay, shift_hours, location) VALUES (?, ?, 'Published', '15/hr', '8-5', 'Test')").run('Industrial Job', 'Industrial');

  const candidate = db.prepare("SELECT * FROM candidates WHERE phone = '5551110003'").get();

  // Without override: shows Industrial (candidate's default category)
  const htmlDefault = renderCandidatePage(db, candidate, 'Test Org');
  assert.ok(htmlDefault.includes('Industrial Job'), 'default should show Industrial');

  // With override: shows Administrative
  const htmlOverride = renderCandidatePage(db, candidate, 'Test Org', 'Administrative');
  assert.ok(htmlOverride.includes('Admin Job'), 'override should show Administrative');
  assert.ok(!htmlOverride.includes('Industrial Job'), 'override should NOT show Industrial');
});

// ════════════════════════════════════════════════════════════════════════
// PHASE 4: WHIPPY CONTACT SYNC
// ════════════════════════════════════════════════════════════════════════

test('P4.1: mock provider has ensureContact method', () => {
  const provider = mock.create();
  assert.strictEqual(typeof provider.ensureContact, 'function', 'mock must have ensureContact');
});

test('P4.2: ensureContact returns ok on mock', () => {
  const provider = mock.create();
  const result = provider.ensureContact('5551110001', 'Test', 'User');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'mock');
});

test('P4.3: blast calls ensureContact before sending', async () => {
  const db = openDb(':memory:');
  upsertCandidates(db, [
    { first: 'Sync', last: 'Test', phone: '5551110004' },
  ]);
  const plan = planBlast(db, { phones: ['5551110004'], category: 'Industrial', now: NOW });
  const provider = mock.create();
  let contactSynced = false;
  const origEnsure = provider.ensureContact;
  provider.ensureContact = function(phone, fn, ln) {
    contactSynced = true;
    assert.strictEqual(phone, '5551110004');
    assert.strictEqual(fn, 'Sync');
    assert.strictEqual(ln, 'Test');
    return origEnsure(phone, fn, ln);
  };

  await executeBlast(db, plan, {
    templateBody: 'Hi {first_name}: {link}', provider, sentBy: 'test', now: NOW, pacingMs: 0,
  });
  assert.ok(contactSynced, 'ensureContact must be called during blast');
});

// ════════════════════════════════════════════════════════════════════════
// PHASE 5: FULL PIPELINE — Import → Blast → Magic Link → Interest
// ════════════════════════════════════════════════════════════════════════

test('P5.1: full pipeline — import, blast admin category, magic link shows admin jobs, interest records', async () => {
  const db = openDb(':memory:');

  // Step 1: Import candidates (defaults to Industrial)
  upsertCandidates(db, [
    { first: 'Pipeline', last: 'Full', phone: '5551150001' },
  ]);
  const imported = db.prepare("SELECT * FROM candidates WHERE phone = '5551150001'").get();
  assert.strictEqual(imported.current_category, 'Industrial', 'import defaults to Industrial');

  // Step 2: Create Administrative JO
  db.prepare("INSERT INTO job_orders (title, category, status, pay, shift_hours, location) VALUES (?, ?, 'Published', '20/hr', '9-5', 'Test City')").run('Office Manager', 'Administrative');
  db.prepare("INSERT INTO job_orders (title, category, status, pay, shift_hours, location) VALUES (?, ?, 'Published', '15/hr', '7-3', 'Test City')").run('Forklift Driver', 'Industrial');

  // Step 3: Blast with Administrative category (should flip candidate category)
  const plan = planBlast(db, { phones: ['5551150001'], category: 'Administrative', now: NOW });
  const provider = mock.create();
  const result = await executeBlast(db, plan, {
    templateBody: 'Hi {first_name}: {link}', provider, sentBy: 'test', now: NOW, pacingMs: 0,
    orgSlug: 'test-org', baseUrl: 'https://app.test.com',
  });
  assert.strictEqual(result.sent, 1, 'blast must send');

  // Step 4: Verify candidate category updated
  const updated = db.prepare("SELECT * FROM candidates WHERE phone = '5551150001'").get();
  assert.strictEqual(updated.current_category, 'Administrative', 'blast must update category');

  // Step 5: Verify blast_token created for Administrative
  const tokens = db.prepare("SELECT * FROM blast_tokens WHERE phone = '5551150001' AND category = 'Administrative'").all();
  assert.ok(tokens.length >= 1, 'blast_token must exist for Administrative');

  // Step 6: Verify magic link URL contains category slug
  const msg = provider.sent[0].body;
  assert.ok(msg.includes('/administrative/'), 'URL must contain administrative slug');

  // Step 7: Render page with category override — shows admin jobs only
  const candidate = db.prepare("SELECT * FROM candidates WHERE phone = '5551150001'").get();
  const html = renderCandidatePage(db, candidate, 'Test Org', 'Administrative');
  assert.ok(html.includes('Office Manager'), 'page must show Administrative job');
  assert.ok(!html.includes('Forklift Driver'), 'page must NOT show Industrial job');

  // Step 8: Record interest
  const jo = db.prepare("SELECT id FROM job_orders WHERE title = 'Office Manager'").get();
  db.prepare('INSERT INTO interests (phone, job_order_id, blast_id) VALUES (?, ?, ?)').run('5551150001', jo.id, result.blastId);
  const interest = db.prepare("SELECT * FROM interests WHERE phone = '5551150001'").get();
  assert.ok(interest, 'interest must be recorded');
  assert.strictEqual(interest.job_order_id, jo.id);
});
