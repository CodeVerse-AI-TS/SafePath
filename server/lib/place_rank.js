'use strict';
/**
 * Pure ranking + text-matching for place suggestions. No I/O, no deps, so it
 * can be unit-tested directly (see test/places.test.js).
 *
 * The provider gives us candidates; this module decides what the user sees,
 * in what order, with which substring highlighted, and how a destination's
 * safety hint reads.
 */

/** Great-circle distance in metres. */
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

const norm = (s) => String(s == null ? '' : s).toLowerCase().trim();

/**
 * Cheapest-edit fuzzy check on the *whole* needle: are the characters of
 * `needle` all present in `haystack`, in order, with at most `maxGap` total
 * skipped characters? This catches typos and dropped letters ("majesitc",
 * "kuvempunagr") cheaply, without pulling in a fuzzy library.
 */
function subsequenceGap(needle, haystack, maxGap = 2) {
  let i = 0, gap = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
    else if (i > 0) gap++; // only count skips after the first match
    if (gap > maxGap) return maxGap + 1;
  }
  return i === needle.length ? gap : maxGap + 1;
}

/** Cheap Damerau-ish edit distance, capped for short strings. */
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Text match quality of `place` against `query`.
 * Returns { score (0..1), start, length } where start/length describe the
 * substring of the *displayed primary name* to highlight (or the secondary
 * line when the primary did not match).
 */
function textMatch(query, place) {
  const q = norm(query);
  if (!q) return { score: 1, start: -1, length: 0, field: null };

  const primary = place.name || '';
  const secondary = place.secondary || '';
  const pn = norm(primary);
  const sn = norm(secondary);

  // 1. exact prefix (best): the name starts with what was typed
  let idx = pn.indexOf(q);
  if (idx === 0) {
    return { score: 1.0, start: 0, length: q.length, field: 'primary' };
  }
  // 2. word-boundary prefix ("palace" in "Mysore Palace")
  if (idx > 0) {
    const boundary = /[\s,\-/]/.test(pn[idx - 1]);
    return { score: boundary ? 0.95 : 0.85, start: idx, length: q.length, field: 'primary' };
  }
  // 3. typo / transposition: small edit distance on the whole name. There is
  //    no literal substring to highlight, so highlight the shared prefix.
  const ed = editDistance(q, pn.slice(0, Math.max(q.length + 2, 4)));
  if (ed <= 2 || (q.length >= 5 && ed / q.length <= 0.3)) {
    let pre = 0;
    while (pre < q.length && pre < pn.length && q[pre] === pn[pre]) pre++;
    return {
      score: 0.7 - ed * 0.05,
      start: pre >= 2 ? 0 : -1,
      length: pre >= 2 ? pre : 0,
      field: 'primary',
    };
  }
  // 4. later word matches
  const words = pn.split(/[\s,]+/).filter(Boolean);
  for (const w of words) {
    if (w.startsWith(q)) return { score: 0.6, start: pn.indexOf(w), length: q.length, field: 'primary' };
  }
  // 5. fuzzy subsequence on the primary, then the secondary line
  if (subsequenceGap(q, pn, 2) <= 2) return { score: 0.45, start: -1, length: 0, field: 'primary' };
  const si = sn.indexOf(q);
  if (si >= 0) return { score: 0.4, start: si, length: q.length, field: 'secondary' };
  if (subsequenceGap(q, sn, 2) <= 2) return { score: 0.25, start: -1, length: 0, field: 'secondary' };
  return { score: 0, start: -1, length: 0, field: null };
}

/** Distance-decay weight: 1 at the origin, ~0 beyond `scaleM`. */
function proximityWeight(distM, scaleM = 12000) {
  if (!isFinite(distM)) return 0;
  return 1 / (1 + (distM / scaleM) ** 2);
}

/** India is the app's home country; other countries are demoted, not hidden. */
function countryWeight(place, homeCountry = 'IN') {
  const cc = (place.country_code || '').toUpperCase();
  if (!cc) return 0.7; // unknown: neither rewarded nor punished
  return cc === homeCountry ? 1 : 0.15;
}

/**
 * Rank candidates for the dropdown.
 *
 * @param {string} query
 * @param {object[]} places     provider candidates
 * @param {object}   [opts]
 * @param {{lat,lng}} [opts.near]      user / map-centre location
 * @param {object}   [opts.pastFreq]   map of normalised name -> past selection count
 * @param {string}   [opts.homeCountry] ISO-2, default IN
 * @param {number}   [opts.limit]
 * @returns {object[]} sorted, each with match offsets, distance_m, reason
 */
function rankPlaces(query, places, opts = {}) {
  const {
    near = null, pastFreq = {}, homeCountry = 'IN', limit = 6,
  } = opts;

  const seen = new Set();
  const scored = [];

  (places || []).forEach((p) => {
    if (!p || !p.name) return;
    const dedupeKey = `${norm(p.name)}|${(p.lat || 0).toFixed(3)}|${(p.lng || 0).toFixed(3)}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const m = textMatch(query, p);
    if (m.score <= 0) return;

    const distM = near && isFinite(near.lat) && isFinite(near.lng)
      ? haversineM(near.lat, near.lng, p.lat, p.lng)
      : null;

    const prox = distM == null ? 0.5 : proximityWeight(distM);
    const cw = countryWeight(p, homeCountry);
    const past = pastFreq[norm(p.name)] || 0;
    const pastBoost = Math.min(0.25, past * 0.08);

    // text dominates; proximity, home country and past picks break ties.
    const score = m.score * 0.62 + prox * 0.20 + cw * 0.12 + pastBoost;

    scored.push({
      ...p,
      distance_m: distM == null ? null : Math.round(distM),
      match: m,
      score: +score.toFixed(4),
      reason: `text ${m.score.toFixed(2)} · near ${prox.toFixed(2)} · country ${cw.toFixed(2)}${past ? ' · used ' + past + '×' : ''}`,
    });
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Turn a safety lookup into the short hint shown on a destination row. */
function safetyHint(riskInfo) {
  if (!riskInfo) return { text: 'No safety data', level: 'none' };
  if (riskInfo.covered === false) return { text: 'No safety data', level: 'none' };
  const risk = riskInfo.risk;
  if (!isFinite(risk)) return { text: 'No safety data', level: 'none' };
  const band = risk >= 60 ? 'high' : risk >= 35 ? 'medium' : 'low';
  const label = band === 'low' ? 'Low risk area' : band === 'medium' ? 'Moderate risk area' : 'Higher risk area';
  // Only mention the time when we actually evaluated a specific bucket.
  const when = riskInfo.bucket && riskInfo.bucket !== 'afternoon' ? ` at ${riskInfo.bucket}` : '';
  return { text: `${label}${when}`, level: band };
}

module.exports = {
  rankPlaces, textMatch, safetyHint, haversineM, subsequenceGap, editDistance,
};
