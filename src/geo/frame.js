// ---------------------------------------------------------------------------
// frame — WGS84 geodetic to earth-centred, and the local ENU basis on top of it
//
// WHY THIS FILE IS THE POINT OF THE DEMO
// --------------------------------------
// A geospatial 3D scene lives in earth-centred, earth-fixed coordinates
// (EPSG:4978). Every vertex is therefore about 6,378,000 metres from the
// origin. A 32-bit float carries roughly 24 bits of mantissa, so near 6.4e6 the
// spacing between representable values is
//
//     2^ceil(log2(6.4e6)) * 2^-24  =  2^23 * 2^-24  ≈  0.76 m
//
// A solar panel is 1.7 m wide. Storing its corners as absolute f32 quantises
// them onto a grid coarser than half the panel. WGSL has no f64 — there is no
// `double` in the shading language and none is planned — so this is not a bug
// you can fix inside the shader.
//
// The fix is to keep the big numbers on the CPU, where JavaScript numbers are
// already f64, and hand the GPU only differences. Pick a render origin near the
// scene, subtract it in f64, and upload the remainder. Local offsets are tens
// of metres, where f32 spacing is about 4 micrometres.
//
// The demo exposes both paths so the failure is visible rather than asserted:
// `buildPositions` in 'absolute' mode uploads raw ECEF and the geometry visibly
// shears apart. In 'relative' mode it uploads the offsets and everything is
// stable. Same scene, same shaders, one subtraction apart.
//
// This is the same discipline used to place sites in the Zervio designer, and
// it is what LuciadRIA is doing when it converts its geocentric camera into a
// local topocentric one before handing the frame to three.js.
// ---------------------------------------------------------------------------

const A = 6378137.0; // WGS84 semi-major axis, metres
const F = 1 / 298.257223563; // flattening
const E2 = F * (2 - F); // first eccentricity squared

const DEG = Math.PI / 180;

/**
 * Geodetic (degrees, degrees, metres above the ellipsoid) to ECEF metres.
 * Returned as a plain array of JS numbers, i.e. f64.
 */
export const geodeticToEcef = (latDeg, lonDeg, height) => {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  // Radius of curvature in the prime vertical.
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [
    (N + height) * cosLat * Math.cos(lon),
    (N + height) * cosLat * Math.sin(lon),
    (N * (1 - E2) + height) * sinLat,
  ];
};

/**
 * The local east / north / up basis at a geodetic position, expressed as unit
 * vectors in ECEF. These three columns are the rotation that takes a local
 * topocentric coordinate into the earth-centred frame.
 */
export const enuBasis = (latDeg, lonDeg) => {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  return {
    east: [-sinLon, cosLon, 0],
    north: [-sinLat * cosLon, -sinLat * sinLon, cosLat],
    up: [cosLat * cosLon, cosLat * sinLon, sinLat],
  };
};

/**
 * A site: an origin on the ellipsoid plus the basis that turns local metres
 * (east, north, up) into ECEF metres. All arithmetic here stays in f64.
 */
export const createSite = (latDeg, lonDeg, height = 0) => {
  const origin = geodeticToEcef(latDeg, lonDeg, height);
  const basis = enuBasis(latDeg, lonDeg);

  /** Local ENU metres to absolute ECEF metres. */
  const localToEcef = (e, n, u) => [
    origin[0] + basis.east[0] * e + basis.north[0] * n + basis.up[0] * u,
    origin[1] + basis.east[1] * e + basis.north[1] * n + basis.up[1] * u,
    origin[2] + basis.east[2] * e + basis.north[2] * n + basis.up[2] * u,
  ];

  /** A direction in local ENU rotated into ECEF. No translation. */
  const localDirToEcef = (e, n, u) => [
    basis.east[0] * e + basis.north[0] * n + basis.up[0] * u,
    basis.east[1] * e + basis.north[1] * n + basis.up[1] * u,
    basis.east[2] * e + basis.north[2] * n + basis.up[2] * u,
  ];

  return { latDeg, lonDeg, height, origin, basis, localToEcef, localDirToEcef };
};

/**
 * Turn an array of absolute ECEF positions (f64) into the Float32Array the GPU
 * will actually see.
 *
 *   'relative' — subtract the render origin first. Correct.
 *   'absolute' — upload the raw ECEF value. Wrong, and visibly so.
 *
 * Both paths go through the identical shader. The only difference is which
 * number survives the cast on this line.
 */
export const buildPositions = (ecefF64, renderOrigin, mode) => {
  const out = new Float32Array(ecefF64.length);
  if (mode === 'absolute') {
    for (let i = 0; i < ecefF64.length; i++) out[i] = ecefF64[i];
    return out;
  }
  for (let i = 0; i < ecefF64.length; i += 3) {
    out[i + 0] = ecefF64[i + 0] - renderOrigin[0];
    out[i + 1] = ecefF64[i + 1] - renderOrigin[1];
    out[i + 2] = ecefF64[i + 2] - renderOrigin[2];
  }
  return out;
};

/**
 * The f32 spacing at a given magnitude, so the UI can state the real number
 * rather than a hand-wave. Returns metres between adjacent representable
 * values near `magnitude`.
 */
export const f32SpacingAt = magnitude => {
  if (magnitude === 0) return 0;
  const exponent = Math.floor(Math.log2(Math.abs(magnitude)));
  return Math.pow(2, exponent - 23);
};
