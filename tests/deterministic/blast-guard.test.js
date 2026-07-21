// Blast Guard — a rule that must NEVER be silently broken. Exact-match tests
// with a fixed clock: no flakiness, no interpretation.
const { test } = require('node:test');
const assert = require('node:assert');
const { checkBlastGuard, applyBlastGuard } = require('../../src/blast-guard');

const NOW = new Date('2026-07-21T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 36e5).toISOString();

test('never-blasted candidate is allowed', () => {
  assert.deepStrictEqual(checkBlastGuard({ last_blast: null, do_not_contact: 0 }, NOW), { allowed: true, reason: 'ok' });
});

test('"3 days" means exactly 72 hours — boundary behavior is precise', () => {
  // 71h59m ago → still blocked
  const justInside = { last_blast: new Date(NOW.getTime() - (72 * 36e5 - 60e3)).toISOString(), do_not_contact: 0 };
  assert.strictEqual(checkBlastGuard(justInside, NOW).allowed, false);
  // exactly 72h ago → allowed
  const exactly = { last_blast: hoursAgo(72), do_not_contact: 0 };
  assert.strictEqual(checkBlastGuard(exactly, NOW).allowed, true);
  // 1 hour ago → blocked
  assert.deepStrictEqual(checkBlastGuard({ last_blast: hoursAgo(1), do_not_contact: 0 }, NOW),
    { allowed: false, reason: 'cooldown' });
});

test('cooldown window is configurable', () => {
  const c = { last_blast: hoursAgo(30), do_not_contact: 0 };
  assert.strictEqual(checkBlastGuard(c, NOW, 24).allowed, true);   // 24h window: 30h ago is fine
  assert.strictEqual(checkBlastGuard(c, NOW, 48).allowed, false);  // 48h window: still cooling
});

test('do_not_contact is an infinite cooldown — nothing overrides it', () => {
  const c = { last_blast: hoursAgo(10000), do_not_contact: 1 };
  assert.deepStrictEqual(checkBlastGuard(c, NOW), { allowed: false, reason: 'do_not_contact' });
  assert.strictEqual(checkBlastGuard({ last_blast: null, do_not_contact: 1 }, NOW).allowed, false);
});

test('guard is global — the reason a candidate is cooling does not mention category', () => {
  // (structural: checkBlastGuard has no category parameter at all)
  assert.strictEqual(checkBlastGuard.length <= 3, true);
});

test('applyBlastGuard partitions a list with exact counts', () => {
  const list = [
    { phone: '1111111111', last_blast: null, do_not_contact: 0 },            // sendable
    { phone: '2222222222', last_blast: hoursAgo(2), do_not_contact: 0 },     // cooldown
    { phone: '3333333333', last_blast: hoursAgo(100), do_not_contact: 0 },   // sendable
    { phone: '4444444444', last_blast: null, do_not_contact: 1 },            // dnc
  ];
  const { sendable, skipped } = applyBlastGuard(list, NOW);
  assert.deepStrictEqual(sendable.map((c) => c.phone), ['1111111111', '3333333333']);
  assert.deepStrictEqual(skipped.map((c) => [c.phone, c.skip_reason]),
    [['2222222222', 'cooldown'], ['4444444444', 'do_not_contact']]);
});
