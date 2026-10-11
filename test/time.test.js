'use strict';
/**
 * Unit tests for time resolution (server/lib/time.js).
 *
 *   npm test
 *
 * These exist because a request for `time=night` used to be answered with the
 * current time whenever the value was not an ISO string: the old parser tried
 * `new Date(value)`, got Invalid Date, and fell back to `new Date()`. The
 * acceptance suite never caught it because it always sent a full ISO timestamp.
 *
 * The rule these tests lock in: a time is either resolved to the time the caller
 * asked for, or refused. It is never silently swapped for a different one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTime, BUCKET_HOURS } = require('../server/lib/time');

test('each time-of-day bucket resolves to its own hour', () => {
  const hours = Object.entries(BUCKET_HOURS).map(([name, hour]) => {
    const { date, error } = resolveTime(name);
    assert.ok(!error, `${name} should resolve, got: ${error}`);
    assert.equal(date.getHours(), hour, `${name} should be ${hour}:00`);
    return hour;
  });
  // Distinct hours, or the multiplier would not change with the bucket.
  assert.equal(new Set(hours).size, hours.length, 'buckets must map to distinct hours');
});

test('bucket names are case-insensitive and trimmed', () => {
  const a = resolveTime('NIGHT');
  const b = resolveTime('  night  ');
  assert.ok(!a.error && !b.error);
  assert.equal(a.date.getHours(), b.date.getHours());
  assert.equal(a.date.getHours(), BUCKET_HOURS.night);
});

test('an omitted or "now" time resolves to about the current time', () => {
  for (const v of [undefined, null, '', 'now']) {
    const { date, error } = resolveTime(v);
    assert.ok(!error, `${JSON.stringify(v)} should resolve`);
    assert.ok(Math.abs(Date.now() - date.getTime()) < 5000, 'should be the present');
  }
});

test('an ISO timestamp is honoured exactly', () => {
  const { date, error } = resolveTime('2026-10-28T23:00:00');
  assert.ok(!error);
  assert.equal(date.getHours(), 23, 'must not be shifted to another hour');
  assert.equal(date.getFullYear(), 2026);
});

test('unparseable input is refused rather than replaced with the current time', () => {
  for (const bad of ['notatime', 'midnight', '25:99', 'noon', 'yesterday', '   ']) {
    const { error, date } = resolveTime(bad);
    if (bad.trim() === '') continue; // empty means "now" by design
    assert.ok(error, `${JSON.stringify(bad)} must be refused, not resolved`);
    assert.equal(date, undefined, 'no date should be returned alongside an error');
  }
});

test('a bare date is refused because it has no time of day', () => {
  const { error } = resolveTime('2026-10-28');
  assert.ok(error, 'a date without a time should be refused');
  assert.match(error, /time of day/i);
});

test('the refusal message tells the caller what to send instead', () => {
  const { error } = resolveTime('notatime');
  assert.match(error, /now/);
  for (const name of Object.keys(BUCKET_HOURS)) assert.match(error, new RegExp(name));
  assert.match(error, /ISO 8601/);
});

test('the field name appears in the error so the caller knows which input is wrong', () => {
  const { error } = resolveTime('nope', { field: 'departure' });
  assert.match(error, /^departure/);
});
