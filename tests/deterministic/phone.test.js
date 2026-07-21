// Phone normalization — every messy format must collapse to ONE canonical
// output, every time. If this breaks, Blast Guard silently fails.
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizePhone, formatPhone, toE164 } = require('../../src/phone');

test('all costumes of the same number normalize identically', () => {
  const variants = [
    '(555) 123-4567', '555-123-4567', '555.123.4567', '5551234567',
    '+1 555 123 4567', '15551234567', '+15551234567', ' 555 123 4567 ',
    '1 (555) 123-4567', '555 123 4567',
  ];
  for (const v of variants) {
    assert.strictEqual(normalizePhone(v), '5551234567', `failed for: "${v}"`);
  }
});

test('numeric (non-string) input normalizes too — Excel cells arrive as numbers', () => {
  assert.strictEqual(normalizePhone(5551234567), '5551234567');
  assert.strictEqual(normalizePhone(15551234567), '5551234567');
});

test('garbage is rejected, never guessed', () => {
  for (const bad of ['', null, undefined, '123', '555-1234', '55512345678901', 'call me maybe', '0551234567', '1551234567']) {
    assert.strictEqual(normalizePhone(bad), null, `should reject: "${bad}"`);
  }
});

test('display and E.164 formats derive from the canonical form', () => {
  assert.strictEqual(formatPhone('5551234567'), '(555) 123-4567');
  assert.strictEqual(toE164('(555) 123-4567'), '+15551234567');
  assert.strictEqual(toE164('nope'), null);
});
