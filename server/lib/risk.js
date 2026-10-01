'use strict';
/**
 * SafePath risk model.
 *
 * A transparent, additive weighted formula (see README -> "How the safety score
 * is calculated"). Everything is derived from the incidents / reports /
 * road_features tables; nothing is hard-coded per neighbourhood.
 *
 *   raw =  w_density * densityNorm
 *        + w_severity * severityRecencyNorm * timeMultiplier(bucket)
 *        + w_lighting * darkness
 *        + w_crowd    * emptiness
 *        - w_protective * protectiveNorm
 *
 *   risk = clamp(raw, 0, 1) * 100      // 0 = calm, 100 = highest reported risk
 *
 * "risk" is an ESTIMATE from reported data, never a guarantee of safety.
 */

const fs = require('node:fs');
const path = require('node:path');
const { all, get, getMeta } = require('./db');
const { haversineM, toRad } = require('./geo');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');

const DEFAULTS = {
  sigma_m: 120,          // Gaussian distance-decay scale
  max_influence_m: 300,  // beyond this an incident has no effect
  recency_halflife_days: 180,
  sat_density: 3.0,      // saturation constant for the count term
  sat_severity: 1.6,     // saturation constant for the severity*recency term
  weights: {
    incident_density: 0.40,
    severity_recency: 0.25,
    lighting: 0.12,
    crowd: 0.08,
    protective: 0.15,
  },
  time_multiplier: { morning: 0.75, afternoon: 0.6, evening: 1.1, night: 1.6 },
  help_radius_m: 400,
  lamp_radius_m: 60,
  report_radius_m: 250,
};

function hourToBucket(h) {
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

function loadParams() {
  let params = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'model.json'), 'utf8'));
    params = {
      ...DEFAULTS,
      ...raw,
      weights: { ...DEFAULTS.weights, ...(raw.weights || {}) },
      time_multiplier: { ...DEFAULTS.time_multiplier, ...(raw.time_multiplier || {}) },
      sigma_m: raw.decay?.gaussian_sigma_m ?? DEFAULTS.sigma_m,
      max_influence_m: raw.decay?.max_influence_m ?? DEFAULTS.max_influence_m,
      recency_halflife_days: raw.recency_halflife_days ?? DEFAULTS.recency_halflife_days,
    };
  } catch {
    /* no model.json yet -> use defaults */
  }
  return params;
}

/* --------------------------- Spatial index --------------------------- */
const CELL_DEG = 0.004; // ~440 m

function makeIndex(rows) {
  const cells = new Map();
  const key = (lat, lng) => `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;
  rows.forEach((r, i) => {
    const k = key(r.lat, r.lng);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(i);
  });
  return {
    rows,
    key,
    /** rows within `radiusM` of (lat,lng) */
    within(lat, lng, radiusM) {
      const out = [];
      const spanLat = Math.ceil(radiusM / 111320 / CELL_DEG) + 1;
      const spanLng = Math.ceil(radiusM / (111320 * Math.max(0.1, Math.cos(toRad(lat)))) / CELL_DEG) + 1;
      const cl = Math.floor(lat / CELL_DEG);
      const cn = Math.floor(lng / CELL_DEG);
      for (let i = cl - spanLat; i <= cl + spanLat; i++) {
        for (let j = cn - spanLng; j <= cn + spanLng; j++) {
          const bucket = cells.get(`${i}:${j}`);
          if (!bucket) continue;
          for (const idx of bucket) {
            const r = rows[idx];
            const d = haversineM(lat, lng, r.lat, r.lng);
            if (d <= radiusM) out.push({ row: r, dist: d });
          }
        }
      }
      return out;
    },
  };
}

/* ------------------------------ Cache -------------------------------- */
let cache = null;

/**
 * SQLite bumps `PRAGMA data_version` whenever another connection commits a
 * write. Watching it lets the cache notice out-of-band edits (a re-seed, or a
 * test cleaning up its probe rows) instead of serving stale counts until the
 * next explicit reload().
 */
function dataVersion() {
  try {
    const row = get('PRAGMA data_version');
    return row ? Object.values(row)[0] : null;
  } catch {
    return null;
  }
}

/** (Re)load incidents, reports and road features from the DB. */
function reload() {
  const params = loadParams();
  const incidents = all(
    'SELECT id, lat, lng, type, severity, timestamp, verified, source FROM incidents'
  ).map((r) => ({
    ...r,
    t: new Date(r.timestamp).getTime(),
    sevW: Math.max(1, Math.min(5, r.severity)) / 5,
  }));
  const reports = all(
    'SELECT id, lat, lng, type, lighting, crowd, severity, created_at FROM reports'
  ).map((r) => ({ ...r, t: new Date(r.created_at).getTime() }));

  const features = all('SELECT lat, lng, kind, name, meta FROM road_features').map((f) => ({
    ...f,
    meta: f.meta ? safeJson(f.meta) : null,
  }));

  cache = {
    params,
    incidents: makeIndex(incidents),
    reports: makeIndex(reports),
    lamps: makeIndex(features.filter((f) => f.kind === 'street_lamp')),
    help: makeIndex(features.filter((f) => ['police', 'hospital', 'shop', 'fuel', 'bus_stop'].includes(f.kind))),
    features,
    counts: {
      incidents: incidents.length,
      reports: reports.length,
      features: features.length,
      lamps: features.filter((f) => f.kind === 'street_lamp').length,
      police: features.filter((f) => f.kind === 'police').length,
      hospitals: features.filter((f) => f.kind === 'hospital').length,
      shops: features.filter((f) => f.kind === 'shop').length,
    },
    loadedAt: Date.now(),
    dataVersion: dataVersion(),
  };
  return cache;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function ctx() {
  if (!cache) reload();
  else if (cache.dataVersion !== dataVersion()) reload();
  return cache;
}

/* ---------------------------- Risk kernel ---------------------------- */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Compute the risk at a point and time.
 * @param {number} lat
 * @param {number} lng
 * @param {Date|string|number} [time]  departure time (defaults to now)
 * @param {object} [opts] { includeComponents: boolean }
 * @returns {object} { risk, bucket, components, nearby }
 */
function riskAt(lat, lng, time = new Date(), opts = {}) {
  const c = ctx();
  const p = c.params;
  const t = time instanceof Date ? time : new Date(time);
  const bucket = hourToBucket(isNaN(t.getTime()) ? new Date().getHours() : t.getHours());
  const timeMult = p.time_multiplier[bucket] ?? 1;
  const nowMs = Date.now();

  /* --- incident density + severity/recency --- */
  const sigma2 = 2 * p.sigma_m * p.sigma_m;
  let densityRaw = 0;
  let sevRaw = 0;
  let nearest = [];
  for (const { row, dist } of c.incidents.within(lat, lng, p.max_influence_m)) {
    const decay = Math.exp(-(dist * dist) / sigma2);
    const ageDays = Math.max(0, (nowMs - row.t) / 864e5);
    const recency = Math.pow(0.5, ageDays / p.recency_halflife_days);
    const w = row.sevW * recency;
    densityRaw += decay;
    sevRaw += w * decay;
    nearest.push({ dist, decay, w, type: row.type, severity: row.severity, ageDays });
  }
  nearest.sort((a, b) => b.w * b.decay - a.w * a.decay);

  const densityNorm = 1 - Math.exp(-densityRaw / p.sat_density);
  // Time of day scales the whole reported-incident signal (density + severity
  // + recency). The multiplier is learned from the observed incident mix in
  // ds/build.js, normalised so its mean across the four buckets is 1.
  const sevNorm = clamp01(sevRaw * timeMult / p.sat_severity);
  const densityTime = clamp01(densityNorm * timeMult);

  /* --- community report signals: lighting + crowd --- */
  const rep = c.reports.within(lat, lng, p.report_radius_m);
  let darkSum = 0, darkW = 0, emptySum = 0, emptyW = 0, repRisk = 0;
  for (const { row, dist } of rep) {
    const decay = Math.exp(-(dist * dist) / sigma2);
    const ageDays = Math.max(0, (nowMs - row.t) / 864e5);
    const recency = Math.pow(0.5, ageDays / p.recency_halflife_days);
    const w = decay * recency;
    if (row.lighting != null) { darkSum += ((5 - row.lighting) / 4) * w; darkW += w; }
    if (row.crowd != null) { emptySum += ((5 - row.crowd) / 4) * w; emptyW += w; }
    repRisk += w * (Math.max(1, Math.min(5, row.severity || 3)) / 5);
  }

  /* --- OSM-derived signals --- */
  const lamps = c.lamps.within(lat, lng, p.lamp_radius_m).length;
  const litProxy = clamp01(1 - Math.exp(-lamps / 1.5)); // 0 = unlit, 1 = well lit

  const nearHelp = c.help.within(lat, lng, p.help_radius_m);
  let helpScore = 0;
  const helpCounts = { police: 0, hospital: 0, shop: 0, fuel: 0, bus_stop: 0 };
  for (const { row } of nearHelp) {
    const k = row.kind;
    helpCounts[k] = (helpCounts[k] || 0) + 1;
    if (k === 'police') helpScore += 1.0;
    else if (k === 'hospital') helpScore += 0.9;
    else if (k === 'shop') helpScore += row.meta?.openLate ? 0.7 : 0.4;
    else if (k === 'fuel') helpScore += 0.5;
    else if (k === 'bus_stop') helpScore += 0.3;
  }
  const helpNorm = clamp01(1 - Math.exp(-helpScore / 2.2));

  // darkness: blend community lighting reports with the OSM lamp proxy.
  const darknessReport = darkW > 0 ? darkSum / darkW : null;
  const darkness = darknessReport == null
    ? clamp01(1 - litProxy)
    : clamp01(0.6 * darknessReport + 0.4 * (1 - litProxy));

  // An unlit road only matters when it is actually dark, so the lighting term
  // scales with the time of day as well.
  const darkTimeFactor = bucket === 'night' ? 1.0 : bucket === 'evening' ? 0.65 : 0.25;
  const darknessTime = darkness * darkTimeFactor;

  // emptiness: only meaningful in the evening/night.
  const emptinessReport = emptyW > 0 ? emptySum / emptyW : 0;
  const nightWeight = bucket === 'night' ? 1 : bucket === 'evening' ? 0.7 : 0.3;
  const emptiness = clamp01(emptinessReport * nightWeight);

  const protectiveNorm = clamp01(0.55 * helpNorm + 0.45 * litProxy);

  /* --- combine --- */
  const w = p.weights;
  const terms = {
    incident_density: w.incident_density * densityTime,
    severity_recency: w.severity_recency * sevNorm,
    lighting: w.lighting * darknessTime,
    crowd: w.crowd * emptiness,
    protective: -(w.protective * protectiveNorm),
  };
  const raw = Object.values(terms).reduce((a, b) => a + b, 0);
  const risk = Math.round(clamp01(raw) * 1000) / 10; // one decimal, 0..100

  const out = {
    lat, lng,
    risk,
    bucket,
    time_multiplier: timeMult,
    nearest_hotspot_m: nearest.length ? Math.round(nearest[0].dist) : null,
    counts: { incidents_nearby: nearest.length, reports_nearby: rep.length, lamps_nearby: lamps, ...helpCounts },
  };
  if (opts.includeComponents !== false) {
    out.components = {
      density_norm: +densityNorm.toFixed(4),
      density_time_scaled: +densityTime.toFixed(4),
      severity_recency_norm: +sevNorm.toFixed(4),
      darkness: +darkness.toFixed(4),
      darkness_time_scaled: +darknessTime.toFixed(4),
      emptiness: +emptiness.toFixed(4),
      protective_norm: +protectiveNorm.toFixed(4),
      weighted: Object.fromEntries(Object.entries(terms).map(([k, v]) => [k, +v.toFixed(4)])),
    };
  }
  return out;
}

/** Convenience: mean of several sampled risks. */
function meanRisk(samples) {
  if (!samples.length) return 0;
  return samples.reduce((a, s) => a + s.risk, 0) / samples.length;
}

/**
 * Risk heatmap over a bbox.
 * @param {number[]} bbox [minLat, minLng, maxLat, maxLng]
 * @param {Date|string|number} time
 * @param {number} cells target number of cells along the longer axis
 */
function riskGrid(bbox, time = new Date(), cells = 48) {
  const [minLat, minLng, maxLat, maxLng] = bbox;
  const spanLat = Math.max(1e-6, maxLat - minLat);
  const spanLng = Math.max(1e-6, maxLng - minLng);
  const step = Math.max(spanLat, spanLng) / Math.max(4, Math.min(80, cells));
  const points = [];
  let max = 0, sum = 0;
  for (let lat = minLat; lat <= maxLat + 1e-9; lat += step) {
    for (let lng = minLng; lng <= maxLng + 1e-9; lng += step) {
      const r = riskAt(lat, lng, time, { includeComponents: false });
      points.push([+lat.toFixed(6), +lng.toFixed(6), r.risk]);
      if (r.risk > max) max = r.risk;
      sum += r.risk;
    }
  }
  return { step_deg: step, max, mean: points.length ? +(sum / points.length).toFixed(2) : 0, points };
}

/** Risk at a specific time bucket, for charts. */
function bucketAverages(bbox, cells = 16) {
  const out = {};
  const base = new Date();
  const hours = { morning: 9, afternoon: 14, evening: 19, night: 23 };
  for (const [b, h] of Object.entries(hours)) {
    const t = new Date(base);
    t.setHours(h, 0, 0, 0);
    out[b] = riskGrid(bbox, t, cells).mean;
  }
  return out;
}

/**
 * The area the model actually has data for: a bbox around the seeded/imported
 * incidents and reports, padded slightly. Routes that fall outside this box
 * carry no safety information, so the UI must say so instead of showing a
 * reassuring score.
 *
 * The box is trimmed to the 1st-99th percentile of each axis so a single stray
 * report (a one-off far-away point) cannot stretch coverage across the state.
 *
 * @param {number} [padDeg] padding in degrees (default ~1.5 km)
 * @returns {{minLat:number,minLng:number,maxLat:number,maxLng:number,incidents:number,reports:number}|null}
 */
function coverageBbox(padDeg = 0.015) {
  const c = ctx();
  const pts = [...c.incidents.rows, ...c.reports.rows];
  if (!pts.length) return null;
  const pct = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))];
  };
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  return {
    minLat: +(pct(lats, 0.01) - padDeg).toFixed(6),
    minLng: +(pct(lngs, 0.01) - padDeg).toFixed(6),
    maxLat: +(pct(lats, 0.99) + padDeg).toFixed(6),
    maxLng: +(pct(lngs, 0.99) + padDeg).toFixed(6),
    incidents: c.incidents.rows.length,
    reports: c.reports.rows.length,
  };
}

/**
 * Is a point inside the covered area? A small tolerance keeps points just
 * outside the padded box from being reported as uncovered.
 */
function inCoverage(lat, lng, bbox = coverageBbox(), tolDeg = 0.01) {
  if (!bbox) return false;
  return lat >= bbox.minLat - tolDeg && lat <= bbox.maxLat + tolDeg &&
         lng >= bbox.minLng - tolDeg && lng <= bbox.maxLng + tolDeg;
}

/** Road features (lamps, help points) inside a bbox, for the map layers. */
function featuresInBbox(bbox, kinds = null, limit = 4000) {
  const c = ctx();
  const [minLat, minLng, maxLat, maxLng] = bbox;
  const out = [];
  for (const f of c.features) {
    if (f.lat < minLat || f.lat > maxLat || f.lng < minLng || f.lng > maxLng) continue;
    if (kinds && !kinds.includes(f.kind)) continue;
    out.push({ lat: +f.lat.toFixed(6), lng: +f.lng.toFixed(6), kind: f.kind, name: f.name || null });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = {
  riskAt, riskGrid, meanRisk, reload, loadParams, hourToBucket, bucketAverages, DEFAULTS,
  coverageBbox, inCoverage, featuresInBbox,
  getCache: () => ctx(),
};
