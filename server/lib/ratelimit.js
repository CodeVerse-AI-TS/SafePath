'use strict';
/**
 * Tiny in-process sliding-window rate limiter (no external deps).
 * Good enough for a single-node deployment; swap for Redis if you scale out.
 */

const buckets = new Map(); // key -> [timestamps]

/**
 * A multiplier applied to every limit. It exists so a test run can exercise the
 * same endpoints repeatedly without tripping the production limits, which stay
 * in force by default. Set SAFEPATH_RATE_MULTIPLIER=50 for a test run; leave it
 * unset (or 1) in production.
 */
const MULTIPLIER = (() => {
  const n = parseFloat(process.env.SAFEPATH_RATE_MULTIPLIER || '1');
  return isFinite(n) && n > 0 ? n : 1;
})();

function hit(key, limit, windowMs) {
  const now = Date.now();
  const effective = Math.max(1, Math.round(limit * MULTIPLIER));
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  buckets.set(key, arr);
  return {
    allowed: arr.length <= effective,
    remaining: Math.max(0, effective - arr.length),
    count: arr.length,
    limit: effective,
  };
}

/** Express middleware factory. */
function rateLimit({ limit = 10, windowMs = 60000, keyFn } = {}) {
  return (req, res, next) => {
    const key = (keyFn ? keyFn(req) : req.ip || 'unknown') + ':' + (req.path || '');
    const r = hit(key, limit, windowMs);
    res.setHeader('X-RateLimit-Limit', r.limit);
    res.setHeader('X-RateLimit-Remaining', r.remaining);
    if (!r.allowed) {
      res.status(429).json({
        error: 'Too many requests',
        detail: `Limit is ${r.limit} requests per ${Math.round(windowMs / 1000)}s. Please wait and try again.`,
      });
      return;
    }
    next();
  };
}

// periodic cleanup so the map does not grow forever
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) {
    const live = arr.filter((t) => now - t < 3600000);
    if (live.length) buckets.set(k, live);
    else buckets.delete(k);
  }
}, 600000).unref?.();

module.exports = { rateLimit, hit };
