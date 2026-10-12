/* The two hero buttons on the home page must open the planner and the map.
   Regression guard: both once shipped with no click handler at all, so a click
   did nothing (no tab change, no scroll, no error) — the silent-failure kind. */
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
  results.push({ name, ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Is `sel` at least partly inside the viewport right now?
const inViewport = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const b = el.getBoundingClientRect();
  return b.top < window.innerHeight && b.bottom > 0 && b.width > 0 && b.height > 0;
}, sel);

const visiblePage = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('.page')).filter((p) => !p.hidden).map((p) => p.id));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e));
  await page.setViewport({ width: 1280, height: 900 });
  // Simulate a returning visitor: pre-set the one-time welcome flag so this
  // test starts on the app itself. The card's own behaviour is covered by
  // test/auth.smoke.js.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('safepath.welcome.seen', '1'); } catch { /* ignore */ }
  });
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await wait(2500);

  // --- 1. both buttons exist on the home screen ---
  const present = await page.evaluate(() => ({
    plan: !!document.getElementById('heroPlanBtn'),
    explore: !!document.getElementById('heroExploreBtn'),
    start: Array.from(document.querySelectorAll('.page')).filter((p) => !p.hidden).map((p) => p.id).join(','),
  }));
  check('both hero buttons exist', present.plan && present.explore);
  check('the app opens on the Overview page', present.start === 'page-overview', present.start);

  // --- 2. "Find a Safe Route" opens the planner ---
  await page.click('#heroPlanBtn');
  await wait(1600);
  const plan = await page.evaluate(() => ({
    page: Array.from(document.querySelectorAll('.page')).filter((p) => !p.hidden).map((p) => p.id),
    hash: location.hash,
    focused: document.activeElement && document.activeElement.id,
    from: !!document.getElementById('fromInput'),
    to: !!document.getElementById('toInput'),
  }));
  check('Find a Safe Route stays on the planner page', plan.page.join(',') === 'page-overview', plan.page.join(','));
  check('Find a Safe Route scrolls the From/To planner into view', await inViewport(page, '#fromInput'));
  check('Find a Safe Route focuses the From field', plan.focused === 'fromInput', String(plan.focused));
  check('the From and To fields are present', plan.from && plan.to);
  check('Find a Safe Route records a history entry', plan.hash === '#planner', plan.hash || '(none)');

  // --- 3. "Explore SafePath" opens the map ---
  await page.click('#heroExploreBtn');
  await wait(1600);
  const explore = await page.evaluate(() => ({
    hash: location.hash,
    mapClass: document.getElementById('map').className,
  }));
  check('Explore SafePath scrolls the map into view', await inViewport(page, '#map'));
  check('Explore SafePath keeps the map live', /leaflet-container/.test(explore.mapClass), explore.mapClass);
  check('Explore SafePath records a history entry', explore.hash === '#explore', explore.hash || '(none)');

  // --- 4. browser Back returns to the previous step ---
  await page.goBack();
  await wait(1500);
  const back = await page.evaluate(() => ({
    hash: location.hash,
    page: Array.from(document.querySelectorAll('.page')).filter((p) => !p.hidden).map((p) => p.id),
  }));
  check('Back returns to the previous view', back.page.join(',') === 'page-overview' && back.hash === '#planner',
    back.page.join(',') + ' ' + back.hash);

  // --- 5. clicking the same button twice does not stack history entries ---
  // Start from a different section, so the first click is a real change.
  await page.click('#heroExploreBtn');
  await wait(900);
  const h0 = await page.evaluate(() => history.length);
  await page.click('#heroPlanBtn');
  await wait(700);
  await page.click('#heroPlanBtn');
  await wait(700);
  const h1 = await page.evaluate(() => history.length);
  const h2 = await page.evaluate(() => location.hash);
  check('clicking twice adds only one history entry', h1 === h0 + 1, h0 + ' -> ' + h1);
  check('clicking twice lands on the planner', h2 === '#planner', h2 || '(none)');

  // --- 6. the existing route search still works from the planner ---
  await page.evaluate(() => {
    document.getElementById('fromInput').value = '';
    document.getElementById('toInput').value = '';
  });
  await page.type('#fromInput', 'Mysore Palace, Mysuru');
  await page.type('#toInput', 'Kuvempunagar, Mysuru');
  await page.evaluate(() => document.getElementById('planBtn').click());
  await page.waitForFunction(() => document.querySelectorAll('#routeCards .route').length > 0, { timeout: 60000 })
    .catch(() => {});
  await wait(2500);
  const routed = await page.evaluate(() => ({
    page: Array.from(document.querySelectorAll('.page')).filter((p) => !p.hidden).map((p) => p.id),
    count: document.querySelectorAll('#routeCards .route').length,
    roles: Array.from(document.querySelectorAll('#routeCards .route')).map((c) => c.dataset.role),
    tiles: document.querySelectorAll('#map2 .leaflet-tile').length,
  }));
  check('the route search still calculates routes', routed.count >= 1, routed.count + ' route(s)');
  check('the route map still renders tiles', routed.tiles > 0, routed.tiles + ' tiles');
  check('a finished search opens the Safe Routes page', routed.page.join(',') === 'page-route', routed.page.join(','));

  // --- 7. the footer links use the same navigation ---
  await page.evaluate(() => document.querySelector('a[data-tab-target="tab-report"]').click());
  await wait(1400);
  check('a footer link opens its page', (await visiblePage(page)).join(',') === 'page-report');

  // --- 8. mobile: both buttons respond to a real tap ---
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.evaluate(() => document.getElementById('tab-overview').click());
  await wait(900);
  await page.tap('#heroPlanBtn');
  await wait(1500);
  check('mobile tap: Find a Safe Route works', await inViewport(page, '#fromInput'));
  await page.tap('#heroExploreBtn');
  await wait(1500);
  check('mobile tap: Explore SafePath works', await inViewport(page, '#map'));

  check('no console errors during the whole flow', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
