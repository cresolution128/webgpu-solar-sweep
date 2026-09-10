// ---------------------------------------------------------------------------
// mat4 — column-major 4x4 matrices, computed in double precision.
//
// Everything here returns Float64Array. That is deliberate: the whole point of
// this demo is that the large-coordinate arithmetic happens on the CPU, where
// we still have 64-bit floats, and only small numbers are ever downcast for
// the GPU. WGSL has no f64 at all, so anything that reaches a shader has
// already lost precision — see geo/frame.js for what we do about that.
//
// Clip space is WebGPU's, not OpenGL's: x and y in [-1, 1] with y up, and z in
// [0, 1]. The projection builders below are the zero-to-one variants for that
// reason; a GL-style matrix would render everything at half depth.
// ---------------------------------------------------------------------------

export const create = () =>
  new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export const multiply = (a, b, out = new Float64Array(16)) => {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4 + 0];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    out[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
};

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = a => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export const vec = { sub3, cross3, dot3, norm3 };

/** Right-handed look-at. `eye`, `target` and `up` are plain 3-arrays. */
export const lookAt = (eye, target, up) => {
  const f = norm3(sub3(target, eye)); // forward
  let s = cross3(f, up); // right
  if (Math.hypot(s[0], s[1], s[2]) < 1e-12) {
    // Degenerate: the view direction is parallel to `up`. Nudge with any axis
    // that is not collinear so the basis stays well conditioned.
    s = cross3(f, Math.abs(f[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
  }
  s = norm3(s);
  const u = cross3(s, f); // true up

  const m = create();
  m[0] = s[0]; m[4] = s[1]; m[8] = s[2]; m[12] = -dot3(s, eye);
  m[1] = u[0]; m[5] = u[1]; m[9] = u[2]; m[13] = -dot3(u, eye);
  m[2] = -f[0]; m[6] = -f[1]; m[10] = -f[2]; m[14] = dot3(f, eye);
  m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
  return m;
};

/** Perspective with depth mapped to [0, 1] (WebGPU / D3D convention). */
export const perspective = (fovYRadians, aspect, near, far) => {
  const f = 1 / Math.tan(fovYRadians / 2);
  const m = new Float64Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (far * near) / (near - far);
  return m;
};

/** Orthographic with depth mapped to [0, 1]. Used for the sun's view. */
export const orthographic = (left, right, bottom, top, near, far) => {
  const m = create();
  m[0] = 2 / (right - left);
  m[5] = 2 / (top - bottom);
  m[10] = 1 / (near - far);
  m[12] = -(right + left) / (right - left);
  m[13] = -(top + bottom) / (top - bottom);
  m[14] = near / (near - far);
  return m;
};

/** Downcast for upload. This is the only place precision is intentionally lost. */
export const toF32 = m => {
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = m[i];
  return out;
};
