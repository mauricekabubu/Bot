import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../tools/calculator.js';

test('calculator supports precedence, parentheses, decimals, and unary minus', () => {
  const cases = [
    ['2 + 3 * 4', 14],
    ['(2 + 3) * 4', 20],
    ['-2 * 3', -6],
    ['2 * -3', -6],
    ['1 - -2', 3],
    ['-(2.5 + .5) / 3', -1],
    ['8 / 4 / 2', 1],
  ];
  for (const [expression, expected] of cases) {
    assert.equal(calculate(expression).result, expected, expression);
  }
});

test('calculator rejects malformed, unsafe, oversized, and unreasonable expressions', () => {
  for (const expression of [
    '1/0',
    '1 / (2 - 2)',
    '2 ** 3',
    'process.exit()',
    '1 + * 2',
    '1 2',
    '1..2',
    '1e999',
    '999999999999999 * 2',
    '1'.repeat(121),
  ]) {
    assert.throws(() => calculate(expression), undefined, expression);
  }
  assert.throws(() => calculate(null));
});
