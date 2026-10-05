'use strict';
/**
 * Live navigation API.
 *
 *   POST /api/navigation        - turn-by-turn payload for one route
 *   POST /api/navigation/reroute - recalculate after going off route
 *   GET  /api/navigation/risk-ahead - risk of the road ahead of a position
 *
 * No location history is stored here. The position in a reroute request is used
 * to compute an answer and then discarded; nothing is written to the database.
 */

const express = require('express');
const { buildNavigation, reroute, riskAhead } = require('../lib/navigation');
const { rateLimit } = require('../lib/ratelimit');
const { resolveTime } = require('../lib/time');

const router = express.Router();

function point(v) {
  if (!v) return null;
  if (Array.isArray(v) && v.length === 2) {
    const lat = parseFloat(v[0]);
    const lng = parseFloat(v[1]);
    return isFinite(lat) && isFinite(lng) ? [lat, lng] : null;
  }
  if (typeof v === 'object') {
    const lat = parseFloat(v.lat);
    const lng = parseFloat(v.lng);
    return isFinite(lat) && isFinite(lng) ? [lat, lng] : null;
  }
  return null;
}

function valid(p) {
  return p && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
}

// Rerouting can be called every time the user drifts off the line, so it gets a
// generous but real ceiling: 30 recalculations per 10 minutes is far more than a
// normal trip needs and still bounds a stuck client.
const rerouteLimit = rateLimit({ limit: 30, windowMs: 10 * 60 * 1000 });

router.post('/navigation', async (req, res, next) => {
  try {
    const b = req.body || {};
    const from = point(b.from);
    const to = point(b.to);
    if (!valid(from) || !valid(to)) {
      res.status(400).json({ error: 'from and to are required, as {lat,lng} or [lat,lng].' });
      return;
    }
    const mode = ['walk', 'cycle', 'drive'].includes(b.mode) ? b.mode : 'walk';
    const role = typeof b.role === 'string' ? b.role.slice(0, 24) : null;

    const departure = resolveTime(b.departure, { field: 'departure' });
    if (departure.error) { res.status(400).json({ error: departure.error }); return; }

    const nav = await buildNavigation({ from, to, mode, role, departure: departure.date });
    res.json({ from: { lat: from[0], lng: from[1] }, to: { lat: to[0], lng: to[1] }, ...nav });
  } catch (err) {
    if (err.status) { res.status(err.status).json({ error: err.message }); return; }
    next(err);
  }
});

router.post('/navigation/reroute', rerouteLimit, async (req, res, next) => {
  try {
    const b = req.body || {};
    const from = point(b.from);
    const to = point(b.to);
    if (!valid(from) || !valid(to)) {
      res.status(400).json({ error: 'from and to are required, as {lat,lng} or [lat,lng].' });
      return;
    }
    const mode = ['walk', 'cycle', 'drive'].includes(b.mode) ? b.mode : 'walk';
    const lambda = b.lambda != null && isFinite(Number(b.lambda)) ? Number(b.lambda) : 1.5;

    const departure = resolveTime(b.departure, { field: 'departure' });
    if (departure.error) { res.status(400).json({ error: departure.error }); return; }

    const nav = await reroute({ from, to, mode, departure: departure.date, lambda });
    res.json({ from: { lat: from[0], lng: from[1] }, to: { lat: to[0], lng: to[1] }, ...nav });
  } catch (err) {
    if (err.status) { res.status(err.status).json({ error: err.message }); return; }
    next(err);
  }
});

router.get('/navigation/risk-ahead', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const toLat = parseFloat(req.query.toLat);
  const toLng = parseFloat(req.query.toLng);
  if (![lat, lng, toLat, toLng].every(isFinite)) {
    res.status(400).json({ error: 'lat, lng, toLat and toLng are required.' });
    return;
  }
  const fromM = Math.max(0, parseFloat(req.query.from_m) || 0);
  const windowM = Math.max(50, Math.min(2000, parseFloat(req.query.window_m) || 500));
  const t = resolveTime(req.query.time);
  if (t.error) { res.status(400).json({ error: t.error }); return; }
  const ahead = riskAhead([[lat, lng], [toLat, toLng]], t.date, fromM, windowM);
  if (!ahead) {
    res.status(404).json({ error: 'No route samples to score for that position.' });
    return;
  }
  res.json({ ...ahead, disclaimer: 'Estimate based on reported data, not a guarantee of safety.' });
});

module.exports = router;
