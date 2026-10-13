import test from 'node:test';
import assert from 'node:assert/strict';
import { formatChips, formatAggregate, chipInputValue, parseChipInput, setDisplayUnit, getDisplayUnit } from '../public/money.js';

test('display selection changes units, never the underlying point amount', () => {
  setDisplayUnit('bb');
  assert.equal(formatChips(2000, 10), '200 BB');
  assert.equal(formatChips(5, 10), '0.5 BB');
  assert.equal(formatChips(-25, 10, { signed: true }), '-2.5 BB');
  setDisplayUnit('points');
  assert.equal(formatChips(2000, 10), '2,000 积分');
  assert.equal(getDisplayUnit(), 'points');
});

test('missing historical blind is unknown and mixed blind totals use supplied BB sum', () => {
  assert.equal(formatChips(2000, null, { unit: 'bb' }), '— BB');
  assert.equal(formatAggregate(300, 15, { unit: 'bb', signed: true }), '+15 BB');
  assert.equal(formatAggregate(300, null, { unit: 'bb' }), '— BB');
  assert.equal(formatChips(1, 2000, { unit: 'bb' }), '0.0005 BB');
});

test('integer point bets round-trip through BB inputs without double conversion', () => {
  for (const bb of [2, 3, 5, 10, 50, 2000]) for (const points of [0, 1, 5, 11, 2000, 99999]) {
    assert.equal(parseChipInput(chipInputValue(points, bb, 'bb'), bb, 'bb'), points);
    assert.equal(parseChipInput(chipInputValue(points, bb, 'points'), bb, 'points'), points);
  }
  assert.equal(parseChipInput('2.5', 10, 'bb'), 25);
  assert.equal(parseChipInput('0.25', 10, 'bb'), null);
  for (const invalid of ['', ' ', 'Infinity', 'NaN', '-1']) assert.equal(parseChipInput(invalid, 10, 'bb'), null);
  assert.equal(parseChipInput('1.0000001', 10, 'points'), null);
});

test('custom blinds preserve a large accumulated integer stack through unit switching', () => {
  for (let bb = 2; bb <= 2000; bb++) for (const points of [1, 20, 99999, 1000000, 999999999]) {
    assert.equal(parseChipInput(chipInputValue(points, bb, 'bb'), bb, 'bb'), points);
  }
});
