/* ==========================================================================
   SafePath frontend
   Vanilla JS + Leaflet. All data comes from the SafePath API; nothing on the
   Signals page is hard-coded. Safety scores are estimates from reported data,
   not guarantees.
   ========================================================================== */
'use strict';

const API = (window.SAFEPATH_API || '').replace(/\/$/, '');
// Default map centre: Mysuru (Mysore) city centre, near the palace.
const CENTER = [12.3052, 76.6554];
const DEFAULT_ZOOM = 13;
const DISCLAIMER = 'Estimate based on reported data, not a guarantee of safety.';

const state = {
  mode: 'walk',
  lambda: 1.5,
  departure: 'now',
  plan: null,
  selected: null,
  hotspots: [],
  coverage: null,
  heatOn: false,
  hotspotsOn: true,
  lampsOn: false,
  helpOn: false,
  pickForReport: false,
  reportLoc: null,
  maps: {},
  userLoc: null,        // last known position, used to bias place suggestions
  acFrom: null,         // autocomplete widgets
  acTo: null,
  acMap: null,
};

/* ----------------------------- tiny helpers ----------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m');
const fmtTime = (s) => {
  const min = Math.round(s / 60);
  if (min < 60) return min + ' min';
  return Math.floor(min / 60) + ' h ' + (min % 60) + ' min';
};
const scoreClass = (s) => (s >= 75 ? 'score-safe' : s >= 55 ? 'score-mid' : 'score-bad');
const riskColour = (r) => (r >= 60 ? '#f0616b' : r >= 35 ? '#f0b429' : '#35c98a');
const riskBand = (r) => (r >= 60 ? 'high' : r >= 35 ? 'medium' : 'low');
// The route exposure number is a composite that rarely reaches the point-risk
// scale, so band the card from the safety score (100 = safest) instead.
const safetyBand = (s) => (s >= 80 ? 'low' : s >= 60 ? 'medium' : 'high');
const timeAgo = (iso) => {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(d)) return '';
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + ' min ago';
  if (d < 86400) return Math.floor(d / 3600) + ' h ago';
  return Math.floor(d / 86400) + ' d ago';
};

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
  if (!res.ok) {
    const err = new Error(json.error || ('Request failed (' + res.status + ')'));
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/* ------------------------------- tabs ---------------------------------- */
function initTabs() {
  const tabs = $$('.tab');
  tabs.forEach((tab) => {
    // navigateTab() records a history entry so Back returns to the previous tab.
    tab.addEventListener('click', () => navigateTab(tab.id.replace('tab-', '')));
    tab.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(tab);
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      if (j != null) { e.preventDefault(); tabs[j].focus(); navigateTab(tabs[j].id.replace('tab-', '')); }
    });
  });

  // Hero buttons: the two entry points into the planner.
  const plan = $('#heroPlanBtn');
  const explore = $('#heroExploreBtn');
  if (plan) plan.addEventListener('click', () => goToSection('planner'));
  if (explore) explore.addEventListener('click', () => goToSection('explore'));

  // Footer and any other in-page anchors that point at a section or a tab.
  $$('a[data-tab-target], a[href^="#page-"]').forEach((a) => {
    const name = (a.dataset.tabTarget || '').replace('tab-', '') || /^#page-([a-z]+)$/.exec(a.getAttribute('href') || '')?.[1];
    if (!name || !TAB_NAMES.includes(name)) return;
    a.addEventListener('click', (e) => { e.preventDefault(); navigateTab(name); });
  });

  // Browser Back/Forward, and a deep link opened directly.
  window.addEventListener('popstate', () => {
    if (!applyHash(location.hash)) selectTab('overview');
  });
  window.addEventListener('hashchange', () => {
    // Only react when the hash actually names a section/tab; otherwise the
    // pushState above already handled it.
    applyHash(location.hash);
  });
  applyHash(location.hash);
}

function selectTab(name) {
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.id === 'tab-' + name)));
  $$('.page').forEach((p) => { p.hidden = p.id !== 'page-' + name; });
  // A Leaflet map created while its panel was hidden has measured a 0px box, so
  // every tab switch must re-measure the map it reveals.
  setTimeout(() => {
    const map = { overview: 'map', route: 'map2', report: 'map3', live: 'map4' }[name];
    if (map && state.maps[map]) state.maps[map].invalidateSize();
    if (name === 'route') renderRoutes();
    if (name === 'signals') loadSignals();
    if (name === 'live') loadLive();
  }, 60);
}

/* --------------------------- section navigation ------------------------- */
/* The hero buttons and the footer links are anchors into the planner, so they
   all funnel through one place. A "section" is a tab plus an element inside it:
   the tab switch uses the existing selectTab(), then the element is scrolled
   into view. The URL hash is kept in step so the browser Back button works. */
const TAB_NAMES = ['overview', 'route', 'report', 'live', 'signals'];
const SECTIONS = {
  // "Find a Safe Route" -> the From/To planner card beside the map.
  planner: { tab: 'overview', target: () => { const f = $('#fromInput'); return f && f.closest('.card'); }, focus: '#fromInput' },
  // "Explore SafePath" -> the map itself, where the layers and hotspots live.
  explore: { tab: 'overview', target: () => $('#map') },
};
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function revealInSection(section) {
  const spec = SECTIONS[section];
  if (!spec) return;
  const el = spec.target && spec.target();
  if (el) {
    // selectTab() re-measures maps on a 60ms timer; scroll after that so the
    // offset is measured against the revealed layout, not the hidden one.
    setTimeout(() => {
      el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: spec.block || 'center' });
      if (spec.focus) {
        const f = $(spec.focus);
        // Focus without yanking the scroll position the smooth scroll just set.
        if (f) setTimeout(() => f.focus({ preventScroll: true }), reduceMotion() ? 0 : 320);
      }
    }, 80);
  }
}

/** Switch tab (if needed) and reveal a section, pushing a history entry. */
function goToSection(section, { push = true } = {}) {
  const spec = SECTIONS[section];
  if (!spec) return;
  selectTab(spec.tab);
  revealInSection(section);
  if (push && location.hash !== '#' + section) {
    appliedHash = section;
    history.pushState({ section }, '', '#' + section);
  }
}

/** Switch tab from a link/tab click, pushing a history entry. */
function navigateTab(name, { push = true } = {}) {
  if (!TAB_NAMES.includes(name)) return;
  selectTab(name);
  if (push && location.hash !== '#page-' + name) {
    appliedHash = 'page-' + name;
    history.pushState({ tab: name }, '', '#page-' + name);
  }
}

/** Apply a hash on load or on Back/Forward. Returns true if it matched. */
function applyHash(hash) {
  const h = String(hash == null ? location.hash : hash).replace(/^#/, '');
  if (!h) return false;
  // Back/Forward fire both popstate and hashchange for the same entry; apply once.
  if (h === appliedHash) return true;
  appliedHash = h;
  if (SECTIONS[h]) { selectTab(SECTIONS[h].tab); revealInSection(h); return true; }
  const m = /^page-([a-z]+)$/.exec(h);
  if (m && TAB_NAMES.includes(m[1])) { selectTab(m[1]); return true; }
  return false;
}
let appliedHash = '';

/* -------------------------------- maps --------------------------------- */
// One colour per route role, matching the map legend in index.html.
const ROLE_COLOUR = { safest: '#35c98a', balanced: '#f0b429', fastest: '#5aa9e6', alternative: '#9fb0c2' };
const HELP_STYLE = {
  police:   { colour: '#5aa9e6', label: 'Police station' },
  hospital: { colour: '#f0616b', label: 'Hospital' },
  shop:     { colour: '#f0b429', label: 'Shop / business' },
  fuel:     { colour: '#9fb0c2', label: 'Fuel station' },
  bus_stop: { colour: '#f5f5f7', label: 'Bus stop' },
};

function baseTiles() {
  return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
}

function fallbackIdFor(id) { return 'mapFallback' + id.replace('map', ''); }

function showMapFallback(id) {
  const el = document.getElementById(fallbackIdFor(id));
  if (el) el.hidden = false;
}
function hideMapFallback(id) {
  const el = document.getElementById(fallbackIdFor(id));
  if (el) el.hidden = true;
}
function leafletReady() { return typeof L !== 'undefined' && L && typeof L.map === 'function'; }

/**
 * Create a Leaflet map, or show the "Map could not load" panel if the library
 * or the tiles are unavailable. Every map needs an explicit height in CSS or it
 * renders into a 0px box (that was the original blank-map bug).
 */
function initMap(id, opts = {}) {
  if (!leafletReady()) {
    console.error('[SafePath] Leaflet is not available — cannot render #' + id + '.');
    showMapFallback(id);
    return null;
  }
  let map;
  try {
    map = L.map(id, { center: CENTER, zoom: DEFAULT_ZOOM, zoomControl: true, ...opts });
  } catch (err) {
    console.error('[SafePath] Leaflet failed to initialise #' + id, err);
    showMapFallback(id);
    return null;
  }
  const tiles = baseTiles();
  let tileErrors = 0;
  tiles.on('tileerror', (e) => {
    tileErrors++;
    console.error('[SafePath] Tile failed to load for #' + id, e && e.tile && e.tile.src);
    if (tileErrors >= 6) showMapFallback(id);
  });
  tiles.on('load', () => { tileErrors = 0; hideMapFallback(id); });
  tiles.addTo(map);
  // Leaflet mis-measures a container that was hidden when the map was created.
  map.whenReady(() => setTimeout(() => map.invalidateSize(), 0));
  state.maps[id] = map;
  return map;
}

const layers = {}; // per-map layer groups

function ensureLayers(map, id) {
  if (!layers[id]) {
    layers[id] = {
      coverage: L.layerGroup().addTo(map),
      heat: L.layerGroup(),
      hotspots: L.layerGroup(),
      lamps: L.layerGroup(),
      help: L.layerGroup(),
      routes: L.layerGroup().addTo(map),
      reports: L.layerGroup().addTo(map),
      markers: L.layerGroup().addTo(map),
    };
    if (id === 'map' || id === 'map2') layers[id].hotspots.addTo(map);
  }
  return layers[id];
}

function hotspotPopup(h) {
  const last = h.last_reported ? new Date(h.last_reported).toLocaleDateString() : 'not recorded';
  const intensity = h.intensity != null ? h.intensity.toFixed(2) : '—';
  return `<b>${esc(h.name)}</b><br>` +
    `<span style="opacity:.75">${esc(h.reason || '')}</span><br>` +
    `Intensity: <b>${intensity}</b> (0–1)<br>` +
    `Reported incidents: <b>${h.count}</b>${h.recent_count != null ? ' · ' + h.recent_count + ' recent' : ''}<br>` +
    `Last reported: <b>${esc(last)}</b><br>` +
    `<span style="opacity:.6;font-size:11px">${DISCLAIMER}</span>`;
}

function hotspotCircle(h) {
  const intensity = h.intensity != null ? h.intensity : 0.3;
  return L.circle([h.lat, h.lng], {
    radius: h.radius_m || 250,
    color: '#f0616b',
    weight: 1 + intensity * 2,
    fillColor: '#f0616b',
    fillOpacity: 0.06 + 0.3 * intensity,
    className: 'hotspot-circle',
  }).bindPopup(hotspotPopup(h));
}

function drawHotspots(map, id, hotspots) {
  if (!map) return;
  const L2 = ensureLayers(map, id);
  L2.hotspots.clearLayers();
  if (!state.hotspotsOn) {
    if (map.hasLayer(L2.hotspots)) map.removeLayer(L2.hotspots);
    return;
  }
  (hotspots || []).forEach((h) => L2.hotspots.addLayer(hotspotCircle(h)));
  if (!map.hasLayer(L2.hotspots)) L2.hotspots.addTo(map);
}

/** Grid-of-cells heatmap, refreshed for the chosen departure time. */
async function toggleHeat(map, id, on, btn) {
  if (!map) return;
  const L2 = ensureLayers(map, id);
  state.heatOn = on;
  if (!on) { L2.heat.clearLayers(); if (map.hasLayer(L2.heat)) map.removeLayer(L2.heat); return; }
  const b = map.getBounds();
  const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((n) => n.toFixed(5)).join(',');
  try {
    const g = await api(`/api/risk-grid?bbox=${bbox}&cells=42&time=${encodeURIComponent(departureISO())}`);
    L2.heat.clearLayers();
    const step = g.step_deg;
    g.points.forEach(([lat, lng, risk]) => {
      L.rectangle([[lat, lng], [lat + step, lng + step]], {
        stroke: false, fillColor: riskColour(risk), fillOpacity: 0.28,
        interactive: false,
      }).addTo(L2.heat);
    });
    L2.heat.addTo(map);
    if (btn) btn.textContent = 'Hide heatmap';
  } catch (e) {
    if (btn) { btn.setAttribute('aria-pressed', 'false'); btn.textContent = 'Risk heatmap'; }
    toast(id === 'map2' ? 'routeStatus' : 'mapStatus', 'Heatmap unavailable: ' + e.message, 'err');
  }
}

/** Street lamps or help points, fetched for the current map view. */
async function toggleFeature(map, id, kind, on) {
  if (!map) return;
  const L2 = ensureLayers(map, id);
  const group = kind === 'street_lamp' ? L2.lamps : L2.help;
  if (!on) { group.clearLayers(); if (map.hasLayer(group)) map.removeLayer(group); return; }
  const b = map.getBounds();
  const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((n) => n.toFixed(5)).join(',');
  const kinds = kind === 'street_lamp' ? 'street_lamp' : 'police,hospital,shop,fuel,bus_stop';
  const status = id === 'map2' ? 'routeStatus' : 'mapStatus';
  try {
    const g = await api(`/api/features?bbox=${bbox}&kinds=${kinds}`);
    group.clearLayers();
    g.features.forEach((f) => {
      if (f.kind === 'street_lamp') {
        L.circleMarker([f.lat, f.lng], {
          radius: 2, color: '#f3cf7a', fillColor: '#f3cf7a', fillOpacity: 0.85, weight: 0,
        }).bindTooltip('Street lamp').addTo(group);
      } else {
        const style = HELP_STYLE[f.kind] || { colour: '#9fb0c2', label: f.kind };
        L.circleMarker([f.lat, f.lng], {
          radius: 5, color: style.colour, fillColor: style.colour, fillOpacity: 0.85, weight: 1,
        }).bindTooltip(style.label + (f.name ? ': ' + esc(f.name) : '')).addTo(group);
      }
    });
    group.addTo(map);
    if (!g.features.length) toast(status, 'No ' + (kind === 'street_lamp' ? 'street lamps' : 'help points') + ' mapped in this view.', 'warn');
  } catch (e) {
    toast(status, 'Layer unavailable: ' + e.message, 'err');
  }
}

/** Dashed rectangle showing the area the model has data for. */
function drawCoverage(map, id) {
  if (!map) return;
  const L2 = ensureLayers(map, id);
  L2.coverage.clearLayers();
  const bbox = state.coverage && state.coverage.bbox;
  if (!bbox || bbox.length !== 4) return;
  // bbox is a flat [minLat, minLng, maxLat, maxLng] array.
  const [minLat, minLng, maxLat, maxLng] = bbox;
  L.rectangle([[minLat, minLng], [maxLat, maxLng]], {
    color: '#5aa9e6', weight: 1.5, dashArray: '8 6', fill: false, opacity: 0.7, interactive: false,
  }).bindTooltip('Area covered by SafePath data', { sticky: true }).addTo(L2.coverage);
}

async function loadCoverage() {
  try {
    const c = await api('/api/coverage');
    state.coverage = c;
  } catch { state.coverage = null; }
  if (state.maps.map2) drawCoverage(state.maps.map2, 'map2');
}

/* --------------------------- route planning ---------------------------- */
function departureISO() {
  if (state.departure === 'now') return 'now';
  const v = $('#customTimeInput').value;
  return v ? new Date(v).toISOString() : 'now';
}

/**
 * A point for the /api/routes body. If the field holds a place chosen from the
 * autocomplete dropdown we already have its coordinates, so we send those and
 * the server skips geocoding entirely. Free-typed text is sent as a query.
 */
function fieldPoint(widget, inputId) {
  const input = $('#' + inputId);
  const text = input.value.trim();
  if (!text) return null;
  const c = widget ? widget.coords() : null;
  if (c) return { lat: c.lat, lng: c.lng, label: text };
  return text;
}

async function planRoutes() {
  const from = $('#fromInput').value.trim();
  const to = $('#toInput').value.trim();
  if (!from || !to) {
    toast('mapStatus', 'Enter both a start and a destination.', 'err');
    return;
  }
  const btn = $('#planBtn');
  btn.disabled = true;
  btn.textContent = 'Finding routes…';
  toast('mapStatus', 'Finding candidate routes…', 'loading');
  toast('routeStatus', 'Finding routes…', 'loading');

  try {
    const plan = await api('/api/routes', {
      method: 'POST',
      body: JSON.stringify({
        from: fieldPoint(state.acFrom, 'fromInput'),
        to: fieldPoint(state.acTo, 'toInput'),
        mode: state.mode,
        departure: departureISO(),
        lambda: state.lambda,
      }),
    });
    state.plan = plan;
    state.selected = null;
    state.hotspots = plan.hotspots || state.hotspots;
    if (plan.coverage) state.coverage = { bbox: plan.coverage.bbox };
    renderPlan(plan);
    toast('mapStatus', `${plan.candidate_count} candidates → ${plan.routes.length} options`, 'ok');
    toast('routeStatus', plan.covered ? 'Routes ready' : 'Routes ready — no safety data here', plan.covered ? 'ok' : 'warn');
    navigateTab('route');
  } catch (e) {
    toast('mapStatus', e.message, 'err');
    $('#routeCards').innerHTML = `<div class="notice notice--err">${esc(e.message)}</div>`;
    navigateTab('route');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find safe routes';
  }
}

/** The role selected by default, and the one the "why" panel describes. */
function primaryRole(plan) {
  const roles = plan.routes.map((r) => r.role);
  if (roles.includes('safest')) return 'safest';
  if (roles.includes('balanced')) return 'balanced';
  return plan.routes[0] && plan.routes[0].role;
}

function renderPlan(plan) {
  $('#routeSummary').textContent =
    `${plan.from.label ? plan.from.label.split(',')[0] : 'Start'} → ${plan.to.label ? plan.to.label.split(',')[0] : 'Destination'} · ` +
    `${plan.mode === 'walk' ? 'walking' : plan.mode === 'cycle' ? 'cycling' : 'driving'} · ` +
    `departing ${plan.departure === 'now' ? 'now' : new Date(plan.departure).toLocaleString()}`;
  $('#candidateCount').textContent = `${plan.candidate_count} candidates compared`;

  const cards = $('#routeCards');
  cards.innerHTML = '';

  // Honest, data-driven notices first.
  const notice = (kind, text) => {
    const d = document.createElement('div');
    d.className = 'notice notice--' + kind;
    d.textContent = text;
    cards.appendChild(d);
  };
  if (plan.uncovered_note) notice('warn', plan.uncovered_note);
  if (plan.long_walk_warning) notice('warn', plan.long_walk_warning);
  if (plan.sameness_note) notice('info', plan.sameness_note);
  if (!plan.uncovered_note && plan.routes.length < 3) {
    notice('info', plan.routes.length === 1
      ? 'Only one distinct route exists between these points at this time — the alternative roads are either the same corridor or carry the same reported risk. Try a different start, destination or travel mode for more options.'
      : `Only ${plan.routes.length} distinct options are worth showing here: the other candidates follow the same corridor or carry the same reported risk, so they would not change your choice.`);
  }

  plan.routes.forEach((r) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'route';
    b.dataset.role = r.role;
    b.setAttribute('aria-pressed', String(state.selected === r.role || (!state.selected && r.role === primaryRole(plan))));
    const band = r.covered ? safetyBand(r.safety_score) : 'none';
    const colour = ROLE_COLOUR[r.role] || ROLE_COLOUR.alternative;
    const h = r.help_along || {};
    const helpBits = [];
    if (h.police) helpBits.push(h.police + ' police');
    if (h.hospital) helpBits.push(h.hospital + ' hospital');
    if (h.shop) helpBits.push(h.shop + ' shops');
    const scoreCell = r.covered
      ? `<div class="route__score ${scoreClass(r.safety_score)}">${r.safety_score}<small>SAFETY</small></div>`
      : `<div class="route__score" style="color:var(--text-faint)">—<small>NO DATA</small></div>`;
    b.innerHTML = `
      <div class="route__top">
        <div class="route__role"><span class="route__dot" style="background:${colour}"></span>${r.role.charAt(0).toUpperCase() + r.role.slice(1)}
          <span class="route__badge route__badge--${band}">${r.covered ? band + ' risk' : 'no data'}</span></div>
        ${scoreCell}
      </div>
      <div class="route__meta">
        <span><b>${fmtDist(r.distance_m)}</b> distance</span>
        <span><b>${fmtTime(r.duration_s)}</b> time</span>
        <span><b>${r.hotspots_near.length}</b> hotspots near</span>
        ${r.extra_time_s > 30 ? `<span><b>+${fmtTime(r.extra_time_s)}</b> vs fastest</span>` : ''}
      </div>
      ${r.covered ? `<div class="exposure">
        <div class="bar" style="flex:1" role="img" aria-label="Reported risk exposure ${r.exposure_per_km} out of 100 per km">
          <span class="bar__seg" style="width:${Math.max(2, 100 - r.exposure_per_km)}%;background:var(--safe)"></span>
          <span class="bar__seg" style="width:${Math.min(98, r.exposure_per_km)}%;background:${riskColour(r.exposure_per_km)}"></span>
        </div>
        <span>${r.exposure_per_km}/km</span>
      </div>` : ''}
      ${helpBits.length ? `<div class="route__meta" style="margin-top:8px;margin-bottom:0"><span>Passes ${esc(helpBits.join(', '))}</span></div>` : ''}
      ${r.extra_time_pct > 40 && !r.is_fastest ? `<div class="notice notice--warn" style="margin-top:9px">${r.role === 'alternative' ? 'This option' : 'This safer option'} takes ${Math.round(r.extra_time_pct)}% longer than the fastest route.</div>` : ''}
      <div class="route__go">
        <button class="btn btn--sm btn--nav" type="button" data-nav-role="${esc(r.role)}">Start navigation</button>
      </div>
    `;
    b.addEventListener('click', () => selectRoute(r.role));
    // The card is a button, so the nested Start-navigation control must not
    // also select the card or bubble its click up.
    const go = b.querySelector('.btn--nav');
    if (go) {
      go.addEventListener('click', (e) => {
        e.stopPropagation();
        startNavigation(r.role);
      });
    }
    cards.appendChild(b);
  });

  renderRoutes();
  renderWhy();

  // Overview map keeps its hotspots in sync with the plan.
  if (state.maps.map && plan.hotspots) drawHotspots(state.maps.map, 'map', plan.hotspots);
}

/** Draw the three routes on the Safe route map and fit them in view. */
function renderRoutes() {
  const plan = state.plan;
  const map = state.maps.map2;
  if (!plan || !map) return;
  const L2 = ensureLayers(map, 'map2');
  L2.routes.clearLayers();

  const selectedRole = state.selected || primaryRole(plan);

  // The two routes that are not selected: thin, drawn in their role colour.
  plan.routes.filter((r) => r.role !== selectedRole).forEach((r) => {
    const pts = r.path || r.coords;
    const line = L.polyline(pts, {
      color: ROLE_COLOUR[r.role] || ROLE_COLOUR.alternative, weight: 4, opacity: 0.55,
    });
    line.bindTooltip(`${r.role} · ${r.covered ? 'safety ' + r.safety_score + '/100 · ' : ''}${fmtTime(r.duration_s)}`);
    line.on('click', () => selectRoute(r.role));
    line.addTo(L2.routes);
  });

  // The selected route: a role-colour casing under segment-risk colouring, so
  // you can still tell which option it is while seeing the risky stretches.
  const r = plan.routes.find((x) => x.role === selectedRole);
  if (r) {
    const pts = r.path || r.coords;
    const risks = r.seg_risks || [];
    L.polyline(pts, {
      color: ROLE_COLOUR[r.role] || ROLE_COLOUR.alternative, weight: 10, opacity: 0.3, lineCap: 'round',
    }).addTo(L2.routes);
    for (let i = 1; i < pts.length; i++) {
      const risk = risks[i] != null ? risks[i] : (risks[i - 1] != null ? risks[i - 1] : 30);
      const seg = L.polyline([pts[i - 1], pts[i]], {
        color: riskColour(risk), weight: 6, opacity: 0.98, lineCap: 'round',
      });
      seg.bindTooltip(r.covered ? `${riskBand(risk)} risk · ${risk}/100` : 'No safety data for this area');
      seg.on('click', () => selectRoute(r.role));
      seg.addTo(L2.routes);
    }
    L.circleMarker(pts[0], { radius: 7, color: '#c8cbd2', fillColor: '#101114', fillOpacity: 1, weight: 3 })
      .bindTooltip('Start').addTo(L2.routes);
    L.circleMarker(pts[pts.length - 1], { radius: 7, color: '#f0616b', fillColor: '#101114', fillOpacity: 1, weight: 3 })
      .bindTooltip('Destination').addTo(L2.routes);

    // Hotspots this route avoids, when a real alternative exists.
    (r.avoided_hotspots || []).forEach((h) => {
      L.circle([h.lat, h.lng], {
        radius: 250, color: '#f0b429', weight: 2, dashArray: '5 5',
        fillColor: '#f0b429', fillOpacity: 0.06,
      }).bindTooltip(`Avoided: ${esc(h.name)}`).addTo(L2.routes);
    });
  }

  drawCoverage(map, 'map2');
  drawHotspots(map, 'map2', state.hotspots);
  fitRoutes();
}

function fitRoutes() {
  const plan = state.plan;
  const map = state.maps.map2;
  if (!plan || !map) return;
  const bounds = L.latLngBounds([]);
  plan.routes.forEach((r) => (r.path || r.coords).forEach((p) => bounds.extend(p)));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
}

function selectRoute(role) {
  state.selected = role;
  const plan = state.plan;
  if (!plan) return;
  $$('#routeCards .route').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.role === role)));
  renderRoutes();
  renderWhy();
}

/**
 * Hand the chosen route to the navigation screen. The route keeps its geometry
 * and its identity (Safest / Balanced / Fastest) so the trip view can say which
 * option is being followed.
 */
function startNavigation(role) {
  const plan = state.plan;
  if (!plan) return;
  const r = plan.routes.find((x) => x.role === role) || plan.routes[0];
  if (!r) return;
  if (!window.SafePathNav) {
    toast('routeStatus', 'Navigation is unavailable: the navigation script did not load.', 'err');
    return;
  }
  state.selected = role;
  window.SafePathNav.start(
    { ...r, coords: r.path || r.coords, mode: plan.mode },
    {
      role: r.role,
      mode: plan.mode,
      fromLabel: plan.from && plan.from.label ? plan.from.label.split(',')[0] : '',
      toLabel: plan.to && plan.to.label ? plan.to.label.split(',')[0] : '',
    }
  );
}

function renderWhy() {
  const plan = state.plan;
  if (!plan) return;
  const role = state.selected || primaryRole(plan);
  const r = plan.routes.find((x) => x.role === role);
  if (!r) return;
  $('#whyCard').hidden = false;
  $('#whyRole').textContent = r.covered ? role + ' · safety ' + r.safety_score + '/100' : role + ' · no data';
  const ul = $('#whyList');
  ul.innerHTML = '';
  (r.reasons || []).forEach((reason) => {
    const li = document.createElement('li');
    if (/high-risk|longer|unlit|Only |No safer alternative|No safety data/i.test(reason)) li.className = 'warn';
    li.textContent = reason;
    ul.appendChild(li);
  });
  // expose the raw numbers that produced the score
  if (r.covered) {
    const detail = document.createElement('li');
    detail.style.color = 'var(--text-faint)';
    detail.style.fontSize = '.78rem';
    detail.textContent =
      `Numbers behind this score: mean risk ${r.mean_risk}/100, 90th percentile ${r.p90_risk}, ` +
      `max ${r.max_risk}, ${(r.high_risk_frac * 100).toFixed(0)}% of the path is high risk, ` +
      `${(r.lit_fraction * 100).toFixed(0)}% lit, ${r.hotspots_near.length} hotspots within 250 m.`;
    ul.appendChild(detail);
  }
}

/* ------------------------------- report -------------------------------- */
function initReportMap() {
  const map = initMap('map3');
  if (!map) return;
  map.on('click', (e) => setReportLoc(e.latlng.lat, e.latlng.lng));
  ensureLayers(map, 'map3');
  drawCoverage(map, 'map3');
}

function setReportLoc(lat, lng) {
  state.reportLoc = { lat, lng };
  const map = state.maps.map3;
  const L2 = ensureLayers(map, 'map3');
  L2.markers.clearLayers();
  L.circle([lat, lng], { radius: 110, color: '#c8cbd2', fillColor: '#c8cbd2', fillOpacity: 0.18 }).addTo(L2.markers);
  L.circleMarker([lat, lng], { radius: 5, color: '#c8cbd2', fillColor: '#c8cbd2', fillOpacity: 1 }).addTo(L2.markers);
  $('#reportLocText').textContent = `${lat.toFixed(4)}, ${lng.toFixed(4)} (stored at ~110 m area level)`;
  toast('reportStatus', 'Location set — tap again to move it', 'ok');
}

function useCurrentLocation(target, cb) {
  if (!navigator.geolocation) { cb(new Error('Geolocation is not available in this browser.')); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      // Remember it: suggestion ranking is biased toward where the user is.
      state.userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      cb(null, pos.coords.latitude, pos.coords.longitude);
    },
    (err) => cb(new Error(err.message || 'Could not get your location.')),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

/**
 * Turn a position into a short place name ("Vijayanagar (12.3051, 76.6551)")
 * via the server's cached reverse geocode. Falls back to the bare coordinates,
 * so the field is never left reading the literal words "Current location".
 */
async function resolvePlaceName(lat, lng) {
  const coords = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  try {
    const out = await api('/api/geocode?q=' + encodeURIComponent(`${lat},${lng}`));
    return out.short_label || out.label || coords;
  } catch {
    return coords;
  }
}

async function submitReport() {
  if (!state.reportLoc) { toast('reportStatus', 'Choose a location first.', 'err'); return; }
  const btn = $('#reportSubmitBtn');
  btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    const out = await api('/api/reports', {
      method: 'POST',
      body: JSON.stringify({
        lat: state.reportLoc.lat,
        lng: state.reportLoc.lng,
        type: $('#reportType').value,
        lighting: parseInt($('#reportLighting').value, 10),
        crowd: parseInt($('#reportCrowd').value, 10),
        note: $('#reportNote').value,
      }),
    });
    const before = out.risk_before, after = out.risk_now;
    const delta = (typeof before === 'number' && typeof after === 'number') ? +(after - before).toFixed(1) : null;
    const change = delta == null ? ''
      : delta > 0.05 ? ` It raised the estimate here from <b>${before}</b> to <b>${after}</b>/100.`
      : delta < -0.05 ? ` The estimate here is now <b>${after}</b>/100 (was ${before}).`
      : ` The estimate here is unchanged at <b>${after}</b>/100.`;
    $('#reportResult').innerHTML =
      `<div class="notice notice--ok">Thanks — your report is now part of the risk estimate for this area.${change} ` +
      `${esc(out.privacy)}</div>`;
    // show the new signal on the map
    const L2 = ensureLayers(state.maps.map3, 'map3');
    L.circleMarker([out.report.lat, out.report.lng], {
      radius: 9, color: '#c8cbd2', weight: 2, fillColor: '#c8cbd2', fillOpacity: 0.3, dashArray: '4 3',
    }).bindPopup('Your report · ' + esc(out.report.type) + ' · ' + timeAgo(out.report.created_at)).addTo(L2.reports);
    $('#reportNote').value = '';
    // refresh hotspots + risk so the change is visible
    await refreshHotspots();
  } catch (e) {
    const extra = e.body && e.body.detail ? ' ' + e.body.detail : '';
    $('#reportResult').innerHTML = `<div class="notice notice--err">${esc(e.message + extra)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Submit report';
  }
}

/* ------------------------------ live desk ------------------------------ */
let liveSource = null;

function initLiveFeed() {
  if (liveSource) return;
  const feed = $('#liveFeed');
  feed.innerHTML = '';
  liveSource = new EventSource(API + '/api/reports/stream');
  liveSource.addEventListener('hello', () => toast('liveStatus', 'Live · connected', 'ok'));
  const onEvent = (kind) => (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    addFeedItem(kind, d);
    if (kind === 'report' && state.maps.map4) {
      const L2 = ensureLayers(state.maps.map4, 'map4');
      L.circleMarker([d.lat, d.lng], { radius: 7, color: '#c8cbd2', fillColor: '#c8cbd2', fillOpacity: 0.35 })
        .bindPopup('Report · ' + esc(d.type) + ' · ' + timeAgo(d.created_at)).addTo(L2.reports);
    }
  };
  liveSource.addEventListener('report', onEvent('report'));
  liveSource.addEventListener('alert', onEvent('alert'));
  liveSource.onerror = () => toast('liveStatus', 'Live · reconnecting…', 'warn');
}

function addFeedItem(kind, d) {
  const feed = kind === 'report' ? $('#liveFeed') : $('#alertFeed');
  const empty = feed.querySelector('.feed__empty');
  if (empty) empty.remove();
  const li = document.createElement('li');
  const icon = kind === 'report'
    ? ({ low_lighting: '💡', harassment: '⚠', unusual_activity: '👀', obstruction: '🚧' }[d.type] || '📍')
    : '🚨';
  const title = kind === 'report'
    ? (d.type || 'report').replace(/_/g, ' ')
    : (d.message || 'panic alert');
  li.innerHTML = `
    <div class="feed__icon" aria-hidden="true">${icon}</div>
    <div class="feed__body">
      <div class="feed__title">${esc(title)}</div>
      <div class="feed__meta mono">${d.lat != null ? d.lat.toFixed(3) + ', ' + d.lng.toFixed(3) : ''} · ${timeAgo(d.created_at || d.at)}</div>
      ${d.delivery ? `<div class="feed__meta">${esc(d.delivery)}</div>` : ''}
    </div>`;
  feed.prepend(li);
  while (feed.children.length > 40) feed.removeChild(feed.lastChild);
}

async function loadLive() {
  initLiveFeed();
  try {
    const { alerts } = await api('/api/alerts?limit=20');
    const feed = $('#alertFeed');
    if (alerts.length) {
      feed.innerHTML = '';
      alerts.forEach((a) => addFeedItem('alert', { ...a, at: a.created_at }));
    }
  } catch { /* non-fatal */ }
  try {
    const ch = await api('/api/alerts/channels');
    $('#alertMode').textContent = ch.mode === 'live' ? 'live channels' : 'demo mode';
    const rows = Object.entries(ch.channels).map(([k, v]) =>
      `<div class="feed__meta">${k}: ${v.configured ? 'configured' : 'not configured'}</div>`).join('');
    $('#alertChannels').innerHTML =
      `<div class="notice ${ch.mode === 'live' ? 'notice--ok' : 'notice--warn'}">${esc(ch.note)}</div>${rows}`;
  } catch { /* non-fatal */ }
}

/* ------------------------------- panic --------------------------------- */
function initPanic() {
  const btn = $('#panicBtn');
  const ring = $('#panicRing');
  const label = $('#panicLabel');
  const HOLD_MS = 2000;
  const CIRC = 2 * Math.PI * 48;
  let timer = null, start = 0, raf = null;

  const reset = () => {
    clearTimeout(timer); cancelAnimationFrame(raf);
    btn.classList.remove('holding');
    ring.setAttribute('stroke-dashoffset', String(CIRC));
    label.textContent = 'to alert';
  };
  const tick = () => {
    const t = Math.min(1, (Date.now() - start) / HOLD_MS);
    ring.setAttribute('stroke-dashoffset', String(CIRC * (1 - t)));
    if (t < 1) raf = requestAnimationFrame(tick);
  };
  const begin = (e) => {
    e.preventDefault();
    start = Date.now();
    btn.classList.add('holding');
    label.textContent = 'keep holding…';
    tick();
    timer = setTimeout(sendPanic, HOLD_MS);
  };

  btn.addEventListener('pointerdown', begin);
  btn.addEventListener('pointerup', reset);
  btn.addEventListener('pointerleave', reset);
  btn.addEventListener('pointercancel', reset);
  // keyboard: Enter/Space triggers the same 2-second hold
  btn.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !timer) { e.preventDefault(); begin(e); }
  });
  btn.addEventListener('keyup', reset);
}

/**
 * Give the emergency contacts panel the position that was just resolved, so its
 * one-tap Text/WhatsApp links carry a real Google Maps link. The account UI is
 * optional — when it is absent (guest-only build) this is a no-op.
 */
function prepareEmergency(lat, lng, err) {
  const ui = window.SafePathAuthUI;
  if (!ui || typeof ui.prepareEmergencyActions !== 'function') return;
  const note = err
    ? 'Your location could not be read, so the message says so. The buttons still open your messaging app.'
    : null;
  try { ui.prepareEmergencyActions(lat, lng, note); } catch { /* non-fatal */ }
}

/**
 * Send an emergency alert for a position. Shared by the planner's panic button
 * and the navigation screen, so the "is this live or a demo?" wording is decided
 * in exactly one place.
 */
async function sendAlert(lat, lng, message) {
  const out = await api('/api/alerts', {
    method: 'POST',
    body: JSON.stringify({ lat, lng, message: message || 'SafePath panic alert' }),
  });
  addFeedItem('alert', { message: message || 'Panic alert', lat, lng, delivery: out.delivery, at: new Date().toISOString() });
  return out;
}

async function sendPanic() {
  const label = $('#panicLabel');
  label.textContent = 'sending…';
  const send = async (lat, lng) => {
    try {
      const out = await sendAlert(lat, lng, 'SafePath panic alert');
      $('#panicResult').innerHTML =
        `<div class="notice ${out.live ? 'notice--ok' : 'notice--warn'}">` +
        `<b>${out.live ? 'Alert sent to your trusted circle.' : 'DEMO ALERT (not delivered).'}</b><br>${esc(out.delivery)}<br>` +
        `<span style="opacity:.75">${esc(out.privacy)}</span></div>`;
    } catch (e) {
      $('#panicResult').innerHTML = `<div class="notice notice--err">Could not send alert: ${esc(e.message)}</div>`;
    }
  };
  useCurrentLocation(null, (err, lat, lng) => {
    if (err) {
      // fall back to the map centre so the button still does something honest
      const c = state.maps.map4 ? state.maps.map4.getCenter() : { lat: CENTER[0], lng: CENTER[1] };
      $('#panicResult').innerHTML = `<div class="notice notice--warn">Location unavailable (${esc(err.message)}). Sending the map centre instead — this is not your real position.</div>`;
      prepareEmergency(lat, lng, err);
      send(c.lat, c.lng);
    } else { prepareEmergency(lat, lng, null); send(lat, lng); }
  });
  const btn = $('#panicBtn');
  btn.classList.remove('holding');
  setTimeout(() => { $('#panicLabel').textContent = 'to alert'; }, 1200);
}

/* ------------------------------ signals -------------------------------- */
function barChart(svg, data, { peak = true } = {}) {
  const W = 320, H = 180, pad = { l: 30, r: 8, t: 12, b: 34 };
  const max = Math.max(1, ...data.map((d) => d.value));
  const bw = (W - pad.l - pad.r) / data.length;
  let out = `<line class="axis" x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}"/>`;
  data.forEach((d, i) => {
    const h = (d.value / max) * (H - pad.t - pad.b);
    const x = pad.l + i * bw + bw * 0.15;
    const w = bw * 0.7;
    const isPeak = peak && d.value === max;
    out += `<rect class="bar${isPeak ? ' bar--peak' : ''}" x="${x.toFixed(1)}" y="${(H - pad.b - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3"/>`;
    out += `<text x="${(x + w / 2).toFixed(1)}" y="${H - pad.b + 13}" text-anchor="middle">${esc(d.label)}</text>`;
    out += `<text x="${(x + w / 2).toFixed(1)}" y="${(H - pad.b - h - 4).toFixed(1)}" text-anchor="middle">${d.value}</text>`;
  });
  svg.innerHTML = out;
}

function lineChart(svg, data) {
  const W = 320, H = 160, pad = { l: 30, r: 10, t: 14, b: 28 };
  if (!data.length) { svg.innerHTML = '<text x="160" y="80" text-anchor="middle">no data</text>'; return; }
  const max = Math.max(1, ...data.map((d) => d.value));
  const stepX = (W - pad.l - pad.r) / Math.max(1, data.length - 1);
  const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const pts = data.map((d, i) => [pad.l + i * stepX, y(d.value)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = line + ` L${pts[pts.length - 1][0].toFixed(1)} ${H - pad.b} L${pts[0][0].toFixed(1)} ${H - pad.b} Z`;
  let out = `<line class="axis" x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}"/>`;
  out += `<path class="area" d="${area}"/><path class="line" d="${line}"/>`;
  pts.forEach((p, i) => {
    out += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5" fill="#c8cbd2"/>`;
    if (i % 2 === 0) out += `<text x="${p[0].toFixed(1)}" y="${H - pad.b + 13}" text-anchor="middle">${esc(data[i].label)}</text>`;
  });
  out += `<text x="${pad.l}" y="${pad.t}" text-anchor="start">max ${max}</text>`;
  svg.innerHTML = out;
}

async function loadSignals() {
  try {
    const s = await api('/api/signals');
    const t = s.totals;
    $('#signalsSource').textContent =
      `Read from the SafePath database (${s.source} data). Model built ${s.model_generated_at ? new Date(s.model_generated_at).toLocaleString() : '—'}.`;
    $('#signalStats').innerHTML = [
      ['Incidents', t.incidents],
      ['Community reports', t.reports],
      ['Hotspots', t.hotspots],
      ['Last 90 days', t.recent_90d],
      ['Verified', t.verified_incidents],
      ['Alerts', t.alerts],
    ].map(([l, n]) => `<div class="stat"><div class="stat__n">${n}</div><div class="stat__l">${l}</div></div>`).join('');

    const b = s.incidents_by_time_of_day;
    barChart($('#chartTime'), [
      { label: 'morning', value: b.morning },
      { label: 'afternoon', value: b.afternoon },
      { label: 'evening', value: b.evening },
      { label: 'night', value: b.night },
    ]);
    const peak = Object.entries(b).sort((x, y) => y[1] - x[1])[0];
    $('#chartTimeNote').textContent = peak
      ? `Most reported incidents fall in the ${peak[0]} bucket (${peak[1]} of ${t.incidents}). Risk is scaled by this pattern at the chosen departure time.`
      : '';

    barChart($('#chartType'), s.incidents_by_type.slice(0, 6).map((r) => ({
      label: r.type.replace('_', ' ').slice(0, 9), value: r.n,
    })), { peak: false });

    lineChart($('#chartTrend'), s.incidents_trend_monthly.map((r) => ({
      label: r.month.slice(5), value: r.n,
    })));

    const list = $('#hotspotList');
    list.innerHTML = '';
    s.top_hotspots.forEach((h, i) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="hotspot__rank">${i + 1}</span>
        <div class="hotspot__body">
          <div class="hotspot__name">${esc(h.name)}</div>
          <div class="hotspot__meta">${h.count} incidents · ${h.recent_pct}% in the last 6 months · ${esc(h.reason || '')}</div>
        </div>
        <div class="intensity" title="Relative intensity ${h.intensity}"><span style="width:${Math.round(h.intensity * 100)}%"></span></div>`;
      li.addEventListener('click', () => {
        navigateTab('overview');
        const m = state.maps.map;
        if (m) { m.setView([h.lat, h.lng], 15); L.popup().setLatLng([h.lat, h.lng]).setContent(`<b>${esc(h.name)}</b><br>${esc(h.reason || '')}`).openOn(m); }
      });
      list.appendChild(li);
    });
    $('#hotspotCount').textContent = `${s.top_hotspots.length} shown of ${t.hotspots}`;
  } catch (e) {
    $('#signalsSource').textContent = 'Could not load signals: ' + e.message;
  }
}

/* ---------------------------- autocomplete ----------------------------- */
/**
 * A marker for a place the user picked from the autocomplete dropdown, so a
 * selection is visible on the map even before a route is planned.
 */
function dropSearchMarker(mapId, place, label) {
  const map = state.maps[mapId];
  if (!map || !isFinite(place.lat) || !isFinite(place.lng)) return;
  const L2 = ensureLayers(map, mapId);
  L2.search = L2.search || L.layerGroup().addTo(map);
  L2.search.clearLayers();
  L.marker([place.lat, place.lng], {
    icon: L.divIcon({
      className: 'ac-pin',
      html: `<span class="ac-pin__dot"></span><span class="ac-pin__label">${esc(label)}</span>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    }),
    keyboard: false,
    alt: label,
  }).addTo(L2.search);
  map.setView([place.lat, place.lng], Math.max(map.getZoom(), 15));
}

/** Where to bias suggestions: the user's last known position, else map centre. */
function biasOrigin(mapId) {
  if (state.userLoc) return state.userLoc;
  const map = state.maps[mapId];
  if (map) {
    const c = map.getCenter();
    return { lat: c.lat, lng: c.lng };
  }
  return { lat: CENTER[0], lng: CENTER[1] };
}

function initAutocomplete() {
  const AC = window.SafePathAutocomplete;
  if (!AC) {
    console.error('[SafePath] autocomplete.js did not load; search suggestions are off.');
    return;
  }

  // --- route form: From and To ---
  state.acFrom = AC.create({
    inputId: 'fromInput',
    label: 'From',
    near: () => biasOrigin('map'),
    myLocation: () => state.userLoc,
    safety: false,
    placeName: resolvePlaceName,
    onSelect: (place) => {
      if (place.isCurrent) state.userLoc = { lat: place.lat, lng: place.lng };
      dropSearchMarker('map', place, 'Start');
      maybeOfferPlan();
    },
  });
  state.acTo = AC.create({
    inputId: 'toInput',
    label: 'To',
    near: () => biasOrigin('map'),
    myLocation: () => state.userLoc,
    safety: true,                                   // destination gets a safety hint
    time: () => departureISO(),
    placeName: resolvePlaceName,
    onSelect: (place) => {
      if (place.isCurrent) state.userLoc = { lat: place.lat, lng: place.lng };
      dropSearchMarker('map', place, 'Destination');
      maybeOfferPlan();
    },
  });

  // --- map overlay search ---
  state.acMap = AC.create({
    inputId: 'mapSearchInput',
    label: 'Search the map',
    near: () => biasOrigin('map'),
    safety: true,
    time: () => departureISO(),
    // While the dropdown is open the chips step aside and the search box lifts
    // above the other map controls, so the first result is never covered.
    onOpen: () => { const m = $('#mapSearchInput').closest('.map-wrap'); if (m) m.classList.add('is-searching'); },
    onClose: () => { const m = $('#mapSearchInput').closest('.map-wrap'); if (m) m.classList.remove('is-searching'); },
    onSelect: (place) => {
      dropSearchMarker('map', place, place.name);
      toast('mapStatus', `Centred on ${place.name}`, 'ok');
      // A map search fills the From field, the common case for "where am I going from".
      if (state.acFrom && !$('#fromInput').value.trim()) {
        state.acFrom.setValue(place.name, place.lat, place.lng);
      }
    },
  });

  // Keep the safety hint in step when the departure time changes.
  const depart = $('#departInput');
  if (depart) depart.addEventListener('change', () => { /* next search re-reads it */ });
}

/**
 * When both fields hold a place, tell the user they can run the search. We do
 * not run it silently: the departure time and mode may still need setting.
 */
function maybeOfferPlan() {
  const fromTxt = $('#fromInput').value.trim();
  const toTxt = $('#toInput').value.trim();
  if (!fromTxt || !toTxt) return;
  toast('mapStatus', 'Both places set — press Enter or “Find safe routes” to compare options.', 'ok');
}

/* ------------------------------- misc ---------------------------------- */
function toast(id, msg, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = (kind === 'loading' ? '<span class="spinner"></span>' : '') + esc(msg);
  el.style.color = kind === 'err' ? 'var(--danger)' : kind === 'warn' ? 'var(--amber)' : kind === 'ok' ? 'var(--safe)' : 'var(--text-dim)';
}

async function refreshHotspots() {
  try {
    const h = await api('/api/hotspots');
    state.hotspots = h.hotspots;
    drawHotspots(state.maps.map, 'map', h.hotspots);
    drawHotspots(state.maps.map2, 'map2', h.hotspots);
  } catch { /* non-fatal */ }
}

async function loadMeta() {
  try {
    const m = await api('/api/meta');
    $('#dataChip').textContent = m.data_source === 'synthetic' ? 'sample data (synthetic)' : m.data_source + ' data';
    $('#modelChip').textContent = m.model_generated_at ? 'model ' + new Date(m.model_generated_at).toLocaleDateString() : 'model not built';
  } catch { /* non-fatal */ }
}

/* ------------------------------- boot ---------------------------------- */
function boot() {
  initTabs();
  const m1 = initMap('map');
  initMap('map2');
  initReportMap();
  initMap('map4');
  if (m1) ensureLayers(m1, 'map');
  initAutocomplete();

  // mode toggle
  $$('#modeCard .seg button').forEach((b) => {
    b.addEventListener('click', () => {
      state.mode = b.dataset.mode;
      $$('#modeCard .seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
  });

  // departure
  $('#departInput').addEventListener('change', (e) => {
    state.departure = e.target.value;
    $('#customTimeField').hidden = e.target.value !== 'custom';
    if (e.target.value === 'custom' && !$('#customTimeInput').value) {
      const d = new Date(Date.now() + 3600000);
      $('#customTimeInput').value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    // risk (and therefore the heatmap) depends on the time of day
    if (state.heatOn) {
      if (state.maps.map && $('#heatToggle').getAttribute('aria-pressed') === 'true') {
        toggleHeat(state.maps.map, 'map', true, $('#heatToggle'));
      }
      if (state.maps.map2 && $('#heatToggle2').getAttribute('aria-pressed') === 'true') {
        toggleHeat(state.maps.map2, 'map2', true, $('#heatToggle2'));
      }
    }
  });
  $('#customTimeInput').addEventListener('change', () => {
    if (state.heatOn && state.maps.map2 && $('#heatToggle2').getAttribute('aria-pressed') === 'true') {
      toggleHeat(state.maps.map2, 'map2', true, $('#heatToggle2'));
    }
  });

  // slider
  $('#lambdaInput').addEventListener('input', (e) => { state.lambda = parseFloat(e.target.value); });

  $('#planBtn').addEventListener('click', planRoutes);
  // Enter moves From -> To, then runs the search. When the dropdown is open the
  // widget has already handled Enter, so this only fires on a closed list.
  $('#fromInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.defaultPrevented === false) {
      const w = state.acFrom && state.acFrom._state;
      if (w && w.open) return;
      $('#toInput').focus();
    }
  });
  $('#toInput').addEventListener('keydown', (e) => {
    // The widget preventDefaults Enter when it used it to pick a suggestion;
    // only a second Enter (list closed) should start the search.
    if (e.key === 'Enter' && e.defaultPrevented === false) planRoutes();
  });

  $('#useLocationBtn').addEventListener('click', () => {
    useCurrentLocation(null, async (err, lat, lng) => {
      if (err) { toast('mapStatus', err.message, 'err'); return; }
      const name = await resolvePlaceName(lat, lng);
      if (state.acFrom) state.acFrom.setValue(name, lat, lng);
      else $('#fromInput').value = name;
      if (state.maps.map) state.maps.map.setView([lat, lng], 15);
      dropSearchMarker('map', { lat, lng }, 'You are here');
      toast('mapStatus', `Using your location — ${name}`, 'ok');
    });
  });

  // heatmap toggles (overview + route maps)
  const ht = $('#heatToggle');
  ht.addEventListener('click', () => {
    const on = ht.getAttribute('aria-pressed') !== 'true';
    ht.setAttribute('aria-pressed', String(on));
    ht.textContent = on ? 'Hide heatmap' : 'Risk heatmap';
    toggleHeat(state.maps.map, 'map', on, ht);
  });
  const htg2 = $('#heatToggle2');
  htg2.addEventListener('click', () => {
    const on = htg2.getAttribute('aria-pressed') !== 'true';
    htg2.setAttribute('aria-pressed', String(on));
    htg2.textContent = on ? 'Hide heatmap' : 'Risk heatmap';
    toggleHeat(state.maps.map2, 'map2', on, htg2);
  });

  // hotspot / lamp / help-point layer toggles, for both maps
  bindLayerToggle('#hotspotToggle', '#hotspotToggle2', (on, btn) => {
    state.hotspotsOn = on;
    btn.textContent = on ? 'Hotspots' : 'Show hotspots';
    drawHotspots(state.maps.map, 'map', state.hotspots);
    drawHotspots(state.maps.map2, 'map2', state.hotspots);
  });
  bindLayerToggle('#lampToggle', '#lampToggle2', (on, btn) => {
    state.lampsOn = on;
    btn.textContent = on ? 'Hide lamps' : 'Street lamps';
    toggleFeature(state.maps.map, 'map', 'street_lamp', on);
    toggleFeature(state.maps.map2, 'map2', 'street_lamp', on);
  });
  bindLayerToggle('#helpToggle', '#helpToggle2', (on, btn) => {
    state.helpOn = on;
    btn.textContent = on ? 'Hide help points' : 'Help points';
    toggleFeature(state.maps.map, 'map', 'help', on);
    toggleFeature(state.maps.map2, 'map2', 'help', on);
  });

  // recenter / locate
  $('#recenterBtn').addEventListener('click', () => {
    if (state.maps.map) state.maps.map.setView(CENTER, DEFAULT_ZOOM);
  });
  $('#recenterBtn2').addEventListener('click', fitRoutes);
  $('#overviewLocBtn').addEventListener('click', () => {
    useCurrentLocation(null, (err, lat, lng) => {
      if (err) { toast('mapStatus', err.message, 'err'); return; }
      if (state.maps.map) state.maps.map.setView([lat, lng], 15);
      toast('mapStatus', 'Centred on your location', 'ok');
    });
  });

  // Leaflet must re-measure every visible map when the viewport changes.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      Object.entries(state.maps).forEach(([id, map]) => {
        const el = document.getElementById(id);
        if (map && el && el.offsetParent !== null) map.invalidateSize();
      });
    }, 150);
  });

  // report page
  $('#reportPickBtn').addEventListener('click', () => {
    toast('reportStatus', 'Tap the map to place your report.', 'ok');
    const m = state.maps.map3;
    if (m) m.getContainer().focus?.();
  });
  $('#reportHereBtn').addEventListener('click', () => {
    useCurrentLocation(null, (err, lat, lng) => {
      if (err) { toast('reportStatus', err.message, 'err'); return; }
      if (state.maps.map3) state.maps.map3.setView([lat, lng], 16);
      setReportLoc(lat, lng);
    });
  });
  $('#reportSubmitBtn').addEventListener('click', submitReport);

  // panic
  initPanic();

  // initial data
  loadMeta();
  loadCoverage().then(() => {
    refreshHotspots();
    if (state.maps.map2) drawCoverage(state.maps.map2, 'map2');
  });
  loadSignals();
}

/**
 * Two buttons (overview map + route map) drive the same layer. `apply` is
 * called with the new state and the button that was pressed; the twin button
 * is kept in sync so the two maps never disagree.
 */
function bindLayerToggle(selA, selB, apply) {
  const a = $(selA);
  const b = $(selB);
  const press = (btn, other) => {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    if (other) other.setAttribute('aria-pressed', String(on));
    apply(on, btn, other);
  };
  if (a) a.addEventListener('click', () => press(a, b));
  if (b) b.addEventListener('click', () => press(b, a));
}

/**
 * A small surface for the navigation module and the browser tests: the trip
 * view needs the same fetch wrapper, toast, alert sender and map registry the
 * planner uses, and the tests need to drive the planner without the mouse.
 */
window.SafePathApp = {
  api,
  toast,
  sendAlert,
  startNavigation,
  selectRoute,
  planRoutes,
  selectTab,
  state,
  maps: state.maps,
  onNavEnd: (summary) => {
    // Back on the planner: bring the route map back up to date.
    if (state.maps.map2) setTimeout(() => state.maps.map2.invalidateSize(), 60);
    if (summary) toast('routeStatus', `Trip saved · ${fmtDist(summary.distance_m)} · ${summary.end_reason.replace('_', ' ')}`, 'ok');
  },
};

document.addEventListener('DOMContentLoaded', boot);
