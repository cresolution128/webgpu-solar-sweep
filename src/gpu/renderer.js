// ---------------------------------------------------------------------------
// renderer — device, pipelines, the interactive frame, and the annual sweep
//
// Four pipelines share three bind group layouts. The frame uniform is a single
// buffer read with a DYNAMIC OFFSET, which is what makes the annual sweep one
// submission: 145 daylight cells each need their own sun matrix, and without
// dynamic offsets that is either 145 buffers or 145 submissions with a stall
// between each. Here it is one buffer written once, one encoder, one submit.
//
// The sweep is two passes per cell:
//   1. render the scene's depth from the sun's point of view (no fragment
//      stage, so it is pure rasterisation),
//   2. a compute pass that projects every panel's nine sample points into that
//      depth map and accumulates whether each one reached the sun.
//
// The occlusion test is therefore a texture fetch, not a ray cast. That is the
// whole trick, and it is only available because the sun is a directional light:
// one depth render answers the visibility question for every sample at once.
// ---------------------------------------------------------------------------

import {
  LIT_MESH_WGSL,
  LIT_PANEL_WGSL,
  SHADOW_MESH_WGSL,
  SHADOW_PANEL_WGSL,
  SWEEP_WGSL,
} from './shaders.js';
import { buildPositions } from '../geo/frame.js';
import { packPanels } from '../scene/site.js';
import * as m4 from '../math/mat4.js';

const SHADOW_SIZE = 2048;
const SHADOW_FORMAT = 'depth32float';
const DEPTH_FORMAT = 'depth24plus';

// Orthographic half-extent of the sun's view, metres. Big enough to hold the
// tower and the tree line, tight enough that a 2048 map is about 12 cm/texel.
const SUN_HALF_EXTENT = 120;
const SUN_DISTANCE = 260;
const SUN_NEAR = 40;
const SUN_FAR = 480;

const FRAME_BYTES = 192; // 2 x mat4 + 4 x vec4

export const createRenderer = async (canvas, scene) => {
  if (!navigator.gpu) {
    throw new Error(
      'WebGPU is not available in this browser. Chrome or Edge 113+, and the page must be served over http://localhost or https.',
    );
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter. The GPU may be blocked or blocklisted.');

  const device = await adapter.requestDevice();
  device.lost.then(info => {
    // eslint-disable-next-line no-console
    console.error('WebGPU device lost:', info.reason, info.message);
  });

  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const uniformAlign = device.limits.minUniformBufferOffsetAlignment;

  // --- bind group layouts -------------------------------------------------
  const frameBGL = device.createBindGroupLayout({
    label: 'frame',
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: FRAME_BYTES },
    }],
  });

  const panelBGL = device.createBindGroupLayout({
    label: 'panels',
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE,
      buffer: { type: 'read-only-storage' },
    }],
  });

  const litBGL = device.createBindGroupLayout({
    label: 'lit-resources',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ],
  });

  const sweepBGL = device.createBindGroupLayout({
    label: 'sweep-resources',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });

  // --- resources ----------------------------------------------------------
  const vertexStride = 9 * 4;
  const vertexBuffer = device.createBuffer({
    label: 'scene-vertices',
    size: scene.mesh.vertexCount * vertexStride,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });

  const panelBuffer = device.createBuffer({
    label: 'panel-instances',
    size: scene.panels.count * 16 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const resultSlots = scene.panels.count * 9;
  const resultBuffer = device.createBuffer({
    label: 'sample-accumulator',
    size: resultSlots * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const readbackBuffer = device.createBuffer({
    label: 'sample-readback',
    size: resultSlots * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  // Slot 0 is the interactive frame; slots 1..n are the sweep's daylight cells.
  const MAX_CELLS = 320;
  const frameBuffer = device.createBuffer({
    label: 'frame-uniforms',
    size: uniformAlign * (MAX_CELLS + 1),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const shadowTexture = device.createTexture({
    label: 'sun-depth',
    size: [SHADOW_SIZE, SHADOW_SIZE],
    format: SHADOW_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const shadowView = shadowTexture.createView();

  const shadowSampler = device.createSampler({ compare: 'less' });

  let depthTexture = null;
  let depthView = null;
  const ensureDepth = () => {
    if (depthTexture && depthTexture.width === canvas.width && depthTexture.height === canvas.height) return;
    if (depthTexture) depthTexture.destroy();
    depthTexture = device.createTexture({
      label: 'scene-depth',
      size: [Math.max(1, canvas.width), Math.max(1, canvas.height)],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    depthView = depthTexture.createView();
  };

  // --- bind groups --------------------------------------------------------
  const frameBG = device.createBindGroup({
    layout: frameBGL,
    entries: [{ binding: 0, resource: { buffer: frameBuffer, size: FRAME_BYTES } }],
  });
  const panelBG = device.createBindGroup({
    layout: panelBGL,
    entries: [{ binding: 0, resource: { buffer: panelBuffer } }],
  });
  const litBG = device.createBindGroup({
    layout: litBGL,
    entries: [
      { binding: 0, resource: shadowView },
      { binding: 1, resource: shadowSampler },
      { binding: 2, resource: { buffer: resultBuffer } },
    ],
  });
  const sweepBG = device.createBindGroup({
    layout: sweepBGL,
    entries: [
      { binding: 0, resource: shadowView },
      { binding: 1, resource: { buffer: resultBuffer } },
    ],
  });

  // --- pipelines ----------------------------------------------------------
  const vertexLayout = {
    arrayStride: vertexStride,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x3' },
    ],
  };

  // Slope-scaled bias on the shadow pipelines. Cheaper and steadier than
  // pushing the whole correction into the comparison epsilon, which would have
  // to be sized for the worst grazing angle and would then wash out the 17 cm
  // height difference that produces inter-row shading.
  const shadowDepthState = {
    format: SHADOW_FORMAT,
    depthWriteEnabled: true,
    depthCompare: 'less',
    depthBias: 2,
    depthBiasSlopeScale: 2.0,
  };

  const shadowMeshPipeline = device.createRenderPipeline({
    label: 'shadow-mesh',
    layout: device.createPipelineLayout({ bindGroupLayouts: [frameBGL, panelBGL] }),
    vertex: {
      module: device.createShaderModule({ code: SHADOW_MESH_WGSL }),
      entryPoint: 'vs',
      buffers: [vertexLayout],
    },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: shadowDepthState,
  });

  const shadowPanelPipeline = device.createRenderPipeline({
    label: 'shadow-panels',
    layout: device.createPipelineLayout({ bindGroupLayouts: [frameBGL, panelBGL] }),
    vertex: {
      module: device.createShaderModule({ code: SHADOW_PANEL_WGSL }),
      entryPoint: 'vs',
    },
    // Panels are single quads with no thickness, so neither face may be culled
    // or half the array would stop casting a shadow.
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: shadowDepthState,
  });

  const litDepthState = { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' };
  const litLayout = device.createPipelineLayout({ bindGroupLayouts: [frameBGL, panelBGL, litBGL] });

  const litMeshModule = device.createShaderModule({ code: LIT_MESH_WGSL });
  const litMeshPipeline = device.createRenderPipeline({
    label: 'lit-mesh',
    layout: litLayout,
    vertex: { module: litMeshModule, entryPoint: 'vs', buffers: [vertexLayout] },
    fragment: { module: litMeshModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: litDepthState,
  });

  const litPanelModule = device.createShaderModule({ code: LIT_PANEL_WGSL });
  const litPanelPipeline = device.createRenderPipeline({
    label: 'lit-panels',
    layout: litLayout,
    vertex: { module: litPanelModule, entryPoint: 'vs' },
    fragment: { module: litPanelModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: litDepthState,
  });

  const sweepPipeline = device.createComputePipeline({
    label: 'annual-sweep',
    layout: device.createPipelineLayout({ bindGroupLayouts: [frameBGL, panelBGL, sweepBGL] }),
    compute: { module: device.createShaderModule({ code: SWEEP_WGSL }), entryPoint: 'main' },
  });

  // --- CPU-side state -----------------------------------------------------
  let precisionMode = 'relative';
  let spaceOrigin = scene.renderOrigin;
  let daylightAccumulated = 0;
  let hasResults = 0;
  // The access range the colour ramp is stretched across, set from the sweep's
  // own output so the ramp spends its resolution where the data actually is.
  let rampLo = 0;
  let rampHi = 1;

  const uploadGeometry = () => {
    spaceOrigin = precisionMode === 'absolute' ? [0, 0, 0] : scene.renderOrigin;

    const positions = buildPositions(scene.mesh.positionsEcef, scene.renderOrigin, precisionMode);
    const interleaved = new Float32Array(scene.mesh.vertexCount * 9);
    for (let i = 0; i < scene.mesh.vertexCount; i++) {
      interleaved[i * 9 + 0] = positions[i * 3 + 0];
      interleaved[i * 9 + 1] = positions[i * 3 + 1];
      interleaved[i * 9 + 2] = positions[i * 3 + 2];
      interleaved[i * 9 + 3] = scene.mesh.normalsEcef[i * 3 + 0];
      interleaved[i * 9 + 4] = scene.mesh.normalsEcef[i * 3 + 1];
      interleaved[i * 9 + 5] = scene.mesh.normalsEcef[i * 3 + 2];
      interleaved[i * 9 + 6] = scene.mesh.colors[i * 3 + 0];
      interleaved[i * 9 + 7] = scene.mesh.colors[i * 3 + 1];
      interleaved[i * 9 + 8] = scene.mesh.colors[i * 3 + 2];
    }
    device.queue.writeBuffer(vertexBuffer, 0, interleaved);
    device.queue.writeBuffer(panelBuffer, 0, packPanels(scene.panels, scene.renderOrigin, precisionMode));
  };

  uploadGeometry();

  /** Scene centre in whatever space the GPU is currently working in. */
  const sceneCentre = () =>
    precisionMode === 'absolute'
      ? [scene.renderOrigin[0], scene.renderOrigin[1], scene.renderOrigin[2]]
      : [0, 0, 0];

  /** The sun's view-projection for a given ECEF sun direction. */
  const sunViewProj = sunDirEcef => {
    const c = sceneCentre();
    const eye = [
      c[0] + sunDirEcef[0] * SUN_DISTANCE,
      c[1] + sunDirEcef[1] * SUN_DISTANCE,
      c[2] + sunDirEcef[2] * SUN_DISTANCE,
    ];
    // Any up vector not parallel to the view direction. The site's own up works
    // except when the sun is almost overhead, which at this latitude it never
    // is, but the fallback costs nothing.
    const siteUp = scene.site.basis.up;
    const up = Math.abs(m4.vec.dot3(siteUp, sunDirEcef)) > 0.995 ? scene.site.basis.north : siteUp;
    const view = m4.lookAt(eye, c, up);
    const proj = m4.orthographic(
      -SUN_HALF_EXTENT, SUN_HALF_EXTENT,
      -SUN_HALF_EXTENT, SUN_HALF_EXTENT,
      SUN_NEAR, SUN_FAR,
    );
    return m4.multiply(proj, view);
  };

  /** Write one 160-byte frame block into `target` at `offset`. */
  const writeFrameBlock = (target, offset, viewProj, lightViewProj, sunDirEcef, sunUp, panelCountOverride) => {
    const f32 = new Float32Array(target, offset, FRAME_BYTES / 4);
    f32.set(m4.toF32(viewProj), 0);
    f32.set(m4.toF32(lightViewProj), 16);
    f32[32] = sunDirEcef[0];
    f32[33] = sunDirEcef[1];
    f32[34] = sunDirEcef[2];
    f32[35] = sunUp;
    f32[36] = daylightAccumulated;
    f32[37] = hasResults;
    f32[38] = SHADOW_SIZE;
    f32[39] = panelCountOverride ?? scene.panels.count;
    f32[40] = rampLo;
    f32[41] = rampHi;
    const up = scene.site.basis.up;
    f32[44] = up[0];
    f32[45] = up[1];
    f32[46] = up[2];
  };

  const drawSceneInto = (pass, meshPipeline, panelPipeline, dynamicOffset) => {
    pass.setBindGroup(0, frameBG, [dynamicOffset]);
    pass.setBindGroup(1, panelBG);
    pass.setPipeline(meshPipeline);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.draw(scene.mesh.vertexCount, 1);
    pass.setPipeline(panelPipeline);
    pass.draw(6, scene.panels.count);
  };

  // --- public surface -----------------------------------------------------

  // Sky colour as a function of sun elevation. Not a physical model: three
  // sampled keys through night, dawn and full day, so the background sits at a
  // sensible brightness behind the scene instead of reading as a black void at
  // every hour before ten in December.
  const skyColour = sunUp => {
    const night = [0.035, 0.045, 0.065];
    const dawn = [0.30, 0.29, 0.31];
    const day = [0.47, 0.58, 0.70];
    const t = Math.max(0, Math.min(1, sunUp * 3.2 + 0.28));
    const from = t < 0.5 ? night : dawn;
    const to = t < 0.5 ? dawn : day;
    const k = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    return {
      r: from[0] + (to[0] - from[0]) * k,
      g: from[1] + (to[1] - from[1]) * k,
      b: from[2] + (to[2] - from[2]) * k,
      a: 1,
    };
  };

  // Test hook: force the clear colour to a known value so the on-screen result
  // can be compared against what was asked for.
  let debugClear = null;

  /** Draw one interactive frame. `viewProj` is an f64 matrix in render space. */
  const renderFrame = ({ viewProj, sunDirEcef, sunUp }) => {
    ensureDepth();

    const block = new ArrayBuffer(FRAME_BYTES);
    const lightViewProj = sunViewProj(sunDirEcef);
    writeFrameBlock(block, 0, viewProj, lightViewProj, sunDirEcef, sunUp);
    device.queue.writeBuffer(frameBuffer, 0, block);

    const encoder = device.createCommandEncoder({ label: 'frame' });

    // The live shadow map, so the picture agrees with the analysis instead of
    // being lit by a separate, softer fiction.
    const shadowPass = encoder.beginRenderPass({
      label: 'live-shadow',
      colorAttachments: [],
      depthStencilAttachment: {
        view: shadowView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    drawSceneInto(shadowPass, shadowMeshPipeline, shadowPanelPipeline, 0);
    shadowPass.end();

    const pass = encoder.beginRenderPass({
      label: 'lit',
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: debugClear ?? skyColour(sunUp),
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setBindGroup(2, litBG);
    drawSceneInto(pass, litMeshPipeline, litPanelPipeline, 0);
    pass.end();

    device.queue.submit([encoder.finish()]);
  };

  /**
   * Run the whole year. One encoder, one submit, one readback.
   * `cells` come from geo/sun.daylightCells; each carries a local ENU sun
   * direction which is rotated into ECEF here.
   */
  const runSweep = async cells => {
    const usable = cells.slice(0, MAX_CELLS);
    const start = performance.now();

    // Zero the accumulator. 512 panels x 9 samples is 18 KB, so a buffer write
    // is cheaper than dispatching a clear kernel.
    device.queue.writeBuffer(resultBuffer, 0, new Float32Array(resultSlots));

    // Every cell's uniform block, written in one go.
    const staging = new ArrayBuffer(uniformAlign * (usable.length + 1));
    const identity = m4.create();
    const dirs = [];
    for (let i = 0; i < usable.length; i++) {
      const cell = usable[i];
      const dir = scene.site.localDirToEcef(cell.dirEnu[0], cell.dirEnu[1], cell.dirEnu[2]);
      dirs.push(dir);
      writeFrameBlock(
        staging,
        uniformAlign * (i + 1),
        identity, // the sweep never rasterises to the screen
        sunViewProj(dir),
        dir,
        1,
      );
    }
    device.queue.writeBuffer(frameBuffer, uniformAlign, staging, uniformAlign, staging.byteLength - uniformAlign);

    const encoder = device.createCommandEncoder({ label: 'annual-sweep' });
    const workgroups = Math.ceil(scene.panels.count / 64);

    for (let i = 0; i < usable.length; i++) {
      const offset = uniformAlign * (i + 1);

      const shadowPass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: shadowView,
          depthClearValue: 1.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      drawSceneInto(shadowPass, shadowMeshPipeline, shadowPanelPipeline, offset);
      shadowPass.end();

      const computePass = encoder.beginComputePass();
      computePass.setPipeline(sweepPipeline);
      computePass.setBindGroup(0, frameBG, [offset]);
      computePass.setBindGroup(1, panelBG);
      computePass.setBindGroup(2, sweepBG);
      computePass.dispatchWorkgroups(workgroups);
      computePass.end();
    }

    encoder.copyBufferToBuffer(resultBuffer, 0, readbackBuffer, 0, resultSlots * 4);
    device.queue.submit([encoder.finish()]);

    await device.queue.onSubmittedWorkDone();
    const gpuMs = performance.now() - start;

    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const view = new Float32Array(readbackBuffer.getMappedRange().slice(0));
    readbackBuffer.unmap();

    daylightAccumulated = usable.length;
    hasResults = 1;

    // Per-panel mean access, and the design-wide figure.
    const perPanel = new Float32Array(scene.panels.count);
    let total = 0;
    for (let p = 0; p < scene.panels.count; p++) {
      let sum = 0;
      for (let s = 0; s < 9; s++) sum += view[p * 9 + s];
      const access = sum / (9 * usable.length);
      perPanel[p] = access;
      total += access;
    }

    let worst = 1;
    let best = 0;
    for (let p = 0; p < scene.panels.count; p++) {
      if (perPanel[p] < worst) worst = perPanel[p];
      if (perPanel[p] > best) best = perPanel[p];
    }

    // Stretch the ramp over the observed spread, with a floor so a genuinely
    // uniform array does not get its rounding noise amplified into a rainbow.
    const MIN_SPREAD = 0.08;
    const mid = (worst + best) / 2;
    const half = Math.max((best - worst) / 2, MIN_SPREAD / 2);
    rampLo = Math.max(0, mid - half);
    rampHi = Math.min(1, mid + half);

    return {
      gpuMs,
      rampLo,
      rampHi,
      cells: usable.length,
      rays: usable.length * scene.panels.count * 9,
      meanAccess: total / scene.panels.count,
      worstAccess: worst,
      bestAccess: best,
      perPanel,
    };
  };

  const setPrecisionMode = mode => {
    if (mode === precisionMode) return;
    precisionMode = mode;
    uploadGeometry();
  };

  const clearResults = () => {
    daylightAccumulated = 0;
    hasResults = 0;
    rampLo = 0;
    rampHi = 1;
  };

  return {
    device,
    adapterInfo: adapter.info ?? null,
    renderFrame,
    runSweep,
    setPrecisionMode,
    clearResults,
    get precisionMode() { return precisionMode; },
    // Where the scene centre sits in whatever space the GPU is working in.
    // Zero when the render origin has been subtracted, six million metres out
    // when it has not, which is exactly the difference the demo is about.
    get sceneCentreRender() {
      return [
        scene.renderOrigin[0] - spaceOrigin[0],
        scene.renderOrigin[1] - spaceOrigin[1],
        scene.renderOrigin[2] - spaceOrigin[2],
      ];
    },
    setDebugClear: c => { debugClear = c; },
    canvasFormat: format,
    shadowSize: SHADOW_SIZE,
    panelCount: scene.panels.count,
  };
};
