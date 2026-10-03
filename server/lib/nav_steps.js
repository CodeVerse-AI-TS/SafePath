/* ==========================================================================
   SafePath turn-by-turn instruction builder
   --------------------------------------------------------------------------
   Turns raw OSRM manoeuvres (from `steps=true`) into the small, stable shape
   the navigation screen consumes:

     { along_m, distance_m, text, street, icon, modifier, exit, arrive }

   `along_m` is the distance from the start of the route to the point where the
   manoeuvre happens, so the client only has to compare it against how far the
   user has travelled. Nothing here talks to the network or the database, so it
   is unit tested directly.

   OSRM's own `distance` on a step is the length of the road you travel *after*
   the manoeuvre, and `maneuver.location` is the junction. We therefore walk the
   geometry once, accumulating distance, and record the cumulative distance at
   each manoeuvre point.
   ========================================================================== */
'use strict';

const { haversineM } = require('./geo');

/** Cardinal direction of a turn, for the "head north" style instruction. */
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
function compassWord(bearing) {
  const i = Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
  return COMPASS[i];
}

/** Human word for a relative turn direction, from OSRM's modifier. */
function modifierWord(modifier) {
  switch (modifier) {
    case 'sharp right': return 'sharp right';
    case 'right': return 'right';
    case 'slight right': return 'slight right';
    case 'sharp left': return 'sharp left';
    case 'left': return 'left';
    case 'slight left': return 'slight left';
    case 'straight': return 'straight';
    case 'uturn': return 'U-turn';
    default: return '';
  }
}

/**
 * Which icon the UI should draw. Kept to a small, closed set so the CSS can
 * style each one and the banner never depends on colour alone.
 *
 * OSRM's modifiers are exact strings ('slight right', 'sharp left', ...), so
 * they are matched exactly rather than by prefix: 'slight right' does not begin
 * with 'right', and treating it as a plain right turn would lose the nuance.
 */
function iconFor(maneuver, street) {
  const type = maneuver && maneuver.type;
  const mod = maneuver && maneuver.modifier;
  const side = mod && mod.endsWith('left') ? 'left' : mod && mod.endsWith('right') ? 'right' : null;

  if (type === 'arrive') return 'arrive';
  if (type === 'depart') return 'depart';
  if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') return 'roundabout';
  if (type === 'merge') return 'merge';
  if (type === 'fork') return side === 'left' ? 'fork-left' : 'fork-right';
  if (type === 'on ramp' || type === 'off ramp') return side === 'left' ? 'ramp-left' : 'ramp-right';
  if (type === 'end of road') return side === 'left' ? 'turn-left' : 'turn-right';

  switch (mod) {
    case 'uturn': return 'uturn';
    case 'slight left': return 'slight-left';
    case 'slight right': return 'slight-right';
    case 'sharp left': return 'sharp-left';
    case 'sharp right': return 'sharp-right';
    case 'left': return 'turn-left';
    case 'right': return 'turn-right';
    default: break;
  }
  if (type === 'new name' || type === 'continue' || type === 'turn' || !type) {
    return street ? 'continue' : 'straight';
  }
  return 'straight';
}

/** Short street name: OSRM sometimes gives "MG Road (Mysuru)"; keep the road. */
function cleanStreet(name) {
  if (!name) return '';
  return String(name).replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * The instruction sentence. Deliberately plain and free of hard-coded demo
 * copy: every word comes from the manoeuvre or the street name OSRM returned.
 */
function textFor(maneuver, street, opts = {}) {
  const type = maneuver && maneuver.type;
  const mod = maneuver && maneuver.modifier;
  const onto = street ? ` onto ${street}` : '';

  switch (type) {
    case 'depart': {
      const dir = opts.bearing != null ? ` ${compassWord(opts.bearing)}` : '';
      return street ? `Head${dir} on ${street}` : `Head${dir}`.trim();
    }
    case 'arrive':
      return 'Arrive at your destination';
    case 'roundabout':
    case 'rotary':
    case 'roundabout turn': {
      const exit = maneuver && maneuver.exit;
      const n = exit ? `${exit}${ordinalSuffix(exit)} exit` : 'the roundabout';
      return `Take ${n}${onto}`;
    }
    case 'merge': {
      const w = modifierWord(mod);
      return `Merge${w ? ' ' + w : ''}${onto}`;
    }
    case 'fork': {
      const w = modifierWord(mod) || 'right';
      return `Keep ${w}${onto}`;
    }
    case 'on ramp': {
      const w = modifierWord(mod);
      return `Take the ramp${w ? ' on the ' + w : ''}${onto}`;
    }
    case 'off ramp': {
      const w = modifierWord(mod);
      return `Take the exit${w ? ' on the ' + w : ''}${onto}`;
    }
    case 'end of road': {
      const w = modifierWord(mod) || 'right';
      return `Turn ${w}${onto}`;
    }
    case 'new name':
      return street ? `Continue onto ${street}` : 'Continue straight';
    case 'notification':
      return maneuver && maneuver.instruction ? String(maneuver.instruction) : 'Continue';
    default: {
      if (mod === 'uturn') return 'Make a U-turn';
      const w = modifierWord(mod);
      if (w && w !== 'straight') return `Turn ${w}${onto}`;
      return street ? `Continue onto ${street}` : 'Continue straight';
    }
  }
}

function ordinalSuffix(n) {
  const i = Math.abs(Number(n)) % 100;
  if (i >= 11 && i <= 13) return 'th';
  switch (i % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

/**
 * Build steps from an OSRM route object ({ coords, legs }).
 *
 * Returns [] when the upstream response carried no steps, so a caller can fall
 * back to a "follow the highlighted route" banner rather than inventing turns.
 */
function buildSteps(route) {
  if (!route || !route.legs || !route.legs.length) return [];
  const coords = route.coords || [];

  // Cumulative distance along the route geometry, so a manoeuvre's position on
  // the line is known even though OSRM reports it as a bare coordinate.
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
  }
  const total = cum[cum.length - 1] || 0;

  // Map every manoeuvre coordinate to the nearest vertex of the geometry.
  // The geometry is dense (full overview), so the nearest vertex is within a
  // few metres of the junction.
  function alongOf(loc) {
    if (!loc) return 0;
    const [lng, lat] = loc;
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const d = haversineM(lat, lng, coords[i][0], coords[i][1]);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    return cum[bestI];
  }

  const raw = [];
  for (const leg of route.legs) {
    for (const s of (leg.steps || [])) {
      raw.push(s);
    }
  }

  const steps = raw.map((s, i) => {
    const street = cleanStreet(s.name);
    const along = alongOf(s.maneuver && s.maneuver.location);
    const next = raw[i + 1];
    // OSRM's step.distance is the length travelled on this step; trust the
    // geometry-derived difference when both are available so the numbers stay
    // consistent with the rest of the app.
    const nextAlong = next ? alongOf(next.maneuver && next.maneuver.location) : total;
    const distance = Math.max(0, Math.round(nextAlong - along)) || Math.round(s.distance || 0);
    const bearing = s.maneuver && s.maneuver.bearing_after;
    return {
      along_m: Math.round(along),
      distance_m: distance,
      text: textFor(s.maneuver, street, { bearing: bearing != null ? bearing : s.maneuver && s.maneuver.bearing_before }),
      street: street || null,
      icon: iconFor(s.maneuver, street),
      modifier: (s.maneuver && s.maneuver.modifier) || null,
      type: (s.maneuver && s.maneuver.type) || null,
      exit: (s.maneuver && s.maneuver.exit) || null,
      bearing_after: bearing != null ? bearing : null,
    };
  });

  // Guard against a degenerate response: keep steps in order and drop any that
  // would make the banner jump backwards.
  let last = -1;
  return steps.filter((s) => {
    if (s.along_m < last) return false;
    last = s.along_m;
    return true;
  });
}

module.exports = { buildSteps, iconFor, textFor, modifierWord, compassWord, ordinalSuffix, cleanStreet };
