'use strict';
/**
 * Optional OpenStreetMap enrichment via the Overpass API.
 *
 *   node data/overpass.js                 # Mysuru bbox, default feature set
 *   node data/overpass.js --bbox 12.25,76.58,12.39,76.72
 *   node data/overpass.js --dry-run       # print the query, do not fetch
 *
 * Pulls street lamps (highway=street_lamp), lit roads (lit=yes/no), shops,
 * police stations, hospitals, petrol stations and bus stops, and stores them in
 * road_features as "safety support" features.
 *
 * IMPORTANT
 *   - Overpass is a shared, free service. This script sends ONE request per run
 *     with a long timeout, sets a descriptive User-Agent, and caches the raw
 *     response on disk (data/cache/overpass-<hash>.json) so re-runs are free.
 *   - If Overpass is unreachable (blocked network, outage, rate limit), the
 *     script leaves the existing features in place and exits 0 with a warning,
 *     so the app still runs on the bundled synthetic features.
 *   - Overpass is not for production traffic. For production, download a
 *     regional extract (Geofabrik) or self-host Overpass, and keep it fresh
 *     with osmium / osm2pgsql. See the README.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDb, run, setMeta, get } = require('../server/lib/db');

const ENDPOINTS = (process.env.OVERPASS_URL ? [process.env.OVERPASS_URL] : [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]);

const USER_AGENT =
  process.env.SAFEPATH_UA || 'SafePath/1.0 (safe-route demo; https://github.com/example/safepath)';

const DEFAULT_BBOX = [12.24, 76.56, 12.40, 76.74]; // south, west, north, east (Mysuru city)

function buildQuery(bbox) {
  const [s, w, n, e] = bbox;
  const box = `${s},${w},${n},${e}`;
  return `[out:json][timeout:120];
(
  node["highway"="street_lamp"](${box});
  way["lit"](${box});
  node["amenity"~"^(police|hospital|fuel|bus_station)$"](${box});
  way["amenity"~"^(police|hospital|fuel|bus_station)$"](${box});
  node["shop"](${box});
  node["amenity"="marketplace"](${box});
);
out center tags;`;
}

function parseArgs() {
  const a = process.argv.slice(2);
  const i = a.indexOf('--bbox');
  let bbox = DEFAULT_BBOX;
  if (i >= 0 && a[i + 1]) bbox = a[i + 1].split(',').map(Number);
  return { bbox, dryRun: a.includes('--dry-run') };
}

function cachePath(query) {
  const h = crypto.createHash('sha1').update(query).digest('hex').slice(0, 12);
  return path.join(__dirname, 'cache', `overpass-${h}.json`);
}

async function fetchOverpass(query) {
  const file = cachePath(query);
  if (fs.existsSync(file)) {
    console.log(`[overpass] using cached response ${path.basename(file)}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  let lastErr;
  for (const endpoint of ENDPOINTS) {
    try {
      console.log(`[overpass] querying ${endpoint} ...`);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 150000);
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          signal: ctrl.signal,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
          },
          body: new URLSearchParams({ data: query }).toString(),
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(json));
      return json;
    } catch (e) {
      lastErr = e;
      console.warn(`[overpass] ${endpoint} failed: ${e.message}`);
    }
  }
  throw lastErr || new Error('no endpoint reachable');
}

function classify(tags = {}) {
  if (tags.highway === 'street_lamp') return { kind: 'street_lamp', name: null, meta: { lit: true } };
  if (tags.amenity === 'police') return { kind: 'police', name: tags.name || 'Police station', meta: null };
  if (tags.amenity === 'hospital' || tags.healthcare === 'hospital') return { kind: 'hospital', name: tags.name || 'Hospital', meta: null };
  if (tags.amenity === 'fuel') return { kind: 'fuel', name: tags.name || 'Fuel station', meta: null };
  if (tags.amenity === 'bus_station' || tags.highway === 'bus_stop') return { kind: 'bus_stop', name: tags.name || null, meta: null };
  if (tags.shop) return { kind: 'shop', name: tags.name || null, meta: { openLate: /24/.test(tags.opening_hours || '') } };
  if (tags.amenity === 'marketplace') return { kind: 'shop', name: tags.name || 'Market', meta: { openLate: false } };
  if (tags.lit === 'yes' || tags.lit === 'no') return { kind: 'lit_road', name: null, meta: { lit: tags.lit === 'yes' } };
  return null;
}

function coordsOf(el) {
  if (el.type === 'node') return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  return null;
}

function main() {
  const { bbox, dryRun } = parseArgs();
  const query = buildQuery(bbox);
  if (dryRun) {
    console.log(query);
    return;
  }

  fetchOverpass(query)
    .then((json) => {
      const db = getDb();
      const before = get('SELECT COUNT(*) AS n FROM road_features').n;
      // Only replace OSM-sourced rows; keep the synthetic ones as a fallback.
      db.exec("DELETE FROM road_features WHERE source = 'osm_overpass'");
      const insert = db.prepare(
        `INSERT INTO road_features(lat, lng, kind, name, source, meta) VALUES(?, ?, ?, ?, 'osm_overpass', ?)`
      );
      const counts = {};
      let written = 0;
      for (const el of json.elements || []) {
        const c = coordsOf(el);
        if (!c) continue;
        const cls = classify(el.tags || {});
        if (!cls) continue;
        insert.run(+c[0].toFixed(6), +c[1].toFixed(6), cls.kind, cls.name, cls.meta ? JSON.stringify(cls.meta) : null);
        counts[cls.kind] = (counts[cls.kind] || 0) + 1;
        written++;
      }
      const after = get('SELECT COUNT(*) AS n FROM road_features').n;
      setMeta('osm_enriched_at', new Date().toISOString());
      console.log(`[overpass] imported ${written} OSM features (${JSON.stringify(counts)})`);
      console.log(`[overpass] road_features rows: ${before} -> ${after}`);
      console.log('[overpass] restart the server (or POST /api/risk/reload) to pick up the new features');
    })
    .catch((e) => {
      console.warn(`[overpass] enrichment skipped: ${e.message}`);
      console.warn('[overpass] the app will keep using the bundled synthetic features.');
      process.exit(0); // non-fatal by design
    });
}

if (require.main === module) main();
module.exports = { buildQuery, classify };
