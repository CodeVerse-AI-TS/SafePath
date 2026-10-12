/* Every dropdown renders as the premium floating glass panel, keeps its native
   <select> working underneath, and stays keyboard-accessible and on-screen.
   Regression guard: the panel is styled by public/styles.css and built by
   public/select.js, so a rename on either side silently loses the look. */
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

// The design tokens the panel must use.
const GLASS = { surface: 'rgba(25, 26, 32, 0.94)', border: 'rgba(255, 255, 255, 0.16)', radius: '16px' };

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
  await wait(3000);

  // The wrapper is the native select's parent; the trigger and menu are its
  // following siblings. These helpers match public/select.js's structure.
  const trigOf = (id) => '#%s ~ .custom-select__trigger'.replace('%s', id);
  const menuOf = (id) => '#%s ~ .custom-select__menu'.replace('%s', id);
  const isOpen = (id) => page.evaluate(
    (s) => document.querySelector(s).closest('.custom-select').classList.contains('is-open'), trigOf(id));
  // The panel needs its trigger in view before it can be measured on-screen.
  const bringIntoView = (id) => page.evaluate(
    (s) => document.querySelector(s).scrollIntoView({ block: 'center' }), trigOf(id));

  // --- 1. both native selects are enhanced, and still present ---
  const enhanced = await page.evaluate(() => ({
    depart: !!document.querySelector('#departInput ~ .custom-select__trigger'),
    report: !!document.querySelector('#reportType ~ .custom-select__trigger'),
    departNative: !!document.getElementById('departInput'),
    reportNative: !!document.getElementById('reportType'),
    departHidden: document.getElementById('departInput').classList.contains('report-select--native'),
  }));
  check('departure select is enhanced', enhanced.depart);
  check('report select is enhanced', enhanced.report);
  check('native selects remain in the DOM', enhanced.departNative && enhanced.reportNative);
  check('the native control is hidden from view', enhanced.departHidden);

  // --- 2. the closed panel is faded and out of hit-testing ---
  const closed = await page.evaluate((s) => {
    const c = getComputedStyle(document.querySelector(s));
    return { opacity: c.opacity, visibility: c.visibility, pointerEvents: c.pointerEvents };
  }, menuOf('departInput'));
  check('closed panel is faded, hidden and untouchable',
    closed.opacity === '0' && closed.visibility === 'hidden' && closed.pointerEvents === 'none',
    closed.opacity + '/' + closed.visibility + '/' + closed.pointerEvents);

  // --- 3. open it and check the glass surface ---
  await bringIntoView('departInput');
  await wait(400);
  await page.click(trigOf('departInput'));
  await wait(500);
  const glass = await page.evaluate((s) => {
    const m = document.querySelector(s);
    const c = getComputedStyle(m);
    return {
      open: m.closest('.custom-select').classList.contains('is-open'),
      bg: c.backgroundColor, border: c.borderTopColor, radius: c.borderTopLeftRadius,
      blur: c.backdropFilter, shadow: c.boxShadow, opacity: c.opacity,
      options: m.querySelectorAll('.custom-select__option').length,
      expanded: m.closest('.custom-select').querySelector('.custom-select__trigger').getAttribute('aria-expanded'),
    };
  }, menuOf('departInput'));
  check('clicking the trigger opens the panel', glass.open && glass.expanded === 'true');
  check('panel uses the charcoal glass surface', glass.bg === GLASS.surface, glass.bg);
  check('panel has a thin silver border', glass.border === GLASS.border, glass.border);
  check('panel corners are 16px', glass.radius === GLASS.radius, glass.radius);
  check('panel applies a backdrop blur of 18-24px', /blur\((1[89]|2[0-4])px\)/.test(glass.blur), glass.blur);
  check('panel casts a soft shadow', glass.shadow !== 'none' && /rgba\(0, 0, 0/.test(glass.shadow));
  check('panel is fully opaque when open', glass.opacity === '1', glass.opacity);
  check('every option is rendered', glass.options === 2, glass.options + ' options');

  // --- 4. option colours: default, hover, selected ---
  // Measured before the pointer enters the menu, so nothing is hovered yet.
  const optionColours = await page.evaluate((s) => {
    const menu = document.querySelector(s);
    const opts = menu.querySelectorAll('.custom-select__option');
    const first = menu.querySelector('.custom-select__option:not([aria-selected="true"])');
    const selected = menu.querySelector('.custom-select__option[aria-selected="true"]');
    return {
      text: getComputedStyle(first).color,
      selectedBg: selected ? getComputedStyle(selected).backgroundColor : null,
      selectedText: selected ? getComputedStyle(selected).color : null,
      check: selected ? getComputedStyle(selected, '::after').content : null,
    };
  }, menuOf('departInput'));
  check('default option text is #E5E5E9', optionColours.text === 'rgb(229, 229, 233)', optionColours.text);
  check('selected option uses the silver wash', optionColours.selectedBg === 'rgba(200, 203, 210, 0.15)', optionColours.selectedBg);
  check('selected option text is white', optionColours.selectedText === 'rgb(255, 255, 255)', optionColours.selectedText);
  check('selected option shows a silver checkmark', /✓/.test(optionColours.check || ''), optionColours.check);

  // hover a non-selected option
  const hover = await page.evaluate((s) => {
    const opt = document.querySelectorAll(s + ' .custom-select__option')[1];
    const r = opt.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, menuOf('departInput'));
  await page.mouse.move(hover.x, hover.y);
  await wait(300);
  const hoverStyle = await page.evaluate((s) => {
    const opt = document.querySelectorAll(s + ' .custom-select__option')[1];
    const c = getComputedStyle(opt);
    return { bg: c.backgroundColor, color: c.color };
  }, menuOf('departInput'));
  check('hovered option brightens to the hover wash', hoverStyle.bg === 'rgba(255, 255, 255, 0.09)', hoverStyle.bg);
  check('hovered option text turns platinum white', hoverStyle.color === 'rgb(255, 255, 255)', hoverStyle.color);

  // --- 5. custom chevron, no OS arrow ---
  const chevron = await page.evaluate((s) => {
    const svg = document.querySelector(s + ' .custom-select__chevron');
    return svg ? { tag: svg.tagName.toLowerCase(), dur: getComputedStyle(svg).transitionDuration,
                   rot: getComputedStyle(svg).transform } : null;
  }, trigOf('departInput'));
  check('the chevron is a custom SVG', !!chevron && chevron.tag === 'svg');
  check('the chevron rotates 180deg when open', !!chevron && /matrix\(-1/.test(chevron.rot), chevron && chevron.rot);
  check('the chevron animates smoothly', !!chevron && /0\.22s/.test(chevron.dur), chevron && chevron.dur);

  // --- 6. animation is a ~200ms ease-out fade-and-rise ---
  const motion = await page.evaluate((s) => {
    const c = getComputedStyle(document.querySelector(s));
    return { dur: c.transitionDuration, ease: c.transitionTimingFunction };
  }, menuOf('departInput'));
  const durS = parseFloat(String(motion.dur).split(',')[0]);
  check('panel transition is ~180-220ms', durS >= 0.18 && durS <= 0.22, motion.dur);
  check('panel uses an ease-out curve', /cubic-bezier/.test(motion.ease), motion.ease);

  // --- 7. keyboard: arrows, Enter, Escape, Home, End ---
  await page.focus(trigOf('departInput'));
  await page.keyboard.press('ArrowDown');
  await wait(350);
  check('ArrowDown opens the panel from the keyboard', await isOpen('departInput'));
  await page.keyboard.press('ArrowDown');
  await wait(250);
  const active = await page.evaluate(() =>
    document.querySelector('.custom-select__option.is-active')?.textContent.trim());
  check('ArrowDown moves the active option', /custom time/i.test(active || ''), active);
  await page.keyboard.press('Enter');
  await wait(350);
  const afterEnter = await page.evaluate(() => ({
    value: document.getElementById('departInput').value,
    open: document.querySelector('#departInput ~ .custom-select__trigger').closest('.custom-select').classList.contains('is-open'),
    focus: document.activeElement.id,
  }));
  check('Enter selects the option', afterEnter.value === 'custom', afterEnter.value);
  check('Enter closes the panel', !afterEnter.open);
  check('focus stays on the trigger', afterEnter.focus === 'departInput-trigger', afterEnter.focus);
  check('selecting drives the existing app logic (custom time field appears)',
    await page.evaluate(() => document.getElementById('customTimeField').hidden === false));

  await page.keyboard.press('ArrowDown');
  await wait(300);
  await page.keyboard.press('Escape');
  await wait(300);
  check('Escape closes without changing the value',
    !(await isOpen('departInput')) &&
    (await page.evaluate(() => document.getElementById('departInput').value)) === 'custom');

  await page.keyboard.press('ArrowDown');
  await wait(300);
  await page.keyboard.press('End');
  await wait(250);
  check('End moves to the last option',
    /custom time/i.test(await page.evaluate(() => document.querySelector('.custom-select__option.is-active')?.textContent.trim()) || ''));
  await page.keyboard.press('Home');
  await wait(250);
  check('Home moves to the first option',
    /leave now/i.test(await page.evaluate(() => document.querySelector('.custom-select__option.is-active')?.textContent.trim()) || ''));
  await page.keyboard.press('Escape');
  await wait(300);

  // --- 8. click outside closes ---
  await page.click(trigOf('departInput'));
  await wait(400);
  await page.mouse.click(20, 20);
  await wait(400);
  check('clicking outside closes the panel', !(await isOpen('departInput')));

  // --- 9. the native select still drives the component (test/script safety) ---
  await page.select('#departInput', 'now');
  await wait(300);
  const nativeSync = await page.evaluate(() => ({
    value: document.getElementById('departInput').value,
    shown: document.querySelector('#departInput ~ .custom-select__trigger .custom-select__value').textContent,
  }));
  check('the native select still works and syncs the trigger',
    nativeSync.value === 'now' && /leave now/i.test(nativeSync.shown), nativeSync.value + '/' + nativeSync.shown);

  // --- 10. the panel flips up and stays inside the viewport ---
  await page.evaluate((s) => {
    const w = document.querySelector(s);
    // Park the trigger low in the viewport so a drop-down panel would overflow.
    window.scrollTo(0, w.getBoundingClientRect().top + window.scrollY - (window.innerHeight - 90));
  }, trigOf('departInput'));
  await wait(400);
  await page.click(trigOf('departInput'));
  await wait(500);
  const placed = await page.evaluate((s) => {
    const menu = document.querySelector(s);
    const r = menu.getBoundingClientRect();
    return {
      dropUp: menu.classList.contains('custom-select__menu--up'),
      inside: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
      top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight,
    };
  }, menuOf('departInput'));
  check('a low trigger flips the panel upward', placed.dropUp, 'dropUp=' + placed.dropUp);
  check('the panel stays inside the viewport', placed.inside,
    placed.top + '-' + placed.bottom + ' of ' + placed.vh);
  await page.keyboard.press('Escape');
  await wait(300);

  // --- 11. the report select uses the same glass treatment ---
  await page.evaluate(() => document.getElementById('tab-report').click());
  await wait(1200);
  await bringIntoView('reportType');
  await wait(400);
  await page.click(trigOf('reportType'));
  await wait(500);
  const report = await page.evaluate((s) => {
    const m = document.querySelector(s);
    const c = getComputedStyle(m);
    const r = m.getBoundingClientRect();
    return {
      bg: c.backgroundColor, radius: c.borderTopLeftRadius, blur: c.backdropFilter,
      options: m.querySelectorAll('.custom-select__option').length,
      inside: r.top >= 0 && r.bottom <= window.innerHeight,
    };
  }, menuOf('reportType'));
  check('the report dropdown uses the same glass surface', report.bg === GLASS.surface, report.bg);
  check('the report dropdown matches the corner radius', report.radius === GLASS.radius, report.radius);
  check('the report dropdown blurs its backdrop', /blur\(2[0-4]px\)/.test(report.blur), report.blur);
  check('all report options are listed', report.options === 5, report.options + ' options');
  check('the report panel stays inside the viewport', report.inside);
  // choose an option and confirm the native value follows
  await page.evaluate((s) => document.querySelectorAll(s + ' .custom-select__option')[2].click(), menuOf('reportType'));
  await wait(300);
  check('choosing a report option updates the native select',
    (await page.evaluate(() => document.getElementById('reportType').value)) === 'unusual_activity');

  // --- 12. the From/To autocomplete uses the same glass panel ---
  await page.evaluate(() => document.getElementById('tab-overview').click());
  await wait(1200);
  await page.evaluate(() => document.getElementById('fromInput').closest('.ac').scrollIntoView({ block: 'center' }));
  await wait(400);
  await page.click('#fromInput');
  await page.type('#fromInput', 'Mysore');
  await page.waitForFunction(() => {
    const l = document.getElementById('fromInputListbox');
    return l && !l.hidden && l.children.length > 0;
  }, { timeout: 20000 }).catch(() => {});
  await wait(800);
  const ac = await page.evaluate(() => {
    const list = document.getElementById('fromInputListbox');
    const c = getComputedStyle(list);
    const r = list.getBoundingClientRect();
    return {
      rows: list.querySelectorAll('.ac__row').length,
      bg: c.backgroundColor, radius: c.borderTopLeftRadius, blur: c.backdropFilter,
      border: c.borderTopColor, inside: r.top >= 0 && r.bottom <= window.innerHeight,
    };
  });
  check('the autocomplete panel uses the same glass surface', ac.bg === GLASS.surface, ac.bg);
  check('the autocomplete panel matches the border and radius',
    ac.border === GLASS.border && ac.radius === GLASS.radius, ac.border + ' / ' + ac.radius);
  check('the autocomplete panel blurs its backdrop', /blur\(2[0-4]px\)/.test(ac.blur), ac.blur);
  check('autocomplete suggestions are rendered', ac.rows > 0, ac.rows + ' rows');

  // The list toggles the `hidden` attribute; a bare display:none would kill the
  // fade, so confirm the panel really is mid-transition shortly after opening.
  const acAnim = await page.evaluate(() => {
    const l = document.getElementById('fromInputListbox');
    const c = getComputedStyle(l);
    return { display: c.display, dur: c.transitionDuration, ease: c.transitionTimingFunction, transform: c.transform };
  });
  check('the autocomplete panel keeps its fade animation (hidden does not force display:none)',
    acAnim.display !== 'none' && parseFloat(String(acAnim.dur).split(',')[0]) >= 0.18, acAnim.display + ' / ' + acAnim.dur);
  check('the autocomplete panel uses the same ease-out curve', /cubic-bezier/.test(acAnim.ease), acAnim.ease);

  // A closed list must be invisible and untouchable even though it is laid out.
  await page.evaluate(() => {
    document.getElementById('fromInput').closest('.ac').classList.remove('is-open');
  });
  await wait(350); // let the fade-out finish before measuring
  const acClosed = await page.evaluate(() => {
    const c = getComputedStyle(document.getElementById('fromInputListbox'));
    return { opacity: c.opacity, visibility: c.visibility, pointerEvents: c.pointerEvents };
  });
  check('a closed autocomplete panel is invisible and untouchable',
    acClosed.opacity === '0' && acClosed.visibility === 'hidden' && acClosed.pointerEvents === 'none',
    acClosed.opacity + '/' + acClosed.visibility + '/' + acClosed.pointerEvents);

  // --- 13. mobile: panels are usable and touch targets stay comfortable ---
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await wait(600);
  await bringIntoView('departInput');
  await wait(400);
  await page.tap(trigOf('departInput'));
  await wait(500);
  const mobile = await page.evaluate((s) => {
    const m = document.querySelector(s);
    const r = m.getBoundingClientRect();
    const opt = m.querySelector('.custom-select__option');
    return {
      open: m.closest('.custom-select').classList.contains('is-open'),
      inside: r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight,
      optH: opt ? Math.round(opt.getBoundingClientRect().height) : 0,
      triggerH: Math.round(m.closest('.custom-select').querySelector('.custom-select__trigger').getBoundingClientRect().height),
    };
  }, menuOf('departInput'));
  check('mobile tap opens the panel', mobile.open);
  check('the panel fits the mobile viewport', mobile.inside);
  check('mobile options are comfortable touch targets', mobile.optH >= 44, mobile.optH + 'px');
  check('the trigger meets the 44px touch minimum', mobile.triggerH >= 44, mobile.triggerH + 'px');

  check('no console errors during the whole flow', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
