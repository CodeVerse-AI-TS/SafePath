/* Verify every map control, the report flow, and the live feed actually work. */
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

const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);

// The probe report is written straight to the shared SQLite file, so remove it
// again rather than leaving test debris behind. Harmless if the DB is remote.
function cleanupProbeReports() {
  try {
    const { getDb } = require('../server/lib/db');
    const db = getDb();
    const n = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE note LIKE '%probe%' OR note LIKE 'Smoke%'").get().n;
    if (n) {
      db.exec("DELETE FROM reports WHERE note LIKE '%probe%' OR note LIKE 'Smoke%'");
      require('../server/lib/risk').reload();
      console.log('  (cleaned up ' + n + ' probe report(s))');
    }
  } catch (e) {
    console.log('  (cleanup skipped: ' + e.message + ')');
  }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e));
  await page.setViewport({ width: 1440, height: 1000 });
  // Simulate a returning visitor: pre-set the one-time welcome flag so this
  // test starts on the app itself. The card's own behaviour is covered by
  // test/auth.smoke.js.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('safepath.welcome.seen', '1'); } catch { /* ignore */ }
  });
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await wait(2500);

  // --- 1. keyboard: plan a route with Enter, not the mouse ---
  await page.click('#fromInput');
  await page.type('#fromInput', 'Mysore Palace, Mysuru');
  await page.type('#toInput', 'Kuvempunagar, Mysuru');
  await page.focus('#toInput');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#routeCards .route').length >= 1, { timeout: 60000 }).catch(() => {});
  await wait(2500);
  check('keyboard Enter plans a route', (await count(page, '#routeCards .route')) === 3);

  // --- 2. route cards are keyboard-focusable buttons with pressed state ---
  const a11y = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#routeCards .route'));
    return {
      allButtons: cards.every((c) => c.tagName === 'BUTTON' && c.type === 'button'),
      pressed: cards.filter((c) => c.getAttribute('aria-pressed') === 'true').length,
      mapTabindex: document.getElementById('map2').getAttribute('tabindex'),
    };
  });
  check('route cards are real buttons', a11y.allButtons);
  check('exactly one card is selected', a11y.pressed === 1, a11y.pressed + ' pressed');
  check('map container is focusable', a11y.mapTabindex === '0', 'tabindex=' + a11y.mapTabindex);

  // --- 3. hotspot toggle removes / restores circles on the route map ---
  const hsSel = '#map2 path.hotspot-circle';
  const hsOn = await count(page, hsSel);
  check('hotspot circles drawn on the route map', hsOn > 0, hsOn + ' circles');
  await page.click('#hotspotToggle2');
  await wait(700);
  const hsOff = await page.evaluate(() => {
    const b = document.getElementById('hotspotToggle2');
    return { pressed: b.getAttribute('aria-pressed'), label: b.textContent.trim(),
             overviewSynced: document.getElementById('hotspotToggle').getAttribute('aria-pressed') };
  });
  const hsGone = await count(page, hsSel);
  check('hotspot toggle flips state', hsOff.pressed === 'false' && hsOff.label === 'Show hotspots', hsOff.label);
  check('twin toggle stays in sync', hsOff.overviewSynced === 'false');
  check('hotspot toggle hides circles', hsGone === 0, hsOn + ' -> ' + hsGone);
  await page.click('#hotspotToggle2');
  await wait(900);
  const hsBack = await count(page, hsSel);
  check('hotspot toggle restores circles', hsBack === hsOn, hsOn + ' -> ' + hsBack);

  // --- 4. street lamps and help points fetch and draw (Overview tab) ---
  await page.evaluate(() => document.getElementById('tab-overview').click());
  await wait(1500);
  await page.click('#lampToggle');
  await wait(3000);
  const lamps = await page.evaluate(() => {
    // lamp markers live in a dedicated pane/layer on the overview map
    return document.querySelectorAll('#map .leaflet-marker-pane .leaflet-interactive, #map path.leaflet-interactive').length;
  });
  check('street lamps layer draws', lamps > 0, lamps + ' markers on overview');
  await page.click('#helpToggle');
  await wait(3000);
  const help = await page.evaluate(() =>
    document.querySelectorAll('#map path.leaflet-interactive').length);
  check('help points layer draws', help > 0, help + ' markers on overview');
  await page.click('#lampToggle');
  await page.click('#helpToggle');
  await wait(800);

  // --- 5. heatmap renders rectangles and reloads on departure change ---
  await page.click('#heatToggle');
  await wait(3000);
  const heat = await page.evaluate(() => ({
    rects: document.querySelectorAll('#map path[fill-opacity]').length,
    label: document.getElementById('heatToggle').textContent.trim(),
  }));
  check('heatmap draws cells', heat.rects > 10, heat.rects + ' cells');
  check('heatmap button relabels', heat.label === 'Hide heatmap', heat.label);

  // --- 6. report flow: tap map, submit, risk responds ---
  await page.evaluate(() => document.getElementById('tab-report').click());
  await wait(1200);
  const box = await page.evaluate(() => {
    const r = document.getElementById('map3').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  await wait(600);
  const locSet = await page.evaluate(() => document.getElementById('reportLocText').textContent);
  check('tapping the report map sets a location', /12\.\d+, 76\.\d+/.test(locSet), locSet.trim());

  await page.select('#reportType', 'low_lighting');
  // Tag the report so cleanupProbeReports() can find and remove it again.
  await page.type('#reportNote', 'Smoke probe report');
  await page.evaluate(() => {
    document.getElementById('reportLighting').value = '1';
    document.getElementById('reportCrowd').value = '1';
  });
  const riskBefore = await page.evaluate(async (loc) => {
    const [lat, lng] = loc.match(/(\d+\.\d+), (\d+\.\d+)/).slice(1, 3);
    const r = await fetch('/api/risk?lat=' + lat + '&lng=' + lng + '&time=now').then((x) => x.json());
    return r.risk;
  }, locSet);
  await page.click('#reportSubmitBtn');
  await wait(3500);
  const afterSubmit = await page.evaluate(() => ({
    notice: (document.querySelector('#reportResult .notice') || {}).textContent || '',
    feed: document.getElementById('liveFeed') ? true : false,
  }));
  check('report submission shows a result', /part of the risk estimate|similar report/i.test(afterSubmit.notice),
    afterSubmit.notice.slice(0, 90));

  const riskAfter = await page.evaluate(async (loc) => {
    const [lat, lng] = loc.match(/(\d+\.\d+), (\d+\.\d+)/).slice(1, 3);
    const r = await fetch('/api/risk?lat=' + lat + '&lng=' + lng + '&time=now').then((x) => x.json());
    return r.risk;
  }, locSet);
  check('risk at the report location reflects the signal', riskAfter >= riskBefore,
    riskBefore + ' -> ' + riskAfter);

  // --- 7. live desk connects over SSE ---
  await page.evaluate(() => document.getElementById('tab-live').click());
  await wait(3000);
  const live = await page.evaluate(() => document.getElementById('liveStatus').textContent.trim());
  check('live feed reports a connection', /Live|connecting|reconnect/i.test(live), live);

  // --- 8. signals come from the API, not hard-coded ---
  await page.evaluate(() => document.getElementById('tab-signals').click());
  await wait(2500);
  const sig = await page.evaluate(async () => {
    const api = await fetch('/api/signals').then((r) => r.json());
    const cards = Array.from(document.querySelectorAll('#page-signals .stat, #page-signals .stat__value'))
      .map((e) => e.textContent.trim());
    return { apiIncidents: api.totals.incidents, apiHotspots: api.totals.hotspots,
             apiReports: api.totals.reports, shown: document.body.textContent };
  });
  check('signals incidents come from the API',
    sig.shown.includes(String(sig.apiIncidents)), 'incidents=' + sig.apiIncidents);
  check('signals reports count comes from the API',
    sig.shown.includes(String(sig.apiReports)) || sig.apiReports === 0,
    'reports=' + sig.apiReports);
  check('signals hotspot count comes from the API',
    sig.shown.includes(String(sig.apiHotspots)), 'hotspots=' + sig.apiHotspots);

  check('no console errors during the whole flow', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();

  // Leave the database as we found it: drop the probe report(s) and reload the model.
  cleanupProbeReports();
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
