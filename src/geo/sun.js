// ---------------------------------------------------------------------------
// sun — solar position, and the month x hour grid the sweep runs over
//
// The NOAA low-precision algorithm. Accurate to well under a tenth of a degree
// over a few centuries either side of 2000, which is far better than the
// geometry it is being cast against: a photogrammetry roof is wrong by tens of
// centimetres, so chasing arcseconds here would be spending effort in the wrong
// place.
//
// Everything is computed in the site's local east-north-up frame and only then
// rotated into ECEF, because "where is the sun" is a local question and the
// answer is meaningless as a raw geocentric vector.
//
// The grid is 12 months x 24 hours, sampled on one representative day per
// month. That is the same 288-cell grid the Zervio shading sweep uses, and it
// is the standard shape for an annual shading loss figure: fine enough to catch
// the winter morning inter-row shading that dominates a flat-roof array, coarse
// enough to be a fixed, cacheable cost.
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export const MONTHS = 12;
export const HOURS = 24;
export const GRID_CELLS = MONTHS * HOURS;

// One representative day per month: the 15th, which is close enough to the
// month's mean declination that the annual total is not biased.
const REP_DAY = 15;

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export const monthName = m => MONTH_NAMES[m];

/** Day of year for the representative day of month `m` (0-based), ignoring leap years. */
const dayOfYear = m => {
  const cumulative = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return cumulative[m] + REP_DAY;
};

/**
 * Solar elevation and azimuth for a month/hour cell, in radians.
 * `hour` is local solar-ish time; the equation of time is applied, the
 * longitude correction is folded in via `lonDeg`, and no daylight-saving
 * adjustment is made because an annual energy figure should not have one.
 */
export const sunAngles = (latDeg, lonDeg, month, hour) => {
  const n = dayOfYear(month);

  // Fractional year, radians.
  const gamma = ((2 * Math.PI) / 365) * (n - 1 + (hour - 12) / 24);

  // Equation of time, minutes.
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  // Solar declination, radians.
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  // True solar time in minutes, then the hour angle.
  // `hour` is treated as local standard time at the site's own meridian, so the
  // longitude term reduces to the equation of time alone.
  const trueSolarTime = hour * 60 + eqTime;
  const hourAngle = (trueSolarTime / 4 - 180) * DEG;

  const lat = latDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);

  const cosZenith =
    sinLat * Math.sin(decl) + cosLat * Math.cos(decl) * Math.cos(hourAngle);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith)));
  const elevation = Math.PI / 2 - zenith;

  // Azimuth measured clockwise from north.
  let azimuth = Math.atan2(
    -Math.sin(hourAngle),
    Math.tan(decl) * cosLat - sinLat * Math.cos(hourAngle),
  );
  if (azimuth < 0) azimuth += 2 * Math.PI;

  return { elevation, azimuth, elevationDeg: elevation * RAD, azimuthDeg: azimuth * RAD };
};

/**
 * Unit vector pointing from the site TOWARD the sun, in local ENU.
 * Returns null when the sun is below the horizon, which the sweep uses to skip
 * the cell entirely rather than accumulate a zero.
 */
export const sunDirectionEnu = (latDeg, lonDeg, month, hour) => {
  const { elevation, azimuth } = sunAngles(latDeg, lonDeg, month, hour);
  if (elevation <= 0) return null;
  const cosEl = Math.cos(elevation);
  return [
    cosEl * Math.sin(azimuth), // east
    cosEl * Math.cos(azimuth), // north
    Math.sin(elevation), // up
  ];
};

/** Every daylight cell in the annual grid, in month-major order. */
export const daylightCells = (latDeg, lonDeg) => {
  const cells = [];
  for (let m = 0; m < MONTHS; m++) {
    for (let h = 0; h < HOURS; h++) {
      const dir = sunDirectionEnu(latDeg, lonDeg, m, h);
      if (dir) cells.push({ month: m, hour: h, dirEnu: dir });
    }
  }
  return cells;
};
