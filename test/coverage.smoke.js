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
  results.push({ name, ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
}

async function plan(page, from, to, mode) {
  // Planning always starts from the Overview tab, which owns the form.
  await page.evaluate(() => {
    document.getElementById('tab-overview').click();
    document.getElementById('fromInput').value = '';
    document.getElementById('toInput').value = '';
  });
  await new Promise((r) => setTimeout(r, 250));
  await page.type('#fromInput', from);
  await page.type('#toInput', to);
  if (mode) await page.click(`#modeCard .seg button[data-mode="${mode}"]`);
  await page.click('#planBtn');
  await page.waitForFunction(() => {
    const c = document.getElementById('routeCards');
    return c.querySelectorAll('.route').length > 0 || c.querySelector('.notice--err');
  }, { timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  return page.evaluate(() => ({
    roles: Array.from(document.querySelectorAll('#routeCards .route')).map((c) => c.dataset.role),
    notices: Array.from(document.querySelectorAll('#routeCards .notice')).map((n) => n.textContent),
    scores: Array.from(document.querySelectorAll('#routeCards .route__score')).map((s) => s.textContent.trim()),
    coverageRect: document.querySelectorAll('#map2 path[stroke="#5aa9e6"]').length,
    firstReason: (document.querySelector('#whyList li') || {}).textContent || '',
  }));
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + e));
  await page.setViewport({ width: 1280, height: 900 });
  // Simulate a returning visitor: pre-set the one-time welcome flag so this
  // test starts on the app itself. The card's own behaviour is covered by
  // test/auth.smoke.js.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('safepath.welcome.seen', '1'); } catch { /* ignore */ }
  });
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2000));

  // 1. Uncovered destination
  const far = await plan(page, 'Mysore Palace, Mysuru', 'Mandya');
  // Outside the covered area the app must NOT claim a route is "safest": that
  // would present an unranked guess as a safety recommendation. Two roles are
  // offered instead (balanced + fastest) and the missing data is stated.
  check('uncovered plan offers routes but no "safest" claim',
    far.roles.length >= 2 && !far.roles.includes('safest'), far.roles.join(','));
  check('uncovered plan warns about no data',
    far.notices.some((n) => /no safety data/i.test(n)), far.notices[0] ? far.notices[0].slice(0, 80) : '');
  check('uncovered routes show no score', far.scores.every((s) => /NO DATA|—/.test(s)), far.scores.join(' | '));
  check('why-panel explains the missing data', /no safety data/i.test(far.firstReason), far.firstReason.slice(0, 90));

  // 2. Long walk warning
  check('long walk warning shown', far.notices.some((n) => /very long walking route/i.test(n)));

  // 3. Covered in-city route with a coverage rectangle
  const city = await plan(page, 'Mysore Palace, Mysuru', 'Kuvempunagar, Mysuru');
  check('city route is scored', city.scores.some((s) => /\d/.test(s)), city.scores.join(' | '));
  check('coverage rectangle drawn', city.coverageRect > 0, city.coverageRect + ' path(s)');

  // 4. Changing departure time changes the score in a sensible direction
  const setDepart = async (val) => {
    await page.evaluate((v) => {
      document.getElementById('tab-overview').click();
      const sel = document.getElementById('departInput');
      sel.value = 'custom'; sel.dispatchEvent(new Event('change'));
      const dt = document.getElementById('customTimeInput');
      dt.value = v; dt.dispatchEvent(new Event('change'));
    }, val);
    await new Promise((r) => setTimeout(r, 250));
  };
  const scores = async () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#routeCards .route__score')).map((s) => s.textContent.trim()));

  await setDepart('2026-10-28T14:00');
  await page.click('#planBtn');
  await new Promise((r) => setTimeout(r, 12000));
  const aft = await scores();
  await setDepart('2026-10-28T23:00');
  await page.click('#planBtn');
  await new Promise((r) => setTimeout(r, 12000));
  const night = await scores();
  const num = (arr) => arr.map((s) => parseFloat(s)).filter((n) => !isNaN(n));
  const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  check('night scores lower than afternoon', avg(num(night)) < avg(num(aft)),
    'afternoon ' + avg(num(aft)).toFixed(1) + ' vs night ' + avg(num(night)).toFixed(1));

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
