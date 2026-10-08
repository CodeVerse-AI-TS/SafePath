/* ==========================================================================
   SafePath navigation maths (pure, no DOM, no Leaflet)
   --------------------------------------------------------------------------
   Everything here is a pure function so it can be unit tested in Node and used
   unchanged in the browser. It answers the questions the navigation screen
   needs: where am I on the line, how far along, which way am I facing, is this
   fix trustworthy, and what is coming up next.

   Coordinate convention everywhere: [lat, lng] pairs, metres, degrees.
   ========================================================================== */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SafePathNavMath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const R_EARTH = 6371008.8; // metres, matches server/lib/geo.js

  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  /** Great-circle distance in metres. */
  function haversineM(aLat, aLng, bLat, bLng) {
    const dLat = toRad(bLat - aLat);
    const dLng = toRad(bLng - aLng);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** Initial bearing from a to b, 0..360 (0 = north, 90 = east). */
  function bearingDeg(aLat, aLng, bLat, bLng) {
    const p1 = toRad(aLat);
    const p2 = toRad(bLat);
    const dL = toRad(bLng - aLng);
    const y = Math.sin(dL) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dL);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /** Signed smallest turn from `a` to `b`, in -180..180 (negative = left). */
  function angleDelta(a, b) {
    let d = ((b - a + 540) % 360) - 180;
    if (d === -180) d = 180;
    return d;
  }

  /** Interpolate between two bearings the short way round (for smooth rotation). */
  function lerpAngle(a, b, t) {
    return (a + angleDelta(a, b) * t + 360) % 360;
  }

  /** Cardinal label for a bearing, e.g. 45 -> "NE". */
  const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function cardinal(bearing) {
    return CARDINALS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
  }

  /**
   * Perpendicular distance in metres from point p to the segment a-b, plus
   * where along the segment the foot falls (0..1).
   * Uses an equirectangular projection, which is accurate to well under a metre
   * over the tens-of-metres segments a route is made of.
   */
  function pointToSegment(p, a, b) {
    const latRef = toRad((a[0] + b[0]) / 2);
    const kx = 111320 * Math.cos(latRef); // metres per degree lng
    const ky = 111320;                    // metres per degree lat
    const px = (p[1] - a[1]) * kx;
    const py = (p[0] - a[0]) * ky;
    const bx = (b[1] - a[1]) * kx;
    const by = (b[0] - a[0]) * ky;
    const len2 = bx * bx + by * by;
    let t = len2 === 0 ? 0 : (px * bx + py * by) / len2;
    t = clamp(t, 0, 1);
    const cx = t * bx;
    const cy = t * by;
    return { distance_m: Math.hypot(px - cx, py - cy), t, along_m: Math.hypot(cx, cy) };
  }

  /**
   * Snap a fix to a polyline: the nearest point on the line, how far along the
   * route it is, and the distance from the line (used for the off-route check).
   *
   * `fromIndex` lets the caller search forward from the last match, which keeps
   * the snap stable on a route that doubles back on itself (a naive global
   * search would jump to the return leg).
   */
  function snapToLine(point, coords, opts = {}) {
    if (!coords || coords.length < 2) return null;
    const fromIndex = clamp(opts.fromIndex || 0, 0, coords.length - 2);
    const lookahead = opts.lookahead || 40;
    const end = Math.min(coords.length - 2, fromIndex + lookahead);

    let best = null;
    for (let i = fromIndex; i <= end; i++) {
      const seg = pointToSegment(point, coords[i], coords[i + 1]);
      if (!best || seg.distance_m < best.distance_m) best = { ...seg, index: i };
    }
    // If the best match is the very last segment of the window, widen the search
    // once - the fix has probably moved beyond the window.
    if (best && best.index === end && end < coords.length - 2) {
      for (let i = end + 1; i <= Math.min(coords.length - 2, end + lookahead); i++) {
        const seg = pointToSegment(point, coords[i], coords[i + 1]);
        if (seg.distance_m < best.distance_m) best = { ...seg, index: i };
      }
    }
    if (!best) return null;

    const a = coords[best.index];
    const b = coords[best.index + 1];
    return {
      lat: a[0] + (b[0] - a[0]) * best.t,
      lng: a[1] + (b[1] - a[1]) * best.t,
      index: best.index,
      t: best.t,
      offset_m: best.distance_m, // how far the fix is from the line
      along_m: best.along_m,
    };
  }

  /** Cumulative distance at each vertex of a polyline: cum[0] = 0. */
  function cumulativeDistances(coords) {
    const cum = [0];
    for (let i = 1; i < coords.length; i++) {
      cum.push(cum[i - 1] + haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
    }
    return cum;
  }

  /**
   * Distance along the whole route of a snap result. `cum` comes from
   * cumulativeDistances(coords); pass it in so it is computed once per route.
   */
  function alongRoute(snap, coords, cum) {
    if (!snap) return 0;
    const c = cum || cumulativeDistances(coords);
    return c[snap.index] + snap.along_m;
  }

  /** Route bearing at a snap position, looking a short way ahead. */
  function headingAlong(coords, index, lookaheadM = 25) {
    if (!coords || coords.length < 2) return 0;
    const i = clamp(index, 0, coords.length - 2);
    let travelled = 0;
    let j = i;
    while (j < coords.length - 2 && travelled < lookaheadM) {
      travelled += haversineM(coords[j][0], coords[j][1], coords[j + 1][0], coords[j + 1][1]);
      j++;
    }
    return bearingDeg(coords[i][0], coords[i][1], coords[j][0], coords[j][1]);
  }

  /**
   * Is a GPS fix trustworthy? Rejects:
   *   - accuracy worse than `maxAccuracyM` (a fix that could be a block away)
   *   - an implied speed above `maxSpeedMps` (a teleport, not walking)
   * `prev` is the last accepted fix: { lat, lng, at (ms) }.
   * Returns { ok, reason }.
   */
  function acceptFix(fix, prev, opts = {}) {
    const maxAccuracyM = opts.maxAccuracyM != null ? opts.maxAccuracyM : 100;
    const maxSpeedMps = opts.maxSpeedMps != null ? opts.maxSpeedMps : 12; // ~43 km/h
    if (!fix || !isFinite(fix.lat) || !isFinite(fix.lng)) return { ok: false, reason: 'invalid' };
    if (isFinite(fix.accuracy) && fix.accuracy > maxAccuracyM) {
      return { ok: false, reason: 'low_accuracy', accuracy: fix.accuracy };
    }
    if (prev && isFinite(prev.lat) && isFinite(prev.at)) {
      const dt = (fix.at - prev.at) / 1000;
      if (dt > 0.2) {
        const d = haversineM(prev.lat, prev.lng, fix.lat, fix.lng);
        const speed = d / dt;
        if (speed > maxSpeedMps) return { ok: false, reason: 'jump', speed_mps: +speed.toFixed(2) };
      }
    }
    return { ok: true };
  }

  /**
   * Smooth a new accepted fix toward the previous displayed position. A higher
   * `t` follows the GPS more closely; a lower one is steadier. Accuracy scales
   * the step: a precise fix is trusted more than a vague one.
   */
  function smoothPosition(prev, next, opts = {}) {
    if (!prev) return { lat: next.lat, lng: next.lng };
    let t = opts.t != null ? opts.t : 0.35;
    if (isFinite(next.accuracy)) {
      t = clamp(t * (1 + (100 - Math.min(100, next.accuracy)) / 100), 0.15, 0.9);
    }
    return {
      lat: prev.lat + (next.lat - prev.lat) * t,
      lng: prev.lng + (next.lng - prev.lng) * t,
    };
  }

  /** Linear interpolation of a position between two fixes, for frame-rate easing. */
  function interpolate(from, to, t) {
    const k = clamp(t, 0, 1);
    return {
      lat: from.lat + (to.lat - from.lat) * k,
      lng: from.lng + (to.lng - from.lng) * k,
    };
  }

  /**
   * Which step are we on, and how far to the next manoeuvre?
   * `steps` is [{ along_m, ... }] where along_m is the distance from the start
   * of the route to the point where the step begins.
   * Returns { index, current, next, distanceToNext_m, progress }.
   */
  function stepProgress(steps, alongM) {
    if (!steps || !steps.length) return null;
    let index = 0;
    for (let i = 0; i < steps.length; i++) {
      if (alongM >= steps[i].along_m - 0.5) index = i;
      else break;
    }
    const current = steps[index];
    const next = steps[index + 1] || null;
    const distanceToNext = next ? Math.max(0, next.along_m - alongM) : 0;
    const span = next ? Math.max(1, next.along_m - current.along_m) : 1;
    return {
      index,
      current,
      next,
      distanceToNext_m: distanceToNext,
      progress: next ? clamp((alongM - current.along_m) / span, 0, 1) : 1,
    };
  }

  /**
   * The first hazard at least `minAheadM` further along the route, within the
   * look-ahead window. `hazards` is [{ along_m, kind, label, severity }].
   * `skipBefore` lets a dismissed warning stay dismissed until we pass it.
   */
  function nextHazard(hazards, alongM, opts = {}) {
    const lookaheadM = opts.lookaheadM != null ? opts.lookaheadM : 400;
    const minAheadM = opts.minAheadM != null ? opts.minAheadM : 15;
    const skipBefore = opts.skipBefore != null ? opts.skipBefore : -Infinity;
    if (!hazards || !hazards.length) return null;
    let best = null;
    for (const h of hazards) {
      if (h.along_m <= skipBefore) continue;
      const ahead = h.along_m - alongM;
      if (ahead < minAheadM || ahead > lookaheadM) continue;
      if (!best || ahead < best.ahead_m) best = { ...h, ahead_m: ahead };
    }
    return best;
  }

  /** Format a distance for the instruction banner: "now", "120 m", "1.2 km". */
  function formatDistance(m) {
    if (!isFinite(m)) return '';
    if (m < 15) return 'now';
    if (m < 1000) return Math.round(m / 5) * 5 + ' m';
    return (m / 1000).toFixed(1) + ' km';
  }

  /**
   * A short, spoken sentence for a step. Kept separate from the banner text so
   * the on-screen copy and the voice line can differ where that reads better.
   */
  function spokenInstruction(step, distanceM) {
    if (!step) return '';
    const where = distanceM != null && distanceM > 15 ? `In ${formatDistance(distanceM)}, ` : '';
    const text = step.text || step.instruction || '';
    return (where + text).replace(/\s+/g, ' ').trim();
  }

  return {
    R_EARTH,
    toRad, toDeg, clamp,
    haversineM, bearingDeg, angleDelta, lerpAngle, cardinal,
    pointToSegment, snapToLine, cumulativeDistances, alongRoute, headingAlong,
    acceptFix, smoothPosition, interpolate,
    stepProgress, nextHazard, formatDistance, spokenInstruction,
    CARDINALS,
  };
});
