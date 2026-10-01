'use strict';
/** Small geodesic helpers (haversine, interpolation, route sampling). */

const R_EARTH = 6371008.8; // metres

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in metres between two [lat, lng] pairs. */
function haversineM(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Total length in metres of a [[lat,lng], ...] polyline. */
function lineLengthM(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return total;
}

/**
 * Resample a polyline at ~`stepM` metre intervals, linearly interpolating
 * between the original vertices. Returns [[lat,lng], ...] including both ends.
 */
function sampleLine(coords, stepM = 30) {
  if (!coords || coords.length === 0) return [];
  if (coords.length === 1) return [coords[0].slice()];
  const out = [coords[0].slice()];
  let carry = 0; // distance already travelled into the current segment
  for (let i = 1; i < coords.length; i++) {
    const [aLat, aLng] = coords[i - 1];
    const [bLat, bLng] = coords[i];
    const segLen = haversineM(aLat, aLng, bLat, bLng);
    if (segLen === 0) continue;
    let d = stepM - carry;
    while (d <= segLen) {
      const t = d / segLen;
      out.push([aLat + (bLat - aLat) * t, aLng + (bLng - aLng) * t]);
      d += stepM;
    }
    carry = (carry + segLen) % stepM;
  }
  const last = coords[coords.length - 1];
  const tail = out[out.length - 1];
  if (haversineM(tail[0], tail[1], last[0], last[1]) > 1) out.push(last.slice());
  return out;
}

/** Bounding box [minLat, minLng, maxLat, maxLng] of a polyline or point list. */
function bboxOf(coords) {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const [lat, lng] of coords) {
    if (lat < minLat) minLat = lat;
    if (lng < minLng) minLng = lng;
    if (lat > maxLat) maxLat = lat;
    if (lng > maxLng) maxLng = lng;
  }
  return [minLat, minLng, maxLat, maxLng];
}

/** Expand a bbox by `m` metres on every side. */
function expandBbox(bbox, m) {
  const [minLat, minLng, maxLat, maxLng] = bbox;
  const dLat = m / 111320;
  const midLat = (minLat + maxLat) / 2;
  const dLng = m / (111320 * Math.max(0.1, Math.cos(toRad(midLat))));
  return [minLat - dLat, minLng - dLng, maxLat + dLat, maxLng + dLng];
}

/** Project a point `distM` metres from [lat,lng] on bearing `bearingDeg`. */
function destination(lat, lng, distM, bearingDeg) {
  const br = toRad(bearingDeg);
  const dr = distM / R_EARTH;
  const lat1 = toRad(lat);
  const lng1 = toRad(lng);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(br)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(br) * Math.sin(dr) * Math.cos(lat1),
      Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2)
    );
  return [toDeg(lat2), toDeg(lng2)];
}

/**
 * Round coordinates to an area-level grid (~110 m at this latitude).
 * Used so user reports never store a precise personal trace.
 */
function areaLevel(lat, lng, gridM = 110) {
  const dLat = gridM / 111320;
  const dLng = gridM / (111320 * Math.cos(toRad(lat)));
  return [
    Math.round(lat / dLat) * dLat,
    Math.round(lng / dLng) * dLng,
  ];
}

module.exports = {
  R_EARTH, haversineM, lineLengthM, sampleLine, bboxOf, expandBbox, destination, areaLevel, toRad, toDeg,
};
