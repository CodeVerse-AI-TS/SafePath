'use strict';
/**
 * POST /api/alerts  - panic button (hold-to-alert). Stores an area-level
 *                     location and dispatches to the trusted circle if a
 *                     channel is configured; otherwise records a DEMO alert.
 * GET  /api/alerts  - recent alerts for the Live desk
 * GET  /api/alerts/channels - which channels are live vs demo (for the UI)
 */

const express = require('express');
const { run } = require('../lib/db');
const { areaLevel } = require('../lib/geo');
const { rateLimit } = require('../lib/ratelimit');
const { dispatchAlert, channelStatus } = require('../lib/notify');
const { recentAlerts, subscribers } = require('../lib/live');

const router = express.Router();

router.get('/alerts/channels', (req, res) => {
  const ch = channelStatus();
  const live = Object.values(ch).some((c) => c.configured);
  res.json({
    channels: ch,
    mode: live ? 'live' : 'demo',
    note: live
      ? 'Configured channels will be used for panic alerts.'
      : 'DEMO MODE: no trusted-circle channel is configured, so a panic alert is only recorded in this app and is not sent to anyone.',
  });
});

router.post('/alerts', rateLimit({ limit: 6, windowMs: 10 * 60 * 1000 }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const lat = parseFloat(b.lat);
    const lng = parseFloat(b.lng);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      res.status(400).json({ error: 'A valid location (lat, lng) is required for an alert.' });
      return;
    }
    const [alat, alng] = areaLevel(lat, lng, 110);
    const message = (b.message || 'SafePath panic alert').toString().slice(0, 300);

    const dispatch = await dispatchAlert({ lat: alat, lng: alng, message });

    const info = run(
      `INSERT INTO alerts(lat, lng, status, message, channel, delivery)
       VALUES(?, ?, ?, ?, ?, ?)`,
      [
        +alat.toFixed(6), +alng.toFixed(6),
        dispatch.live ? 'open' : 'demo',
        message,
        dispatch.live ? 'configured' : 'none',
        dispatch.delivery,
      ]
    );
    const id = Number(info.lastInsertRowid);

    const payload = {
      kind: 'alert', id, lat: +alat.toFixed(4), lng: +alng.toFixed(4),
      status: dispatch.live ? 'open' : 'demo', message, delivery: dispatch.delivery,
      created_at: new Date().toISOString(),
    };
    subscribers().forEach((s) => s.write(`event: alert\ndata: ${JSON.stringify(payload)}\n\n`));

    res.status(201).json({
      ok: true,
      alert: payload,
      live: dispatch.live,
      demo: !dispatch.live,
      delivery: dispatch.delivery,
      privacy: 'Location stored at ~110 m area level only. No continuous tracking.',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/alerts', (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  res.json({ alerts: recentAlerts(limit) });
});

module.exports = router;
