'use strict';
/**
 * Trip summary and live-trip sharing.
 *
 *   POST /api/trips            - save a finished trip summary
 *   GET  /api/trips            - recent trip summaries
 *   POST /api/trips/share      - create a live-share link for a trusted contact
 *   GET  /api/trips/share/:token - the (area-level) position behind that link
 *   POST /api/trips/share/:token/stop - end sharing
 *
 * PRIVACY: a trip's endpoints are rounded to ~110 m before they are stored, the
 * same area-level rule the report endpoint uses. Sharing publishes an area-level
 * position only, expires automatically, and can be stopped at any time. Nothing
 * here keeps a trail of where the user went.
 */

const crypto = require('node:crypto');
const express = require('express');
const { run, get, all } = require('../lib/db');
const { areaLevel } = require('../lib/geo');
const { rateLimit } = require('../lib/ratelimit');
const { dispatchShare, channelStatus } = require('../lib/notify');

const router = express.Router();

const SHARE_TTL_MS = 4 * 60 * 60 * 1000; // a shared trip link expires after 4 hours

function num(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

function validPoint(lat, lng) {
  return lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** Round to ~110 m, the same area-level rule the report endpoint applies. */
function area(lat, lng) {
  const [a, b] = areaLevel(lat, lng, 110);
  return [+a.toFixed(6), +b.toFixed(6)];
}

router.post('/trips', rateLimit({ limit: 40, windowMs: 10 * 60 * 1000 }), (req, res) => {
  const b = req.body || {};
  const fromLat = num(b.from_lat);
  const fromLng = num(b.from_lng);
  const toLat = num(b.to_lat);
  const toLng = num(b.to_lng);
  if (!validPoint(fromLat, fromLng) || !validPoint(toLat, toLng)) {
    res.status(400).json({ error: 'A trip needs from_lat/from_lng and to_lat/to_lng.' });
    return;
  }
  const [fLat, fLng] = area(fromLat, fromLng);
  const [tLat, tLng] = area(toLat, toLng);

  const info = run(
    `INSERT INTO trips(
       role, mode, from_lat, from_lng, to_lat, to_lng, from_label, to_label,
       distance_m, planned_duration_s, actual_duration_s, avg_speed_kmh,
       safety_score, mean_risk, started_at, ended_at, end_reason, share_token)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      typeof b.role === 'string' ? b.role.slice(0, 24) : null,
      ['walk', 'cycle', 'drive'].includes(b.mode) ? b.mode : 'walk',
      fLat, fLng, tLat, tLng,
      (b.from_label || '').toString().slice(0, 120) || null,
      (b.to_label || '').toString().slice(0, 120) || null,
      Math.max(0, Math.round(num(b.distance_m) || 0)) || null,
      Math.max(0, Math.round(num(b.planned_duration_s) || 0)) || null,
      Math.max(0, Math.round(num(b.actual_duration_s) || 0)) || null,
      num(b.avg_speed_kmh) != null ? +num(b.avg_speed_kmh).toFixed(1) : null,
      num(b.safety_score) != null ? +num(b.safety_score).toFixed(1) : null,
      num(b.mean_risk) != null ? +num(b.mean_risk).toFixed(1) : null,
      b.started_at ? new Date(b.started_at).toISOString() : new Date().toISOString(),
      new Date().toISOString(),
      ['arrived', 'ended_by_user', 'aborted'].includes(b.end_reason) ? b.end_reason : 'ended_by_user',
      b.share_token ? String(b.share_token).slice(0, 64) : null,
    ]
  );

  res.status(201).json({
    ok: true,
    trip: {
      id: Number(info.lastInsertRowid),
      end_reason: b.end_reason || 'ended_by_user',
      saved_at: new Date().toISOString(),
    },
    privacy: 'Trip endpoints are stored rounded to about 110 m. No location trail is kept.',
  });
});

router.get('/trips', (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  const trips = all(
    `SELECT id, role, mode, distance_m, planned_duration_s, actual_duration_s, avg_speed_kmh,
            safety_score, mean_risk, started_at, ended_at, end_reason
     FROM trips ORDER BY ended_at DESC LIMIT ?`,
    [limit]
  );
  res.json({
    trips,
    count: trips.length,
    privacy: 'Trip endpoints are stored at area level (~110 m).',
  });
});

/** Create a live-share link. Publishes an area-level position, never a trail. */
router.post('/trips/share', rateLimit({ limit: 12, windowMs: 10 * 60 * 1000 }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const lat = num(b.lat);
    const lng = num(b.lng);
    if (!validPoint(lat, lng)) {
      res.status(400).json({ error: 'A current location (lat, lng) is required to start sharing.' });
      return;
    }
    const [aLat, aLng] = area(lat, lng);
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + SHARE_TTL_MS).toISOString();

    const tripId = num(b.trip_id) != null ? Math.round(num(b.trip_id)) : null;
    run(
      `INSERT INTO trip_shares(token, trip_id, lat, lng, active, expires_at)
       VALUES(?,?,?,?,1,?)`,
      [token, tripId, aLat, aLng, expiresAt]
    );

    // Try the configured trusted-circle channels (same ones the panic button
    // uses). With nothing configured this is honestly reported as a demo link.
    const dispatch = await dispatchShare({
      token, lat: aLat, lng: aLng, toLabel: (b.to_label || '').toString().slice(0, 120) || null,
      expiresAt, baseUrl: req.headers.origin || null,
    });

    res.status(201).json({
      ok: true,
      token,
      url: dispatch.url,
      expires_at: expiresAt,
      live: dispatch.live,
      demo: !dispatch.live,
      delivery: dispatch.delivery,
      channels: channelStatus(),
      privacy: 'The link shows an area-level position only, expires in 4 hours, and can be stopped at any time. No location trail is stored.',
    });
  } catch (err) {
    next(err);
  }
});

/** The position behind a share link. Returns nothing once stopped or expired. */
router.get('/trips/share/:token', (req, res) => {
  const token = String(req.params.token || '').slice(0, 64);
  const row = get('SELECT * FROM trip_shares WHERE token = ?', [token]);
  if (!row) { res.status(404).json({ error: 'That share link does not exist.' }); return; }
  const expired = row.expires_at && new Date(row.expires_at).getTime() < Date.now();
  if (!row.active || expired) {
    res.status(410).json({ error: 'This share link has ended.', ended: true });
    return;
  }
  res.json({
    ok: true,
    lat: row.lat,
    lng: row.lng,
    active: !!row.active,
    created_at: row.created_at,
    expires_at: row.expires_at,
    accuracy_note: 'Area-level (~110 m) position, updated only while the trip runs.',
    disclaimer: 'Estimate based on reported data, not a guarantee of safety.',
  });
});

router.post('/trips/share/:token/stop', (req, res) => {
  const token = String(req.params.token || '').slice(0, 64);
  const row = get('SELECT * FROM trip_shares WHERE token = ?', [token]);
  if (!row) { res.status(404).json({ error: 'That share link does not exist.' }); return; }
  run('UPDATE trip_shares SET active = 0 WHERE token = ?', [token]);
  res.json({ ok: true, stopped: true });
});

/**
 * Keep the shared position current while the trip runs. The client sends its
 * area-level position; only the latest one is kept, so there is no trail.
 */
router.post('/trips/share/:token/update', rateLimit({ limit: 120, windowMs: 10 * 60 * 1000 }), (req, res) => {
  const token = String(req.params.token || '').slice(0, 64);
  const row = get('SELECT * FROM trip_shares WHERE token = ?', [token]);
  if (!row) { res.status(404).json({ error: 'That share link does not exist.' }); return; }
  const expired = row.expires_at && new Date(row.expires_at).getTime() < Date.now();
  if (!row.active || expired) { res.status(410).json({ error: 'This share link has ended.', ended: true }); return; }
  const lat = num((req.body || {}).lat);
  const lng = num((req.body || {}).lng);
  if (!validPoint(lat, lng)) { res.status(400).json({ error: 'lat and lng are required.' }); return; }
  const [aLat, aLng] = area(lat, lng);
  run('UPDATE trip_shares SET lat = ?, lng = ? WHERE token = ?', [aLat, aLng, token]);
  res.json({ ok: true });
});

module.exports = router;
