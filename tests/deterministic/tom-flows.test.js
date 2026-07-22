// Tom's deterministic paths, end-to-end at the state-machine level:
// the category gate can't be skipped, the send gate is a BUTTON (typed "yes"
// rejected), and the job-order path publishes exactly what was confirmed.
//
// V2.2: blast path overhauled to form-based flow — contacts parsed -> blast_form state
// -> preview_blast action submits all settings at once -> preview -> confirm_send.
const { test } = require('node:test');
const assert = require('node:assert');
const { openDb, setSetting } = require('../../src/db');
const { createTom, BLAST_CONFIRM_REJECTION, parseFieldEdit, parseManualContacts, sortContacts } = require('../../src/tom');

function freshTom() {
  const db = openDb(':memory:');
  setSetting(db, 'sms_provider', 'mock');
  return { db, tom: createTom(db) };
}

const JOB_TEXT = `Title: Forklift Operator
Category: Industrial
Pay: $18/hr
Shift: 1st shift, 6am-2:30pm
Address: 123 Warehouse Dr, Waxahachie, TX 75165
City/State: Waxahachie, TX
Requirements: 6 months forklift experience
Description: Move palletized goods in a warehouse.`;

test('job order path: type \u2192 parse \u2192 edit \u2192 publish', async () => {
  const { db, tom } = freshTom();
  const s = await tom.start('job_order', 'josh');
  const r1 = await tom.message(s.sessionId, { text: JOB_TEXT });
  assert.strictEqual(r1.state, 'review');
  assert.strictEqual(r1.draft.title, 'Forklift Operator');
  assert.strictEqual(r1.draft.category, 'Industrial');

  const r2 = await tom.message(s.sessionId, { text: 'set pay to $18.50/hr' });
  assert.strictEqual(r2.draft.pay, '$18.50/hr');

  const r3 = await tom.message(s.sessionId, { action: 'edit_field', payload: { field: 'city_state', value: 'Ennis, TX' } });
  assert.strictEqual(r3.draft.city_state, 'Ennis, TX');

  const r4 = await tom.message(s.sessionId, { text: 'yes, publish' });
  assert.match(r4.text, /Published job order #\d+/);
  const jo = db.prepare('SELECT * FROM job_orders').get();
  assert.strictEqual(jo.status, 'Published');
  assert.strictEqual(jo.pay, '$18.50/hr');
  assert.strictEqual(jo.city_state, 'Ennis, TX');
});

test('job order path: "done" saves unpublished (draft stays a draft)', async () => {
  const { db, tom } = freshTom();
  const s = await tom.start('job_order');
  await tom.message(s.sessionId, { text: JOB_TEXT });
  const r = await tom.message(s.sessionId, { text: 'done with job order' });
  assert.match(r.text, /Saved job order/);
  assert.strictEqual(db.prepare('SELECT status FROM job_orders').get().status, 'Unpublished');
});

test('blast path: contacts parsed \u2192 blast_form state with form data', async () => {
  const { tom } = freshTom();
  const s = await tom.start('blast', 'josh');
  const r1 = await tom.message(s.sessionId, { text: 'John Smith 555-123-4567\nJane Doe 555-987-6543' });
  assert.strictEqual(r1.state, 'blast_form');
  assert.ok(r1.showBlastForm, 'should return showBlastForm flag');
  assert.strictEqual(r1.contactCount, 2);
  assert.ok(r1.categories, 'should include categories');
  assert.ok(r1.templates, 'should include templates');
});

test('blast path: preview_blast requires category', async () => {
  const { tom } = freshTom();
  const s = await tom.start('blast', 'josh');
  await tom.message(s.sessionId, { text: 'John Smith 555-123-4567' });
  const r = await tom.message(s.sessionId, {
    action: 'preview_blast',
    payload: { recipientMode: 'all', sortBy: 'most_recent', category: null, templateBody: 'Hi {first_name} {link}' },
  });
  assert.ok(r.showBlastForm, 'should stay on form');
  assert.ok(r.keepForm, 'keepForm should be true');
  assert.match(r.text, /category/i);
});

test('blast path: typed "yes" NEVER sends \u2014 only the button action does', async () => {
  const { db, tom } = freshTom();
  const s = await tom.start('blast', 'josh');
  await tom.message(s.sessionId, { text: 'John Smith 555-123-4567' });
  // Submit form with all settings via preview_blast action
  const preview = await tom.message(s.sessionId, {
    action: 'preview_blast',
    payload: {
      recipientMode: 'all',
      sortBy: 'most_recent',
      category: 'Industrial',
      templateBody: 'Hi {first_name} check {link}',
    },
  });
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
  const preview = await tom.message(s.sessionId, {
    action: 'preview_blast',
    payload: {
      recipientMode: 'all',
      sortBy: 'most_recent',
      category: 'Industrial',
      templateBody: 'Hi {first_name} check {link}',
    },
  });
  assert.match(preview.text, /1 will be sent/);
  assert.match(preview.text, /1 skipped \(cooldown\)/);
});

test('blast path: recipient limit via form (top N)', async () => {
  const { tom } = freshTom();
  const s = await tom.start('blast', 'josh');
  await tom.message(s.sessionId, { text: 'John Smith 555-123-4567\nJane Doe 555-987-6543\nBob Lee 555-111-2222' });
  const preview = await tom.message(s.sessionId, {
    action: 'preview_blast',
    payload: {
      recipientMode: 'top',
      recipientCount: '2',
      sortBy: 'alpha_az',
      category: 'Industrial',
      templateBody: 'Hi {first_name} check {link}',
    },
  });
  assert.strictEqual(preview.state, 'preview');
  assert.match(preview.text, /2 will be sent/);
});

test('blast path: Last Contacted subset via form sort', async () => {
  const { tom } = freshTom();
  const s = await tom.start('blast');
  const rows = 'Name,Phone,Last Contacted\nJohn Smith,5551234567,2026-07-01\nJane Doe,5559876543,2026-07-15';
  const r = await tom.message(s.sessionId, { file: { buffer: Buffer.from(rows), originalname: 'list.csv' } });
  assert.strictEqual(r.state, 'blast_form');
  assert.ok(r.hasLastContacted, 'should detect Last Contacted dates');
  assert.ok(r.sortOptions, 'should include sort options');
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
  assert.deepStrictEqual(parseFieldEdit('location should be Ennis TX'), { field: 'city_state', value: 'Ennis TX' });
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

test('sortContacts sorts alphabetically A-Z by last name', () => {
  const contacts = [
    { first: 'Charlie', last: 'Zulu', phone: '1' },
    { first: 'Alice', last: 'Alpha', phone: '2' },
    { first: 'Bob', last: 'Mike', phone: '3' },
  ];
  const sorted = sortContacts(contacts, 'alpha_az');
  assert.strictEqual(sorted[0].last, 'Alpha');
  assert.strictEqual(sorted[1].last, 'Mike');
  assert.strictEqual(sorted[2].last, 'Zulu');
});

test('sortContacts sorts alphabetically Z-A by last name', () => {
  const contacts = [
    { first: 'Alice', last: 'Alpha', phone: '1' },
    { first: 'Bob', last: 'Zulu', phone: '2' },
  ];
  const sorted = sortContacts(contacts, 'alpha_za');
  assert.strictEqual(sorted[0].last, 'Zulu');
  assert.strictEqual(sorted[1].last, 'Alpha');
});
