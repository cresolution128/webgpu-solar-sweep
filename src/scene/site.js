// ---------------------------------------------------------------------------
// site — the scene, authored in local metres and placed on the ellipsoid
//
// A flat-roof commercial array, because that is where shading actually decides
// the yield: tilted rows shade the row behind them at low sun, and that
// inter-row loss is the single largest term in a winter month. A pitched
// domestic roof would look prettier and prove less.
//
// Everything is authored in local east-north-up metres, which is how a human
// thinks about a building, and converted to ECEF exactly once at the end. The
// geometry is deliberately simple — boxes — because the demo is about the
// analysis pipeline, not about mesh authoring.
// ---------------------------------------------------------------------------

import { createSite } from '../geo/frame.js';

// A real place, so the sun angles are real: an industrial unit in Slough, west
// of London. Latitude drives everything about the annual shading pattern.
export const SITE_LAT = 51.5085;
export const SITE_LON = -0.5951;
export const SITE_HEIGHT = 25;

const ROOF_Z = 8; // warehouse roof height, metres
const ROOF_HALF_E = 30; // 60 m east-west
const ROOF_HALF_N = 20; // 40 m north-south

// Array layout. Portrait-landscape and pitch are the numbers an installer
// argues about, so they are named rather than inlined.
const PANEL_WIDTH = 1.7; // east-west
const PANEL_LENGTH = 1.0; // along the slope
const PANEL_TILT_DEG = 10; // typical UK flat-roof ballast tilt
const ROW_PITCH = 2.2; // north-south spacing between row fronts
const ARRAY_INSET = 2.0; // keep clear of the roof edge
const MOUNT_CLEARANCE = 0.3; // front edge above the roof deck

// Authored as display-space colours: the shader decodes them to linear before
// lighting and re-encodes on the way out.
const COLORS = {
  ground: [0.46, 0.49, 0.40],
  roof: [0.56, 0.57, 0.59],
  wall: [0.68, 0.66, 0.62],
  tower: [0.62, 0.62, 0.65],
  plant: [0.38, 0.39, 0.41],
  trunk: [0.40, 0.31, 0.23],
  leaves: [0.30, 0.48, 0.26],
};

/** Push one axis-aligned box, given min and max corners in local ENU metres. */
const pushBox = (out, min, max, color) => {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;

  // Each face as two triangles, with an explicit outward normal. Written out
  // rather than generated so the winding is obvious and reviewable.
  const faces = [
    { n: [0, 0, 1], v: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y0, z1], [x1, y1, z1], [x0, y1, z1]] }, // top
    { n: [0, 0, -1], v: [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y1, z0], [x1, y0, z0], [x0, y0, z0]] }, // bottom
    { n: [0, -1, 0], v: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z0], [x1, y0, z1], [x0, y0, z1]] }, // south
    { n: [0, 1, 0], v: [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z0], [x0, y1, z1], [x1, y1, z1]] }, // north
    { n: [-1, 0, 0], v: [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z0], [x0, y0, z1], [x0, y1, z1]] }, // west
    { n: [1, 0, 0], v: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z0], [x1, y1, z1], [x1, y0, z1]] }, // east
  ];

  for (const face of faces) {
    for (const v of face.v) {
      out.local.push(v[0], v[1], v[2]);
      out.normal.push(face.n[0], face.n[1], face.n[2]);
      out.color.push(color[0], color[1], color[2]);
    }
  }
};

const pushTree = (out, e, n, height) => {
  const trunkR = 0.35;
  const crownR = 2.6;
  const crownBase = height * 0.35;
  pushBox(out, [e - trunkR, n - trunkR, 0], [e + trunkR, n + trunkR, crownBase + 1], COLORS.trunk);
  // Two stacked boxes read as a crown from any angle and cost 24 triangles.
  pushBox(out, [e - crownR, n - crownR, crownBase], [e + crownR, n + crownR, height * 0.82], COLORS.leaves);
  pushBox(out, [e - crownR * 0.6, n - crownR * 0.6, height * 0.78], [e + crownR * 0.6, n + crownR * 0.6, height], COLORS.leaves);
};

/**
 * Build the whole site. Returns geometry in ECEF (f64) plus the panel
 * instances, ready to be downcast by geo/frame.buildPositions.
 */
export const buildSite = () => {
  const site = createSite(SITE_LAT, SITE_LON, SITE_HEIGHT);
  const out = { local: [], normal: [], color: [] };

  // Ground, a little below the building base so there is no coplanar fight.
  pushBox(out, [-140, -140, -0.4], [140, 140, -0.05], COLORS.ground);

  // The warehouse: walls, then the roof deck as a thin slab on top.
  pushBox(out, [-ROOF_HALF_E, -ROOF_HALF_N, 0], [ROOF_HALF_E, ROOF_HALF_N, ROOF_Z - 0.2], COLORS.wall);
  pushBox(out, [-ROOF_HALF_E, -ROOF_HALF_N, ROOF_Z - 0.2], [ROOF_HALF_E, ROOF_HALF_N, ROOF_Z], COLORS.roof);

  // Rooftop plant. These are the obstacles that produce the awkward local
  // shading an installer has to design around.
  pushBox(out, [-20, 10, ROOF_Z], [-15, 14, ROOF_Z + 2.6], COLORS.plant);
  pushBox(out, [4, 12, ROOF_Z], [9, 15, ROOF_Z + 2.2], COLORS.plant);
  pushBox(out, [18, -6, ROOF_Z], [21, -3, ROOF_Z + 1.8], COLORS.plant);

  // A taller neighbour to the south-west. In the northern hemisphere the sun
  // is always in the southern half of the sky, so this is the one that hurts.
  pushBox(out, [-72, -62, 0], [-46, -36, 29], COLORS.tower);

  // Trees along the southern boundary.
  pushTree(out, 8, -34, 13);
  pushTree(out, -12, -31, 11);
  pushTree(out, 30, -30, 14.5);

  // --- panels -------------------------------------------------------------
  const tilt = (PANEL_TILT_DEG * Math.PI) / 180;
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  const halfW = PANEL_WIDTH / 2;
  const halfL = PANEL_LENGTH / 2;

  // In-plane axes. `right` runs east; `slope` runs from the low southern edge
  // up toward the north, lifted by the tilt. The normal is their cross product
  // and points south and up, which is where the sun is.
  const rightEnu = [1, 0, 0];
  const slopeEnu = [0, cosT, sinT];
  const normalEnu = [0, -sinT, cosT];

  const usableE = ROOF_HALF_E - ARRAY_INSET;
  const usableN = ROOF_HALF_N - ARRAY_INSET;
  const cols = Math.floor((usableE * 2) / (PANEL_WIDTH + 0.02));
  const rows = Math.floor((usableN * 2) / ROW_PITCH);

  const centersLocal = [];
  const startE = -((cols - 1) * (PANEL_WIDTH + 0.02)) / 2;
  const startN = -((rows - 1) * ROW_PITCH) / 2;
  const centerZ = ROOF_Z + MOUNT_CLEARANCE + halfL * sinT;

  // Keep-out zones around the rooftop plant. An installer leaves an access and
  // maintenance margin around every unit, and without one the layout drops
  // modules inside an air handler that then report zero sun for the whole year
  // and drag the array average down for a reason that is not shading.
  const PLANT_CLEARANCE = 1.2;
  const keepOut = [
    [-20, 10, -15, 14],
    [4, 12, 9, 15],
    [18, -6, 21, -3],
  ].map(([e0, n0, e1, n1]) => [
    e0 - PLANT_CLEARANCE, n0 - PLANT_CLEARANCE,
    e1 + PLANT_CLEARANCE, n1 + PLANT_CLEARANCE,
  ]);

  const blocked = (e, n) =>
    keepOut.some(([e0, n0, e1, n1]) =>
      e + halfW > e0 && e - halfW < e1 && n + halfL > n0 && n - halfL < n1);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const e = startE + c * (PANEL_WIDTH + 0.02);
      const n = startN + r * ROW_PITCH;
      if (blocked(e, n)) continue;
      centersLocal.push([e, n, centerZ]);
    }
  }

  // --- to ECEF ------------------------------------------------------------
  const vertexCount = out.local.length / 3;
  const positionsEcef = new Float64Array(out.local.length);
  for (let i = 0; i < vertexCount; i++) {
    const p = site.localToEcef(out.local[i * 3], out.local[i * 3 + 1], out.local[i * 3 + 2]);
    positionsEcef[i * 3 + 0] = p[0];
    positionsEcef[i * 3 + 1] = p[1];
    positionsEcef[i * 3 + 2] = p[2];
  }

  const normalsEcef = new Float32Array(out.local.length);
  for (let i = 0; i < vertexCount; i++) {
    const n = site.localDirToEcef(out.normal[i * 3], out.normal[i * 3 + 1], out.normal[i * 3 + 2]);
    normalsEcef[i * 3 + 0] = n[0];
    normalsEcef[i * 3 + 1] = n[1];
    normalsEcef[i * 3 + 2] = n[2];
  }

  const panelCount = centersLocal.length;
  const panelCentersEcef = new Float64Array(panelCount * 3);
  for (let i = 0; i < panelCount; i++) {
    const p = site.localToEcef(centersLocal[i][0], centersLocal[i][1], centersLocal[i][2]);
    panelCentersEcef[i * 3 + 0] = p[0];
    panelCentersEcef[i * 3 + 1] = p[1];
    panelCentersEcef[i * 3 + 2] = p[2];
  }

  const panelRight = site.localDirToEcef(...rightEnu);
  const panelSlope = site.localDirToEcef(...slopeEnu);
  const panelNormal = site.localDirToEcef(...normalEnu);

  return {
    site,
    // render origin: the centre of the roof, so every offset the GPU sees is
    // tens of metres rather than millions.
    renderOrigin: site.localToEcef(0, 0, ROOF_Z),
    mesh: {
      positionsEcef,
      normalsEcef,
      colors: new Float32Array(out.color),
      vertexCount,
    },
    panels: {
      count: panelCount,
      cols,
      rows,
      centersEcef: panelCentersEcef,
      right: panelRight,
      slope: panelSlope,
      normal: panelNormal,
      halfWidth: halfW,
      halfLength: halfL,
      tiltDeg: PANEL_TILT_DEG,
      rowPitch: ROW_PITCH,
    },
    // A bounding radius in metres, used to fit the sun's orthographic frustum.
    radius: 150,
  };
};

/**
 * Pack the panel instance buffer. Layout matches the WGSL `Panel` struct:
 * four vec4s, with the half-extents tucked into the unused w components so the
 * struct stays 64 bytes and naturally aligned.
 */
export const packPanels = (panels, renderOrigin, mode) => {
  const data = new Float32Array(panels.count * 16);
  const absolute = mode === 'absolute';
  for (let i = 0; i < panels.count; i++) {
    const o = i * 16;
    const cx = panels.centersEcef[i * 3 + 0];
    const cy = panels.centersEcef[i * 3 + 1];
    const cz = panels.centersEcef[i * 3 + 2];
    data[o + 0] = absolute ? cx : cx - renderOrigin[0];
    data[o + 1] = absolute ? cy : cy - renderOrigin[1];
    data[o + 2] = absolute ? cz : cz - renderOrigin[2];
    data[o + 3] = 0;
    data[o + 4] = panels.right[0];
    data[o + 5] = panels.right[1];
    data[o + 6] = panels.right[2];
    data[o + 7] = panels.halfWidth;
    data[o + 8] = panels.slope[0];
    data[o + 9] = panels.slope[1];
    data[o + 10] = panels.slope[2];
    data[o + 11] = panels.halfLength;
    data[o + 12] = panels.normal[0];
    data[o + 13] = panels.normal[1];
    data[o + 14] = panels.normal[2];
    data[o + 15] = 0;
  }
  return data;
};
