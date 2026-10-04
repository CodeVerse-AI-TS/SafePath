'use strict';
/**
 * GET /api/hotspots          - hotspot list (cluster output)
 * GET /api/signals           - every number the Signals page needs, from the DB
 * GET /api/signals/trend     - monthly incident counts
 *
 * Nothing here is hard-coded; all values are SQL aggregates over the tables.
 */

const express = require('express');
const { all, get, readHotspots, getMeta } = require('../lib/db');

const router = express.Router();

router.get('/hotspots', (req, res) => {
  const hotspots = readHotspots();
  res.json({
    hotspots,
    generated_at: getMeta('model_generated_at'),
    count: hotspots.length,
    source: getMeta('data_source', 'synthetic'),
    disclaimer: 'Estimate based on reported data, not a guarantee of safety.',
  });
});

router.get('/signals', (req, res) => {
  const incidentsTotal = get('SELECT COUNT(*) AS n FROM incidents').n;
  const reportsTotal = get('SELECT COUNT(*) AS n FROM reports').n;
  const alertsTotal = get('SELECT COUNT(*) AS n FROM alerts').n;

  const verified = get('SELECT COUNT(*) AS n FROM incidents WHERE verified = 1').n;
  const recent30 = get(`SELECT COUNT(*) AS n FROM incidents WHERE timestamp > datetime('now','-30 days')`).n;
  const recent90 = get(`SELECT COUNT(*) AS n FROM incidents WHERE timestamp > datetime('now','-90 days')`).n;

  // incidents by hour -> grouped into the four buckets
  const byHour = all(`SELECT CAST(strftime('%H', timestamp) AS INTEGER) AS hour, COUNT(*) AS n FROM incidents GROUP BY hour`);
  const buckets = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  for (const row of byHour) {
    const h = row.hour;
    const b = h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : h >= 17 && h < 21 ? 'evening' : 'night';
    buckets[b] += row.n;
  }

  const byType = all(`SELECT type, COUNT(*) AS n, ROUND(AVG(severity),2) AS avg_severity FROM incidents GROUP BY type ORDER BY n DESC`);
  const bySeverity = all(`SELECT severity, COUNT(*) AS n FROM incidents GROUP BY severity ORDER BY severity`);

  const allHotspots = readHotspots();
  const hotspots = allHotspots.slice(0, 12).map((h) => ({
    cluster_id: h.cluster_id, name: h.name, lat: h.lat, lng: h.lng,
    intensity: h.intensity, count: h.count, recent_count: h.recent_count,
    recent_pct: h.count ? Math.round((h.recent_count / h.count) * 100) : 0,
    reason: h.reason,
  }));

  // monthly trend for the last 12 months
  const trend = all(`
    SELECT strftime('%Y-%m', timestamp) AS month, COUNT(*) AS n
    FROM incidents
    WHERE timestamp > datetime('now','-12 months')
    GROUP BY month ORDER BY month
  `);

  const reportsByType = all(`SELECT type, COUNT(*) AS n FROM reports GROUP BY type ORDER BY n DESC`);
  const reportsByBucket = all(`SELECT time_of_day, COUNT(*) AS n FROM reports GROUP BY time_of_day`);

  const incidentRange = get('SELECT MIN(timestamp) AS first, MAX(timestamp) AS last FROM incidents');

  res.json({
    source: getMeta('data_source', 'synthetic'),
    model_generated_at: getMeta('model_generated_at'),
    totals: {
      incidents: incidentsTotal, reports: reportsTotal, alerts: alertsTotal,
      verified_incidents: verified, recent_30d: recent30, recent_90d: recent90,
      hotspots: allHotspots.length,
    },
    incidents_by_time_of_day: buckets,
    incidents_by_type: byType,
    incidents_by_severity: bySeverity,
    incidents_trend_monthly: trend,
    reports_by_type: reportsByType,
    reports_by_time_of_day: reportsByBucket,
    top_hotspots: hotspots,
    incident_range: incidentRange,
    disclaimer: 'Estimate based on reported data, not a guarantee of safety. Sample data is synthetic.',
  });
});

router.get('/signals/trend', (req, res) => {
  const months = Math.max(1, Math.min(36, parseInt(req.query.months, 10) || 12));
  const trend = all(
    `SELECT strftime('%Y-%m', timestamp) AS month, COUNT(*) AS n
     FROM incidents WHERE timestamp > datetime('now', ?) GROUP BY month ORDER BY month`,
    [`-${months} months`]
  );
  res.json({ months, trend });
});

module.exports = router;
