// The name-splitting parser edge case (PROJECT_BRIEF §12) — exact-match tests.
const { test } = require('node:test');
const assert = require('node:assert');
const { splitName } = require('../../src/names');

test('splits "First Last"', () => {
  assert.deepStrictEqual(splitName('John Smith'), { first: 'John', last: 'Smith' });
});

test('handles Q4\'s "Last, First" convention', () => {
  assert.deepStrictEqual(splitName('Smith, John'), { first: 'John', last: 'Smith' });
  assert.deepStrictEqual(splitName('  Van Der Berg ,  Mary '), { first: 'Mary', last: 'Van Der Berg' });
});

test('multi-part names: first token is first name, rest is last name', () => {
  assert.deepStrictEqual(splitName('Mary Jo Watson'), { first: 'Mary', last: 'Jo Watson' });
});

test('single name and empty input degrade gracefully', () => {
  assert.deepStrictEqual(splitName('Cher'), { first: 'Cher', last: '' });
  assert.deepStrictEqual(splitName(''), { first: '', last: '' });
  assert.deepStrictEqual(splitName('   '), { first: '', last: '' });
});

test('collapses extra whitespace', () => {
  assert.deepStrictEqual(splitName('  John    Smith  '), { first: 'John', last: 'Smith' });
});
