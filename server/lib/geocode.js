'use strict';
/**
 * Nominatim geocoding client.
 *
 * Respects the public usage policy:
 *   - one request per second (serialised queue)
 *   - a descriptive User-Agent / Referer
 *   - results cached in-process and in SQLite (meta table) for 24 h
 *   - India-biased (countrycodes=in) as the prototype did
 *
 * For production, self-host Nominatim or use a paid geocoder and set
 * NOMINATIM_URL to point at it. See README.
 */

const { getMeta, setMeta } = require('./db');

const BASE = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const USER_AGENT =
  process.env.SAFEPATH_UA || 'SafePath/1.0 (safe-route demo; https://github.com/example/safepath)';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;

let lastCall = 0;
let queue = Promise.resolve();

/** Serialise calls so we never exceed ~1 req/sec to the public service. */
function schedule(fn) {
  const run = queue.then(async () => {
    const wait = 1100 - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

function cacheGet(key) {
  try {
    const raw = getMeta(`geo:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.at > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
function cacheSet(key, data) {
  try { setMeta(`geo:${key}`, JSON.stringify({ at: Date.now(), data })); } catch { /* ignore */ }
}

async function nominatim(pathAndQuery, cacheKey) {
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const url = `${BASE}${pathAndQuery}`;
  const data = await schedule(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Referer: 'https://localhost/' },
      });
      if (!res.ok) {
        const err = new Error(`Geocoder responded ${res.status}`);
        err.status = 502;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  });
  cacheSet(cacheKey, data);
  return data;
}

/** "lat, lng" -> point, if the query looks like coordinates. */
function parseLatLng(q) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(q || '');
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * Geocode a free-text query or "lat, lng" string. Returns
 * { label, lat, lng, source } or null.
 */
async function geocode(query) {
  if (!query || !query.trim()) return null;
  const asPoint = parseLatLng(query);
  if (asPoint) {
    const label = await reverseLabel(asPoint.lat, asPoint.lng);
    return { label, lat: asPoint.lat, lng: asPoint.lng, source: 'coordinates' };
  }
  const q = encodeURIComponent(query.trim());
  const data = await nominatim(
    `/search?q=${q}&format=jsonv2&limit=1&countrycodes=in&addressdetails=1`,
    `s:${query.trim().toLowerCase()}`
  );
  if (!Array.isArray(data) || !data.length) return null;
  const r = data[0];
  return {
    label: r.display_name,
    short_label: r.name || r.display_name.split(',')[0],
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    source: 'nominatim',
  };
}

/** Reverse geocode to a short human label (best effort, cached). */
async function reverseLabel(lat, lng) {
  try {
    const data = await nominatim(
      `/reverse?lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}&format=jsonv2&zoom=16&addressdetails=1`,
      `r:${lat.toFixed(4)},${lng.toFixed(4)}`
    );
    if (data && data.display_name) {
      const a = data.address || {};
      const short = a.suburb || a.neighbourhood || a.city_district || a.city || data.name;
      return short ? `${short} (${lat.toFixed(4)}, ${lng.toFixed(4)})` : data.display_name;
    }
  } catch { /* fall through */ }
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

// NOTE: no autocomplete here on purpose - the public Nominatim policy forbids
// search-as-you-type. Use ./places.js (provider-backed) for suggestions.
module.exports = { geocode, reverseLabel, parseLatLng, BASE };
