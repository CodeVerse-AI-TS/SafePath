/* Verify the live navigation flow end to end, from a desk.
   A route is planned, then a simulated trip is driven through the navigation
   screen using the same code path a real GPS fix takes (SafePathNav._injectFix),
   so the arrow, banner, compass, stats, off-route reroute and end-of-trip are
   all exercised without walking anywhere. */
let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch {
  console.log('SKIP  puppeteer-core is not installed (npm i -D puppeteer-core) — skipping browser checks.');
  process.exit(0);
}
const fs = require('fs');
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';
if (!fs.existsSync(CHROME)) {
  console.log('SKIP  no Chromium at ' + CHROME + ' (set CHROME_PATH to run browser checks).');
  process.exit(0);
}

const BASE = process.env.BASE || 'http://localhost:12000';
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? el.textContent.trim() : null;
}, sel);
const hidden = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return !el || el.hidden;
}, sel);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e));
  await page.setViewport({ width: 1440, height: 1000 });
  // Location must not be requested before the user starts navigating.
  await page.evaluateOnNewDocument(() => {
    window.__geoWatchCalls = 0;
    window.__geoGetCalls = 0;
    const g = navigator.geolocation;
    const watch = g.watchPosition.bind(g);
    const get = g.getCurrentPosition.bind(g);
    g.watchPosition = (...a) => { window.__geoWatchCalls++; return watch(...a); };
    g.getCurrentPosition = (...a) => { window.__geoGetCalls++; return get(...a); };
  });
  // Simulate a returning visitor: pre-set the one-time welcome flag so this
  // test starts on the app itself. The card's own behaviour is covered by
  // test/auth.smoke.js.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('safepath.welcome.seen', '1'); } catch { /* ignore */ }
  });
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await wait(2500);

  // --- 0. no location access until navigation begins ---
  const geoBefore = await page.evaluate(() => ({
    watch: window.__geoWatchCalls, get: window.__geoGetCalls,
  }));
  check('the planner does not touch the location API',
    geoBefore.watch === 0 && geoBefore.get === 0, JSON.stringify(geoBefore));

  // --- 1. plan a route so there is something to navigate ---
  await page.click('#fromInput');
  await page.type('#fromInput', 'Mysore Palace, Mysuru');
  await page.type('#toInput', 'Kuvempunagar, Mysuru');
  await page.focus('#toInput');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#routeCards .route').length >= 1, { timeout: 60000 }).catch(() => {});
  await wait(2500);
  check('a route is planned', (await page.evaluate(() => document.querySelectorAll('#routeCards .route').length)) >= 1);

  // --- 2. every route card offers Start navigation ---
  const navBtns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#routeCards .route .btn--nav')).map((b) => b.textContent.trim()));
  check('each route card has a Start navigation button', navBtns.length >= 1 && navBtns.every((t) => /start navigation/i.test(t)),
    navBtns.length + ' buttons');

  // --- 3. tapping it enters navigation mode ---
  await page.evaluate(() => document.querySelector('#routeCards .route .btn--nav').click());
  await page.waitForFunction(() => {
    const s = document.getElementById('navScreen');
    return s && !s.hidden;
  }, { timeout: 20000 }).catch(() => {});
  await wait(2000);

  const entered = await page.evaluate(() => ({
    navVisible: !document.getElementById('navScreen').hidden,
    plannerHidden: getComputedStyle(document.querySelector('.app')).display === 'none',
    bodyFlag: document.body.classList.contains('nav-active'),
    hasMap: !!document.querySelector('#mapNav .leaflet-container'),
  }));
  check('Start navigation opens the trip view', entered.navVisible, 'navScreen visible');
  check('the planner is hidden behind it', entered.plannerHidden && entered.bodyFlag);
  check('the navigation map renders', entered.hasMap, 'leaflet container present');

  // --- 4. the permission sheet explains why location is needed ---
  const permShown = await page.evaluate(() => {
    const s = document.getElementById('navPermSheet');
    const body = document.getElementById('navPermBody');
    return { shown: s && !s.hidden, text: body ? body.textContent : '' };
  });
  check('location permission is explained', permShown.shown && /only during this trip/i.test(permShown.text),
    permShown.shown ? 'sheet shown' : 'sheet not shown');
  const geoDuring = await page.evaluate(() => ({ watch: window.__geoWatchCalls }));
  check('location is requested only once navigation starts', geoDuring.watch >= 1, geoDuring.watch + ' watch call(s)');
  check('a simulated trip is offered when location is unavailable',
    await page.evaluate(() => {
      const b = document.getElementById('navPermSim');
      return !!b && !b.hidden;
    }));

  // --- 5. drive a simulated trip through the real fix path ---
  await page.evaluate(() => {
    const s = document.getElementById('navPermSheet');
    if (s) s.hidden = true;
  });
  const drove = await page.evaluate(async () => {
    const nav = window.SafePathNav;
    const st = nav._state;
    const coords = st.coords;
    const cum = st.cum;
    const total = st.total_m;
    // Walk 45% of the route in 25 fixes, at ~20 m steps, in one go. Stopping
    // short of the destination matters: arrival would end the trip.
    for (let i = 0; i <= 25; i++) {
      const along = (total * 0.45 * i) / 25;
      const p = nav._pointAt(coords, cum, along);
      const n = nav._pointAt(coords, cum, Math.min(total, along + 15));
      const heading = window.SafePathNavMath.bearingDeg(p[0], p[1], n[0], n[1]);
      nav._injectFix({
        lat: p[0], lng: p[1], accuracy: 8, heading, speed: 1.4, at: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 20));
    }
    return { along: st.along_m, total, heading: st.heading, speed: st.speedMps, arrived: st.arrived };
  });
  await wait(600);
  check('the arrow advances along the route', drove.along > drove.total * 0.3 && !drove.arrived,
    Math.round(drove.along) + ' of ' + Math.round(drove.total) + ' m');

  // --- 6. the arrow marker rotates to the direction of travel ---
  const arrow = await page.evaluate(() => {
    const el = document.querySelector('#mapNav .nav-arrow');
    return {
      present: !!el,
      transform: el ? el.style.transform : null,
      markerCount: document.querySelectorAll('#mapNav .nav-arrowWrap').length,
      accuracyCircle: document.querySelectorAll('#mapNav path.leaflet-interactive').length,
    };
  });
  check('the position arrow is drawn', arrow.present && arrow.markerCount === 1, arrow.markerCount + ' arrow(s)');
  check('the arrow is rotated to the heading', !!arrow.transform && /rotate\(/.test(arrow.transform), arrow.transform);
  check('an accuracy circle is drawn around the arrow', arrow.accuracyCircle > 0, arrow.accuracyCircle + ' circle(s)');

  // --- 7. the travelled part of the route is greyed out ---
  const lines = await page.evaluate(() => {
    const paths = Array.from(document.querySelectorAll('#mapNav path.leaflet-interactive'));
    const stroke = (p) => p.getAttribute('stroke') || '';
    return {
      grey: paths.filter((p) => /6c7f93/i.test(stroke(p))).length,
      bright: paths.filter((p) => /35c98a|f0b429|5aa9e6/i.test(stroke(p))).length,
    };
  });
  check('the travelled part of the route is grey', lines.grey > 0, lines.grey + ' grey line(s)');
  check('the remaining route is still bright', lines.bright > 0, lines.bright + ' bright line(s)');

  // --- 8. the info panel shows speed, remaining distance/time/ETA and safety ---
  const panel = await page.evaluate(() => ({
    speed: document.getElementById('navSpeed').textContent.trim(),
    remainingDist: document.getElementById('navRemainingDist').textContent.trim(),
    remainingTime: document.getElementById('navRemainingTime').textContent.trim(),
    eta: document.getElementById('navEta').textContent.trim(),
    safety: document.getElementById('navSafetyVal').textContent.trim(),
    compass: document.getElementById('navCompassText').textContent.trim(),
  }));
  check('speed is shown', /^\d+$/.test(panel.speed), panel.speed + ' km/h');
  check('remaining distance is shown', /m|km/.test(panel.remainingDist), panel.remainingDist);
  check('remaining time is shown', /min|h/.test(panel.remainingTime), panel.remainingTime);
  check('an arrival time is shown', /\d/.test(panel.eta), panel.eta);
  check('the road ahead safety score is shown', /\/100|no data/.test(panel.safety), panel.safety);
  check('the compass shows a cardinal direction', /^[NSEW]{1,2}\s\d+°$/.test(panel.compass), panel.compass);

  // --- 9. the next-turn banner has an instruction and a distance ---
  const banner = await page.evaluate(() => ({
    instruction: document.getElementById('navInstruction').textContent.trim(),
    dist: document.getElementById('navStepDist').textContent.trim(),
    icon: document.getElementById('navIcon').textContent.trim(),
    steps: window.SafePathNav._state.route.steps.length,
  }));
  check('turn-by-turn steps were fetched', banner.steps > 0, banner.steps + ' steps');
  check('the banner shows an instruction', banner.instruction.length > 3, banner.instruction);
  check('the banner shows a distance to the turn', banner.dist.length > 0, banner.dist);
  check('the banner has a direction icon', banner.icon.length > 0, banner.icon);

  // --- 10. north-up / heading-up toggle ---
  // The button carries an icon plus a label, so read the label span (what a
  // sighted user reads) and the accessible name separately.
  const northState = () => page.evaluate(() => {
    const btn = document.getElementById('navNorthBtn');
    const label = btn.querySelector('.nav__ctrlText');
    return {
      label: (label ? label.textContent : btn.textContent).trim(),
      pressed: btn.getAttribute('aria-pressed'),
      aria: btn.getAttribute('aria-label'),
    };
  });
  const before = await page.evaluate(() => ({
    rotor: document.querySelector('.nav__rotor').style.transform,
  }));
  await page.click('#navNorthBtn');
  await wait(500);
  const after = await page.evaluate(() => ({
    rotor: document.querySelector('.nav__rotor').style.transform,
  }));
  const afterState = await northState();
  check('the orientation toggle switches to north-up',
    afterState.label === 'north-up' && afterState.pressed === 'true', afterState.label);
  check('north-up states the mode in the accessible name',
    /north up/i.test(afterState.aria || ''), afterState.aria);
  check('north-up removes the map rotation', /rotate\(-?0(\.0)?deg\)|rotate\(0deg\)/.test(after.rotor) || after.rotor === '', after.rotor);
  await page.click('#navNorthBtn');
  await wait(400);
  const backState = await northState();
  check('it switches back to heading-up', backState.label === 'heading-up', backState.label);

  // --- 11. the safety alert banner appears when a hazard is ahead ---
  const alertBanner = await page.evaluate(async () => {
    const nav = window.SafePathNav;
    const st = nav._state;
    const hazards = st.route.hazards || [];
    if (!hazards.length) return { skipped: true };
    // Stand 120 m before the last hazard on the route, walking there in 20 m
    // steps with 2.5 s timestamps so the pace stays plausible in either
    // direction. (Walking backward is allowed now, so this works whether the
    // hazard is ahead of or behind the current position.)
    const h = hazards[hazards.length - 1];
    const target = Math.max(0, h.along_m - 120);
    // Steps of 40 m: large enough that a real change of direction is
    // unambiguous rather than being absorbed as GPS jitter.
    const step = target >= st.along_m ? 40 : -40;
    let t = Date.now() - 120000;
    let guard = 0;
    while (Math.abs(st.along_m - target) > 3 && guard++ < 800) {
      const next = step > 0 ? Math.min(target, st.along_m + step) : Math.max(target, st.along_m + step);
      const p = nav._pointAt(st.coords, st.cum, next);
      nav._injectFix({ lat: p[0], lng: p[1], accuracy: 8, heading: 0, speed: 1.4, at: (t += 2500) });
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 500));
    const box = document.getElementById('navAlert');
    return {
      shown: box && !box.hidden,
      text: document.getElementById('navAlertText').textContent,
      kind: box ? box.dataset.kind : null,
      ahead: Math.round(h.along_m - st.along_m),
    };
  });
  if (alertBanner.skipped) {
    check('a safety alert banner is available for hazards ahead', true, 'no hazards on this route to show');
  } else {
    check('a safety alert appears for a hazard ahead', alertBanner.shown,
      alertBanner.ahead + ' m ahead · ' + alertBanner.text.slice(0, 60));
    check('the alert names the hazard type', /incident area|poorly lit/i.test(alertBanner.text), alertBanner.text.slice(0, 50));
    check('the alert does not repeat the same phrase twice',
      !/poorly lit stretch.*\(poorly lit stretch\)/i.test(alertBanner.text), alertBanner.text.slice(0, 60));
  }

  // --- 12. going off route triggers a reroute offer ---
  const offRoute = await page.evaluate(async () => {
    const nav = window.SafePathNav;
    const M = window.SafePathNavMath;
    const st = nav._state;
    const base = st.lastAccepted;
    // Walk straight away from the route, perpendicular to it. A north-east walk
    // is not reliable: the route curves, so the distance to the line oscillates
    // and the off-route hold keeps resetting.
    const routeHeading = M.headingAlong(st.coords, st.lastSnapIndex, 25);
    const perp = ((routeHeading + 90) * Math.PI) / 180;
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos((base.lat * Math.PI) / 180);
    const t0 = Date.now() - 40000;
    for (let i = 1; i <= 12; i++) {
      const d = 20 * i; // 20 m, 40 m, ... 240 m from the line
      nav._injectFix({
        lat: base.lat + (d * Math.cos(perp)) / mPerDegLat,
        lng: base.lng + (d * Math.sin(perp)) / mPerDegLng,
        accuracy: 8, heading: 45, speed: 1.4,
        at: t0 + i * 2500,
      });
      // 400 ms of real time per step, so the 2 s off-route hold elapses.
      await new Promise((r) => setTimeout(r, 400));
    }
    return {
      offRouteSince: st.offRouteSince,
      rerouteAt: st.rerouteAt,
      offset: st.snapped ? Math.round(st.snapped.offset_m) : null,
    };
  });
  // Give the reroute request time to come back.
  await wait(6000);
  const rerouteShown = await page.evaluate(() => {
    const box = document.getElementById('navReroute');
    return {
      shown: box && !box.hidden,
      text: document.getElementById('navRerouteText').textContent,
      pending: !!window.SafePathNav._state.pendingRoute,
    };
  });
  check('leaving the route opens the reroute prompt', rerouteShown.shown,
    'off by ' + (offRoute.offset || 0) + ' m · ' + rerouteShown.text.slice(0, 60));
  check('the prompt reports how far off route you are', /off the route|Safer route|recalculated/i.test(rerouteShown.text),
    rerouteShown.text.slice(0, 60));

  // --- 13. accepting the reroute swaps the route without ending the trip ---
  const swapped = await page.evaluate(async () => {
    const nav = window.SafePathNav;
    const before = nav._state.total_m;
    nav._acceptReroute();
    await new Promise((r) => setTimeout(r, 600));
    return {
      before, after: nav._state.total_m,
      stillActive: nav.isActive(),
      hidden: document.getElementById('navReroute').hidden,
      steps: nav._state.route.steps.length,
    };
  });
  check('the trip stays active after a reroute', swapped.stillActive);
  check('the reroute prompt closes once accepted', swapped.hidden === true);
  check('the new route carries instructions', swapped.steps > 0, swapped.steps + ' steps');

  // --- 14. arrival is detected and summarised ---
  const arrived = await page.evaluate(async () => {
    const nav = window.SafePathNav;
    const st = nav._state;
    const end = st.coords[st.coords.length - 1];
    // Walk the last stretch in realistic steps so the arrival is reached the way
    // a real trip would reach it: 20 m steps, timestamped 3 s apart (~24 km/h).
    let along = st.along_m;
    let t = Date.now() - Math.max(20000, (st.total_m - along) * 150);
    nav._setFirstFixAt(t);
    while (along < st.total_m - 10) {
      along = Math.min(st.total_m, along + 20);
      const p = nav._pointAt(st.coords, st.cum, along);
      nav._injectFix({ lat: p[0], lng: p[1], accuracy: 6, heading: 0, speed: 1.3, at: (t += 3000) });
      await new Promise((r) => setTimeout(r, 3));
    }
    nav._injectFix({ lat: end[0], lng: end[1], accuracy: 5, heading: 0, speed: 1.2, at: (t += 3000) });
    await new Promise((r) => setTimeout(r, 900));
    const sheet = document.getElementById('navArriveSheet');
    return {
      shown: sheet && !sheet.hidden,
      summary: document.getElementById('navSummary').textContent,
      watching: st.watchId != null,
      simulating: st.simulating,
    };
  });
  check('arriving shows the trip summary', arrived.shown, arrived.summary.slice(0, 80).replace(/\s+/g, ' '));
  check('arrival stops the location watcher', arrived.watching === false && arrived.simulating === false);
  const summaryFields = await page.evaluate(() => {
    const dts = Array.from(document.querySelectorAll('#navSummary dt')).map((d) => d.textContent);
    return dts.join('|');
  });
  check('the summary reports distance, time and safety',
    /Distance/i.test(summaryFields) && /Time/i.test(summaryFields) && /Safety/i.test(summaryFields),
    summaryFields);
  // Average speed is measured over the fixes, so a simulated trip still reports
  // a real pace rather than a nonsense number derived from wall-clock seconds.
  const avgShown = await page.evaluate(() => {
    const dts = Array.from(document.querySelectorAll('#navSummary dt')).map((d) => d.textContent);
    const dds = Array.from(document.querySelectorAll('#navSummary dd')).map((d) => d.textContent);
    const i = dts.findIndex((d) => /speed/i.test(d));
    return i === -1 ? null : dds[i];
  });
  check('average speed is a plausible number, not a wall-clock artefact',
    avgShown != null && /^\d+(\.\d+)? km\/h$/.test(avgShown) && parseFloat(avgShown) <= 120,
    String(avgShown));

  // --- 15. Done returns to the planner ---
  await page.click('#navArriveDone');
  await wait(1200);
  const back = await page.evaluate(() => ({
    navHidden: document.getElementById('navScreen').hidden,
    plannerVisible: getComputedStyle(document.querySelector('.app')).display !== 'none',
    bodyFlag: document.body.classList.contains('nav-active'),
    active: window.SafePathNav.isActive(),
    watching: window.SafePathNav._state.watchId != null,
  }));
  check('Done returns to the planner', back.navHidden && back.plannerVisible && !back.bodyFlag);
  check('Done closes the navigation session', back.active === false && back.watching === false);

  // --- 16. ending a route manually works, with confirmation ---
  // Make sure no sheet is left covering the controls.
  await page.evaluate(() => {
    ['navArriveSheet', 'navEndSheet', 'navPermSheet'].forEach((id) => {
      const el = document.getElementById(id); if (el) el.hidden = true;
    });
  });
  await page.evaluate(() => window.SafePathApp.startNavigation(
    document.querySelector('#routeCards .route').dataset.role));
  await page.waitForFunction(() => !document.getElementById('navScreen').hidden, { timeout: 20000 }).catch(() => {});
  await wait(1500);
  // Without location permission the explanation sheet covers the controls; this
  // section is about the End route flow, so close it.
  await page.evaluate(() => {
    const s = document.getElementById('navPermSheet'); if (s) s.hidden = true;
  });
  await page.click('#navEndBtn');
  await wait(500);
  check('End route asks for confirmation', !(await hidden(page, '#navEndSheet')));
  await page.click('#navEndCancel');
  await wait(400);
  check('Cancel keeps the trip running', (await hidden(page, '#navEndSheet')) && await page.evaluate(() => window.SafePathNav.isActive()));
  await page.click('#navEndBtn');
  await wait(400);
  await page.click('#navEndConfirm');
  await wait(1500);
  const ended = await page.evaluate(() => ({
    navHidden: document.getElementById('navScreen').hidden,
    active: window.SafePathNav.isActive(),
    watching: window.SafePathNav._state.watchId != null,
    wakeLock: window.SafePathNav._state.wakeLock,
  }));
  check('End trip stops the trip and returns to the planner', ended.navHidden && ended.active === false);
  check('ending releases the location watcher and wake lock', ended.watching === false && !ended.wakeLock);

  // --- 17. the trip summary was saved to the API ---
  const saved = await page.evaluate(async () => {
    const res = await fetch('/api/trips?limit=5');
    return res.json();
  });
  check('the finished trip is saved via the API', saved.trips && saved.trips.length > 0,
    (saved.trips ? saved.trips.length : 0) + ' trip(s) stored');

  // --- 18. 320px layout keeps controls big enough to tap ---
  await page.setViewport({ width: 320, height: 720 });
  await page.evaluate(() => window.SafePathApp.startNavigation(
    document.querySelector('#routeCards .route').dataset.role));
  await page.waitForFunction(() => !document.getElementById('navScreen').hidden, { timeout: 20000 }).catch(() => {});
  await wait(1800);
  await page.evaluate(() => {
    const s = document.getElementById('navPermSheet'); if (s) s.hidden = true;
  });
  const sizes = await page.evaluate(() => {
    const ids = ['navEndBtn', 'navShareBtn', 'navNorthBtn', 'navSimBtn', 'navVoiceBtn'];
    return ids.map((id) => {
      const el = document.getElementById(id);
      if (!el) return { id, h: 0, w: 0 };
      const r = el.getBoundingClientRect();
      return { id, h: Math.round(r.height), w: Math.round(r.width) };
    });
  });
  const tooSmall = sizes.filter((s) => s.h < 44 || s.w < 44);
  check('controls are at least 44px at 320px wide', tooSmall.length === 0,
    tooSmall.length ? tooSmall.map((s) => s.id + ' ' + s.w + 'x' + s.h).join(', ') : 'all large enough');

  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= 321);
  check('no horizontal overflow at 320px', noOverflow);

  // --- 19. simulate mode drives the trip without a real GPS ---
  await page.click('#navSimBtn');
  await wait(2500);
  const sim = await page.evaluate(() => ({
    simulating: window.SafePathNav._state.simulating,
    pressed: document.getElementById('navSimBtn').getAttribute('aria-pressed'),
    along: window.SafePathNav._state.along_m,
    speed: document.getElementById('navSpeed').textContent.trim(),
  }));
  check('simulate mode moves the arrow along the route', sim.simulating && sim.along > 0,
    Math.round(sim.along) + ' m simulated');
  check('simulate mode updates the speed readout', Number(sim.speed) > 0, sim.speed + ' km/h');
  await page.click('#navSimBtn');
  await wait(400);
  check('simulate mode can be stopped', await page.evaluate(() => window.SafePathNav._state.simulating === false));

  // --- 20. privacy: no trail of personal positions is kept ---
  const privacy = await page.evaluate(async () => {
    const res = await fetch('/api/trips?limit=3');
    const body = await res.json();
    const trip = (body.trips || [])[0] || {};
    return {
      note: body.privacy || '',
      keys: Object.keys(trip).join(','),
      // A stored trail would be an array of points or a polyline column.
      hasTrail: /(^|,)(trail|path|coords|polyline|track)(,|$)/.test(Object.keys(trip).join(',')),
      fromLat: trip.from_lat, fromLng: trip.from_lng,
    };
  });
  check('the stored trip carries no position trail', privacy.hasTrail === false, privacy.keys);
  check('the trips API states its privacy stance', /area|round|trail|not stored/i.test(privacy.note), privacy.note.slice(0, 80));

  // The share link is the one place a live position leaves the app, so it must
  // publish an area-level position rather than the precise fix.
  const rounded = await page.evaluate(async () => {
    const precise = { lat: 12.3052345678, lng: 76.6552345678 };
    const created = await (await fetch('/api/trips/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: precise.lat, lng: precise.lng, to_label: 'Test' }),
    })).json();
    const shown = await (await fetch('/api/trips/share/' + created.token)).json();
    return { precise, token: created.token, published: { lat: shown.lat, lng: shown.lng }, note: shown.accuracy_note || '' };
  });
  const moved = rounded.published.lat == null
    ? Infinity
    : Math.abs(rounded.published.lat - rounded.precise.lat) * 111320;
  check('a shared live position is published only at area level',
    moved > 0.1 && moved <= 120,
    'moved ' + Math.round(moved) + ' m from the precise fix');
  check('the share link says how precise it is', /area-level|110 m/i.test(rounded.note), rounded.note.slice(0, 60));

  // --- 22. the control stack never collides, at any common viewport ---
  // The SOS button and the map controls share one flex column, so this is the
  // regression test for the overlap bug: no control may cover another, the
  // stack must stay clear of the bottom panel (or beside it in landscape), and
  // the SOS label must stay inside its circle.
  const layout = await page.evaluate(() => {
    const measure = (id) => {
      const el = document.getElementById(id);
      if (!el || el.hidden || el.offsetParent === null) return null;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return null;
      return { id, x: b.x, y: b.y, right: b.right, bottom: b.bottom, w: b.width, h: b.height };
    };
    const stack = document.getElementById('navControls');
    const mode = stack.dataset.overflow;
    const ids = mode === 'more'
      ? ['navMoreBtn', 'navPanicBtn']
      : ['navNorthBtn', 'navRecenterBtn', 'navVoiceBtn', 'navPanicBtn'];
    const ctrls = ids.map(measure).filter(Boolean);
    const panel = document.getElementById('navBottom').getBoundingClientRect();
    const banner = document.getElementById('navBanner').getBoundingClientRect();
    const end = document.getElementById('navEndBtn').getBoundingClientRect();
    const stackBox = stack.getBoundingClientRect();
    const hit = (a, z) => !(a.right <= z.x || z.right <= a.x || a.bottom <= z.y || z.bottom <= a.y);

    const overlaps = [];
    for (let i = 0; i < ctrls.length; i++) {
      for (let j = i + 1; j < ctrls.length; j++) {
        if (hit(ctrls[i], ctrls[j])) overlaps.push(ctrls[i].id + '~' + ctrls[j].id);
      }
    }
    const others = [
      { n: 'panel', x: panel.x, y: panel.y, right: panel.right, bottom: panel.bottom },
      { n: 'banner', x: banner.x, y: banner.y, right: banner.right, bottom: banner.bottom },
      { n: 'end', x: end.x, y: end.y, right: end.right, bottom: end.bottom },
    ];
    for (const c of ctrls) for (const o of others) if (hit(c, o)) overlaps.push(c.id + '~' + o.n);

    // Each control must actually receive the tap at its own centre.
    const unreachable = [];
    for (const c of ctrls) {
      const el = document.elementFromPoint((c.x + c.right) / 2, (c.y + c.bottom) / 2);
      if (!el || !el.closest('#' + c.id)) {
        unreachable.push(c.id + '→' + (el ? (el.id || el.className || el.tagName) : 'none'));
      }
    }
    const sorted = ctrls.slice().sort((a, z) => a.y - z.y);
    let minGap = Infinity;
    for (let i = 1; i < sorted.length; i++) minGap = Math.min(minGap, sorted[i].y - sorted[i - 1].bottom);

    const sos = document.getElementById('navPanicBtn').getBoundingClientRect();
    const word = document.querySelector('.panic__word').getBoundingClientRect();
    const hint = document.querySelector('.panic__hint').getBoundingClientRect();
    const inside = (a, z) => a.x >= z.x - 0.5 && a.right <= z.right + 0.5 && a.y >= z.y - 0.5 && a.bottom <= z.bottom + 0.5;

    return {
      mode, count: ctrls.length, overlaps, unreachable,
      minGap: minGap === Infinity ? null : Math.round(minGap),
      tooSmall: ctrls.filter((c) => c.w < 44 || c.h < 44).map((c) => c.id + ' ' + Math.round(c.w) + 'x' + Math.round(c.h)),
      // "stack" sits above the panel; "more" sits in a gutter beside it.
      separation: mode === 'stack'
        ? Math.round(panel.y - stackBox.bottom)
        : Math.round(stackBox.x - panel.right),
      sosInside: inside(word, sos) && inside(hint, sos),
      sosSize: Math.round(sos.width) + 'x' + Math.round(sos.height),
      hOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  check('every control is reachable at its own centre', layout.unreachable.length === 0,
    layout.unreachable.join(', '));
  check('no control overlaps another control or the panel/banner',
    layout.overlaps.length === 0, layout.overlaps.join(', '));
  check('the stack keeps at least 8px between controls',
    layout.minGap !== null && layout.minGap >= 8, layout.minGap + 'px');
  check('the stack is clear of the bottom panel', layout.separation >= 0,
    layout.separation + 'px (' + layout.mode + ' mode)');
  check('every control is at least 44px to tap',
    layout.tooSmall.length === 0, layout.tooSmall.join(', ') || 'all large enough');
  check('the SOS label stays inside its circle', layout.sosInside, layout.sosSize);
  check('the control stack does not cause horizontal overflow', !layout.hOverflow);

  // --- 23. the same holds across the common phone and tablet widths ---
  const VIEWPORTS = [
    { w: 320, h: 720 }, { w: 360, h: 640 }, { w: 375, h: 667 },
    { w: 414, h: 896 }, { w: 768, h: 1024 }, { w: 812, h: 375 },
  ];
  const layoutFails = [];
  for (const v of VIEWPORTS) {
    await page.setViewport({ width: v.w, height: v.h });
    await wait(500);
    const r = await page.evaluate(() => {
      window.SafePathNav._syncControls();
      const measure = (id) => {
        const el = document.getElementById(id);
        if (!el || el.hidden || el.offsetParent === null) return null;
        const b = el.getBoundingClientRect();
        if (b.width === 0) return null;
        return { id, x: b.x, y: b.y, right: b.right, bottom: b.bottom, w: b.width, h: b.height };
      };
      const stack = document.getElementById('navControls');
      const mode = stack.dataset.overflow;
      const ids = mode === 'more'
        ? ['navMoreBtn', 'navPanicBtn']
        : ['navNorthBtn', 'navRecenterBtn', 'navVoiceBtn', 'navPanicBtn'];
      const ctrls = ids.map(measure).filter(Boolean);
      const panel = document.getElementById('navBottom').getBoundingClientRect();
      const stackBox = stack.getBoundingClientRect();
      const hit = (a, z) => !(a.right <= z.x || z.right <= a.x || a.bottom <= z.y || z.bottom <= a.y);
      const problems = [];
      for (let i = 0; i < ctrls.length; i++) {
        for (let j = i + 1; j < ctrls.length; j++) {
          if (hit(ctrls[i], ctrls[j])) problems.push('overlap ' + ctrls[i].id + '~' + ctrls[j].id);
        }
      }
      for (const c of ctrls) {
        const el = document.elementFromPoint((c.x + c.right) / 2, (c.y + c.bottom) / 2);
        if (!el || !el.closest('#' + c.id)) problems.push('covered ' + c.id);
        if (c.w < 44 || c.h < 44) problems.push('small ' + c.id);
      }
      const sep = mode === 'stack' ? panel.y - stackBox.bottom : stackBox.x - panel.right;
      if (sep < 0) problems.push('behind panel');
      if (document.documentElement.scrollWidth > window.innerWidth + 1) problems.push('overflow');
      return { mode, count: ctrls.length, problems };
    });
    if (r.problems.length) layoutFails.push(v.w + 'x' + v.h + ': ' + r.problems.join('; '));
    if (r.count < 2) layoutFails.push(v.w + 'x' + v.h + ': only ' + r.count + ' control(s)');
  }
  check('no layout problems at 320/360/375/414/768/812 widths',
    layoutFails.length === 0, layoutFails.join(' | '));
  await page.setViewport({ width: 1440, height: 1000 });
  await wait(400);

  // clean up: leave the app on the planner
  await page.evaluate(() => window.SafePathNav.endTrip('aborted'));
  await page.setViewport({ width: 1440, height: 1000 });

  check('no console errors during the whole navigation flow', errors.length === 0,
    errors.slice(0, 3).join(' | '));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('Navigation smoke test crashed:', e);
  process.exit(1);
});
