// Blast engine: guard-first preview, partial-send rule, per-blast records,
// most-recent-blast-wins category, template {link} requirement.
const { test } = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../../src/db');
const { upsertCandidates } = require('../../src/importing');
const { planBlast, executeBlast, renderMessage } = require('../../src/blast');
const mock = require('../../src/messaging/mock');

const NOW = new Date('2026-07-21T12:00:00Z');

function seededDb() {
  const db = openDb(':memory:');
  upsertCandidates(db, [
    { first: 'Al', last: 'A', phone: '1111111111' },
    { first: 'Bo', last: 'B', phone: '2222222222' },
    { first: 'Cy', last: 'C', phone: '3333333333' },
    { first: 'Di', last: 'D', phone: '4444444444' },
  ]);
  // Bo is cooling (1h ago), Di replied STOP
  db.prepare(`UPDATE candidates SET last_blast = ? WHERE phone = '2222222222'`).run(new Date(NOW - 36e5).toISOString());
  db.prepare(`UPDATE candidates SET do_not_contact = 1 WHERE phone = '4444444444'`).run();
  return db;
}

const ALL = ['1111111111', '2222222222', '3333333333', '4444444444'];

test('plan applies Blast Guard BEFORE preview: counts are known pre-confirmation', () => {
  const db = seededDb();
  const plan = planBlast(db, { phones: ALL, category: 'Industrial', now: NOW });
  assert.strictEqual(plan.sendable.length, 2);
  assert.strictEqual(plan.skippedCooldown.length, 1);
  assert.strictEqual(plan.skippedDnc.length, 1);
});

test('invalid category is rejected outright', () => {
  const db = seededDb();
  assert.throws(() => planBlast(db, { phones: ALL, category: 'Warehouse', now: NOW }), /Invalid category/);
});

test('template without {link} is rejected — a magic blast without the link is just a text', async () => {
  const db = seededDb();
  const plan = planBlast(db, { phones: ALL, category: 'Industrial', now: NOW });
  await assert.rejects(
    executeBlast(db, plan, { templateBody: 'Hi {first_name}!', provider: mock.create(), pacingMs: 0 }),
    /must include \{link\}/,
  );
});

test('full send: blast record, recipients, cooldown burns, category update', async () => {
  const db = seededDb();
  const plan = planBlast(db, { phones: ALL, category: 'Industrial', now: NOW });
  const provider = mock.create();
  const result = await executeBlast(db, plan, {
    templateBody: 'Hi {first_name}: {link}', provider, sentBy: 'josh', now: NOW, pacingMs: 0,
  });

  assert.strictEqual(result.sent, 2);
  assert.strictEqual(result.skippedCooldown, 1);
  assert.strictEqual(result.skippedDnc, 1);
  assert.strictEqual(provider.sent.length, 2);
  assert.ok(provider.sent[0].body.includes('/m/'), 'message contains the magic link');

  const blast = db.prepare('SELECT * FROM blasts WHERE id = ?').get(result.blastId);
  assert.strictEqual(blast.sent_count, 2);
  assert.strictEqual(blast.skipped_cooldown_count, 1);
  assert.strictEqual(blast.skipped_dnc_count, 1);
  assert.strictEqual(blast.category, 'Industrial');
  assert.strictEqual(blast.sent_by, 'josh');

  const al = db.prepare(`SELECT * FROM candidates WHERE phone = '1111111111'`).get();
  assert.strictEqual(al.last_blast, NOW.toISOString());
  assert.strictEqual(al.blast_count, 1);
  assert.strictEqual(al.current_category, 'Industrial'); // most recent blast wins

  const bo = db.prepare(`SELECT * FROM candidates WHERE phone = '2222222222'`).get();
  assert.strictEqual(bo.blast_count, 0, 'skipped candidate must not be counted');

  const recipients = db.prepare('SELECT status, COUNT(*) n FROM blast_recipients WHERE blast_id = ? GROUP BY status').all(result.blastId);
  const byStatus = Object.fromEntries(recipients.map((r) => [r.status, r.n]));
  assert.deepStrictEqual(byStatus, { sent: 2, skipped_cooldown: 1, skipped_dnc: 1 });
});

test('PARTIAL-SEND RULE: a failed send never burns a cooldown', async () => {
  const db = seededDb();
  const plan = planBlast(db, { phones: ALL, category: 'Industrial', now: NOW });
  const provider = mock.create({ failNumbers: ['3333333333'] }); // Cy's send fails mid-blast
  const result = await executeBlast(db, plan, {
    templateBody: 'Hi {first_name}: {link}', provider, now: NOW, pacingMs: 0,
  });

  assert.strictEqual(result.sent, 1);
  assert.strictEqual(result.failed, 1);

  const cy = db.prepare(`SELECT * FROM candidates WHERE phone = '3333333333'`).get();
  assert.strictEqual(cy.last_blast, null, 'failed send must NOT set last_blast');
  assert.strictEqual(cy.blast_count, 0, 'failed send must NOT bump blast_count');

  const rec = db.prepare(`SELECT status FROM blast_recipients WHERE blast_id = ? AND phone = '3333333333'`).get(result.blastId);
  assert.strictEqual(rec.status, 'failed');
});

test('a second blast in a different category updates current_category (most recent wins)', async () => {
  const db = seededDb();
  const p1 = planBlast(db, { phones: ['1111111111'], category: 'Industrial', now: NOW });
  await executeBlast(db, p1, { templateBody: '{link}', provider: mock.create(), now: NOW, pacingMs: 0 });
  const later = new Date(NOW.getTime() + 80 * 36e5); // 80h later, past cooldown
  const p2 = planBlast(db, { phones: ['1111111111'], category: 'Administrative', now: later });
  assert.strictEqual(p2.sendable.length, 1, 'cooldown must have expired after 80h');
  await executeBlast(db, p2, { templateBody: '{link}', provider: mock.create(), now: later, pacingMs: 0 });
  const al = db.prepare(`SELECT current_category, blast_count FROM candidates WHERE phone = '1111111111'`).get();
  assert.strictEqual(al.current_category, 'Administrative');
  assert.strictEqual(al.blast_count, 2);
});

test('renderMessage fills placeholders and falls back to "there" without a name', () => {
  const c = { first_name: '', magic_token: 'tok123' };
  const out = renderMessage('Hi {first_name}! {link}', c, 'https://jl.example');
  assert.strictEqual(out, 'Hi there! https://jl.example/m/tok123');
});
