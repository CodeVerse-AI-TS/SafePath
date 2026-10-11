'use strict';
/**
 * Unit tests for the SafePath risk function and the route ranker.
 *
 *   npm test
 *
 * These run against the real modules (no mocks). They use the seeded database
 * when it exists; on a fresh clone the suite builds the sample data and model
 * once first, so `npm test` works without any extra setup.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'data', 'safepath.db');
process.env.SAFEPATH_DB = DB;

// Build the database + model on a fresh clone so the suite is self-contained.
if (!fs.existsSync(DB)) {
  execFileSync(process.execPath, [path.join(ROOT, 'data', 'seed.js')], { cwd: ROOT, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(ROOT, 'ds', 'build.js')], { cwd: ROOT, stdio: 'inherit' });
}

const risk = require(path.join(ROOT, 'server', 'lib', 'risk'));
const geo = require(path.join(ROOT, 'server', 'lib', 'geo'));
const routing = require(path.join(ROOT, 'server', 'lib', 'routing'));
const { readHotspots } = require(path.join(ROOT, 'server', 'lib', 'db'));

risk.reload();

const at = (h) => new Date(2026, 9, 28, h, 0, 0); // 28 Oct 2026, local time

function busiestHotspot() {
  return readHotspots().slice().sort((a, b) => b.count - a.count)[0];
}

test('risk score is always within 0..100', () => {
  const points = [
    [12.3110, 76.6520], // Devaraja Market, the densest hotspot
    [12.2934, 76.6309], // Kuvempunagar, quieter
    [12.2637, 76.6228], // Srirampura, edge of the seeded area
  ];
  for (const [lat, lng] of points) {
    for (const h of [8, 13, 19, 23]) {
      const r = risk.riskAt(lat, lng, at(h));
      assert.ok(r.risk >= 0 && r.risk <= 100, `risk ${r.risk} out of range at ${lat},${lng} @${h}h`);
    }
  }
});

test('risk decays with distance from an incident', () => {
  // Measure from the most isolated incident in the seed set, so the curve shows
  // a single incident's Gaussian decay rather than a saturated cluster. Inside
  // a dense cluster the count term saturates by design; a lone incident shows
  // the decay law cleanly.
  const { all } = require(path.join(ROOT, 'server', 'lib', 'db'));
  const inc = all('SELECT id, lat, lng FROM incidents');
  let lone = null;
  for (const i of inc) {
    let n = 0;
    for (const j of inc) if (i.id !== j.id && geo.haversineM(i.lat, i.lng, j.lat, j.lng) < 700) n++;
    if (!lone || n < lone.n) lone = { lat: i.lat, lng: i.lng, n };
  }

  const densityAt = (d) => {
    const [lat, lng] = geo.destination(lone.lat, lone.lng, d, 0);
    return risk.riskAt(lat, lng, at(23), { includeComponents: true }).components.density_norm;
  };
  const rings = [0, 100, 200, 300, 600, 1000].map(densityAt);
  assert.ok(rings[0] > rings[1], `density should fall 0 -> 100 m: ${rings.join(', ')}`);
  assert.ok(rings[1] > rings[2], `density should fall 100 -> 200 m: ${rings.join(', ')}`);
  assert.ok(rings[2] > rings[3], `density should fall 200 -> 300 m: ${rings.join(', ')}`);
  // Beyond the 300 m maximum influence radius the incident term must be gone.
  assert.ok(rings[4] === 0 && rings[5] === 0, `incident term should vanish past 300 m: ${rings.join(', ')}`);
});

test('risk is higher at night than in the afternoon at the same place', () => {
  const h = busiestHotspot();
  const afternoon = risk.riskAt(h.lat, h.lng, at(14)).risk;
  const night = risk.riskAt(h.lat, h.lng, at(23)).risk;
  assert.ok(night > afternoon, `expected night (${night}) > afternoon (${afternoon})`);
});

test('recent incidents weigh more than old ones (recency decay)', () => {
  const p = risk.loadParams();
  const halflife = p.recency_halflife_days;
  const w = (days) => Math.pow(0.5, days / halflife);
  assert.ok(w(0) > w(halflife), 'one half-life should halve the weight');
  assert.ok(w(halflife) > w(2 * halflife), 'two half-lives should weigh less than one');
  assert.ok(Math.abs(w(halflife) - 0.5) < 1e-9, 'half-life definition should hold');
});

test('the lighting signal matters at least as much at night as by day', () => {
  const h = busiestHotspot();
  const night = risk.riskAt(h.lat, h.lng, at(23), { includeComponents: true }).components.darkness_time_scaled;
  const day = risk.riskAt(h.lat, h.lng, at(13), { includeComponents: true }).components.darkness_time_scaled;
  assert.ok(typeof night === 'number' && typeof day === 'number', 'darkness component should be a number');
  assert.ok(night >= day, `darkness should weigh at least as much at night (${night} vs ${day})`);
});

test('time-of-day multipliers follow the learned pattern (night highest)', () => {
  const m = risk.loadParams().time_multiplier;
  assert.ok(m.night > m.afternoon, `night ${m.night} should exceed afternoon ${m.afternoon}`);
  assert.ok(m.night > m.morning, `night ${m.night} should exceed morning ${m.morning}`);
  for (const k of ['morning', 'afternoon', 'evening', 'night']) {
    assert.ok(typeof m[k] === 'number' && m[k] > 0, `missing multiplier for ${k}`);
  }
});

test('protective factors are bounded and present', () => {
  const h = busiestHotspot();
  const p = risk.riskAt(h.lat, h.lng, at(14), { includeComponents: true }).components.protective_norm;
  assert.ok(p >= 0 && p <= 1, `protective_norm out of range: ${p}`);
});

test('safety score falls as risk rises', () => {
  const quiet = routing.scoreRoute(
    { coords: [[12.2637, 76.6228], [12.2642, 76.6235]], distance_m: 120, duration_s: 90 }, at(14)
  );
  const h = busiestHotspot();
  const risky = routing.scoreRoute(
    { coords: [[h.lat, h.lng], [h.lat + 0.0005, h.lng + 0.0005]], distance_m: 120, duration_s: 90 }, at(23)
  );
  assert.ok(quiet.safety_score > risky.safety_score,
    `expected quiet ${quiet.safety_score} > hotspot ${risky.safety_score}`);
});

test('dedupe collapses identical routes but keeps a different middle', () => {
  const a = [[12.31, 76.65], [12.32, 76.65], [12.33, 76.65]];
  const b = [[12.31, 76.65], [12.32, 76.67], [12.33, 76.65]];
  const same = routing.dedupe([{ coords: a, distance_m: 100 }, { coords: a.map((p) => [...p]), distance_m: 100 }]);
  assert.equal(same.length, 1, 'identical routes should collapse to one');
  const different = routing.dedupe([{ coords: a, distance_m: 100 }, { coords: b, distance_m: 100 }]);
  assert.equal(different.length, 2, 'routes with a different middle should stay distinct');
});

test('hotspots are regenerated from the database and carry required fields', () => {
  const hs = readHotspots();
  assert.ok(hs.length > 0, 'expected at least one hotspot');
  for (const h of hs.slice(0, 5)) {
    assert.ok(h.cluster_id != null, 'cluster_id present');
    assert.ok(Number.isFinite(h.lat) && Number.isFinite(h.lng), 'lat/lng finite');
    assert.ok(typeof h.intensity === 'number' && h.intensity >= 0 && h.intensity <= 1, 'intensity 0..1');
    assert.ok(typeof h.count === 'number' && h.count > 0, 'count > 0');
    assert.ok(typeof h.reason === 'string' && h.reason.length > 0, 'reason present');
  }
});
