/* ==========================================================================
   SafePath live navigation
   --------------------------------------------------------------------------
   A self-contained trip view: it takes one route (the one the user picked) and
   drives a focused, full-screen navigation screen from it.

   What lives here, and why:
     - its own Leaflet map, because the trip view replaces the planner entirely
     - a "rotor" wrapper around the map so heading-up rotation is a plain CSS
       transform and never fights Leaflet's own pan transforms
     - geolocation.watchPosition with a noisy-fix filter and position smoothing
     - snapping to the route line (30 m tolerance) so the arrow does not jitter
     - turn-by-turn banner, compass, speed/ETA panel, hazard warnings
     - rerouting when the user drifts more than 40 m off the line
     - wake lock, voice guidance, share, check-in, and a simulate mode so the
       whole flow can be exercised from a desk

   All safety numbers are estimates from reported data, not guarantees.
   ========================================================================== */
'use strict';

(function () {
  const M = window.SafePathNavMath;
  if (!M) { console.error('[SafePath] nav_math.js must load before nav.js'); return; }

  const ROLE_COLOUR = { safest: '#35c98a', balanced: '#f0b429', fastest: '#5aa9e6', alternative: '#9fb0c2' };
  const NAV_ZOOM = 17;
  const ARRIVE_M = 30;          // arrival radius
  const OFF_ROUTE_M = 40;       // "off route" threshold
  const OFF_ROUTE_HOLD_MS = 2000; // must be off route this long before we act
  // Backwards movement smaller than this is treated as GPS noise and ignored;
  // anything larger is a real change of direction.
  const BACKWARD_TOLERANCE_M = 20;
  const REROUTE_COOLDOWN_MS = 15000;
  const SNAP_TOLERANCE_M = 30;  // snap the display to the line within this
  // How far back and forward along the line to look when snapping a fix. The
  // look-back has to be generous enough that a user who turns around still
  // tracks the line, and the look-ahead bounded so a route that doubles back
  // does not drag the arrow onto the return leg.
  const SNAP_LOOKBACK = 30;
  const SNAP_LOOKAHEAD = 25;
  const CHECKIN_STILL_MS = 2 * 60 * 1000;
  const CHECKIN_MIN_RISK = 45;
  const SIM_SPEED_MPS = 1.4;    // walking pace for the simulated trip
  const UI_THROTTLE_MS = 200;   // battery care: don't touch the DOM every fix
  const SPEAK_AT_M = 120;       // announce a turn this far before it

  const $ = (id) => document.getElementById(id);

  /**
   * Keep the control stack clear of the bottom panel.
   *
   * The panel's height is not a constant: it changes with the compass, the End
   * route button wrapping, the GPS line, and the browser chrome hiding. Rather
   * than guess a number, publish the measured height as --nav-panel-h and let
   * the CSS place the stack above it. A ResizeObserver catches every change, so
   * the controls can never drift behind the panel.
   *
   * On a screen too short for the stack (landscape phones), the three map
   * controls collapse into one "More" button that opens a sheet, so SOS always
   * has room and stays reachable.
   */
  const controls = { ro: null, panel: null, queued: false };

  function syncControlOverflow() {
    const stack = $('navControls');
    if (!stack) return;
    const more = $('navMoreBtn');
    const compact = $('navRecenterBtn');
    // Measure the full stack: hide the "more" button, show everything else.
    if (more) more.hidden = true;
    if (compact) compact.hidden = false;

    const panel = $('navBottom');
    const panelTop = panel ? panel.getBoundingClientRect().top : window.innerHeight;
    const room = panelTop - stack.getBoundingClientRect().height - 24;
    const overflow = room < 0;

    if (more) more.hidden = !overflow;
    if (compact) compact.hidden = overflow;
    stack.dataset.overflow = overflow ? 'more' : 'stack';
    if (!overflow) return;

    // Keep the sheet's rows in step with the real control state.
    const north = $('navNorthBtn');
    const voice = $('navVoiceBtn');
    const mNorth = $('navMoreNorth');
    const mVoice = $('navMoreVoice');
    if (mNorth && north) {
      const northUp = north.getAttribute('aria-pressed') === 'true';
      mNorth.textContent = northUp ? 'Map: north up' : 'Map: heading up';
      mNorth.setAttribute('aria-pressed', String(northUp));
    }
    if (mVoice && voice) {
      const on = voice.getAttribute('aria-pressed') === 'true';
      mVoice.textContent = on ? 'Voice guidance: on' : 'Voice guidance: off';
      mVoice.setAttribute('aria-pressed', String(on));
    }
  }

  function queueSyncControlOverflow() {
    if (controls.queued) return;
    controls.queued = true;
    requestAnimationFrame(() => { controls.queued = false; syncControlOverflow(); });
  }

  function watchPanelHeight() {
    const panel = $('navBottom');
    if (!panel || controls.panel === panel) return;
    controls.panel = panel;
    const apply = () => {
      const h = Math.round(panel.getBoundingClientRect().height);
      if (h > 0) document.documentElement.style.setProperty('--nav-panel-h', h + 'px');
      queueSyncControlOverflow();
    };
    apply();
    if (typeof ResizeObserver === 'function') {
      controls.ro = new ResizeObserver(apply);
      controls.ro.observe(panel);
    }
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
  }

  function unwatchPanelHeight() {
    if (controls.ro) { controls.ro.disconnect(); controls.ro = null; }
    controls.panel = null;
  }

  const state = {
    active: false,
    route: null,       // { coords, steps, hazards, distance_m, duration_s, safety, role, mode }
    coords: [],
    cum: [],
    total_m: 0,
    role: 'safest',
    mode: 'walk',
    from: null,
    to: null,
    fromLabel: '',
    toLabel: '',

    map: null,
    rotor: null,
    layers: null,
    marker: null,
    accuracy: null,

    orientation: 'heading', // 'heading' | 'north'
    follow: true,
    heading: 0,             // travel heading (world)
    mapHeading: 0,          // rotation currently applied to the map
    rotorDeg: 0,            // continuous rotor angle, so it never spins the long way
    deviceHeading: null,    // from the orientation sensor, when available
    compassSource: 'gps',

    watchId: null,
    simTimer: null,
    simAlong: 0,
    simulating: false,
    wakeLock: null,

    lastAccepted: null,     // last trustworthy fix
    displayed: null,        // smoothed position actually drawn
    target: null,           // where the smoothing is heading
    lastFixAt: 0,
    lastGpsAt: 0,

    along_m: 0,
    travelled_m: 0,
    speedMps: 0,
    speedSamples: [],
    snapped: null,
    lastSnapIndex: 0,

    stepIndex: -1,
    spokenStepIndex: -1,
    spokenNearStep: -1,
    dismissedHazardBefore: -1,
    rerouteAt: 0,
    reroutePending: false,
    offRouteSince: 0,
    lastUiAt: 0,

    stillSince: Date.now(),
    checkinShown: false,
    startedAt: Date.now(),
    arrived: false,

    shareToken: null,
    shareTimer: null,
    voiceOn: true,
    gpsState: 'waiting',   // waiting | ok | lost | low_accuracy | denied | unavailable
    wakeLockWarned: false,
  };

  /* ------------------------------ helpers ------------------------------- */

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m');
  const fmtClock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const riskColour = (r) => (r >= 60 ? '#f0616b' : r >= 35 ? '#f0b429' : '#35c98a');

  /** The app's API helper, when app.js has loaded; otherwise a small fallback. */
  async function api(path, opts = {}) {
    if (window.SafePathApp && window.SafePathApp.api) return window.SafePathApp.api(path, opts);
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
    if (!res.ok) { const e = new Error(json.error || 'Request failed (' + res.status + ')'); e.status = res.status; throw e; }
    return json;
  }

  function announce(text) {
    // The banner is aria-live="assertive", so screen readers pick up changes on
    // its own. This handles the separate case of a one-off status line.
    const el = $('navGps');
    if (el) el.textContent = text;
  }

  function speak(text) {
    if (!state.voiceOn || !text) return;
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.lang = 'en-IN';
      window.speechSynthesis.speak(u);
    } catch { /* voice guidance is a bonus, never a failure */ }
  }

  /* ------------------------------- map ---------------------------------- */

  /**
   * Build the navigation map. The Leaflet container is deliberately twice the
   * size of the viewport and offset by half, inside a "rotor" element. Rotating
   * the rotor therefore rotates the whole map about the centre of the screen
   * without touching the transforms Leaflet applies to its own panes, and the
   * doubled size means the corners stay covered at any angle.
   */
  function buildMap() {
    const host = $('mapNav');
    if (!host) return null;
    if (state.map) return state.map;

    if (typeof L === 'undefined' || !L || typeof L.map !== 'function') {
      const fb = $('mapFallbackNav');
      if (fb) fb.hidden = false;
      return null;
    }

    const rotor = document.createElement('div');
    rotor.className = 'nav__rotor';
    const inner = document.createElement('div');
    inner.className = 'nav__rotorInner';
    rotor.appendChild(inner);
    host.appendChild(rotor);
    state.rotor = rotor;

    const map = L.map(inner, {
      center: state.coords[0] || [12.3052, 76.6554],
      zoom: NAV_ZOOM,
      zoomControl: false,
      attributionControl: false,
      // A compass-less phone should still be usable, so the zoom buttons stay
      // available in the corner; the controls that matter are in the panel.
      dragging: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    map.whenReady(() => setTimeout(() => map.invalidateSize(), 0));

    state.layers = {
      hazards: L.layerGroup().addTo(map),
      remaining: L.layerGroup().addTo(map),
      travelled: L.layerGroup().addTo(map),
    };

    // Panning by hand means "I want to look around": stop following and, in
    // heading-up mode, switch to north-up so the map does not fight the finger.
    map.on('dragstart', releaseFollow);

    state.map = map;
    return map;
  }

  function drawRoute() {
    if (!state.map || !state.layers) return;
    const L2 = state.layers;
    L2.remaining.clearLayers();
    L2.travelled.clearLayers();
    if (!state.coords.length) return;

    const split = splitAt(state.coords, state.cum, state.along_m);
    const colour = ROLE_COLOUR[state.role] || ROLE_COLOUR.safest;

    // The part already walked: grey and faded, but still visible so the user can
    // see where they came from.
    if (split.travelled.length > 1) {
      L.polyline(split.travelled, { color: '#6c7f93', weight: 6, opacity: 0.75, lineCap: 'round' })
        .addTo(L2.travelled);
    }
    // The road ahead: bright, with a soft casing so it reads in sunlight.
    if (split.remaining.length > 1) {
      L.polyline(split.remaining, { color: colour, weight: 11, opacity: 0.25, lineCap: 'round' })
        .addTo(L2.remaining);
      L.polyline(split.remaining, { color: colour, weight: 6, opacity: 0.98, lineCap: 'round' })
        .addTo(L2.remaining);
    }
  }

  /** Split a polyline into [travelled, remaining] at `alongM`. */
  function splitAt(coords, cum, alongM) {
    const travelled = [];
    const remaining = [];
    let placed = false;
    for (let i = 0; i < coords.length; i++) {
      if (!placed && cum[i] >= alongM) {
        const prev = Math.max(0, i - 1);
        const span = cum[i] - cum[prev] || 1;
        const t = M.clamp((alongM - cum[prev]) / span, 0, 1);
        const point = [
          coords[prev][0] + (coords[i][0] - coords[prev][0]) * t,
          coords[prev][1] + (coords[i][1] - coords[prev][1]) * t,
        ];
        if (travelled.length === 0) travelled.push(coords[0]);
        travelled.push(point);
        remaining.push(point);
        placed = true;
      } else if (!placed) {
        travelled.push(coords[i]);
      } else {
        remaining.push(coords[i]);
      }
    }
    if (!placed) return { travelled: coords.slice(), remaining: [] };
    return { travelled, remaining };
  }

  function drawHazards() {
    if (!state.map || !state.layers) return;
    const L2 = state.layers;
    L2.hazards.clearLayers();
    (state.route.hazards || []).forEach((h) => {
      if (h.kind !== 'hotspot') return;
      L.circle([h.lat, h.lng], {
        radius: 150, color: riskColour(h.risk), weight: 1.5, dashArray: '4 4',
        fillColor: riskColour(h.risk), fillOpacity: 0.05,
      }).bindTooltip(`${esc(h.label)} · risk ${h.risk}/100`).addTo(L2.hazards);
    });
  }

  function setOrientation(mode) {
    state.orientation = mode;
    const btn = $('navNorthBtn');
    const headingUp = mode === 'heading';
    if (btn) {
      // The glyph shows what tapping will do; the label names the current mode.
      const icon = btn.querySelector('.nav__ctrlIcon');
      const label = btn.querySelector('.nav__ctrlText');
      if (icon) icon.textContent = headingUp ? '↑' : '⤒';
      if (label) label.textContent = headingUp ? 'heading-up' : 'north-up';
      btn.setAttribute('aria-pressed', String(!headingUp));
      const name = headingUp ? 'Map is heading up. Switch to north up.' : 'Map is north up. Switch to heading up.';
      btn.setAttribute('aria-label', name);
      btn.title = name;
    }
    applyRotation();
    queueSyncControlOverflow();
  }

  function applyRotation() {
    if (!state.rotor) return;
    const target = state.orientation === 'heading' ? state.heading : 0;
    // Rotate the opposite way so the direction of travel points to the top. The
    // angle is kept continuous rather than normalised to 0..360: walking north
    // with a little GPS wobble would otherwise swing the rotor through a full
    // turn as the heading crosses the 0/360 seam.
    const delta = M.angleDelta(state.rotorDeg, -target);
    state.rotorDeg += delta;
    state.mapHeading = target;
    state.rotor.style.transform = `rotate(${state.rotorDeg.toFixed(1)}deg)`;
    // The marker sits inside the rotor, so its own rotation is only the
    // difference between where the user is heading and which way the map is up.
    if (state.marker && state.marker.getElement()) {
      const el = state.marker.getElement().querySelector('.nav-arrow');
      if (el) el.style.transform = `rotate(${M.angleDelta(state.mapHeading, state.heading).toFixed(1)}deg)`;
    }
  }

  function ensureMarker() {
    if (!state.map || state.marker) return;
    const html = '<div class="nav-arrow" aria-hidden="true">' +
      '<svg viewBox="0 0 48 48" width="46" height="46">' +
      '<circle cx="24" cy="24" r="17" class="nav-arrow__halo" />' +
      '<path d="M24 6 L34 38 L24 31 L14 38 Z" class="nav-arrow__body" />' +
      '</svg></div>';
    const icon = L.divIcon({ className: 'nav-arrowWrap', html, iconSize: [46, 46], iconAnchor: [23, 23] });
    state.marker = L.marker(state.displayed || state.coords[0], { icon, interactive: false, zIndexOffset: 1000 })
      .addTo(state.map);
    state.accuracy = L.circle(state.displayed || state.coords[0], {
      radius: 25, color: '#c8cbd2', weight: 1, opacity: 0.5,
      fillColor: '#c8cbd2', fillOpacity: 0.08, interactive: false,
    }).addTo(state.map);
  }

  /* --------------------------- trip lifecycle --------------------------- */

  /**
   * Start navigation on a route object from the planner
   * ({ coords, path, steps?, hazards?, distance_m, duration_s, safety_score, role }).
   * The steps and hazards are fetched for the exact geometry being used.
   */
  async function start(plan, opts = {}) {
    if (!plan || !plan.coords) { console.error('[SafePath] start() needs a route with coords'); return; }
    const from = plan.coords[0];
    const to = plan.coords[plan.coords.length - 1];

    state.active = true;
    state.role = opts.role || plan.role || 'safest';
    state.mode = opts.mode || plan.mode || 'walk';
    state.from = { lat: from[0], lng: from[1] };
    state.to = { lat: to[0], lng: to[1] };
    state.fromLabel = opts.fromLabel || '';
    state.toLabel = opts.toLabel || '';
    state.coords = plan.coords.map(([lat, lng]) => [lat, lng]);
    state.cum = M.cumulativeDistances(state.coords);
    state.total_m = state.cum[state.cum.length - 1] || 0;
    state.along_m = 0;
    state.travelled_m = 0;
    state.startedAt = Date.now();
    state.arrived = false;
    state.follow = true;
    state.simulating = false;
    state.lastAccepted = null;
    state.firstFixAt = null;
    state.displayed = null;
    state.target = null;
    state.stepIndex = -1;
    state.rotorDeg = 0;
    state.spokenStepIndex = -1;
    state.spokenNearStep = -1;
    state.dismissedHazardBefore = -1;
    state.rerouteAt = 0;
    state.reroutePending = false;
    state.offRouteSince = 0;
    state.stillSince = Date.now();
    state.checkinShown = false;
    state.gpsState = 'waiting';
    state.route = {
      coords: state.coords,
      steps: plan.steps || [],
      hazards: plan.hazards || [],
      safety: plan.safety || {
        safety_score: plan.safety_score, mean_risk: plan.mean_risk,
        p90_risk: plan.p90_risk, max_risk: plan.max_risk, covered: plan.covered,
      },
      distance_m: plan.distance_m || state.total_m,
      duration_s: plan.duration_s || 0,
    };

    // Full screen trip view: hide the planner chrome.
    $('navScreen').hidden = false;
    document.body.classList.add('nav-active');
    const app = document.querySelector('.app');
    if (app) app.setAttribute('aria-hidden', 'true');

    setOrientation('heading');
    buildMap();
    ensureMarker();
    drawHazards();
    drawRoute();
    resetPanel();
    // The panel is on screen now, so its real height can be measured.
    watchPanelHeight();

    // Instructions and hazards for exactly this geometry. The planner may not
    // have asked for steps, so fetch them here rather than guessing.
    if (!state.route.steps.length) {
      await loadNavDetails(from, to);
    }

    if (opts.simulate) {
      startSimulation();
      return;
    }
    await requestLocation();
  }

  /** Fetch steps + hazards for the route being navigated. */
  async function loadNavDetails(from, to) {
    try {
      const nav = await api('/api/navigation', {
        method: 'POST',
        body: JSON.stringify({
          from: { lat: from[0], lng: from[1] },
          to: { lat: to[0], lng: to[1] },
          mode: state.mode,
          role: state.role,
          departure: 'now',
        }),
      });
      // Only adopt the geometry if it matches what we are already drawing, so
      // the line never changes under the user mid-trip.
      if (nav.coords && Math.abs(nav.distance_m - state.route.distance_m) < 250) {
        state.route.steps = nav.steps || [];
        state.route.hazards = nav.hazards || [];
        state.route.safety = nav.safety || state.route.safety;
      } else {
        state.route.steps = nav.steps || [];
        state.route.hazards = nav.hazards || [];
      }
      if (nav.note) announce(nav.note);
      drawHazards();
      renderInstruction(true);
    } catch (e) {
      announce('Turn-by-turn instructions are unavailable (' + e.message + '). Follow the highlighted line.');
    }
  }

  function resetPanel() {
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    set('navSpeed', '0');
    set('navRemainingDist', fmtDist(state.total_m));
    set('navRemainingTime', fmtTime(state.route.duration_s));
    set('navEta', fmtClock(new Date(Date.now() + state.route.duration_s * 1000)));
    set('navSafetyVal', '—');
    set('navSafetyNote', '');
    set('navCompassText', '—');
    set('navStepDist', '');
    set('navStreet', '');
    set('navInstruction', 'Waiting for GPS…');
    set('navIcon', '↑');
    // The panel's content just changed, so re-measure and re-check the stack.
    watchPanelHeight();
    const alert = $('navAlert'); if (alert) alert.hidden = true;
    const reroute = $('navReroute'); if (reroute) reroute.hidden = true;
    const checkin = $('navCheckin'); if (checkin) checkin.hidden = true;
    const share = $('navShareBtn'); if (share) share.textContent = 'Share my live trip';
  }

  function fmtTime(s) {
    const min = Math.round(s / 60);
    if (min < 60) return min + ' min';
    return Math.floor(min / 60) + ' h ' + (min % 60) + ' min';
  }

  /* --------------------------- geolocation ------------------------------ */

  async function requestLocation() {
    if (!navigator.geolocation) {
      state.gpsState = 'unavailable';
      showPermissionSheet('This browser does not provide location to web pages.', false);
      return;
    }
    state.gpsState = 'waiting';
    announce('Waiting for GPS signal…');
    watch();
  }

  function watch() {
    if (state.watchId != null) return;
    state.watchId = navigator.geolocation.watchPosition(
      onFix,
      onGeoError,
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
    );
  }

  function unwatch() {
    if (state.watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(state.watchId);
    }
    state.watchId = null;
  }

  function onGeoError(err) {
    const denied = err && (err.code === 1 || /denied|permission/i.test(err.message || ''));
    state.gpsState = denied ? 'denied' : 'lost';
    const msg = denied
      ? 'Location permission was denied.'
      : (err && err.message ? err.message : 'Your location is unavailable right now.');
    announce(msg + ' You can run a simulated trip instead.');
    showPermissionSheet(msg, true);
  }

  function showPermissionSheet(message, allowSim) {
    const sheet = $('navPermSheet');
    if (!sheet) return;
    const body = $('navPermBody');
    if (body) body.textContent = message + ' SafePath uses your location only during this trip.';
    const sim = $('navPermSim');
    if (sim) sim.hidden = !allowSim;
    sheet.hidden = false;
  }

  /** A raw position from watchPosition (or the simulator). */
  function onFix(pos) {
    const c = pos.coords || pos;
    const fix = {
      lat: c.latitude,
      lng: c.longitude,
      accuracy: c.accuracy,
      heading: c.heading != null && isFinite(c.heading) && c.heading >= 0 ? c.heading : null,
      speed: c.speed != null && isFinite(c.speed) && c.speed >= 0 ? c.speed : null,
      at: pos.timestamp || Date.now(),
    };
    applyFix(fix);
  }

  /**
   * Filter, snap, and smooth a fix, then update everything that depends on it.
   * Kept separate from onFix so the simulator and the tests drive the exact
   * same path as a real GPS.
   */
  function applyFix(fix) {
    if (!state.active || state.arrived) return;
    state.lastGpsAt = Date.now();

    const verdict = M.acceptFix(fix, state.lastAccepted, { maxAccuracyM: 100, maxSpeedMps: 14 });
    if (!verdict.ok) {
      if (verdict.reason === 'low_accuracy') {
        state.gpsState = 'low_accuracy';
        announce(`Weak GPS signal (accurate to about ${Math.round(fix.accuracy)} m). Move to open sky.`);
      } else if (verdict.reason === 'jump') {
        state.gpsState = 'ok';
        announce('Ignoring a jump in the GPS signal.');
      }
      return;
    }
    state.gpsState = 'ok';
    state.lastAccepted = fix;
    // Remember when the first usable fix arrived, so the trip's average speed is
    // measured over the fixes rather than over the page's lifetime.
    if (!state.firstFixAt) state.firstFixAt = fix.at || Date.now();

    // Snap to the line, searching a window around the last match so a route that
    // doubles back does not drag the arrow onto the wrong leg, while still
    // following a user who turns around.
    const snap = M.snapToLine([fix.lat, fix.lng], state.coords, {
      fromIndex: Math.max(0, state.lastSnapIndex - SNAP_LOOKBACK),
      lookahead: SNAP_LOOKAHEAD,
    });
    if (snap) {
      state.lastSnapIndex = snap.index;
      state.snapped = snap;
      const along = M.alongRoute(snap, state.coords, state.cum);
      // Absorb small backwards jitter from GPS noise, but accept a genuine
      // backward move (the user turned around) so the remaining distance and ETA
      // stay honest instead of freezing at the furthest point reached. The
      // tolerance scales with how uncertain the fix is.
      const backTolerance = Math.max(BACKWARD_TOLERANCE_M, (fix.accuracy || 0) * 0.75);
      if (along >= state.along_m - backTolerance) {
        state.along_m = Math.max(state.along_m, along);
      } else {
        state.along_m = along;
      }
      state.travelled_m = state.along_m;
    }

    // What we actually draw: the snapped point while close to the line (a stable
    // display), the raw fix once the user is genuinely off route.
    const offset = snap ? snap.offset_m : Infinity;
    const drawPoint = (snap && offset <= SNAP_TOLERANCE_M)
      ? { lat: snap.lat, lng: snap.lng }
      : { lat: fix.lat, lng: fix.lng };
    state.target = drawPoint;
    state.displayed = M.smoothPosition(state.displayed, { ...drawPoint, accuracy: fix.accuracy }, { t: 0.4 });

    // Heading: prefer the movement direction, fall back to the route bearing,
    // then to the device compass.
    updateHeading(fix, snap);
    updateSpeed(fix);

    if (offset > OFF_ROUTE_M) handleOffRoute(offset);
    else { state.offRouteSince = 0; hideReroutePrompt(); }

    checkArrival();
    checkStillness();
    updateHazards();
    updateStats();
    renderInstruction();
    followIfNeeded();
  }

  function updateHeading(fix, snap) {
    let heading = null;
    if (fix.heading != null) heading = fix.heading;
    else if (state.lastAccepted && state.lastAccepted !== fix) {
      // GPS often omits heading when stationary; derive it from movement.
      const prev = state.lastAccepted;
      const d = M.haversineM(prev.lat, prev.lng, fix.lat, fix.lng);
      if (d > 3) heading = M.bearingDeg(prev.lat, prev.lng, fix.lat, fix.lng);
    }
    if (heading == null && snap) {
      heading = M.headingAlong(state.coords, snap.index, 30);
      state.compassSource = 'route';
    } else if (heading != null) {
      state.compassSource = fix.heading != null ? 'gps' : 'route';
    }
    if (heading != null) state.heading = heading;
    updateCompass();
    applyRotation();
  }

  function updateSpeed(fix) {
    if (fix.speed != null) {
      state.speedMps = fix.speed;
    } else if (state.lastAccepted && state.lastAccepted !== fix) {
      const prev = state.lastAccepted;
      const dt = (fix.at - prev.at) / 1000;
      if (dt > 0.5) {
        const d = M.haversineM(prev.lat, prev.lng, fix.lat, fix.lng);
        state.speedMps = d / dt;
      }
    }
    if (state.speedMps < 0.4) state.speedMps = 0; // GPS noise while standing still
    state.speedSamples.push(state.speedMps);
    if (state.speedSamples.length > 20) state.speedSamples.shift();
  }

  function followIfNeeded() {
    if (!state.follow || !state.map || !state.displayed) return;
    state.map.setView([state.displayed.lat, state.displayed.lng], state.map.getZoom(), { animate: false });
    const acc = state.accuracy;
    if (acc) {
      acc.setLatLng([state.displayed.lat, state.displayed.lng]);
      const a = state.lastAccepted && isFinite(state.lastAccepted.accuracy) ? state.lastAccepted.accuracy : 25;
      acc.setRadius(Math.max(10, Math.min(200, a)));
    }
    if (state.marker) state.marker.setLatLng([state.displayed.lat, state.displayed.lng]);
  }

  /* ------------------------------ arrival ------------------------------- */

  function checkArrival() {
    const remaining = Math.max(0, state.total_m - state.along_m);
    const dToEnd = state.displayed
      ? M.haversineM(state.displayed.lat, state.displayed.lng, state.to.lat, state.to.lng)
      : Infinity;
    if (remaining <= ARRIVE_M || dToEnd <= ARRIVE_M) arrive();
  }

  function arrive() {
    if (state.arrived) return;
    state.arrived = true;
    const summary = buildSummary('arrived');
    showArrival(summary);
    stopTracking();
    saveTrip(summary);
  }

  function buildSummary(reason) {
    const elapsedS = Math.max(1, Math.round((Date.now() - state.startedAt) / 1000));
    const travelled = state.travelled_m || state.total_m;
    // Average speed is derived from the fixes themselves, not from how long the
    // page has been open: a trip driven quickly through a simulated feed still
    // has a real, meaningful pace, while a trip with no time between fixes does
    // not, and reports nothing rather than a nonsense number.
    const avg = averageSpeedKmh(travelled);
    return {
      role: state.role,
      mode: state.mode,
      distance_m: Math.round(travelled),
      planned_distance_m: Math.round(state.total_m),
      actual_duration_s: elapsedS,
      planned_duration_s: Math.round(state.route.duration_s || 0),
      avg_speed_kmh: avg,
      safety_score: state.route.safety ? state.route.safety.safety_score : null,
      mean_risk: state.route.safety ? state.route.safety.mean_risk : null,
      end_reason: reason,
      started_at: new Date(state.startedAt).toISOString(),
      from_lat: state.from.lat, from_lng: state.from.lng,
      to_lat: state.to.lat, to_lng: state.to.lng,
      from_label: state.fromLabel, to_label: state.toLabel,
    };
  }

  /**
   * Distance travelled divided by the time the fixes actually span. Returns null
   * when the fixes cover too little time to mean anything, or when the implied
   * pace is beyond any real walking, cycling or driving speed.
   */
  function averageSpeedKmh(distanceM) {
    const first = state.firstFixAt;
    const last = state.lastGpsAt;
    if (!first || !last || last <= first) return null;
    const hours = (last - first) / 3600000;
    if (hours <= 0) return null;
    const kmh = (distanceM / 1000) / hours;
    if (!isFinite(kmh) || kmh <= 0 || kmh > 120) return null;
    return +kmh.toFixed(1);
  }

  function showArrival(s) {
    const dl = $('navSummary');
    if (!dl) return;
    const row = (k, v) => `<dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd>`;
    dl.innerHTML =
      row('Route used', state.role) +
      row('Distance', fmtDist(s.distance_m)) +
      row('Time', fmtTime(s.actual_duration_s)) +
      (s.avg_speed_kmh != null ? row('Average speed', s.avg_speed_kmh + ' km/h') : '') +
      (s.safety_score != null ? row('Safety score', s.safety_score + '/100') : '');
    const sheet = $('navArriveSheet');
    if (sheet) sheet.hidden = false;
  }

  /* ----------------------------- rerouting ------------------------------ */

  function handleOffRoute(offset) {
    if (state.arrived) return;
    if (!state.offRouteSince) state.offRouteSince = Date.now();
    const held = Date.now() - state.offRouteSince;
    if (held < OFF_ROUTE_HOLD_MS) return;

    const box = $('navReroute');
    const text = $('navRerouteText');
    if (box && !state.reroutePending && Date.now() - state.rerouteAt > REROUTE_COOLDOWN_MS) {
      box.hidden = false;
      if (text) text.textContent = `You are about ${Math.round(offset)} m off the route. Checking for a safer way…`;
      doReroute();
    } else if (box) {
      box.hidden = false;
    }
  }

  function hideReroutePrompt() {
    const box = $('navReroute');
    if (box && !state.reroutePending) box.hidden = true;
  }

  async function doReroute() {
    if (state.reroutePending) return;
    state.reroutePending = true;
    state.rerouteAt = Date.now();
    const text = $('navRerouteText');
    try {
      const here = state.lastAccepted || state.displayed;
      const nav = await api('/api/navigation/reroute', {
        method: 'POST',
        body: JSON.stringify({
          from: { lat: here.lat, lng: here.lng },
          to: state.to,
          mode: state.mode,
          departure: 'now',
        }),
      });
      state.pendingRoute = nav;
      const safer = nav.is_safer_than_fastest && nav.extra_time_s > 0;
      if (text) {
        text.textContent = safer
          ? `Safer route found: ${fmtDist(nav.distance_m)}, safety ${nav.safety.safety_score}/100, about ${fmtTime(nav.extra_time_s)} longer.`
          : `Route recalculated: ${fmtDist(nav.distance_m)}, safety ${nav.safety.safety_score}/100.`;
      }
      const btn = $('navRerouteBtn');
      if (btn) btn.textContent = 'Use this route';
      speak(safer ? 'A safer route has been found.' : 'Route recalculated.');
    } catch (e) {
      if (text) text.textContent = 'Could not recalculate the route: ' + e.message;
      state.pendingRoute = null;
    } finally {
      state.reroutePending = false;
    }
  }

  /** Adopt the recalculated route without restarting the trip. */
  function acceptReroute() {
    const nav = state.pendingRoute;
    if (!nav || !nav.coords) { hideReroutePrompt(); return; }
    state.coords = nav.coords.map(([lat, lng]) => [lat, lng]);
    state.cum = M.cumulativeDistances(state.coords);
    state.total_m = state.cum[state.cum.length - 1] || 0;
    state.route.steps = nav.steps || [];
    state.route.hazards = nav.hazards || [];
    state.route.safety = nav.safety || state.route.safety;
    state.route.distance_m = nav.distance_m;
    state.route.duration_s = nav.duration_s;
    state.role = nav.role || state.role;
    state.along_m = 0;
    state.travelled_m = 0;
    state.lastSnapIndex = 0;
    state.stepIndex = -1;
    state.spokenStepIndex = -1;
    state.firstFixAt = null;
    state.pendingRoute = null;
    state.offRouteSince = 0;
    state.follow = true;
    hideReroutePrompt();
    drawHazards();
    drawRoute();
    renderInstruction(true);
    updateStats();
    speak('Following the new route.');
    announce('Now following the recalculated route.');
  }

  /* ------------------------------ hazards ------------------------------- */

  function updateHazards() {
    const box = $('navAlert');
    const text = $('navAlertText');
    if (!box || !text) return;
    const h = M.nextHazard(state.route.hazards || [], state.along_m, {
      lookaheadM: 400,
      minAheadM: 20,
      skipBefore: state.dismissedHazardBefore,
    });
    if (!h) { box.hidden = true; state.currentHazard = null; return; }
    state.currentHazard = h;
    box.hidden = false;
    box.dataset.kind = h.kind;
    const lead = h.kind === 'hotspot'
      ? `Reported-incident area in ${M.formatDistance(h.ahead_m)}`
      : `Poorly lit stretch in ${M.formatDistance(h.ahead_m)}`;
    // The label is a place name for a hotspot, but a generic description for an
    // unlit stretch, so only name it when it adds something.
    const named = h.label && h.label.toLowerCase() !== lead.toLowerCase().replace(/ in .*$/, '').trim();
    text.textContent = `${lead}${named ? ` (${h.label})` : ''}. ${h.advice}`;
    if (state.lastSpokenHazard !== h.along_m) {
      state.lastSpokenHazard = h.along_m;
      speak(`${lead}${named ? ` near ${h.label}` : ''}. ${h.advice}`);
    }
  }

  /* --------------------------- instruction UI --------------------------- */

  const ICON_GLYPH = {
    'turn-left': '↰', 'turn-right': '↱', 'slight-left': '↖', 'slight-right': '↗',
    'sharp-left': '⤴', 'sharp-right': '⤵', 'uturn': '↺', 'roundabout': '⟳',
    'merge': '⇗', 'fork-left': '↖', 'fork-right': '↗', 'ramp-left': '↖', 'ramp-right': '↗',
    'continue': '↑', 'straight': '↑', 'depart': '➤', 'arrive': '◉',
  };

  function renderInstruction(force) {
    const prog = M.stepProgress(state.route.steps, state.along_m);
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };

    if (!prog) {
      // No steps from the routing service: be honest rather than invent turns.
      const remaining = Math.max(0, state.total_m - state.along_m);
      set('navIcon', '↑');
      set('navInstruction', 'Follow the highlighted route');
      set('navStreet', '');
      set('navStepDist', fmtDist(remaining));
      return;
    }

    const next = prog.next || prog.current;
    const dist = prog.next ? prog.distanceToNext_m : Math.max(0, state.total_m - state.along_m);
    set('navIcon', ICON_GLYPH[next.icon] || '↑');
    set('navInstruction', next.text || 'Continue');
    set('navStreet', next.street || '');
    set('navStepDist', M.formatDistance(dist));

    // Voice + screen reader on a new instruction, and once on approach.
    if (prog.index !== state.spokenStepIndex) {
      state.spokenStepIndex = prog.index;
      state.spokenNearStep = -1;
      speak(M.spokenInstruction(next, dist));
    } else if (dist < SPEAK_AT_M && state.spokenNearStep !== prog.index && prog.next) {
      state.spokenNearStep = prog.index;
      speak(M.spokenInstruction(next, dist));
    }
    if (force) state.spokenNearStep = -1;
  }

  /* ------------------------------- stats -------------------------------- */

  function updateStats() {
    const now = Date.now();
    // Battery care: the marker follows every fix, but the text panel updates a
    // few times a second at most.
    if (!forceUi(now)) return;
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };

    set('navSpeed', String(Math.round(state.speedMps * 3.6)));

    const remaining = Math.max(0, state.total_m - state.along_m);
    set('navRemainingDist', fmtDist(remaining));

    // Remaining time: trust the route's own pace, adjusted by how fast the user
    // is actually moving once we have enough samples to say.
    const avg = state.speedSamples.length >= 3
      ? state.speedSamples.reduce((a, b) => a + b, 0) / state.speedSamples.length
      : 0;
    const pace = avg > 0.5 ? avg : (state.route.distance_m / Math.max(1, state.route.duration_s || 1));
    const remainingS = pace > 0 ? remaining / pace : 0;
    set('navRemainingTime', fmtTime(remainingS));
    set('navEta', fmtClock(new Date(Date.now() + remainingS * 1000)));

    updateSafetyAhead();
  }

  function forceUi(now) {
    if (now - state.lastUiAt < UI_THROTTLE_MS) return false;
    state.lastUiAt = now;
    return true;
  }

  /** The live safety read of the road ahead. */
  function updateSafetyAhead() {
    const safety = state.route.safety || {};
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    const box = $('navSafety');
    if (!safety.covered) {
      set('navSafetyVal', 'no data');
      set('navSafetyNote', 'Outside the area the model has data for.');
      if (box) box.dataset.band = 'none';
      return;
    }
    // Score the stretch just ahead, so the number reflects where the user is
    // about to walk rather than the average of the whole route.
    const ahead = riskAheadFromSamples(500);
    if (!ahead) return;
    const safetyScore = Math.max(0, Math.round(100 - ahead));
    set('navSafetyVal', safetyScore + '/100');
    set('navSafetyNote', ahead >= 60 ? 'High reported risk ahead' : ahead >= 35 ? 'Some reported risk ahead' : 'Low reported risk ahead');
    if (box) box.dataset.band = ahead >= 60 ? 'high' : ahead >= 35 ? 'medium' : 'low';
  }

  /**
   * Mean risk of the next `windowM` metres, from the hazards we already have.
   * Uses the hotspot intensity near the path so the number moves with the data
   * rather than being a second, divergent model.
   */
  function riskAheadFromSamples(windowM) {
    const to = state.along_m + windowM;
    const near = (state.route.hazards || []).filter(
      (h) => h.along_m >= state.along_m - 30 && h.along_m <= to
    );
    if (!near.length) {
      // Nothing on the way: fall back to the route average, which is real data.
      return state.route.safety ? state.route.safety.mean_risk : null;
    }
    const worst = near.reduce((a, h) => Math.max(a, h.risk || 0), 0);
    const mean = near.reduce((a, h) => a + (h.risk || 0), 0) / near.length;
    return 0.6 * worst + 0.4 * mean;
  }

  function updateCompass() {
    const el = $('navCompassText');
    const needle = $('navCompassNeedle');
    const wrap = $('navCompass');
    const bearing = state.deviceHeading != null ? state.deviceHeading : state.heading;
    const card = M.cardinal(bearing);
    if (el) el.textContent = `${card} ${Math.round(bearing)}°`;
    if (needle) needle.setAttribute('transform', `rotate(${bearing.toFixed(0)} 32 32)`);
    if (wrap) wrap.setAttribute('aria-label', `Compass: heading ${card} ${Math.round(bearing)} degrees, from ${state.compassSource === 'gps' ? 'GPS' : state.compassSource === 'route' ? 'the route direction' : 'the device sensor'}`);
  }

  /* ------------------------------- check-in ----------------------------- */

  function checkStillness() {
    if (state.checkinShown || state.arrived) return;
    if (state.speedMps > 0.6) { state.stillSince = Date.now(); return; }
    const still = Date.now() - state.stillSince;
    if (still < CHECKIN_STILL_MS) return;

    const mean = state.route.safety ? state.route.safety.mean_risk : 0;
    const ahead = riskAheadFromSamples(300) || 0;
    if (Math.max(mean, ahead) < CHECKIN_MIN_RISK) {
      state.stillSince = Date.now(); // reset the clock; no risky spot, no prompt
      return;
    }
    state.checkinShown = true;
    const box = $('navCheckin');
    if (box) box.hidden = false;
    speak('You have been still for a while. Are you okay?');
    announce('Check-in: you have been still for two minutes in a higher-risk area. Are you okay?');
  }

  async function sendCheckinAlert() {
    const box = $('navCheckin');
    if (box) box.hidden = true;
    const here = state.lastAccepted || state.displayed || state.from;
    await sendAlert(here.lat, here.lng, 'SafePath check-in: no reply after a still period in a higher-risk area.');
  }

  /* ------------------------------- alerts ------------------------------- */

  /** Reuse the planner's alert sender so the honesty wording lives in one place. */
  async function sendAlert(lat, lng, message) {
    if (window.SafePathApp && window.SafePathApp.sendAlert) {
      return window.SafePathApp.sendAlert(lat, lng, message);
    }
    return api('/api/alerts', { method: 'POST', body: JSON.stringify({ lat, lng, message }) });
  }

  function initPanic() {
    const btn = $('navPanicBtn');
    const ring = $('navPanicRing');
    const label = $('navPanicLabel');
    if (!btn) return;
    const HOLD_MS = 2000;
    const CIRC = 2 * Math.PI * 48;
    let timer = null, start = 0, raf = null;

    // Haptics: a tick as the hold begins, a stronger pattern when it fires.
    // Not every browser or device supports it, so it is best-effort only.
    const buzz = (pattern) => {
      try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* unsupported */ }
    };

    const reset = () => {
      clearTimeout(timer); timer = null;
      cancelAnimationFrame(raf);
      btn.classList.remove('holding');
      if (ring) ring.setAttribute('stroke-dashoffset', String(CIRC));
      if (label) label.textContent = 'Hold to alert';
    };
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / HOLD_MS);
      if (ring) ring.setAttribute('stroke-dashoffset', String(CIRC * (1 - t)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    const begin = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      if (timer) return;
      start = Date.now();
      btn.classList.add('holding');
      if (label) label.textContent = 'keep holding…';
      buzz(20);
      tick();
      timer = setTimeout(fire, HOLD_MS);
    };
    const fire = async () => {
      reset();
      buzz([40, 60, 40]);
      const here = state.lastAccepted || state.displayed || state.from;
      const out = $('navPanicResult');
      if (out) out.textContent = 'Sending your alert…';
      try {
        const res = await sendAlert(here.lat, here.lng, 'SafePath panic alert during navigation');
        if (out) {
          out.textContent = res.live
            ? 'Alert sent to your trusted circle.'
            : 'DEMO ALERT — recorded in this app, not sent to anyone. ' + (res.delivery || '');
        }
      } catch (err) {
        if (out) out.textContent = 'Could not send the alert: ' + err.message;
      }
    };

    btn.addEventListener('pointerdown', begin);
    btn.addEventListener('pointerup', reset);
    btn.addEventListener('pointerleave', reset);
    btn.addEventListener('pointercancel', reset);
    btn.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !timer) begin(e); });
    btn.addEventListener('keyup', reset);
  }

  /* ------------------------------ sharing ------------------------------- */

  async function shareTrip() {
    const btn = $('navShareBtn');
    const here = state.lastAccepted || state.displayed || state.from;
    if (btn) { btn.disabled = true; btn.textContent = 'Sharing…'; }
    try {
      const out = await api('/api/trips/share', {
        method: 'POST',
        body: JSON.stringify({ lat: here.lat, lng: here.lng, to_label: state.toLabel }),
      });
      state.shareToken = out.token;
      const abs = out.url.startsWith('http') ? out.url : location.origin + out.url;
      // Keep the shared position fresh while the trip runs.
      if (state.shareTimer) clearInterval(state.shareTimer);
      state.shareTimer = setInterval(() => pushShare(), 30000);
      if (btn) { btn.disabled = false; btn.textContent = 'Sharing live'; }
      announce(out.live
        ? 'Live trip shared with your trusted circle.'
        : 'DEMO share link created but not sent to anyone: no trusted-circle channel is configured.');
      if (window.SafePathApp && window.SafePathApp.toast) {
        window.SafePathApp.toast('navGps', out.live ? 'Live trip shared.' : 'Demo share link created (not sent).', out.live ? 'ok' : 'warn');
      }
      try { await navigator.clipboard.writeText(abs); } catch { /* clipboard is optional */ }
      return out;
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Share my live trip'; }
      announce('Could not create a share link: ' + e.message);
      return null;
    }
  }

  function pushShare() {
    if (!state.shareToken) return;
    const here = state.lastAccepted || state.displayed;
    if (!here) return;
    api(`/api/trips/share/${state.shareToken}/update`, {
      method: 'POST',
      body: JSON.stringify({ lat: here.lat, lng: here.lng }),
    }).catch(() => { /* a dropped share update is not worth interrupting the trip */ });
  }

  /* ---------------------------- wake lock ------------------------------- */

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) {
      if (!state.wakeLockWarned) {
        state.wakeLockWarned = true;
        announce('This browser cannot keep the screen awake; keep the screen on manually.');
      }
      return;
    }
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    } catch (e) {
      announce('Could not keep the screen awake: ' + e.message);
    }
  }

  function releaseWakeLock() {
    if (state.wakeLock) { try { state.wakeLock.release(); } catch { /* already gone */ } }
    state.wakeLock = null;
  }

  /* --------------------------- device compass --------------------------- */

  function onOrientation(e) {
    // webkitCompassHeading is iOS; alpha is the standard, where 0 is north but
    // measured counter-clockwise, so it needs inverting.
    let heading = null;
    if (e.webkitCompassHeading != null && isFinite(e.webkitCompassHeading)) {
      heading = e.webkitCompassHeading;
    } else if (e.alpha != null && isFinite(e.alpha)) {
      heading = 360 - e.alpha;
    }
    if (heading == null) return;
    state.deviceHeading = heading;
    state.compassSource = 'device';
    updateCompass();
  }

  function initCompassSensor() {
    if (!('DeviceOrientationEvent' in window)) return;
    const start = () => window.addEventListener('deviceorientation', onOrientation, true);
    // iOS 13+ requires an explicit, user-initiated permission request.
    if (typeof window.DeviceOrientationEvent.requestPermission === 'function') {
      window.DeviceOrientationEvent.requestPermission()
        .then((res) => { if (res === 'granted') start(); })
        .catch(() => { /* the GPS heading is a fine fallback */ });
    } else {
      start();
    }
  }

  /* ---------------------------- simulation ------------------------------ */

  /**
   * Debug mode: walk the arrow along the route at a steady pace, generating the
   * same fix objects a real GPS would, so the whole flow can be tested indoors.
   */
  function startSimulation() {
    stopSimulation();
    state.simulating = true;
    state.simAlong = 0;
    state.simStartedAt = Date.now();
    const btn = $('navSimBtn');
    if (btn) { btn.setAttribute('aria-pressed', 'true'); btn.textContent = 'Stop simulating'; }
    announce('Simulated trip running. The arrow will move along the route.');
    // A first fix right away, so the screen is never empty.
    emitSimFix();
    state.simTimer = setInterval(() => {
      state.simAlong += SIM_SPEED_MPS * 1;
      if (state.simAlong >= state.total_m) { emitSimFix(); return; }
      emitSimFix();
    }, 1000);
  }

  function stopSimulation() {
    if (state.simTimer) clearInterval(state.simTimer);
    state.simTimer = null;
    state.simulating = false;
    const btn = $('navSimBtn');
    if (btn) { btn.setAttribute('aria-pressed', 'false'); btn.textContent = 'Simulate'; }
  }

  function emitSimFix() {
    const along = Math.min(state.simAlong, state.total_m);
    const point = pointAt(state.coords, state.cum, along);
    const next = pointAt(state.coords, state.cum, Math.min(state.total_m, along + 12));
    const heading = M.bearingDeg(point[0], point[1], next[0], next[1]);
    onFix({
      coords: { latitude: point[0], longitude: point[1], accuracy: 8, heading, speed: SIM_SPEED_MPS },
      timestamp: Date.now(),
    });
  }

  /** Position at a given distance along a polyline. */
  function pointAt(coords, cum, alongM) {
    const total = cum[cum.length - 1] || 0;
    const d = M.clamp(alongM, 0, total);
    let i = 0;
    while (i < cum.length - 1 && cum[i + 1] < d) i++;
    const span = cum[i + 1] - cum[i] || 1;
    const t = M.clamp((d - cum[i]) / span, 0, 1);
    return [
      coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
      coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t,
    ];
  }

  /** Stop following, and offer Recenter. Used when the user drags the map. */
  function releaseFollow() {
    if (!state.follow) return;
    state.follow = false;
    if (state.orientation === 'heading') setOrientation('north');
    queueSyncControlOverflow();
  }

  /** Resume following the user's position, and hide Recenter again. */
  function recenterOnUser() {
    state.follow = true;
    if (state.orientation === 'north') setOrientation('heading');
    followIfNeeded();
    announce('Following your position again.');
    queueSyncControlOverflow();
  }

  /** Toggle voice guidance. Shared by the on-map button and the "more" sheet. */
  function toggleVoice() {
    const btn = $('navVoiceBtn');
    if (btn) btn.click();
  }

  function openMoreSheet() {
    syncControlOverflow();
    const sheet = $('navMoreSheet');
    if (!sheet) return;
    sheet.hidden = false;
    const more = $('navMoreBtn');
    if (more) more.setAttribute('aria-expanded', 'true');
    const first = $('navMoreNorth');
    if (first) first.focus();
  }

  function closeMoreSheet() {
    const sheet = $('navMoreSheet');
    if (sheet) sheet.hidden = true;
    const more = $('navMoreBtn');
    if (more) { more.setAttribute('aria-expanded', 'false'); more.focus(); }
  }

  /* --------------------------- end of trip ------------------------------ */

  function askEnd() {
    const sheet = $('navEndSheet');
    if (sheet) sheet.hidden = false;
    const btn = $('navEndConfirm');
    if (btn) btn.focus();
  }

  function cancelEnd() {
    const sheet = $('navEndSheet');
    if (sheet) sheet.hidden = true;
  }

  /** Stop everything and hand control back to the planner. */
  function endTrip(reason = 'ended_by_user') {
    if (!state.active) return;
    const summary = buildSummary(reason);
    stopTracking();
    unwatchPanelHeight();
    hideAllSheets();
    // Mark the session closed before anything else can read it: a late fix must
    // not be applied to a trip that has already ended.
    state.active = false;
    state.arrived = false;
    const app = document.querySelector('.app');
    if (app) app.removeAttribute('aria-hidden');
    document.body.classList.remove('nav-active');
    $('navScreen').hidden = true;
    saveTrip(summary);
    if (window.SafePathApp && window.SafePathApp.onNavEnd) window.SafePathApp.onNavEnd(summary);
    return summary;
  }

  function stopTracking() {
    unwatch();
    stopSimulation();
    releaseWakeLock();
    if (state.shareTimer) clearInterval(state.shareTimer);
    state.shareTimer = null;
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch { /* fine */ }
    window.removeEventListener('deviceorientation', onOrientation, true);
  }

  function hideAllSheets() {
    ['navEndSheet', 'navArriveSheet', 'navPermSheet', 'navMoreSheet'].forEach((id) => {
      const el = $(id); if (el) el.hidden = true;
    });
    const reroute = $('navReroute'); if (reroute) reroute.hidden = true;
    const checkin = $('navCheckin'); if (checkin) checkin.hidden = true;
    const alert = $('navAlert'); if (alert) alert.hidden = true;
  }

  function saveTrip(summary) {
    const body = {
      role: summary.role, mode: summary.mode,
      from_lat: summary.from_lat, from_lng: summary.from_lng,
      to_lat: summary.to_lat, to_lng: summary.to_lng,
      from_label: summary.from_label, to_label: summary.to_label,
      distance_m: summary.distance_m, planned_duration_s: summary.planned_duration_s,
      actual_duration_s: summary.actual_duration_s, avg_speed_kmh: summary.avg_speed_kmh,
      safety_score: summary.safety_score, mean_risk: summary.mean_risk,
      started_at: summary.started_at, end_reason: summary.end_reason,
      share_token: state.shareToken,
    };
    api('/api/trips', { method: 'POST', body: JSON.stringify(body) })
      .catch((e) => console.warn('[SafePath] could not save the trip summary:', e.message));
  }

  /* ------------------------------ wiring -------------------------------- */

  function init() {
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };

    on('navEndBtn', 'click', askEnd);
    on('navEndCancel', 'click', cancelEnd);
    on('navEndConfirm', 'click', () => {
      cancelEnd();
      endTrip('ended_by_user');
      announce('Trip ended. Back to the planner.');
    });
    on('navArriveDone', 'click', () => endTrip('arrived'));

    on('navNorthBtn', 'click', () => {
      setOrientation(state.orientation === 'heading' ? 'north' : 'heading');
      if (state.orientation === 'heading') { state.follow = true; followIfNeeded(); }
      queueSyncControlOverflow();
    });
    on('navRecenterBtn', 'click', () => {
      recenterOnUser();
    });

    on('navRerouteBtn', 'click', acceptReroute);
    on('navRerouteIgnore', 'click', () => {
      const box = $('navReroute');
      if (box) box.hidden = true;
      state.offRouteSince = Date.now();
    });

    on('navCheckinOk', 'click', () => {
      const box = $('navCheckin');
      if (box) box.hidden = true;
      state.checkinShown = false;
      state.stillSince = Date.now();
      announce('Thanks — check-in cleared.');
    });
    on('navCheckinHelp', 'click', sendCheckinAlert);

    on('navAlertDismiss', 'click', () => {
      const h = state.currentHazard;
      if (h) state.dismissedHazardBefore = h.along_m;
      const box = $('navAlert');
      if (box) box.hidden = true;
    });

    on('navVoiceBtn', 'click', () => {
      state.voiceOn = !state.voiceOn;
      const btn = $('navVoiceBtn');
      const icon = $('navVoiceIcon');
      if (btn) {
        btn.setAttribute('aria-pressed', String(state.voiceOn));
        const name = state.voiceOn ? 'Voice guidance on' : 'Voice guidance off';
        btn.setAttribute('aria-label', name);
        btn.title = name;
      }
      if (icon) icon.textContent = state.voiceOn ? '🔊' : '🔇';
      if (!state.voiceOn) { try { window.speechSynthesis.cancel(); } catch { /* fine */ } }
      queueSyncControlOverflow();
    });

    on('navMoreBtn', 'click', openMoreSheet);
    on('navMoreClose', 'click', closeMoreSheet);
    on('navMoreNorth', 'click', () => {
      setOrientation(state.orientation === 'heading' ? 'north' : 'heading');
      syncControlOverflow();
    });
    on('navMoreRecenter', 'click', () => { recenterOnUser(); closeMoreSheet(); });
    on('navMoreVoice', 'click', () => { toggleVoice(); syncControlOverflow(); });

    on('navShareBtn', 'click', shareTrip);
    on('navSimBtn', 'click', () => {
      if (state.simulating) {
        stopSimulation();
        announce('Simulation stopped. Waiting for GPS.');
      } else {
        unwatch();
        startSimulation();
      }
    });

    on('navPermRetry', 'click', () => {
      const sheet = $('navPermSheet');
      if (sheet) sheet.hidden = true;
      requestLocation();
    });
    on('navPermSim', 'click', () => {
      const sheet = $('navPermSheet');
      if (sheet) sheet.hidden = true;
      startSimulation();
    });
    on('navPermCancel', 'click', () => {
      const sheet = $('navPermSheet');
      if (sheet) sheet.hidden = true;
      endTrip('aborted');
    });

    initPanic();

    // Re-acquire the wake lock when the tab comes back, and re-measure the map.
    document.addEventListener('visibilitychange', () => {
      if (!state.active) return;
      if (document.visibilityState === 'visible') {
        acquireWakeLock();
        if (state.map) state.map.invalidateSize();
      }
    });
    window.addEventListener('resize', () => {
      if (state.active && state.map) state.map.invalidateSize();
    });

    window.addEventListener('beforeunload', () => { if (state.active) stopTracking(); });
  }

  document.addEventListener('DOMContentLoaded', init);

  /* ------------------------------ exports ------------------------------- */

  window.SafePathNav = {
    start,
    endTrip,
    askEnd,
    isActive: () => state.active,
    // Used by the browser tests to drive a trip without a real GPS.
    _state: state,
    _injectFix: applyFix,
    _acceptReroute: acceptReroute,
    _pointAt: pointAt,
    _splitAt: splitAt,
    _startSimulation: startSimulation,
    _stopSimulation: stopSimulation,
    _buildSummary: buildSummary,
    _setFirstFixAt: (ms) => { state.firstFixAt = ms; },
    _setOrientation: setOrientation,
    _riskAhead: riskAheadFromSamples,
    _syncControls: syncControlOverflow,
    _recenter: recenterOnUser,
  };
})();
