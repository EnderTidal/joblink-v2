// The candidate-facing magic link: category comes from the most recent blast,
// interest is per-job, deduped, and attributed to the blast that brought them in.
const { test } = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../../src/db');
const { upsertCandidates } = require('../../src/importing');
const { createJobOrder } = require('../../src/job-orders');
const { planBlast, executeBlast } = require('../../src/blast');
const { renderCandidatePage, markInterest } = require('../../src/candidate-page');
const mock = require('../../src/messaging/mock');

const NOW = new Date('2026-07-21T12:00:00Z');

async function setup() {
  const db = openDb(':memory:');
  upsertCandidates(db, [{ first: 'Al', last: 'A', phone: '1111111111' }]);
  const joInd = createJobOrder(db, { title: 'Forklift Op', category: 'Industrial', pay: '$18/hr', status: 'Published' });
  const joAdm = createJobOrder(db, { title: 'Front Desk', category: 'Administrative', pay: '$16/hr', status: 'Published' });
  const plan = planBlast(db, { phones: ['1111111111'], category: 'Industrial', now: NOW });
  const { blastId } = await executeBlast(db, plan, { templateBody: '{link}', provider: mock.create(), now: NOW, pacingMs: 0 });
  const cand = db.prepare(`SELECT * FROM candidates WHERE phone = '1111111111'`).get();
  return { db, cand, joInd, joAdm, blastId };
}

test('page shows only the current category (most recent blast wins)', async () => {
  const { db, cand } = await setup();
  const html = renderCandidatePage(db, cand);
  assert.ok(html.includes('Forklift Op'));
  assert.ok(!html.includes('Front Desk'), 'other-category jobs must not appear');
  assert.ok(html.includes('$18/hr'));
  assert.ok(html.includes('Al'), 'greets by first name');
});

test('unpublished jobs never appear, even in the right category', async () => {
  const { db, cand } = await setup();
  createJobOrder(db, { title: 'Secret Job', category: 'Industrial', pay: '$99/hr', status: 'Unpublished' });
  assert.ok(!renderCandidatePage(db, cand).includes('Secret Job'));
});

test('marking interest: recorded once, attributed to the blast', async () => {
  const { db, cand, joInd, blastId } = await setup();
  assert.deepStrictEqual(markInterest(db, cand, joInd), { ok: true });
  assert.deepStrictEqual(markInterest(db, cand, joInd), { ok: true }); // idempotent
  const rows = db.prepare('SELECT * FROM interests WHERE phone = ?').all(cand.phone);
  assert.strictEqual(rows.length, 1, 'double-tap must not create duplicates');
  assert.strictEqual(rows[0].blast_id, blastId, 'interest is attributed to the blast that brought them in');
});

test('cannot mark interest in an unpublished job', async () => {
  const { db, cand } = await setup();
  const hidden = createJobOrder(db, { title: 'Hidden', category: 'Industrial', pay: '$1', status: 'Unpublished' });
  assert.strictEqual(markInterest(db, cand, hidden).ok, false);
});

test('interested counts flow into Review Magic Blasts', async () => {
  const { db, cand, joInd, blastId } = await setup();
  markInterest(db, cand, joInd);
  const { listBlasts } = require('../../src/blast');
  const blasts = listBlasts(db);
  const b = blasts.find((x) => x.id === blastId);
  assert.strictEqual(b.interested_count, 1);
});

test('page HTML escapes job content (no script injection from parsed docs)', async () => {
  const { db, cand } = await setup();
  createJobOrder(db, { title: '<script>alert(1)</script>', category: 'Industrial', pay: '$1', status: 'Published' });
  const html = renderCandidatePage(db, cand);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
