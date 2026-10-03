/* ==========================================================================
   SafePath navigation payload
   --------------------------------------------------------------------------
   Everything the turn-by-turn screen needs for one trip, assembled server-side
   so the browser does not have to make several calls while the user is walking:

     - turn-by-turn steps (from OSRM `steps=true`)
     - hazards positioned along the route: hotspots to warn about and poorly lit
       stretches
     - a live safety read of the road ahead (recomputed on demand, because the
       time of day changes what is risky)
     - a safer alternative, computed only when the client asks (off-route)

   The safety numbers are estimates from reported data, not guarantees.
   ========================================================================== */
'use strict';

const { riskAt, coverageBbox, inCoverage } = require('./risk');
const { sampleLine, haversineM, lineLengthM } = require('./geo');
const { readHotspots } = require('./db');
const { osrmRoute, scoreRoute, HOTSPOT_PROXIMITY_M } = require('./routing');
const { buildSteps } = require('./nav_steps');

// A hotspot counts as "on the way" if the route passes within this distance.
// Shared with the route cards so a card can never promise a hotspot that
// navigation then fails to mention.
const HAZARD_RADIUS_M = HOTSPOT_PROXIMITY_M;
// Below this risk a stretch is not worth interrupting the user about.
const HAZARD_MIN_RISK = 45;
// A stretch with no lamp within this distance counts as unlit.
const UNLIT_RADIUS_M = 60;
// Unlit stretches shorter than this are noise, not a warning.
const UNLIT_MIN_LENGTH_M = 120;
const UNLIT_MIN_RISK = 30;

/**
 * Distance along the route of every sample, with its risk, in one pass.
 * Shared by the hazard builder and the "risk ahead" read.
 */
function riskProfile(coords, departure) {
  const samples = sampleLine(coords, 30);
  const cum = [0];
  for (let i = 1; i < samples.length; i++) {
    cum.push(cum[i - 1] + haversineM(samples[i - 1][0], samples[i - 1][1], samples[i][0], samples[i][1]));
  }
  const cover = coverageBbox();
  const rows = samples.map((p, i) => ({
    lat: p[0],
    lng: p[1],
    along_m: cum[i],
    risk: riskAt(p[0], p[1], departure, { includeComponents: false }).risk,
    covered: inCoverage(p[0], p[1], cover),
  }));
  return { rows, total_m: cum[cum.length - 1] || 0, covered: cover };
}

/**
 * Hazards to warn about, each positioned by how far along the route it is.
 * Two kinds:
 *   - hotspot: the route passes near a reported-incident cluster
 *   - unlit:   a run of the route with no street lamp nearby
 */
function buildHazards(coords, departure) {
  const { rows } = riskProfile(coords, departure);
  const hazards = [];

  // --- hotspots near the path ---
  const hotspots = readHotspots();
  for (const h of hotspots) {
    let nearest = null;
    for (const r of rows) {
      const d = haversineM(r.lat, r.lng, h.lat, h.lng);
      if (!nearest || d < nearest.d) nearest = { d, along: r.along_m, risk: r.risk };
    }
    if (!nearest || nearest.d > HAZARD_RADIUS_M) continue;
    if (nearest.risk < HAZARD_MIN_RISK) continue;
    hazards.push({
      kind: 'hotspot',
      along_m: Math.round(nearest.along),
      label: h.name || 'reported-incident area',
      detail: h.reason || null,
      risk: Math.round(nearest.risk),
      intensity: h.intensity,
      cluster_id: h.cluster_id,
      lat: h.lat,
      lng: h.lng,
      distance_from_path_m: Math.round(nearest.d),
      advice: 'Stay on the main road and keep to lit, busy stretches.',
    });
  }

  // --- unlit stretches ---
  const { getCache } = require('./risk');
  const c = getCache();
  let runStart = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const lit = c.lamps.within(r.lat, r.lng, UNLIT_RADIUS_M).length > 0;
    if (!lit && r.covered && r.risk >= UNLIT_MIN_RISK) {
      if (runStart == null) runStart = i;
    } else if (runStart != null) {
      const len = rows[i - 1].along_m - rows[runStart].along_m;
      if (len >= UNLIT_MIN_LENGTH_M) {
        const mid = Math.floor((runStart + i - 1) / 2);
        hazards.push({
          kind: 'unlit',
          along_m: Math.round(rows[runStart].along_m),
          label: 'poorly lit stretch',
          detail: `About ${Math.round(len)} m with no street lamp recorded nearby.`,
          length_m: Math.round(len),
          risk: Math.round(rows[mid].risk),
          lat: rows[mid].lat,
          lng: rows[mid].lng,
          advice: 'Prefer a lit road, or stay where shops and people are.',
        });
      }
      runStart = null;
    }
  }
  if (runStart != null) {
    const len = rows[rows.length - 1].along_m - rows[runStart].along_m;
    if (len >= UNLIT_MIN_LENGTH_M) {
      const mid = Math.floor((runStart + rows.length - 1) / 2);
      hazards.push({
        kind: 'unlit',
        along_m: Math.round(rows[runStart].along_m),
        label: 'poorly lit stretch',
        detail: `About ${Math.round(len)} m with no street lamp recorded nearby.`,
        length_m: Math.round(len),
        risk: Math.round(rows[mid].risk),
        lat: rows[mid].lat,
        lng: rows[mid].lng,
        advice: 'Prefer a lit road, or stay where shops and people are.',
      });
    }
  }

  return hazards.sort((a, b) => a.along_m - b.along_m);
}

/**
 * The risk of the road immediately ahead of a position, plus the worst of it
 * inside the window. Returns null when the position is outside the area the
 * model has data for, so the UI can say "no safety data" instead of a number.
 */
function riskAhead(coords, departure, fromM, windowM = 500) {
  const { rows, covered } = riskProfile(coords, departure);
  const to = fromM + windowM;
  const window = rows.filter((r) => r.along_m >= fromM && r.along_m <= to);
  if (!window.length) return null;
  const insideCoverage = window.some((r) => r.covered);
  const mean = window.reduce((a, r) => a + r.risk, 0) / window.length;
  const max = window.reduce((a, r) => Math.max(a, r.risk), 0);
  return {
    from_m: Math.round(fromM),
    to_m: Math.round(to),
    window_m: Math.round(windowM),
    mean_risk: +mean.toFixed(1),
    max_risk: +max.toFixed(1),
    covered: insideCoverage,
    covered_bbox: covered ? [covered.minLat, covered.minLng, covered.maxLat, covered.maxLng] : null,
    samples: window.length,
  };
}

/** A stable, cheap identity for a route, so the client can tell them apart. */
function routeKey(coords) {
  if (!coords || !coords.length) return '';
  const a = coords[0];
  const b = coords[coords.length - 1];
  return `${coords.length}:${a[0].toFixed(5)},${a[1].toFixed(5)}:${b[0].toFixed(5)},${b[1].toFixed(5)}`;
}

/**
 * Build the full navigation payload for one route.
 *
 * `role` is the label the user picked (safest / balanced / fastest), kept only
 * for display; the geometry is what was routed.
 */
async function buildNavigation({ from, to, mode = 'walk', role = null, departure = new Date() }) {
  const routes = await osrmRoute([from, to], mode, { steps: true });
  const base = routes[0];
  if (!base) {
    const err = new Error('No route could be computed between those points.');
    err.status = 404;
    throw err;
  }

  const steps = buildSteps(base);
  const scored = scoreRoute({ ...base, source: 'navigation' }, departure);
  const hazards = buildHazards(base.coords, departure);

  return {
    role,
    mode,
    departure: departure.toISOString(),
    coords: base.coords.map(([lat, lng]) => [+lat.toFixed(6), +lng.toFixed(6)]),
    distance_m: Math.round(base.distance_m || lineLengthM(base.coords)),
    duration_s: Math.round(base.duration_s),
    steps,
    hazards,
    safety: {
      safety_score: scored.safety_score,
      mean_risk: scored.mean_risk,
      p90_risk: scored.p90_risk,
      max_risk: scored.max_risk,
      high_risk_m: scored.high_risk_m,
      exposure_per_km: scored.exposure_per_km,
      covered: scored.covered,
      covered_fraction: scored.covered_fraction,
    },
    steps_available: steps.length > 0,
    note: steps.length
      ? null
      : 'The routing service returned no turn-by-turn steps for this route; follow the highlighted line.',
    disclaimer: 'Estimate based on reported data, not a guarantee of safety.',
  };
}

/**
 * Recalculate when the user has gone off route: route from where they are now,
 * score the candidates, and return the safest one plus whether it is actually
 * better than what they are on.
 */
async function reroute({ from, to, mode = 'walk', departure = new Date(), lambda = 1.5 }) {
  const { planRoutes } = require('./routing');
  const plan = await planRoutes({ from, to, mode, departure, lambda });

  // Prefer the labelled safest option; fall back to the best safety score.
  const safest = plan.routes.find((r) => r.role === 'safest')
    || [...plan.routes].sort((a, b) => b.safety_score - a.safety_score)[0];
  if (!safest) {
    const err = new Error('No route could be computed from your current position.');
    err.status = 404;
    throw err;
  }

  // One extra call for steps, so the new route still has instructions.
  let steps = [];
  try {
    const withSteps = await osrmRoute(
      [from, to], mode,
      { steps: true }
    );
    const match = withSteps.find((r) => routeKey(r.coords) === routeKey(safest.coords))
      || withSteps[0];
    steps = buildSteps(match);
  } catch {
    /* instructions are best-effort after a reroute */
  }

  const fastest = [...plan.routes].sort((a, b) => a.duration_s - b.duration_s)[0];
  return {
    role: safest.role,
    mode,
    departure: departure.toISOString(),
    coords: safest.coords.map(([lat, lng]) => [+lat.toFixed(6), +lng.toFixed(6)]),
    distance_m: safest.distance_m,
    duration_s: safest.duration_s,
    steps,
    hazards: buildHazards(safest.coords, departure),
    safety: {
      safety_score: safest.safety_score,
      mean_risk: safest.mean_risk,
      p90_risk: safest.p90_risk,
      max_risk: safest.max_risk,
      high_risk_m: safest.high_risk_m,
      exposure_per_km: safest.exposure_per_km,
      covered: safest.covered,
      covered_fraction: safest.covered_fraction,
    },
    steps_available: steps.length > 0,
    is_safer_than_fastest: fastest ? safest.safety_score > fastest.safety_score + 0.05 : false,
    extra_time_s: fastest ? Math.max(0, Math.round(safest.duration_s - fastest.duration_s)) : 0,
    alternatives: plan.routes.map((r) => ({
      role: r.role,
      distance_m: r.distance_m,
      duration_s: r.duration_s,
      safety_score: r.safety_score,
      covered: r.covered,
    })),
    disclaimer: 'Estimate based on reported data, not a guarantee of safety.',
  };
}

module.exports = {
  buildNavigation, reroute, buildHazards, riskAhead, riskProfile,
  HAZARD_RADIUS_M, HAZARD_MIN_RISK, UNLIT_RADIUS_M, UNLIT_MIN_LENGTH_M,
};
