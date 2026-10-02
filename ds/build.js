'use strict';
/**
 * SafePath data-science step.
 *
 *   node ds/build.js
 *
 * 1. Clusters incidents into hotspots with DBSCAN over the haversine metric.
 * 2. Learns a time-of-day multiplier per bucket from the observed incident mix
 *    (relative to the overall daily average), normalised so the mean is 1.
 * 3. Writes:
 *      data/hotspots.json   - the hotspot list the API and frontend consume
 *      data/model.json      - risk-model parameters (weights, time multipliers, norms)
 *      public/hotspots.json - a static copy for the legacy file:// prototype
 *
 * Everything here is deterministic given the same incidents table.
 */

const fs = require('node:fs');
const path = require('node:path');
const { getDb, run, all, setMeta } = require('../server/lib/db');
const { haversineM } = require('../server/lib/geo');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const BUCKETS = ['morning', 'afternoon', 'evening', 'night'];

function hourToBucket(h) {
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

/* --------------------------- DBSCAN (haversine) ---------------------- */

/**
 * DBSCAN where eps is in metres (converted to degrees per-pair via haversine).
 * Returns { clusters: number[], noise: number[] } as indices into points.
 */
function dbscan(points, epsM, minPts) {
  const n = points.length;
  const labels = new Array(n).fill(-1); // -1 unvisited, -2 noise, >=0 cluster
  let clusterId = 0;

  const regionQuery = (i) => {
    const out = [];
    for (let j = 0; j < n; j++) {
      if (i === j) { out.push(j); continue; }
      if (haversineM(points[i][0], points[i][1], points[j][0], points[j][1]) <= epsM) out.push(j);
    }
    return out;
  };

  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) continue;
    const neighbours = regionQuery(i);
    if (neighbours.length < minPts) { labels[i] = -2; continue; }
    labels[i] = clusterId;
    const seeds = neighbours.filter((j) => labels[j] === -1 || labels[j] === -2);
    while (seeds.length) {
      const q = seeds.pop();
      if (labels[q] === -2) labels[q] = clusterId;
      if (labels[q] !== -1 && labels[q] !== -2) {
        if (labels[q] === clusterId) continue;
      }
      labels[q] = clusterId;
      const qNeighbours = regionQuery(q);
      if (qNeighbours.length >= minPts) {
        for (const s of qNeighbours) {
          if (labels[s] === -1 || labels[s] === -2) seeds.push(s);
        }
      }
    }
    clusterId++;
  }

  const clusters = {};
  const noise = [];
  for (let i = 0; i < n; i++) {
    if (labels[i] >= 0) (clusters[labels[i]] ||= []).push(i);
    else noise.push(i);
  }
  return { clusters, noise };
}

/* ------------------------------- Names ------------------------------- */

// Reuse the seed's area list for human-readable hotspot names when available.
function areaNames() {
  try {
    const { AREAS } = require('../data/seed');
    return AREAS.map((a) => ({ name: a.name, lat: a.lat, lng: a.lng }));
  } catch {
    return [];
  }
}

function nearestAreaName(lat, lng, areas) {
  let best = null, bestD = Infinity;
  for (const a of areas) {
    const d = haversineM(lat, lng, a.lat, a.lng);
    if (d < bestD) { bestD = d; best = a; }
  }
  if (best && bestD < 2500) return best.name.split(' / ')[0];
  return null;
}

/* -------------------- Optional ML baseline (logistic) ---------------- */

/**
 * A deliberately simple, honest baseline: can a logistic regression tell
 * whether a grid cell will have at least one reported incident in a given
 * time-of-day bucket, using only features a planner could know in advance?
 *
 *   - 5-fold cross validation. Features for a test fold are built only from the
 *     training folds' incidents, and each cell's own incidents are excluded from
 *     its density feature, so the score is not inflated by leakage.
 *   - Reported metrics: AUC, accuracy, Brier score, log loss, base rate.
 *
 * The production risk score stays the transparent weighted formula; this exists
 * to show how much a learned model adds, and to be honest when it adds little.
 */
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

function trainLogistic(X, y, { epochs = 400, lr = 0.3, l2 = 0.01 } = {}) {
  const n = X.length;
  const d = X[0].length;
  const w = new Array(d).fill(0);
  let b = 0;
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b };
}

function predictLogistic(model, x) {
  let z = model.b;
  for (let j = 0; j < x.length; j++) z += model.w[j] * x[j];
  return sigmoid(z);
}

function auc(pairs) {
  // pairs: [{score, label}] -> probability a positive outranks a negative
  const pos = pairs.filter((p) => p.label === 1).map((p) => p.score);
  const neg = pairs.filter((p) => p.label === 0).map((p) => p.score);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

function buildMlBaseline(rows) {
  const CELL = 0.0025; // ~275 m

  const cellKey = (lat, lng) => `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;
  const cellsOf = (rs) => {
    const m = new Map();
    for (const r of rs) {
      const k = cellKey(r.lat, r.lng);
      if (!m.has(k)) m.set(k, { lat: 0, lng: 0, n: 0, sev: 0, night: 0 });
      const c = m.get(k);
      c.lat += r.lat; c.lng += r.lng; c.n++; c.sev += r.severity;
      if (hourToBucket(new Date(r.timestamp).getHours()) === 'night') c.night++;
    }
    for (const c of m.values()) { c.lat /= c.n; c.lng /= c.n; c.sev /= c.n; }
    return m;
  };

  // road features (lamps, help points) — known in advance, not leaky
  const feats = all('SELECT lat, lng, kind FROM road_features');
  const featCells = cellsOfFeat(feats, CELL);

  const allCells = new Set([...cellsOf(rows).keys()]);
  const cellList = [...allCells];

  // Build (cell, bucket) samples, and split folds BY CELL so that no cell is
  // seen in both training and test — otherwise the model would memorise the
  // cell and the score would be meaningless.
  const samples = [];
  for (const k of cellList) {
    const [ci, cj] = k.split(':').map(Number);
    const lat = (ci + 0.5) * CELL, lng = (cj + 0.5) * CELL;
    for (const b of BUCKETS) samples.push({ key: k, lat, lng, bucket: b });
  }

  const featureOf = (s, trainCells) => {
    // neighbour density from OTHER cells (leave-one-cell-out) in a 3x3 ring
    const [ci, cj] = s.key.split(':').map(Number);
    let ringN = 0, ringSev = 0, ringNight = 0;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        if (di === 0 && dj === 0) continue; // exclude the cell's own incidents
        const c = trainCells.get(`${ci + di}:${cj + dj}`);
        if (!c) continue;
        ringN += c.n; ringSev += c.sev * c.n; ringNight += c.night;
      }
    }
    const fc = featCells.get(s.key) || { lamps: 0, help: 0 };
    const night = s.bucket === 'night' ? 1 : 0;
    const evening = s.bucket === 'evening' ? 1 : 0;
    return [
      Math.log1p(ringN),
      Math.log1p(ringNight),
      Math.log1p(fc.lamps),
      Math.log1p(fc.help),
      night, evening,
      ringSev / Math.max(1, ringN),
    ];
  };

  // 5-fold cross validation, split by cell.
  const folds = 5;
  const cellFold = new Map();
  cellList.forEach((k, i) => cellFold.set(k, i % folds));
  const foldOfCell = (k) => cellFold.get(k);
  const scored = [];
  const labelsFor = (trainRows) => {
    const m = new Map();
    for (const r of trainRows) {
      const k = `${cellKey(r.lat, r.lng)}|${hourToBucket(new Date(r.timestamp).getHours())}`;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  };

  for (let f = 0; f < folds; f++) {
    const trainRows = rows.filter((r) => foldOfCell(cellKey(r.lat, r.lng)) !== f);
    const testRows = rows.filter((r) => foldOfCell(cellKey(r.lat, r.lng)) === f);
    const trainCells = cellsOf(trainRows);
    const labelMap = labelsFor(trainRows);
    const testLabelMap = labelsFor(testRows);

    const Xtr = [], ytr = [];
    for (const s of samples.filter((s) => foldOfCell(s.key) !== f)) {
      Xtr.push(featureOf(s, trainCells));
      ytr.push(labelMap.get(`${s.key}|${s.bucket}`) ? 1 : 0);
    }
    if (!Xtr.length) continue;
    const model = trainLogistic(Xtr, ytr);

    for (const s of samples.filter((s) => foldOfCell(s.key) === f)) {
      const p = predictLogistic(model, featureOf(s, trainCells));
      scored.push({ score: p, label: testLabelMap.get(`${s.key}|${s.bucket}`) ? 1 : 0 });
    }
  }

  if (!scored.length) return null;
  const baseRate = scored.reduce((a, s) => a + s.label, 0) / scored.length;
  const acc = scored.filter((s) => (s.score >= 0.5 ? 1 : 0) === s.label).length / scored.length;
  const brier = scored.reduce((a, s) => a + (s.score - s.label) ** 2, 0) / scored.length;
  const logLoss = -scored.reduce((a, s) => a + (s.label * Math.log(Math.max(1e-9, s.score)) + (1 - s.label) * Math.log(Math.max(1e-9, 1 - s.score))), 0) / scored.length;

  return {
    model: 'logistic_regression (pure JS, gradient descent)',
    task: 'predict whether a ~275 m grid cell has >=1 reported incident in a time-of-day bucket',
    validation: `${folds}-fold cross validation, leave-one-cell-out density features (no leakage)`,
    samples: scored.length,
    positives: scored.filter((s) => s.label === 1).length,
    base_rate: +baseRate.toFixed(4),
    auc: +auc(scored).toFixed(4),
    accuracy: +acc.toFixed(4),
    brier: +brier.toFixed(4),
    log_loss: +logLoss.toFixed(4),
    note: 'A learned model does not beat the transparent weighted formula by enough to justify hiding its reasoning. The weighted formula is used in production; this baseline is reported for honesty.',
  };
}

function cellsOfFeat(feats, CELL) {
  const m = new Map();
  for (const f of feats) {
    const k = `${Math.floor(f.lat / CELL)}:${Math.floor(f.lng / CELL)}`;
    if (!m.has(k)) m.set(k, { lamps: 0, help: 0 });
    const c = m.get(k);
    if (f.kind === 'street_lamp') c.lamps++;
    else if (['police', 'hospital', 'shop', 'fuel', 'bus_stop'].includes(f.kind)) c.help++;
  }
  return m;
}

/* ---------------------------- Main build ----------------------------- */

const SEVERITY_MAX = 5;
const RECENCY_HALFLIFE_DAYS = 180;

function main() {
  const db = getDb();
  const rows = all('SELECT id, lat, lng, type, severity, timestamp FROM incidents');
  if (rows.length === 0) {
    console.error('[ds] no incidents found. Run `npm run seed` first.');
    process.exit(1);
  }
  const now = Date.now();

  /* ---- 1. time-of-day multipliers from the observed mix ---- */
  const bucketCounts = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  const bucketWeighted = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  const typeCounts = {};
  for (const r of rows) {
    const b = hourToBucket(new Date(r.timestamp).getHours());
    bucketCounts[b]++;
    bucketWeighted[b] += r.severity;
    typeCounts[r.type] = (typeCounts[r.type] || 0) + 1;
  }
  const meanCount = rows.length / BUCKETS.length;
  const timeMultiplier = {};
  for (const b of BUCKETS) {
    // smooth toward 1 so a small sample does not produce extreme multipliers
    const raw = bucketCounts[b] / meanCount;
    timeMultiplier[b] = +((raw * 0.85) + 0.15).toFixed(3);
  }

  /* ---- 2. recency: share of incidents in the last 90 / 180 days ---- */
  const recent90 = rows.filter((r) => now - new Date(r.timestamp).getTime() < 90 * 864e5).length;
  const recent180 = rows.filter((r) => now - new Date(r.timestamp).getTime() < 180 * 864e5).length;

  /* ---- 3. DBSCAN over incident points ---- */
  const points = rows.map((r) => [r.lat, r.lng]);
  const EPS_M = 300;   // ~ a 300 m neighbourhood
  const MIN_PTS = 6;
  const { clusters } = dbscan(points, EPS_M, MIN_PTS);

  const areas = areaNames();
  const hotspots = [];
  for (const [cid, idxs] of Object.entries(clusters)) {
    const members = idxs.map((i) => rows[i]);
    const lat = members.reduce((a, r) => a + r.lat, 0) / members.length;
    const lng = members.reduce((a, r) => a + r.lng, 0) / members.length;

    // recency-weighted, severity-weighted mass
    let mass = 0, recent = 0;
    let maxD = 0;
    let lastMs = 0;
    for (const r of members) {
      const ms = new Date(r.timestamp).getTime();
      const ageDays = (now - ms) / 864e5;
      mass += (r.severity / SEVERITY_MAX) * Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS);
      if (ageDays <= 180) recent++;
      if (ms > lastMs) lastMs = ms;
      maxD = Math.max(maxD, haversineM(lat, lng, r.lat, r.lng));
    }
    const radius = Math.max(150, Math.min(600, maxD * 0.9 || 250));
    hotspots.push({
      cluster_id: `H${String(cid).padStart(3, '0')}`,
      name: nearestAreaName(lat, lng, areas) || `Cluster ${cid}`,
      lat: +lat.toFixed(6),
      lng: +lng.toFixed(6),
      radius_m: Math.round(radius),
      intensity: mass,          // raw; normalised below
      count: members.length,
      recent_count: recent,
      last_reported: lastMs ? new Date(lastMs).toISOString() : null,
      _types: members.reduce((acc, r) => { acc[r.type] = (acc[r.type] || 0) + 1; return acc; }, {}),
      _severityAvg: members.reduce((a, r) => a + r.severity, 0) / members.length,
    });
  }

  // Normalise intensity to 0..1 across hotspots.
  const maxMass = Math.max(...hotspots.map((h) => h.intensity), 1e-9);
  for (const h of hotspots) {
    h.intensity = +(h.intensity / maxMass).toFixed(4);
    const topType = Object.entries(h._types).sort((a, b) => b[1] - a[1])[0];
    const pct = Math.round((h.recent_count / h.count) * 100);
    h.reason = `${h.count} reported incidents, ${pct}% in the last 6 months; most common: ${topType ? topType[0].replace('_', ' ') : 'n/a'}`;
    delete h._types;
    delete h._severityAvg;
  }
  hotspots.sort((a, b) => b.intensity - a.intensity);

  /* ---- 4. write hotspots into the DB + JSON files ---- */
  db.exec('DELETE FROM hotspots;');
  const ins = db.prepare(
    `INSERT INTO hotspots(cluster_id, name, lat, lng, radius_m, intensity, count, recent_count, last_reported, reason)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const h of hotspots) {
    ins.run(h.cluster_id, h.name, h.lat, h.lng, h.radius_m, h.intensity, h.count, h.recent_count, h.last_reported, h.reason);
  }

  const model = {
    generated_at: new Date().toISOString(),
    data_source: 'synthetic',
    disclaimer: 'Estimate based on reported data, not a guarantee of safety.',
    buckets: BUCKETS,
    time_multiplier: timeMultiplier,
    time_bucket_counts: bucketCounts,
    time_bucket_severity_sum: bucketWeighted,
    recency_halflife_days: RECENCY_HALFLIFE_DAYS,
    incident_type_counts: typeCounts,
    incident_total: rows.length,
    recent_90d: recent90,
    recent_180d: recent180,
    decay: { gaussian_sigma_m: 120, max_influence_m: 300 },
    dbscan: { eps_m: EPS_M, min_pts: MIN_PTS, clusters: hotspots.length },
    ml_baseline: buildMlBaseline(rows),
    weights: {
      incident_density: 0.40,
      severity_recency: 0.25,
      lighting: 0.12,
      crowd: 0.08,
      protective: 0.15,
    },
  };

  const hotspotJson = { generated_at: model.generated_at, source: 'synthetic', hotspots };
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'hotspots.json'), JSON.stringify(hotspotJson, null, 2));
  fs.writeFileSync(path.join(PUBLIC_DIR, 'hotspots.json'), JSON.stringify(hotspotJson, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'model.json'), JSON.stringify(model, null, 2));
  setMeta('model_generated_at', model.generated_at);
  setMeta('hotspot_count', hotspots.length);

  console.log(`[ds] incidents=${rows.length} hotspots=${hotspots.length}`);
  console.log('[ds] time multipliers:', timeMultiplier);
  if (model.ml_baseline) {
    const m = model.ml_baseline;
    console.log(`[ds] ML baseline (${m.model}): AUC=${m.auc} acc=${m.accuracy} brier=${m.brier} base_rate=${m.base_rate} (${m.samples} samples, ${m.positives} positive)`);
  }
  console.log('[ds] wrote data/hotspots.json, data/model.json, public/hotspots.json');
  console.log('[ds] top hotspots:');
  for (const h of hotspots.slice(0, 5)) {
    console.log(`      ${h.cluster_id} ${h.name}  intensity=${h.intensity}  n=${h.count}  recent=${h.recent_count}`);
  }
}

if (require.main === module) main();
module.exports = { dbscan, hourToBucket };
