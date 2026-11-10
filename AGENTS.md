# AGENTS.md — SafePath

SafePath predicts the **safer walking route** between two places. Vanilla JS +
Leaflet frontend, Node/Express + SQLite backend, a pure-JS data-science build.
Default city is **Mysuru** (migrated from Bengaluru).

## Commands

```bash
npm run bootstrap      # seed (synthetic) + build hotspots/model — run after clone
npm start              # API + static frontend on PORT (default 3000)
npm test               # offline unit tests (risk function, ranker) — no network
npm run test:acceptance  # end-to-end against a RUNNING server (BASE=... to override)
npm run test:map       # headless-Chromium checks: maps render, routes draw, 320px
npm run test:coverage  # headless-Chromium: no-data areas, long walks, time-of-day
npm run test:interaction # headless-Chromium: every control, report flow, live feed
npm run test:autocomplete # headless-Chromium: search dropdown, debounce, keyboard, 320px
npm run import -- f.csv  # import real incidents from CSV
```

`npm run seed` clears previous community reports unless `--keep-reports` is passed.

## Layout

| Path | Role |
|---|---|
| `server/lib/risk.js` | Risk model: `riskAt`, `riskGrid`, `coverageBbox`, `featuresInBbox`, `inCoverage`, `reload`, `getCache` |
| `server/lib/routing.js` | `planRoutes`, `scoreRoute` (coverage-aware), `explainRoute`, `serialiseRoute` |
| `server/lib/db.js` | SQLite schema + migrations. Add new columns via the `PRAGMA table_info` pattern, not just the CREATE TABLE |
| `ds/build.js` | DBSCAN over haversine → `data/hotspots.json`, `data/model.json`, `public/hotspots.json`; trains the logistic-regression baseline |
| `public/app.js` | All frontend logic. Map section starts at the `/* maps */` banner |
| `public/autocomplete.js` | The combobox widget (`window.SafePathAutocomplete.create`) used by both From/To and the map overlay search. Pure helpers are exposed for tests |
| `server/lib/places.js` | Autocomplete provider proxy (Photon default; Geoapify/Mapbox keyed). SQLite-cached 24h, one retry on 429/5xx |
| `server/lib/place_rank.js` | Pure ranking + text matching + `safetyHint`. Unit tested in `test/places.test.js` |
| `server/routes/places.js` | `/api/places/suggest` and `/api/places/status` |
| `public/styles.css` | Map heights live in the `/* map */` block; dropdown styles in the `/* autocomplete */` block |

## Gotchas worth remembering

- **Leaflet needs an explicit container height.** `#map, #map2, #map3, #map4`
  are sized in CSS (400px mobile-first → 70vh/min 560px desktop). A map created
  while its tab is hidden measures a 0px box, so `selectTab()` calls
  `invalidateSize()` on tab open, plus there is a window-resize handler and a
  re-fit after routes render. This was the original blank-map bug.
- **Each map has a `#mapFallbackN` panel** shown if Leaflet or the tiles fail, so
  a failure never looks like a blank map. `initMap()` returns `null` on failure —
  all callers must null-check.
- **`/api/coverage` returns a flat `[minLat, minLng, maxLat, maxLng]` array** (and
  `plan.coverage.bbox` is the same shape). Do not destructure it as nested pairs.
- **Coverage gating is deliberate.** A route is only scored if a majority of its
  samples fall inside the coverage bbox; otherwise it is marked `covered: false`
  and shown as "no safety data" rather than given a misleading score. Coverage is
  percentile-trimmed so one stray report cannot define the area.
- **Report feedback works but can be invisible at saturated spots.** `riskAt`
  saturates incident density in dense areas, so a new report may not move the
  number there; it does move it at quieter points (+9 observed at Kuvempunagar).
- **The risk cache self-heals on out-of-band writes.** `ctx()` compares SQLite's
  `PRAGMA data_version` and reloads when another connection has committed, so a
  re-seed or a test cleaning up its rows cannot leave stale counts behind. Keep
  `dataVersion` in the cache object if you touch `reload()`.
- **`test/*.smoke.js` need `puppeteer-core` + Chromium** and skip cleanly if
  absent. Set `CHROME_PATH` to override the binary.
- **The report rate limit is 5 per 10 min per IP, so back-to-back browser suites
  trip it.** `interaction.smoke.js` submits a report; if `test:coverage` or
  `test:acceptance` ran moments before, the POST returns 429 and two checks fail
  with "Too many requests". That is not a regression. Either leave ~10 min
  between full runs, or start the server with
  `SAFEPATH_REPORT_LIMIT=50 SAFEPATH_REPORT_WINDOW_MS=60000`.
- **Do not commit credentials.** The `package.json` `repository.url` had a
  GitHub token embedded in it; it is stripped. Check before committing.
- **Nominatim must never serve autocomplete.** Its usage policy forbids
  search-as-you-type. `/api/geocode` (one user-initiated resolve) may use it;
  suggestions go through `server/lib/places.js`. `/api/geocode/suggest` is a 307
  redirect to `/api/places/suggest` and must stay that way.
- **Photon is a free demo server and does rate-limit bursts.** The client retries
  a 429/5xx once after 350 ms, and results are cached in SQLite for 24 h. If you
  add load, self-host Photon (`PHOTON_URL`) or move to a keyed provider — do not
  raise the retry count.
- **The autocomplete Enter key is shared with the form.** The widget calls
  `preventDefault()` when it consumes Enter to pick a suggestion, so the form's
  `keydown` handlers must check `e.defaultPrevented` before planning a route.
  Otherwise selecting a place also fires a route search.
- **A pasted coordinate pair outranks an empty provider result.** When the
  provider returns nothing for text that parses as `lat, lng`, the coordinate row
  is kept at the top of the list rather than being replaced by "No results".
- **Suggestion ranking lives on the server, not the browser.** `textMatch()`
  returns `start`/`length`; the dropdown only escapes and wraps that slice. Do not
  re-implement matching in `public/autocomplete.js`.
- **The dropdown is positioned inside a `.ac` wrapper.** The widget inserts that
  wrapper around the input, so the list can be absolutely positioned and escape a
  map's `overflow: hidden`. Any new search field must be a bare `<input>`; the
  widget adds the wrapper itself.
- **The base design system is minified and ends with the charcoal theme.** The
  base sheet holds three `:root` blocks (paper, forest, charcoal); all three are
  top-level, so the last one (charcoal, `#101114`) wins. The reference is a
  marketing-site sheet, not the app's own; `public/styles.css` therefore keeps a
  "supplement" block after it that restores every component the app renders at
  runtime (route cards, feeds, hotspot list, charts, nav). Edit the supplement,
  not the base block.
- **`hidden` loses to the base sheet's own `display` rules.** The base sets
  `display:grid`/`flex` on `.sheet`, `.nav__alert`, `.nav__reroute`,
  `.nav__checkin`, `.nav__banner`, `.map-fallback`, etc. An element hidden by
  clearing its `hidden` attribute is *not* hidden when the class rule comes later
  with equal specificity. Every such component needs an explicit
  `.x[hidden] { display: none; }` guard in the supplement. A missing `.sheet`
  guard once left all four sheets on screen, swallowing every nav tap.
- **The nav stack is positioned by `--nav-panel-h`, plus its own bottom offset.**
  `nav.js` publishes only the panel's *height*; the stack must add the panel's
  own distance from the viewport edge (`--nav-panel-gap`, 24px / 12px under
  900px) or it tucks behind the panel. When the screen is too short for the
  stack, `nav.js` sets `data-overflow="more"` on `#navControls`; the panel then
  reserves a right-hand gutter (`.nav:has(...[data-overflow="more"])`) so the two
  cannot overlap. Do not delete `body.nav-active .app { display: none }` — the
  base sheet has no equivalent and the planner would stay visible under the map.

## Page navigation

- **One hash namespace drives every entry point.** `initTabs()` in `public/app.js`
  wires the tab strip, the two hero buttons, and every `a[data-tab-target]` /
  `a[href^="#page-"]` footer link through `navigateTab()` / `goToSection()`.
  Those two call the existing `selectTab()` and then `history.pushState` a hash:
  `#page-<tab>` for a tab, `#planner` / `#explore` for a hero section. `popstate`
  and `hashchange` both fire on Back, so `applyHash()` remembers the last applied
  hash (`appliedHash`) and ignores the duplicate.
- **A "section" is a tab plus an element inside it.** `SECTIONS` maps a section
  name to `{ tab, target() }`; `revealInSection()` scrolls that element into view
  after `selectTab()`'s 60ms map re-measure, and honours `prefers-reduced-motion`.
  The hero buttons are sections, not pages — do not add a second Route Finder.
- **The hero buttons once shipped with no handler at all.** `heroPlanBtn` and
  `heroExploreBtn` existed in `index.html` but nothing listened for a click, so a
  press did nothing — no tab change, no scroll, and no console error. That silent
  failure is what `test/home-nav.smoke.js` guards (20 checks, wired into
  `test:all` as `test:home-nav`).
- **Never call `selectTab()` directly from a user action.** Use `navigateTab()`
  so the URL stays in step and Back works; a direct call updates the view but
  leaves the hash stale, and the next Back/Forward desyncs the tabs.

## Live navigation

- **`public/nav_math.js` is shared, pure and dependency-free.** It is loaded both
  by the browser and by `require()` in the unit tests, so it must not touch the
  DOM, `window` (except the export), or the network. Any new geometry helper goes
  here so both sides stay in step.
- **`public/nav.js` owns the whole trip view.** It is loaded before `app.js` and
  reaches the planner through `window.SafePathApp` (`api`, `toast`, `sendAlert`,
  `onNavEnd`). Keep that coupling one-way: `nav.js` may call `SafePathApp`, but
  `app.js` must not reach into navigation internals beyond `SafePathNav.start()`
  and `SafePathNav.endTrip()`.
- **`#navScreen` must stay a direct child of `<body>`.** The trip view hides
  `.app` (and sets `aria-hidden` on it) while navigating, so nesting the nav
  section inside `.app` would hide the nav screen too. This was a real bug.
- **The map rotates via a wrapper, never via Leaflet's transform.** The rotor is
  `200vmax` and offset by half, so rotation about its centre keeps the viewport
  covered. Rotating a Leaflet container directly fights its own pan transforms.
- **`applyFix()` is the single entry point for a position.** Real GPS
  (`onFix` → `applyFix`) and the simulator (`emitSimFix` → `onFix`) share it, and
  the browser tests inject through `SafePathNav._injectFix`. Any new fix source
  must go through the same filter, snap and smoothing path.
- **`endTrip()` must set `state.active = false`.** `isActive()` is the flag the
  rest of the app reads; a trip that was ended but still reports active will keep
  accepting fixes.
- **Average speed is measured over the fixes, not wall-clock time.** A trip
  driven through a simulated feed would otherwise report hundreds of km/h. The
  guard also drops anything above 120 km/h.
- **Backward movement is allowed, but only past a tolerance.** GPS noise should
  not rewind progress, yet a user who turns around must see the remaining
  distance update. The tolerance scales with the fix accuracy.
- **Snapping searches a window, not just forward.** `SNAP_LOOKBACK` (30 segments)
  lets a user who turns around stay on the line; `SNAP_LOOKAHEAD` (25) stops a
  route that doubles back from dragging the arrow onto the return leg.
- **Hazard copy must not repeat itself.** A hotspot has a place name, but an
  unlit stretch has only a generic label, so the label is only appended when it
  adds information.
- **`HOTSPOT_PROXIMITY_M` (routing.js) is the only proximity radius.** The route
  cards and `buildHazards()` must both use it. They once differed (250 m on the
  card, 150 m in navigation), so a card could promise "1 hotspot near" and
  navigation then say nothing about it. Never hard-code a second radius.
- **The map controls and the SOS button share one flex column.** `#navControls`
  holds the orientation toggle, Recenter, Voice and SOS, in that order, and it is
  the only positioned element; no control may set its own `top`/`right`/`bottom`.
  Positioning them individually is what let SOS cover the third control. A test
  asserts no control overlaps another or the panel at six viewport widths.
- **The stack's bottom offset comes from the measured panel height.** `nav.js`
  publishes `--nav-panel-h` from a `ResizeObserver` on `#navBottom`, because the
  panel changes height with the compass, the End route button and the GPS line.
  Do not replace this with a hard-coded offset.
- **Short landscape screens collapse the controls into a "More" sheet.** When the
  stack cannot fit above the panel, `syncControlOverflow()` swaps the three map
  controls for one `#navMoreBtn` and keeps SOS. In that mode the panel is inset
  by a right-hand gutter (`@media (orientation: landscape) and (max-height: 620px)`)
  and the stack sits beside it, not above it — so a vertical clearance check does
  not apply there.
- **Live-navigation layering uses the `--z-*` tokens.** map < panel < banner <
  controls < modal. Do not add ad-hoc large z-index values to nav elements.
- **SOS stays protected against accidental taps.** It is a 2-second hold with a
  progress ring and `navigator.vibrate` haptics, and it keeps its `#navPanicHelp`
  description. Keep the hold — a single tap must never send an alert.
- **Navigation never touches location before Start.** A test asserts the planner
  makes zero geolocation calls, and that the watcher is released on arrival and on
  end. Do not add an eager `getCurrentPosition()`.
- **Run browser tests with `SAFEPATH_RATE_MULTIPLIER`.** The navigation flow
  makes many report/share calls; `SAFEPATH_RATE_MULTIPLIER=60 node server/index.js`
  keeps the limits in force in production while letting a test run through.

## Honesty requirements (do not regress)

- Every score is labelled "Estimate based on reported data, not a guarantee of
  safety." The seed data is labelled synthetic everywhere it is shown.
- No hard-coded insight strings in the "Why this route" panel — reasons are
  derived from route geometry, hotspots, and OSM features.
- Report coordinates are rounded to ~110 m (area level); no traces are stored.
- Hotspots describe reported data, never the people who live in an area.
- A suggestion outside the coverage bbox is labelled "No safety data", never
  given a risk score. The same rule as routes.
- Recents and saved places are `localStorage`-only and are never sent to the
  server; the autocomplete proxy receives only the query text and a coarse bias
  point.
- Navigation asks for location only after the user presses Start navigation, says
  so on the permission screen, and releases the watcher on arrival or end. No
  position trail is stored — a finished trip keeps a summary and area-level
  endpoints only.
- A live share link publishes an area-level position, states its own accuracy,
  expires, and can be stopped. Do not widen it to a precise position or a trail.

## Dropdowns (premium floating glass panels)

Every dropdown in the app shares one visual system, defined at the end of
`public/styles.css` and driven by the `--glass-*` tokens. Keep these in sync
when adding a control.

- **Custom selects are progressive enhancement.** `public/select.js` enhances any
  `<select data-glass-select>`: the real `<select>` stays in the DOM, is hidden
  with `.report-select--native` (absolute, 1px, `opacity:0`, `pointer-events:none`)
  and remains the single source of truth. The custom listbox writes
  `select.selectedIndex` and dispatches a bubbling `change`, so every existing
  handler, form read and test keeps working. Never remove the native select.
- **Why not a bare hidden select.** Tests call `page.select('#reportType', …)`
  and scripts set `.value` directly. Both still work because the element is in
  the DOM. `display:none` also works for `page.select`, but the class-based
  approach keeps the layout stable.
- **Panel visibility is class-driven, not `hidden`.** The menu is always laid out;
  `.custom-select.is-open .custom-select__menu` (and `.ac.is-open .ac__list`) flips
  `opacity`/`visibility`/`transform`. This is what lets both open *and* close
  animate. A `display:none` toggle would kill the transition — `autocomplete.js`
  still sets the `hidden` attribute, so `.ac__list[hidden] { display: block; }`
  overrides it and the attribute is kept only as state for scripts and tests.
- **Cards must not clip the panel.** `select.js` walks up to the nearest
  overflow-clipping ancestor and adds `.has-floating-panel` (`overflow: visible`).
- **Placement.** `place()` flips the panel up (`.custom-select__menu--up`) when
  there is more room above, and clamps it inside the viewport horizontally.
- **Keyboard + ARIA.** Select-only combobox pattern: `role="combobox"` with
  `aria-haspopup="listbox"`, `aria-expanded`, `aria-controls`,
  `aria-activedescendant`; the listbox options carry `role="option"` and
  `aria-selected`. Supports Arrow keys, Home/End, Enter, Escape, Tab and
  typeahead. Focus stays on the trigger.
- **Reduced motion.** The panel, chevron and option transitions are disabled under
  `prefers-reduced-motion: reduce`.
- **Regression test.** `npm run test:glass` (`test/glass-panels.smoke.js`) asserts
  the glass tokens, option colours, chevron rotation, ~200ms ease-out motion, the
  viewport flip, keyboard flow, the native-select contract and mobile targets.
  It reads the same selectors as `select.js`, so a rename on either side fails
  loudly instead of silently losing the look.

## Optional accounts (Firebase) — do not make sign-in mandatory

SafePath works with no account. Everything below exists to keep it that way.

- **Guest mode is the default.** `public/firebase-config.js` ships with
  `YOUR_…` placeholders; `SafePathAuth.isConfigured()` returns false and the app
  runs guest-only. Never add a config with real keys to this repo.
- **The SDK is loaded lazily.** `auth.js` imports `firebase-*` from gstatic
  only when someone opens the sign-in sheet. A guest never downloads it. Keep
  it that way — an eager import would slow every guest page load.
- **Every auth path degrades to a no-op.** `auth.js` returns `{ok:false,error}`
  rather than throwing, and `auth-ui.js` guards on `window.SafePathAuth`. If
  Firebase is missing or fails, navigation must be unaffected.
- **Never gate navigation on auth.** The only thing an account adds is saving
  emergency contacts. Tests in `test/auth.smoke.js` assert a guest can open the
  planner, reach the emergency panel and get Call 112.
- **The welcome card is one-time and always escapable.** It is keyed on
  `safepath.welcome.seen` in localStorage and has an explicit Skip. Because it
  is a modal, **any new browser test must pre-set that flag** via
  `page.evaluateOnNewDocument`, or it will click into the overlay. Existing
  suites already do this.
- **Honesty on the emergency panel.** A web page cannot send SMS. The Text and
  WhatsApp buttons only build a pre-filled `sms:` / `wa.me` link; the user
  presses send. No string in that panel may claim a message was sent. `Call 112`
  is a `tel:` link and is always present, guest or signed in.
- **Emergency message format** is fixed: `I need help. My location: <Google
  Maps link>`. `auth-ui.js` builds it in one place (`buildMessage`).
- **Escape all user text.** Contact names, phones and relationships are escaped
  on render. A test feeds `<img src=x onerror=…>` and asserts no element is
  created and no script runs.
- **Firestore rules are the real access control.** `firestore.rules` scopes
  `users/{uid}/contacts` to the owning uid and denies everything else. Client
  code is not trusted. The 5-contact cap is a product limit, not a security
  boundary — rules cannot count sibling documents.
- **Account deletion removes contacts first**, then the account, so a failure
  never leaves orphaned personal data.
- **The smoke test stubs only the Firebase SDK**, intercepting gstatic module
  requests. The intercepted responses must send `Access-Control-Allow-Origin`,
  or the browser blocks the cross-origin module import and every auth test
  fails for the wrong reason.

## Theming

- **The site is charcoal `#101114`, not forest green.** The `--bg`/`--panel`
  variables in the stylesheet's first layer, and a few comments mentioning a
  dark forest, are stale. The stylesheet stacks abandoned themes (forest green →
  plum → charcoal) and only the last block wins. Measure the rendered pixel
  colour before "restoring" a theme from a comment.
- **`public/theme.js` is the single owner of the theme.** An inline script in
  `<head>` only *reads* the saved preference and sets `data-theme` before first
  paint, to avoid a flash of the wrong theme. `theme.js` performs the switching.
  Keep both in step.
- **There are exactly two themes, light and dark, and one button to swap them.**
  There is no "system" option and the OS preference is deliberately ignored — do
  not reintroduce a `matchMedia` listener or a third choice. The stored value is
  the theme itself (`light` or `dark`) in `safepath-theme`.
- **A first-time visitor gets the dark theme.** `DEFAULT_THEME` is `dark`, which
  is what the site has always looked like. Defaulting to the OS preference makes
  the site render light for anyone whose OS is light, which changes the product's
  appearance and fails the visual suites.
- **The toggle shows the theme you would switch to**, not the current one: the
  sun while dark is active, the moon while light is. CSS decides this from
  `html[data-theme]`; `theme.js` sets the matching `aria-label`/`title` in words.
  Keep the two in agreement if you touch either.
- **The light theme is an override layer keyed on `html[data-theme="light"]`.**
  It must out-specify the stacked dark blocks, so every rule repeats the
  `html[data-theme="light"]` ancestor rather than relying on source order. Note
  that a `html[data-theme="light"] .x` rule also out-specifies a plain `.x` rule
  in a media query, so any mobile override of a themed element needs its own
  `html[data-theme="light"]` counterpart.
- **The theme toggle sits to the right of the account control.** It is the last
  child of `.topbar`, so it is the element that gets clipped if the row
  overflows. Keep it last; do not move it back beside the brand.
- **The toggle must not change the top bar's height.** The top bar is
  `height:76px` below 900px and `92px` above. If it wraps to a second row, the
  sticky tab strip is pushed out of alignment and clicks land on the wrong
  element. It is 40px by default, 34px below 900px, and 30px (frameless) below
  520px, where `.topbar__spacer` also steps aside.
- **The status chips are hidden at 900px.** Brand + account + toggle already need
  most of the row; the three chips add ~440px and push the row wider than the
  viewport. This is the same trade the 520px rule made.
- **`.authbar__user` needs an explicit `[hidden]` rule.** The class sets
  `display:flex`, which out-specifies the UA rule for `[hidden]`, so a signed-out
  user box still laid out and ate ~120px of the bar — enough to wrap the toggle
  at 390px. The stylesheet already does this for `.nav`, `.sheet` and
  `.installbar`; follow that pattern for any new flex container toggled by
  `hidden`.
- **Only write `data-theme` when the value changes.** `theme.js` sets this
  attribute on `<html>`, and the light layer is keyed off it, so a redundant
  write at load invalidates style for the whole document and can disturb the
  entry animation.

## Testing notes

- **`main` has `animation:fadeUp .5s`, and a tab click only flips `hidden`.**
  Clicking or measuring on a fixed `wait(500)` races that animation and can hit
  a 0x0 element ("Node is either not clickable or not an Element"). Worse, a
  route search from a previous step resolves asynchronously and can switch tabs
  back after the test has already seen Overview. `test/autocomplete.smoke.js`
  uses a `showOverview()` helper that clicks and then requires the Overview page
  to stay visible for a sustained window before proceeding.
- **Run `npm run test:all`, not the suites against your dev server.** The runner
  starts its own server on a spare port and raises the report rate limit. A
  second server left running on the runner's port makes suites flake in ways
  that look like product bugs. Check for stray `node server/index.js` processes
  before investigating a failure.
