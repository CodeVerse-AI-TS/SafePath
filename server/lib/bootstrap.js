'use strict';
/**
 * First-boot bootstrap.
 *
 * A fresh container starts with an empty volume: no database, no hotspot
 * index. Rather than making the operator remember `npm run bootstrap`, the
 * server seeds itself once on first boot.
 *
 * This runs ONLY when the database has never been seeded, which is the single
 * condition that makes it safe. Both scripts below delete existing rows, so
 * re-running them on a live deployment would destroy real community reports.
 * The `seeded_at` marker is written by data/seed.js and is never cleared, so
 * it is a reliable "this database has been initialised" flag.
 *
 * Disable with SAFEPATH_AUTO_BOOTSTRAP=0 if you want to manage data by hand.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

/** Has this database been seeded before? */
function isSeeded(getMeta) {
  return Boolean(getMeta('seeded_at', null));
}

/** Run one of the repo's scripts as a child process, streaming its output. */
function runScript(script) {
  const file = path.join(ROOT, script);
  console.log(`[bootstrap] running ${script}`);
  execFileSync(process.execPath, [file], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
}

/**
 * Seed and build the hotspot index if, and only if, this is a fresh database.
 * Returns true when it ran. Never throws: a bootstrap failure should leave the
 * server running so /api/health can report the problem.
 */
function bootstrapIfEmpty(getMeta) {
  if (process.env.SAFEPATH_AUTO_BOOTSTRAP === '0') {
    console.log('[bootstrap] disabled by SAFEPATH_AUTO_BOOTSTRAP=0');
    return false;
  }
  if (isSeeded(getMeta)) return false;

  console.log('[bootstrap] empty database detected — seeding synthetic data');
  try {
    runScript('data/seed.js');
    runScript('ds/build.js');
    console.log('[bootstrap] done');
    return true;
  } catch (err) {
    console.error('[bootstrap] failed:', err.message);
    console.error('[bootstrap] run `npm run bootstrap` manually, then restart');
    return false;
  }
}

module.exports = { bootstrapIfEmpty, isSeeded };
