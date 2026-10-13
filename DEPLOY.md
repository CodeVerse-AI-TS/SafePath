# Deploying SafePath

This guide takes SafePath from `npm start` on your machine to a real HTTPS URL
that people can install on their phones.

Read [Safety and honesty in production](#safety-and-honesty-in-production)
before you put this in front of the public. Some defaults are fine for a demo
and not fine for real users.

---

## What you are deploying

One Node process. It serves the API *and* the static app, so there is no
separate frontend host, no build step, and no second service to keep in sync.

```
Browser ──HTTPS──> Node (Express) ──> SQLite file on a mounted volume
                        │
                        └──> Nominatim / OSRM / Photon / Overpass (outbound)
```

Two consequences shape every option below:

1. **The SQLite file must live on a persistent volume.** Community reports,
   alerts and trips are written at runtime. If the filesystem is wiped on each
   deploy, that data is gone.
2. **Routing and geocoding are outbound calls to public demo servers.** They are
   rate-limited and not meant for production traffic. See
   [Self-host the routing services](#self-host-the-routing-services) before you
   expect real load.

---

## Option 1 — Docker (recommended, works anywhere)

The `Dockerfile` is a multi-stage Node 24 image that runs as a non-root user.

```bash
docker build -t safepath .

docker run -d \
  --name safepath \
  -p 3000:3000 \
  -v safepath-data:/data \
  safepath
```

Open <http://localhost:3000>.

The first boot finds an empty volume and seeds the synthetic dataset
automatically (847 incidents, 1,095 road features), then builds the hotspot
index. That takes a few seconds; the log shows it happening. On later boots it
skips the seed and goes straight to serving.

### Why the volume matters

```bash
-v safepath-data:/data
```

Without it, a new container starts with no database, re-seeds, and any reports
submitted by users are lost. With it, data survives restarts, rebuilds and
redeploys.

Confirm it is working:

```bash
# Submit a report, restart, and check it is still there.
curl -X POST localhost:3000/api/reports \
  -H 'Content-Type: application/json' \
  -d '{"lat":12.3052,"lng":76.6554,"type":"lighting","lighting":"dark","crowd":"empty"}'

docker restart safepath
curl -s localhost:3000/api/health | grep -o '"reports":[0-9]*'
```

### Docker Compose

```yaml
services:
  safepath:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - safepath-data:/data
    environment:
      NODE_ENV: production
      SAFEPATH_DB: /data/safepath.db
      # Set this to your real origin once you have a domain.
      SAFEPATH_CORS: https://your-domain.example
      # Put a real address here. Public defaults are for demos only.
      SAFEPATH_UA: SafePath/1.0 (contact: you@example.com)
    restart: unless-stopped

volumes:
  safepath-data:
```

---

## Option 2 — A managed platform

Any host that runs a Dockerfile and can mount a persistent disk will work.
The two things to get right on every one of them:

- **Attach a persistent volume and point `SAFEPATH_DB` at it.** On platforms
  with an ephemeral filesystem this is the difference between a real service and
  a demo that forgets everything on each deploy.
- **Set `SAFEPATH_UA` to a real contact address.** Nominatim and OSRM ask for
  this and may block anonymous traffic.

Platform notes:

| Platform | Volume | Notes |
|---|---|---|
| **Fly.io** | `fly volumes create safepath_data --size 1` | Mount at `/data`. Set `SAFEPATH_DB=/data/safepath.db`. Scale to a single instance — SQLite does not share across machines. |
| **Railway** | Add a Volume, mount at `/data` | Detects the Dockerfile automatically. |
| **Render** | Add a Disk at `/data` | Use a paid instance type; disks are not available on the free tier. |
| **A VPS** | Just a directory | Run the Docker command above, or use `systemd` with `npm start`. Put Caddy or nginx in front for HTTPS. |

**Keep it to one instance.** SQLite is a single file. Running two containers
against the same file over a network filesystem will corrupt it. If you need
horizontal scaling, move to PostgreSQL + PostGIS and rework `server/lib/db.js`.

### HTTPS is not optional

Two features need a secure origin:

- **Service worker / install-to-home-screen.** Browsers only allow this on
  HTTPS (or `localhost`).
- **Geolocation.** The "current location" button and the panic button will not
  work over plain HTTP on a real device.

Put the app behind a reverse proxy with a certificate, or use a platform that
gives you one automatically.

---

## Option 3 — Run it directly

```bash
npm ci --omit=dev
SAFEPATH_DB=/var/lib/safepath/safepath.db PORT=3000 npm start
```

A minimal `systemd` unit:

```ini
[Unit]
Description=SafePath
After=network.target

[Service]
Type=simple
User=safepath
WorkingDirectory=/opt/safepath
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=SAFEPATH_DB=/var/lib/safepath/safepath.db
Environment=SAFEPATH_UA=SafePath/1.0 (contact: you@example.com)
ExecStart=/usr/bin/node server/index.js
Restart=always
# The server handles SIGTERM, checkpoints SQLite, then exits.
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

`server/index.js` closes the database cleanly on `SIGTERM`, so a restart or
redeploy will not leave a half-written WAL behind.

---

## Environment variables for production

Everything below is optional locally. These are the ones that matter in
production.

| Variable | Set it to | Why |
|---|---|---|
| `SAFEPATH_DB` | `/data/safepath.db` | Puts the database on the persistent volume. |
| `SAFEPATH_CORS` | Your real origin | The default is `*`, which lets any site call your API. |
| `SAFEPATH_UA` | `SafePath/1.0 (contact: you@example.com)` | Nominatim and OSRM require an identifying User-Agent. |
| `NOMINATIM_URL` | Your own instance | The public instance forbids heavy use. |
| `OSRM_FOOT_URL` etc. | Your own instance | Same reason. |
| `SAFEPATH_REPORT_LIMIT` | `5` (default) | Reports per IP per window. |
| `SAFEPATH_ALERT_WEBHOOK` | A real endpoint | Otherwise panic alerts are demo-only. |

---

## Self-host the routing services

This is the step that most often gets skipped, and it is the one that will bite
you first. The defaults point at public community servers that are run as
demos. They will rate-limit or block production traffic, and heavy use is
against their usage policies.

Run your own:

- **OSRM** — <https://github.com/Project-OSRM/osrm-backend>. Download a Karnataka
  or India OSM extract, `osrm-extract` / `osrm-partition` / `osrm-customize`
  once per profile (foot, bike, car), then run `osrm-routed`. Point
  `OSRM_FOOT_URL`, `OSRM_BIKE_URL` and `OSRM_CAR_URL` at it.
- **Nominatim** — <https://github.com/osm-search/Nominatim>. Heavier to run
  (needs PostgreSQL + PostGIS). Point `NOMINATIM_URL` at it.
- **Photon** (autocomplete) — <https://github.com/komoot/photon>. Or use a keyed
  provider: set `SAFEPATH_PLACES_PROVIDER=geoapify` with `GEOAPIFY_API_KEY`.
- **Overpass** — only needed when you pull OSM safety features. Run it once
  during setup rather than from the live server.

The app already caches geocoding and routing responses in memory, so repeated
requests for the same journey do not hit the upstream service again.

---

## First-run data

On a fresh volume the server seeds **synthetic** data so the app works
immediately. This is clearly labelled: `/api/health` reports
`"data_source": "synthetic"` and the UI shows a "sample data" chip. Do not
present synthetic data as real.

To load real data:

```bash
# 1. Import incidents from a CSV.
#    Columns: lat, lng, type, severity, timestamp, source, verified
npm run import -- incidents.csv --replace

# 2. Optionally pull real OSM safety features (street lamps, lit roads,
#    police, hospitals, shops, bus stops) for the area you cover.
npm run osm:pull

# 3. Rebuild the hotspot index and model from the imported data.
npm run ds:build
```

`npm run import` with `--replace` deletes existing incidents. It does **not**
touch community reports. Re-running `npm run seed` *does* clear reports — that
is why the server only ever seeds an empty database.

After importing, `data_source` changes from `synthetic` to whatever your import
sets, and the sample-data chip disappears.

### Optional: train the ML baseline

The logistic-regression baseline trains as part of the normal build:

```bash
npm run ds:build
```

It fits on grid cells × time buckets and prints honest validation metrics (AUC,
accuracy, Brier score, base rate) to the console:

```
[ds] ML baseline (logistic_regression (pure JS, gradient descent)):
     AUC=0.6914 acc=0.6844 brier=0.2095 base_rate=0.4044 (1036 samples, 419 positive)
```

It is a sanity check on the transparent weighted formula, not a replacement for
it. Report the numbers as they come out, including when they are unimpressive —
an AUC near 0.69 is honest and modest, and the safety score the app actually
uses is the transparent formula, not this model.

---

## Verify a deployment

```bash
# The API is up and reports its data source.
curl -s https://your-domain.example/api/health

# Risk changes with time of day, as it should.
curl -s "https://your-domain.example/api/risk?lat=12.3052&lng=76.6554&time=afternoon"
curl -s "https://your-domain.example/api/risk?lat=12.3052&lng=76.6554&time=night"

# The app itself.
curl -s -o /dev/null -w '%{http_code}\n' https://your-domain.example/

# The PWA pieces.
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://your-domain.example/manifest.webmanifest
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://your-domain.example/sw.js
```

Then run the browser suites against it:

```bash
BASE=https://your-domain.example npm run test:all
```

On a phone, open the URL and use "Add to Home Screen". The app should launch
full-screen with no browser chrome. Turn on airplane mode and reload: the app
shell should still open, with a warning that live data is unavailable.

---

## Safety and honesty in production

These are product requirements, not nice-to-haves. Please keep them.

- **Never present a score as a guarantee.** The disclaimer — "Estimate based on
  reported data, not a guarantee of safety" — must stay visible on any page that
  shows a risk score or a ranked route. The API repeats it in its responses.
- **Say when alerts are demo-only.** A panic alert with no
  `SAFEPATH_ALERT_WEBHOOK`, `SAFEPATH_ALERT_SMS_URL` or `SAFEPATH_ALERT_EMAIL_URL`
  configured goes nowhere. The UI states this plainly. Do not remove that text
  while the backend is unconfigured — a user must never believe an alert was
  delivered when it was not.
- **Do not name neighbourhoods as dangerous.** Show counts, recency and the
  underlying reports. Let people draw their own conclusions.
- **Keep report locations area-level.** Coordinates are rounded to roughly
  110 m before storage. Do not add precise traces.
- **Keep the rate limit on.** `POST /api/reports` is limited per IP. If you put
  it behind a proxy, make sure the client IP is forwarded correctly, or every
  user will share one bucket.
- **Label synthetic data.** If you deploy without importing real incidents, the
  sample-data chip stays on. That is correct.

---

## Backups

The whole state is one SQLite file.

```bash
# Safe while running: SQLite's backup command takes a consistent snapshot.
docker exec safepath node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/data/safepath.db');
  db.exec(\"VACUUM INTO '/data/backup.db'\");
  db.close();
"
docker cp safepath:/data/backup.db ./safepath-$(date +%F).db
```

Copying `safepath.db` alone while the server is writing can miss recent
transactions held in the WAL. Use the snapshot above, or stop the container
first.

---

## Troubleshooting

**The app loads but every route fails.**
Outbound access to Nominatim/OSRM is blocked, or you are being rate-limited.
Check the server log and set `SAFEPATH_UA` to a real contact address.

**Reports vanish after a deploy.**
No persistent volume, or `SAFEPATH_DB` is not pointing at it.

**Install prompt never appears.**
Needs HTTPS and a valid manifest. Chrome also requires the icons to load — check
`/icon-192.png` and `/icon-512.png` return 200.

**The service worker serves an old page.**
It should not: it is network-first, so a deploy is picked up on the next load.
If a device is stuck, the cached copy is only used when the network fails. Force
a refresh once and it will re-fetch.

**`npm ci` fails with "lock file out of sync".**
Run `npm install` and commit the updated `package-lock.json`.

**Risk scores all look the same.**
The database is probably empty or only has a handful of incidents. Check
`/api/health` counts.
