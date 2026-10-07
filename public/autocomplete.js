/* ==========================================================================
   SafePath place autocomplete (combobox)
   --------------------------------------------------------------------------
   A single reusable widget, used by both the route form ("From"/"To") and the
   map overlay search. It owns one text input and one dropdown listbox.

   Behaviours required by the brief, and where they live:
     - 2-3 char minimum, 300 ms debounce ............ MIN_CHARS, DEBOUNCE_MS
     - AbortController + out-of-order guard ......... fetchSuggestions()
     - up to 6 suggestions .......................... LIMIT
     - icon + bold name + smaller secondary ......... renderRow()
     - matched text highlighted ..................... highlight()
     - Current location / recents / saved places .... staticRows()
     - "Current location" resolves to a real name .. opts.placeName (commit())
     - coordinate paste as a suggestion ............. coordRow()
     - safety hint, "No safety data" ................ safetyChip()
     - keyboard + ARIA combobox ..................... onKeyDown(), setActive()
     - loading / no-results / offline states ........ renderStatus()
     - touch rows >= 44px, closes on outside tap .... styles.css .ac__row
     - debounce + abort (no stale results) .......... schedule()
   ========================================================================== */
'use strict';

(function () {
  const MIN_CHARS = 2;
  const DEBOUNCE_MS = 300;
  const LIMIT = 6;
  const RECENTS_MAX = 5;
  const RECENTS_KEY = 'safepath.recentSearches.v1';
  const SAVED_KEY = 'safepath.savedPlaces.v1';
  const LS_AVAILABLE = (() => {
    try { window.localStorage.setItem('__sp', '1'); window.localStorage.removeItem('__sp'); return true; }
    catch { return false; }
  })();

  /* ------------------------------- storage ------------------------------ */
  function readLS(key, fallback) {
    if (!LS_AVAILABLE) return fallback;
    try {
      const raw = window.localStorage.getItem(key);
      const v = raw ? JSON.parse(raw) : fallback;
      return v == null ? fallback : v;
    } catch { return fallback; }
  }
  function writeLS(key, value) {
    if (!LS_AVAILABLE) return;
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
  }

  /** Recent selections, most-recent first, de-duplicated, max 5. */
  function recentList() {
    const arr = readLS(RECENTS_KEY, []);
    return Array.isArray(arr) ? arr.filter((r) => r && r.name && isFinite(r.lat) && isFinite(r.lng)).slice(0, RECENTS_MAX) : [];
  }
  function pushRecent(place) {
    const key = String(place.name).toLowerCase();
    const next = [place, ...recentList().filter((r) => String(r.name).toLowerCase() !== key)].slice(0, RECENTS_MAX);
    writeLS(RECENTS_KEY, next);
  }
  function clearRecents() { writeLS(RECENTS_KEY, []); }

  function savedList() {
    const s = readLS(SAVED_KEY, null);
    if (s && Array.isArray(s) && s.length) return s;
    // Seed Home / Work once so the section is never empty on first run.
    const defaults = [{ name: 'Home', kind: 'saved', icon: 'home', lat: null, lng: null }];
    return defaults;
  }

  /** How often a place has been picked before (boosts ranking). */
  function pastFrequency() {
    const freq = {};
    recentList().forEach((r, i) => {
      const k = String(r.name).toLowerCase();
      freq[k] = (freq[k] || 0) + (RECENTS_MAX - i);
    });
    return freq;
  }

  /* ------------------------------ geometry ------------------------------ */
  const isFiniteNum = (n) => typeof n === 'number' && isFinite(n);

  /** "12.9716, 77.5946" (or with spaces / ;) -> { lat, lng } or null. */
  function parseCoords(text) {
    const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(String(text || ''));
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }

  function distanceM(a, b) {
    if (!a || !b || !isFiniteNum(a.lat) || !isFiniteNum(b.lat)) return null;
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const fmtDistance = (m) => {
    if (m == null) return '';
    if (m < 950) return Math.round(m / 10) * 10 + ' m';
    return (m / 1000).toFixed(m < 9500 ? 1 : 0) + ' km';
  };

  /* -------------------------------- icons ------------------------------- */
  // Inline SVG keeps the widget dependency-free and lets the icon inherit the
  // current colour. 16px box, stroke-based, matching the app's line style.
  const ICONS = {
    locate: '<circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2"/>',
    place: '<path d="M8 14s5-4.2 5-8A5 5 0 0 0 3 6c0 3.8 5 8 5 8z"/><circle cx="8" cy="6" r="1.6"/>',
    station: '<rect x="4" y="2.5" width="8" height="9" rx="2"/><path d="M4 8h8M6.5 14l1-2.5M9.5 14l-1-2.5"/>',
    landmark: '<path d="M2.5 13h11M4 13V6.5l4-3 4 3V13M6.5 13V9.5h3V13"/>',
    address: '<path d="M3 13.5h10M4.5 13.5V4a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 11.5 4v9.5M6.5 6h3M6.5 8.5h3"/>',
    home: '<path d="M2.5 7.5 8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5z"/>',
    work: '<rect x="2.5" y="5.5" width="11" height="8" rx="1.5"/><path d="M6 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5"/>',
    clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.8V8l2.2 1.4"/>',
    pin: '<path d="M8 14s5-4.2 5-8A5 5 0 0 0 3 6c0 3.8 5 8 5 8z"/><circle cx="8" cy="6" r="1.4"/>',
    close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  };
  function icon(name) {
    return `<svg class="ac__icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"
      fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
      stroke-linejoin="round">${ICONS[name] || ICONS.place}</svg>`;
  }

  const CATEGORY_ICON = { place: 'place', station: 'station', landmark: 'landmark', address: 'address' };

  /* ------------------------------ highlighting -------------------------- */
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /**
   * Escape `text` and wrap the [start, start+length) slice in <mark>. The slice
   * comes from the server's match offsets, so no matching happens here.
   */
  function highlight(text, start, length) {
    const t = String(text == null ? '' : text);
    if (!(start >= 0) || !(length > 0) || start >= t.length) return escapeHtml(t);
    const end = Math.min(t.length, start + length);
    return escapeHtml(t.slice(0, start)) +
      '<mark class="ac__mark">' + escapeHtml(t.slice(start, end)) + '</mark>' +
      escapeHtml(t.slice(end));
  }

  /* ------------------------------- widget ------------------------------- */
  const instances = [];

  /**
   * @param {object} opts
   * @param {string} opts.inputId      id of the text input
   * @param {string} [opts.label]      accessible label used in announcements
   * @param {() => ({lat,lng})} [opts.near]      bias origin (map centre / user)
   * @param {() => ({lat,lng})} [opts.myLocation] the device's own position, if known
   * @param {(place) => void} [opts.onSelect]    called with the chosen place
   * @param {(text) => void} [opts.onClear]      called when the field is emptied
   * @param {boolean} [opts.safety]    request safety hints for suggestions
   * @param {() => string} [opts.time] departure time for the hint
   * @param {string} [opts.extraClass] extra class on the dropdown
   * @param {(lat:number, lng:number) => Promise<string|null>} [opts.placeName]
   *        turns a resolved position into a real place name, so "Current
   *        location" is replaced by where the user actually is.
   */
  function create(opts) {
    const input = document.getElementById(opts.inputId);
    if (!input) return null;

    // The input lives inside a relatively-positioned wrapper so the dropdown
    // can be absolutely positioned under it (and escape the map's overflow).
    const wrap = document.createElement('div');
    wrap.className = 'ac';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const list = document.createElement('ul');
    list.className = 'ac__list';
    list.id = opts.inputId + 'Listbox';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    if (opts.extraClass) list.classList.add(opts.extraClass);
    wrap.appendChild(list);

    // ARIA combobox wiring on the input itself.
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');

    const status = document.createElement('div');
    status.className = 'sr-only';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    wrap.appendChild(status);

    const st = {
      rows: [],          // { kind, place?, id }
      active: -1,
      open: false,
      error: null,
      query: '',
      debounceTimer: null,
      controller: null,
      seq: 0,            // request sequence; only the newest may render
    };

    /* --------------------------- rendering --------------------------- */

    function rowId(i) { return `${opts.inputId}-opt-${i}`; }

    function renderRow(row, i) {
      const active = i === st.active;
      const common = `id="${rowId(i)}" role="option" aria-selected="${active}" class="ac__row${active ? ' is-active' : ''}" data-idx="${i}"`;
      if (row.kind === 'status') {
        return `<li class="ac__row ac__row--status" role="presentation">${row.html}</li>`;
      }
      if (row.kind === 'clear-recents') {
        return `<li class="ac__row ac__row--action" role="presentation">
          <button type="button" class="ac__clear" data-action="clear-recents">${icon('close')}Clear recent searches</button></li>`;
      }
      const p = row.place;
      const ic = row.kind === 'current' ? 'locate'
        : row.kind === 'recent' ? 'clock'
          : row.kind === 'saved' ? (p.icon || 'pin')
            : (CATEGORY_ICON[p.category] || 'place');
      const m = p.match || { start: -1, length: 0, field: null };
      const primary = (m.field === 'primary')
        ? highlight(p.name, m.start, m.length)
        : escapeHtml(p.name);
      const secondaryText = p.secondary || '';
      const secondary = (m.field === 'secondary')
        ? highlight(secondaryText, m.start, m.length)
        : escapeHtml(secondaryText);

      const bits = [];
      if (secondary) bits.push(secondary);
      if (row.kind !== 'current' && p.distance_m != null) bits.push(fmtDistance(p.distance_m) + ' away');
      if (row.hint) bits.push(row.hint);

      const safety = row.safety
        ? `<span class="ac__safety ac__safety--${row.safety.level}">${escapeHtml(row.safety.text)}</span>`
        : '';

      return `<li ${common} class="ac__row${active ? ' is-active' : ''}">
        <span class="ac__ic ac__ic--${row.kind}">${icon(ic)}</span>
        <span class="ac__text">
          <span class="ac__name">${primary}</span>
          ${bits.length ? `<span class="ac__sub">${bits.join(' · ')}</span>` : ''}
        </span>
        ${safety}
      </li>`;
    }

    function render() {
      if (!st.rows.length) { close(); return; }
      list.innerHTML = st.rows.map(renderRow).join('');
      list.hidden = false;
      wrap.classList.add('is-open');
      input.setAttribute('aria-expanded', 'true');
      st.open = true;
      setActive(st.active, { scroll: false });
    }

    function renderStatus(html) {
      st.rows = [{ kind: 'status', html }];
      st.active = -1;
      render();
    }

    function close() {
      // Invalidate any in-flight request. Without this a slow geocode response
      // landing after the user pressed Escape would pass the out-of-order guard
      // and re-open the panel they just dismissed.
      st.seq++;
      if (st.controller) st.controller.abort();
      if (st.debounceTimer) { clearTimeout(st.debounceTimer); st.debounceTimer = null; }
      list.hidden = true;
      wrap.classList.remove('is-open');
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      st.open = false;
      st.active = -1;
    }

    function announce(msg) { status.textContent = msg; }

    function setActive(i, { scroll = true } = {}) {
      const selectable = st.rows.map((r, idx) => (r.kind === 'status' || r.kind === 'clear-recents' ? -1 : idx)).filter((x) => x >= 0);
      if (!selectable.length) { st.active = -1; input.removeAttribute('aria-activedescendant'); return; }
      let next = i;
      if (next < 0) next = selectable[selectable.length - 1];
      if (next >= st.rows.length) next = selectable[0];
      if (selectable.indexOf(next) === -1) next = selectable[0];
      st.active = next;
      input.setAttribute('aria-activedescendant', rowId(next));
      Array.from(list.children).forEach((li, idx) => {
        const on = idx === next;
        li.classList.toggle('is-active', on);
        if (li.getAttribute('role') === 'option') li.setAttribute('aria-selected', String(on));
      });
      if (scroll) {
        const el = list.querySelector('.is-active');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      }
      const row = st.rows[next];
      if (row && row.place) {
        announce(`${row.place.name}${row.place.secondary ? ', ' + row.place.secondary : ''}${row.safety ? ', ' + row.safety.text : ''}`);
      }
    }

    /* ---------------------------- data rows -------------------------- */

    function currentLocationRow() {
      // The device position, not the search bias (which may just be the map
      // centre). When it is unknown the row carries no coordinates, and
      // selectRow() resolves them with a live geolocation request.
      const here = opts.myLocation ? opts.myLocation() : null;
      return {
        kind: 'current',
        place: {
          name: 'Current location',
          secondary: 'Use where you are now',
          lat: here ? here.lat : null,
          lng: here ? here.lng : null,
          category: 'place',
          isCurrent: true,
        },
      };
    }

    function staticRows() {
      const rows = [currentLocationRow()];
      const recents = recentList();
      recents.forEach((r) => rows.push({ kind: 'recent', place: { ...r, category: r.category || 'place' } }));
      if (recents.length) rows.push({ kind: 'clear-recents' });
      savedList().forEach((s) => rows.push({ kind: 'saved', place: { ...s, category: 'place' } }));
      return rows;
    }

    /** A pasted "lat, lng" becomes a real, selectable suggestion. */
    function coordRow(text) {
      const c = parseCoords(text);
      if (!c) return null;
      return {
        kind: 'coord',
        place: {
          name: `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`,
          secondary: 'Coordinates',
          lat: c.lat,
          lng: c.lng,
          category: 'address',
          isCoords: true,
        },
      };
    }

    /* ----------------------------- fetching --------------------------- */

    function fetchSuggestions(q, seq) {
      // Cancel any in-flight request: the user has typed more.
      if (st.controller) st.controller.abort();
      const controller = new AbortController();
      st.controller = controller;

      const near = opts.near ? opts.near() : null;
      const params = new URLSearchParams({ q, limit: String(LIMIT) });
      if (near && isFiniteNum(near.lat)) { params.set('lat', near.lat.toFixed(5)); params.set('lng', near.lng.toFixed(5)); }
      if (opts.safety) params.set('safety', '1');
      if (opts.safety && opts.time) params.set('time', opts.time());

      const url = (window.SAFEPATH_API || '').replace(/\/$/, '') + '/api/places/suggest?' + params.toString();

      // Distinguish "the user typed again" (silent, a newer request wins) from
      // "we waited too long" (must be shown, or the row says "Searching…"
      // forever). Both surface as an AbortError, so track the reason.
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 8000);

      return fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
        .then((res) => res.json().then((body) => ({ ok: res.ok, status: res.status, body })))
        .then(({ ok, status, body }) => {
          // Out-of-order guard: a newer keystroke has already superseded us.
          if (seq !== st.seq) return;
          clearTimeout(timeout);
          if (!ok) {
            st.error = (body && (body.error || body.detail)) || `Search failed (${status})`;
            renderStatus(status === 429
              ? 'Too many searches just now — pause a moment and keep typing.'
              : `Search unavailable: ${escapeHtml(st.error)}`);
            return;
          }
          st.error = null;
          const sugg = body.suggestions || [];
          if (!sugg.length) {
            // A pasted coordinate pair is a valid answer even when the provider
            // has nothing for that text, so keep it at the top of the list.
            const keep = coordRow(st.query);
            const rows = keep ? [keep] : [];
            rows.push({
              kind: 'status',
              html: `No results for “${escapeHtml(q)}”. Try a nearby landmark, or paste coordinates like 12.31,76.66.`,
            });
            st.rows = rows;
            st.active = keep ? 0 : -1;
            render();
            return;
          }
          st.rows = sugg.map((p) => ({ kind: 'suggestion', place: p, safety: p.safety || null }));
          st.active = 0;
          render();
          announce(`${sugg.length} suggestion${sugg.length === 1 ? '' : 's'} available`);
        })
        .catch((err) => {
          if (seq !== st.seq) return;
          clearTimeout(timeout);
          if (err && err.name === 'AbortError') {
            if (timedOut) renderStatus('Search timed out — check your connection and try again.');
            return; // otherwise superseded: a newer request owns the list
          }
          renderStatus('Offline — could not reach SafePath search. Check your connection.');
        });
    }

    /** Debounced entry point for a keystroke. */
    function schedule() {
      const raw = input.value;
      const q = raw.trim();
      st.query = q;
      clearTimeout(st.debounceTimer);

      // An emptied field returns to the static list (recents / saved / here).
      if (!q) {
        if (opts.onClear) opts.onClear('');
        showStatic();
        return;
      }

      // A pasted coordinate pair is a suggestion in its own right, shown
      // immediately and always first, before any network call.
      const coord = coordRow(q);

      if (q.length < MIN_CHARS) {
        if (coord) { st.rows = [coord]; st.active = 0; render(); return; }
        close();
        return;
      }

      st.error = null;
      const seq = ++st.seq;

      // Keep the coordinate row visible while the search runs, so the user can
      // act on it without waiting for the network.
      const loadingRow = { kind: 'status', html: '<span class="spinner"></span>Searching…' };
      st.rows = coord ? [coord, loadingRow] : [loadingRow];
      st.active = coord ? 0 : -1;
      render();

      st.debounceTimer = setTimeout(() => { fetchSuggestions(q, seq); }, DEBOUNCE_MS);
    }

    function showStatic() {
      st.rows = staticRows();
      st.active = 0;
      render();
    }

    /* ---------------------------- selection --------------------------- */

    function selectRow(i) {
      const row = st.rows[i];
      if (!row || row.kind === 'status' || row.kind === 'clear-recents') return;

      if (row.kind === 'current' && (!isFiniteNum(row.place.lat))) {
        // Resolve geolocation lazily, only when actually chosen.
        announce('Finding your location…');
        renderStatus('<span class="spinner"></span>Finding your location…');
        if (!navigator.geolocation) { renderStatus('Geolocation is not available in this browser.'); return; }
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const p = { ...row.place, lat: pos.coords.latitude, lng: pos.coords.longitude };
            commit(p);
          },
          (err) => renderStatus('Could not get your location: ' + escapeHtml(err.message || 'permission denied')),
          { enableHighAccuracy: true, timeout: 8000 }
        );
        return;
      }
      commit(row.place);
    }

    function commit(place) {
      // "Current location" carries no name of its own — show where the user
      // actually is instead of the literal label. The coordinates are stored
      // first, so the field stays usable even if the lookup is slow or fails.
      if (place.isCurrent && isFiniteNum(place.lat) && isFiniteNum(place.lng)) {
        const lat = place.lat;
        const lng = place.lng;
        input.value = 'Current location';
        input.dataset.lat = String(lat);
        input.dataset.lng = String(lng);
        close();
        announce('Selected Current location');
        if (opts.onSelect) opts.onSelect({ ...place, name: 'Current location' });
        if (opts.placeName) {
          Promise.resolve(opts.placeName(lat, lng)).then((label) => {
            if (!label) return;
            // Only replace the label while the field still holds this position.
            if (input.dataset.lat === String(lat) && input.dataset.lng === String(lng)) {
              input.value = label;
              announce(`Selected ${label}`);
            }
          }).catch(() => { /* keep the coordinates as the label */ });
        }
        return;
      }

      const label = place.isCoords ? place.name : (place.name || '');
      input.value = label;
      // Store the coordinates so the route search needs no second geocode.
      input.dataset.lat = String(place.lat);
      input.dataset.lng = String(place.lng);
      if (!place.isCurrent) {
        pushRecent({
          name: place.name, secondary: place.secondary || null,
          lat: place.lat, lng: place.lng, category: place.category || 'place',
        });
      }
      close();
      announce(`Selected ${place.name}`);
      if (opts.onSelect) opts.onSelect(place);
    }

    /**
     * The current selection's coordinates, or coordinates parsed from the text.
     * Returns null when the text is free-form (the server will geocode it).
     */
    function coords() {
      const lat = parseFloat(input.dataset.lat);
      const lng = parseFloat(input.dataset.lng);
      if (isFinite(lat) && isFinite(lng)) return { lat, lng };
      return parseCoords(input.value.trim());
    }

    /* ----------------------------- keyboard --------------------------- */

    function onKeyDown(e) {
      const isOpen = st.open;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (!isOpen) {
            // Closed: with text, open as soon as results arrive; with an empty
            // field, open the static list (current location / recents / saved).
            if (input.value.trim()) { schedule(); return; }
            showStatic();
          }
          setActive(st.active + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (isOpen) setActive(st.active - 1);
          break;
        case 'Home':
          if (isOpen) { e.preventDefault(); setActive(0); }
          break;
        case 'End':
          if (isOpen) {
            const last = st.rows.length - 1;
            e.preventDefault();
            setActive(last);
          }
          break;
        case 'Enter':
          if (isOpen && st.active >= 0) {
            e.preventDefault();
            selectRow(st.active);
          } else if (isOpen) {
            close();
          }
          // If closed, let the field's own Enter handler run (plan / focus next).
          break;
        case 'Escape':
          if (isOpen) { e.preventDefault(); close(); announce('Suggestions closed'); }
          break;
        case 'Tab':
          // Leaving the field commits nothing; just close so the list does not
          // float over the next control.
          close();
          break;
        default:
          break;
      }
    }

    /* ------------------------------ events ---------------------------- */

    input.addEventListener('input', () => {
      // Any keystroke invalidates a stored coordinate: the text no longer
      // describes the place the coordinates came from.
      delete input.dataset.lat;
      delete input.dataset.lng;
      schedule();
    });

    input.addEventListener('keydown', onKeyDown);

    input.addEventListener('focus', () => {
      if (!input.value.trim()) showStatic();
      else if (st.rows.length && !st.open) render();
    });

    input.addEventListener('click', () => {
      if (!input.value.trim()) showStatic();
      else if (st.rows.length && !st.open) render();
    });

    // Mouse / touch selection. pointerdown (not click) so it wins the race
    // against the input's blur.
    list.addEventListener('pointerdown', (e) => {
      const clearBtn = e.target.closest('[data-action="clear-recents"]');
      if (clearBtn) {
        e.preventDefault();
        clearRecents();
        showStatic();
        announce('Recent searches cleared');
        return;
      }
      const li = e.target.closest('.ac__row');
      if (!li || li.classList.contains('ac__row--status')) return;
      const idx = parseInt(li.dataset.idx, 10);
      if (!isFinite(idx)) return;
      e.preventDefault();
      selectRow(idx);
    });

    // Outside tap / click closes the dropdown.
    function onDocPointerDown(e) {
      if (!st.open) return;
      if (!wrap.contains(e.target)) close();
    }
    document.addEventListener('pointerdown', onDocPointerDown, true);

    // Escape anywhere in the page also closes it.
    function onDocKeyDown(e) {
      if (e.key === 'Escape' && st.open) close();
    }
    document.addEventListener('keydown', onDocKeyDown);

    // Keep the dropdown aligned while the page scrolls or resizes.
    function onReposition() { if (st.open) list.style.maxWidth = input.offsetWidth + 'px'; }
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);

    const api = {
      input,
      list,
      wrap,
      close,
      open: () => { if (st.rows.length) render(); else showStatic(); },
      showStatic,
      coords,
      /** Fill the field from outside (e.g. "use my location" button). */
      setValue: (text, lat, lng) => {
        input.value = text;
        if (isFiniteNum(lat) && isFiniteNum(lng)) {
          input.dataset.lat = String(lat);
          input.dataset.lng = String(lng);
        }
        close();
      },
      clear: () => { input.value = ''; delete input.dataset.lat; delete input.dataset.lng; },
      destroy: () => {
        document.removeEventListener('pointerdown', onDocPointerDown, true);
        document.removeEventListener('keydown', onDocKeyDown);
        window.removeEventListener('resize', onReposition);
        window.removeEventListener('scroll', onReposition, true);
      },
      /** Exposed for tests. */
      _state: st,
      _parseCoords: parseCoords,
      _highlight: highlight,
    };
    instances.push(api);
    return api;
  }

  window.SafePathAutocomplete = {
    create,
    parseCoords,
    highlight,
    recentList,
    clearRecents,
    pushRecent,
    savedList,
    pastFrequency,
    CATEGORY_ICON,
    icon,
    instances,
    MIN_CHARS,
    DEBOUNCE_MS,
    LIMIT,
  };
})();
