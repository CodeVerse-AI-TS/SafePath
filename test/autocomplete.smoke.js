'use strict';
/**
 * Autocomplete smoke test - drives a real headless browser.
 *
 * Covers the acceptance criteria that need a DOM:
 *   - typing "Maje" surfaces Majestic and friends, quickly
 *   - one request per typing pause, and no stale results
 *   - keyboard-only selection
 *   - selecting a suggestion skips re-geocoding (the route request carries coords)
 *   - static rows (current location / recents / saved) before any typing
 *   - coordinate paste becomes a suggestion
 *   - the 320px layout keeps 44px rows
 *
 * Requires the server to be running (BASE=... to point elsewhere).
 * Skips cleanly when puppeteer-core or Chromium is unavailable.
 */

const path = require('node:path');

const BASE = process.env.BASE || 'http://localhost:12000';

let puppeteer = null;
let launchError = null;
try {
  puppeteer = require('puppeteer-core');
} catch (err) {
  launchError = err;
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const fs = require('node:fs');
  const candidates = [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/brave-browser', '/usr/bin/microsoft-edge',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return null;
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name + (detail ? ' — ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Switch to the Overview tab and wait until the page really has a laid-out box.
 * Two things race a plain "click then sleep": the fade-up on <main> runs for
 * 500ms, and the route search from the previous step lands asynchronously and
 * switches to the Route tab, hiding Overview again. Either way the map search
 * ends up 0x0, which Puppeteer reports as "Node is either not clickable or not
 * an Element". So click, then require Overview to stay visible for a sustained
 * window, re-clicking if the late route response steals the tab back.
 */
async function showOverview(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.click('#tab-overview');
    let heldFor = 0;
    while (Date.now() < deadline && heldFor < 900) {
      const visible = await page.evaluate(() => {
        const p = document.getElementById('page-overview');
        if (!p || p.hidden) return false;
        const r = p.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!visible) break;
      heldFor += 100;
      await wait(100);
    }
    if (heldFor >= 900) return;
  }
}

/**
 * Wait until a listbox actually holds selectable option rows (or a non-loading
 * status). The upstream provider is occasionally slow, so poll rather than
 * sleeping a fixed time.
 */
async function waitForOptions(page, listboxId, timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate((id) => {
      const l = document.getElementById(id);
      if (!l) return null;
      const rows = Array.from(l.querySelectorAll('.ac__row[role="option"]'));
      const status = l.querySelector('.ac__row--status');
      return {
        hidden: l.hidden,
        options: rows.map((r) => r.textContent.trim()),
        statusText: status ? status.textContent.trim() : null,
      };
    }, listboxId);
    if (last && !last.hidden && (last.options.length > 0
      || (last.statusText && !/Searching/i.test(last.statusText)))) return last;
    await wait(120);
  }
  return last;
}

(async () => {
  if (!puppeteer) {
    console.log('SKIP  puppeteer-core is not installed (' + (launchError && launchError.message) + ')');
    console.log('      npm install --save-dev puppeteer-core');
    process.exit(0);
  }
  const chrome = findChrome();
  if (!chrome) {
    console.log('SKIP  no Chromium/Chrome binary found. Set CHROME_PATH to run these checks.');
    process.exit(0);
  }

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

    // Record every suggest request so we can count them and check for staleness.
    const suggestRequests = [];
    const geocodeRequests = [];
    // Requests made through a controlling service worker never reach a
    // page-level interceptor, which would make the request counts below
    // silently wrong. This suite measures API calls, not offline caching.
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/api/places/suggest')) {
        suggestRequests.push({ url: u, t: Date.now(), q: new URL(u).searchParams.get('q') });
      }
      // Deterministic reverse geocode, so the "current location" label does
      // not depend on the network or the upstream provider being up.
      if (u.includes('/api/geocode?')) {
        geocodeRequests.push(u);
        const q = new URL(u).searchParams.get('q') || '';
        const [lat, lng] = q.split(',').map(Number);
        const label = isFinite(lat) && isFinite(lng)
          ? `Vani Vilas (${lat.toFixed(5)}, ${lng.toFixed(5)})` : 'Unknown';
        req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ label, short_label: label, lat, lng, source: 'coordinates' }),
        });
        return;
      }
      req.continue();
    });

  // Simulate a returning visitor: pre-set the one-time welcome flag so this
  // test starts on the app itself. The card's own behaviour is covered by
  // test/auth.smoke.js.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('safepath.welcome.seen', '1'); } catch { /* ignore */ }
  });

  // A fixed device position, so choosing "Current location" is repeatable.
  await page.evaluateOnNewDocument(() => {
    const pos = { coords: { latitude: 12.3051, longitude: 76.6551, accuracy: 8 }, timestamp: Date.now() };
    navigator.geolocation.getCurrentPosition = (ok) => setTimeout(() => ok(pos), 0);
  });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#fromInput', { timeout: 15000 });
    await wait(900);

    const sel = (s) => page.evaluate((x) => {
      const el = document.querySelector(x);
      if (!el) return null;
      return {
        hidden: el.hidden,
        rows: Array.from(el.querySelectorAll('.ac__row')).map((r) => ({
          text: r.textContent.trim(),
          role: r.getAttribute('role'),
          selected: r.getAttribute('aria-selected'),
          minH: r.getBoundingClientRect().height,
        })),
        html: el.innerHTML,
      };
    }, s);

    const inputState = (s) => page.evaluate((x) => {
      const el = document.querySelector(x);
      return {
        value: el.value,
        role: el.getAttribute('role'),
        expanded: el.getAttribute('aria-expanded'),
        controls: el.getAttribute('aria-controls'),
        active: el.getAttribute('aria-activedescendant'),
        lat: el.dataset.lat || null,
        lng: el.dataset.lng || null,
      };
    }, s);

    /* ---------------- 1. ARIA wiring ---------------- */
    console.log('\n1. Combobox ARIA wiring');
    const aria = await inputState('#fromInput');
    check('From input is role=combobox', aria.role === 'combobox', 'role=' + aria.role);
    check('aria-expanded starts false', aria.expanded === 'false', 'expanded=' + aria.expanded);
    check('aria-controls points at the listbox', !!aria.controls, 'controls=' + aria.controls);
    const listRole = await page.evaluate(() => {
      const l = document.getElementById('fromInputListbox');
      return l ? l.getAttribute('role') : null;
    });
    check('listbox has role=listbox', listRole === 'listbox', 'role=' + listRole);

    /* ---------------- 2. static rows before typing ---------------- */
    console.log('\n2. Rows shown before any typing');
    await page.focus('#fromInput');
    await wait(400);
    const staticBox = await sel('#fromInputListbox');
    check('dropdown opens on focus', staticBox && staticBox.hidden === false);
    const staticText = (staticBox.rows || []).map((r) => r.text).join(' | ');
    check('offers "Current location"', /Current location/.test(staticText), staticText.slice(0, 90));
    check('offers saved places (Home)', /Home/.test(staticText));
    check('every row is at least 44px tall',
      (staticBox.rows || []).filter((r) => r.role === 'option').every((r) => r.minH >= 44),
      'min=' + Math.min(...(staticBox.rows || []).filter((r) => r.role === 'option').map((r) => r.minH)));

    /* -------- 2b. "Current location" shows where you actually are -------- */
    // Regression: choosing this row used to leave the literal words
    // "Current location" in the field (and the map-centre coordinates).
    console.log('\n2b. "Current location" resolves to a real place name');
    const curRow = (staticBox.rows || []).findIndex((r) => /Current location/.test(r.text));
    check('the static list contains the "Current location" row', curRow >= 0, 'index=' + curRow);
    await page.evaluate((i) => {
      const li = document.querySelectorAll('#fromInputListbox .ac__row')[i];
      if (li) li.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    }, curRow);
    await wait(700);
    const curState = await inputState('#fromInput');
    check('the field no longer reads "Current location"',
      curState.value !== 'Current location' && !/^Current location$/.test(curState.value),
      'value="' + curState.value + '"');
    check('the field shows the resolved place name',
      /Vani Vilas/.test(curState.value), 'value="' + curState.value + '"');
    check('the resolved coordinates are the device position',
      curState.lat === '12.3051' && curState.lng === '76.6551',
      'lat=' + curState.lat + ' lng=' + curState.lng);
    check('a reverse geocode was requested for the device position',
      geocodeRequests.some((u) => /12\.3051/.test(decodeURIComponent(u))),
      geocodeRequests.length + ' geocode request(s)');

    // The round "use my location" button must show the place name too, not the
    // literal words "Current location".
    await page.evaluate(() => {
      const i = document.getElementById('fromInput');
      i.value = ''; delete i.dataset.lat; delete i.dataset.lng;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => document.getElementById('useLocationBtn').click());
    await wait(700);
    const btnState = await inputState('#fromInput');
    check('the location button fills the field with a place name',
      /Vani Vilas/.test(btnState.value) && !/^Current location$/.test(btnState.value),
      'value="' + btnState.value + '"');
    check('the location button stores the device coordinates',
      btnState.lat === '12.3051' && btnState.lng === '76.6551',
      'lat=' + btnState.lat + ' lng=' + btnState.lng);

    /* ---------------- 3. coordinate paste ---------------- */
    console.log('\n3. Pasting coordinates');
    await page.click('#fromInput', { clickCount: 3 });
    await page.type('#fromInput', '12.9716, 77.5946', { delay: 12 });
    await wait(500);
    const coordBox = await sel('#fromInputListbox');
    check('a coordinate pair becomes a suggestion',
      /12\.9716/.test((coordBox.rows || []).map((r) => r.text).join(' ')),
      (coordBox.rows || [])[0] ? coordBox.rows[0].text.slice(0, 60) : 'no rows');

    /* ---------------- 4. debounce: one request per pause ---------------- */
    console.log('\n4. Debounce and request count');
    suggestRequests.length = 0;
    await page.click('#fromInput', { clickCount: 3 });
    await page.evaluate(() => { document.querySelector('#fromInput').value = ''; });
    // Type a fast burst: 6 keystrokes with no pause should produce one request.
    await page.type('#fromInput', 'Majest', { delay: 40 });
    await wait(1400);
    const burstCount = suggestRequests.filter((r) => (r.q || '').length >= 2).length;
    check('a fast burst of keystrokes makes one request, not six', burstCount === 1, burstCount + ' request(s)');

    /* ---------------- 5. "Maje" -> Majestic ---------------- */
    console.log('\n5. Typing "Maje"');
    suggestRequests.length = 0;
    await page.click('#fromInput', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    const t0 = Date.now();
    await page.type('#fromInput', 'Maje', { delay: 35 });
    // Poll until results appear so we can measure latency honestly.
    let majeBox = null;
    for (let i = 0; i < 40; i++) {
      majeBox = await sel('#fromInputListbox');
      if (majeBox && majeBox.rows.some((r) => r.role === 'option')) break;
      await wait(100);
    }
    const elapsed = Date.now() - t0;
    const majeText = (majeBox.rows || []).map((r) => r.text).join(' | ');
    check('"Maje" suggests Majestic', /Majestic/i.test(majeText), majeText.slice(0, 120));
    check('results arrive within ~1.5s of typing', elapsed < 1500, elapsed + ' ms');
    check('at most 6 suggestions',
      (majeBox.rows || []).filter((r) => r.role === 'option').length <= 6,
      (majeBox.rows || []).filter((r) => r.role === 'option').length + ' rows');

    /* ---------------- 6. highlight ---------------- */
    console.log('\n6. Matched text is highlighted');
    const markCount = await page.evaluate(() =>
      document.querySelectorAll('#fromInputListbox .ac__mark').length);
    check('the matched characters are wrapped in a <mark>', markCount > 0, markCount + ' highlight(s)');
    const markText = await page.evaluate(() => {
      const m = document.querySelector('#fromInputListbox .ac__mark');
      return m ? m.textContent : null;
    });
    check('the highlighted text is the typed prefix', /^maje/i.test(markText || ''), 'mark="' + markText + '"');

    /* ---------------- 7. safety hint ---------------- */
    console.log('\n7. Safety hint on a destination');
    await page.click('#toInput', { clickCount: 3 });
    await page.type('#toInput', 'Kuvempunagar', { delay: 30 });
    await waitForOptions(page, 'toInputListbox');
    const toBox = await sel('#toInputListbox');
    const toHtml = toBox.html || '';
    check('a safety chip is shown on destination suggestions',
      /ac__safety/.test(toHtml),
      (toHtml.match(/ac__safety[^"]*"[^>]*>([^<]+)/) || [])[1] || 'none');

    /* ---------------- 8. keyboard-only selection ---------------- */
    console.log('\n8. Keyboard-only selection');
    await page.click('#fromInput', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type('#fromInput', 'Maje', { delay: 30 });
    await waitForOptions(page, 'fromInputListbox');
    await page.keyboard.press('ArrowDown');
    await wait(150);
    const afterDown = await inputState('#fromInput');
    check('ArrowDown sets aria-activedescendant',
      !!afterDown.active, 'active=' + afterDown.active);
    await page.keyboard.press('Enter');
    await wait(400);
    const chosen = await inputState('#fromInput');
    const closed = await sel('#fromInputListbox');
    check('Enter selects the active row and fills the field',
      /maje/i.test(chosen.value), 'value="' + chosen.value + '"');
    check('the dropdown closes after selection', closed.hidden === true);
    check('the chosen place stores its coordinates (no re-geocode needed)',
      chosen.lat != null && chosen.lng != null, 'lat=' + chosen.lat + ' lng=' + chosen.lng);

    /* ---------------- 9. Escape ---------------- */
    console.log('\n9. Escape closes the dropdown');
    await page.focus('#toInput');
    await wait(300);
    await page.keyboard.press('Escape');
    await wait(200);
    const escBox = await sel('#toInputListbox');
    check('Escape closes the dropdown', escBox.hidden === true);

    /* ---------------- 10. selection skips geocoding ---------------- */
    console.log('\n10. Route search uses the stored coordinates');
    let routeBody = null;
    let routeCalls = 0;
    page.on('request', (req) => {
      if (req.url().includes('/api/routes') && req.method() === 'POST') {
        routeCalls++;
        try { routeBody = JSON.parse(req.postData() || '{}'); } catch { /* ignore */ }
      }
    });

    // Fill To from the dropdown, then press Enter a second time to plan.
    await page.click('#toInput', { clickCount: 3 });
    await page.type('#toInput', 'Kuvempunagar', { delay: 30 });
    await waitForOptions(page, 'toInputListbox');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await wait(500);
    check('picking a suggestion with Enter does not start a route search on its own',
      routeCalls === 0, routeCalls + ' route call(s) after selection');

    await page.keyboard.press('Enter');
    await wait(8000);
    check('a second Enter starts the route search',
      routeCalls >= 1, routeCalls + ' route call(s)');
    check('the route request sends coordinates for both ends',
      routeBody && routeBody.from && typeof routeBody.from === 'object' && typeof routeBody.from.lat === 'number'
      && routeBody.to && typeof routeBody.to.lat === 'number',
      routeBody ? JSON.stringify(routeBody.from) + ' -> ' + JSON.stringify(routeBody.to) : 'no /api/routes request seen');

    /* ---------------- 11. map overlay search ---------------- */
    console.log('\n11. Map overlay search');
    // The route search in step 10 switches to the Safe route tab, which hides
    // the Overview page that owns #mapSearchInput. Return to Overview first, or
    // this click has nothing laid out to hit.
    await showOverview(page);
    const mapSearch = await page.evaluate(() => {
      const el = document.getElementById('mapSearchInput');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { exists: true, role: el.getAttribute('role'), w: r.width, h: r.height };
    });
    check('the map overlay has a search field', mapSearch && mapSearch.exists);
    check('the overlay search is also a combobox', mapSearch.role === 'combobox', 'role=' + mapSearch.role);
    await page.click('#mapSearchInput', { clickCount: 3 });
    await page.type('#mapSearchInput', 'Mysore Pal', { delay: 30 });
    await waitForOptions(page, 'mapSearchInputListbox');
    const mapBox = await sel('#mapSearchInputListbox');
    check('the overlay search returns suggestions',
      /Mysore|Palace/i.test((mapBox.rows || []).map((r) => r.text).join(' ')),
      (mapBox.rows || []).slice(0, 2).map((r) => r.text).join(' | ').slice(0, 90));

    /* ---------------- 12. 320px layout ---------------- */
    console.log('\n12. 320px layout');
    // The route search above switched to the Safe route tab, which hides the
    // Overview page (and therefore the From field). Go back before measuring.
    await showOverview(page);
    await page.setViewport({ width: 320, height: 640 });
    await wait(700);
    // Type via the DOM: on a 320px viewport the on-screen layout can put the
    // field under an overlay, and this check is about layout, not clicking.
    await page.evaluate(() => {
      const el = document.querySelector('#fromInput');
      el.focus();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.value = 'Maje';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForOptions(page, 'fromInputListbox');
    const small = await page.evaluate(() => {
      const l = document.getElementById('fromInputListbox');
      const rows = Array.from(l.querySelectorAll('.ac__row[role="option"]'));
      const r = l.getBoundingClientRect();
      return {
        hidden: l.hidden,
        rowH: rows.map((x) => x.getBoundingClientRect().height),
        right: r.right, left: r.left, width: window.innerWidth,
        scrollable: l.scrollHeight > l.clientHeight,
      };
    });
    check('dropdown is visible at 320px', small.hidden === false);
    check('rows stay at least 44px at 320px',
      small.rowH.length > 0 && small.rowH.every((h) => h >= 44),
      'min=' + (small.rowH.length ? Math.min(...small.rowH) : 'n/a'));
    check('dropdown does not overflow the viewport horizontally',
      small.left >= -1 && small.right <= small.width + 1,
      `left=${Math.round(small.left)} right=${Math.round(small.right)} vw=${small.width}`);

    /* ---------------- 13. no stale results ---------------- */
    console.log('\n13. No stale results after changing the query');
    await page.setViewport({ width: 1280, height: 900 });
    await page.click('#fromInput', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type('#fromInput', 'Kuvempunagar', { delay: 25 });
    await wait(150);
    // Immediately replace with something unrelated; the older response must not win.
    await page.click('#fromInput', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type('#fromInput', 'Vijayanagar', { delay: 25 });
    await waitForOptions(page, 'fromInputListbox');
    const finalBox = await sel('#fromInputListbox');
    const finalText = (finalBox.rows || []).map((r) => r.text).join(' | ');
    check('the dropdown shows results for the latest query only',
      /Vijayanagar|Vijaya/i.test(finalText) || finalText.trim() === '',
      finalText.slice(0, 110));
    check('no "Kuvempunagar" result leaked in from the abandoned query',
      !/Kuvempunagar/i.test(finalText), finalText.slice(0, 110));

    /* -------- 14. a dismissed dropdown stays dismissed -------- */
    // Regression: close() must invalidate an in-flight search. Otherwise a slow
    // geocode response lands after Escape and re-opens the panel the user shut.
    console.log('\n14. Dismissed dropdown stays dismissed');
    const acOpen = () => page.evaluate(() =>
      document.getElementById('fromInput').closest('.ac').classList.contains('is-open'));

    await page.evaluate(() => {
      const i = document.getElementById('fromInput');
      i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#fromInput');
    await page.type('#fromInput', 'Mysore Palace', { delay: 20 });
    await wait(120);
    await page.keyboard.press('Escape');
    check('Escape closes the dropdown immediately', !(await acOpen()));
    await wait(4000); // let any in-flight response land
    check('a late response does not re-open the dropdown', !(await acOpen()));

    await page.evaluate(() => {
      const i = document.getElementById('fromInput');
      i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#fromInput');
    await page.type('#fromInput', 'Cubbon Park', { delay: 20 });
    await wait(120);
    await page.mouse.click(15, 400); // outside tap
    await wait(4000);
    check('a late response does not re-open after an outside click', !(await acOpen()));

    // A normal search must still open and list results after all that.
    await page.evaluate(() => {
      const i = document.getElementById('fromInput');
      i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#fromInput');
    await page.type('#fromInput', 'Mysore', { delay: 20 });
    await waitForOptions(page, 'fromInputListbox');
    check('searching still opens the dropdown with results',
      (await acOpen()) && (await page.evaluate(() =>
        document.getElementById('fromInputListbox').querySelectorAll('.ac__row').length)) > 0);

    /* ---------------- 15. console clean ---------------- */
    console.log('\n15. Console');
    const realErrors = errors.filter((e) => !/favicon|tile|OpenStreetMap|net::ERR/i.test(e));
    check('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

    console.log(`\n${pass} passed, ${fail} failed\n`);
    await browser.close();
    process.exit(fail ? 1 : 0);
  } catch (err) {
    console.error('\nAutocomplete smoke run crashed:', err.message);
    try { await browser.close(); } catch { /* ignore */ }
    process.exit(1);
  }
})();
