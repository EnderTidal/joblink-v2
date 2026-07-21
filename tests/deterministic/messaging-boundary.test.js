// The swappable messaging seam: core business logic must never know Whippy
// exists. When Relay arrives, the swap touches src/messaging/ and nothing else.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { openDb, setSetting } = require('../../src/db');
const { getProvider } = require('../../src/messaging');

const CORE_MODULES = ['blast.js', 'blast-guard.js', 'job-orders.js', 'importing.js', 'tom.js', 'candidate-page.js'];

test('STRUCTURAL: no core module imports the Whippy implementation directly', () => {
  for (const file of CORE_MODULES) {
    const src = fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8');
    assert.ok(!src.includes("messaging/whippy"), `${file} must not import whippy directly`);
    assert.ok(!src.includes('whippy.co'), `${file} must not contain Whippy API details`);
  }
});

test('provider selection: unconfigured Whippy falls back to mock (never crashes, never sends)', () => {
  const db = openDb(':memory:');
  setSetting(db, 'sms_provider', 'whippy'); // selected but no credentials
  const p = getProvider(db);
  assert.strictEqual(p.name, 'mock');
  assert.strictEqual(p.reason, 'whippy_not_configured');
});

test('provider selection: fresh install defaults to mock — cannot text real people by accident', () => {
  const db = openDb(':memory:');
  assert.strictEqual(getProvider(db).name, 'mock');
});

test('configured Whippy returns the real provider with the interface contract', () => {
  const db = openDb(':memory:');
  setSetting(db, 'sms_provider', 'whippy');
  setSetting(db, 'whippy_api_key', 'key');
  setSetting(db, 'whippy_channel_id', 'chan');
  setSetting(db, 'whippy_from_number', '+15550000000');
  const p = getProvider(db);
  assert.strictEqual(p.name, 'whippy');
  for (const fn of ['sendSms', 'testConnection', 'closeOpenConversations']) {
    assert.strictEqual(typeof p[fn], 'function', `provider must implement ${fn}`);
  }
});
