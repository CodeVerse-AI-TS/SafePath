/* Unit tests for the turn-by-turn instruction builder (server/lib/nav_steps.js).
   The builder turns raw OSRM manoeuvres into the shape the navigation screen
   reads, so these check both the wording and the positions along the route. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildSteps, iconFor, textFor, ordinalSuffix, cleanStreet } = require('../server/lib/nav_steps');

/* A short east-west line, ~556 m per 0.005 deg of longitude at this latitude. */
const A = [12.3052, 76.6554];
const B = [12.3052, 76.6604];
const C = [12.3052, 76.6654];
const COORDS = [A, B, C];

function step({ type, modifier, location, name, exit, bearing_after, bearing_before }) {
  return {
    name: name || '',
    distance: 0,
    maneuver: {
      type, modifier, exit,
      location: [location[1], location[0]], // OSRM gives [lng, lat]
      bearing_after, bearing_before,
    },
  };
}

function route(steps) {
  return { coords: COORDS, legs: [{ steps }] };
}

test('buildSteps returns [] when the upstream route has no legs', () => {
  assert.deepStrictEqual(buildSteps({ coords: COORDS }), []);
  assert.deepStrictEqual(buildSteps(null), []);
});

test('buildSteps positions each manoeuvre along the route', () => {
  const steps = buildSteps(route([
    step({ type: 'depart', location: A, bearing_after: 90 }),
    step({ type: 'turn', modifier: 'right', location: B, name: 'Ramanuja Road' }),
    step({ type: 'arrive', location: C }),
  ]));
  assert.strictEqual(steps.length, 3);
  assert.strictEqual(steps[0].along_m, 0);
  assert.ok(Math.abs(steps[1].along_m - 556) < 20, 'middle step at ~556 m, got ' + steps[1].along_m);
  assert.ok(Math.abs(steps[2].along_m - 1112) < 30, 'final step at ~1112 m, got ' + steps[2].along_m);
});

test('buildSteps measures each step length from the geometry', () => {
  const steps = buildSteps(route([
    step({ type: 'depart', location: A }),
    step({ type: 'turn', modifier: 'right', location: B }),
    step({ type: 'arrive', location: C }),
  ]));
  assert.ok(Math.abs(steps[0].distance_m - 556) < 20, 'first step ~556 m, got ' + steps[0].distance_m);
  assert.ok(Math.abs(steps[1].distance_m - 556) < 20, 'second step ~556 m, got ' + steps[1].distance_m);
});

test('buildSteps keeps steps in order and drops any that go backwards', () => {
  const steps = buildSteps(route([
    step({ type: 'depart', location: A }),
    step({ type: 'turn', modifier: 'left', location: B }),
    // A bogus manoeuvre that claims to be before the previous one.
    step({ type: 'turn', modifier: 'right', location: A }),
    step({ type: 'arrive', location: C }),
  ]));
  const alongs = steps.map((s) => s.along_m);
  assert.deepStrictEqual(alongs, [...alongs].sort((a, b) => a - b), 'must be non-decreasing');
  assert.strictEqual(steps.length, 3, 'the out-of-order step is dropped');
});

test('buildSteps carries the street name and drops a trailing locality', () => {
  const steps = buildSteps(route([
    step({ type: 'depart', location: A }),
    step({ type: 'turn', modifier: 'left', location: B, name: 'Sayyaji Rao Road (Mysuru)' }),
    step({ type: 'arrive', location: C }),
  ]));
  assert.strictEqual(steps[1].street, 'Sayyaji Rao Road');
});

test('textFor describes a turn onto a named road', () => {
  assert.strictEqual(
    textFor({ type: 'turn', modifier: 'left' }, 'MG Road'),
    'Turn left onto MG Road'
  );
  assert.strictEqual(textFor({ type: 'turn', modifier: 'right' }, null), 'Turn right');
});

test('textFor heads off in the compass direction of departure', () => {
  assert.strictEqual(textFor({ type: 'depart' }, 'MG Road', { bearing: 90 }), 'Head east on MG Road');
  assert.strictEqual(textFor({ type: 'depart' }, null, { bearing: 0 }), 'Head north');
});

test('textFor handles roundabouts with an exit number', () => {
  assert.strictEqual(
    textFor({ type: 'roundabout', exit: 2 }, 'MG Road'),
    'Take 2nd exit onto MG Road'
  );
  assert.strictEqual(textFor({ type: 'roundabout' }, null), 'Take the roundabout');
});

test('textFor handles merges, forks, ramps and U-turns', () => {
  assert.strictEqual(textFor({ type: 'merge', modifier: 'right' }, 'MG Road'), 'Merge right onto MG Road');
  assert.strictEqual(textFor({ type: 'fork', modifier: 'slight left' }, null), 'Keep slight left');
  assert.strictEqual(textFor({ type: 'on ramp', modifier: 'left' }, null), 'Take the ramp on the left');
  assert.strictEqual(textFor({ type: 'off ramp', modifier: 'right' }, null), 'Take the exit on the right');
  assert.strictEqual(textFor({ type: 'turn', modifier: 'uturn' }, null), 'Make a U-turn');
});

test('textFor says "continue" for a road that only changes name', () => {
  assert.strictEqual(textFor({ type: 'new name' }, 'MG Road'), 'Continue onto MG Road');
  assert.strictEqual(textFor({ type: 'new name' }, null), 'Continue straight');
});

test('textFor announces arrival', () => {
  assert.strictEqual(textFor({ type: 'arrive' }, null), 'Arrive at your destination');
});

test('iconFor picks a direction glyph from the manoeuvre', () => {
  assert.strictEqual(iconFor({ type: 'turn', modifier: 'left' }), 'turn-left');
  assert.strictEqual(iconFor({ type: 'turn', modifier: 'right' }), 'turn-right');
  // A slight or sharp turn keeps its nuance rather than flattening to a turn.
  assert.strictEqual(iconFor({ type: 'turn', modifier: 'slight right' }), 'slight-right');
  assert.strictEqual(iconFor({ type: 'turn', modifier: 'slight left' }), 'slight-left');
  assert.strictEqual(iconFor({ type: 'turn', modifier: 'sharp left' }), 'sharp-left');
  assert.strictEqual(iconFor({ type: 'turn', modifier: 'uturn' }), 'uturn');
  assert.strictEqual(iconFor({ type: 'roundabout' }), 'roundabout');
  assert.strictEqual(iconFor({ type: 'arrive' }), 'arrive');
  assert.strictEqual(iconFor({ type: 'depart' }), 'depart');
  assert.strictEqual(iconFor({ type: 'fork', modifier: 'slight left' }), 'fork-left');
  assert.strictEqual(iconFor({ type: 'continue' }, 'MG Road'), 'continue');
  assert.strictEqual(iconFor({}, null), 'straight');
});

test('ordinalSuffix gets the awkward cases right', () => {
  assert.strictEqual(ordinalSuffix(1), 'st');
  assert.strictEqual(ordinalSuffix(2), 'nd');
  assert.strictEqual(ordinalSuffix(3), 'rd');
  assert.strictEqual(ordinalSuffix(4), 'th');
  assert.strictEqual(ordinalSuffix(11), 'th');
  assert.strictEqual(ordinalSuffix(12), 'th');
  assert.strictEqual(ordinalSuffix(13), 'th');
  assert.strictEqual(ordinalSuffix(21), 'st');
});

test('cleanStreet strips a trailing parenthesised locality', () => {
  assert.strictEqual(cleanStreet('MG Road (Mysuru)'), 'MG Road');
  assert.strictEqual(cleanStreet('MG Road'), 'MG Road');
  assert.strictEqual(cleanStreet(''), '');
  assert.strictEqual(cleanStreet(null), '');
});

test('buildSteps keeps the modifier and exit number for the UI', () => {
  const steps = buildSteps(route([
    step({ type: 'depart', location: A }),
    step({ type: 'roundabout', exit: 3, location: B, name: 'MG Road' }),
    step({ type: 'arrive', location: C }),
  ]));
  assert.strictEqual(steps[1].exit, 3);
  assert.strictEqual(steps[1].type, 'roundabout');
  assert.strictEqual(steps[1].icon, 'roundabout');
});

test('buildSteps spans multiple legs', () => {
  const steps = buildSteps({
    coords: COORDS,
    legs: [
      { steps: [step({ type: 'depart', location: A })] },
      { steps: [step({ type: 'arrive', location: C })] },
    ],
  });
  assert.strictEqual(steps.length, 2);
  assert.strictEqual(steps[0].along_m, 0);
  assert.ok(steps[1].along_m > 900, 'the arrival is at the end, got ' + steps[1].along_m);
});
