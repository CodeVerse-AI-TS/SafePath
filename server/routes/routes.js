'use strict';
/** POST /api/routes - the safety-aware route planner. */

const express = require('express');
const { planRoutes } = require('../lib/routing');
const { geocode, reverseLabel } = require('../lib/geocode');

const router = express.Router();

function asPoint(v) {
  // accepts { lat, lng } | [lat,lng] | "lat,lng" | "address string"
  if (v == null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) {
    const lat = parseFloat(v.lat);
    const lng = parseFloat(v.lng);
    if (isFinite(lat) && isFinite(lng)) return { lat, lng, label: v.label || null };
    if (v.query) return { query: String(v.query) };
    return null;
  }
  if (Array.isArray(v) && v.length === 2) {
    const lat = parseFloat(v[0]);
    const lng = parseFloat(v[1]);
    return isFinite(lat) && isFinite(lng) ? { lat, lng, label: null } : null;
  }
  return { query: String(v) };
}

async function resolve(point) {
  if (!point) return null;
  if (point.lat != null) {
    return {
      lat: point.lat,
      lng: point.lng,
      label: point.label || (await reverseLabel(point.lat, point.lng)),
    };
  }
  const g = await geocode(point.query);
  return g ? { lat: g.lat, lng: g.lng, label: g.label } : null;
}

router.post('/routes', async (req, res, next) => {
  try {
    const body = req.body || {};
    const fromRaw = asPoint(body.from);
    const toRaw = asPoint(body.to);
    if (!fromRaw || !toRaw) {
      res.status(400).json({ error: 'Both "from" and "to" are required (coordinates or a place name).' });
      return;
    }

    const [from, to] = await Promise.all([resolve(fromRaw), resolve(toRaw)]);
    if (!from) { res.status(404).json({ error: 'Could not find the start point. Try a more specific place in India.' }); return; }
    if (!to) { res.status(404).json({ error: 'Could not find the destination. Try a more specific place in India.' }); return; }

    const mode = ['walk', 'cycle', 'drive'].includes(body.mode) ? body.mode : 'walk';
    const departure = body.departure && body.departure !== 'now' ? new Date(body.departure) : new Date();
    const lambda = body.lambda != null ? Number(body.lambda) : 1.5;

    const plan = await planRoutes({ from: [from.lat, from.lng], to: [to.lat, to.lng], mode, departure, lambda });

    res.json({
      from: { ...from },
      to: { ...to },
      ...plan,
    });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

module.exports = router;
