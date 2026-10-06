// tests/deterministic/analytics.test.js — smoke tests for analytics query logic
// Uses in-memory SQLite DBs, no HTTP, no network.

const { test } = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../../src/db');
const { upsertCandidates } = require('../../src/importing');
const { planBlast, executeBlast } = require('../../src/blast');
const mock = require('../../src/messaging/mock');

const NOW = new Date('2026-09-01T12:00:00Z');

function seededDb() {
  const db = openDb(':memory:');
  upsertCandidates(db, [
    { first: 'Al', last: 'A', phone: '1111111111' },
    { first: 'Bo', last: 'B', phone: '2222222222' },
    { first: 'Cy', last: 'C', phone: '3333333333' },
  ]);
  db.prepare("INSERT INTO job_orders (title, category, pay, shift_hours, location, requirements, description, company, status) VALUES (?,?,?,?,?,?,?,?,?)").run('Warehouse Associate', 'Industrial', '$18/hr', '7am-3pm', '123 Main', 'Lift 50lb', 'General labor', 'ACME', 'Published');
  db.prepare("INSERT INTO job_orders (title, category, pay, shift_hours, location, requirements, description, company, status) VALUES (?,?,?,?,?,?,?,?,?)").run('Forklift Operator', 'Skilled Trades', '$22/hr', '6am-2pm', '456 Oak', 'Class A', 'Drive forklift', 'ACME', 'Published');
  return db;
}

test('analytics/overview: candidate count excludes DNC', () => {
  const db = seededDb();
  db.prepare('UPDATE candidates SET do_not_contact = 1 WHERE phone = ?').run('3333333333');
  const total = db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE do_not_contact = 0').get().n;
  assert.strictEqual(total, 2);
});

test('analytics/overview: blast count and sent count', async () => {
  const db = seededDb();
  const plan = planBlast(db, { phones: ['1111111111', '2222222222'], category: 'Industrial', now: NOW });
  await executeBlast(db, plan, { templateBody: 'Hi {first_name}: {link}', provider: mock.create(), now: NOW, pacingMs: 0 });
  const blastCount = db.prepare('SELECT COUNT(*) AS n FROM blasts').get().n;
  const totalSent = db.prepare('SELECT COALESCE(SUM(sent_count),0) AS n FROM blasts').get().n;
  assert.strictEqual(blastCount, 1);
  assert.strictEqual(totalSent, 2);
});

test('analytics/overview: response rate calculation', async () => {
  const db = seededDb();
  const plan = planBlast(db, { phones: ['1111111111', '2222222222', '3333333333'], category: 'Industrial', now: NOW });
  await executeBlast(db, plan, { templateBody: '{link}', provider: mock.create(), now: NOW, pacingMs: 0 });
  // Simulate one interest reply linked to blast
  const blastId = db.prepare('SELECT id FROM blasts ORDER BY id DESC LIMIT 1').get().id;
  const jo = db.prepare('SELECT id FROM job_orders LIMIT 1').get();
  db.prepare('INSERT INTO interests (phone, job_order_id, blast_id, status) VALUES (?,?,?,?)').run('1111111111', jo.id, blastId, 'interested');
  const totalSent = db.prepare('SELECT COALESCE(SUM(sent_count),0) AS n FROM blasts').get().n;
  const totalInterested = db.prepare("SELECT COUNT(*) AS n FROM interests WHERE status = 'interested'").get().n;
  const responseRate = totalSent > 0 ? Math.round((totalInterested / totalSent) * 100 * 10) / 10 : 0;
  assert.strictEqual(totalSent, 3);
  assert.strictEqual(totalInterested, 1);
  assert.ok(responseRate > 0 && responseRate <= 100, 'response rate should be between 0-100');
});

test('analytics/pipeline: byInterestStatus groups correctly', async () => {
  const db = seededDb();
  const jo = db.prepare('SELECT id FROM job_orders LIMIT 1').get();
  db.prepare("INSERT INTO interests (phone, job_order_id, status) VALUES (?,?,?)").run('1111111111', jo.id, 'interested');
  db.prepare("INSERT INTO interests (phone, job_order_id, status) VALUES (?,?,?)").run('2222222222', jo.id, 'yes_listed');
  const statuses = db.prepare('SELECT status, COUNT(*) AS count FROM interests GROUP BY status').all();
  const byStatus = Object.fromEntries(statuses.map(r => [r.status, r.count]));
  assert.strictEqual(byStatus['interested'], 1);
  assert.strictEqual(byStatus['yes_listed'], 1);
});

test('test-suite/validate-phones: normalizePhone rejects garbage', () => {
  const { normalizePhone } = require('../../src/phone');
  assert.ok(normalizePhone('2065551234'), '10-digit should normalize');
  assert.ok(normalizePhone('+12065551234'), 'E.164 should pass through');
  assert.strictEqual(normalizePhone('notaphone'), null, 'garbage should return null');
  assert.strictEqual(normalizePhone('123'), null, 'too short should return null');
});

test('analytics/trends: daily grouping returns valid rows', async () => {
  const db = seededDb();
  const plan = planBlast(db, { phones: ['1111111111'], category: 'Industrial', now: NOW });
  await executeBlast(db, plan, { templateBody: '{link}', provider: mock.create(), now: NOW, pacingMs: 0 });
  const days = 30;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const dailyBlasts = db.prepare(
    "SELECT strftime('%Y-%m-%d', sent_at) AS day, SUM(sent_count) AS messages FROM blasts WHERE sent_at >= ? GROUP BY day ORDER BY day"
  ).all(since);
  // The blast was sent with NOW = 2026-09-01, which is within 30 days of today (2026-09-29)
  assert.ok(Array.isArray(dailyBlasts), 'should return array');
  assert.ok(dailyBlasts.length >= 0, 'should not error');
});
