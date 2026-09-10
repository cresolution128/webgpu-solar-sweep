// ---------------------------------------------------------------------------
// main — camera, controls, and the panel of instruments
//
// The camera orbits in the site's own east-north-up basis rather than in raw
// ECEF, because "up" at a site is a local idea and orbiting around a geocentric
// axis would roll the horizon.
//
// Note where the arithmetic happens: the eye position and the view matrix are
// built here, in JavaScript, in f64. Only the finished matrix is downcast. In
// absolute mode that downcast is exactly what destroys the scene, which is the
// point being demonstrated.
// ---------------------------------------------------------------------------

import { createRenderer } from './gpu/renderer.js';
import { buildSite, SITE_LAT, SITE_LON } from './scene/site.js';
import { daylightCells, monthName, sunAngles, sunDirectionEnu } from './geo/sun.js';
import { f32SpacingAt } from './geo/frame.js';
import * as m4 from './math/mat4.js';

// Bumped by hand whenever the shading changes. It is displayed in the sidebar
// purely so a stale module cache is visible instead of looking like a shader
// edit that silently did nothing.
const BUILD = 'orbit-v-7';

const canvas = document.getElementById('view');
const el = id => document.getElementById(id);

const state = {
  month: 11, // December, where the shading is worst
  hour: 10,
  azimuth: 2.6, // radians, from north, in the local frame
  elevation: 0.42,
  distance: 108,
  dragging: false,
  lastX: 0,
  lastY: 0,
};

const selftest = new URLSearchParams(location.search).has('selftest');

/** In self-test runs, report back to the dev server so a runner can assert on it. */
const report = payload => {
  if (!selftest) return;
  navigator.sendBeacon?.('/result', JSON.stringify(payload));
};

const fail = message => {
  el('overlay').hidden = false;
  el('overlay-text').textContent = message;
  report({ ok: false, error: message });
};

// A runtime error after start-up used to be completely silent: the loop would
// stop rescheduling itself and the last frame would sit there looking like a
// dark scene that ignores the mouse. Surface it.
const errors = [];
const noteError = message => {
  errors.push(message);
  if (errors.length === 1) fail(message);
};
window.addEventListener('error', e => noteError('Error: ' + e.message));
window.addEventListener('unhandledrejection', e =>
  noteError('Unhandled rejection: ' + (e.reason?.message ?? String(e.reason))),
);

const main = async () => {
  const scene = buildSite();
  let renderer;
  try {
    renderer = await createRenderer(canvas, scene);
  } catch (err) {
    fail(err.message);
    return;
  }

  const site = scene.site;

  // --- static readouts ----------------------------------------------------
  el('stat-panels').textContent = scene.panels.count.toLocaleString();
  el('stat-array').textContent = `${scene.panels.cols} x ${scene.panels.rows}`;
  el('stat-origin').textContent = scene.renderOrigin
    .map(v => (v / 1000).toFixed(1))
    .join(', ') + ' km';
  el('stat-spacing').textContent = `${(f32SpacingAt(scene.renderOrigin[0]) * 100).toFixed(0)} cm`;

  el('stat-build').textContent = BUILD;

  const info = renderer.adapterInfo;
  el('stat-adapter').textContent =
    info && (info.description || info.vendor)
      ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ')
      : 'reported as anonymous';

  // --- camera -------------------------------------------------------------
  const buildViewProj = () => {
    const centre = renderer.sceneCentreRender;
    const { east, north, up } = site.basis;
    const cosEl = Math.cos(state.elevation);
    const dir = [
      east[0] * cosEl * Math.sin(state.azimuth) + north[0] * cosEl * Math.cos(state.azimuth) + up[0] * Math.sin(state.elevation),
      east[1] * cosEl * Math.sin(state.azimuth) + north[1] * cosEl * Math.cos(state.azimuth) + up[1] * Math.sin(state.elevation),
      east[2] * cosEl * Math.sin(state.azimuth) + north[2] * cosEl * Math.cos(state.azimuth) + up[2] * Math.sin(state.elevation),
    ];
    const eye = [
      centre[0] + dir[0] * state.distance,
      centre[1] + dir[1] * state.distance,
      centre[2] + dir[2] * state.distance,
    ];
    const view = m4.lookAt(eye, centre, up);
    const aspect = canvas.width / Math.max(1, canvas.height);
    const proj = m4.perspective((48 * Math.PI) / 180, aspect, 1.5, 1600);
    return m4.multiply(proj, view);
  };

  // --- sun ----------------------------------------------------------------
  const currentSun = () => {
    const angles = sunAngles(SITE_LAT, SITE_LON, state.month, state.hour);
    const enu = sunDirectionEnu(SITE_LAT, SITE_LON, state.month, state.hour);
    // Below the horizon: keep a direction so the matrices stay finite, but flag
    // it so the shader falls back to ambient.
    const safeEnu = enu ?? [0, 0.6, 0.8];
    return {
      dirEcef: site.localDirToEcef(safeEnu[0], safeEnu[1], safeEnu[2]),
      up: enu ? Math.sin(angles.elevation) : -1,
      angles,
    };
  };

  const updateSunReadout = () => {
    const { angles } = currentSun();
    const hh = String(state.hour).padStart(2, '0');
    el('sun-label').textContent = `${monthName(state.month)} 15, ${hh}:00`;
    el('sun-angles').textContent =
      angles.elevationDeg > 0
        ? `${angles.elevationDeg.toFixed(1)}° above horizon, azimuth ${angles.azimuthDeg.toFixed(0)}°`
        : 'below the horizon';
  };

  // --- resize -------------------------------------------------------------
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w;
      canvas.height = h;
    }
  };
  window.addEventListener('resize', resize);
  resize();

  // --- input --------------------------------------------------------------
  canvas.addEventListener('pointerdown', e => {
    state.dragging = true;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    // Throws if the pointer id is not active, which a synthetic event and some
    // pen/touch sequences can both produce. Losing the capture is survivable;
    // losing the drag because the handler threw is not.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  });
  const endDrag = e => {
    state.dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointermove', e => {
    if (!state.dragging) return;
    // Grab-and-spin horizontally: drag right and the building turns right.
    // Vertically the camera follows the cursor instead, so dragging down raises
    // the eye and tips the roof toward you. That pairing is what map and globe
    // viewers do, and it is the one that felt right in testing.
    state.azimuth += (e.clientX - state.lastX) * 0.006;
    state.elevation = Math.min(
      1.45,
      Math.max(0.06, state.elevation + (e.clientY - state.lastY) * 0.005),
    );
    state.lastX = e.clientX;
    state.lastY = e.clientY;
  });
  canvas.addEventListener(
    'wheel',
    e => {
      e.preventDefault();
      state.distance = Math.min(420, Math.max(28, state.distance * (1 + Math.sign(e.deltaY) * 0.1)));
    },
    { passive: false },
  );

  // --- controls -----------------------------------------------------------
  const monthInput = el('month');
  const hourInput = el('hour');
  monthInput.value = String(state.month);
  hourInput.value = String(state.hour);
  monthInput.addEventListener('input', () => {
    state.month = Number(monthInput.value);
    updateSunReadout();
  });
  hourInput.addEventListener('input', () => {
    state.hour = Number(hourInput.value);
    updateSunReadout();
  });

  for (const radio of document.querySelectorAll('input[name="precision"]')) {
    radio.addEventListener('change', () => {
      renderer.setPrecisionMode(radio.value);
      el('precision-note').textContent =
        radio.value === 'absolute'
          ? 'Vertices uploaded as raw ECEF. Every coordinate is quantised onto a grid coarser than half a panel.'
          : 'Vertices uploaded relative to the render origin. Offsets are tens of metres, where float32 resolves micrometres.';
    });
  }

  // --- the sweep ----------------------------------------------------------
  // The legend has to state the range the ramp is actually stretched across,
  // or the colours claim a precision the scale does not have.
  const updateLegend = result => {
    el('legend-lo').textContent = `${(result.rampLo * 100).toFixed(0)}%`;
    el('legend-hi').textContent = `${(result.rampHi * 100).toFixed(0)}%`;
  };

  const sweepButton = el('run-sweep');

  const publish = result => {
    el('results').hidden = false;
    el('res-time').textContent = `${result.gpuMs.toFixed(1)} ms`;
    el('res-cells').textContent = result.cells.toString();
    el('res-samples').textContent = result.rays.toLocaleString();
    el('res-mean').textContent = `${(result.meanAccess * 100).toFixed(1)}%`;
    el('res-range').textContent =
      `${(result.worstAccess * 100).toFixed(0)}% – ${(result.bestAccess * 100).toFixed(0)}%`;
    updateLegend(result);
  };

  // One path for the button, the start-up run and the self-test, so the three
  // cannot drift apart.
  const runSweep = async () => {
    sweepButton.disabled = true;
    sweepButton.textContent = 'Running…';
    el('results').hidden = true;

    // Yield a frame so the button state paints before the GPU work is queued.
    await new Promise(requestAnimationFrame);

    const result = await renderer.runSweep(daylightCells(SITE_LAT, SITE_LON));
    publish(result);

    sweepButton.disabled = false;
    sweepButton.textContent = 'Run annual sweep again';
    return result;
  };

  sweepButton.addEventListener('click', runSweep);

  el('reset-results').addEventListener('click', () => {
    renderer.clearResults();
    el('results').hidden = true;
    el('legend-lo').textContent = '0%';
    el('legend-hi').textContent = '100%';
  });

  // A headless smoke test: ?selftest=1 runs the sweep immediately and reports
  // through the document title, so the whole pipeline can be verified from a
  // command line without a human looking at the canvas.
  if (selftest) {
    const result = await runSweep();
    // A handful of numbers that would move if any stage of the pipeline broke.
    const sample = Array.from(result.perPanel.slice(0, 4), v => Number(v.toFixed(4)));
    report({
      ok: true,
      adapter: renderer.adapterInfo
        ? [renderer.adapterInfo.vendor, renderer.adapterInfo.architecture].filter(Boolean).join(' ')
        : 'anonymous',
      panels: scene.panels.count,
      cells: result.cells,
      sampleTests: result.rays,
      meanAccess: Number(result.meanAccess.toFixed(4)),
      worstAccess: Number(result.worstAccess.toFixed(4)),
      bestAccess: Number(result.bestAccess.toFixed(4)),
      gpuMs: Number(result.gpuMs.toFixed(1)),
      firstPanels: sample,
    });
    document.title = `OK panels=${scene.panels.count} cells=${result.cells} ` +
      `mean=${(result.meanAccess * 100).toFixed(1)}% worst=${(result.worstAccess * 100).toFixed(1)}% ` +
      `best=${(result.bestAccess * 100).toFixed(1)}% gpuMs=${result.gpuMs.toFixed(1)}`;

    // Draw one tinted frame and post it back, so the runner can look at the
    // picture instead of trusting the numbers alone. ?precision=absolute
    // captures the broken path instead, which is how the two screenshots in the
    // README were produced.
    const q = new URLSearchParams(location.search);
    if (q.get('precision') === 'absolute') renderer.setPrecisionMode('absolute');
    if (q.has('month')) state.month = Number(q.get('month'));
    if (q.has('hour')) state.hour = Number(q.get('hour'));
    if (q.has('dist')) state.distance = Number(q.get('dist'));
    const sun = currentSun();
    renderer.renderFrame({ viewProj: buildViewProj(), sunDirEcef: sun.dirEcef, sunUp: sun.up });
    fetch('/shot', { method: 'POST', body: canvas.toDataURL('image/png') }).catch(() => {});
  }

  // --- loop ---------------------------------------------------------------
  updateSunReadout();
  let frames = 0;
  let totalFrames = 0;
  let lastFpsAt = performance.now();
  const loop = () => {
    try {
      resize();
      const sun = currentSun();
      renderer.renderFrame({
        viewProj: buildViewProj(),
        sunDirEcef: sun.dirEcef,
        sunUp: sun.up,
      });
    } catch (err) {
      noteError('Render loop: ' + (err.message ?? String(err)));
      return; // stop rescheduling rather than spamming an identical failure
    }
    frames++;
    totalFrames++;
    const now = performance.now();
    if (now - lastFpsAt > 500) {
      el('stat-fps').textContent = `${Math.round((frames * 1000) / (now - lastFpsAt))} fps`;
      frames = 0;
      lastFpsAt = now;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // Compute the year immediately. A tool that opens as an empty grey array and
  // waits to be told to do the one thing it exists for shows nothing about
  // itself; the button stays, relabelled, for re-running after a change.
  if (!selftest && !new URLSearchParams(location.search).has('probe')) {
    runSweep().catch(err => noteError('Start-up sweep: ' + (err.message ?? String(err))));
  }

  // Exposed for the CDP harness in tools/inspect.js, so a live window can be
  // interrogated without adding UI for it.
  window.__diag = () => ({
    build: BUILD,
    totalFrames,
    visibility: document.visibilityState,
    canvas: `${canvas.width}x${canvas.height} client ${canvas.clientWidth}x${canvas.clientHeight}`,
    dpr: window.devicePixelRatio,
    azimuth: state.azimuth,
    elevation: state.elevation,
    distance: state.distance,
    month: state.month,
    hour: state.hour,
    errors,
  });
  window.__clear = (r, g, b) => renderer.setDebugClear(r === null ? null : { r, g, b, a: 1 });
  window.__format = () => renderer.canvasFormat;
  window.__orbit = (dx, dy) => {
    const opts = { bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: 400, clientY: 400 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
    canvas.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: 400 + dx, clientY: 400 + dy }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: 400 + dx, clientY: 400 + dy }));
    return state.azimuth;
  };

  // ?probe=1 drives the camera with synthetic pointer events and reports what
  // happened, so "the orbit does not work" can be answered without guessing.
  // It waits for the page to actually be visible first: a browser throttles
  // requestAnimationFrame to nothing in a hidden or occluded window, so
  // measuring frames before then says nothing about the app.
  if (new URLSearchParams(location.search).has('probe')) {
    const waitForVisible = async () => {
      for (let i = 0; i < 100; i++) {
        if (document.visibilityState === 'visible') return true;
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    };
    (async () => {
      const becameVisible = await waitForVisible();
      const framesAtStart = totalFrames;
      await new Promise(r => setTimeout(r, 1000));
      const framesWhileIdle = totalFrames - framesAtStart;

      const before = { az: state.azimuth, el: state.elevation, dist: state.distance };
      const opts = { bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: 400, clientY: 400 };
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
      canvas.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: 520, clientY: 440 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: 520, clientY: 440 }));
      canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }));
      await new Promise(r => setTimeout(r, 500));

      navigator.sendBeacon('/result', JSON.stringify({
        ok: errors.length === 0,
        build: BUILD,
        becameVisible,
        visibility: document.visibilityState,
        framesInOneSecond: framesWhileIdle,
        framesTotal: totalFrames,
        azimuthMoved: Math.abs(state.azimuth - before.az) > 1e-6,
        elevationMoved: Math.abs(state.elevation - before.el) > 1e-6,
        distanceMoved: Math.abs(state.distance - before.dist) > 1e-6,
        canvas: `${canvas.width}x${canvas.height}`,
        errors,
      }));
    })();
  }
};

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err);
  fail(err.message ?? String(err));
});
