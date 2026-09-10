// Attach to a running Chrome over the DevTools protocol, collect console output
// (which is where WebGPU validation errors land — they never reach JS), read the
// page's own diagnostics, and capture what is actually on screen.
//
//   node tools/inspect.js [outputPng]
//
// Requires Chrome started with --remote-debugging-port=9222.
const fs = require('fs');

const PORT = 9222;
const OUT = process.argv[2] || 'inspect.png';

const rpc = (ws, state) => (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++state.id;
    state.pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (state.pending.delete(id)) reject(new Error('timeout: ' + method));
    }, 15000);
  });

(async () => {
  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && t.url.includes('localhost:8099'));
  if (!page) {
    console.log('no page on localhost:8099. targets:', list.map(t => t.url));
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const state = { id: 0, pending: new Map() };
  const logs = [];

  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && state.pending.has(msg.id)) {
      const { resolve, reject } = state.pending.get(msg.id);
      state.pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Log.entryAdded') {
      logs.push(`[${msg.params.entry.level}] ${msg.params.entry.text}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(`[console.${msg.params.type}] ` + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
      logs.push(`[http ${msg.params.response.status}] ${msg.params.response.url}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + msg.params.exceptionDetails.text + ' ' +
        (msg.params.exceptionDetails.exception?.description ?? ''));
    }
  });

  await new Promise(r => ws.addEventListener('open', r));
  const send = rpc(ws, state);

  await send('Log.enable');
  await send('Runtime.enable');
  await send('Page.enable');

  // Reload with cache disabled so we are certainly looking at current source.
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  // An occluded window gets no animation frames at all, which is correct browser
  // behaviour and makes it impossible to tell a throttled page from a broken
  // one. Focus emulation plus a screencast keep the compositor producing frames
  // for a window that is not on top.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 3000));
  await send('Page.startScreencast', { format: 'png', maxWidth: 1400, maxHeight: 900, everyNthFrame: 1 });
  await new Promise(r => setTimeout(r, 4000));

  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  };

  // --sweep clicks the analysis button and waits, so the tinted state can be
  // captured rather than described.
  if (process.argv.includes('--sweep')) {
    await evaluate('document.getElementById("run-sweep").click()');
    await new Promise(r => setTimeout(r, 5000));
    console.log('--- RESULTS PANEL ---');
    console.log(await evaluate(`JSON.stringify({
      hidden: document.getElementById('results').hidden,
      time: document.getElementById('res-time').textContent,
      mean: document.getElementById('res-mean').textContent,
      range: document.getElementById('res-range').textContent,
      legend: document.getElementById('legend-lo').textContent + ' .. ' + document.getElementById('legend-hi').textContent,
    })`));
  }

  const before = await evaluate('window.__diag ? JSON.stringify(window.__diag()) : "no __diag"');
  await evaluate('window.__orbit ? window.__orbit(150, 60) : -1');
  await new Promise(r => setTimeout(r, 1500));
  const after = await evaluate('window.__diag ? JSON.stringify(window.__diag()) : "no __diag"');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));

  console.log('--- BEFORE ---'); console.log(before);
  console.log('--- AFTER ORBIT ---'); console.log(after);
  console.log('--- CONSOLE (' + logs.length + ') ---');
  console.log(logs.slice(0, 40).join('\n') || '(nothing)');
  console.log('--- screenshot -> ' + OUT + ' ---');
  ws.close();
  process.exit(0);
})().catch(e => { console.error('inspect failed:', e.message); process.exit(1); });
