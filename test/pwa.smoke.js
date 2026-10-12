/**
 * SafePath — installable-app (PWA) smoke test
 * ---------------------------------------------------------------------------
 * Checks the manifest, the icons, and the service worker's real behaviour in a
 * browser: that it registers, that it caches the app shell, that it serves the
 * cached shell when the network is gone, and — most importantly — that it
 * NEVER serves a cached response for /api/*.
 *
 * That last one is the rule that matters. A stale risk score or a stale route
 * would be actively misleading in a safety tool, so it is asserted directly.
 *
 *   node test/pwa.smoke.js
 *   BASE=http://localhost:12000 node test/pwa.smoke.js
 */
'use strict';

const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE || 'http://localhost:12000';
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';

let pass = 0, fail = 0;
function check(label, ok, extra) {
  if (ok) { pass++; console.log(`PASS  ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  await page.setViewport({ width: 1280, height: 900 });

  // Registered before any page script, so this sees the event that pwa.js acts on.
  await page.evaluateOnNewDocument(() => {
    window.__bipFired = false;
    window.addEventListener('beforeinstallprompt', () => { window.__bipFired = true; });
  });

  try {
    /* ------------------------------- manifest --------------------------- */
    console.log('\n1. Web app manifest');
    const manifest = await page.evaluate(async (base) => {
      const res = await fetch(base + '/manifest.webmanifest');
      return res.ok ? res.json() : null;
    }, BASE);
    check('manifest is served and parses', !!manifest);
    if (manifest) {
      check('has a name and short name',
        /SafePath/.test(manifest.name) && manifest.short_name === 'SafePath',
        manifest.short_name);
      check('display is standalone (installs as an app)',
        manifest.display === 'standalone', manifest.display);
      check('start_url and scope are set',
        manifest.start_url === '/' && manifest.scope === '/');
      check('theme_color matches the app background',
        manifest.theme_color === '#101114', manifest.theme_color);
      check('declares 192px and 512px icons',
        manifest.icons.some((i) => i.sizes === '192x192') &&
        manifest.icons.some((i) => i.sizes === '512x512'));
      check('declares a maskable icon (Android adaptive)',
        manifest.icons.some((i) => (i.purpose || '').includes('maskable')));
      check('every icon file actually exists and is a PNG', await page.evaluate(async (base, icons) => {
        for (const icon of icons) {
          const res = await fetch(base + icon.src);
          if (!res.ok) return false;
          if (!(res.headers.get('content-type') || '').includes('image/png')) return false;
        }
        return true;
      }, BASE, manifest.icons));
      check('declares app shortcuts', Array.isArray(manifest.shortcuts) && manifest.shortcuts.length > 0);
    }

    /* --------------------------------- page ----------------------------- */
    console.log('\n2. Page wiring');
    await page.goto(BASE + '/?cb=' + Date.now(), { waitUntil: 'networkidle2', timeout: 60000 });
    await wait(2000);

    check('theme-color meta matches the dark theme',
      await page.evaluate(() => {
        const m = document.querySelector('meta[name="theme-color"]');
        return m && m.content === '#101114';
      }));
    check('color-scheme is dark',
      await page.evaluate(() => {
        const m = document.querySelector('meta[name="color-scheme"]');
        return m && m.content === 'dark';
      }));
    check('manifest is linked', await page.evaluate(() =>
      !!document.querySelector('link[rel="manifest"]')));
    check('apple-touch-icon is linked', await page.evaluate(() =>
      !!document.querySelector('link[rel="apple-touch-icon"]')));

    // Dismiss the welcome card so the app itself is interactive.
    await page.evaluate(() => {
      const b = document.getElementById('welcomeSkip');
      if (b) b.click();
    });
    await wait(400);

    /* --------------------------- service worker ------------------------- */
    console.log('\n3. Service worker');
    const swState = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false };
      const reg = await navigator.serviceWorker.getRegistration();
      return {
        supported: true,
        registered: !!reg,
        scope: reg ? reg.scope : null,
        active: !!(reg && reg.active),
        controller: !!navigator.serviceWorker.controller,
      };
    });
    check('service worker is supported', swState.supported);
    check('service worker registered', !!swState.registered);
    check('service worker reached the active state', !!swState.active);

    // Wait for activation and control to settle.
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && reg.active) await reg.active.ready;
    });
    await wait(1200);

    /* ------------------------------- caching ---------------------------- */
    console.log('\n4. Offline shell');
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const shell = names.find((n) => n.includes('shell'));
      if (!shell) return { names, shell: null, count: 0, hasRoot: false, hasCss: false };
      const cache = await caches.open(shell);
      const keys = await cache.keys();
      const urls = keys.map((r) => new URL(r.url).pathname);
      return {
        names, shell,
        count: urls.length,
        hasRoot: urls.includes('/'),
        hasCss: urls.includes('/styles.css'),
      };
    });
    check('a shell cache was created', !!cached.shell, cached.shell);
    check('the app shell was precached', cached.count > 0, cached.count + ' entries');
    check('the document is cached', cached.hasRoot);
    check('the stylesheet is cached', cached.hasCss);

    // Go offline and confirm the app still opens from the cache.
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await wait(1200);
    const offlineShell = await page.evaluate(() => ({
      hasBrand: !!document.querySelector('.brand__name'),
      title: document.title,
      // The theme paints via background-image on body/html, so test that and a
      // rule that only styles.css defines. A bare background-color check would
      // pass even with no CSS at all.
      hasStyles: getComputedStyle(document.body).backgroundImage !== 'none'
        && getComputedStyle(document.querySelector('.brand__mark')).borderRadius === '12px',
    }));
    check('the app still renders while offline', offlineShell.hasBrand, offlineShell.title);
    check('cached CSS is applied while offline', offlineShell.hasStyles);

    // Back online.
    await page.setOfflineMode(false);
    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    await wait(1500);

    /* --------------------------- api never cached ----------------------- */
    console.log('\n5. Live data is never served from the cache');
    const apiCached = await page.evaluate(async () => {
      const names = await caches.keys();
      let hits = [];
      for (const n of names) {
        const cache = await caches.open(n);
        const keys = await cache.keys();
        hits = hits.concat(keys.map((r) => new URL(r.url).pathname).filter((p) => p.startsWith('/api/')));
      }
      return hits;
    });
    check('no /api/ response is in any cache', apiCached.length === 0, apiCached.join(', ') || 'none');

    // Prove it at runtime: hit the API, then check again.
    await page.evaluate(async (base) => {
      try { await fetch(base + '/api/health'); } catch { /* ignore */ }
      try { await fetch(base + '/api/hotspots'); } catch { /* ignore */ }
    }, BASE);
    await wait(800);
    const apiCached2 = await page.evaluate(async () => {
      const names = await caches.keys();
      let hits = [];
      for (const n of names) {
        const cache = await caches.open(n);
        const keys = await cache.keys();
        hits = hits.concat(keys.map((r) => new URL(r.url).pathname).filter((p) => p.startsWith('/api/')));
      }
      return hits;
    });
    check('hitting the API does not cache it', apiCached2.length === 0, apiCached2.join(', ') || 'none');

    /* ------------------------------- prompts ---------------------------- */
    console.log('\n6. Install and update prompts');
    // Chromium fires beforeinstallprompt, so pwa.js is expected to have shown
    // the bar. Assert the behaviour matches the event rather than a fixed state.
    const bipFired = await page.evaluate(() => window.__bipFired === true);
    const installShown = await page.evaluate(() => !document.getElementById('installPrompt').hidden);
    check('install bar is shown only when the browser offers install',
      installShown === bipFired,
      `beforeinstallprompt=${bipFired} visible=${installShown}`);
    check('update prompt stays hidden until a new worker is waiting', await page.evaluate(() =>
      document.getElementById('updatePrompt').hidden));
    check('install prompt can be dismissed and remembered', await page.evaluate(() => {
      const el = document.getElementById('installPrompt');
      el.hidden = false;
      document.getElementById('installDismiss').click();
      return el.hidden && localStorage.getItem('safepath.install.dismissed') === '1';
    }));

    /* ------------------------------- console ---------------------------- */
    console.log('\n7. Console');
    const real = errors.filter((e) => !/favicon|tile|OpenStreetMap|net::ERR|Failed to load resource/i.test(e));
    check('no unexpected console errors', real.length === 0, real.slice(0, 3).join(' | '));

    console.log(`\n${pass} passed, ${fail} failed\n`);
    await browser.close();
    process.exit(fail ? 1 : 0);
  } catch (err) {
    console.error('\nPWA smoke run crashed:', err.message);
    try { await browser.close(); } catch { /* ignore */ }
    process.exit(1);
  }
})();
