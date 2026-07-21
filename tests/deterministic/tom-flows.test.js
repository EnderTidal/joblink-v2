// Tom's deterministic paths, end-to-end at the state-machine level:
// the category gate can't be skipped, the send gate is a BUTTON (typed "yes"
// rejected), and the job-order path publishes exactly what was confirmed.
const { test } = require('node:test');
const assert = require('node:assert');
const { openDb, setSetting } = require('../../src/db');
const { createTom, BLAST_CONFIRM_REJECTION, parseFieldEdit, parseManualContacts } = require('../../src/tom');

function freshTom() {
  const db = openDb(':memory:');
  setSetting(db, 'sms_provider', 'mock');
  return { db, tom: createTom(db) };
}

const JOB_TEXT = `Title: Forklift Operator
Category: Industrial
Pay: $18/hr
Shift: 1st shift, 6am-2:30pm
Location: Waxahachie, TX
Requirements: 6 months forklift experience
Description: Move palletized goods in a warehouse.`;

test('job order path: type → parse → edit → publish', async () => {
  const { db, tom } = freshTom();
  const s = await tom.start('job_order', 'josh');
  const r1 = await tom.message(s.sessionId, { text: JOB_TEXT });
  assert.strictEqual(r1.state, 'review');
  assert.strictEqual(r1.draft.title, 'Forklift Operator');
  assert.strictEqual(r1.draft.category, 'Industrial');

  const r2 = await tom.message(s.sessionId, { text: 'set pay to $18.50/hr' });
  assert.strictEqual(r2.draft.pay, '$18.50/hr');

  const r3 = await tom.message(s.sessionId, { action: 'edit_field', payload: { field: 'location', value: 'Ennis, TX' } });
  assert.strictEqual(r3.draft.location, 'Ennis, TX');

  const r4 = await tom.message(s.sessionId, { text: 'yes, publish' });
  assert.match(r4.text, /Published job order #\d+/);
  const jo = db.prepare('SELECT * FROM job_orders').get();
  assert.strictEqual(jo.status, 'Published');
  assert.strictEqual(jo.pay, '$18.50/hr');
  assert.strictEqual(jo.location, 'Ennis, TX');
});

test('job order path: "done" saves unpublished (draft stays a draft)', async () => {
  const { db, tom } = freshTom();
  const s = await tom.start('job_order');
  await tom.message(s.sessionId, { text: JOB_TEXT });
  const r = await tom.message(s.sessionId, { text: 'done with job order' });
  assert.match(r.text, /Saved job order/);
  assert.strictEqual(db.prepare('SELECT status FROM job_orders').get().status, 'Unpublished');
});

test('blast path: category gate cannot be skipped or assumed', async () => {
  const { tom } = freshTom();
  const s = await tom.start('blast', 'josh');
  const r1 = await tom.message(s.sessionId, { text: 'John Smith 555-123-4567\nJane Doe 555-987-6543' });
  assert.strictEqual(r1.state, 'await_category');
  // Try to bulldoze past it with free text
  const r2 = await tom.message(s.sessionId, { text: 'just send it to everyone' });
  assert.strictEqual(r2.state, 'await_category', 'category gate must hold');
  assert.match(r2.text, /category/i);
});

test('blast path: typed "yes" NEVER sends — only the button action does', async () => {
  const { db, tom } = freshTom();
  const s = await tom.start('blast', 'josh');
  await tom.message(s.sessionId, { text: 'John Smith 555-123-4567' });
  const preview = await tom.message(s.sessionId, { action: 'choose_category', payload: { category: 'Industrial' } });
  assert.strictEqual(preview.state, 'preview');
  assert.ok(preview.confirmButton, 'preview must offer the send button');

  for (const attempt of ['yes', 'YES send it', 'confirm', 'go', 'do it now']) {
    const r = await tom.message(s.sessionId, { text: attempt });
    assert.strictEqual(r.text.includes(BLAST_CONFIRM_REJECTION.slice(0, 30)), true, `typed "${attempt}" must be rejected`);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM blasts').get().n, 0, 'no blast may exist yet');
  }

  const sent = await tom.message(s.sessionId, { action: 'confirm_send' });
  assert.match(sent.text, /Blast #\d+ complete: 1 sent/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM blasts').get().n, 1);
});

test('blast path: preview shows guard results BEFORE sending', async () => {
  const { db, tom } = freshTom();
  // Prior blast 1h ago puts Jane in cooldown
  db.prepare(`INSERT INTO candidates (phone, first_name, magic_token, last_blast) VALUES ('5559876543','Jane','tokjane', ?)`)
    .run(new Date(Date.now() - 36e5).toISOString());
  const s = await tom.start('blast', 'josh');
  await tom.message(s.sessionId, { text: 'John Smith 555-123-4567\nJane Doe 555-987-6543' });
  const preview = await tom.message(s.sessionId, { action: 'choose_category', payload: { category: 'Industrial' } });
  assert.match(preview.text, /1 will be sent/);
  assert.match(preview.text, /1 skipped \(cooldown\)/);
});

test('blast path: Last Contacted subset prompt appears only when dates exist', async () => {
  const { tom } = freshTom();
  const s = await tom.start('blast');
  const rows = 'Name,Phone,Last Contacted\nJohn Smith,5551234567,2026-07-01\nJane Doe,5559876543,2026-07-15';
  const { parseContactRows } = require('../../src/importing');
  // simulate file upload by feeding parsed rows through the manual path is not possible;
  // use the file route shape instead:
  const parsed = parseContactRows(rows.split('\n').map((l) => l.split(',')));
  assert.ok(parsed.contacts.every((c) => c.lastContacted instanceof Date));
  const r = await tom.message(s.sessionId, { file: { buffer: Buffer.from(rows), originalname: 'list.csv' } });
  assert.strictEqual(r.state, 'await_subset');
  const r2 = await tom.message(s.sessionId, { text: '1' });
  assert.strictEqual(r2.state, 'await_category');
  assert.match(r2.text, /Selected 1 contacts/);
});

test('review path: reports blasts with counts', async () => {
  const { db, tom } = freshTom();
  const empty = await tom.start('review');
  assert.match(empty.text, /No magic blasts yet/);
  db.prepare(`INSERT INTO blasts (category, sent_count, skipped_cooldown_count) VALUES ('Industrial', 287, 13)`).run();
  const r = await tom.start('review');
  assert.match(r.text, /287 sent/);
  assert.match(r.text, /13 skipped \(cooldown\)/);
});

test('field-edit parser handles the common phrasings', () => {
  assert.deepStrictEqual(parseFieldEdit('set pay to $18.50'), { field: 'pay', value: '$18.50' });
  assert.deepStrictEqual(parseFieldEdit('pay: $19'), { field: 'pay', value: '$19' });
  assert.deepStrictEqual(parseFieldEdit('location should be Ennis TX'), { field: 'location', value: 'Ennis TX' });
  assert.deepStrictEqual(parseFieldEdit('change title to Welder II'), { field: 'title', value: 'Welder II' });
  assert.strictEqual(parseFieldEdit('publish it'), null);
});

test('manual contact entry parses "Name phone" lines', () => {
  const { contacts, invalid } = parseManualContacts('John Smith 555-123-4567\nDoe, Jane, (555) 987-6543\nnonsense line');
  assert.strictEqual(contacts.length, 2);
  assert.deepStrictEqual([contacts[0].first, contacts[0].last, contacts[0].phone], ['John', 'Smith', '5551234567']);
  assert.deepStrictEqual([contacts[1].first, contacts[1].last, contacts[1].phone], ['Jane', 'Doe', '5559876543']);
  assert.strictEqual(invalid.length, 1);
});

test('one path per conversation: a job_order session refuses after ending', async () => {
  const { tom } = freshTom();
  const s = await tom.start('job_order');
  await tom.message(s.sessionId, { text: JOB_TEXT });
  await tom.message(s.sessionId, { text: 'done' });
  await tom.message(s.sessionId, { text: 'no' }); // ends session
  const r = await tom.message(s.sessionId, { text: 'send a blast to everyone' });
  assert.match(r.text, /ended|new one/i);
});
