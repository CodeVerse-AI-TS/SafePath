'use strict';
/** GET /api/risk and GET /api/risk-grid */

const express = require('express');
const { riskAt, riskGrid, getCache, reload, bucketAverages, coverageBbox, featuresInBbox } = require('../lib/risk');
const { resolveTime } = require('../lib/time');

const router = express.Router();

function num(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

router.get('/risk', (req, res) => {
  const lat = num(req.query.lat);
  const lng = num(req.query.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    res.status(400).json({ error: 'lat and lng query parameters are required and must be valid coordinates.' });
    return;
  }
  const t = resolveTime(req.query.time);
  if (t.error) { res.status(400).json({ error: t.error }); return; }
  const time = t.date;
  const r = riskAt(lat, lng, time);
  res.json({
    ...r,
    time: time.toISOString(),
    disclaimer: 'Estimate based on reported data, not a guarantee of safety.',
  });
});

router.get('/risk-grid', (req, res) => {
  const bbox = (req.query.bbox || '').split(',').map(Number);
  if (bbox.length !== 4 || bbox.some((v) => !isFinite(v))) {
    res.status(400).json({ error: 'bbox must be "minLat,minLng,maxLat,maxLng".' });
    return;
  }
  const [minLat, minLng, maxLat, maxLng] = bbox;
  if (minLat >= maxLat || minLng >= maxLng) {
    res.status(400).json({ error: 'bbox is inverted (min must be less than max).' });
    return;
  }
  // guard against a huge request
  if ((maxLat - minLat) > 1.5 || (maxLng - minLng) > 1.5) {
    res.status(400).json({ error: 'bbox too large; request a smaller area (max ~1.5 degrees per side).' });
    return;
  }
  const t = resolveTime(req.query.time);
  if (t.error) { res.status(400).json({ error: t.error }); return; }
  const time = t.date;
  const cells = Math.max(8, Math.min(80, parseInt(req.query.cells, 10) || 48));
  const grid = riskGrid([minLat, minLng, maxLat, maxLng], time, cells);
  res.json({
    bbox: [minLat, minLng, maxLat, maxLng],
    time: time.toISOString(),
    step_deg: grid.step_deg,
    max: grid.max,
    mean: grid.mean,
    points: grid.points,
    disclaimer: 'Estimate based on reported data, not a guarantee of safety.',
  });
});

/** Risk at the four time buckets across a bbox - used by the Signals page. */
router.get('/risk-by-time', (req, res) => {
  const bbox = (req.query.bbox || '12.24,76.56,12.40,76.74').split(',').map(Number);
  if (bbox.length !== 4 || bbox.some((v) => !isFinite(v))) {
    res.status(400).json({ error: 'bbox must be "minLat,minLng,maxLat,maxLng".' });
    return;
  }
  const cells = Math.max(6, Math.min(24, parseInt(req.query.cells, 10) || 14));
  res.json({ bbox, averages: bucketAverages(bbox, cells), disclaimer: 'Estimate based on reported data, not a guarantee of safety.' });
});

/** Force a reload of the in-memory spatial index (after a bulk import). */
router.post('/risk/reload', (req, res) => {
  const c = reload();
  res.json({ ok: true, counts: c.counts });
});

/**
 * The area the model has data for. The UI draws this as a dashed rectangle and
 * uses it to say "no safety data for this area" instead of showing a score.
 */
router.get('/coverage', (req, res) => {
  const bbox = coverageBbox();
  if (!bbox) { res.status(404).json({ error: 'No data loaded yet. Run `npm run seed`.' }); return; }
  res.json({
    bbox: [bbox.minLat, bbox.minLng, bbox.maxLat, bbox.maxLng],
    incidents: bbox.incidents,
    reports: bbox.reports,
    disclaimer: 'Estimate based on reported data, not a guarantee of safety.',
  });
});

/**
 * Road features inside a bbox, for the map layers (street lamps, help points).
 * GET /api/features?bbox=minLat,minLng,maxLat,maxLng&kinds=street_lamp,police
 */
router.get('/features', (req, res) => {
  const bbox = (req.query.bbox || '').split(',').map(Number);
  if (bbox.length !== 4 || bbox.some((v) => !isFinite(v))) {
    res.status(400).json({ error: 'bbox must be "minLat,minLng,maxLat,maxLng".' });
    return;
  }
  const [minLat, minLng, maxLat, maxLng] = bbox;
  if (minLat >= maxLat || minLng >= maxLng) {
    res.status(400).json({ error: 'bbox is inverted (min must be less than max).' });
    return;
  }
  if ((maxLat - minLat) > 1.5 || (maxLng - minLng) > 1.5) {
    res.status(400).json({ error: 'bbox too large; request a smaller area (max ~1.5 degrees per side).' });
    return;
  }
  const kinds = req.query.kinds ? String(req.query.kinds).split(',').filter(Boolean) : null;
  const limit = Math.max(1, Math.min(6000, parseInt(req.query.limit, 10) || 4000));
  res.json({ bbox: [minLat, minLng, maxLat, maxLng], kinds, features: featuresInBbox([minLat, minLng, maxLat, maxLng], kinds, limit) });
});

module.exports = router;
