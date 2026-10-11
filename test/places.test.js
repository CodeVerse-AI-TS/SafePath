'use strict';
/**
 * Unit tests for the pure place-ranking helpers used by autocomplete.
 * No network, no database: run with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rankPlaces, textMatch, safetyHint, subsequenceGap, editDistance, haversineM,
} = require('../server/lib/place_rank');

const MYSURU = { lat: 12.3052, lng: 76.6554 };

function place(name, secondary, lat, lng, country_code = 'IN', category = 'place') {
  return { name, secondary, lat, lng, country_code, category, provider: 'test' };
}

test('subsequenceGap accepts dropped letters but rejects unrelated text', () => {
  assert.ok(subsequenceGap('kuvempunagr', 'kuvempunagar', 2) <= 2, 'dropped letter should pass');
  assert.ok(subsequenceGap('maje', 'majestic', 2) <= 2, 'prefix should pass');
  assert.ok(subsequenceGap('zzz', 'majestic', 2) > 2, 'unrelated string should fail');
});

test('transposed letters are still matched (via edit distance, not subsequence)', () => {
  // "majesitc" cannot be found as a subsequence, but is one transposition away.
  assert.ok(subsequenceGap('majesitc', 'majestic', 2) > 2, 'subsequence alone will not catch it');
  assert.equal(editDistance('majesitc', 'majestic'), 2);
  const m = textMatch('majesitc', place('Majestic', 'Bengaluru'));
  assert.ok(m.score > 0, 'but textMatch must still return the place');
  assert.equal(m.start, 0, 'and highlight the shared prefix');
  assert.ok(m.length >= 2);
});

test('editDistance is symmetric and zero for identical strings', () => {
  assert.equal(editDistance('majestic', 'majestic'), 0);
  assert.equal(editDistance('maje', 'majes'), 1);
  assert.equal(editDistance('abc', 'xyz'), 3);
});

test('textMatch scores a prefix highest and highlights it', () => {
  const m = textMatch('Maje', place('Majestic Bus Stand', 'Bengaluru'));
  assert.equal(m.start, 0);
  assert.equal(m.length, 4);
  assert.equal(m.score, 1);
});

test('textMatch highlights a mid-string word boundary', () => {
  const m = textMatch('palace', place('Mysore Palace', 'Mysuru'));
  assert.ok(m.start > 0, 'should find "palace" inside the name');
  assert.equal(m.length, 6);
  assert.ok(m.score >= 0.9 && m.score < 1);
});

test('textMatch tolerates a typo', () => {
  const m = textMatch('majesitc', place('Majestic', 'Bengaluru'));
  assert.ok(m.score > 0, 'a transposition should still match');
  assert.ok(m.score < 1, 'but score below an exact prefix');
});

test('textMatch returns no match for unrelated text', () => {
  const m = textMatch('zzzzzz', place('Majestic', 'Bengaluru'));
  assert.equal(m.score, 0);
});

test('"Maje" ranks the Bengaluru Majestic above an Indonesian Maje when biased to India', () => {
  const candidates = [
    place('Maje', 'Bengkulu, Indonesia', -4.85, 103.41, 'ID'),
    place('Majestic', 'Bengaluru, Karnataka', 12.9767, 77.5713, 'IN'),
    place('Majestic Bus Stand', 'Bengaluru, Karnataka', 12.9770, 77.5720, 'IN'),
  ];
  const ranked = rankPlaces('Maje', candidates, { near: MYSURU, limit: 6 });
  assert.equal(ranked[0].country_code, 'IN', 'India should win: ' + ranked.map((r) => r.name).join(' | '));
  assert.ok(ranked.some((r) => /Majestic/.test(r.name)));
});

test('a nearer place outranks an identical-looking far one', () => {
  const near = place('Majestic', 'Mysuru', 12.31, 76.66, 'IN');
  const far = place('Majestic', 'Delhi', 28.61, 77.20, 'IN');
  const ranked = rankPlaces('Majestic', [far, near], { near: MYSURU, limit: 6 });
  assert.equal(ranked[0].secondary, 'Mysuru');
});

test('a previously chosen place is boosted on a tie', () => {
  const a = place('Kuvempunagar', 'Mysuru', 12.29, 76.63, 'IN');
  const b = place('Kuvempunagar', 'Mysuru', 12.29, 76.63, 'IN'); // identical, different object
  const ranked = rankPlaces('Kuvempu', [a, b], { near: MYSURU, pastFreq: { kuvempunagar: 3 } });
  assert.ok(ranked.length >= 1);
  assert.ok(/used 3×/.test(ranked[0].reason));
});

test('duplicates are collapsed', () => {
  const p = place('Mysore Palace', 'Mysuru', 12.3052, 76.6554, 'IN');
  const ranked = rankPlaces('Mysore Palace', [p, { ...p }, { ...p }], { near: MYSURU });
  assert.equal(ranked.length, 1);
});

test('ranking respects the limit', () => {
  const many = Array.from({ length: 20 }, (_, i) => place('Majestic ' + i, 'Bengaluru', 12.97 + i * 0.001, 77.57, 'IN'));
  const ranked = rankPlaces('Majestic', many, { near: MYSURU, limit: 6 });
  assert.equal(ranked.length, 6);
});

test('distance is reported in metres for each suggestion', () => {
  const ranked = rankPlaces('Mysore Palace', [place('Mysore Palace', 'Mysuru', 12.3052, 76.6554)], { near: MYSURU });
  assert.ok(ranked[0].distance_m != null && ranked[0].distance_m < 50);
});

test('haversineM is about 111 km per degree of latitude', () => {
  const d = haversineM(12, 77, 13, 77);
  assert.ok(d > 110000 && d < 112000, 'got ' + d);
});

test('safetyHint reports "No safety data" outside the covered area', () => {
  assert.equal(safetyHint(null).text, 'No safety data');
  assert.equal(safetyHint({ covered: false, risk: 80 }).text, 'No safety data');
  assert.equal(safetyHint({ covered: false, risk: 80 }).level, 'none');
});

test('safetyHint bands the risk and names the time of day when it matters', () => {
  assert.equal(safetyHint({ covered: true, risk: 12, bucket: 'night' }).text, 'Low risk area at night');
  assert.equal(safetyHint({ covered: true, risk: 12, bucket: 'afternoon' }).text, 'Low risk area');
  assert.equal(safetyHint({ covered: true, risk: 45, bucket: 'evening' }).level, 'medium');
  assert.equal(safetyHint({ covered: true, risk: 72, bucket: 'night' }).level, 'high');
});
