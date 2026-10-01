'use strict';
/** Shared live-feed state (SSE subscribers) and report/hotspot readers. */

const { all } = require('./db');

const _subscribers = new Set();

function subscribers() {
  return _subscribers;
}

function recentReports(limit = 40) {
  return all(
    `SELECT id, lat, lng, type, lighting, crowd, severity, time_of_day, note, created_at
     FROM reports ORDER BY datetime(created_at) DESC, id DESC LIMIT ?`,
    [limit]
  ).map((r) => ({
    ...r,
    // never expose more than area-level precision
    lat: +Number(r.lat).toFixed(4),
    lng: +Number(r.lng).toFixed(4),
  }));
}

function recentAlerts(limit = 20) {
  return all(
    `SELECT id, lat, lng, status, message, channel, delivery, created_at
     FROM alerts ORDER BY datetime(created_at) DESC, id DESC LIMIT ?`,
    [limit]
  ).map((a) => ({ ...a, lat: +Number(a.lat).toFixed(4), lng: +Number(a.lng).toFixed(4) }));
}

module.exports = { subscribers, recentReports, recentAlerts };
