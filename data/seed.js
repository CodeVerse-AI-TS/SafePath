'use strict';
/**
 * SafePath synthetic seed data.
 *
 * ============================ SAMPLE DATA ============================
 * Every incident and road feature written by this script is SYNTHETIC.
 * Rows are shaped like plausible Mysuru incident reports (area, type,
 * severity, time-of-day) so the risk model, hotspot clustering and UI can be
 * exercised end to end. No row describes a real event, person or place.
 * To use real data, run `npm run import -- path/to/incidents.csv` instead.
 * =====================================================================
 *
 * Usage:  node data/seed.js [--incidents 720]
 */

const { getDb, run, setMeta } = require('../server/lib/db');
const { destination } = require('../server/lib/geo');

/* ----------------------------- RNG ---------------------------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20240617);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randn = () => {
  // Box–Muller
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const between = (a, b) => a + rand() * (b - a);

/* --------------------- Mysuru (Mysore) reference areas --------------- */
// weight = relative incident density, spreadM = cluster radius, night = how
// night-weighted the area's incidents are (1 = daytime-ish, 3 = very night-heavy).
const AREAS = [
  { name: 'Mysuru City Railway Station', lat: 12.3149, lng: 76.6454, weight: 9, spreadM: 300, night: 2.6, reason: 'late-night arrivals, luggage snatching reports' },
  { name: 'Mysuru Central Bus Stand', lat: 12.3267, lng: 76.6272, weight: 8, spreadM: 320, night: 2.4, reason: 'busy transit interchange, theft and snatching reports' },
  { name: 'Devaraja Market', lat: 12.3110, lng: 76.6520, weight: 7, spreadM: 260, night: 1.4, reason: 'crowded market, pickpocketing reports' },
  { name: 'Mysore Palace precinct', lat: 12.3052, lng: 76.6554, weight: 5, spreadM: 340, night: 1.8, reason: 'tourist crowds, evening harassment reports' },
  { name: 'Agrahara / Mandi Mohalla', lat: 12.2975, lng: 76.6560, weight: 5, spreadM: 300, night: 2.2, reason: 'old-city lanes, low-lighting reports' },
  { name: 'Lashkar Mohalla', lat: 12.3118, lng: 76.6621, weight: 5, spreadM: 300, night: 2.1, reason: 'harassment and eve-teasing reports in the evenings' },
  { name: 'Nazarbad / Zoo periphery', lat: 12.3093, lng: 76.6658, weight: 4, spreadM: 320, night: 2.5, reason: 'unlit road edges, stalking reports after dark' },
  { name: 'Kuvempunagar', lat: 12.2934, lng: 76.6309, weight: 3, spreadM: 320, night: 1.3, reason: 'residential streets, low-lighting reports' },
  { name: 'Saraswathipuram', lat: 12.2985, lng: 76.6284, weight: 3, spreadM: 300, night: 1.4, reason: 'residential parks and service roads' },
  { name: 'Vijayanagar', lat: 12.3333, lng: 76.6126, weight: 3, spreadM: 320, night: 1.5, reason: 'residential layout, occasional snatching reports' },
  { name: 'Gokulam', lat: 12.3261, lng: 76.6283, weight: 3, spreadM: 300, night: 1.6, reason: 'guest-house streets, sparse lighting' },
  { name: 'Yadavagiri', lat: 12.3279, lng: 76.6392, weight: 3, spreadM: 300, night: 1.7, reason: 'underpasses and service roads' },
  { name: 'Hebbal Industrial Area', lat: 12.3580, lng: 76.6105, weight: 3, spreadM: 360, night: 2.0, reason: 'industrial edges, sparse lighting' },
  { name: 'Metagalli', lat: 12.3478, lng: 76.6298, weight: 3, spreadM: 340, night: 1.9, reason: 'factory approach roads, poor lighting' },
  { name: 'Chamundipuram', lat: 12.2886, lng: 76.6482, weight: 3, spreadM: 300, night: 1.5, reason: 'residential, bus stand vicinity crowding' },
  { name: 'Manasagangotri / University', lat: 12.3135, lng: 76.6218, weight: 2, spreadM: 320, night: 2.2, reason: 'campus approach roads, quiet after dark' },
  { name: 'Vidyaranyapuram', lat: 12.2793, lng: 76.6496, weight: 2, spreadM: 300, night: 1.4, reason: 'residential outskirts, infrequent patrols' },
  { name: 'Bogadi', lat: 12.3042, lng: 76.5996, weight: 2, spreadM: 320, night: 1.5, reason: 'outskirts, incomplete street lighting' },
  { name: 'Bannimantap', lat: 12.3326, lng: 76.6517, weight: 2, spreadM: 320, night: 1.6, reason: 'grounds and service roads, dark stretches' },
  { name: 'Chamundi Hill road', lat: 12.2724, lng: 76.6704, weight: 2, spreadM: 380, night: 2.0, reason: 'isolated hill road, unlit hairpins' },
  { name: 'Srirampura', lat: 12.2637, lng: 76.6228, weight: 2, spreadM: 300, night: 1.5, reason: 'residential outskirts, low lighting' },
];

/* --------------------------- Incident types -------------------------- */
// hourWeights = relative likelihood by hour of day (index 0..23).
function hours(profile) {
  return profile;
}
const TYPES = [
  { type: 'harassment', severity: [2, 3, 4, 4, 5], hour: hours([1,1,1,1,1,1,2,3,4,4,4,4,4,4,4,4,5,6,8,9,8,6,4,2]) },
  { type: 'stalking',   severity: [2, 3, 3, 4, 5], hour: hours([3,3,2,2,1,1,2,3,3,3,3,3,3,3,3,4,5,6,8,9,9,7,5,4]) },
  { type: 'snatching',  severity: [2, 3, 3, 4, 5], hour: hours([4,3,2,1,1,1,2,3,4,4,4,4,4,4,4,5,6,8,9,9,8,7,6,5]) },
  { type: 'theft',      severity: [1, 2, 3, 3, 4], hour: hours([2,2,1,1,1,2,3,4,5,6,6,6,6,6,6,6,7,8,8,7,6,5,4,3]) },
  { type: 'assault',    severity: [3, 4, 4, 5, 5], hour: hours([5,5,4,3,2,1,1,2,2,2,2,2,3,3,3,4,5,6,8,9,9,9,8,6]) },
  { type: 'road_accident', severity: [2, 3, 4, 4, 5], hour: hours([4,3,2,2,2,3,5,7,8,7,6,6,6,6,6,6,8,9,9,8,7,6,5,4]) },
  { type: 'obstruction', severity: [1, 1, 2, 2, 3], hour: hours([2,1,1,1,1,2,4,6,7,7,6,6,6,6,6,6,7,7,6,5,4,3,2,2]) },
];
const TYPE_WEIGHT = { harassment: 1.0, stalking: 0.85, snatching: 0.9, theft: 0.8, assault: 0.7, road_accident: 0.8, obstruction: 0.6 };

function weightedIndex(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/** A plausible timestamp: biased to recent months, hour from type profile. */
function incidentTimestamp(hourWeights, nightBias) {
  const daysAgo = Math.floor(Math.pow(rand(), 1.7) * 540); // 0..540 days, recent-weighted
  const d = new Date(Date.now() - daysAgo * 86400000);
  // blend the type's hour profile with the area's night bias
  const biased = hourWeights.map((w, h) => {
    const isNight = h >= 21 || h <= 5;
    return w * (isNight ? nightBias : 1);
  });
  d.setHours(weightedIndex(biased), Math.floor(rand() * 60), 0, 0);
  return d.toISOString();
}

/* ------------------------------ Seeders ------------------------------ */

function seedIncidents(targetCount) {
  const db = getDb();
  db.exec('DELETE FROM incidents;');
  const insert = db.prepare(
    `INSERT INTO incidents(lat, lng, type, severity, timestamp, source, verified, note)
     VALUES(?, ?, ?, ?, ?, 'synthetic', ?, ?)`
  );

  const totalWeight = AREAS.reduce((a, x) => a + x.weight * 1, 0);
  let written = 0;

  // Clustered incidents around each area.
  for (const area of AREAS) {
    const share = Math.round((area.weight / totalWeight) * targetCount);
    for (let i = 0; i < share; i++) {
      const t = pick(TYPES);
      const bearing = rand() * 360;
      const dist = Math.abs(randn()) * area.spreadM * 0.6;
      const [lat, lng] = destination(area.lat, area.lng, dist, bearing);
      const severity = t.severity[Math.floor(rand() * t.severity.length)];
      const verified = rand() < 0.42 ? 1 : 0;
      insert.run(
        +lat.toFixed(6), +lng.toFixed(6), t.type, severity,
        incidentTimestamp(t.hour, area.night), verified,
        `Synthetic ${t.type} near ${area.name.split(' / ')[0]} (sample data)`
      );
      written++;
    }
  }

  // City-wide low-severity baseline (scattered, mostly daytime).
  const baseline = Math.max(60, Math.round(targetCount * 0.18));
  for (let i = 0; i < baseline; i++) {
    const a = pick(AREAS);
    const [lat, lng] = destination(a.lat, a.lng, between(1500, 6000), rand() * 360);
    const t = pick([TYPES[3], TYPES[6], TYPES[5]]); // theft / obstruction / accident
    insert.run(
      +lat.toFixed(6), +lng.toFixed(6), t.type, 1 + Math.floor(rand() * 2),
      incidentTimestamp(t.hour, 1.1), rand() < 0.3 ? 1 : 0,
      'Synthetic baseline report (sample data)'
    );
    written++;
  }

  setMeta('seeded_incidents', written);
  return written;
}

function seedRoadFeatures() {
  const db = getDb();
  db.exec('DELETE FROM road_features;');
  const insert = db.prepare(
    `INSERT INTO road_features(lat, lng, kind, name, source, meta)
     VALUES(?, ?, ?, ?, 'synthetic_osm', ?)`
  );

  let n = 0;
  // Street lamps: sprinkled along corridors between areas and around each area.
  for (const area of AREAS) {
    const lamps = 18 + Math.round(area.weight * 2);
    for (let i = 0; i < lamps; i++) {
      const [lat, lng] = destination(area.lat, area.lng, between(60, area.spreadM + 400), rand() * 360);
      insert.run(+lat.toFixed(6), +lng.toFixed(6), 'street_lamp', null, JSON.stringify({ lit: rand() < 0.85 }));
      n++;
    }
  }
  // Corridor lamps between neighbouring areas.
  for (let i = 0; i < AREAS.length - 1; i++) {
    const a = AREAS[i], b = AREAS[i + 1];
    const steps = 12;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const lat = a.lat + (b.lat - a.lat) * t;
      const lng = a.lng + (b.lng - a.lng) * t;
      const [jl, jn] = destination(lat, lng, between(0, 40), rand() * 360);
      insert.run(+jl.toFixed(6), +jn.toFixed(6), 'street_lamp', null, JSON.stringify({ lit: true }));
      n++;
    }
  }

  const HELP = [
    ['police', 'Devaraja Police Station', 12.3129, 76.6495],
    ['police', 'Nazarbad Police Station', 12.3084, 76.6673],
    ['police', 'Lashkar Police Station', 12.3118, 76.6621],
    ['police', 'Krishnaraja Police Station', 12.3052, 76.6554],
    ['police', 'Vijayanagar Police Station', 12.3333, 76.6126],
    ['police', 'Kuvempunagar Police Station', 12.2934, 76.6309],
    ['police', 'Narasimharaja Police Station', 12.3149, 76.6454],
    ['police', 'Siddarthanagar Police Station', 12.2985, 76.6284],
    ['police', 'Hebbal Police Station', 12.3580, 76.6105],
    ['police', 'Bannimantap Police Station', 12.3326, 76.6517],
    ['police', 'Vidyaranyapuram Police Station', 12.2793, 76.6496],
    ['police', 'Metagalli Police Station', 12.3478, 76.6298],
    ['hospital', 'KR Hospital', 12.3146, 76.6511],
    ['hospital', 'Cheluvamba Hospital', 12.3139, 76.6490],
    ['hospital', 'Holdsworth Memorial Hospital', 12.3204, 76.6501],
    ['hospital', 'JSS Hospital', 12.2960, 76.6553],
    ['hospital', 'Bharath Hospital', 12.3529, 76.6083],
    ['hospital', 'Vikram Hospital', 12.3236, 76.6383],
    ['hospital', 'Columbia Asia Hospital', 12.3501, 76.6607],
    ['hospital', 'Cauvery Hospital', 12.3053, 76.6959],
    ['hospital', 'Seth Mohanlal Memorial Hospital', 12.3052, 76.6420],
    ['hospital', 'Basappa Memorial Hospital', 12.3230, 76.6230],
    ['hospital', 'Sushruta Hospital', 12.3010, 76.6180],
    ['hospital', 'Narayana Multispeciality Hospital', 12.2900, 76.6600],
  ];
  for (const [kind, name, lat, lng] of HELP) {
    insert.run(lat, lng, kind, name, null);
    n++;
  }

  // Shops / businesses around commercial areas.
  const COMMERCIAL = AREAS.filter((a) => ['Devaraja Market', 'Mysore Palace precinct', 'Lashkar Mohalla', 'Mysuru Central Bus Stand', 'Kuvempunagar', 'Saraswathipuram', 'Vijayanagar', 'Gokulam', 'Yadavagiri'].includes(a.name));
  for (const area of COMMERCIAL) {
    const shops = 10 + Math.round(area.weight * 2);
    for (let i = 0; i < shops; i++) {
      const [lat, lng] = destination(area.lat, area.lng, between(40, 600), rand() * 360);
      const openLate = rand() < 0.35;
      insert.run(+lat.toFixed(6), +lng.toFixed(6), 'shop', null, JSON.stringify({ openLate }));
      n++;
    }
  }

  // Fuel stations + bus stops.
  for (const area of AREAS) {
    for (let i = 0; i < 2; i++) {
      const [lat, lng] = destination(area.lat, area.lng, between(200, 900), rand() * 360);
      insert.run(+lat.toFixed(6), +lng.toFixed(6), 'fuel', null, null);
      n++;
    }
    for (let i = 0; i < 3; i++) {
      const [lat, lng] = destination(area.lat, area.lng, between(100, 700), rand() * 360);
      insert.run(+lat.toFixed(6), +lng.toFixed(6), 'bus_stop', null, null);
      n++;
    }
  }

  setMeta('seeded_road_features', n);
  return n;
}

function main() {
  const args = process.argv.slice(2);
  const iIdx = args.indexOf('--incidents');
  const target = iIdx >= 0 ? parseInt(args[iIdx + 1], 10) : 720;

  // A clean install should not inherit community reports from a previous area.
  // Pass --keep-reports to preserve them across a re-seed.
  if (!args.includes('--keep-reports')) {
    const db = getDb();
    const removed = db.prepare('SELECT COUNT(*) AS n FROM reports').get().n;
    db.exec('DELETE FROM reports;');
    if (removed) console.log(`[seed] cleared ${removed} previous community report(s)`);
  }

  const incidents = seedIncidents(target);
  const features = seedRoadFeatures();
  setMeta('data_source', 'synthetic');
  setMeta('seeded_at', new Date().toISOString());
  console.log(`[seed] wrote ${incidents} SYNTHETIC incidents and ${features} synthetic road features`);
  console.log('[seed] sample data only - run `npm run import -- <csv>` for real data');
}

if (require.main === module) main();
module.exports = { AREAS, TYPES };
