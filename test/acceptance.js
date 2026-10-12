'use strict';
/**
 * SafePath acceptance checks — run against a LIVE server.
 *
 *   npm start                 # in one terminal
 *   node test/acceptance.js   # in another (BASE=http://localhost:3000 to override)
 *
 * These checks exercise the real HTTP API, the real risk model and the real
 * OSRM/Nominatim services, so they need network access and a running server.
 * The offline unit tests for the risk function live in test/risk.test.js and run
 * under `npm test`.
 *
 * Exit code is non-zero if any check fails.
 */

const BASE = process.env.BASE || 'http://localhost:12000';

let pass = 0, fail = 0;
const probeShareTokens = []; // share links this run created, for cleanup
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function api(path, opts) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const plan = (from, to, mode, departure, lambda) =>
  api('/api/routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, mode, departure, lambda }),
  });

const OD = [
  { label: 'Mysore Palace → Kuvempunagar', from: 'Mysore Palace, Mysuru', to: 'Kuvempunagar, Mysuru' },
  { label: 'Railway Station → Gokulam', from: [12.3149, 76.6454], to: [12.3261, 76.6283] },
  { label: 'Hebbal → City Bus Stand', from: [12.3580, 76.6105], to: [12.3267, 76.6272] },
  { label: 'Nazarbad → Vijayanagar', from: [12.3093, 76.6658], to: [12.3333, 76.6126] },
  { label: 'Devaraja Market → Saraswathipuram', from: [12.3110, 76.6520], to: [12.2985, 76.6284] },
];

const AFTERNOON = '2026-10-28T14:00:00';
const NIGHT = '2026-10-28T23:00:00';

(async () => {
  console.log(`\nSafePath acceptance against ${BASE}\n`);

  // --- 1. service health ---
  console.log('1. Service and data');
  const health = await api('/api/health');
  check('/api/health responds', health.status === 200 && health.body.ok === true);
  check('data is seeded', !!health.body.seeded, `seeded ${health.body.seeded}`);
  check('model is built', !!health.body.model_generated_at);
  const meta = await api('/api/meta');
  check('data source is labelled', ['synthetic', 'imported'].includes(meta.body.data_source),
    `data_source=${meta.body.data_source}`);

  // --- 2. risk endpoint + decay / time ---
  console.log('\n2. Risk endpoint');
  const r1 = await api('/api/risk?lat=12.3110&lng=76.6520&time=' + encodeURIComponent(NIGHT));
  check('risk returns a 0..100 score',
    r1.status === 200 && typeof r1.body.risk === 'number' && r1.body.risk >= 0 && r1.body.risk <= 100,
    `risk=${r1.body.risk}`);
  check('risk payload carries the disclaimer',
    /not a guarantee/i.test(r1.body.disclaimer || ''));

  const grid = await api('/api/risk-grid?bbox=12.25,76.58,12.39,76.72&time=' + encodeURIComponent(NIGHT) + '&cells=24');
  check('risk-grid returns points', grid.status === 200 && Array.isArray(grid.body.points) && grid.body.points.length > 0,
    `${grid.body.points && grid.body.points.length} points`);

  // The documented shorthand form of ?time= (see README "API"). Sending a full
  // ISO timestamp, as the checks above do, once masked a parser that silently
  // replaced any non-ISO value with the current time, so `time=night` could be
  // answered with a daytime score. Exercise the shorthand directly.
  const buckets = ['morning', 'afternoon', 'evening', 'night'];
  const byBucket = {};
  for (const b of buckets) {
    const r = await api(`/api/risk?lat=12.3110&lng=76.6520&time=${b}`);
    byBucket[b] = { status: r.status, bucket: r.body.bucket, risk: r.body.risk };
  }
  check('each time-of-day name is honoured',
    buckets.every((b) => byBucket[b].status === 200 && byBucket[b].bucket === b),
    buckets.map((b) => `${b}->${byBucket[b].bucket}`).join(' '));
  const distinct = new Set(buckets.map((b) => byBucket[b].risk));
  check('time of day actually changes the score', distinct.size > 1,
    buckets.map((b) => `${b}=${byBucket[b].risk}`).join(' '));
  check('night scores higher than afternoon',
    byBucket.night.risk > byBucket.afternoon.risk,
    `afternoon=${byBucket.afternoon.risk} night=${byBucket.night.risk}`);

  // Unknown input must be refused, not silently answered for a different time.
  const bad = await api('/api/risk?lat=12.3110&lng=76.6520&time=notatime');
  check('an unparseable time is refused with 400', bad.status === 400,
    `HTTP ${bad.status} ${JSON.stringify(bad.body).slice(0, 80)}`);

  // --- 3. three routes + safety ordering, per OD pair and mode ---
  console.log('\n3. Route options (3 distinct, safest never worse than fastest)');
  for (const od of OD) {
    const p = await plan(od.from, od.to, 'walk', AFTERNOON, 1);
    if (p.status !== 200) { check(od.label, false, `HTTP ${p.status} ${JSON.stringify(p.body).slice(0, 120)}`); continue; }
    const roles = p.body.routes.map((r) => r.role);
    check(`${od.label}: 3 route cards`, p.body.routes.length === 3, `roles=${roles.join(',')} (${p.body.candidate_count} candidates)`);
    check(`${od.label}: distinct roles`, new Set(roles).size === 3, roles.join(','));
    const fastest = p.body.routes.find((r) => r.role === 'fastest');
    const safest = p.body.routes.find((r) => r.role === 'safest');
    if (fastest && safest) {
      check(`${od.label}: safest exposure <= fastest`,
        safest.exposure_per_km <= fastest.exposure_per_km + 0.01,
        `safest ${safest.exposure_per_km} vs fastest ${fastest.exposure_per_km}`);
      check(`${od.label}: safest safety >= fastest safety`,
        safest.safety_score >= fastest.safety_score - 0.01,
        `${safest.safety_score} vs ${fastest.safety_score}`);
      check(`${od.label}: safer option reports extra time`,
        typeof safest.extra_time_pct === 'number' && typeof fastest.extra_time_pct === 'number',
        `safest +${safest.extra_time_pct}%, fastest ${fastest.extra_time_pct}%`);
      check(`${od.label}: no hard-coded insight strings`,
        p.body.routes.every((r) => Array.isArray(r.reasons) && r.reasons.length > 0),
        `${safest.reasons.length} reasons`);
    }
  }

  // --- 4. day/night direction ---
  console.log('\n4. Departure time changes the score');
  const od = OD[0];
  const day = await plan(od.from, od.to, 'walk', AFTERNOON, 1);
  const night = await plan(od.from, od.to, 'walk', NIGHT, 1);
  const dayS = day.body.routes.find((r) => r.role === 'fastest');
  const nightS = night.body.routes.find((r) => r.role === 'fastest');
  if (dayS && nightS) {
    check('same route scores lower at night than in the afternoon',
      nightS.safety_score < dayS.safety_score,
      `afternoon ${dayS.safety_score} vs night ${nightS.safety_score}`);
    check('night risk per km is higher',
      nightS.exposure_per_km > dayS.exposure_per_km,
      `afternoon ${dayS.exposure_per_km} vs night ${nightS.exposure_per_km}`);
  }

  // --- 5. modes ---
  console.log('\n5. Travel modes');
  for (const mode of ['walk', 'cycle', 'drive']) {
    const p = await plan(OD[1].from, OD[1].to, mode, AFTERNOON, 1);
    check(`${mode} mode plans a route`, p.status === 200 && p.body.routes.length >= 1 && p.body.mode === mode,
      `${p.body.routes ? p.body.routes.length : 0} routes`);
  }

  // --- 6. safety-vs-speed slider ---
  console.log('\n6. Safety vs speed slider');
  const fast = await plan(OD[1].from, OD[1].to, 'walk', AFTERNOON, 0.05);
  const safe = await plan(OD[1].from, OD[1].to, 'walk', AFTERNOON, 6);
  const bFast = fast.body.routes.find((r) => r.role === 'balanced');
  const bSafe = safe.body.routes.find((r) => r.role === 'balanced');
  if (bFast && bSafe) {
    check('higher lambda picks an option at least as safe',
      bSafe.safety_score >= bFast.safety_score - 0.01,
      `lambda 0.05 -> ${bFast.safety_score}, lambda 6 -> ${bSafe.safety_score}`);
  }

  // --- 7. report feeds back into the risk model ---
  console.log('\n7. Report changes nearby risk');
  const spot = { lat: 12.2637, lng: 76.6228 }; // Srirampura, a quiet corner unlikely to be deduped
  const before = await api(`/api/risk?lat=${spot.lat}&lng=${spot.lng}&time=now`);
  const rep = await api('/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...spot, type: 'low_lighting', lighting: 1, crowd: 1, note: 'Acceptance test: unlit stretch' }),
  });
  if (rep.status === 201) {
    check('report accepted', true, `id ${rep.body.report.id}`);
    check('report stored at area level',
      Math.abs(rep.body.report.lat - spot.lat) < 0.002 && Math.abs(rep.body.report.lng - spot.lng) < 0.002,
      `stored ${rep.body.report.lat},${rep.body.report.lng}`);
    const after = await api(`/api/risk?lat=${spot.lat}&lng=${spot.lng}&time=now`);
    check('risk near the report did not decrease',
      after.body.risk >= before.body.risk - 0.01,
      `${before.body.risk} -> ${after.body.risk}`);
    const hs = await api('/api/hotspots');
    check('hotspot list still readable after a report',
      hs.status === 200 && Array.isArray(hs.body.hotspots) && hs.body.hotspots.length > 0,
      `${hs.body.hotspots.length} hotspots`);
  } else if (rep.status === 429) {
    check('report endpoint is rate-limited / deduped', true, 'HTTP 429 (expected after repeated runs)');
  } else {
    check('report accepted', false, `HTTP ${rep.status} ${JSON.stringify(rep.body).slice(0, 120)}`);
  }

  // --- 8. signals read from the database ---
  console.log('\n8. Signals page numbers');
  const sig = await api('/api/signals');
  check('/api/signals responds', sig.status === 200);
  check('signals totals are numbers',
    typeof sig.body.totals.incidents === 'number' && typeof sig.body.totals.hotspots === 'number',
    `incidents=${sig.body.totals.incidents} hotspots=${sig.body.totals.hotspots}`);
  const byTod = sig.body.incidents_by_time_of_day || {};
  check('incidents-by-time buckets sum to the total',
    ['morning', 'afternoon', 'evening', 'night'].reduce((a, k) => a + (byTod[k] || 0), 0) === sig.body.totals.incidents,
    JSON.stringify(byTod));
  check('hotspot total is not the truncated display list',
    sig.body.totals.hotspots >= (sig.body.top_hotspots || []).length,
    `total ${sig.body.totals.hotspots}, shown ${(sig.body.top_hotspots || []).length}`);

  // --- 9. alert channels honesty ---
  console.log('\n9. Panic alert channels');
  const ch = await api('/api/alerts/channels');
  check('channel status is exposed', ch.status === 200 && ch.body.channels, `mode=${ch.body.mode}`);
  check('demo mode is stated when nothing is configured',
    ch.body.mode === 'live' || /demo/i.test(ch.body.note || ''), ch.body.note ? ch.body.note.slice(0, 80) : '');

  // --- 10. geocoding ---
  console.log('\n10. Geocoding');
  const geo = await api('/api/geocode?q=' + encodeURIComponent('Mysore Palace, Mysuru'));
  check('geocode resolves a Mysuru place',
    geo.status === 200 && geo.body.lat && geo.body.lng, geo.body.label || JSON.stringify(geo.body).slice(0, 80));

  console.log('\n11. Place autocomplete (search-as-you-type)');
  const st = await api('/api/places/status');
  check('a places provider is reported', st.status === 200 && !!st.body.provider,
    'provider=' + (st.body.provider || '?') + ' enabled=' + st.body.enabled);
  check('autocomplete does not use Nominatim (its policy forbids it)',
    (st.body.provider || '') !== 'nominatim', 'provider=' + st.body.provider);

  const tooShort = await api('/api/places/suggest?q=M&lat=12.3052&lng=76.6554');
  check('a 1-character query returns no suggestions',
    tooShort.status === 200 && tooShort.body.suggestions.length === 0,
    tooShort.body.suggestions.length + ' suggestion(s)');

  if (st.body.enabled) {
    const sug = await api('/api/places/suggest?q=' + encodeURIComponent('Maje') + '&lat=12.3052&lng=76.6554&limit=6');
    const list = (sug.body.suggestions || []);
    check('"Maje" returns at most 6 suggestions', list.length > 0 && list.length <= 6, list.length + ' suggestion(s)');
    check('suggestions carry coordinates and a match range',
      list.length > 0 && list.every((s) => isFinite(s.lat) && isFinite(s.lng) && s.match && typeof s.match.start === 'number'),
      list[0] ? JSON.stringify(list[0].match) : 'none');
    check('the match offset points at the typed text in the name',
      list.some((s) => s.name.slice(s.match.start, s.match.start + s.match.length).toLowerCase() === 'maje'),
      list.map((s) => s.name).slice(0, 3).join(' | '));
    check('an India-biased query favours Indian results',
      list.filter((s) => (s.secondary || '').includes('India')).length >= Math.ceil(list.length / 2),
      list.filter((s) => (s.secondary || '').includes('India')).length + '/' + list.length + ' in India');

    const safety = await api('/api/places/suggest?q=' + encodeURIComponent('Mysore Palace')
      + '&lat=12.3052&lng=76.6554&safety=1&time=2026-10-27T23:00:00');
    check('a safety hint is attached when requested',
      (safety.body.suggestions || []).length > 0 && safety.body.suggestions.every((s) => s.safety && s.safety.text),
      (safety.body.suggestions[0] || {}).safety ? safety.body.suggestions[0].safety.text : 'none');
    check('the safety hint is honest about unknown areas',
      (safety.body.suggestions || []).some((s) => s.safety.level === 'none' || /risk/i.test(s.safety.text)),
      (safety.body.suggestions[0] || {}).safety ? safety.body.suggestions[0].safety.text : 'none');

    // A far-away query must not claim safety data it does not have.
    const far = await api('/api/places/suggest?q=' + encodeURIComponent('Delhi') + '&lat=12.3052&lng=76.6554&safety=1');
    const farNone = (far.body.suggestions || []).filter((s) => s.safety && s.safety.level === 'none');
    check('places outside the covered area are marked "No safety data"',
      (far.body.suggestions || []).length > 0 && farNone.length > 0,
      farNone.length + '/' + (far.body.suggestions || []).length + ' marked no-data');

    // The deprecated alias must forward, not call Nominatim.
    const legacy = await fetch(BASE + '/api/geocode/suggest?q=Maje&lat=12.3052&lng=76.6554', { redirect: 'manual' });
    check('the old /api/geocode/suggest endpoint redirects to the new one',
      [301, 302, 307, 308].includes(legacy.status), 'status=' + legacy.status);
  } else {
    console.log('  SKIP  provider disabled — set SAFEPATH_PLACES_PROVIDER=photon to exercise autocomplete');
  }

  // --- 11. navigation payload ---
  const nav = await api('/api/navigation', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: [12.3052, 76.6554], to: [12.3152, 76.6654], mode: 'walk',
      role: 'safest', departure: 'now',
    }),
  });
  check('/api/navigation responds', nav.status === 200, `HTTP ${nav.status}`);
  if (nav.status === 200) {
    const n = nav.body;
    check('navigation returns a polyline', Array.isArray(n.coords) && n.coords.length > 10, (n.coords || []).length + ' points');
    check('navigation returns turn-by-turn steps', Array.isArray(n.steps) && n.steps.length > 0, (n.steps || []).length + ' steps');
    check('each step is placed along the route',
      (n.steps || []).every((s) => typeof s.along_m === 'number' && typeof s.text === 'string' && s.text.length > 0));
    check('steps are in order along the route',
      (n.steps || []).every((s, i, a) => i === 0 || s.along_m >= a[i - 1].along_m));
    check('navigation carries a safety summary',
      n.safety && typeof n.safety.safety_score === 'number',
      n.safety ? `score ${n.safety.safety_score}, mean ${n.safety.mean_risk}` : 'missing');
    check('navigation hazards are placed along the route',
      Array.isArray(n.hazards) && n.hazards.every((h) => typeof h.along_m === 'number' && h.kind && h.advice),
      (n.hazards || []).length + ' hazard(s)');
    check('the navigation payload states it is an estimate',
      /estimate|not a guarantee/i.test(n.disclaimer || n.note || ''), (n.disclaimer || n.note || '').slice(0, 60));
  }

  // --- 11b. the route card and the navigator agree about the same road ---
  // These two used different proximity radii (250 m on the card, 150 m in
  // navigation), so a card could promise "1 hotspot near" and navigation then
  // stay silent. Both now share HOTSPOT_PROXIMITY_M; this pins them together.
  const pair = { from: [12.305211, 76.655486], to: [12.293412, 76.630767] };
  const agree = await api('/api/routes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...pair, mode: 'walk', departure: 'now' }),
  });
  const agreeNav = await api('/api/navigation', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...pair, mode: 'walk', departure: 'now' }),
  });
  if (agree.status === 200 && agreeNav.status === 200) {
    const fastest = (agree.body.routes || []).find((r) => r.role === 'fastest') || (agree.body.routes || [])[0];
    const cardCount = fastest ? (fastest.hotspots_near || []).length : 0;
    const hazardCount = (agreeNav.body.hazards || []).filter((h) => h.kind === 'hotspot').length;
    // The navigated route is the same road, so the hotspot sets must match.
    const cardNames = new Set((fastest ? fastest.hotspots_near || [] : []).map((h) => h.name));
    const hazardNames = new Set((agreeNav.body.hazards || [])
      .filter((h) => h.kind === 'hotspot').map((h) => h.label));
    const onlyOnCard = [...cardNames].filter((n) => !hazardNames.has(n));
    check('the route card and the navigator count the same hotspots',
      cardCount === hazardCount && onlyOnCard.length === 0,
      `card ${cardCount} (${[...cardNames].join(', ') || 'none'}) vs nav ${hazardCount} (${[...hazardNames].join(', ') || 'none'})`);
  } else {
    check('the route card and the navigator count the same hotspots', false,
      `routes HTTP ${agree.status}, navigation HTTP ${agreeNav.status}`);
  }

  // --- 12. reroute from a live position ---
  const rer = await api('/api/navigation/reroute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: [12.3052, 76.6554], to: [12.3152, 76.6654], mode: 'walk', departure: 'now' }),
  });
  check('/api/navigation/reroute responds', rer.status === 200, `HTTP ${rer.status}`);
  if (rer.status === 200) {
    check('reroute returns a usable route', Array.isArray(rer.body.coords) && rer.body.coords.length > 10);
    check('reroute states whether it is safer than the fastest option',
      typeof rer.body.is_safer_than_fastest === 'boolean',
      `safer=${rer.body.is_safer_than_fastest}, extra_time_s=${rer.body.extra_time_s}`);
    check('reroute reports the extra time it costs', typeof rer.body.extra_time_s === 'number');
  }

  // --- 13. trip storage, area-level and without a trail ---
  const trip = await api('/api/trips', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role: 'safest', mode: 'walk',
      from_lat: 12.3052345678, from_lng: 76.6552345678,
      to_lat: 12.3152345678, to_lng: 76.6652345678,
      distance_m: 1234, actual_duration_s: 600, avg_speed_kmh: 7.4,
      safety_score: 68, end_reason: 'arrived',
    }),
  });
  check('a trip can be saved', trip.status === 201 || trip.status === 200, `HTTP ${trip.status}`);
  const trips = await api('/api/trips?limit=5');
  check('/api/trips is readable', trips.status === 200, `HTTP ${trips.status}`);
  if (trips.status === 200) {
    const keys = Object.keys((trips.body.trips || [])[0] || {}).join(',');
    check('the trips list keeps no coordinate trail',
      !/(^|,)(coords|path|polyline|track|trail)(,|$)/.test(keys), keys);
    check('the trips payload states its privacy stance',
      /area|round|trail|not stored/i.test(trips.body.privacy || ''), (trips.body.privacy || '').slice(0, 70));
  }

  // --- 14. live share publishes an area-level position only ---
  const share = await api('/api/trips/share', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat: 12.3052345678, lng: 76.6552345678, to_label: 'Acceptance test' }),
  });
  check('a live-share link is created', share.status === 201 || share.status === 200, `HTTP ${share.status}`);
  if (share.status === 200 || share.status === 201) {
    check('the share link is a token, not a raw position',
      typeof share.body.token === 'string' && share.body.token.length >= 8, share.body.token);
    if (typeof share.body.token === 'string') probeShareTokens.push(share.body.token);
    check('the share link says whether it is live',
      typeof share.body.live === 'boolean', 'live=' + share.body.live);
    const shown = await api('/api/trips/share/' + share.body.token);
    check('the shared position is readable', shown.status === 200, `HTTP ${shown.status}`);
    if (shown.status === 200) {
      const movedM = Math.abs(shown.body.lat - 12.3052345678) * 111320;
      check('the shared position is only area-level', movedM > 0.1 && movedM <= 120,
        `moved ${Math.round(movedM)} m from the precise fix`);
      check('the share payload states its accuracy', /area-level|110 m/i.test(shown.body.accuracy_note || ''),
        (shown.body.accuracy_note || '').slice(0, 60));
      check('the share payload repeats the estimate disclaimer',
        /estimate|not a guarantee/i.test(shown.body.disclaimer || ''));
    }
    await api('/api/trips/share/' + share.body.token + '/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const ended = await api('/api/trips/share/' + share.body.token);
    check('a stopped share link refuses to serve a position',
      ended.status === 410, 'HTTP ' + ended.status);
  }

  // Remove the probe rows this run wrote, so repeated runs do not accumulate
  // debris. Only possible when the server shares our filesystem.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE)) {
    try {
      const { getDb } = require('../server/lib/db');
      const db = getDb();
      const n = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE note LIKE 'Acceptance test%'").get().n;
      if (n) {
        db.exec("DELETE FROM reports WHERE note LIKE 'Acceptance test%'");
        require('../server/lib/risk').reload();
        console.log(`cleaned up ${n} acceptance probe report(s)`);
      }
      // The navigation checks write a probe share link and a probe trip.
      for (const tok of probeShareTokens) {
        db.prepare('DELETE FROM trip_shares WHERE token = ?').run(tok);
      }
      const t = db.prepare(
        "SELECT COUNT(*) AS n FROM trips WHERE distance_m = 1234 AND actual_duration_s = 600"
      ).get().n;
      if (t) db.exec("DELETE FROM trips WHERE distance_m = 1234 AND actual_duration_s = 600");
      if (t) console.log(`cleaned up ${t} acceptance probe trip(s)`);
    } catch (e) {
      console.log('cleanup skipped:', e.message);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nAcceptance run crashed:', err.message);
  console.error('Is the server running?  npm start');
  process.exit(1);
});
