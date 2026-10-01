'use strict';
/**
 * Resolving a caller-supplied time to a Date.
 *
 * The API accepts three forms, because the UI and the docs use different ones:
 *
 *   'now'  | omitted   -> the current time
 *   'night'            -> a representative hour for that time-of-day bucket
 *   ISO 8601 string    -> that exact instant
 *
 * The bucket names matter: risk is scaled by a time-of-day multiplier, so
 * "night" and "afternoon" must give different answers. An earlier version
 * parsed only ISO strings and quietly fell back to the current time for
 * anything else, which meant a request for `time=night` could be answered with
 * a daytime score. For a safety estimate that silent substitution is worse than
 * an error, so unknown input is now rejected rather than guessed at.
 *
 * A date with no time part (e.g. '2026-10-28') is local midnight, not a
 * meaningful departure time, so it is treated as invalid too.
 */

/** Representative hour for each bucket, used when only a bucket name is given. */
const BUCKET_HOURS = { morning: 9, afternoon: 14, evening: 19, night: 23 };

/** A local Date at `hour` today, matching how bucketAverages builds its dates. */
function atHour(hour, base = new Date()) {
  const d = new Date(base);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/**
 * Resolve a time parameter.
 * @returns {{date: Date}|{error: string}} never a silent fallback.
 */
function resolveTime(value, { field = 'time' } = {}) {
  if (value == null || value === '' || value === 'now') return { date: new Date() };
  if (typeof value !== 'string') return { error: `${field} must be a string.` };

  const raw = value.trim();
  if (raw === '') return { date: new Date() };

  const bucket = raw.toLowerCase();
  if (bucket in BUCKET_HOURS) return { date: atHour(BUCKET_HOURS[bucket]) };

  const date = new Date(raw);
  if (isNaN(date.getTime())) {
    return {
      error: `${field} "${value}" is not a time. Use "now", a time of day ` +
        `(${Object.keys(BUCKET_HOURS).join(', ')}), or an ISO 8601 timestamp such as 2026-10-28T23:00:00.`,
    };
  }
  // A bare date carries no time of day; guessing midnight would misreport risk.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { error: `${field} "${value}" has no time of day. Include a time, e.g. ${raw}T23:00:00.` };
  }
  return { date };
}

module.exports = { resolveTime, atHour, BUCKET_HOURS };
