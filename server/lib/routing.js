'use strict';
/**
 * SafePath safe-route engine.
 *
 * Candidate generation
 *   - OSRM `alternatives=N` on a mode-appropriate profile (foot by default)
 *   - plus "via-point detours": we sample the direct line, find the riskiest
 *     spots on it, and ask OSRM to route through a waypoint pushed
 *     perpendicular to the line, away from the hotspot.
 *   - candidates are de-duplicated, then scored and ranked.
 *
 * Scoring (per candidate, at the chosen departure time)
 *   - sample the polyline every ~30 m
 *   - riskAt() each sample, then mean / p90 / max risk
 *   - high-risk stretch = metres where risk >= HIGH_RISK
 *   - safety score = 100 - (0.6*mean + 0.25*p90 + 0.15*highRiskFrac*100)
 *   - cost = distanceKm + lambda * meanRisk/100 * distanceKm   (lambda from slider)
 *
 * Selection: Fastest (min duration), Safest (max safety), Balanced (min cost).
 *
 * The safety score is an ESTIMATE from reported data, not a guarantee.
 */

const { riskAt, coverageBbox, inCoverage } = require('./risk');
const { sampleLine, haversineM, lineLengthM, destination, toRad, toDeg } = require('./geo');
const { readHotspots } = require('./db');

const HIGH_RISK = 60;
// A route needs this share of its length inside the covered area before its
// safety score means anything. Below it we report "no safety data" instead.
// A route that merely starts in the covered city and then leaves (e.g. Mysuru
// to Mandya) is mostly unknown, so a majority-coverage bar is the honest one.
const COVERED_MIN_FRACTION = 0.6;
// Walking further than this is impractical; the UI warns and suggests another mode.
const LONG_WALK_M = 10000;

const PROFILES = {
  walk: process.env.OSRM_FOOT_URL || 'https://routing.openstreetmap.de/routed-foot/route/v1/foot',
  cycle: process.env.OSRM_BIKE_URL || 'https://routing.openstreetmap.de/routed-bike/route/v1/bike',
  drive: process.env.OSRM_CAR_URL || 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
};

const USER_AGENT =
  process.env.SAFEPATH_UA || 'SafePath/1.0 (safe-route demo; https://github.com/example/safepath)';

/* How close a hotspot must be to count as "on this path". This is the single
   source of truth for proximity: the route cards count with it and the
   navigator warns with it, so the two can never disagree about the same road.
   (They used to differ — 250 m on the card, 150 m in navigation — so a card
   could promise "1 hotspot near" and navigation then say nothing.) */
const HOTSPOT_PROXIMITY_M = 250;

/* --------------------------- HTTP + cache ---------------------------- */
const cacheStore = new Map(); // key -> { at, data }
const CACHE_TTL_MS = 1000 * 60 * 10;
const lastCall = new Map();   // host -> timestamp
const MIN_INTERVAL_MS = 250;  // be gentle with the public demo servers

function cacheKey(o) {
  return JSON.stringify(o);
}

async function throttle(host) {
  const now = Date.now();
  const prev = lastCall.get(host) || 0;
  const wait = MIN_INTERVAL_MS - (now - prev);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall.set(host, Date.now());
}

async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const host = new URL(url).host;
  await throttle(host);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Upstream ${res.status} from ${host}`);
      err.status = res.status;
      err.body = body.slice(0, 300);
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------- OSRM calls ---------------------------- */

function coordsParam(points) {
  return points.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(';');
}

/**
 * One OSRM route request. `points` = [[lat,lng], ...] (2+).
 * Returns [{ coords:[[lat,lng]], distance_m, duration_s, steps? }].
 * With `steps: true` each route also carries the raw OSRM legs/manoeuvres.
 */
async function osrmRoute(points, mode, { alternatives = 0, steps = false } = {}) {
  const profile = PROFILES[mode] || PROFILES.walk;
  const url =
    `${profile}/${coordsParam(points)}` +
    `?overview=full&geometries=geojson&steps=${steps ? 'true' : 'false'}&annotations=false` +
    (alternatives > 0 ? `&alternatives=${alternatives}` : '');

  const key = cacheKey({ url });
  const hit = cacheStore.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const json = await fetchJson(url);
  if (json.code !== 'Ok' || !json.routes || !json.routes.length) {
    const err = new Error(json.message || 'No route found');
    err.code = json.code || 'NoRoute';
    throw err;
  }
  const routes = json.routes.map((r) => ({
    coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    distance_m: r.distance,
    duration_s: r.duration,
    legs: r.legs || null,
  }));
  cacheStore.set(key, { at: Date.now(), data: routes });
  return routes;
}

/* -------------------------- Candidate helpers ------------------------ */

/**
 * Fraction of route `a` that lies within `tolM` of route `b`.
 * The first and last 8% of `a` are trimmed so that a shared approach/exit
 * segment does not by itself make two genuinely different routes look alike.
 */
function overlapFraction(a, b, tolM = 25, trim = 0.08) {
  let sa = sampleLine(a, 30);
  let sb = sampleLine(b, 30);
  if (!sa.length || !sb.length) return 0;
  const cut = Math.floor(sa.length * trim);
  if (sa.length > 3 * cut) sa = sa.slice(cut, sa.length - cut);
  let close = 0;
  for (const [lat, lng] of sa) {
    for (const [blat, blng] of sb) {
      if (haversineM(lat, lng, blat, blng) <= tolM) { close++; break; }
    }
  }
  return close / sa.length;
}

/** Symmetric overlap: a route pair is "the same" only if both directions agree. */
function routeOverlap(a, b) {
  return Math.min(overlapFraction(a, b), overlapFraction(b, a));
}

function dedupe(candidates) {
  const kept = [];
  for (const c of candidates) {
    const dup = kept.find((k) => routeOverlap(k.coords, c.coords) > 0.85);
    if (!dup) kept.push(c);
    else if (c.distance_m < dup.distance_m) {
      // Same road, better geometry: swap in the shorter variant. Never merge the
      // coordinates of two different roads.
      dup.distance_m = c.distance_m;
      dup.duration_s = c.duration_s;
      dup.coords = c.coords;
      dup.source = c.source;
    }
  }
  return kept;
}

/**
 * Bearing (degrees) from point a to point b.
 */
function bearingBetween(a, b) {
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x =
    Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) -
    Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Build via-point detours that steer away from the riskiest spots on the
 * fastest route. Returns extra candidate routes.
 *
 * Strategy: walk the base route, find its highest-risk stretches that are not
 * pinned to the endpoints, then ask OSRM to route through a waypoint pushed
 * perpendicular to the local heading (both flanks), far enough to clear the
 * hotspot's influence. A corridor shift at the midpoint adds a genuinely
 * different path when the base route has no single dominant hotspot.
 */
async function detourCandidates(from, to, mode, departure, { maxDetours = 10 } = {}) {
  const out = [];
  let baseRoute;
  try {
    baseRoute = (await osrmRoute([from, to], mode, { alternatives: 0 }))[0];
  } catch {
    return out;
  }
  const total = baseRoute.distance_m || lineLengthM(baseRoute.coords);
  const samples = sampleLine(baseRoute.coords, 100);

  // cumulative distance + risk per sample
  const withDist = [];
  let cum = 0;
  for (let i = 0; i < samples.length; i++) {
    if (i > 0) cum += haversineM(samples[i - 1][0], samples[i - 1][1], samples[i][0], samples[i][1]);
    withDist.push({
      lat: samples[i][0],
      lng: samples[i][1],
      d: cum,
      r: riskAt(samples[i][0], samples[i][1], departure, { includeComponents: false }).risk,
    });
  }

  // riskiest spots, well away from the endpoints (those cannot be avoided)
  const risky = withDist
    .filter((s) => s.r > 45 && s.d > total * 0.12 && s.d < total * 0.88)
    .sort((a, b) => b.r - a.r);

  const chosen = [];
  for (const s of risky) {
    if (chosen.some((c) => haversineM(c.lat, c.lng, s.lat, s.lng) < 600)) continue;
    chosen.push(s);
    if (chosen.length >= 2) break;
  }

  const tryVia = async (wp) => {
    if (out.length >= maxDetours) return;
    try {
      const rs = await osrmRoute([from, wp, to], mode, { alternatives: 0 });
      out.push({ ...rs[0], via: wp });
    } catch { /* ignore a failed detour */ }
  };

  for (const s of chosen) {
    // local heading at this sample
    const i = withDist.indexOf(s);
    const a = withDist[Math.max(0, i - 1)];
    const b = withDist[Math.min(withDist.length - 1, i + 1)];
    const heading = bearingBetween([a.lat, a.lng], [b.lat, b.lng]);
    // push further for riskier spots, always clearing the 300 m influence zone
    const offset = Math.min(1100, 420 + s.r * 5);
    // choose the flank that is actually calmer
    const flanks = [heading + 90, heading - 90].map((br) => {
      const [lat, lng] = destination(s.lat, s.lng, offset, br);
      return { wp: [lat, lng], r: riskAt(lat, lng, departure, { includeComponents: false }).risk, br };
    });
    flanks.sort((x, y) => x.r - y.r);
    await tryVia(flanks[0].wp);
    if (flanks.length > 1) await tryVia(flanks[1].wp);
  }

  // corridor shifts at one-third and two-thirds, if we still have budget
  if (out.length < maxDetours && total > 1200) {
    const heading = bearingBetween([from[0], from[1]], [to[0], to[1]]);
    const offset = Math.min(900, Math.max(250, total * 0.12));
    for (const frac of [0.35, 0.65]) {
      const mid = withDist[Math.min(withDist.length - 1, Math.floor(withDist.length * frac))];
      await tryVia(destination(mid.lat, mid.lng, offset, heading + 90));
      await tryVia(destination(mid.lat, mid.lng, offset, heading - 90));
    }
  }

  return out;
}

/* ------------------------------ Scoring ------------------------------ */

function scoreRoute(candidate, departure) {
  const stepM = 30;
  const samples = sampleLine(candidate.coords, stepM);
  const lengthM = candidate.distance_m || lineLengthM(candidate.coords);
  const actualStep = samples.length > 1 ? lengthM / (samples.length - 1) : lengthM;

  let sum = 0, max = 0;
  const risks = [];
  const segRisks = [];
  // How much of this route is inside the area the model has data for? A route
  // far outside coverage would otherwise score a falsely reassuring 100, since
  // uncovered ground contributes 0 risk.
  const cover = coverageBbox();
  let coveredSamples = 0;
  for (const [lat, lng] of samples) {
    const r = riskAt(lat, lng, departure, { includeComponents: false }).risk;
    const inside = inCoverage(lat, lng, cover);
    segRisks.push(r);
    if (inside) {
      // Only covered samples feed the score: unknown ground is not "safe".
      risks.push(r);
      sum += r;
      if (r > max) max = r;
      coveredSamples++;
    }
  }
  const coveredFrac = samples.length ? coveredSamples / samples.length : 0;
  const covered = coveredFrac >= COVERED_MIN_FRACTION;
  const mean = risks.length ? sum / risks.length : 0;
  const sorted = [...risks].sort((a, b) => a - b);
  const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : 0;

  let highLenM = 0;
  for (const r of risks) if (r >= HIGH_RISK) highLenM += actualStep;
  const highFrac = lengthM > 0 ? highLenM / lengthM : 0;

  // total exposure = integral of risk over distance (risk-metres).
  // risk per km travelled is simply the mean risk along the path.
  const riskMeters = risks.reduce((a, r) => a + r * actualStep, 0);

  // One composite risk per km, so the exposure number and the safety score can
  // never disagree: safety = 100 - exposure. The mean dominates; p90 and the
  // share of the route in high-risk areas add the "worst stretch" penalties.
  const exposure = 0.6 * mean + 0.25 * p90 + 0.15 * highFrac * 100;
  const safety = clamp(100 - exposure, 0, 100);

  return {
    ...candidate,
    samples,
    seg_risks: segRisks,
    length_m: Math.round(lengthM),
    mean_risk: +mean.toFixed(1),
    p90_risk: +p90.toFixed(1),
    max_risk: +max.toFixed(1),
    high_risk_m: Math.round(highLenM),
    high_risk_frac: +highFrac.toFixed(3),
    risk_meters: Math.round(riskMeters),
    exposure_per_km: +exposure.toFixed(1),
    safety_score: +safety.toFixed(1),
    covered,
    covered_fraction: +coveredFrac.toFixed(3),
  };
}

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

/** Cost in km-equivalent: distance + lambda * risk-weighted distance. */
function costOf(route, lambda) {
  const km = route.length_m / 1000;
  return km + lambda * (route.exposure_per_km / 100) * km;
}

/* -------------------------- Route enrichment ------------------------- */

/** Which hotspots does this path come near? */
function hotspotsNear(route, hotspots, radiusM = HOTSPOT_PROXIMITY_M) {
  const pts = sampleLine(route.coords, 60);
  const hits = [];
  for (const h of hotspots) {
    let min = Infinity;
    for (const [lat, lng] of pts) {
      const d = haversineM(lat, lng, h.lat, h.lng);
      if (d < min) min = d;
    }
    if (min <= radiusM) hits.push({ ...h, distance_m: Math.round(min) });
  }
  return hits;
}

/** Share of the path on lit roads, from OSM street lamps. */
function litFraction(route) {
  const { getCache } = require('./risk');
  const c = getCache();
  const pts = sampleLine(route.coords, 30);
  if (!pts.length) return 0;
  let lit = 0;
  for (const [lat, lng] of pts) {
    if (c.lamps.within(lat, lng, 60).length > 0) lit++;
  }
  return +(lit / pts.length).toFixed(3);
}

/** Protective POIs passed along the path (within 150 m). */
function helpAlong(route) {
  const pts = sampleLine(route.coords, 50);
  const { getCache } = require('./risk');
  const c = getCache();
  const counts = { police: 0, hospital: 0, shop: 0, fuel: 0, bus_stop: 0 };
  const seen = new Set();
  for (const [lat, lng] of pts) {
    for (const { row } of c.help.within(lat, lng, 150)) {
      const key = `${row.kind}:${row.lat.toFixed(4)}:${row.lng.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts[row.kind] = (counts[row.kind] || 0) + 1;
    }
  }
  return counts;
}

/* ------------------------- Reasons (real data) ----------------------- */

function explainRoute(route, fastest, avoidedHotspots, mode, opts = {}) {
  const reasons = [];
  const modeWord = mode === 'walk' ? 'walking' : mode === 'cycle' ? 'cycling' : 'driving';
  const { uncoveredPlan = false, coverage = null } = opts;

  // Outside the covered area there is no data to reason from: say so plainly
  // instead of emitting reassuring but meaningless reasons.
  if (!route.covered) {
    reasons.push(
      'No safety data for this area. This route lies outside the area SafePath has reported incidents for, so no safety score is shown.'
    );
    if (coverage) {
      reasons.push(
        `SafePath currently covers about ${coverage.incidents} incidents near the seeded city area only.`
      );
    }
    const minsU = Math.round((route.duration_s - fastest.duration_s) / 60);
    if (route.is_fastest) reasons.push('This is the quickest option.');
    else if (minsU >= 1) reasons.push(`+${minsU} min vs the fastest ${modeWord} route.`);
    else if (minsU <= -1) reasons.push(`${-minsU} min faster than the fastest route.`);
    else reasons.push('About the same time as the fastest route.');
    if (route.extra_time_warning) reasons.push(route.extra_time_warning);
    return reasons;
  }

  if (avoidedHotspots.length) {
    const names = [...new Set(avoidedHotspots.map((h) => h.name))].slice(0, 2).join(', ');
    reasons.push(
      `Avoids ${avoidedHotspots.length} reported hotspot${avoidedHotspots.length > 1 ? 's' : ''}` +
      (names ? ` near ${names}` : '') + '.'
    );
  }
  const litPct = Math.round(route.lit_fraction * 100);
  if (litPct >= 40) reasons.push(`${litPct}% of this route is on roads with nearby street lighting.`);
  else if (litPct > 0) reasons.push(`Only ${litPct}% of this route has nearby street lighting.`);
  else reasons.push('No street lamps mapped close to this route — treat it as unlit after dark.');

  const h = route.help_along || {};
  const bits = [];
  if (h.shop) bits.push(`${h.shop} open shop${h.shop > 1 ? 's' : ''}`);
  if (h.police) bits.push(`${h.police} police station${h.police > 1 ? 's' : ''}`);
  if (h.hospital) bits.push(`${h.hospital} hospital${h.hospital > 1 ? 's' : ''}`);
  if (h.fuel) bits.push(`${h.fuel} fuel station${h.fuel > 1 ? 's' : ''}`);
  if (bits.length) reasons.push(`Passes ${bits.join(' and ')} within 150 m.`);

  if (route.hotspots_near.length) {
    reasons.push(
      `Still passes ${route.hotspots_near.length} hotspot${route.hotspots_near.length > 1 ? 's' : ''} — ` +
      `worst is ${route.hotspots_near[0].name} (${route.hotspots_near[0].distance_m} m away).`
    );
  } else {
    reasons.push('No known hotspot within 250 m of the path.');
  }

  const mins = Math.round((route.duration_s - fastest.duration_s) / 60);
  if (route.role === 'alternative') {
    reasons.push(
      'No candidate route scored meaningfully safer than the fastest one here, so this is a distinct alternative rather than a "safest" pick.'
    );
  } else if (route.is_fastest) reasons.push('This is the quickest option.');
  else if (mins >= 1) reasons.push(`+${mins} min vs the fastest ${modeWord} route.`);
  else if (mins <= -1) reasons.push(`${-mins} min faster than the fastest route.`);
  else reasons.push('About the same time as the fastest route.');

  if (route.high_risk_m > 0) {
    reasons.push(`${(route.high_risk_m / 1000).toFixed(2)} km runs through high-risk areas (risk ≥ ${HIGH_RISK}).`);
  }
  if (!route.is_fastest) {
    if (route.mean_risk_delta >= 1.5) {
      reasons.push(
        `Average reported risk is ${route.mean_risk_delta.toFixed(1)} points lower than the fastest route (${route.mean_risk} vs ${fastest.mean_risk} per km).`
      );
    }
    if (route.high_risk_m < fastest.high_risk_m - 50) {
      reasons.push(
        `Avoids ${((fastest.high_risk_m - route.high_risk_m) / 1000).toFixed(2)} km of high-risk walking compared with the fastest route.`
      );
    }
  }
  if (route.insight_note) reasons.push(route.insight_note);
  if (route.extra_time_warning) reasons.push(route.extra_time_warning);

  return reasons;
}

/* ------------------------------- Entry ------------------------------- */

/**
 * @param {object} req
 * @param {[number,number]} req.from [lat,lng]
 * @param {[number,number]} req.to   [lat,lng]
 * @param {'walk'|'cycle'|'drive'} [req.mode]
 * @param {Date|string|number} [req.departure]
 * @param {number} [req.lambda] 0..5 safety-vs-speed weight
 */
async function planRoutes(req) {
  const from = req.from;
  const to = req.to;
  const mode = PROFILES[req.mode] ? req.mode : 'walk';
  const departure = req.departure ? new Date(req.departure) : new Date();
  const lambda = typeof req.lambda === 'number' ? clamp(req.lambda, 0, 5) : 1.5;

  const hotspots = readHotspots();
  const candidates = [];

  // 1) OSRM alternatives on the chosen profile
  try {
    const alts = await osrmRoute([from, to], mode, { alternatives: 3 });
    alts.forEach((r) => candidates.push({ ...r, source: 'osrm_alternative' }));
  } catch (err) {
    const e = new Error(`Routing service unavailable: ${err.message}`);
    e.status = 502;
    throw e;
  }

  // 2) via-point detours that push away from high-risk cells
  try {
    const detours = await detourCandidates(from, to, mode, departure, { maxDetours: 4 });
    detours.forEach((r) => candidates.push({ ...r, source: 'via_detour' }));
  } catch {
    /* detours are best-effort */
  }

  let deduped = dedupe(candidates);
  if (!deduped.length) {
    const e = new Error('No route could be computed between those points.');
    e.status = 404;
    throw e;
  }

  // Score every candidate.
  let scored = deduped.map((c) => scoreRoute(c, departure));
  scored.forEach((r) => {
    r.hotspots_near = hotspotsNear(r, hotspots);
    r.lit_fraction = litFraction(r);
    r.help_along = helpAlong(r);
  });

  const coverage = coverageBbox();
  // Does this plan carry any safety information at all? If no candidate reaches
  // the covered area, every route would score an identical, meaningless 100.
  const anyCovered = scored.some((r) => r.covered);
  const uncoveredPlan = !anyCovered;

  // Select Fastest / Safest / Balanced. Safety ordering uses the same composite
  // exposure that the cards show, so a card labelled "safest" can never display
  // a lower safety score than "fastest".
  const bySafety = [...scored].sort(
    (a, b) => b.safety_score - a.safety_score || a.duration_s - b.duration_s
  );
  const fastest = scored.reduce((a, b) => (b.duration_s < a.duration_s ? b : a));
  const balanced = scored.reduce((a, b) => (costOf(b, lambda) < costOf(a, lambda) ? b : a));

  const roles = new Map();
  roles.set(fastest, 'fastest');

  // "Safest" is only meaningful if it is actually safer than the fastest route.
  // If nothing beats the fastest route's safety, the fastest route is also the
  // safest and there is no separate safest option to advertise. When the whole
  // plan is outside the covered area there is nothing to compare, so we skip
  // the safety ranking entirely and just present distinct alternatives.
  const saferThanFastest = uncoveredPlan
    ? []
    : bySafety.filter((r) => r.safety_score > fastest.safety_score + 0.05);
  const safest = saferThanFastest[0] || null;
  if (safest && safest !== fastest) roles.set(safest, 'safest');

  // Balanced sits between the fastest and the safest where a distinct route exists.
  const used = new Set([...roles.keys()]);
  if (!used.has(balanced)) { roles.set(balanced, 'balanced'); used.add(balanced); }
  else {
    const pool = scored.filter((r) => !used.has(r));
    if (pool.length) {
      let pick;
      if (safest) {
        // There is a real safer option, so "balanced" should sit between the
        // two: pick the candidate whose safety is closest to the midpoint.
        const lo = Math.min(fastest.safety_score, safest.safety_score);
        const hi = Math.max(fastest.safety_score, safest.safety_score);
        const mid = (lo + hi) / 2;
        pick = pool.sort(
          (a, b) => Math.abs(a.safety_score - mid) - Math.abs(b.safety_score - mid) ||
                    costOf(a, lambda) - costOf(b, lambda)
        )[0];
      } else {
        // Nothing is safer than the fastest, so there is no safety/time
        // trade-off to balance: the best remaining option is simply the
        // cheapest one by the cost function, never a strictly worse road.
        pick = pool.sort((a, b) => costOf(a, lambda) - costOf(b, lambda))[0];
      }
      roles.set(pick, 'balanced');
      used.add(pick);
    }
  }

  // Fill "safest" only if it is genuinely safer than what is already labelled.
  if (![...roles.values()].includes('safest')) {
    const pool = scored.filter((r) => !used.has(r) && r.safety_score > fastest.safety_score + 0.05);
    if (pool.length) {
      const pick = pool.sort((a, b) => b.safety_score - a.safety_score)[0];
      roles.set(pick, 'safest');
      used.add(pick);
    }
  }

  // If there is no route meaningfully safer than the fastest one, the fastest
  // route is also the safest. Rather than mislabel a less-safe road as "Safest",
  // show the next distinct candidate honestly as an "alternative".
  if (![...roles.values()].includes('safest') && roles.size < 3) {
    const pool = scored.filter((r) => !used.has(r));
    if (pool.length) {
      const pick = pool.sort((a, b) => a.duration_s - b.duration_s)[0];
      roles.set(pick, 'alternative');
      used.add(pick);
    }
  }

  const out = [];
  for (const [route, role] of roles) {
    route.is_fastest = route === fastest;
    route.role = role;
    route.cost = +costOf(route, lambda).toFixed(3);
    const extra = route.duration_s - fastest.duration_s;
    const extraPct = fastest.duration_s > 0 ? extra / fastest.duration_s : 0;
    route.extra_time_s = Math.round(extra);
    route.extra_time_pct = +(extraPct * 100).toFixed(1);
    if (route !== fastest && extraPct > 0.4) {
      const label = route.role === 'alternative' ? 'This option' : 'This safer option';
      route.extra_time_warning =
        `${label} takes ${Math.round(extra / 60)} min more (${Math.round(extraPct * 100)}% longer) than the fastest route.`;
    }
    const avoided = hotspots.filter(
      (h) => fastest.hotspots_near.some((f) => f.cluster_id === h.cluster_id) &&
             !route.hotspots_near.some((r2) => r2.cluster_id === h.cluster_id)
    );
    route.avoided_hotspots = avoided;
    // Exposure is the integral of risk along the path (risk-metres). Compare
    // like with like: mean risk per km walked, which is length-independent.
    const delta = fastest.mean_risk - route.mean_risk;
    route.exposure_reduction_vs_fastest = +(delta / Math.max(0.1, fastest.mean_risk) * 100).toFixed(1);
    route.mean_risk_delta = +delta.toFixed(1);
    if (!route.is_fastest && route.mean_risk_delta < 1.5 && route.high_risk_m >= fastest.high_risk_m - 50) {
      route.insight_note =
        'At this time of day every option on this corridor carries about the same reported risk, so the safer choice here is mostly about convenience. Consider a different departure time, or travel with company.';
    }
    route.reasons = explainRoute(route, fastest, avoided, mode, { uncoveredPlan, coverage });
    out.push(route);
  }

  // order: safest, balanced, alternative, fastest for display
  const order = { safest: 0, balanced: 1, alternative: 2, fastest: 3 };
  out.sort((a, b) => order[a.role] - order[b.role]);

  // Honest note when the "alternatives" are essentially the same road.
  let samenessNote = null;
  if (out.length > 1) {
    const others = out.filter((r) => !r.is_fastest);
    const minOverlap = others.length
      ? Math.min(...others.map((r) => routeOverlap(fastest.coords, r.coords)))
      : 0;
    if (minOverlap > 0.6) {
      samenessNote =
        'The alternative routes here follow much the same roads, so their safety scores are close. There is no clearly different corridor to offer between these two points.';
    }
  }

  // Walking is impractical beyond ~10 km; say so rather than hide it.
  let longWalkWarning = null;
  if (mode === 'walk') {
    const longest = Math.max(...out.map((r) => r.length_m));
    if (longest > LONG_WALK_M) {
      longWalkWarning =
        `This is a very long walking route (${(longest / 1000).toFixed(1)} km). Consider cycling or driving instead.`;
    }
  }

  return {
    mode,
    departure: departure.toISOString(),
    lambda,
    candidate_count: scored.length,
    coverage: coverage
      ? {
          bbox: [coverage.minLat, coverage.minLng, coverage.maxLat, coverage.maxLng],
          incidents: coverage.incidents,
          reports: coverage.reports,
        }
      : null,
    covered: !uncoveredPlan,
    uncovered_note: uncoveredPlan
      ? 'No safety data for this area. These routes are outside the area SafePath has reported incidents for, so no safety score is shown.'
      : null,
    sameness_note: samenessNote,
    long_walk_warning: longWalkWarning,
    routes: out.map(serialiseRoute),
    hotspots,
    disclaimer: 'Estimate based on reported data, not a guarantee of safety.',
  };
}

/** Strip heavy fields; keep polyline + segment risks for the map. */
function serialiseRoute(r) {
  return {
    role: r.role,
    source: r.source,
    is_fastest: !!r.is_fastest,
    coords: r.coords.map(([lat, lng]) => [+lat.toFixed(6), +lng.toFixed(6)]),
    path: r.samples.map(([lat, lng]) => [+lat.toFixed(6), +lng.toFixed(6)]),
    seg_risks: r.seg_risks.map((x) => Math.round(x)),
    distance_m: r.length_m,
    duration_s: Math.round(r.duration_s),
    safety_score: r.safety_score,
    mean_risk: r.mean_risk,
    p90_risk: r.p90_risk,
    max_risk: r.max_risk,
    high_risk_m: r.high_risk_m,
    high_risk_frac: r.high_risk_frac,
    exposure_per_km: r.exposure_per_km,
    risk_meters: r.risk_meters,
    cost: r.cost,
    covered: !!r.covered,
    covered_fraction: r.covered_fraction,
    extra_time_s: r.extra_time_s,
    extra_time_pct: r.extra_time_pct,
    exposure_reduction_vs_fastest: r.exposure_reduction_vs_fastest,
    mean_risk_delta: r.mean_risk_delta,
    insight_note: r.insight_note || null,
    lit_fraction: r.lit_fraction,
    help_along: r.help_along,
    hotspots_near: r.hotspots_near.map((h) => ({
      cluster_id: h.cluster_id, name: h.name, lat: h.lat, lng: h.lng,
      intensity: h.intensity, count: h.count, distance_m: h.distance_m,
    })),
    avoided_hotspots: (r.avoided_hotspots || []).map((h) => ({
      cluster_id: h.cluster_id, name: h.name, lat: h.lat, lng: h.lng, intensity: h.intensity,
    })),
    reasons: r.reasons,
    via: r.via || null,
  };
}

module.exports = {
  planRoutes, osrmRoute, scoreRoute, hotspotsNear, detourCandidates, dedupe,
  PROFILES, HIGH_RISK, HOTSPOT_PROXIMITY_M,
};
