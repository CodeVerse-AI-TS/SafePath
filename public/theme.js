/* SafePath theme controller.
 *
 * Three choices: light, dark, or system. The choice is saved in localStorage and
 * applied as data-theme on <html>, which is what styles.css keys off. The
 * attribute is set once more in a small inline script in <head> so a light-mode
 * visitor never sees a flash of the dark theme before this file loads.
 *
 * "System" follows the operating system and keeps following it: a change to the
 * OS preference re-applies the theme while that choice is selected.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'safepath-theme';
  var CHOICES = ['light', 'dark', 'system'];
  var DEFAULT_CHOICE = 'dark';
  var THEME_COLOR = { light: '#f4f5f7', dark: '#101114' };

  var root = document.documentElement;
  var picker = document.getElementById('themePick');
  var opts = picker ? Array.prototype.slice.call(picker.querySelectorAll('.themepick__opt')) : [];
  var mq = window.matchMedia('(prefers-color-scheme: light)');

  /** The saved choice, or the default when nothing is saved or it is unreadable. */
  function savedChoice() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return CHOICES.indexOf(v) >= 0 ? v : DEFAULT_CHOICE;
    } catch (e) {
      return DEFAULT_CHOICE;
    }
  }

  /** The theme a choice resolves to right now. */
  function resolve(choice) {
    if (choice === 'light' || choice === 'dark') return choice;
    return mq.matches ? 'light' : 'dark';
  }

  /** Repaint the picker so the selected option is the one marked pressed. */
  function paint(choice) {
    opts.forEach(function (b) {
      var on = b.getAttribute('data-theme-choice') === choice;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function apply(choice) {
    var theme = resolve(choice);
    // Only write when something actually changes. Setting these attributes
    // invalidates style for the whole document, because the light theme is
    // keyed off html[data-theme], and a needless restyle at load is enough to
    // disturb the page's entry animation.
    if (root.getAttribute('data-theme') !== theme) root.setAttribute('data-theme', theme);
    if (root.getAttribute('data-theme-choice') !== choice) root.setAttribute('data-theme-choice', choice);
    // Keep the browser UI in step with the page.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && meta.getAttribute('content') !== THEME_COLOR[theme]) {
      meta.setAttribute('content', THEME_COLOR[theme]);
    }
    paint(choice);
  }

  function choose(choice) {
    if (CHOICES.indexOf(choice) < 0) return;
    try { localStorage.setItem(STORAGE_KEY, choice); } catch (e) { /* private mode */ }
    apply(choice);
  }

  opts.forEach(function (btn) {
    btn.addEventListener('click', function () {
      choose(btn.getAttribute('data-theme-choice'));
    });
  });

  // While "system" is selected, follow the OS when it changes. Older Safari
  // only has addListener, so fall back to it.
  function onSystemChange() { if (savedChoice() === 'system') apply('system'); }
  if (mq.addEventListener) mq.addEventListener('change', onSystemChange);
  else if (mq.addListener) mq.addListener(onSystemChange);

  apply(savedChoice());

  // Exposed so the smoke test can drive the picker without clicking.
  window.SafePathTheme = {
    choose: choose,
    savedChoice: savedChoice,
    resolve: resolve,
    STORAGE_KEY: STORAGE_KEY,
  };
})();
