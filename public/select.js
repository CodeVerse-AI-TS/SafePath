/* ==========================================================================
   SafePath — premium floating glass select
   --------------------------------------------------------------------------
   Progressive enhancement for native <select> elements. The real <select> stays
   in the DOM (hidden, still scriptable) and remains the single source of truth:
   the custom listbox writes back to it and dispatches a `change` event, so every
   existing handler, form read and test keeps working unchanged.

   Implements the ARIA "select-only combobox" pattern:
   https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-select-only/
   ========================================================================== */
'use strict';

(function () {
  const CHEVRON =
    '<svg class="custom-select__chevron" viewBox="0 0 12 8" width="12" height="8" aria-hidden="true" focusable="false">' +
    '<path d="M1 1.5 6 6.5l5-5" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  let uid = 0;

  function optionLabel(opt) {
    return (opt.label || opt.textContent || '').trim();
  }

  /** Nearest ancestor that clips overflow — the panel must escape it to float. */
  function clippingAncestor(el) {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/(hidden|auto|scroll|clip)/.test(s.overflowY + s.overflowX)) return n;
    }
    return null;
  }

  function create(select) {
    if (select.dataset.glassSelect === 'on') return null;
    select.dataset.glassSelect = 'on';

    const id = select.id || 'glass-select-' + ++uid;
    const listId = id + '-listbox';
    const label = document.querySelector('label[for="' + id + '"]');

    // The real control is hidden but stays in the DOM so scripts and tests can
    // still read `.value` and dispatch `change`.
    select.classList.add('report-select--native');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;

    const wrap = document.createElement('div');
    wrap.className = 'custom-select';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select__trigger';
    trigger.id = id + '-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', listId);
    trigger.innerHTML =
      '<span class="custom-select__value"></span>' +
      '<span class="custom-select__caret">' + CHEVRON + '</span>';

    const menu = document.createElement('ul');
    menu.className = 'custom-select__menu';
    menu.id = listId;
    menu.setAttribute('role', 'listbox');
    menu.tabIndex = -1;

    // A visible label names both the combobox and its listbox. Labels in this
    // app have no id of their own, so mint one when needed.
    if (label) {
      if (!label.id) label.id = id + '-label';
      trigger.setAttribute('aria-labelledby', label.id + ' ' + trigger.id);
      menu.setAttribute('aria-labelledby', label.id);
    } else {
      trigger.setAttribute('aria-label', optionLabel(select.options[select.selectedIndex]) || 'Choose an option');
    }

    const valueEl = trigger.querySelector('.custom-select__value');

    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    wrap.appendChild(trigger);
    wrap.appendChild(menu);

    let open = false;
    let active = select.selectedIndex;

    const options = () => Array.from(select.options);

    function syncTrigger() {
      const opt = select.options[select.selectedIndex];
      valueEl.textContent = opt ? optionLabel(opt) : '';
      // Mirror the native title so long values are readable when truncated.
      trigger.title = opt ? optionLabel(opt) : '';
    }

    function buildMenu() {
      menu.innerHTML = options().map((opt, i) => {
        const selected = i === select.selectedIndex;
        return (
          '<li class="custom-select__option" role="option" id="' + listId + '-opt' + i + '" ' +
          'aria-selected="' + selected + '" data-idx="' + i + '">' +
          '<span class="custom-select__optionLabel">' + escapeHtml(optionLabel(opt)) + '</span>' +
          '</li>'
        );
      }).join('');
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    }

    function markActive(i, { scroll = true } = {}) {
      active = i;
      const nodes = menu.querySelectorAll('.custom-select__option');
      nodes.forEach((n, idx) => n.classList.toggle('is-active', idx === i));
      const cur = nodes[i];
      if (cur) {
        trigger.setAttribute('aria-activedescendant', cur.id);
        if (scroll) cur.scrollIntoView({ block: 'nearest' });
      }
    }

    /** Keep the floating panel inside the viewport: flip up, then clamp across. */
    function place() {
      menu.style.maxWidth = '';
      const r = trigger.getBoundingClientRect();
      const gap = 8;
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const menuH = menu.offsetHeight;
      const below = vh - r.bottom - gap;
      const above = r.top - gap;
      const dropUp = below < Math.min(menuH, 200) && above > below;

      menu.style.top = dropUp ? 'auto' : 'calc(100% + ' + gap + 'px)';
      menu.style.bottom = dropUp ? 'calc(100% + ' + gap + 'px)' : 'auto';
      menu.classList.toggle('custom-select__menu--up', dropUp);

      // Horizontal: never let the panel leave the viewport.
      const width = Math.min(r.width, vw - 16);
      menu.style.minWidth = width + 'px';
      menu.style.left = '0';
      menu.style.right = 'auto';
      const left = r.left;
      if (left + width > vw - 8) {
        menu.style.left = 'auto';
        menu.style.right = '0';
      }
    }

    function show() {
      if (open) return;
      open = true;
      buildMenu();
      trigger.setAttribute('aria-expanded', 'true');
      wrap.classList.add('is-open');
      place();
      markActive(select.selectedIndex);
      // Re-measure after the browser has laid the panel out.
      requestAnimationFrame(() => { if (open) place(); });
    }

    function hide() {
      if (!open) return;
      open = false;
      trigger.setAttribute('aria-expanded', 'false');
      // The panel stays in the DOM; CSS fades it out and then removes it from
      // hit-testing, so closing never delays the next interaction.
      wrap.classList.remove('is-open');
      trigger.removeAttribute('aria-activedescendant');
    }

    function choose(i) {
      if (i < 0 || i >= select.options.length) return;
      if (select.selectedIndex !== i) {
        select.selectedIndex = i;
        // The existing app listens for `change` on the native select.
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      syncTrigger();
      hide();
      trigger.focus();
    }

    function move(delta) {
      const n = select.options.length;
      if (!n) return;
      let i = active;
      for (let step = 0; step < n; step++) {
        i = (i + delta + n) % n;
        if (!select.options[i].disabled) break;
      }
      markActive(i);
    }

    // --- events ---------------------------------------------------------
    trigger.addEventListener('click', (e) => { e.stopPropagation(); open ? hide() : show(); });

    trigger.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          e.preventDefault();
          if (!open) { show(); return; }
          move(e.key === 'ArrowDown' ? 1 : -1);
          break;
        }
        case 'Enter':
        case ' ':
          e.preventDefault();
          open ? choose(active) : show();
          break;
        case 'Escape':
          if (open) { e.preventDefault(); hide(); }
          break;
        case 'Home':
          if (open) { e.preventDefault(); markActive(0); }
          break;
        case 'End':
          if (open) { e.preventDefault(); markActive(select.options.length - 1); }
          break;
        case 'Tab':
          hide();
          break;
        default:
          // Typeahead: jump to the next option starting with the typed letter.
          if (open && e.key.length === 1 && /\S/.test(e.key)) {
            const n = select.options.length;
            const key = e.key.toLowerCase();
            for (let s = 1; s <= n; s++) {
              const i = (active + s) % n;
              if (optionLabel(select.options[i]).toLowerCase().startsWith(key)) {
                e.preventDefault();
                markActive(i);
                break;
              }
            }
          }
      }
    });

    menu.addEventListener('click', (e) => {
      const li = e.target.closest('.custom-select__option');
      if (li) choose(Number(li.dataset.idx));
    });

    // Pointer hover only previews the active row; it never moves the option.
    menu.addEventListener('mousemove', (e) => {
      const li = e.target.closest('.custom-select__option');
      if (li) markActive(Number(li.dataset.idx), { scroll: false });
    });

    document.addEventListener('click', (e) => {
      if (open && !wrap.contains(e.target)) hide();
    });

    // The native select can still change out of band (tests, scripts, forms).
    select.addEventListener('change', syncTrigger);

    window.addEventListener('resize', () => { if (open) place(); });
    window.addEventListener('scroll', () => { if (open) place(); }, true);

    // Cards clip their content; the floating panel needs to escape that.
    const clipper = clippingAncestor(trigger);
    if (clipper) clipper.classList.add('has-floating-panel');

    syncTrigger();
    return { refresh: syncTrigger, close: hide, wrap, trigger, menu };
  }

  function init() {
    const api = [];
    document.querySelectorAll('select[data-glass-select]').forEach((sel) => {
      const c = create(sel);
      if (c) api.push(c);
    });
    return api;
  }

  window.SafePathSelect = { init };

  // Enhance as soon as the markup exists. app.js binds its `change` handlers on
  // its own DOMContentLoaded, which fires after this one; either order works
  // because the real <select> is never removed.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
