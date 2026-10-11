/* Unit tests for the pure navigation maths (public/nav_math.js).
   These cover the parts the navigation screen depends on: snapping to the line,
   rejecting noisy fixes, smoothing, step progress and hazard look-ahead. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const M = require('../public/nav_math.js');

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* A short straight east-west line near Mysuru, ~1.11 km per 0.01 deg lng. */
const LINE = [
  [12.3052, 76.6554],
  [12.3052, 76.6654],
  [12.3052, 76.6754],
];

test('haversineM measures a known distance', () => {
  // 0.01 deg of latitude is ~1112 m anywhere.
  const d = M.haversineM(12.0, 76.0, 12.01, 76.0);
  assert.ok(near(d, 1112, 5), 'expected ~1112 m, got ' + d);
});

test('bearingDeg points the right way', () => {
  assert.ok(near(M.bearingDeg(12.0, 76.0, 12.01, 76.0), 0, 1), 'due north');
  assert.ok(near(M.bearingDeg(12.0, 76.0, 12.0, 76.01), 90, 1), 'due east');
  assert.ok(near(M.bearingDeg(12.0, 76.0, 11.99, 76.0), 180, 1), 'due south');
});

test('angleDelta takes the short way round', () => {
  assert.strictEqual(M.angleDelta(350, 10), 20);
  assert.strictEqual(M.angleDelta(10, 350), -20);
  assert.strictEqual(M.angleDelta(0, 90), 90);
});

test('lerpAngle interpolates across the 0/360 seam', () => {
  // Halfway from 350 to 10 is 0, not 180.
  assert.ok(near(M.lerpAngle(350, 10, 0.5), 0, 0.01));
});

test('cardinal maps bearings to compass points', () => {
  assert.strictEqual(M.cardinal(0), 'N');
  assert.strictEqual(M.cardinal(45), 'NE');
  assert.strictEqual(M.cardinal(180), 'S');
  assert.strictEqual(M.cardinal(359), 'N');
});

test('pointToSegment finds the perpendicular foot', () => {
  // A point 0.001 deg north of the middle of the first segment.
  const seg = M.pointToSegment([12.3062, 76.6604], LINE[0], LINE[1]);
  assert.ok(near(seg.distance_m, 111, 5), 'expected ~111 m, got ' + seg.distance_m);
  assert.ok(near(seg.t, 0.5, 0.02), 'foot should be mid-segment');
});

test('snapToLine snaps a nearby point onto the line', () => {
  const p = [12.3053, 76.6604]; // ~11 m north of the line
  const snap = M.snapToLine(p, LINE);
  assert.ok(snap, 'should snap');
  assert.ok(snap.offset_m < 15, 'offset should be small, got ' + snap.offset_m);
  assert.ok(near(snap.lat, 12.3052, 1e-4), 'snapped latitude should be on the line');
});

test('snapToLine reports a large offset when the point is far away', () => {
  const snap = M.snapToLine([12.32, 76.66], LINE); // ~1.6 km north
  assert.ok(snap.offset_m > 1000, 'expected a big offset, got ' + snap.offset_m);
});

test('snapToLine respects fromIndex so it does not jump to a far leg', () => {
  // A route that goes out and comes back close to itself.
  const out = [
    [12.3052, 76.6554],
    [12.3052, 76.6754],
    [12.3152, 76.6754],
    [12.3152, 76.6554], // return leg, ~1.1 km north of the outbound leg
  ];
  const onReturn = [12.3153, 76.6650];
  const early = M.snapToLine(onReturn, out, { fromIndex: 0, lookahead: 1 });
  assert.ok(early.index <= 1, 'a short window must stay on the outbound leg, got index ' + early.index);
});

test('cumulativeDistances and alongRoute agree', () => {
  const cum = M.cumulativeDistances(LINE);
  assert.strictEqual(cum[0], 0);
  // 0.02 deg of longitude at this latitude is ~2.17 km.
  const total = cum[cum.length - 1];
  assert.ok(near(total, 2172, 25), 'total ~2.17 km, got ' + total);
  // The vertex in the middle of the line is exactly halfway along it.
  const snap = M.snapToLine([12.3052, 76.6654], LINE);
  const along = M.alongRoute(snap, LINE, cum);
  assert.ok(near(along, total / 2, 25), 'halfway along the line, got ' + along);
});

test('acceptFix rejects a low-accuracy fix', () => {
  const v = M.acceptFix({ lat: 12.3, lng: 76.6, accuracy: 250, at: Date.now() }, null, { maxAccuracyM: 100 });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'low_accuracy');
});

test('acceptFix rejects an impossible jump', () => {
  const t0 = Date.now();
  const prev = { lat: 12.3052, lng: 76.6554, at: t0 };
  // 1 km in one second is a teleport, not walking.
  const v = M.acceptFix({ lat: 12.3142, lng: 76.6554, accuracy: 10, at: t0 + 1000 }, prev, { maxSpeedMps: 12 });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'jump');
});

test('acceptFix accepts a normal walking fix', () => {
  const t0 = Date.now();
  const prev = { lat: 12.3052, lng: 76.6554, at: t0 };
  // ~1.4 m in one second.
  const v = M.acceptFix({ lat: 12.30521, lng: 76.6554, accuracy: 8, at: t0 + 1000 }, prev, { maxSpeedMps: 12 });
  assert.strictEqual(v.ok, true);
});

test('acceptFix rejects malformed input', () => {
  assert.strictEqual(M.acceptFix({ lat: NaN, lng: 76.6, at: Date.now() }, null).ok, false);
  assert.strictEqual(M.acceptFix(null, null).ok, false);
});

test('smoothPosition eases toward the new fix without jumping', () => {
  const prev = { lat: 12.3052, lng: 76.6554 };
  const next = { lat: 12.3152, lng: 76.6554, accuracy: 10 };
  const out = M.smoothPosition(prev, next, { t: 0.3 });
  assert.ok(out.lat > prev.lat && out.lat < next.lat, 'should land between the two');
  // A precise fix (accuracy 10) is trusted a little more than the base step, so
  // the result is at least t of the way and never past the fix itself.
  assert.ok(out.lat >= prev.lat + (next.lat - prev.lat) * 0.3 - 1e-9, 'at least t of the way');
  assert.ok(out.lat < next.lat, 'never overshoots the fix');
});

test('smoothPosition moves further for a precise fix than a vague one', () => {
  const prev = { lat: 12.3052, lng: 76.6554 };
  const target = { lat: 12.3152, lng: 76.6554 };
  const sharp = M.smoothPosition(prev, { ...target, accuracy: 5 }, { t: 0.3 });
  const vague = M.smoothPosition(prev, { ...target, accuracy: 95 }, { t: 0.3 });
  assert.ok(sharp.lat > vague.lat, 'a precise fix should be followed more closely');
});

test('smoothPosition returns the fix itself when there is no previous position', () => {
  const out = M.smoothPosition(null, { lat: 12.3, lng: 76.6 });
  assert.deepStrictEqual(out, { lat: 12.3, lng: 76.6 });
});

test('stepProgress picks the current step and counts down to the next', () => {
  const steps = [
    { along_m: 0, text: 'Head north' },
    { along_m: 200, text: 'Turn right' },
    { along_m: 500, text: 'Arrive' },
  ];
  const p0 = M.stepProgress(steps, 50);
  assert.strictEqual(p0.index, 0);
  assert.strictEqual(p0.current.text, 'Head north');
  assert.strictEqual(p0.next.text, 'Turn right');
  assert.strictEqual(p0.distanceToNext_m, 150);

  const p1 = M.stepProgress(steps, 210);
  assert.strictEqual(p1.index, 1);
  assert.strictEqual(p1.distanceToNext_m, 290);
});

test('stepProgress handles the final step', () => {
  const steps = [{ along_m: 0 }, { along_m: 100 }];
  const p = M.stepProgress(steps, 150);
  assert.strictEqual(p.index, 1);
  assert.strictEqual(p.next, null);
  assert.strictEqual(p.distanceToNext_m, 0);
});

test('nextHazard only returns hazards inside the look-ahead window', () => {
  const hazards = [
    { along_m: 100, kind: 'hotspot', label: 'A', risk: 70 },
    { along_m: 900, kind: 'unlit', label: 'B', risk: 40 },
  ];
  const h = M.nextHazard(hazards, 0, { lookaheadM: 400 });
  assert.ok(h, 'should find one');
  assert.strictEqual(h.label, 'A');
  assert.strictEqual(h.ahead_m, 100);
});

test('nextHazard ignores hazards already passed and dismissed ones', () => {
  const hazards = [{ along_m: 100, label: 'A' }, { along_m: 300, label: 'B' }];
  assert.strictEqual(M.nextHazard(hazards, 200, { lookaheadM: 400 }).label, 'B');
  assert.strictEqual(M.nextHazard(hazards, 200, { lookaheadM: 400, skipBefore: 300 }), null);
});

test('formatDistance reads naturally', () => {
  assert.strictEqual(M.formatDistance(5), 'now');
  assert.strictEqual(M.formatDistance(123), '125 m');
  assert.strictEqual(M.formatDistance(1400), '1.4 km');
});

test('spokenInstruction prefixes the distance when there is one', () => {
  assert.strictEqual(M.spokenInstruction({ text: 'Turn left' }, 120), 'In 120 m, Turn left');
  assert.strictEqual(M.spokenInstruction({ text: 'Turn left' }, 5), 'Turn left');
});
