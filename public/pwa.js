/* SafePath — installable-app support.
 *
 * Two jobs:
 *   1. Register the service worker so the app can open offline and be
 *      installed to a home screen.
 *   2. Show a small, dismissible "Install app" prompt when the browser offers
 *      one, and an "Update available" prompt when a new worker is waiting.
 *
 * Everything here is additive and optional. If service workers are
 * unsupported, blocked, or fail to register, the app runs exactly as before:
 * every failure path below is caught and ignored.
 */
(function () {
  'use strict';

  var STORE_KEY = 'safepath.install.dismissed';

  function $(sel) { return document.querySelector(sel); }

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch { /* private mode: no persistence, not an error */ }
    return null;
  }

  /* ------------------------------------------------------- install prompt */
  var deferredPrompt = null;

  function hideInstall() {
    var el = $('#installPrompt');
    if (el) el.hidden = true;
  }

  function showInstall() {
    var el = $('#installPrompt');
    if (!el) return;
    // Respect a previous dismissal. Re-offered only after the app is updated.
    if (store(STORE_KEY) === '1') return;
    el.hidden = false;
  }

  function initInstallPrompt() {
    var el = $('#installPrompt');
    if (!el) return;

    window.addEventListener('beforeinstallprompt', function (e) {
      // Chrome shows its own mini-infobar unless this is prevented.
      e.preventDefault();
      deferredPrompt = e;
      showInstall();
    });

    var accept = $('#installAccept');
    if (accept) {
      accept.addEventListener('click', function () {
        hideInstall();
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        deferredPrompt.userChoice.finally(function () { deferredPrompt = null; });
      });
    }

    var dismiss = $('#installDismiss');
    if (dismiss) {
      dismiss.addEventListener('click', function () {
        hideInstall();
        store(STORE_KEY, '1');
      });
    }

    // Already installed (running standalone)? Never offer it.
    var standalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    if (standalone) hideInstall();
  }

  /* ------------------------------------------------------ update available */
  function showUpdate(registration) {
    var el = $('#updatePrompt');
    if (!el) return;
    el.hidden = false;
    var btn = $('#updateReload');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      window.location.reload();
    });
  }

  /* -------------------------------------------------- service worker setup */
  function register() {
    if (!('serviceWorker' in navigator)) return;
    // Only over http(s). A file:// or opaque origin cannot register one.
    if (!/^https?:$/.test(window.location.protocol)) return;

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').then(function (registration) {
        // A worker is already waiting: offer the reload.
        if (registration.waiting) showUpdate(registration);

        registration.addEventListener('updatefound', function () {
          var installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', function () {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdate(registration);
            }
          });
        });
      }).catch(function () {
        // Registration can fail on unsupported browsers, in private mode, or
        // when the page is not served over a secure origin. None of that
        // should affect the app, so it is deliberately swallowed.
      });
    });
  }

  function init() {
    initInstallPrompt();
    register();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
