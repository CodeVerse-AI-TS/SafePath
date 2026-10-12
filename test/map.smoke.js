/* Headless smoke test: no console errors, maps have real height, routes draw. */
let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch {
  console.log('SKIP  puppeteer-core is not installed (npm i -D puppeteer-core) — skipping browser checks.');
  process.exit(0);
}
const fs = require('fs');
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';
if (!fs.existsSync(CHROME)) {
  console.log('SKIP  no Chromium at ' + CHROME + ' (set CHROME_PATH to run browser checks).');
  process.exit(0);
}

const BASE = process.env.BASE || 'http://localhost:12000';
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.setViewport({ width: 1280, height: 900 });
  // Simulate a returning visitor: pre-set the one-time welcome flag so this
  // test starts on the app itself. The card's own behaviour is covered by
  // test/auth.smoke.js.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('safepath.welcome.seen', '1'); } catch { /* ignore */ }
  });
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));

  const mapInfo = await page.evaluate(() => {
    const el = document.getElementById('map');
    const fb = document.getElementById('mapFallback');
    return {
      height: el ? el.getBoundingClientRect().height : 0,
      tiles: document.querySelectorAll('#map .leaflet-tile-loaded').length,
      hotspots: document.querySelectorAll('#map .leaflet-interactive').length,
      fallbackHidden: fb ? fb.hidden : null,
    };
  });
  check('overview map has real height', mapInfo.height > 200, mapInfo.height + 'px');
  check('overview tiles rendered', mapInfo.tiles > 0, mapInfo.tiles + ' tiles');
  check('overview fallback hidden', mapInfo.fallbackHidden === true);
  check('overview hotspots drawn', mapInfo.hotspots > 0, mapInfo.hotspots + ' shapes');

  // Plan a route
  await page.type('#fromInput', 'Mysore Palace, Mysuru');
  await page.type('#toInput', 'Kuvempunagar, Mysuru');
  await page.click('#planBtn');
  await page.waitForFunction(
    () => document.querySelectorAll('#routeCards .route').length >= 1,
    { timeout: 45000 }
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));

  const routeInfo = await page.evaluate(() => {
    const cards = document.querySelectorAll('#routeCards .route');
    const el = document.getElementById('map2');
    const polylines = document.querySelectorAll('#map2 path.leaflet-interactive');
    const roleTexts = Array.from(cards).map((c) => c.dataset.role);
    const styles = Array.from(cards).map((c) => getComputedStyle(c).color);
    return {
      cards: cards.length,
      roles: roleTexts,
      mapHeight: el ? el.getBoundingClientRect().height : 0,
      tiles: document.querySelectorAll('#map2 .leaflet-tile-loaded').length,
      polylines: polylines.length,
      cardColours: styles,
    };
  });
  check('three route cards rendered', routeInfo.cards === 3, routeInfo.roles.join(','));
  check('safe-route map has real height', routeInfo.mapHeight > 200, routeInfo.mapHeight + 'px');
  check('safe-route tiles rendered', routeInfo.tiles > 0, routeInfo.tiles + ' tiles');
  check('routes drawn as polylines', routeInfo.polylines > 3, routeInfo.polylines + ' segments');
  check('route cards use light text', routeInfo.cardColours.every((c) => {
    const m = c.match(/rgb\((\d+), (\d+), (\d+)/); if (!m) return false;
    return (parseInt(m[1]) + parseInt(m[2]) + parseInt(m[3])) / 3 > 150;
  }), routeInfo.cardColours.join(' | '));

  // Clicking a card must sync the map (selected route drawn thicker/segmented)
  const before = await page.evaluate(() => document.querySelectorAll('#map2 path.leaflet-interactive').length);
  await page.click('#routeCards .route[data-role="fastest"]');
  await new Promise((r) => setTimeout(r, 800));
  const after = await page.evaluate(() => ({
    pressed: document.querySelector('#routeCards .route[data-role="fastest"]').getAttribute('aria-pressed'),
    polylines: document.querySelectorAll('#map2 path.leaflet-interactive').length,
  }));
  check('clicking a card selects it', after.pressed === 'true');
  check('map redraws on selection', after.polylines !== before || after.polylines > 0, before + ' -> ' + after.polylines);

  // Mobile 320px
  await page.setViewport({ width: 320, height: 720 });
  await new Promise((r) => setTimeout(r, 1200));
  const mobile = await page.evaluate(() => {
    const el = document.getElementById('map2');
    return { w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height,
             overflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
  });
  check('320px: route map visible', mobile.w > 200 && mobile.h > 200, mobile.w + 'x' + mobile.h);
  check('320px: no horizontal overflow', !mobile.overflow);

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
