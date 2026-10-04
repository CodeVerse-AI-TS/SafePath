'use strict';
/**
 * POST /api/reports  - submit a community report
 * GET  /api/reports  - recent reports (area-level coordinates only)
 * GET  /api/reports/stream - Server-Sent Events feed for the Live desk
 *
 * Privacy: incoming coordinates are snapped to an ~110 m grid before storage,
 * so no precise personal location or trace is ever kept.
 */

const express = require('express');
const { run, all, get } = require('../lib/db');
const { areaLevel, haversineM } = require('../lib/geo');
const { reload, riskAt } = require('../lib/risk');
const { rateLimit } = require('../lib/ratelimit');
const { recentReports, subscribers } = require('../lib/live');

const router = express.Router();

const TYPES = new Set(['low_lighting', 'harassment', 'unusual_activity', 'obstruction', 'other']);

function hourToBucket(h) {
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

// 5 reports per 10 minutes per IP. The limit is overridable so a test run can
// raise it rather than tripping the same bucket as a real user.
const REPORT_LIMIT = parseInt(process.env.SAFEPATH_REPORT_LIMIT || '5', 10);
const REPORT_WINDOW_MS = parseInt(process.env.SAFEPATH_REPORT_WINDOW_MS || String(10 * 60 * 1000), 10);

router.post('/reports', rateLimit({ limit: REPORT_LIMIT, windowMs: REPORT_WINDOW_MS }), (req, res) => {
  const b = req.body || {};
  const lat = parseFloat(b.lat);
  const lng = parseFloat(b.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    res.status(400).json({ error: 'A valid location (lat, lng) is required. Tap the map to place it.' });
    return;
  }
  const type = TYPES.has(b.type) ? b.type : 'other';
  const note = (b.note || '').toString().slice(0, 500);
  const lighting = b.lighting != null ? Math.max(1, Math.min(5, parseInt(b.lighting, 10) || 3)) : null;
  const crowd = b.crowd != null ? Math.max(1, Math.min(5, parseInt(b.crowd, 10) || 3)) : null;

  // --- basic abuse checks ---
  // 1) crude content filter
  if (/(https?:\/\/|www\.)/i.test(note) && note.length > 60) {
    res.status(422).json({ error: 'Reports cannot contain links. Please describe what you saw.' });
    return;
  }
  if (/[A-Z\s!]{40,}/.test(note)) {
    res.status(422).json({ error: 'That looks like spam. Please write a normal description.' });
    return;
  }
  // 2) dedupe: same area + type within 20 minutes counts as one report
  const [alat, alng] = areaLevel(lat, lng, 110);
  const dup = all(
    `SELECT id, lat, lng, created_at FROM reports
     WHERE type = ? AND created_at > datetime('now', '-20 minutes')`,
    [type]
  ).find((r) => haversineM(r.lat, r.lng, alat, alng) < 120);
  if (dup) {
    res.status(429).json({
      error: 'A similar report was just submitted for this area.',
      detail: 'Thanks - it is already reflected in the risk estimate.',
      existing_id: dup.id,
    });
    return;
  }

  const severity = type === 'harassment' ? 4 : type === 'unusual_activity' ? 3 : type === 'low_lighting' ? 3 : 2;
  // Risk before this report (from the currently loaded index), so the API can
  // show the change the new signal actually makes.
  const beforeRisk = riskAt(alat, alng, new Date(), { includeComponents: false }).risk;

  const info = run(
    `INSERT INTO reports(lat, lng, type, lighting, crowd, severity, time_of_day, note, source)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'user')`,
    [+alat.toFixed(6), +alng.toFixed(6), type, lighting, crowd, severity, hourToBucket(new Date().getHours()), note || null]
  );
  const id = Number(info.lastInsertRowid);

  // feed the new signal straight back into the model
  reload();
  const afterRisk = riskAt(alat, alng, new Date(), { includeComponents: false }).risk;

  const report = get('SELECT * FROM reports WHERE id = ?', [id]);
  const payload = { kind: 'report', ...report };
  subscribers().forEach((s) => s.write(`event: report\ndata: ${JSON.stringify(payload)}\n\n`));

  res.status(201).json({
    ok: true,
    report: {
      id: report.id,
      lat: report.lat,
      lng: report.lng,
      type: report.type,
      lighting: report.lighting,
      crowd: report.crowd,
      time_of_day: report.time_of_day,
      created_at: report.created_at,
      note: report.note,
    },
    privacy: 'Location stored at ~110 m area level only.',
    risk_before: beforeRisk,
    risk_now: afterRisk,
    message: 'Thanks - this report is now part of the risk estimate for this area.',
  });
});

router.get('/reports', (req, res) => {
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 40));
  res.json({ reports: recentReports(limit) });
});

/** Server-Sent Events stream used by the Live desk. */
router.get('/reports/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, at: new Date().toISOString() })}\n\n`);

  // last few reports so a fresh client is not empty
  for (const r of recentReports(10).reverse()) {
    res.write(`event: report\ndata: ${JSON.stringify({ kind: 'report', ...r })}\n\n`);
  }

  const sub = { write: (chunk) => res.write(chunk), end: () => res.end() };
  subscribers().add(sub);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    subscribers().delete(sub);
  });
});

module.exports = router;
