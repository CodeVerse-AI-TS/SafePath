'use strict';
/**
 * GET /api/places/suggest?q=&lat=&lng=&time=&limit=
 *
 * Search-as-you-type place suggestions. The provider call happens here (or in
 * ../lib/places.js) so that any API key stays on the server; the browser only
 * ever talks to this proxy.
 *
 * Response: { suggestions: [...], provider, cached, disclaimer }
 * Each suggestion carries the coordinates plus a text-match range so the
 * dropdown can bold the matched characters without re-doing the match.
 *
 * The public Nominatim server is deliberately NOT used here - its usage policy
 * forbids autocomplete. See ../lib/places.js for the provider options.
 */

const express = require('express');
const { resolveTime } = require('../lib/time');
const { search, providerStatus } = require('../lib/places');
const { rankPlaces, safetyHint } = require('../lib/place_rank');
const { riskAt, coverageBbox } = require('../lib/risk');
const { rateLimit } = require('../lib/ratelimit');

const router = express.Router();

// Autocomplete fires often; allow bursts but keep a lid on it.
router.use(rateLimit({ limit: 150, windowMs: 60 * 1000 }));

const DISCLAIMER = 'Estimate based on reported data, not a guarantee of safety.';

function num(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

/** Is a point inside the rectangle the model has data for? */
function inCoverage(lat, lng, bbox) {
  if (!bbox) return false;
  return lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng;
}

router.get('/places/suggest', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const limit = Math.max(1, Math.min(8, parseInt(req.query.limit, 10) || 6));
    const lat = num(req.query.lat);
    const lng = num(req.query.lng);
    const near = lat != null && lng != null ? { lat, lng } : null;

    const status = providerStatus();
    if (!status.enabled) {
      res.json({
        suggestions: [], provider: status.provider, enabled: false,
        note: status.needs_key
          ? `Search suggestions need a ${status.provider} API key. Set the key on the server, or use SAFEPATH_PLACES_PROVIDER=photon (free, no key).`
          : 'Search suggestions are disabled (SAFEPATH_PLACES_PROVIDER=none).',
        disclaimer: DISCLAIMER,
      });
      return;
    }

    // Too short to be useful, but still answer so the UI can show its hint.
    if (q.length < 2) {
      res.json({ suggestions: [], provider: status.provider, enabled: true, min_chars: 2, disclaimer: DISCLAIMER });
      return;
    }

    let raw = [];
    let upstreamError = null;
    try {
      raw = await search(q, { limit: Math.min(20, limit * 3), near });
    } catch (err) {
      upstreamError = err;
    }

    if (upstreamError) {
      // Be honest and useful: the dropdown shows an error row, not fake data.
      res.status(502).json({
        suggestions: [],
        provider: status.provider,
        error: 'Search is temporarily unavailable. Check your connection and try again.',
        detail: upstreamError.message,
        disclaimer: DISCLAIMER,
      });
      return;
    }

    const ranked = rankPlaces(q, raw, { near, limit });

    // Attach a safety hint to each suggestion. The hint is only computed for a
    // destination-style lookup (the UI asks for it), and it is cheap: riskAt is
    // an in-memory spatial lookup against the loaded index.
    const t = resolveTime(req.query.time);
    if (t.error) { res.status(400).json({ error: t.error }); return; }
    const time = t.date;
    const wantSafety = req.query.safety === '1';
    const bbox = wantSafety ? coverageBbox() : null;

    const suggestions = ranked.map((p) => {
      const out = {
        name: p.name,
        secondary: p.secondary,
        lat: p.lat,
        lng: p.lng,
        category: p.category,
        provider: p.provider,
        distance_m: p.distance_m,
        match: { field: p.match.field, start: p.match.start, length: p.match.length },
      };
      if (wantSafety) {
        if (!inCoverage(p.lat, p.lng, bbox)) {
          out.safety = { text: 'No safety data', level: 'none' };
        } else {
          const r = riskAt(p.lat, p.lng, time);
          out.safety = { ...safetyHint({ covered: true, risk: r.risk, bucket: r.bucket }), risk: r.risk };
        }
      }
      return out;
    });

    res.json({
      query: q,
      provider: status.provider,
      suggestions,
      disclaimer: DISCLAIMER,
    });
  } catch (err) {
    next(err);
  }
});

/** Which provider is in use and whether it is configured. */
router.get('/places/status', (req, res) => {
  const s = providerStatus();
  res.json({
    ...s,
    note: s.enabled
      ? `Autocomplete via ${s.provider}. Nominatim is used only for the final directions search.`
      : 'Autocomplete is unavailable; the directions search still works.',
  });
});

module.exports = router;
