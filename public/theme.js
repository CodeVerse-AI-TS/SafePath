/* SafePath theme controller.
 *
 * Two themes: light and dark. The choice is saved in localStorage and applied as
 * data-theme on <html>, which is what styles.css keys off. The attribute is set
 * once more in a small inline script in <head> so a light-mode visitor never
 * sees a flash of the dark theme before this file loads.
 *
 * There is one button in the top bar. It shows the icon for the theme you would
 * switch to — a sun while dark is active, a moon while light is — and swaps the
 * two. The accessible name says the same thing, so it reads as an action.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'safepath-theme';
  var THEMES = ['light', 'dark'];
  var DEFAULT_THEME = 'dark';
  var THEME_COLOR = { light: '#f4f5f7', dark: '#101114' };
  var ACTION_LABEL = { light: 'Switch to dark theme', dark: 'Switch to light theme' };

  var root = document.documentElement;
  var button = document.getElementById('themeToggle');

  /** The saved theme, or the default when nothing is saved or it is unreadable. */
  function savedTheme() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return THEMES.indexOf(v) >= 0 ? v : DEFAULT_THEME;
    } catch (e) {
      return DEFAULT_THEME;
    }
  }

  /** The theme that clicking the button would move to. */
  function other(theme) {
    return theme === 'light' ? 'dark' : 'light';
  }

  function apply(theme) {
    // Only write when something actually changes. Setting this attribute
    // invalidates style for the whole document, because the light theme is
    // keyed off html[data-theme], and a needless restyle at load is enough to
    // disturb the page's entry animation.
    if (root.getAttribute('data-theme') !== theme) root.setAttribute('data-theme', theme);
    // Keep the browser UI in step with the page.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && meta.getAttribute('content') !== THEME_COLOR[theme]) {
      meta.setAttribute('content', THEME_COLOR[theme]);
    }
    if (button) {
      var label = ACTION_LABEL[theme];
      if (button.getAttribute('aria-label') !== label) {
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
      }
    }
  }

  function choose(theme) {
    if (THEMES.indexOf(theme) < 0) return;
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) { /* private mode */ }
    apply(theme);
  }

  if (button) {
    button.addEventListener('click', function () {
      choose(other(root.getAttribute('data-theme')));
    });
  }

  apply(savedTheme());

  // Exposed so the smoke test can drive the toggle without clicking.
  window.SafePathTheme = {
    choose: choose,
    savedTheme: savedTheme,
    other: other,
    STORAGE_KEY: STORAGE_KEY,
  };
})();
