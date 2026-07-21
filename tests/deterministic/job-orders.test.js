// Job Orders: the enumerated field list, validation, and dashboard actions.
const { test } = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../../src/db');
const { JOB_ORDER_FIELDS, validateJobOrder, createJobOrder, setStatus, listJobOrders, publishedInCategory } = require('../../src/job-orders');

const GOOD = {
  title: 'Forklift Operator', category: 'Industrial', pay: '$18/hr',
  shift_hours: '1st shift', location: 'Waxahachie, TX',
  requirements: '6+ months experience', description: 'Warehouse work', status: 'Unpublished',
};

test('the field list is exactly the eight agreed fields', () => {
  assert.deepStrictEqual(JOB_ORDER_FIELDS.map((f) => f.key),
    ['title', 'category', 'pay', 'shift_hours', 'location', 'requirements', 'description', 'status']);
});

test('required fields: title, category, pay, status', () => {
  const v = validateJobOrder({ description: 'something' });
  assert.deepStrictEqual(v.missing.sort(), ['category', 'pay', 'status', 'title'].sort());
  assert.strictEqual(validateJobOrder(GOOD).ok, true);
});

test('bad category and bad status are rejected', () => {
  assert.ok(!validateJobOrder({ ...GOOD, category: 'Warehouse' }).ok);
  assert.ok(!validateJobOrder({ ...GOOD, status: 'Live' }).ok);
});

test('dashboard actions: publish / unpublish / complete', () => {
  const db = openDb(':memory:');
  const id = createJobOrder(db, GOOD);
  assert.strictEqual(setStatus(db, id, 'Published').status, 'Published');
  assert.strictEqual(setStatus(db, id, 'Unpublished').status, 'Unpublished');
  assert.strictEqual(setStatus(db, id, 'Complete').status, 'Complete');
  assert.throws(() => setStatus(db, id, 'Deleted'), /Bad status/);
});

test('candidate page query: only Published jobs in the category', () => {
  const db = openDb(':memory:');
  const a = createJobOrder(db, { ...GOOD, title: 'A', status: 'Published' });
  createJobOrder(db, { ...GOOD, title: 'B', status: 'Unpublished' });
  createJobOrder(db, { ...GOOD, title: 'C', status: 'Complete' });
  createJobOrder(db, { ...GOOD, title: 'D', category: 'Administrative', status: 'Published' });
  const visible = publishedInCategory(db, 'Industrial');
  assert.deepStrictEqual(visible.map((j) => j.title), ['A']);
  assert.strictEqual(visible[0].id, a);
});

test('list filters by status and category and counts interest', () => {
  const db = openDb(':memory:');
  const id = createJobOrder(db, { ...GOOD, status: 'Published' });
  db.prepare(`INSERT INTO candidates (phone, magic_token) VALUES ('5551234567', 'tok')`).run();
  db.prepare('INSERT INTO interests (phone, job_order_id) VALUES (?, ?)').run('5551234567', id);
  const rows = listJobOrders(db, { status: 'Published', category: 'Industrial' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].interested_count, 1);
});
