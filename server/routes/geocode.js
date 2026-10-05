'use strict';
/**
 * Geocoding helpers.
 *
 *   GET /api/geocode?q=          - final resolve for "Search directions" (Nominatim)
 *   GET /api/geocode/suggest?q=  - DEPRECATED alias for /api/places/suggest
 *
 * Nominatim is intentionally kept for the single, user-initiated directions
 * submit only. It is NOT used for autocomplete: the public server's usage
 * policy forbids search-as-you-type. See ../lib/places.js.
 */

const express = require('express');
const { geocode } = require('../lib/geocode');
const { rateLimit } = require('../lib/ratelimit');

const router = express.Router();

// generous but bounded, since Nominatim is rate-limited upstream anyway
router.use(rateLimit({ limit: 90, windowMs: 60 * 1000 }));

router.get('/geocode', async (req, res, next) => {
  try {
    const q = req.query.q;
    if (!q) { res.status(400).json({ error: 'q (query) is required.' }); return; }
    const result = await geocode(q);
    if (!result) { res.status(404).json({ error: 'No place found. Try a more specific name in India.' }); return; }
    res.json(result);
  } catch (err) { next(err); }
});

/**
 * Kept for backwards compatibility. The old implementation called Nominatim's
 * /search for every keystroke, which its usage policy forbids; it now forwards
 * to the provider-backed autocomplete proxy instead.
 */
router.get('/geocode/suggest', (req, res) => {
  const qs = new URLSearchParams();
  ['q', 'lat', 'lng', 'time', 'limit', 'safety'].forEach((k) => {
    if (req.query[k] != null) qs.set(k, String(req.query[k]));
  });
  res.set('Deprecation', 'true');
  res.set('Link', '</api/places/suggest>; rel="successor-version"');
  res.redirect(307, `/api/places/suggest?${qs.toString()}`);
});

module.exports = router;
