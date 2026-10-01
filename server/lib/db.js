'use strict';
/**
 * SQLite data layer for SafePath.
 * Uses Node's built-in `node:sqlite` (Node >= 22.5) so there is no native build step.
 *
 * NOTE ON DATA: everything seeded by data/seed.js is SYNTHETIC sample data.
 * It is shaped like real Indian-city incident reports so the model and UI can be
 * exercised end to end, but no row describes a real event or person.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const DEFAULT_DB = path.join(DATA_DIR, 'safepath.db');

let db = null;

function getDbPath() {
  return process.env.SAFEPATH_DB || DEFAULT_DB;
}

/** Open (and migrate) the database. Idempotent. */
function getDb() {
  if (db) return db;
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      lat          REAL NOT NULL,
      lng          REAL NOT NULL,
      type         TEXT NOT NULL,           -- harassment | theft | assault | snatching | stalking | road_accident | obstruction | other
      severity     INTEGER NOT NULL,        -- 1 (minor) .. 5 (severe)
      timestamp    TEXT NOT NULL,           -- ISO 8601
      source       TEXT NOT NULL,           -- synthetic | imported | report
      verified     INTEGER NOT NULL DEFAULT 0,
      note         TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_incidents_lat_lng ON incidents(lat, lng);
    CREATE INDEX IF NOT EXISTS idx_incidents_ts ON incidents(timestamp);

    CREATE TABLE IF NOT EXISTS reports (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      lat          REAL NOT NULL,           -- AREA-LEVEL (rounded) coordinate, see routes/reports.js
      lng          REAL NOT NULL,
      type         TEXT NOT NULL,           -- low_lighting | harassment | unusual_activity | obstruction | other
      lighting     INTEGER,                 -- 1..5 (1 = very dark, 5 = well lit)
      crowd        INTEGER,                 -- 1..5 (1 = empty, 5 = busy)
      severity     INTEGER NOT NULL DEFAULT 3,
      time_of_day  TEXT,                    -- morning | afternoon | evening | night (derived)
      note         TEXT,
      source       TEXT NOT NULL DEFAULT 'user',
      verified     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reports_lat_lng ON reports(lat, lng);
    CREATE INDEX IF NOT EXISTS idx_reports_ts ON reports(created_at);

    CREATE TABLE IF NOT EXISTS hotspots (
      cluster_id   TEXT PRIMARY KEY,
      name         TEXT,
      lat          REAL NOT NULL,
      lng          REAL NOT NULL,
      radius_m     REAL NOT NULL DEFAULT 250,
      intensity    REAL NOT NULL,           -- 0..1
      count        INTEGER NOT NULL,
      recent_count INTEGER NOT NULL DEFAULT 0,
      last_reported TEXT,                   -- ISO 8601 of the most recent incident
      reason       TEXT,
      generated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS road_features (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      lat        REAL NOT NULL,
      lng        REAL NOT NULL,
      kind       TEXT NOT NULL,   -- street_lamp | police | hospital | shop | fuel | bus_stop | lit_road
      name       TEXT,
      source     TEXT NOT NULL DEFAULT 'synthetic_osm',
      meta       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_road_features_kind ON road_features(kind);

    CREATE TABLE IF NOT EXISTS alerts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      lat          REAL NOT NULL,
      lng          REAL NOT NULL,
      status       TEXT NOT NULL DEFAULT 'open',   -- open | acknowledged | resolved | demo
      message      TEXT,
      channel      TEXT,                            -- none | webhook | sms | email (demo)
      delivery     TEXT,                            -- human-readable delivery result / demo note
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trips (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      role          TEXT,                    -- safest | balanced | fastest | alternative
      mode          TEXT NOT NULL DEFAULT 'walk',
      from_lat      REAL NOT NULL,
      from_lng      REAL NOT NULL,
      to_lat        REAL NOT NULL,
      to_lng        REAL NOT NULL,
      from_label    TEXT,
      to_label      TEXT,
      distance_m    INTEGER,
      planned_duration_s INTEGER,
      actual_duration_s  INTEGER,
      avg_speed_kmh REAL,
      safety_score  REAL,
      mean_risk     REAL,
      started_at    TEXT NOT NULL,
      ended_at      TEXT NOT NULL DEFAULT (datetime('now')),
      end_reason    TEXT,                    -- arrived | ended_by_user | aborted
      share_token   TEXT,                    -- set only if the user shared the trip
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_trips_ended ON trips(ended_at);

    CREATE TABLE IF NOT EXISTS trip_shares (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      token       TEXT NOT NULL UNIQUE,
      trip_id     INTEGER,
      lat         REAL,                      -- AREA-LEVEL (rounded) last known position
      lng         REAL,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at  TEXT,
      FOREIGN KEY(trip_id) REFERENCES trips(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Forward-compatible column adds for databases created by an older build.
  const cols = d.prepare('PRAGMA table_info(hotspots)').all().map((c) => c.name);
  if (!cols.includes('last_reported')) {
    d.exec('ALTER TABLE hotspots ADD COLUMN last_reported TEXT');
  }
}

/** Small helpers -------------------------------------------------------- */

function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}
function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}
function get(sql, params = []) {
  return getDb().prepare(sql).get(...params);
}
function setMeta(key, value) {
  run(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)]
  );
}
function getMeta(key, fallback = null) {
  const row = get('SELECT value FROM meta WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

/** Read hotspots as the public JSON shape (mirrors legacy hotspots.json). */
function readHotspots() {
  const rows = all('SELECT * FROM hotspots ORDER BY intensity DESC');
  return rows.map((h) => ({
    cluster_id: h.cluster_id,
    name: h.name,
    lat: h.lat,
    lng: h.lng,
    radius_m: h.radius_m,
    intensity: h.intensity,
    count: h.count,
    recent_count: h.recent_count,
    last_reported: h.last_reported || null,
    reason: h.reason,
  }));
}

/** Close the database, checkpointing the WAL. Used on shutdown in containers. */
function closeDb() {
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // A checkpoint failure must not stop the process from exiting.
  }
  db.close();
  db = null;
}

module.exports = { getDb, getDbPath, closeDb, run, all, get, setMeta, getMeta, readHotspots };
