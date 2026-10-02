'use strict';
/**
 * Import a real incident CSV into SafePath.
 *
 * Usage:
 *   node data/import.js path/to/incidents.csv [--replace]
 *   npm run import -- data/sample_incidents_template.csv
 *
 * Expected header (extra columns are ignored, missing optional ones default):
 *   lat,lng,type,severity,timestamp,source,verified,note
 *   - lat/lng      required, WGS84 decimal degrees
 *   - type         one of harassment|theft|assault|snatching|stalking|
 *                  road_accident|obstruction|other   (default: other)
 *   - severity     1..5 (default 3)
 *   - timestamp    ISO 8601 or "YYYY-MM-DD HH:MM" (default: now)
 *   - source       free text, default "imported"
 *   - verified     0/1/true/false (default 0)
 *
 * --replace deletes existing incidents first (a full re-import).
 * Without it, rows are appended, so you can layer several CSVs.
 *
 * After importing, regenerate hotspots + model params:
 *   npm run ds:build
 */

const fs = require('node:fs');
const { getDb, setMeta, get } = require('../server/lib/db');

const VALID_TYPES = new Set([
  'harassment', 'theft', 'assault', 'snatching', 'stalking',
  'road_accident', 'obstruction', 'other',
]);

/** Minimal RFC-4180-ish CSV parser (handles quotes, escaped quotes, CRLF). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

function normaliseTimestamp(v) {
  if (!v) return new Date().toISOString();
  const s = String(v).trim();
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + (s.length <= 16 ? ':00' : ''));
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function normaliseVerified(v) {
  if (v == null || v === '') return 0;
  const s = String(v).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'verified'].includes(s) ? 1 : 0;
}

function normaliseType(v) {
  const s = String(v || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (VALID_TYPES.has(s)) return s;
  if (/harass|eve.?teas/.test(s)) return 'harassment';
  if (/snatch|chain/.test(s)) return 'snatching';
  if (/stalk/.test(s)) return 'stalking';
  if (/theft|stolen|pickpocket/.test(s)) return 'theft';
  if (/assault|attack|molest/.test(s)) return 'assault';
  if (/accident|collision|hit/.test(s)) return 'road_accident';
  if (/obstruct|block|debris/.test(s)) return 'obstruction';
  return 'other';
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const replace = args.includes('--replace');
  if (!file) {
    console.error('Usage: node data/import.js <file.csv> [--replace]');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  if (rows.length < 2) {
    console.error('CSV has no data rows.');
    process.exit(1);
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  for (const req of ['lat', 'lng']) {
    if (col(req) === -1) {
      console.error(`CSV is missing required column "${req}". Found: ${header.join(', ')}`);
      process.exit(1);
    }
  }

  const db = getDb();
  if (replace) db.exec('DELETE FROM incidents;');
  const insert = db.prepare(
    `INSERT INTO incidents(lat, lng, type, severity, timestamp, source, verified, note)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let ok = 0, skipped = 0;
  const before = get('SELECT COUNT(*) AS n FROM incidents').n;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const lat = parseFloat(r[col('lat')]);
    const lng = parseFloat(r[col('lng')]);
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      skipped++; continue;
    }
    let severity = parseInt(r[col('severity')], 10);
    if (!(severity >= 1 && severity <= 5)) severity = 3;
    insert.run(
      +lat.toFixed(6), +lng.toFixed(6),
      col('type') >= 0 ? normaliseType(r[col('type')]) : 'other',
      severity,
      col('timestamp') >= 0 ? normaliseTimestamp(r[col('timestamp')]) : new Date().toISOString(),
      (col('source') >= 0 && r[col('source')]) || 'imported',
      col('verified') >= 0 ? normaliseVerified(r[col('verified')]) : 0,
      col('note') >= 0 ? r[col('note')] : null
    );
    ok++;
  }

  const after = get('SELECT COUNT(*) AS n FROM incidents').n;
  setMeta('last_import', JSON.stringify({ file, at: new Date().toISOString(), added: ok, skipped, replace }));
  console.log(`[import] ${replace ? 'replaced' : 'added'} ${ok} incidents from ${file} (skipped ${skipped} invalid rows)`);
  console.log(`[import] incidents in DB: ${before} -> ${after}`);
  console.log('[import] now run `npm run ds:build` to regenerate hotspots and model parameters');
}

if (require.main === module) main();
module.exports = { parseCsv, normaliseType };
