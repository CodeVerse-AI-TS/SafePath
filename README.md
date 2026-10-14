# SafePath — safe path prediction for Mysuru

SafePath predicts the **safer walking route** between two places on a map. It
learns where reported incidents cluster in Mysuru, scores any point by the
risk it carries at a chosen time of day, and ranks route options by how much of
that risk they avoid.

> **The safety score is an estimate from reported data, not a guarantee of
> safety.** It reflects where incidents have been reported and how recently, plus
> lighting and "help nearby" signals. Absence of reports is not absence of risk.

The bundled data is **clearly labelled synthetic sample data** (see
[Swapping in real data](#swapping-in-real-data)). Nothing in the seed describes a
real event, person or place.

---

## How the safety score is calculated (plain English)

Think of the city as a heat map of reported incidents.

1. **Where incidents cluster.** Every reported incident is a dot. Dots that sit
   close together form a **hotspot** (found with DBSCAN, a standard clustering
   method). A hotspot near you matters more than one far away, and the effect
   fades with distance — a dot 50 m away counts for much more than one 250 m
   away. Beyond 300 m a single incident has no effect at all.

2. **How serious and how recent.** A report of assault weighs more than a report
   of a road obstruction. A report from last month weighs more than one from
   three years ago (the weight halves roughly every six months). So the map drifts
   toward where problems are being reported *now*.

3. **What time it is.** Incidents are not spread evenly across the day. In this
   dataset the **night** bucket holds the most reports, so the same street scores
   higher at 11 pm than at 2 pm. The multiplier is learned from the data, not
   typed in by hand.

4. **Lighting and how busy it feels.** Community reports about dark or empty
   stretches, plus mapped street lamps and open shops, add to or reduce the
   score. An unlit road only counts against you when it is actually dark.

5. **Help nearby reduces the score.** Police stations, hospitals, open shops,
   petrol stations and bus stops within a few hundred metres are treated as
   "safety support" and pull the score down a little.

Those pieces combine into a **risk score from 0 to 100** for any point and time.
A **route** is then sampled every ~30 m; we take the mean risk, the 90th
percentile (the bad stretches) and the share of the path that is high-risk, and
turn that into a **safety score out of 100**:

```
exposure per km = 0.60 × mean risk + 0.25 × 90th-percentile risk + 0.15 × (high-risk share)
safety score    = 100 − exposure per km
```

Lower exposure means a safer-feeling path. The route cards show the exposure
number directly, and the safety score is just 100 minus it, so the two can never
disagree.

**Three options** come out of that: **Fastest** (shortest time), **Safest**
(highest safety score) and **Balanced** (best mix of time and safety, set by the
Safety-vs-Speed slider). If no route is meaningfully safer than the fastest one,
the app says so — and shows a distinct route as an **Alternative** — instead of
pretending an alternative is safer.

---

## What the app does

Five pages, in the existing dark design (Space Grotesk / Manrope / DM Mono):

| Page | What it shows |
|---|---|
| **Overview** | Start/destination with predictive autocomplete, a search box over the map, departure time, travel mode, safety-vs-speed slider, the map with a risk heatmap and hotspot layer. |
| **Safe route** | Up to three route cards (Safest / Balanced / Fastest), a segment-coloured polyline (green → amber → red by local risk), the avoided hotspot circles, and a data-derived "Why this route" panel. |
| **Report** | Submit a community report at your location or a tapped point; validated, rate-limited, deduped, and fed straight back into the risk model. |
| **Live desk** | A live feed (Server-Sent Events) of new reports and panic alerts, with the map updating as they arrive. |
| **Signals** | Charts and lists read entirely from the database: incidents by time of day and type, monthly trend, top hotspots. |

Plus a **panic button**: hold for two seconds to send your area-level location to
your trusted circle. The channels (webhook / SMS / email) are configurable; when
none is set, the UI states plainly that it is **demo mode** and the alert is only
stored locally.

### Live navigation

Picking a route card and pressing **Start navigation** locks in that route
(Safest, Balanced or Fastest) and opens a full-screen trip view. It is a focused
screen, not a page: the planner is hidden while a trip is running and comes back
when it ends.

| Part | What it does |
|---|---|
| **Map** | A dedicated Leaflet map that rotates to your heading, with the route split into a grey "walked" part and a bright "still to walk" part. The position arrow is smoothed and snapped to the route line so it does not jitter. |
| **Turn banner** | The next manoeuvre, the street name and the distance to it, from real OSRM steps. Each new instruction is spoken and announced to screen readers. |
| **Safety alerts** | A banner when a reported-incident area or a poorly lit stretch is within 400 m ahead, with a plain-language suggestion. |
| **Compass** | Heading from GPS, from the route direction, or from the device sensor, with a north-up / heading-up toggle. |
| **Panel** | Current speed, distance and time remaining, arrival time, and a live safety score for the road immediately ahead. |
| **End route** | Confirms before stopping, then shows a trip summary and saves it. |
| **Reroute** | If you drift more than 40 m off the line for two seconds, SafePath recalculates from where you are and offers a safer alternative rather than silently redirecting you. |
| **Check-in** | If you stop moving for two minutes in a higher-risk spot, the app asks if you are okay and offers to alert your trusted circle. |
| **Share** | Creates an expiring link that publishes an area-level position only, refreshed while the trip runs. |
| **Simulate** | A debug mode that drives the arrow along the route without moving, so the whole flow can be tested indoors. |

**Location is used only during a trip.** The app requests it when you press Start
navigation, and the permission screen says so in as many words. The watcher is
released the moment the trip ends or you arrive, and no trail of positions is
stored — see [Safety, privacy and honesty](#safety-privacy-and-honesty).

### The maps are interactive

Every map is Leaflet + OpenStreetMap, and the two prediction maps (Overview and
Safe route) share one set of layer controls:

| Control | What it does |
|---|---|
| **Risk heatmap** | Fetches `/api/risk-grid` for the current view and the chosen departure time and draws a cell grid coloured green → amber → red. Re-fetches when you change the departure time. |
| **Hotspots** | Circles sized and shaded by cluster intensity. Click one for its name, reported-incident count, recent share, intensity and last-reported date. |
| **Street lamps** | `/api/features?kinds=street_lamp` — the lit-road evidence behind the lighting signal. |
| **Help points** | Police stations, hospitals, shops, fuel stations and bus stops from `/api/features`. |
| **Recenter** | Overview returns to Mysuru; Safe route fits all candidate routes in view. |
| **Use my location** | Centres the map on your position (browser geolocation, never stored) and fills the **From** field with a reverse-geocoded place name, e.g. "Vijayanagar (12.3051, 76.6551)". |

On the Safe route page, routes are drawn in role colours (Safest green, Balanced
amber, Fastest blue) with start and destination markers. Selecting a card redraws
that route as a **segment-coloured polyline** — each ~30 m segment is coloured by
the risk at your departure time — over a role-coloured casing, so you can see both
which option it is and where its risky stretches are. Hovering a segment shows its
band and score; clicking the line selects the same route as clicking its card.
Hotspots the route avoids are ringed in amber, and the area the model has data for
is drawn as a dashed blue rectangle — anything outside it is shown as *no safety
data* rather than scored.

> Maps created while their tab is hidden are re-measured with `invalidateSize()`
> on tab open, on window resize, and after routes render. Each map container has
> an explicit height in CSS (`min-height: 560px`, `70vh` on desktop, `340px` on
> mobile) — Leaflet renders into a zero-height box otherwise. If the tile layer or
> the Leaflet library fails to load, the map is replaced with a "Map could not
> load" panel instead of staying blank.

---

## Predictive place autocomplete

The "From" and "To" fields and the search box over the Overview map all share one
combobox widget (`public/autocomplete.js`). Type two characters and a dropdown
appears with up to six places.

What each row shows:

| Part | Meaning |
|---|---|
| **Icon** | place, station, landmark, address, or a clock / home / pin for recents and saved places |
| **Bold name** | the place name, with the characters you typed highlighted |
| **Secondary line** | area and city, distance away, and — for a destination — a safety hint |
| **Safety hint** | "Low / Moderate / Higher risk area", plus the time of day when it differs from afternoon. Outside the modelled area it says **No safety data** rather than guessing |

Behaviour worth knowing:

- **Debounced, cancelled, ordered.** Keystrokes wait ~300 ms before a request goes
  out, an `AbortController` cancels the previous request, and each response carries
  a sequence number so a slow reply can never overwrite a newer one. A fast burst
  of typing produces a single request.
- **Keyboard first.** `↓`/`↑` move, `Enter` picks, `Escape` closes, `Tab` leaves.
  The input is a proper ARIA combobox (`role="combobox"`, `aria-expanded`,
  `aria-activedescendant`, `role="listbox"`/`option`), and the highlighted row is
  announced to screen readers. A first `Enter` picks a suggestion; a second starts
  the route search.
- **Picking a place skips a round trip.** The chosen coordinates are kept on the
  input, so the route request sends `{lat, lng}` directly and the server does not
  geocode again.
- **Recents and saved places** live in `localStorage` only (never on the server):
  the last five places you chose, plus Home/Work shortcuts.
- **Coordinates still work.** Pasting `12.31, 76.66` becomes a suggestion in its
  own right, shown immediately and never replaced by an empty result list.
- **Honest states.** Loading, no-results, rate-limited, timed-out and offline each
  get their own row instead of a blank or stale dropdown.

### Why not Nominatim for autocomplete

The public Nominatim server's usage policy **forbids search-as-you-type**, so it is
not used for suggestions. Nominatim still handles the single, user-initiated
geocode when a route is planned. Autocomplete goes through a small server-side
proxy that defaults to [Photon](https://photon.komoot.io) — free and keyless — with
Geoapify and Mapbox available if you have a key. Any key stays on the server; the
browser only ever calls `/api/places/suggest`. Responses are cached in SQLite for
24 hours, and a transient upstream failure gets one retry before the UI reports it.

To self-host or switch provider:

```bash
# self-hosted Photon
PHOTON_URL=http://localhost:2322 npm start

# a keyed provider (key stays on the server)
SAFEPATH_PLACES_PROVIDER=geoapify GEOAPIFY_API_KEY=... npm start

# turn suggestions off; the directions search still works
SAFEPATH_PLACES_PROVIDER=none npm start
```

### How suggestions are ranked

Candidate places come from the provider; `server/lib/place_rank.js` (pure, unit
tested) decides the order and the highlight:

```
score = 0.62 · text match      (prefix > word-boundary > typo > fuzzy subsequence)
      + 0.20 · proximity        (1 / (1 + (distance/12 km)²) from the map centre or your location)
      + 0.12 · home country     (India favoured, others demoted — never hidden)
      + past selections         (up to +0.25 for places you have chosen before)
```

The text match tolerates typos and dropped letters, and it returns the exact
`start`/`length` of the matched substring so the dropdown highlights it without
re-matching in the browser. Duplicates are collapsed and the list is capped at six.

---

## Architecture

```
server/                 Node + Express API
  index.js              app wiring, static hosting, error handling
  lib/
    db.js               SQLite (prepare/get/all/run + meta)
    geo.js              haversine, sampling, bearings, area-level snapping
    risk.js             the risk kernel: any point -> risk 0..100
    routing.js          candidate generation, scoring, role selection
    geocode.js          Nominatim client (cached, User-Agent, India-bounded)
    places.js           autocomplete provider proxy (Photon / Geoapify / Mapbox)
    place_rank.js       pure ranking + text matching for suggestions (unit tested)
    notify.js           trusted-circle channels (webhook / SMS / email)
    ratelimit.js        in-memory rate limiter
    live.js             SSE subscriber list
  routes/               risk, routes, reports, alerts, signals, places, geocode
data/
  seed.js               synthetic Mysuru dataset (500+ incidents)
  import.js             import a real incident CSV
  overpass.js           optional OSM enrichment (lamps, lit, shops, help)
  hotspots.json         cluster output (regenerated by ds/build.js)
  model.json            learned parameters + honest ML baseline metrics
ds/build.js             DBSCAN hotspots + time multipliers + ML baseline
public/                 index.html, app.js, autocomplete.js, styles.css (vanilla JS + Leaflet)
test/risk.test.js       unit tests for the risk function and ranker
test/places.test.js     unit tests for suggestion ranking and text matching
```

### Data model (SQLite)

- `incidents(lat, lng, type, severity, timestamp, source, verified, note)`
- `reports(lat, lng, type, lighting, crowd, severity, time_of_day, note, source)`
- `hotspots(cluster_id, name, lat, lng, radius_m, intensity, count, recent_count, reason)`
- `road_features(lat, lng, kind, name, meta)` — street lamps, `lit` roads, shops,
  police, hospitals, fuel, bus stops
- `alerts(lat, lng, created_at, channels, status, ...)`
- `meta(key, value)`

Reports and alerts are stored at **area level only** (coordinates snapped to an
~110 m grid). No personal location or movement trace is kept.

---

## Quick start

Requires **Node.js 22.5+** (uses the built-in `fetch`). **Node 24 is
recommended**: the data layer uses the built-in `node:sqlite`, which needs the
`--experimental-sqlite` flag on Node 22.5–23.3 and is stable from Node 24.
SQLite is embedded; no external database is needed.

```bash
npm install                 # express only
npm run seed                # write synthetic sample data (500+ incidents)
npm run ds:build            # cluster -> data/hotspots.json + data/model.json
npm start                   # http://localhost:3000
```

`npm run bootstrap` runs seed + ds:build in one step.

To put this online — Docker, a persistent volume, HTTPS and install-to-home-screen
— see **[DEPLOY.md](DEPLOY.md)**.

Then open <http://localhost:3000>. Enter two places in Mysuru (e.g.
"Mysore Palace" → "Kuvempunagar"), or use your current location, and press
**Find safe routes**.

Run the tests:

```bash
npm test               # offline unit tests for the risk function + ranker
npm run test:acceptance # end-to-end checks against a running server (needs network)
npm run test:map        # headless-browser checks: maps render, routes draw, 320px layout
npm run test:coverage   # headless-browser checks: no-data areas, long walks, time-of-day
npm run test:interaction # headless-browser checks: every control, the report flow, the live feed
npm run test:autocomplete # headless-browser checks: the search dropdown, debounce, keyboard, 320px
npm run test:nav        # unit tests for the navigation maths and step builder
npm run test:navigation # headless-browser checks: the whole live-navigation flow
npm run test:auth       # headless-browser checks: the optional account flow, guest-first
npm run test:pwa        # headless-browser checks: manifest, service worker, offline shell
npm run test:all        # everything above, run against a server it starts itself
```

`npm test` builds the sample data automatically on a fresh clone and needs no
network. `npm run test:acceptance` drives the live API (routes, risk, reports,
signals, alerts, geocoding), so start the server first. Every browser suite
defaults to `http://localhost:12000`; set `BASE` to override, e.g.
`BASE=http://localhost:3000 npm run test:acceptance`.

`npm run test:all` is the exception: it starts its own server on a spare port and
stops it afterwards, so you do not need one running. It raises the report rate
limit for the duration of the run via `SAFEPATH_RATE_MULTIPLIER`, which the
server ignores in production because the variable is not set there. Without that,
running the browser suites twice within ten minutes trips the spam guard and
looks like a broken report flow.

`test:map`, `test:coverage`, `test:interaction` and `test:autocomplete` drive a real headless Chromium
(via `puppeteer-core`) against the running server. They are the regression guard
for the blank-map bug: they assert each map container has a real height, that
tiles and hotspot circles actually render, that three route cards appear with
light-coloured text, that selecting a card redraws the map, and that the layout
holds at 320 px with no console errors. `test:interaction` goes further and
exercises every control the way a person would — planning a route with the
keyboard, toggling each layer, tapping the report map, submitting a report and
watching the nearby risk move, and confirming the live feed connects and the
Signals numbers match `/api/signals`. `test:autocomplete` types into the real
fields and asserts the dropdown appears after two characters, that a fast burst of
keystrokes makes a single request, that the matched text is highlighted, that
keyboard-only selection works and stores coordinates, that picking a suggestion
does not accidentally start a route search, that the 320 px dropdown keeps 44 px
rows, and that a superseded query never leaks stale results. All four skip cleanly
if Chromium is not installed (`CHROME_PATH` overrides the binary).

The browser tests and the acceptance suite write a tagged probe report and delete
it again when they finish, so running them repeatedly does not accumulate test
debris in the database.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `SAFEPATH_DB` | `data/safepath.db` | SQLite file path |
| `SAFEPATH_CORS` | `*` | Allowed origin (tighten in production) |
| `SAFEPATH_UA` | built-in | `User-Agent` sent to Nominatim / OSRM / Overpass / Photon |
| `SAFEPATH_REPORT_LIMIT` | `5` | Max community reports per IP per window |
| `SAFEPATH_REPORT_WINDOW_MS` | `600000` | Report rate-limit window (10 min) |
| `SAFEPATH_RATE_MULTIPLIER` | `1` | Multiplies every rate limit. Set to e.g. `60` for a test run; leave at `1` in production. |
| `SAFEPATH_PLACES_PROVIDER` | `photon` | Autocomplete provider: `photon`, `geoapify`, `mapbox` or `none` |
| `PHOTON_URL` | `https://photon.komoot.io` | Photon endpoint (self-host it for production) |
| `GEOAPIFY_API_KEY` | — | Key for `SAFEPATH_PLACES_PROVIDER=geoapify` |
| `MAPBOX_TOKEN` | — | Token for `SAFEPATH_PLACES_PROVIDER=mapbox` |
| `NOMINATIM_URL` | public Nominatim | Geocoding endpoint (self-host in production) |
| `OSRM_FOOT_URL` | `routing.openstreetmap.de/routed-foot` | Walking profile |
| `OSRM_BIKE_URL` | `routing.openstreetmap.de/routed-bike` | Cycling profile |
| `OSRM_CAR_URL` | `routing.openstreetmap.de/routed-car` | Driving profile |
| `OVERPASS_URL` | public Overpass | OSM feature source |
| `SAFEPATH_ALERT_WEBHOOK` | — | POST panic alerts to a webhook |
| `SAFEPATH_ALERT_SMS_URL` / `SAFEPATH_ALERT_SMS_TO` | — | SMS provider bridge + number |
| `SAFEPATH_ALERT_EMAIL_URL` | — | Email provider bridge |

Nothing is required for local use; the defaults are the public demo services.

---

## API

| Endpoint | Returns |
|---|---|
| `GET /api/risk?lat=&lng=&time=` | risk 0..100 at a point and time, with components |
| `GET /api/risk-grid?bbox=&time=&cells=` | a grid of risk values for the heatmap |
| `GET /api/risk-by-time?bbox=&cells=` | average risk per time bucket across a bbox |
| `POST /api/routes` | `{from, to, mode, departure, lambda}` → Safest / Balanced / Fastest |
| `POST /api/reports` | submit a community report (rate-limited, deduped) |
| `GET /api/reports` | recent reports (area-level coordinates) |
| `GET /api/reports/stream` | Server-Sent Events feed for the Live desk |
| `POST /api/alerts` | panic alert (hold-to-alert), fans out to configured channels |
| `GET /api/alerts` · `GET /api/alerts/channels` | recent alerts · which channels are live |
| `POST /api/navigation` | turn-by-turn payload for a route: coords, steps, hazards, safety, note |
| `POST /api/navigation/reroute` | recalculate from a live position and say whether the new route is safer |
| `POST /api/trips` · `GET /api/trips` | save a finished trip (area-level) · recent trips |
| `POST /api/trips/share` | create an expiring live-share link (area-level position) |
| `GET /api/trips/share/:token` | the shared position, with its accuracy note |

| `POST /api/trips/share/:token/update` · `.../stop` | refresh · end a live share |
| `GET /api/hotspots` | the hotspot list |
| `GET /api/signals` | all Signals-page numbers (from the DB) |
| `GET /api/geocode?q=` | final geocode for the directions search (Nominatim) |
| `GET /api/places/suggest?q=&lat=&lng=&time=&limit=&safety=` | **place autocomplete** (provider proxy, cached, ranked) |
| `GET /api/places/status` | which autocomplete provider is configured |
| `GET /api/geocode/suggest?q=` | deprecated 307 redirect to `/api/places/suggest` |
| `GET /api/health` · `GET /api/meta` | service + dataset status |

`from` / `to` accept `[lat, lng]` or a place name. `lambda` is the safety-vs-speed weight (higher = safer preferred).

### The `time` parameter

`time` (and `departure`, on the navigation endpoints) accepts three forms. Risk
is scaled by a time-of-day multiplier, so the value you send changes the answer:

| Value | Meaning |
|---|---|
| omitted, or `now` | the current time |
| `morning`, `afternoon`, `evening`, `night` | a representative hour for that bucket (09:00, 14:00, 19:00, 23:00 local) |
| an ISO 8601 timestamp, e.g. `2026-10-28T23:00:00` | that exact instant |

Anything else is refused with `400` and a message saying what to send instead. A
bare date such as `2026-10-28` is also refused, because it has no time of day and
silently treating it as midnight would misreport risk.

```bash
# afternoon and night differ, as they should
curl 'localhost:3000/api/risk?lat=12.3052&lng=76.6554&time=afternoon'
curl 'localhost:3000/api/risk?lat=12.3052&lng=76.6554&time=night'
```

---

## The risk model

- **Clustering.** `ds/build.js` runs **DBSCAN over the haversine metric**
  (`eps = 300 m`, `min_pts = 6`) on all incidents and writes `hotspots.json`
  (cluster centroid, radius, recency-weighted intensity, count, plain reason).
- **Distance decay.** Gaussian, `sigma = 120 m`, hard cut-off at `300 m`.
- **Severity + recency.** Severity 1..5 normalised to 0..1; recency weight halves
  every **180 days**.
- **Time of day.** Four buckets (morning / afternoon / evening / night) with a
  multiplier **learned** from the observed incident mix and normalised to mean 1.
- **Lighting / crowd.** From community reports (blended with the OSM lamp proxy).
- **Protective factors.** Police, hospital, open shop, fuel, bus stop within
  400 m reduce the score.
- **Weights.** `incident_density 0.40`, `severity_recency 0.25`, `lighting 0.12`,
  `crowd 0.08`, `protective 0.15` (protective subtracts). All in `model.json`.

### Optional ML baseline (reported honestly)

`ds/build.js` also trains a small **logistic regression** (pure JS) to predict
whether a ~275 m grid cell will have at least one incident in a time-of-day
bucket. It is validated with **cross validation split by cell**, using
leave-one-cell-out density features so the score is not inflated by leakage.
Metrics (AUC, accuracy, Brier score, log loss, base rate) are written to
`data/model.json` under `ml_baseline`. On the synthetic sample the AUC is around
**0.69** — a modest signal, which is why the **transparent weighted formula**
stays in production rather than a black box. If you swap in real data with more
signal, re-check those numbers before changing anything.

---

## Swapping in real data

1. Export incidents as CSV with this header:

   ```csv
   lat,lng,type,severity,timestamp,source,verified,note
   ```

   `type` is one of harassment | theft | assault | snatching | stalking |
   road_accident | obstruction | other. See
   `data/sample_incidents_template.csv`.

2. Import and rebuild:

   ```bash
   npm run import -- path/to/incidents.csv --replace   # or omit --replace to append
   npm run ds:build                                    # regenerate hotspots + model
   ```

3. Restart the server. The app, heatmap and Signals page now read your data.

Optional — pull real OSM safety features for a bounding box:

```bash
npm run osm:pull -- --bbox 12.90,77.55,13.02,77.65
```

This writes street lamps, `lit` roads, shops, police, hospitals, fuel and bus
stops into `road_features`. It sends **one** cached request, sets a descriptive
`User-Agent`, and leaves existing features untouched if Overpass is unreachable.

---

## Safety, privacy and honesty

- **Never a guarantee.** Every score is labelled an estimate from reported data,
  in the UI and in the API payloads.
- **Area-level only.** Report and alert coordinates are snapped to an ~110 m grid
  before storage; no precise personal location or trace is kept.
- **Location during navigation is permission-gated and temporary.** The app asks
  for your location only when you press Start navigation, explains that it uses
  it only during the trip, and releases the watcher as soon as you arrive or end
  the trip. What is saved afterwards is a summary — distance, time, average
  speed, safety score and area-level endpoints — not a trail of positions.
- **Live sharing is deliberately coarse.** A share link publishes an area-level
  position (~110 m), expires after four hours, can be stopped at any time, and
  states its own accuracy in the payload.
- **Bias.** Hotspots are described by **counts and recency**, never by naming a
  neighbourhood as "dangerous". The Signals page repeats that hotspots describe
  reported data, not the people who live there.
- **Rate limiting + abuse checks.** 5 reports / 10 min and 6 alerts / 10 min per
  IP, plus a content filter and a 20-minute same-area dedupe.
- **Public service etiquette.** Nominatim, OSRM and Overpass results are cached,
  calls are throttled, and a descriptive `User-Agent` is sent. For production,
  **self-host or use a paid provider** (see below).

### Running the routing/geocoding services yourself

The public demo servers are fine for development but are shared and rate-limited.

- **OSRM:** download a regional OSM extract (Geofabrik), build a profile with
  `osrm-extract` / `osrm-contract`, run `osrm-routed`, then point
  `OSRM_FOOT_URL` / `OSRM_BIKE_URL` / `OSRM_CAR_URL` at it.
- **Nominatim:** self-host with the official Docker image and an OSM extract, or
  use a paid geocoder. Set `NOMINATIM_URL`.
- **Overpass:** self-host Overpass, or pre-download the features once with
  `data/overpass.js` and stop calling it at runtime (the app only reads
  `road_features` from the database).

---

## Accessibility

Keyboard-operable controls with visible focus styles, `aria-label` /
`aria-pressed` on the toggle and route buttons, `role="img"` labels on the
exposure bars, `prefers-reduced-motion` support, and a mobile-first layout that
works from **320 px** upward.

The search dropdowns are full ARIA comboboxes: `role="combobox"` with
`aria-expanded`, `aria-controls` and `aria-activedescendant` on the input, and
`role="listbox"` / `role="option"` rows. Every row is at least 44 px tall for
touch, the active row is announced politely to screen readers, and the whole flow
works with the keyboard alone (type, arrow, Enter). Opening and closing the list
never traps focus or shifts the page.

---

## Optional accounts and emergency contacts

**Signing in is optional and never required.** SafePath is fully usable as a
guest: routing, maps, hotspots, reports and the emergency panel all work with
no account and no interruptions.

A guest who opens the app sees a small welcome card with **Sign in**,
**Create account** and **Skip — continue as guest**. Skipping is a real choice,
not a delay: the card does not return, and a **Sign in** button stays in the
header for anyone who changes their mind.

An account adds exactly one thing: **up to 5 saved emergency contacts**
(name, phone, relationship) that can be added, edited and deleted. Signed-in
users see their name and a **Sign out** option in the header.

### The emergency button

Holding the button for two seconds reads your location and opens the Live page,
where **Call 112 sits at the top of the panel** — the fastest thing to reach
when it matters, and the only action that reaches a real human directly.

Below that, **Choose how to alert your contacts** lists your saved contacts
with one-tap **Text** and **WhatsApp** buttons, pre-filled with:

```
I need help. My location: https://maps.google.com/?q=<lat>,<lng>
```

**Call 112 is always available — for guests too.**

Being honest about what a web page can do: it cannot silently send an SMS. The
Text and WhatsApp buttons only open your own messaging app with the message
ready; you press send. The UI says this plainly and never claims an alert was
sent. The area-level location is still POSTed to `/api/alerts`, which reports
its real delivery status.

Guests who open the emergency section see "Sign in to save emergency contacts"
with a sign-in button. Nothing else on the page is blocked.

### Managing contacts

Contacts are edited in a sheet reached from **Account → Emergency contacts**, or
from the **Add one now** link on the emergency panel.

- **Name** and **Phone** are required; **Relationship** is optional.
- Phone numbers are validated, not just length-checked. An Indian mobile must
  be 10 digits starting **6–9**, with an optional `+91` or `0` prefix, so
  `+91 58765 43210` is refused as the typo it is rather than mistaken for an
  international number. A number with any other country code is accepted, so
  `+1 415 555 2671` and `+44 20 7946 0958` work. The stored value is normalised
  to a single `+` and digits.
- **The limit is 5 contacts.** At 5 the form is disabled and the panel says
  "You have reached the limit of 5 contacts. Delete one to add another." The
  limit is enforced in the store as well as the UI.
- **Delete all my contacts** (in **Account → Privacy & my data**) removes every
  contact but keeps your account. Deleting the account removes both.

A consent note sits above the form — *Only add people who know you're listing
them* — because these are other people's phone numbers.

### Setup

Firebase Authentication (email/password and Google) with Firestore for
contacts, each user able to reach only their own documents.

1. Follow **`FIREBASE_SETUP.md`** (create project, enable providers, paste the
   config into `public/firebase-config.js`).
2. Publish **`firestore.rules`** — these are what actually protect user data.
3. Restart the server.

With `firebase-config.js` left at its placeholders the app simply runs in guest
mode, so a fresh clone works with no Firebase project at all.

### Privacy

- Guest use stores nothing about you.
- An account stores your email and the contacts you choose to save.
- Contacts are readable only by their owner, enforced by Firestore rules.
- Reports stay area-level (~110 m) and no location trail is stored.
- **Delete all my contacts** removes every contact and keeps the account.
- **Delete my account and data** removes your contacts and then the account.

All user-entered text is escaped before it reaches the page.

### Tests

```bash
npm run test:auth   # 68 checks: guest flow, sign-up, contact CRUD,
                    # phone rules, the 5-contact limit, delete-all,
                    # escaping, emergency links, sign-out, privacy
```

`test/auth.smoke.js` stubs only the Firebase SDK at the network boundary; the
validation, escaping, link building and rendering under test are the real
modules. The manual checklist is in `TEST_CHECKLIST.md`.

## Theme

The interface is charcoal and silver: neutral chrome (backgrounds, borders,
brand mark, focus rings) carries no meaning, so the colour budget is spent
entirely on risk. All tokens live at the top of `public/styles.css`.

| Token | Value | Role |
| --- | --- | --- |
| `--bg` / `--bg-2` | `#101114` / `#15161a` | page and inset background |
| `--surface` … `--surface-3` | `#1a1c21` … `#2c2e35` | cards, controls, raised panels |
| `--border` / `--border-strong` | `#2a2c33` / `#3d4048` | hairlines and control outlines |
| `--text` / `--text-dim` / `--text-faint` | `#f5f5f7` / `#92959e` / `#6f727b` | body, secondary, tertiary |
| `--accent` | `#c8cbd2` | silver: brand, focus, selection |
| `--safe` | `#35c98a` | **low risk** — green |
| `--amber` | `#f0b429` | **medium risk** — amber |
| `--danger` | `#f0616b` | **high risk** — red |
| `--info` | `#5aa9e6` | fastest route — blue |

### Why the risk colours are not silver

A silver accent is right for chrome, but it must never carry risk. If `--safe`
were silver, "low risk" and "high risk" would differ only in lightness, and the
one distinction the app exists to make would be the hardest one to see. The four
semantic colours are therefore held out of the silver system and left saturated.

All four clear WCAG AA (≥ 4.5:1) against both `--bg` and `--surface`:

| Colour | on `--bg` | on `--surface` |
| --- | --- | --- |
| `--safe` `#35c98a` | 8.9:1 | 8.0:1 |
| `--amber` `#f0b429` | 10.1:1 | 9.1:1 |
| `--danger` `#f0616b` | 6.0:1 | 5.4:1 |
| `--info` `#5aa9e6` | 7.4:1 | 6.7:1 |

Risk is also never colour-only: route cards carry a text badge ("medium risk"),
scores are printed as numbers, and the legend is labelled. Someone who cannot
distinguish red from green still gets every distinction in words and figures.

### Map markers

Marker colours are chosen for the light OpenStreetMap tiles, not for the dark
chrome — no saturated hue clears 3:1 against `#f2efe9` on its own, so markers
read through a dark fill and a saturated stroke. Markers that used the old mint
brand colour are now silver or white (`#c8cbd2` / `#f5f5f7`): the start point,
your reported location, a submitted report, and the bus-stop help point. Risk
markers and the other help points keep their semantic colours.

---

## Notes

- `data/safepath.db` is generated by `npm run seed`; delete it to start fresh.
