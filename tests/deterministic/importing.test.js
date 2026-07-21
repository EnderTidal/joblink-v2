// Importing: header detection, the Overwrite Rule, ephemeral Last Contacted,
// and in-file dedup. The Overwrite Rule test is the canonical one from the
// brief: name changes, history NEVER does.
const { test } = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../../src/db');
const { parseContactRows, upsertCandidates, selectByLastContacted } = require('../../src/importing');

function freshDb() { return openDb(':memory:'); }

test('parses a headered list with separate first/last columns', () => {
  const { contacts, invalid } = parseContactRows([
    ['First Name', 'Last Name', 'Phone'],
    ['John', 'Smith', '(555) 123-4567'],
    ['Jane', 'Doe', '555.987.6543'],
    ['Bad', 'Row', 'not a phone'],
  ]);
  assert.strictEqual(contacts.length, 2);
  assert.deepStrictEqual(contacts[0], { first: 'John', last: 'Smith', phone: '5551234567', lastContacted: null, raw: contacts[0].raw });
  assert.strictEqual(invalid.length, 1);
  assert.strictEqual(invalid[0].reason, 'bad_phone');
});

test('parses a combined-name column (the §12 edge case)', () => {
  const { contacts } = parseContactRows([
    ['Name', 'Phone Number'],
    ['John Smith', '5551234567'],
    ['Doe, Jane', '5559876543'],
  ]);
  assert.deepStrictEqual([contacts[0].first, contacts[0].last], ['John', 'Smith']);
  assert.deepStrictEqual([contacts[1].first, contacts[1].last], ['Jane', 'Doe']);
});

test('headerless files still parse (phone column found by content)', () => {
  const { contacts } = parseContactRows([
    ['John Smith', '5551234567'],
    ['Jane Doe', '5559876543'],
  ]);
  assert.strictEqual(contacts.length, 2);
  assert.strictEqual(contacts[0].phone, '5551234567');
  assert.strictEqual(contacts[0].first, 'John');
});

test('same phone twice in one file → one contact (last occurrence wins)', () => {
  const { contacts } = parseContactRows([
    ['Name', 'Phone'],
    ['John Smith', '5551234567'],
    ['Johnny Smith', '(555) 123-4567'],
  ]);
  assert.strictEqual(contacts.length, 1);
  assert.strictEqual(contacts[0].first, 'Johnny');
});

test('OVERWRITE RULE: name is overwritten; last_blast, blast_count, magic_token are NEVER touched', () => {
  const db = freshDb();
  upsertCandidates(db, [{ first: 'John', last: 'Smith', phone: '5551234567' }]);
  // Simulate blast history
  db.prepare(`UPDATE candidates SET last_blast = '2026-07-01T00:00:00Z', blast_count = 5 WHERE phone = '5551234567'`).run();
  const before = db.prepare(`SELECT * FROM candidates WHERE phone = '5551234567'`).get();

  // Re-import same number, different name
  const counts = upsertCandidates(db, [{ first: 'Jonathan', last: 'Smythe', phone: '5551234567' }]);
  const after = db.prepare(`SELECT * FROM candidates WHERE phone = '5551234567'`).get();

  assert.strictEqual(counts.updated, 1);
  assert.strictEqual(after.first_name, 'Jonathan');          // overwritten
  assert.strictEqual(after.last_name, 'Smythe');             // overwritten
  assert.strictEqual(after.last_blast, before.last_blast);   // untouched
  assert.strictEqual(after.blast_count, before.blast_count); // untouched
  assert.strictEqual(after.magic_token, before.magic_token); // untouched
  assert.strictEqual(after.do_not_contact, before.do_not_contact); // untouched
});

test('import with an empty name never blanks an existing name', () => {
  const db = freshDb();
  upsertCandidates(db, [{ first: 'John', last: 'Smith', phone: '5551234567' }]);
  upsertCandidates(db, [{ first: '', last: '', phone: '5551234567' }]);
  const row = db.prepare(`SELECT first_name FROM candidates WHERE phone = '5551234567'`).get();
  assert.strictEqual(row.first_name, 'John');
});

test('LAST CONTACTED is ephemeral: selection works in-memory, nothing lands in the DB', () => {
  const db = freshDb();
  const contacts = [
    { first: 'A', last: 'A', phone: '1111111111', lastContacted: new Date('2026-07-01') },
    { first: 'B', last: 'B', phone: '2222222222', lastContacted: new Date('2026-07-15') },
    { first: 'C', last: 'C', phone: '3333333333', lastContacted: new Date('2026-06-01') },
    { first: 'D', last: 'D', phone: '4444444444', lastContacted: null },
  ];
  upsertCandidates(db, contacts);
  const top2 = selectByLastContacted(contacts, 2);
  assert.deepStrictEqual(top2.map((c) => c.phone), ['2222222222', '1111111111']); // newest first
  // No column exists for it — structurally impossible to store
  const cols = db.prepare(`PRAGMA table_info(candidates)`).all().map((c) => c.name.toLowerCase());
  assert.ok(!cols.some((c) => c.includes('contact') && c !== 'do_not_contact'),
    `candidates table must have no last-contacted column, found: ${cols.join(', ')}`);
});

test('new candidates get unique, unguessable magic tokens (not derived from phone)', () => {
  const db = freshDb();
  upsertCandidates(db, [
    { first: 'A', last: 'A', phone: '5551234567' },
    { first: 'B', last: 'B', phone: '5551234568' },
  ]);
  const rows = db.prepare('SELECT phone, magic_token FROM candidates').all();
  assert.notStrictEqual(rows[0].magic_token, rows[1].magic_token);
  for (const r of rows) {
    assert.ok(r.magic_token.length >= 16);
    assert.ok(!r.magic_token.includes(r.phone), 'token must not embed the phone number');
  }
});
