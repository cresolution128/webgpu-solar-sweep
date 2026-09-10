// ---------------------------------------------------------------------------
// shaders — all WGSL for the demo
//
// Four programs, three bind groups, one shared uniform block.
//
//   group(0)  frame uniforms                 every stage
//   group(1)  panel instances (read-only)    vertex + compute
//   group(2)  shadow map + results           fragment (sample) / compute (write)
//
// The bind group layouts are declared explicitly in pipelines.js rather than
// derived with `layout: 'auto'`, because four pipelines share these resources
// and auto layouts would produce four incompatible sets of them.
//
// A note on the shadow lookup in `shadowFactor`: `textureSampleCompare` must be
// called from uniform control flow, so the out-of-frustum case cannot early
// return. It computes the PCF tap unconditionally and discards the result with
// `select` instead. That restriction is a genuine WGSL rule and not a style
// choice; an early return there fails to compile.
// ---------------------------------------------------------------------------

const FRAME_STRUCT = /* wgsl */ `
struct Frame {
  viewProj      : mat4x4<f32>,
  lightViewProj : mat4x4<f32>,
  // xyz: unit vector toward the sun, in render space. w: sin(elevation),
  // negative when the sun is down, which switches the scene to ambient only.
  sunDir        : vec4<f32>,
  // x: daylight cells accumulated, y: results are valid, z: shadow map size,
  // w: panel count.
  params        : vec4<f32>,
  // x, y: the access range the colour ramp is stretched across. A fixed 0-100%
  // ramp spends almost all of its resolution on values this analysis never
  // produces, and renders a real 25-point spread as one flat green. z, w unused.
  ramp          : vec4<f32>,
  // xyz: the site's local up, in render space. Geocentric coordinates have no
  // meaningful "up" of their own, so the sky term needs the local vertical
  // handed to it. w unused.
  localUp       : vec4<f32>,
};

struct Panel {
  center : vec4<f32>, // xyz position, w unused
  right  : vec4<f32>, // xyz unit east, w half width
  up     : vec4<f32>, // xyz unit up-slope, w half length
  normal : vec4<f32>, // xyz unit face normal, w unused
};

// The six vertices of a quad as two triangles, without a vertex buffer.
// Corner order is (-1,-1) (1,-1) (1,1) (-1,1).
fn cornerOf(vi : u32) -> vec2<f32> {
  var idx = vi;
  if (vi == 3u) { idx = 0u; }
  else if (vi == 4u) { idx = 2u; }
  else if (vi == 5u) { idx = 3u; }
  let x = select(-1.0, 1.0, idx == 1u || idx == 2u);
  let y = select(-1.0, 1.0, idx == 2u || idx == 3u);
  return vec2<f32>(x, y);
}
`;

// ---------------------------------------------------------------------------
// Shadow pass. Depth only: no fragment stage at all, which halves the work and
// is the reason the annual sweep costs milliseconds rather than seconds.
// ---------------------------------------------------------------------------

export const SHADOW_MESH_WGSL = /* wgsl */ `
${FRAME_STRUCT}
@group(0) @binding(0) var<uniform> frame : Frame;

@vertex
fn vs(
  @location(0) position : vec3<f32>,
  @location(1) normal   : vec3<f32>,
  @location(2) color    : vec3<f32>,
) -> @builtin(position) vec4<f32> {
  // normal and color are unused here but must be declared: the pipeline shares
  // one vertex buffer layout with the lit pass.
  _ = normal;
  _ = color;
  return frame.lightViewProj * vec4<f32>(position, 1.0);
}
`;

export const SHADOW_PANEL_WGSL = /* wgsl */ `
${FRAME_STRUCT}
@group(0) @binding(0) var<uniform> frame : Frame;
@group(1) @binding(0) var<storage, read> panels : array<Panel>;

@vertex
fn vs(
  @builtin(vertex_index) vi : u32,
  @builtin(instance_index) ii : u32,
) -> @builtin(position) vec4<f32> {
  let p = panels[ii];
  let c = cornerOf(vi);
  let world = p.center.xyz
            + p.right.xyz * (c.x * p.right.w)
            + p.up.xyz    * (c.y * p.up.w);
  return frame.lightViewProj * vec4<f32>(world, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Lit pass, shared shadow lookup.
// ---------------------------------------------------------------------------

const LIT_COMMON = /* wgsl */ `
${FRAME_STRUCT}
@group(0) @binding(0) var<uniform> frame : Frame;
@group(2) @binding(0) var shadowTex : texture_depth_2d;
@group(2) @binding(1) var shadowSamp : sampler_comparison;
@group(2) @binding(2) var<storage, read> results : array<f32>;

fn shadowFactor(world : vec3<f32>, ndl : f32) -> f32 {
  let lp = frame.lightViewProj * vec4<f32>(world, 1.0);
  let ndc = lp.xyz / lp.w;
  let inside = ndc.x >= -1.0 && ndc.x <= 1.0
            && ndc.y >= -1.0 && ndc.y <= 1.0
            && ndc.z <= 1.0;
  let uv = clamp(ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5), vec2<f32>(0.0), vec2<f32>(1.0));
  let bias = clamp(0.0004 * (1.0 - ndl), 0.00004, 0.0004);
  let texel = 1.0 / frame.params.z;

  var sum = 0.0;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let offset = vec2<f32>(f32(x), f32(y)) * texel;
      sum = sum + textureSampleCompare(shadowTex, shadowSamp, uv + offset, ndc.z - bias);
    }
  }
  return select(1.0, sum / 9.0, inside);
}

// The canvas format is a plain unorm target, not an _srgb one, so nothing
// converts on our behalf. Lighting has to happen in linear space and the result
// has to be encoded on the way out, or every mid-tone lands about a stop and a
// half too dark. Authored colours are written as display values, so they get
// decoded on the way in.
//
// LuciadRIA 2026.0 made the same move, and its release notes warn that colour
// and lighting output shifts slightly because of it.
fn toLinear(c : vec3<f32>) -> vec3<f32> {
  return pow(max(c, vec3<f32>(0.0)), vec3<f32>(2.2));
}
fn toDisplay(c : vec3<f32>) -> vec3<f32> {
  return pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2));
}

/** Returns a LINEAR radiance. Callers encode with toDisplay before writing. */
fn shade(baseColor : vec3<f32>, normal : vec3<f32>, world : vec3<f32>) -> vec3<f32> {
  let n = normalize(normal);
  let ndl = max(dot(n, frame.sunDir.xyz), 0.0);
  let daylight = select(0.0, 1.0, frame.sunDir.w > 0.0);
  let shadow = shadowFactor(world, ndl);

  // A cheap hemisphere term: a surface looking at the sky picks up more bounce
  // than one looking at the ground. Without it every vertical face reads as one
  // flat silhouette at low sun, which is most of a winter day at this latitude.
  let sky = clamp(0.5 + 0.5 * dot(n, frame.localUp.xyz), 0.0, 1.0);

  // Sky light survives when the sun is down; the ground bounce does not, so the
  // night floor is dim without being black.
  let dusk = clamp(frame.sunDir.w * 4.0 + 0.35, 0.18, 1.0);
  let ambient = (0.26 + 0.22 * sky) * dusk;
  let direct = 1.25 * ndl * shadow * daylight;

  return toLinear(baseColor) * (ambient + direct);
}
`;

export const LIT_MESH_WGSL = /* wgsl */ `
${LIT_COMMON}

struct VSOut {
  @builtin(position) clip   : vec4<f32>,
  @location(0)       normal : vec3<f32>,
  @location(1)       color  : vec3<f32>,
  @location(2)       world  : vec3<f32>,
};

@vertex
fn vs(
  @location(0) position : vec3<f32>,
  @location(1) normal   : vec3<f32>,
  @location(2) color    : vec3<f32>,
) -> VSOut {
  var out : VSOut;
  out.clip = frame.viewProj * vec4<f32>(position, 1.0);
  out.normal = normal;
  out.color = color;
  out.world = position;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(toDisplay(shade(in.color, in.normal, in.world)), 1.0);
}
`;

export const LIT_PANEL_WGSL = /* wgsl */ `
${LIT_COMMON}
@group(1) @binding(0) var<storage, read> panels : array<Panel>;

struct VSOut {
  @builtin(position)          clip  : vec4<f32>,
  @location(0)                uv    : vec2<f32>,
  @location(1)                world : vec3<f32>,
  @location(2) @interpolate(flat) inst : u32,
  @location(3)                normal : vec3<f32>,
};

// Green through amber to red. Deliberately not a rainbow: a diverging or
// spectral ramp invents categories that are not in the data, and this quantity
// is one-dimensional and ordered.
fn accessRamp(t : f32) -> vec3<f32> {
  let clear  = vec3<f32>(0.24, 0.70, 0.36);
  let middle = vec3<f32>(0.93, 0.71, 0.18);
  let loss   = vec3<f32>(0.83, 0.24, 0.20);
  // Stretch the ramp across the range the sweep actually produced.
  let lo = frame.ramp.x;
  let hi = max(frame.ramp.y, lo + 0.001);
  let k = clamp((t - lo) / (hi - lo), 0.0, 1.0);
  return select(
    mix(loss, middle, k / 0.5),
    mix(middle, clear, (k - 0.5) / 0.5),
    k >= 0.5,
  );
}

@vertex
fn vs(
  @builtin(vertex_index) vi : u32,
  @builtin(instance_index) ii : u32,
) -> VSOut {
  let p = panels[ii];
  let c = cornerOf(vi);
  let world = p.center.xyz
            + p.right.xyz * (c.x * p.right.w)
            + p.up.xyz    * (c.y * p.up.w);
  var out : VSOut;
  out.clip = frame.viewProj * vec4<f32>(world, 1.0);
  out.uv = c * 0.5 + vec2<f32>(0.5);
  out.world = world;
  out.inst = ii;
  out.normal = p.normal.xyz;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  // Which of the nine analysis samples covers this fragment. The tint is the
  // analysis grid, drawn at its true resolution rather than smoothed, so a
  // panel that is half shaded reads as half shaded.
  let cx = min(u32(in.uv.x * 3.0), 2u);
  let cy = min(u32(in.uv.y * 3.0), 2u);
  let idx = in.inst * 9u + cy * 3u + cx;

  let denom = max(frame.params.x, 1.0);
  let access = clamp(results[idx] / denom, 0.0, 1.0);

  let unanalysed = vec3<f32>(0.13, 0.16, 0.22);
  var base = select(unanalysed, accessRamp(access), frame.params.y > 0.5);

  // A darker gutter at the panel edge so 500 instances read as an array of
  // modules rather than one continuous sheet.
  let edge = min(min(in.uv.x, 1.0 - in.uv.x), min(in.uv.y, 1.0 - in.uv.y));
  base = base * select(0.55, 1.0, edge > 0.045);

  let lit = shade(base, in.normal, in.world);

  // Once the tint carries analysis output, let the data dominate the lighting.
  // Re-shading a measurement by the very sun it measures makes a module that
  // happens to be in shadow right now read as a low-access module, which is
  // precisely the confusion this view exists to prevent. A little shading is
  // kept so the array still sits in the scene rather than floating over it.
  let flat = toLinear(base) * 0.9;
  let shown = select(lit, mix(lit, flat, 0.72), frame.params.y > 0.5);

  return vec4<f32>(toDisplay(shown), 1.0);
}
`;

// ---------------------------------------------------------------------------
// The sweep. One invocation per panel, nine samples each, accumulated across
// every daylight cell of the year.
//
// This is the whole reason the demo exists. The same reduction on CPU worker
// threads, against a bounding volume hierarchy, took roughly 85 seconds for a
// design this size in the tool I worked on before. Here the occlusion test is a
// texture fetch against a depth map the GPU rendered anyway, so a cell costs
// microseconds and the annual answer arrives before the user lets go of the
// button.
// ---------------------------------------------------------------------------

export const SWEEP_WGSL = /* wgsl */ `
${FRAME_STRUCT}
@group(0) @binding(0) var<uniform> frame : Frame;
@group(1) @binding(0) var<storage, read> panels : array<Panel>;
@group(2) @binding(0) var shadowTex : texture_depth_2d;
@group(2) @binding(1) var<storage, read_write> accum : array<f32>;

// Lift the sample off the panel face so it cannot occlude itself. Same idea,
// and very nearly the same 5 cm, as the ray origin offset in the raycasting
// version of this analysis.
const NORMAL_OFFSET : f32 = 0.05;

// Residual depth epsilon. Most of the bias is carried by the normal offset
// above and by the pipeline's slope-scaled depth bias, so this only has to
// absorb the depth map's own quantisation.
const DEPTH_EPSILON : f32 = 0.00012;

fn sampleLit(world : vec3<f32>) -> f32 {
  let lp = frame.lightViewProj * vec4<f32>(world, 1.0);
  let ndc = lp.xyz / lp.w;
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0) {
    // Outside the sun frustum means nothing between here and the sun was
    // rendered, so the sample is lit. textureLoad has no uniformity
    // requirement, unlike the comparison sampler in the lit pass, so an early
    // return is legal here.
    return 1.0;
  }
  let uv = ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  let size = frame.params.z;
  let px = vec2<i32>(clamp(uv * size, vec2<f32>(0.0), vec2<f32>(size - 1.0)));
  let stored = textureLoad(shadowTex, px, 0);
  return select(0.0, 1.0, ndc.z - DEPTH_EPSILON <= stored);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= u32(frame.params.w)) { return; }

  let p = panels[i];
  // A panel facing away from the sun receives no direct beam at all, whatever
  // the geometry does. Testing occlusion first and this second would report a
  // north-facing module as fully lit at midday.
  let facing = dot(p.normal.xyz, frame.sunDir.xyz);

  for (var s = 0u; s < 9u; s = s + 1u) {
    let sx = (f32(s % 3u) - 1.0) * (2.0 / 3.0);
    let sy = (f32(s / 3u) - 1.0) * (2.0 / 3.0);
    let world = p.center.xyz
              + p.right.xyz * (sx * p.right.w)
              + p.up.xyz    * (sy * p.up.w)
              + p.normal.xyz * NORMAL_OFFSET;

    var lit = 0.0;
    if (facing > 0.0) {
      lit = sampleLit(world);
    }
    let slot = i * 9u + s;
    accum[slot] = accum[slot] + lit;
  }
}
`;
