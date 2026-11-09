/* ==========================================================================
   SafePath — account & emergency UI wiring
   --------------------------------------------------------------------------
   Bridges public/auth.js (Firebase) and the SafePath DOM. Loaded after app.js
   so it can reuse the app's helpers without duplicating them.

   The one rule that matters: NOTHING HERE IS REQUIRED FOR NAVIGATION. If
   Firebase is absent, every function below still leaves a usable page.
   ========================================================================== */
'use strict';

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  // Local escape — auth-ui.js must not assume app.js loaded successfully.
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const Auth = window.SafePathAuth;
  const WELCOME_KEY = 'safepath.welcome.seen';
  let editingId = null;

  /**
   * Reuse the app's own toast() when it is present, so contact feedback looks
   * and behaves exactly like the rest of SafePath. auth-ui.js must also survive
   * app.js failing to load, so fall back to the local status line.
   */
  function toast(msg, kind, targetId = 'contactStatus') {
    const el = document.getElementById(targetId);
    // app.toast() only sets the text, so visibility is handled here for both
    // the delegated and the fallback path.
    if (el) el.hidden = !msg;
    const app = window.SafePathApp;
    if (app && typeof app.toast === 'function') { app.toast(targetId, msg, kind); return; }
    if (el) el.textContent = msg;
  }

  function clearToast(targetId = 'contactStatus') { toast('', null, targetId); }

  /* ------------------------------ sheets ------------------------------ */
  // The app has its own .sheet pattern; reuse it so focus handling and the
  // backdrop look identical to the existing navigation sheets.
  let lastFocus = null;

  function openSheet(id) {
    const el = document.getElementById(id);
    if (!el) return;
    lastFocus = document.activeElement;
    el.hidden = false;
    const first = el.querySelector('input:not([type=hidden]), button');
    if (first) setTimeout(() => first.focus(), 30);
    document.addEventListener('keydown', onSheetKey);
  }

  function closeSheet(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = true;
    document.removeEventListener('keydown', onSheetKey);
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  function anySheetOpen() { return $$('.sheet').some((s) => !s.hidden); }

  function onSheetKey(e) {
    if (e.key !== 'Escape') return;
    const open = $$('.sheet').filter((s) => !s.hidden).pop();
    if (open) { closeSheet(open.id); e.preventDefault(); }
  }

  // Click the backdrop to dismiss.
  $$('.sheet').forEach((sheet) => {
    sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(sheet.id); });
  });

  /* ------------------------------ welcome ----------------------------- */
  function maybeShowWelcome() {
    let seen = null;
    try { seen = localStorage.getItem(WELCOME_KEY); } catch { /* private mode */ }
    if (seen) return;
    openSheet('welcomeSheet');
  }

  function markWelcomeSeen() {
    try { localStorage.setItem(WELCOME_KEY, '1'); } catch { /* ignore */ }
  }

  /* -------------------------------- auth ------------------------------ */
  function showAuthError(elId, msg) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg;
    el.hidden = false;
  }

  function showAuthNotice(msg) {
    const el = $('#authNotice');
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg;
    el.hidden = false;
  }

  function selectAuthTab(which) {
    const isSignIn = which === 'signin';
    $('#authTabSignIn').setAttribute('aria-selected', String(isSignIn));
    $('#authTabCreate').setAttribute('aria-selected', String(!isSignIn));
    $('#authPaneSignIn').hidden = !isSignIn;
    $('#authPaneCreate').hidden = isSignIn;
    $('#authSheetTitle').textContent = isSignIn ? 'Sign in' : 'Create account';
    showAuthError('authError', null);
    showAuthError('authErrorCreate', null);
  }

  function openAuth(mode) {
    selectAuthTab(mode === 'create' ? 'create' : 'signin');
    showAuthNotice(null);
    // If accounts are not configured, say so plainly instead of failing on submit.
    if (Auth && !Auth.isConfigured()) {
      showAuthError(mode === 'create' ? 'authErrorCreate' : 'authError',
        'Accounts are not configured on this deployment. SafePath still works as a guest.');
    }
    openSheet('authSheet');
  }

  async function handleSignIn(e) {
    e.preventDefault();
    const email = $('#authEmail').value.trim();
    const password = $('#authPassword').value;
    if (!email || !password) { showAuthError('authError', 'Enter your email and password.'); return; }
    const btn = $('#authSubmitBtn');
    btn.disabled = true; btn.textContent = 'Signing in…';
    const out = await Auth.signIn(email, password);
    btn.disabled = false; btn.textContent = 'Sign in';
    if (!out.ok) { showAuthError('authError', out.error); return; }
    closeSheet('authSheet');
    $('#authPassword').value = '';
  }

  async function handleCreate(e) {
    e.preventDefault();
    const email = $('#authEmailCreate').value.trim();
    const password = $('#authPasswordCreate').value;
    if (!email || !password) { showAuthError('authErrorCreate', 'Enter an email and a password.'); return; }
    if (password.length < 6) { showAuthError('authErrorCreate', 'Use a password of at least 6 characters.'); return; }
    const btn = $('#authCreateBtn');
    btn.disabled = true; btn.textContent = 'Creating…';
    const out = await Auth.signUp(email, password);
    btn.disabled = false; btn.textContent = 'Create account';
    if (!out.ok) { showAuthError('authErrorCreate', out.error); return; }
    closeSheet('authSheet');
    $('#authPasswordCreate').value = '';
  }

  async function handleGoogle() {
    showAuthNotice(null);
    const out = await Auth.signInWithGoogle();
    if (!out.ok) { showAuthError('authError', out.error); return; }
    closeSheet('authSheet');
  }

  async function handleForgot() {
    const email = ($('#authEmail').value || $('#authEmailCreate').value || '').trim();
    if (!email) { showAuthError('authError', 'Enter your email first, then tap “Forgot password?”.'); return; }
    const out = await Auth.sendPasswordReset(email);
    if (!out.ok) { showAuthError('authError', out.error); return; }
    showAuthNotice(`If an account exists for ${email}, a reset link is on its way.`);
  }

  /* ----------------------------- auth bar ----------------------------- */
  function renderAuthBar(snap) {
    const signInBtn = $('#authSignInBtn');
    const userBox = $('#authUser');
    if (!signInBtn || !userBox) return;

    if (snap.user) {
      signInBtn.hidden = true;
      userBox.hidden = false;
      const name = snap.user.displayName || snap.user.email || 'Signed in';
      $('#authName').textContent = name;
      const avatar = $('#authAvatar');
      if (snap.user.photoURL) {
        avatar.textContent = '';
        avatar.style.backgroundImage = `url("${encodeURI(snap.user.photoURL)}")`;
      } else {
        avatar.style.backgroundImage = '';
        avatar.textContent = (name.trim()[0] || '?').toUpperCase();
      }
    } else {
      signInBtn.hidden = false;
      userBox.hidden = true;
      $('#authMenu').hidden = true;
      $('#authMenuBtn').setAttribute('aria-expanded', 'false');
      $('#authAvatar').style.backgroundImage = '';
    }
    renderEmergency(snap);
    renderContactList(snap);
  }

  /* --------------------------- contacts UI ---------------------------- */
  function renderContactList(snap) {
    const list = $('#contactList');
    if (!list) return;
    const count = $('#contactsCount');
    if (count) count.textContent = String(snap.contacts.length);
    const empty = $('#contactsEmpty');
    if (empty) empty.hidden = snap.contacts.length > 0;

    list.innerHTML = snap.contacts.map((c) => `
      <li class="contactrow" data-id="${esc(c.id)}">
        <div class="contactrow__main">
          <span class="contactrow__name">${esc(c.name)}</span>
          ${c.relationship ? `<span class="contactrow__rel">${esc(c.relationship)}</span>` : ''}
          <span class="contactrow__phone mono">${esc(c.phone)}</span>
        </div>
        <div class="contactrow__actions">
          <button class="btn btn--sm" data-act="edit" data-id="${esc(c.id)}" type="button"
                  aria-label="Edit ${esc(c.name)}">Edit</button>
          <button class="btn btn--sm btn--danger" data-act="delete" data-id="${esc(c.id)}" type="button"
                  aria-label="Delete ${esc(c.name)}">Delete</button>
        </div>
      </li>`).join('');

    const saveBtn = $('#contactSaveBtn');
    if (saveBtn) saveBtn.textContent = editingId ? 'Save changes' : 'Add contact';
    const cancel = $('#contactCancelBtn');
    if (cancel) cancel.hidden = !editingId;
    const form = $('#contactForm');
    if (form) {
      const atMax = snap.contacts.length >= Auth.MAX_CONTACTS && !editingId;
      $$('input', form).forEach((i) => { i.disabled = atMax; });
      if (saveBtn) saveBtn.disabled = atMax;
      if (atMax) showContactError(`You have reached the limit of ${Auth.MAX_CONTACTS} contacts. Delete one to add another.`);
      else if (!editingId) showContactError(null);
    }
  }

  function showContactError(msg) {
    const el = $('#contactError');
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg;
    el.hidden = false;
  }

  function resetContactForm() {
    editingId = null;
    const form = $('#contactForm');
    if (form) form.reset();
    showContactError(null);
    const cancel = $('#contactCancelBtn');
    if (cancel) cancel.hidden = true;
    const saveBtn = $('#contactSaveBtn');
    if (saveBtn) saveBtn.textContent = 'Add contact';
  }

  async function handleContactSubmit(e) {
    e.preventDefault();
    const payload = {
      name: $('#contactName').value,
      phone: $('#contactPhone').value,
      relationship: $('#contactRelationship').value,
    };
    const btn = $('#contactSaveBtn');
    const wasEditing = !!editingId;
    btn.disabled = true;
    const out = wasEditing
      ? await Auth.updateContact(editingId, payload)
      : await Auth.addContact(payload);
    btn.disabled = false;
    if (!out.ok) { showContactError(out.error); return; }
    resetContactForm();
    toast(wasEditing ? 'Contact updated.' : 'Contact saved. It will appear when you hold the emergency button.', 'ok');
  }

  function onContactListClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const act = btn.getAttribute('data-act');
    if (act === 'delete') {
      const c = Auth.state.contacts.find((x) => x.id === id);
      if (!window.confirm(`Delete ${c ? c.name : 'this contact'}?`)) return;
      Auth.deleteContact(id).then((out) => {
        if (!out.ok) { showContactError(out.error); return; }
        toast('Contact deleted.', 'ok');
      });
      return;
    }
    if (act === 'edit') {
      const c = Auth.state.contacts.find((x) => x.id === id);
      if (!c) return;
      editingId = id;
      $('#contactName').value = c.name;
      $('#contactPhone').value = c.phone;
      $('#contactRelationship').value = c.relationship || '';
      showContactError(null);
      clearToast();
      $('#contactSaveBtn').textContent = 'Save changes';
      $('#contactCancelBtn').hidden = false;
      $('#contactName').focus();
    }
  }

  function openContacts() {
    if (!Auth.state.user) { openAuth('signin'); return; }
    resetContactForm();
    renderContactList(Auth.state);
    openSheet('contactsSheet');
  }

  /**
   * After a hold, the actions the user needs live on the Live page. Switch to it
   * so the contacts are actually in front of them rather than off-screen.
   */
  function revealEmergency() {
    const app = window.SafePathApp;
    if (app && typeof app.selectTab === 'function') app.selectTab('live');
    else if (location.hash !== '#page-live') location.hash = '#page-live';
  }

  /* ---------------------------- emergency ----------------------------- */
  /** The exact text a contact will receive. Built once, reused everywhere. */
  function buildMessage(lat, lng) {
    if (typeof lat === 'number' && typeof lng === 'number') {
      return `I need help. My location: https://maps.google.com/?q=${lat.toFixed(5)},${lng.toFixed(5)}`;
    }
    return 'I need help. My location is not available — please call me.';
  }

  // The most recent position handed over by the panic flow. Kept so the bulk
  // buttons can build a real message without a second, slower location read.
  let lastFix = null;

  /** Digits only, so "sms:" and wa.me both accept the number. */
  const digitsOf = (phone) => String(phone || '').replace(/[^0-9]/g, '');

  /** Saved contacts that actually have a usable number. */
  function alertableContacts() {
    return (Auth.state.contacts || []).filter((c) => digitsOf(c.phone).length >= 8);
  }

  /** The message the bulk buttons will send, from the last known position. */
  function currentMessage() {
    return lastFix ? buildMessage(lastFix.lat, lastFix.lng) : buildMessage();
  }

  function showBulkProgress(msg) {
    const el = $('#alertAllProgress');
    if (!el) return;
    el.hidden = !msg;
    el.textContent = msg || '';
  }

  /**
   * The sms: URL that texts every saved contact at once. The scheme takes a
   * comma-separated recipient list, so this is a single message addressed to
   * everyone — one navigation, one send, the fastest way to reach the circle.
   * Returns null when there is nobody to text.
   */
  function buildSmsAllHref() {
    const contacts = alertableContacts();
    if (!contacts.length) return null;
    const encoded = encodeURIComponent(currentMessage());
    const recipients = contacts.map((c) => digitsOf(c.phone)).join(',');
    // iOS uses "&body=" after the address list; everything else uses "?body=".
    const sep = /iPhone|iPad|Macintosh/.test(navigator.userAgent) ? '&' : '?';
    return `sms:${recipients}${sep}body=${encoded}`;
  }

  /** Text everyone in one tap. */
  function alertAllBySms() {
    const href = buildSmsAllHref();
    if (!href) { showBulkProgress('Add a contact first.'); return; }
    const n = alertableContacts().length;
    window.location.href = href;
    showBulkProgress(`One message to ${n} contact${n === 1 ? '' : 's'} is open — press send.`);
  }

  /**
   * WhatsApp has no multi-recipient link, so each contact gets its own chat.
   * Browsers only honour the first navigation inside a click, so the rest are
   * opened in sequence and the progress line reports what actually happened
   * rather than pretending all of them were sent.
   */
  async function alertAllByWhatsapp() {
    const contacts = alertableContacts();
    if (!contacts.length) { showBulkProgress('Add a contact first.'); return; }
    const encoded = encodeURIComponent(currentMessage());
    let opened = 0;
    for (const c of contacts) {
      if (opened > 0) await new Promise((r) => setTimeout(r, 400));
      const url = `https://wa.me/${digitsOf(c.phone)}?text=${encoded}`;
      const win = window.open(url, '_blank', 'noopener');
      if (win) opened++;
      showBulkProgress(`Opening WhatsApp — ${opened} of ${contacts.length}…`);
    }
    showBulkProgress(opened === contacts.length
      ? `Opened ${opened} WhatsApp chat${opened === 1 ? '' : 's'} — press send in each.`
      : `Opened ${opened} of ${contacts.length} chats. Your browser blocked the rest — use the buttons below.`);
  }

  function renderEmergency(snap) {
    const guest = $('#emergencyGuest');
    const contactsBox = $('#emergencyContacts');
    const list = $('#emergencyList');
    const empty = $('#emergencyEmpty');
    const bulk = $('#emergencyBulk');
    if (!guest || !contactsBox) return;

    const signedIn = !!snap.user;
    guest.hidden = signedIn;
    contactsBox.hidden = !signedIn;
    // The bulk actions only make sense with at least one usable number.
    if (bulk) bulk.hidden = !signedIn || alertableContacts().length === 0;
    showBulkProgress('');

    const preview = $('#emergencyMessagePreview');
    if (preview) {
      preview.textContent = `Message: “${buildMessage(12.30520, 76.65540)}”`;
    }

    if (!signedIn) return;
    if (empty) empty.hidden = snap.contacts.length > 0;
    if (!list) return;

    // Location is fetched at hold time; until then the links carry a placeholder
    // that the live handler replaces. Each row is rebuilt by refreshEmergencyLinks().
    list.innerHTML = snap.contacts.map((c) => `
      <li class="emergencyrow" data-id="${esc(c.id)}">
        <div class="emergencyrow__main">
          <span class="emergencyrow__name">${esc(c.name)}</span>
          ${c.relationship ? `<span class="contactrow__rel">${esc(c.relationship)}</span>` : ''}
        </div>
        <div class="emergencyrow__actions">
          <a class="btn btn--sm" data-act="sms" data-phone="${esc(c.phone)}" href="#">Text</a>
          <a class="btn btn--sm" data-act="whatsapp" data-phone="${esc(c.phone)}" href="#">WhatsApp</a>
        </div>
      </li>`).join('');
  }

  /** Fill every Text/WhatsApp link with the real message for a known position. */
  function applyLocationToLinks(lat, lng) {
    lastFix = { lat, lng };
    const msg = buildMessage(lat, lng);
    const encoded = encodeURIComponent(msg);
    $$('#emergencyList a[data-act]').forEach((a) => {
      const phone = (a.getAttribute('data-phone') || '').replace(/[^0-9+]/g, '');
      const digits = phone.replace(/^\+/, '');
      if (a.getAttribute('data-act') === 'sms') {
        a.href = `sms:${phone}${/iPhone|iPad|Macintosh/.test(navigator.userAgent) ? '&' : '?'}body=${encoded}`;
      } else {
        a.href = `https://wa.me/${digits}?text=${encoded}`;
      }
      a.setAttribute('data-ready', '1');
    });
    const preview = $('#emergencyMessagePreview');
    if (preview) preview.textContent = `Message: “${msg}”`;
  }

  /**
   * Called by the app when a hold completes. Resolves the position, then fills
   * the one-tap links. Never claims a message was sent — only that it is ready.
   */
  function prepareEmergencyActions(lat, lng, note) {
    // The panel lives on the Live page; make sure the user is looking at it.
    revealEmergency();
    if (typeof lat === 'number' && typeof lng === 'number') {
      applyLocationToLinks(lat, lng);
    }
    const honesty = $('#emergencyHonesty');
    if (honesty && note) honesty.textContent = note;

    // Bring the panel into view after a hold, so the saved contacts and the
    // Call 112 button are in front of the user at the moment they need them.
    const panel = $('#emergencyPanel');
    if (panel) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      panel.classList.add('is-highlighted');
      setTimeout(() => panel.classList.remove('is-highlighted'), 1800);
    }
  }
  /* ------------------------------ privacy ----------------------------- */
  function openPrivacy() {
    const wrap = $('#privacyDeleteWrap');
    if (wrap) wrap.hidden = !Auth.state.user;
    clearToast('privacyStatus');
    openSheet('privacySheet');
  }

  async function handleDeleteAllContacts() {
    if (!Auth.state.user) return;
    const n = Auth.state.contacts.length;
    if (!n) { toast('You have no saved contacts.', 'warn', 'privacyStatus'); return; }
    if (!window.confirm(`Delete all ${n} saved contact${n === 1 ? '' : 's'}? Your account stays.`)) return;
    const btn = $('#privacyDeleteContactsBtn');
    btn.disabled = true; btn.textContent = 'Deleting…';
    const out = await Auth.deleteAllContacts();
    btn.disabled = false; btn.textContent = 'Delete all my contacts';
    if (!out.ok) { toast(out.error, 'err', 'privacyStatus'); return; }
    resetContactForm();
    toast(`Deleted ${out.removed} contact${out.removed === 1 ? '' : 's'}. Your account is still active.`, 'ok', 'privacyStatus');
  }

  async function handleDeleteAccount() {
    if (!window.confirm('Delete your account and all saved contacts? This cannot be undone.')) return;
    const btn = $('#privacyDeleteBtn');
    btn.disabled = true; btn.textContent = 'Deleting…';
    const out = await Auth.deleteAccount();
    btn.disabled = false; btn.textContent = 'Delete my account and data';
    if (!out.ok) { showAuthNotice(null); toast(out.error, 'err', 'privacyStatus'); return; }
    closeSheet('privacySheet');
    alert('Your account and saved contacts have been deleted.');
  }

  /* ------------------------------- wiring ----------------------------- */
  function wire() {
    $('#welcomeSignIn')?.addEventListener('click', () => { markWelcomeSeen(); closeSheet('welcomeSheet'); openAuth('signin'); });
    $('#welcomeCreate')?.addEventListener('click', () => { markWelcomeSeen(); closeSheet('welcomeSheet'); openAuth('create'); });
    $('#welcomeSkip')?.addEventListener('click', () => { markWelcomeSeen(); closeSheet('welcomeSheet'); });

    $('#authSignInBtn')?.addEventListener('click', () => openAuth('signin'));
    $('#emergencySignInBtn')?.addEventListener('click', () => openAuth('signin'));
    $('#authCloseBtn')?.addEventListener('click', () => closeSheet('authSheet'));
    $('#authTabSignIn')?.addEventListener('click', () => selectAuthTab('signin'));
    $('#authTabCreate')?.addEventListener('click', () => selectAuthTab('create'));
    $('#authPaneSignIn')?.addEventListener('submit', handleSignIn);
    $('#authPaneCreate')?.addEventListener('submit', handleCreate);
    $('#authGoogleBtn')?.addEventListener('click', handleGoogle);
    $('#authForgotBtn')?.addEventListener('click', handleForgot);
    $('#authPrivacyBtn')?.addEventListener('click', openPrivacy);

    $('#authMenuBtn')?.addEventListener('click', () => {
      const menu = $('#authMenu');
      const open = menu.hidden;
      menu.hidden = !open;
      $('#authMenuBtn').setAttribute('aria-expanded', String(open));
    });
    $('#authContactsBtn')?.addEventListener('click', () => { $('#authMenu').hidden = true; openContacts(); });
    $('#authPrivacyMenuBtn')?.addEventListener('click', () => { $('#authMenu').hidden = true; openPrivacy(); });
    $('#authSignOutBtn')?.addEventListener('click', async () => {
      $('#authMenu').hidden = true;
      await Auth.signOut();
      resetContactForm();
    });

    $('#contactsCloseBtn')?.addEventListener('click', () => { resetContactForm(); closeSheet('contactsSheet'); });
    $('#contactForm')?.addEventListener('submit', handleContactSubmit);
    $('#contactCancelBtn')?.addEventListener('click', resetContactForm);
    $('#contactList')?.addEventListener('click', onContactListClick);
    $('#emergencyManageBtn')?.addEventListener('click', openContacts);
    $('#alertAllSmsBtn')?.addEventListener('click', alertAllBySms);
    $('#alertAllWhatsappBtn')?.addEventListener('click', alertAllByWhatsapp);

    $('#privacyCloseBtn')?.addEventListener('click', () => closeSheet('privacySheet'));
    $('#privacyDeleteContactsBtn')?.addEventListener('click', handleDeleteAllContacts);
    $('#privacyDeleteBtn')?.addEventListener('click', handleDeleteAccount);

    // Close the account menu on an outside click.
    document.addEventListener('click', (e) => {
      const menu = $('#authMenu');
      if (!menu || menu.hidden) return;
      if (!e.target.closest('#authBar')) { menu.hidden = true; $('#authMenuBtn')?.setAttribute('aria-expanded', 'false'); }
    });
  }

  /* -------------------------------- boot ------------------------------ */
  function boot() {
    if (!Auth) { console.warn('[safepath] auth module missing — running as guest only.'); return; }
    wire();
    $('#contactsMax').textContent = String(Auth.MAX_CONTACTS);
    Auth.onChange(renderAuthBar);
    // Only reach for the network once the user asks to sign in.
    if (Auth.isConfigured()) Auth.init().catch(() => { /* guest mode continues */ });
    maybeShowWelcome();

    // Let the panic flow hand the resolved position to the contact links.
    window.SafePathAuthUI = {
      prepareEmergencyActions, openAuth, openContacts, openPrivacy,
      buildMessage, revealEmergency,
      // Exposed so the smoke test can assert the bulk behaviour without
      // actually opening a messaging app.
      alertAllBySms, alertAllByWhatsapp, alertableContacts, currentMessage, buildSmsAllHref,
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
