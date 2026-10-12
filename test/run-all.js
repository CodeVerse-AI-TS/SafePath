'use strict';
/**
 * Runs the whole suite against a server this script starts and stops itself.
 *
 *   npm run test:all
 *
 * Why this exists: the browser suites talk to a running server, and the report
 * endpoint is rate-limited to 5 submissions per 10 minutes to stop spam. Running
 * the suites twice inside that window therefore fails with a 429 that reads like
 * a broken feature ("report submission shows a result — Too many requests")
 * when in fact the abuse protection is working. Starting our own server lets us
 * raise the limit through SAFEPATH_RATE_MULTIPLIER, which is ignored in
 * production because the variable is simply not set there.
 *
 * A spare port is used so an app you already have running on PORT is untouched.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.TEST_PORT || '12711';
const BASE = `http://127.0.0.1:${PORT}`;

const SUITES = [
  'test/acceptance.js',
  'test/map.smoke.js',
  'test/coverage.smoke.js',
  'test/interaction.smoke.js',
  'test/autocomplete.smoke.js',
  'test/glass-panels.smoke.js',
  'test/home-nav.smoke.js',
  'test/navigation.smoke.js',
  'test/auth.smoke.js',
  'test/pwa.smoke.js',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

function run(file, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file], { cwd: ROOT, env, stdio: 'inherit' });
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

(async () => {
  // The unit tests need no server and run first, so a failure there is obvious.
  const unitCode = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--test', 'test/time.test.js', 'test/risk.test.js',
      'test/nav_math.test.js', 'test/nav_steps.test.js', 'test/places.test.js'],
      { cwd: ROOT, stdio: 'inherit' });
    p.on('exit', (c) => resolve(c ?? 1));
  });

  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT,
      // Raised only for this run; the variable is unset in production.
      SAFEPATH_RATE_MULTIPLIER: process.env.SAFEPATH_RATE_MULTIPLIER || '50',
    },
  });

  const stop = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(130); });

  const healthy = await waitForHealth();
  if (!healthy) {
    console.error(`\nThe server did not become healthy on ${BASE}. Aborting.`);
    stop();
    process.exit(1);
  }

  let failed = 0;
  for (const suite of SUITES) {
    console.log(`\n${'='.repeat(66)}\n${suite}\n${'='.repeat(66)}`);
    const code = await run(suite, { ...process.env, BASE });
    if (code !== 0) failed += 1;
  }

  stop();
  console.log(`\n${'='.repeat(66)}`);
  if (failed || unitCode !== 0) {
    console.log(`FAILED — ${failed} suite(s) failed${unitCode !== 0 ? ' + unit tests failed' : ''}`);
    process.exit(1);
  }
  console.log(`All suites passed (unit tests + ${SUITES.length} browser suites).`);
  process.exit(0);
})();
