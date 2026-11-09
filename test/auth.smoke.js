/**
 * SafePath — accounts & emergency smoke test
 * ---------------------------------------------------------------------------
 * Drives the real public/auth.js and public/auth-ui.js in a browser.
 *
 * The ONLY thing stubbed is the Firebase SDK itself: requests to
 * gstatic.com/firebasejs/* are intercepted and answered with small ES modules
 * that implement the Firebase API surface those files use. Everything under
 * test — validation, escaping, contact CRUD, link building, sign-in/out
 * rendering, guest fallbacks — is the real application code.
 *
 *   node test/auth.smoke.js            # against localhost:3000
 *   BASE=http://localhost:12000 node test/auth.smoke.js
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

/* ------------------------------------------------------------------ stubs */
// A tiny in-memory Firestore + Auth. Enough to exercise the app's real code.
const STUB_APP = `
export function initializeApp(cfg) { return { name: '[stub]', options: cfg }; }
`;

const STUB_AUTH = `
let currentUser = null;
const listeners = new Set();
export function getAuth() { return {}; }
export function onAuthStateChanged(_auth, cb) { listeners.add(cb); cb(currentUser); return () => listeners.delete(cb); }
function setUser(u) { currentUser = u; listeners.forEach((cb) => cb(currentUser)); }
export class GoogleAuthProvider {}
export async function createUserWithEmailAndPassword(_a, email, password) {
  if (password.length < 6) { const e = new Error('weak'); e.code = 'auth/weak-password'; throw e; }
  setUser({ uid: 'uid-' + email, email, displayName: '', photoURL: '' });
  return { user: currentUser };
}
export async function signInWithEmailAndPassword(_a, email, password) {
  if (password === 'wrong') { const e = new Error('bad'); e.code = 'auth/wrong-password'; throw e; }
  setUser({ uid: 'uid-' + email, email, displayName: 'Test User', photoURL: '' });
  return { user: currentUser };
}
export async function signInWithPopup() {
  setUser({ uid: 'uid-google', email: 'g@example.com', displayName: 'Google User', photoURL: '' });
  return { user: currentUser };
}
export async function sendPasswordResetEmail() { return true; }
export async function signOut() { setUser(null); }
export async function deleteUser() { setUser(null); }
export function __setUser(u) { setUser(u); }
export function __getAuth() { return { get currentUser() { return currentUser; } }; }
`;

const STUB_FIRESTORE = `
const store = new Map(); // "uid/col" -> Map(id -> data)
let seq = 0;
const key = (path) => path.join('/');
export function getFirestore() { return {}; }
export function serverTimestamp() { return new Date().toISOString(); }
export function doc(_db, ...path) { return { __doc: true, path }; }
export function collection(_db, ...path) { return { __col: true, path }; }
function bucket(path) { const k = key(path); if (!store.has(k)) store.set(k, new Map()); return store.get(k); }
export async function addDoc(col, data) {
  const id = 'doc' + (++seq);
  bucket(col.path).set(id, { ...data });
  return { id };
}
export async function getDocs(col) {
  const b = bucket(col.path);
  return { docs: [...b.entries()].map(([id, data]) => ({ id, data: () => ({ ...data }), ref: { path: [...col.path, id] } })) };
}
export async function updateDoc(ref, data) {
  const b = bucket(ref.path.slice(0, -1));
  const id = ref.path[ref.path.length - 1];
  b.set(id, { ...(b.get(id) || {}), ...data });
  return true;
}
export async function deleteDoc(ref) {
  const b = bucket(ref.path.slice(0, -1));
  b.delete(ref.path[ref.path.length - 1]);
  return true;
}
export function __reset() { store.clear(); seq = 0; }
`;

const STUB_CONFIG = `window.SAFEPATH_FIREBASE = { apiKey: 'AIzaStub', authDomain: 'stub.firebaseapp.com', projectId: 'stub-project', storageBucket: 'stub.appspot.com', messagingSenderId: '1', appId: '1:1:web:1' };
window.SAFEPATH_FIRESTORE_REGION = '';`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  // The real gstatic CDN sends permissive CORS headers; an intercepted
  // response must do the same or the browser refuses the cross-origin module.
  const CORS = { 'Access-Control-Allow-Origin': '*' };
  const serve = (req, body) => req.respond({
    status: 200, contentType: 'application/javascript', headers: CORS, body,
  });

  // Puppeteer's request interception does not coexist with a controlling
  // service worker: the SW answers requests before the interceptor sees them.
  // This suite tests auth logic, not offline caching, so the SW is bypassed.
  await page.setBypassServiceWorker(true);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/firebasejs/') && url.endsWith('firebase-app.js')) return serve(req, STUB_APP);
    if (url.includes('/firebasejs/') && url.endsWith('firebase-auth.js')) return serve(req, STUB_AUTH);
    if (url.includes('/firebasejs/') && url.endsWith('firebase-firestore.js')) return serve(req, STUB_FIRESTORE);
    if (url.endsWith('/firebase-config.js')) return serve(req, STUB_CONFIG);
    return req.continue();
  });

  await page.setViewport({ width: 1280, height: 900 });

  try {
    /* ------------------------- 1. welcome & guest ------------------------ */
    console.log('\n1. Welcome card and guest flow');
    await page.goto(BASE + '/?cb=' + Date.now(), { waitUntil: 'networkidle2', timeout: 60000 });
    await wait(2200);

    check('welcome card is shown on a first visit', !(await page.evaluate(() => document.getElementById('welcomeSheet').hidden)));
    check('welcome card offers Sign in, Create account and Skip',
      await page.evaluate(() => ['welcomeSignIn', 'welcomeCreate', 'welcomeSkip'].every((i) => document.getElementById(i))));

    await page.click('#welcomeSkip');
    await wait(500);
    check('Skip closes the card', await page.evaluate(() => document.getElementById('welcomeSheet').hidden));
    check('a guest keeps a Sign in button in the header',
      await page.evaluate(() => { const b = document.getElementById('authSignInBtn'); return b && !b.hidden; }));

    // Navigation must be untouched for guests.
    await page.click('#tab-route');
    await wait(800);
    check('guest can open the Safe Routes page', await page.evaluate(() => !document.getElementById('page-route').hidden));
    check('guest still has both route inputs',
      await page.evaluate(() => !!(document.getElementById('fromInput') && document.getElementById('toInput'))));

    // Welcome must not reappear once skipped.
    await page.reload({ waitUntil: 'networkidle2' });
    await wait(1800);
    check('welcome card does not reappear after Skip', await page.evaluate(() => document.getElementById('welcomeSheet').hidden));

    /* -------------------- 2. guest emergency panel ----------------------- */
    console.log('\n2. Emergency panel as a guest');
    await page.click('#tab-live');
    await wait(700);
    check('guest sees the "Sign in to save emergency contacts" prompt',
      await page.evaluate(() => {
        const el = document.getElementById('emergencyGuest');
        return el && !el.hidden && /Sign in to save emergency contacts/i.test(el.textContent);
      }));
    check('guest still gets a Call 112 button',
      await page.evaluate(() => {
        const a = document.getElementById('call112Btn');
        return a && a.offsetParent !== null && a.getAttribute('href') === 'tel:112';
      }));
    check('guest sees no saved-contacts list', await page.evaluate(() => document.getElementById('emergencyContacts').hidden));
    check('the panic button is present for guests', await page.evaluate(() => !!document.getElementById('panicBtn')));
    check('the guest prompt does not block the page',
      await page.evaluate(() => !document.getElementById('page-live').hidden));

    /* ---------------------------- 3. create account --------------------- */
    console.log('\n3. Create account');
    await page.click('#authSignInBtn');
    await wait(400);
    await page.click('#authTabCreate');
    await wait(200);
    await page.type('#authEmailCreate', 'rider@example.com');
    await page.type('#authPasswordCreate', 'secret123');
    await page.click('#authCreateBtn');
    await wait(900);
    check('create account signs the user in',
      await page.evaluate(() => !!window.SafePathAuth.state.user));
    check('header shows the signed-in name and hides Sign in',
      await page.evaluate(() => {
        const name = document.getElementById('authName').textContent;
        return name.length > 0 && document.getElementById('authSignInBtn').hidden;
      }));
    check('auth sheet closed after sign-up', await page.evaluate(() => document.getElementById('authSheet').hidden));

    /* -------------------------- 4. add contacts ------------------------- */
    console.log('\n4. Add, edit and delete contacts');
    await page.click('#authMenuBtn');
    await wait(250);
    await page.click('#authContactsBtn');
    await wait(500);
    check('contacts sheet opens', await page.evaluate(() => !document.getElementById('contactsSheet').hidden));
    check('contact limit is advertised as 5', await page.evaluate(() => document.getElementById('contactsMax').textContent === '5'));

    await page.type('#contactName', 'Amma');
    await page.type('#contactPhone', '+91 98765 43210');
    await page.type('#contactRelationship', 'Mother');
    await page.click('#contactSaveBtn');
    await wait(700);
    check('contact appears in the list',
      await page.evaluate(() => /Amma/.test(document.getElementById('contactList').textContent)));
    check('contact count updates',
      await page.evaluate(() => document.getElementById('contactsCount').textContent === '1'));
    check('the form is cleared after adding',
      await page.evaluate(() => document.getElementById('contactName').value === ''));

    // Validation must reject a bad phone number.
    await page.type('#contactName', 'Bad Phone');
    await page.type('#contactPhone', 'abc');
    await page.click('#contactSaveBtn');
    await wait(500);
    check('an invalid phone number is rejected',
      await page.evaluate(() => {
        const el = document.getElementById('contactError');
        return el && !el.hidden && el.textContent.length > 0;
      }));
    check('the invalid contact was not saved',
      await page.evaluate(() => window.SafePathAuth.state.contacts.length === 1));
    await page.evaluate(() => { document.getElementById('contactName').value = ''; document.getElementById('contactPhone').value = ''; });

    /* ------------------ 4b. phone validation rules ---------------------- */
    // Indian mobiles start 6-9; an explicit +91 with a bad digit is a typo, not
    // an international number. Anything else with a country code is accepted.
    const phoneCases = [
      ['+91 98765 43210', true, 'Indian mobile'],
      ['9876543210', true, 'Indian mobile, no country code'],
      ['+91 58765 43210', false, 'Indian number starting with 5'],
      ['+1 415 555 2671', true, 'US number'],
      ['+44 20 7946 0958', true, 'UK number'],
      ['000000', false, 'all zeros'],
      ['12345', false, 'too short'],
    ];
    const phoneResults = await page.evaluate((cases) => cases.map(([value]) => {
      const r = window.SafePathAuth.validatePhone(value);
      return { value, ok: r.ok, stored: r.phone || '' };
    }), phoneCases);
    phoneResults.forEach((r, i) => {
      const [value, expected, label] = phoneCases[i];
      check(`phone ${expected ? 'accepts' : 'rejects'} ${label} (${value})`, r.ok === expected,
        expected ? `stored ${r.stored}` : 'was accepted');
    });
    check('an accepted Indian number is stored in +91 form',
      (phoneResults.find((r) => r.value === '9876543210') || {}).stored === '+919876543210');

    /* ---------------------------- 5. escaping --------------------------- */
    console.log('\n5. User text is escaped');
    const XSS = '<img src=x onerror=window.__xss=1>';
    await page.type('#contactName', 'Eve');
    await page.type('#contactPhone', '+91 90000 11111');
    await page.type('#contactRelationship', XSS);
    await page.click('#contactSaveBtn');
    await wait(700);
    check('an HTML payload is stored as text, not executed',
      await page.evaluate(() => window.__xss === undefined));
    check('the payload renders as literal text in the list',
      await page.evaluate(() => {
        const row = [...document.querySelectorAll('.contactrow')].find((r) => /Eve/.test(r.textContent));
        return !!row && row.textContent.includes('<img src=x onerror=');
      }));
    check('no injected element was created from contact text',
      await page.evaluate(() => !document.querySelector('.contactrow img')));

    /* ------------------------- 6. edit and delete ----------------------- */
    console.log('\n6. Edit and delete');
    // One dialog handler for the rest of the run. Registering a second listener
    // would make puppeteer try to accept an already-handled dialog and throw.
    page.on('dialog', (d) => d.accept());
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.contactrow')].find((r) => /Amma/.test(r.textContent));
      row.querySelector('button[data-act="edit"]').click();
    });
    await wait(400);
    check('Edit loads the contact into the form',
      await page.evaluate(() => document.getElementById('contactName').value === 'Amma'));
    await page.evaluate(() => { document.getElementById('contactName').value = 'Amma (renamed)'; });
    await page.click('#contactSaveBtn');
    await wait(700);
    check('the edit is saved',
      await page.evaluate(() => /Amma \(renamed\)/.test(document.getElementById('contactList').textContent)));

    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.contactrow')].find((r) => /Eve/.test(r.textContent));
      row.querySelector('button[data-act="delete"]').click();
    });
    await wait(700);
    check('delete removes the contact',
      await page.evaluate(() => !/Eve/.test(document.getElementById('contactList').textContent)));
    check('contact count drops after delete',
      await page.evaluate(() => document.getElementById('contactsCount').textContent === '1'));

    /* --------------------- 7. emergency with contacts ------------------- */
    console.log('\n7. Emergency actions with saved contacts');
    await page.click('#contactsCloseBtn');
    await wait(400);
    check('signed-in user sees the contacts panel, not the guest prompt',
      await page.evaluate(() => !document.getElementById('emergencyContacts').hidden && document.getElementById('emergencyGuest').hidden));
    check('Call 112 is the first control in the emergency panel',
      await page.evaluate(() => {
        const panel = document.getElementById('emergencyPanel');
        const focusable = panel.querySelectorAll('a[href], button');
        return focusable.length > 0 && focusable[0].id === 'call112Btn';
      }));
    check('the panel says how to alert contacts',
      await page.evaluate(() => /Choose how to alert your contacts/i.test(document.getElementById('emergencyPanel').textContent)));
    check('each contact offers Text and WhatsApp',
      await page.evaluate(() => {
        const row = document.querySelector('.emergencyrow');
        return !!row && !!row.querySelector('a[data-act="sms"]') && !!row.querySelector('a[data-act="whatsapp"]');
      }));

    // Simulate the hold completing and handing over a position.
    await page.evaluate(() => window.SafePathAuthUI.prepareEmergencyActions(12.3052, 76.6554, null));
    await wait(300);
    const links = await page.evaluate(() => {
      const sms = document.querySelector('.emergencyrow a[data-act="sms"]');
      const wa = document.querySelector('.emergencyrow a[data-act="whatsapp"]');
      return { sms: sms.href, wa: wa.href, preview: document.getElementById('emergencyMessagePreview').textContent };
    });
    const EXPECT = 'I need help. My location: https://maps.google.com/?q=12.30520,76.65540';
    check('the Text link is pre-filled with the required message',
      decodeURIComponent(links.sms).includes(EXPECT), links.sms.slice(0, 60));
    check('the WhatsApp link is pre-filled with the same message',
      decodeURIComponent(links.wa).includes(EXPECT), links.wa.slice(0, 60));
    check('the WhatsApp link targets the saved number', /wa\.me\/919876543210/.test(links.wa), links.wa.slice(0, 45));
    check('the message is previewed on screen', links.preview.includes('I need help'));

    /* ------------------- 7b. one-tap alert to everyone ------------------ */
    console.log('\n7b. One-tap alert to every contact');
    check('the bulk actions are visible with a saved contact',
      await page.evaluate(() => !document.getElementById('emergencyBulk').hidden));
    check('Text all and WhatsApp all are both offered',
      await page.evaluate(() => !!document.getElementById('alertAllSmsBtn')
        && !!document.getElementById('alertAllWhatsappBtn')));

    // A second contact, so "all" genuinely means more than one.
    await page.evaluate(async () => {
      await window.SafePathAuth.addContact({ name: 'Appa', phone: '+91 90000 22222', relationship: 'Father' });
    });
    await wait(500);
    check('two contacts are saved for the bulk check',
      await page.evaluate(() => window.SafePathAuth.state.contacts.length === 2));

    // The sms: URL is what a single-tap "text everyone" produces. Built by a
    // pure function, so no navigation is needed to assert it.
    const smsHref = await page.evaluate(() => window.SafePathAuthUI.buildSmsAllHref());
    check('Text all addresses every saved contact in one link',
      !!smsHref && /^sms:/.test(smsHref)
        && smsHref.includes('919876543210') && smsHref.includes('919000022222'),
      (smsHref || '').split('?')[0]);
    check('Text all uses a comma-separated recipient list (one composer)',
      !!smsHref && smsHref.split('?')[0].split('&')[0].split(',').length === 2,
      (smsHref || '').split('?')[0]);
    check('Text all carries the live-location message',
      !!smsHref && decodeURIComponent(smsHref).includes('I need help. My location: https://maps.google.com/?q=12.30520,76.65540'),
      (smsHref || '').slice(-60));

    // Prove the button reaches the handler without navigating: with no alertable
    // contacts the handler takes its early-return path, so no sms: navigation
    // fires (which would destabilise the rest of the headless run).
    const wired = await page.evaluate(() => {
      const saved = window.SafePathAuth.state.contacts;
      window.SafePathAuth.state.contacts = [];
      document.getElementById('alertAllSmsBtn').click();
      const msg = document.getElementById('alertAllProgress').textContent;
      window.SafePathAuth.state.contacts = saved;
      return msg;
    });
    check('the Text all button is wired to the bulk handler',
      /Add a contact first/i.test(wired), wired);

    // WhatsApp has no multi-recipient link, so each contact gets its own chat.
    const waUrls = await page.evaluate(async () => {
      const seen = [];
      const realOpen = window.open;
      window.open = (url) => { seen.push(url); return {}; };
      await window.SafePathAuthUI.alertAllByWhatsapp();
      window.open = realOpen;
      return seen;
    });
    check('WhatsApp all opens one chat per contact',
      waUrls.length === 2, `opened ${waUrls.length}`);
    check('the WhatsApp chats target the saved numbers',
      waUrls.some((u) => /wa\.me\/919876543210/.test(u)) && waUrls.some((u) => /wa\.me\/919000022222/.test(u)),
      waUrls.map((u) => u.slice(8, 26)).join(' | '));
    check('each WhatsApp chat is pre-filled with the location message',
      waUrls.every((u) => decodeURIComponent(u).includes('https://maps.google.com/?q=')),
      (waUrls[0] || '').slice(0, 60));
    check('the WhatsApp progress line reports how many were opened',
      await page.evaluate(() => /2 WhatsApp chats/i.test(document.getElementById('alertAllProgress').textContent)));

    check('the UI never claims a message was sent',
      await page.evaluate(() => {
        const t = document.getElementById('emergencyPanel').textContent;
        return /cannot send an SMS or WhatsApp message/i.test(t) && !/alert sent/i.test(t);
      }));
    check('Call 112 is still available when signed in',
      await page.evaluate(() => document.getElementById('call112Btn').getAttribute('href') === 'tel:112'));

    /* ------------------- 7c. five-contact limit ------------------------- */
    console.log('\n7c. Five-contact limit and consent note');
    check('the consent note is shown before adding',
      await page.evaluate(() => /Only add people who know you/i.test(document.querySelector('.contactform__consent').textContent)));

    // Fill up to the limit through the API, then confirm the UI blocks a sixth.
    await page.evaluate(async () => {
      for (const n of ['Two', 'Three', 'Four', 'Five']) {
        await window.SafePathAuth.addContact({ name: n, phone: '+91 90000 0000' + n.length, relationship: '' });
      }
    });
    await wait(600);
    check('the account now holds exactly the 5-contact limit',
      await page.evaluate(() => window.SafePathAuth.state.contacts.length === 5));

    await page.click('#authMenuBtn');
    await wait(250);
    await page.click('#authContactsBtn');
    await wait(500);
    check('the limit is stated clearly at 5 contacts',
      await page.evaluate(() => {
        const el = document.getElementById('contactError');
        return el && !el.hidden && /limit of 5 contacts/i.test(el.textContent);
      }));
    check('the add form is disabled at the limit',
      await page.evaluate(() => document.getElementById('contactSaveBtn').disabled === true));
    check('a sixth contact is refused by the store',
      await page.evaluate(async () => {
        const r = await window.SafePathAuth.addContact({ name: 'Six', phone: '+91 90000 00006', relationship: '' });
        return r.ok === false && /up to 5/i.test(r.error);
      }));

    /* ------------------- 7c. delete all my contacts --------------------- */
    console.log('\n7c. Delete all my contacts');
    await page.click('#contactsCloseBtn');
    await wait(300);
    await page.click('#authMenuBtn');
    await wait(250);
    check('a signed-in user can reach the privacy note from the account menu',
      await page.evaluate(() => {
        const b = document.getElementById('authPrivacyMenuBtn');
        return !!b && b.offsetParent !== null;
      }));
    await page.click('#authPrivacyMenuBtn');
    await wait(400);
    check('the privacy note opens for a signed-in user',
      await page.evaluate(() => !document.getElementById('privacySheet').hidden));
    check('a signed-in user sees "Delete all my contacts"',
      await page.evaluate(() => {
        const b = document.getElementById('privacyDeleteContactsBtn');
        return !!b && !document.getElementById('privacyDeleteWrap').hidden;
      }));
    // confirm() guards the action; the result is reported on the sheet's status line.
    await page.click('#privacyDeleteContactsBtn');
    await wait(900);
    check('delete-all empties the contact list',
      await page.evaluate(() => window.SafePathAuth.state.contacts.length === 0));
    check('delete-all keeps the account signed in',
      await page.evaluate(() => !!window.SafePathAuth.state.user));
    check('delete-all reports what happened',
      await page.evaluate(() => {
        const el = document.getElementById('privacyStatus');
        return el && !el.hidden && /Deleted 5 contacts/i.test(el.textContent);
      }));
    await page.click('#privacyCloseBtn');
    await wait(300);

    /* ------------------- 7d. toast reuse --------------------------------- */
    console.log('\n7d. Contact feedback reuses the app toast');
    await page.click('#authMenuBtn');
    await wait(250);
    await page.click('#authContactsBtn');
    await wait(500);
    await page.type('#contactName', 'Toast Test');
    await page.type('#contactPhone', '+91 90000 12345');
    await page.click('#contactSaveBtn');
    await wait(800);
    check('saving a contact shows a toast on the shared status line',
      await page.evaluate(() => {
        const el = document.getElementById('contactStatus');
        return el && !el.hidden && /Contact saved/i.test(el.textContent);
      }));
    await page.click('#contactsCloseBtn');
    await wait(300);

    /* ------------------------------ 8. sign out ------------------------- */
    console.log('\n8. Sign out');
    await page.click('#authMenuBtn');
    await wait(250);
    await page.click('#authSignOutBtn');
    await wait(900);
    check('sign out returns the user to guest state',
      await page.evaluate(() => !window.SafePathAuth.state.user));
    check('the header shows Sign in again',
      await page.evaluate(() => { const b = document.getElementById('authSignInBtn'); return b && !b.hidden; }));
    check('contacts are cleared from memory on sign out',
      await page.evaluate(() => window.SafePathAuth.state.contacts.length === 0));
    check('the guest prompt comes back on the emergency panel',
      await page.evaluate(() => !document.getElementById('emergencyGuest').hidden));
    check('the page is still fully usable after signing out',
      await page.evaluate(() => !!document.getElementById('panicBtn') && !!document.getElementById('fromInput')));

    /* --------------------------- 9. privacy note ------------------------ */
    console.log('\n9. Privacy note');
    await page.click('#authSignInBtn');
    await wait(400);
    await page.click('#authPrivacyBtn');
    await wait(400);
    check('the privacy note opens',
      await page.evaluate(() => !document.getElementById('privacySheet').hidden));
    check('it explains what an account stores',
      await page.evaluate(() => /only your email/i.test(document.getElementById('privacySheet').textContent)));
    check('delete-my-account is hidden while signed out',
      await page.evaluate(() => document.getElementById('privacyDeleteWrap').hidden));
    await page.click('#privacyCloseBtn');
    await wait(300);

    /* --------------------------- 10. console ---------------------------- */
    console.log('\n10. Console');
    const real = errors.filter((e) => !/favicon|tile|OpenStreetMap|net::ERR/i.test(e));
    check('no unexpected console errors', real.length === 0, real.slice(0, 3).join(' | '));

    console.log(`\n${pass} passed, ${fail} failed\n`);
    await browser.close();
    process.exit(fail ? 1 : 0);
  } catch (err) {
    console.error('\nAuth smoke run crashed:', err.message);
    try { await browser.close(); } catch { /* ignore */ }
    process.exit(1);
  }
})();
