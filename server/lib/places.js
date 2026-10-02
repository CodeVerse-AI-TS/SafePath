'use strict';
/**
 * Places autocomplete for search-as-you-type.
 *
 * WHY NOT NOMINATIM: the public Nominatim server's usage policy forbids
 * autocomplete ("no autocomplete / search-as-you-type"). Nominatim is still
 * used for the final "Search directions" submit only (see ./geocode.js).
 *
 * Providers (chosen with SAFEPATH_PLACES_PROVIDER, default `photon`):
 *   photon  - photon.komoot.io, free, no API key. The default and the only one
 *             that works out of the box, which keeps the demo honest.
 *   geoapify, mapbox - keyed providers. The key is read from the server
 *             environment and NEVER sent to the browser; the frontend only
 *             ever calls our own /api/places/suggest proxy.
 *   none    - disables autocomplete gracefully.
 *
 * Results are cached in the SQLite `meta` table (24 h) so repeated prefixes
 * and typed-then-deleted text do not hit the upstream every time.
 *
 * IMPORTANT: this module returns *candidate* places only. Ranking against the
 * user's location, fuzzy scoring, highlight offsets and the safety hint all
 * happen in ./place_rank.js, which is pure and unit-tested.
 */

const { getMeta, setMeta } = require('./db');

const PROVIDER = (process.env.SAFEPATH_PLACES_PROVIDER || 'photon').toLowerCase();
const USER_AGENT =
  process.env.SAFEPATH_UA || 'SafePath/1.0 (safe-route demo; https://github.com/example/safepath)';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const FETCH_TIMEOUT_MS = 8000;

const PHOTON_URL = process.env.PHOTON_URL || 'https://photon.komoot.io';
const GEOAPIFY_KEY = process.env.GEOAPIFY_API_KEY || process.env.GEOAPIFY_KEY || '';
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || process.env.MAPBOX_ACCESS_TOKEN || '';

/* --------------------------------- cache -------------------------------- */

function cacheGet(key) {
  try {
    const raw = getMeta(`place:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.at > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
function cacheSet(key, data) {
  try { setMeta(`place:${key}`, JSON.stringify({ at: Date.now(), data })); } catch { /* ignore */ }
}

/* -------------------------------- helpers ------------------------------- */

/** Turn a {name, city, state, country} into "name · area, city" parts. */
function buildParts(name, city, state, country) {
  const primary = (name || '').trim();
  const area = [city, state].filter(Boolean).join(', ') || null;
  const secondary = [area, country].filter(Boolean).join(' · ') || country || null;
  return { primary, area, secondary };
}

/**
 * Photon's `type` (and osm_value) maps to a coarse icon category the UI knows
 * how to draw: place | station | landmark | address.
 */
function photonCategory(p) {
  const type = p.type || '';
  const value = p.osm_value || '';
  if (type === 'house' || value === 'house' || value === 'address' || p.housenumber) return 'address';
  if (['railway', 'station'].includes(value) || ['station'].includes(type)) return 'station';
  if (['bus_stop', 'bus_station', 'halt', 'tram_stop', 'subway_entrance'].includes(value)) return 'station';
  if (['attraction', 'museum', 'monument', 'memorial', 'castle', 'viewpoint', 'artwork', 'theme_park', 'zoo']
    .includes(value) || value === 'tourism') return 'landmark';
  if (type === 'street' || type === 'district' || type === 'locality' || type === 'city'
    || type === 'county' || type === 'state' || type === 'country' || type === 'house') return 'place';
  return 'place';
}

function photonFeatureToPlace(f) {
  const p = f.properties || {};
  const coords = (f.geometry && f.geometry.coordinates) || [];
  const lng = parseFloat(coords[0]);
  const lat = parseFloat(coords[1]);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  const { primary, secondary } = buildParts(p.name, p.city, p.state, p.country);
  if (!primary) return null;
  return {
    name: primary,
    secondary,
    lat,
    lng,
    category: photonCategory(p),
    provider: 'photon',
    id: `${p.osm_type || 'x'}${p.osm_id || ''}` || null,
    country_code: (p.countrycode || '').toUpperCase() || null,
  };
}

/* ------------------------------- providers ------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One GET with a timeout, and a single retry on a transient upstream failure
 * (429 / 5xx). One retry after a short pause is enough to smooth over a blip
 * without becoming the kind of client that hammers a free service.
 */
async function fetchJson(url) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (res.ok) return await res.json();
      const err = new Error(`Places provider responded ${res.status}`);
      err.status = 502;
      err.retryable = res.status === 429 || res.status >= 500;
      lastErr = err;
    } catch (e) {
      lastErr = e;
      lastErr.retryable = true;
    } finally {
      clearTimeout(timer);
    }
    if (!lastErr.retryable) break;
    if (attempt === 0) await sleep(350);
  }
  throw lastErr;
}

async function photon(query, { limit, near }) {
  const params = new URLSearchParams({ q: query, limit: String(limit), lang: 'en' });
  if (near && isFinite(near.lat) && isFinite(near.lng)) {
    params.set('lat', near.lat.toFixed(5));
    params.set('lon', near.lng.toFixed(5));
  }
  const data = await fetchJson(`${PHOTON_URL}/api/?${params.toString()}`);
  const features = (data && data.features) || [];
  return features.map(photonFeatureToPlace).filter(Boolean);
}

async function geoapify(query, { limit, near }) {
  if (!GEOAPIFY_KEY) return null;
  const params = new URLSearchParams({
    text: query, limit: String(limit), lang: 'en', format: 'json', apiKey: GEOAPIFY_KEY,
  });
  if (near && isFinite(near.lat) && isFinite(near.lng)) {
    params.set('bias', `proximity:${near.lng.toFixed(5)},${near.lat.toFixed(5)}`);
  }
  const data = await fetchJson(`https://api.geoapify.com/v1/geocode/autocomplete?${params.toString()}`);
  return ((data && data.results) || []).map((r) => {
    const primary = r.name || r.address_line1 || r.address_line2 || r.formatted;
    if (!primary) return null;
    const { secondary } = buildParts(null, r.city || r.county, r.state, r.country);
    return {
      name: primary,
      secondary: secondary || r.formatted || null,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      category: (r.result_type || '').includes('street') ? 'place'
        : (r.result_type || '').includes('amenity') ? 'landmark' : 'place',
      provider: 'geoapify',
      country_code: (r.country_code || '').toUpperCase() || null,
    };
  }).filter((p) => p && isFinite(p.lat) && isFinite(p.lng));
}

async function mapbox(query, { limit, near }) {
  if (!MAPBOX_TOKEN) return null;
  const params = new URLSearchParams({ q: query, limit: String(limit), language: 'en', access_token: MAPBOX_TOKEN });
  if (near && isFinite(near.lat) && isFinite(near.lng)) {
    // bbox bias around the user: ~0.25 degrees either side
    params.set('proximity', `${near.lng.toFixed(5)},${near.lat.toFixed(5)}`);
  }
  const data = await fetchJson(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${params.toString()}`);
  return ((data && data.features) || []).map((f) => {
    const ctx = {}; (f.context || []).forEach((c) => { const k = (c.id || '').split('.')[0]; ctx[k] = c.text; });
    const { secondary } = buildParts(null, ctx.place || ctx.locality, ctx.region, ctx.country);
    return {
      name: f.text,
      secondary: secondary || f.place_name || null,
      lat: f.center[1],
      lng: f.center[0],
      category: (f.place_type || [])[0] === 'address' ? 'address' : 'place',
      provider: 'mapbox',
      country_code: null,
    };
  }).filter((p) => p && isFinite(p.lat) && isFinite(p.lng));
}

const PROVIDERS = { photon, geoapify, mapbox };

/** Which provider is active, and whether it is usable (key present). */
function providerStatus() {
  if (PROVIDER === 'none') return { provider: 'none', enabled: false, needs_key: false };
  if (PROVIDER === 'geoapify') return { provider: 'geoapify', enabled: !!GEOAPIFY_KEY, needs_key: true };
  if (PROVIDER === 'mapbox') return { provider: 'mapbox', enabled: !!MAPBOX_TOKEN, needs_key: true };
  return { provider: 'photon', enabled: true, needs_key: false };
}

/**
 * Raw, unranked provider results. Returns [] when the provider is disabled or
 * has no key. Throws (with err.status = 502) when the upstream fails.
 */
async function search(query, { limit = 6, near = null } = {}) {
  const q = (query || '').trim();
  if (q.length < 2) return [];
  const status = providerStatus();
  if (!status.enabled) return [];
  const fn = PROVIDERS[status.provider];
  if (!fn) return [];

  const key = `${status.provider}:${q.toLowerCase()}:${limit}:${near ? near.lat.toFixed(2) + ',' + near.lng.toFixed(2) : ''}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const places = (await fn(q, { limit, near })) || [];
  cacheSet(key, places);
  return places;
}

module.exports = { search, providerStatus, buildParts, photonCategory, PROVIDER };
