'use strict';
/**
 * SafePath API server.
 *
 *   npm run seed      # write synthetic sample data (500+ incidents)
 *   npm run ds:build  # cluster -> hotspots.json + model.json
 *   npm start         # serve API + /public on http://localhost:3000
 *
 * All safety numbers are ESTIMATES from reported data, not guarantees.
 */

const path = require('node:path');
const express = require('express');
const { getDb, getDbPath, getMeta, closeDb } = require('./lib/db');
const { reload, getCache } = require('./lib/risk');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// Simple, permissive CORS so the single-file prototype can call the API
// during local development. Tighten this for production.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.SAFEPATH_CORS || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// --- boot the data layer ---
getDb();
// A fresh volume has no data. Seed it once so a new deployment works without
// a manual step; this never runs against a database that has been seeded.
if (require.main === module) {
  require('./lib/bootstrap').bootstrapIfEmpty(getMeta);
}
try { reload(); } catch (err) {
  console.warn('[safepath] risk index not loaded:', err.message);
  console.warn('[safepath] run `npm run seed && npm run ds:build` first');
}

// --- API ---
app.use('/api', require('./routes/risk'));
app.use('/api', require('./routes/routes'));
app.use('/api', require('./routes/reports'));
app.use('/api', require('./routes/alerts'));
app.use('/api', require('./routes/signals'));
app.use('/api', require('./routes/navigation'));
app.use('/api', require('./routes/trips'));
app.use('/api', require('./routes/places'));
app.use('/api', require('./routes/geocode'));

app.get('/api/health', (req, res) => {
  const c = (() => { try { return getCache(); } catch { return null; } })();
  res.json({
    ok: true,
    db: path.basename(getDbPath()),
    seeded: getMeta('seeded_at'),
    model_generated_at: getMeta('model_generated_at'),
    data_source: getMeta('data_source', 'synthetic'),
    counts: c ? c.counts : null,
    disclaimer: 'Estimate based on reported data, not a guarantee of safety.',
  });
});

app.get('/api/meta', (req, res) => {
  res.json({
    app: 'SafePath',
    data_source: getMeta('data_source', 'synthetic'),
    seeded_at: getMeta('seeded_at'),
    model_generated_at: getMeta('model_generated_at'),
    hotspot_count: parseInt(getMeta('hotspot_count', '0'), 10),
    default_center: { lat: 12.3052, lng: 76.6554 },
    disclaimer: 'Estimate based on reported data, not a guarantee of safety. Seeded data is synthetic sample data.',
  });
});

// --- static frontend ---
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// --- 404 + error handling ---
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

app.use((err, req, res, _next) => {
  console.error('[safepath] error:', err.message);
  res.status(err.status || 500).json({
    error: err.status ? err.message : 'Internal error',
    detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
  });
});

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`SafePath listening on http://localhost:${PORT}`);
    console.log(`  health:   http://localhost:${PORT}/api/health`);
    console.log('  disclaimer: estimates from reported data, not a guarantee of safety');
  });

  // Containers send SIGTERM on redeploy. Stop accepting connections, then
  // close SQLite so its WAL is checkpointed before the volume is detached.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[safepath] ${signal} received, shutting down`);
    server.close(() => {
      try { closeDb(); } catch (err) { console.error('[safepath] close failed:', err.message); }
      process.exit(0);
    });
    // Do not hang forever if a connection refuses to drain.
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
