/* ==========================================================================
   SafePath — optional accounts (Firebase Auth + Firestore)
   --------------------------------------------------------------------------
   Design rules, in priority order:

   1. GUEST MODE IS THE DEFAULT AND IS NEVER BLOCKED. If Firebase is not
      configured, fails to load, or errors at any point, every function here
      degrades to a no-op and the rest of the app keeps working.
   2. The Firebase SDK is loaded lazily — only when someone actually asks to
      sign in. A guest who never opens the sign-in card never downloads it.
   3. All user-entered text is escaped before it reaches the DOM. Firebase
      itself does not sanitise strings.
   4. Nothing here is trusted for access control: the Firestore rules
      (firestore.rules) are what stop one user reading another's data.
   ========================================================================== */
'use strict';

(function () {
  const SDK_VERSION = '10.12.0';
  const SDK_BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

  // Public state, read by app.js and the tests.
  const state = {
    ready: false,          // is Firebase configured AND loaded?
    configured: false,
    user: null,            // { uid, email, displayName, photoURL } | null
    contacts: [],
    error: null,
  };

  const listeners = new Set();
  function emit() { listeners.forEach((fn) => { try { fn(snapshot()); } catch { /* ignore */ } }); }
  function snapshot() {
    return { ready: state.ready, configured: state.configured, user: state.user ? { ...state.user } : null, contacts: state.contacts.map((c) => ({ ...c })), error: state.error };
  }
  function onChange(fn) { listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn); }

  function isConfigured() {
    const c = window.SAFEPATH_FIREBASE || {};
    return !!(c.apiKey && c.projectId && !/^YOUR_/.test(c.apiKey) && !/^YOUR_/.test(c.projectId));
  }

  // --- lazy SDK loading ---------------------------------------------------
  let sdkPromise = null;
  function loadSdk() {
    if (sdkPromise) return sdkPromise;
    sdkPromise = (async () => {
      const [appMod, authMod, fsMod] = await Promise.all([
        import(`${SDK_BASE}/firebase-app.js`),
        import(`${SDK_BASE}/firebase-auth.js`),
        import(`${SDK_BASE}/firebase-firestore.js`),
      ]);
      const app = appMod.initializeApp(window.SAFEPATH_FIREBASE);
      const auth = authMod.getAuth(app);
      const db = fsMod.getFirestore(app, window.SAFEPATH_FIRESTORE_REGION || undefined);
      return { app, auth, db, authMod, fsMod };
    })();
    return sdkPromise;
  }

  let sdk = null;

  /** Load Firebase and attach the auth listener. Resolves to true/false. */
  async function init() {
    if (state.ready) return true;
    state.configured = isConfigured();
    if (!state.configured) { state.error = null; return false; }
    try {
      sdk = await loadSdk();
      state.ready = true;
      sdk.authMod.onAuthStateChanged(sdk.auth, async (fbUser) => {
        state.user = fbUser ? {
          uid: fbUser.uid,
          email: fbUser.email || '',
          displayName: fbUser.displayName || '',
          photoURL: fbUser.photoURL || '',
        } : null;
        if (fbUser) { try { await loadContacts(); } catch (e) { state.error = e.message; state.contacts = []; } }
        else state.contacts = [];
        emit();
      });
      return true;
    } catch (err) {
      state.ready = false;
      state.error = err.message || 'Could not load the account service.';
      emit();
      return false;
    }
  }

  // --- contacts -----------------------------------------------------------
  const MAX_CONTACTS = 5;
  const contactsCol = () => sdk.fsMod.collection(sdk.db, 'users', state.user.uid, 'contacts');

  function normaliseContact(id, data) {
    return {
      id,
      name: String(data.name || ''),
      phone: String(data.phone || ''),
      relationship: String(data.relationship || ''),
    };
  }

  async function loadContacts() {
    if (!state.ready || !state.user) { state.contacts = []; return []; }
    const snap = await sdk.fsMod.getDocs(contactsCol());
    state.contacts = snap.docs.map((d) => normaliseContact(d.id, d.data()));
    emit();
    return state.contacts;
  }

  /** Validate and add a contact. Returns { ok, error } — never throws. */
  async function addContact({ name, phone, relationship }) {
    if (!state.user) return { ok: false, error: 'Sign in to save emergency contacts.' };
    if (!state.ready) return { ok: false, error: state.error || 'Account service is unavailable.' };
    if (state.contacts.length >= MAX_CONTACTS) return { ok: false, error: `You can save up to ${MAX_CONTACTS} contacts.` };
    const clean = validateContact({ name, phone, relationship });
    if (clean.error) return clean;
    try {
      const ref = await sdk.fsMod.addDoc(contactsCol(), {
        name: clean.name, phone: clean.phone, relationship: clean.relationship,
        created_at: sdk.fsMod.serverTimestamp(),
      });
      state.contacts.push({ id: ref.id, name: clean.name, phone: clean.phone, relationship: clean.relationship });
      emit();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  }

  async function updateContact(id, { name, phone, relationship }) {
    if (!state.user) return { ok: false, error: 'Sign in to save emergency contacts.' };
    const clean = validateContact({ name, phone, relationship });
    if (clean.error) return clean;
    try {
      await sdk.fsMod.updateDoc(sdk.fsMod.doc(sdk.db, 'users', state.user.uid, 'contacts', id), {
        name: clean.name, phone: clean.phone, relationship: clean.relationship,
      });
      const i = state.contacts.findIndex((c) => c.id === id);
      if (i >= 0) state.contacts[i] = { id, name: clean.name, phone: clean.phone, relationship: clean.relationship };
      emit();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  }

  async function deleteContact(id) {
    if (!state.user) return { ok: false, error: 'Sign in to manage emergency contacts.' };
    try {
      await sdk.fsMod.deleteDoc(sdk.fsMod.doc(sdk.db, 'users', state.user.uid, 'contacts', id));
      state.contacts = state.contacts.filter((c) => c.id !== id);
      emit();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  }

  /**
   * Digits only, for validation and for building tel:/wa.me links.
   * Keeps a single leading "+" and strips spaces, dashes, dots, brackets.
   */
  function digitsOf(phone) {
    return String(phone || '').replace(/[\s().-]/g, '');
  }

  /**
   * Phone validation. The app is used in India, so an Indian mobile is checked
   * properly (10 digits starting 6-9, optional +91 / 0 prefix) rather than
   * accepted as "any digits". Anything else with a country code is accepted as
   * an international number, so a user abroad is not locked out.
   */
  const IN_MOBILE = /^(?:\+91|91|0)?([6-9]\d{9})$/;
  const INTL = /^\+[1-9]\d{6,14}$/;
  const IN_PREFIXED = /^(?:\+91|91)/;

  function validatePhone(phone) {
    const raw = String(phone || '').trim();
    if (!raw) return { ok: false, error: 'Enter a phone number, e.g. +91 98765 43210.' };
    const d = digitsOf(raw);
    if (!/^\+?\d+$/.test(d)) return { ok: false, error: 'Use digits, spaces, +, - or brackets only.' };
    if (/^\+?0+$/.test(d)) return { ok: false, error: 'That is not a phone number.' };

    // An explicit Indian country code is treated as Indian even when the digits
    // are wrong, so "+91 58765 43210" is corrected rather than passed off as an
    // international number.
    if (IN_PREFIXED.test(d)) {
      const m = d.match(IN_MOBILE);
      if (m) return { ok: true, phone: '+91' + m[1], local: true };
      return { ok: false, error: 'An Indian mobile is 10 digits starting 6, 7, 8 or 9 — check the number.' };
    }
    if (IN_MOBILE.test(d)) return { ok: true, phone: '+91' + d.match(IN_MOBILE)[1], local: true };
    if (INTL.test(d)) return { ok: true, phone: d, local: false };
    if (/^\d{10}$/.test(d)) {
      return { ok: false, error: 'Indian mobile numbers start with 6, 7, 8 or 9 — check the number.' };
    }
    return { ok: false, error: 'Enter a valid phone number, e.g. +91 98765 43210 or +1 415 555 2671.' };
  }

  function validateContact({ name, phone, relationship }) {
    const n = String(name || '').trim();
    const r = String(relationship || '').trim();
    if (n.length < 2 || n.length > 60) return { ok: false, error: 'Enter a name (2–60 characters).' };
    const p = validatePhone(phone);
    if (!p.ok) return { ok: false, error: p.error };
    if (r.length > 40) return { ok: false, error: 'Relationship must be 40 characters or fewer.' };
    return { ok: true, name: n, phone: p.phone, relationship: r };
  }

  /**
   * Delete every contact for the signed-in user, keeping the account.
   * Used by "Delete all my contacts" in the privacy panel.
   */
  async function deleteAllContacts() {
    if (!state.user) return { ok: false, error: 'Sign in to manage emergency contacts.' };
    if (!state.ready) return { ok: false, error: state.error || 'Account service is unavailable.' };
    try {
      const snap = await sdk.fsMod.getDocs(contactsCol());
      await Promise.all(snap.docs.map((d) => sdk.fsMod.deleteDoc(d.ref)));
      state.contacts = [];
      emit();
      return { ok: true, removed: snap.docs.length };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  }

  function friendlyError(err) {
    const code = (err && err.code) || '';
    if (code === 'permission-denied') return 'Permission denied — check your Firestore security rules.';
    if (code === 'unavailable') return 'No connection to the account service.';
    return (err && err.message) || 'Something went wrong.';
  }

  // --- auth actions -------------------------------------------------------
  async function signUp(email, password) {
    if (!(await ensure())) return { ok: false, error: state.error };
    try {
      await sdk.authMod.createUserWithEmailAndPassword(sdk.auth, email, password);
      return { ok: true };
    } catch (err) { return { ok: false, error: authError(err) }; }
  }

  async function signIn(email, password) {
    if (!(await ensure())) return { ok: false, error: state.error };
    try {
      await sdk.authMod.signInWithEmailAndPassword(sdk.auth, email, password);
      return { ok: true };
    } catch (err) { return { ok: false, error: authError(err) }; }
  }

  async function signInWithGoogle() {
    if (!(await ensure())) return { ok: false, error: state.error };
    try {
      const provider = new sdk.authMod.GoogleAuthProvider();
      await sdk.authMod.signInWithPopup(sdk.auth, provider);
      return { ok: true };
    } catch (err) { return { ok: false, error: authError(err) }; }
  }

  async function sendPasswordReset(email) {
    if (!(await ensure())) return { ok: false, error: state.error };
    try {
      await sdk.authMod.sendPasswordResetEmail(sdk.auth, email);
      return { ok: true };
    } catch (err) { return { ok: false, error: authError(err) }; }
  }

  async function signOut() {
    if (!state.ready) return { ok: true };
    try { await sdk.authMod.signOut(sdk.auth); return { ok: true }; }
    catch (err) { return { ok: false, error: friendlyError(err) }; }
  }

  /**
   * Delete the signed-in user's Firestore data and then the account itself.
   * The contact documents are removed first so a failed account deletion does
   * not leave orphaned personal data behind.
   */
  async function deleteAccount() {
    if (!state.user) return { ok: false, error: 'You are not signed in.' };
    if (!state.ready) return { ok: false, error: state.error || 'Account service is unavailable.' };
    try {
      const snap = await sdk.fsMod.getDocs(contactsCol());
      await Promise.all(snap.docs.map((d) => sdk.fsMod.deleteDoc(d.ref)));
      state.contacts = [];
      emit();
      await sdk.authMod.deleteUser(sdk.auth.currentUser);
      state.user = null;
      emit();
      return { ok: true };
    } catch (err) {
      if ((err && err.code) === 'auth/requires-recent-login') {
        return { ok: false, error: 'For security, please sign out and sign in again, then delete your account.' };
      }
      return { ok: false, error: friendlyError(err) };
    }
  }

  /** Load the SDK on demand; used by every entry point that needs Firebase. */
  async function ensure() {
    if (state.ready) return true;
    if (!isConfigured()) {
      state.error = 'Accounts are not configured on this deployment. SafePath still works as a guest.';
      return false;
    }
    const ok = await init();
    if (!ok) state.error = state.error || 'Could not reach the account service.';
    return ok;
  }

  function authError(err) {
    const code = (err && err.code) || '';
    switch (code) {
      case 'auth/email-already-in-use': return 'That email already has an account — try signing in.';
      case 'auth/invalid-email': return 'That email address looks invalid.';
      case 'auth/weak-password': return 'Use a password of at least 6 characters.';
      case 'auth/wrong-password':
      case 'auth/invalid-credential': return 'Email or password is incorrect.';
      case 'auth/user-not-found': return 'No account found for that email.';
      case 'auth/too-many-requests': return 'Too many attempts. Wait a moment and try again.';
      case 'auth/popup-closed-by-user':
      case 'auth/cancelled-popup-request': return 'Sign-in window closed before finishing.';
      case 'auth/popup-blocked': return 'Your browser blocked the sign-in window. Allow pop-ups and retry.';
      case 'auth/operation-not-allowed': return 'That sign-in method is not enabled in Firebase.';
      case 'auth/network-request-failed': return 'Network problem — check your connection.';
      case 'auth/unauthorized-domain': return 'This domain is not authorised in Firebase Auth settings.';
      default: return (err && err.message) || 'Sign-in failed.';
    }
  }

  window.SafePathAuth = {
    MAX_CONTACTS,
    state, onChange, init, isConfigured,
    signUp, signIn, signInWithGoogle, sendPasswordReset, signOut, deleteAccount,
    loadContacts, addContact, updateContact, deleteContact, deleteAllContacts,
    validateContact, validatePhone,
  };
})();
