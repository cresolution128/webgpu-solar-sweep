// Ask the page to clear to a set of known values, screenshot each, and print the
// pixel the compositor actually shows. That isolates the canvas transfer
// function from anything the shaders are doing.
const fs = require('fs');
const zlib = require('zlib');

const decodePng = buf => {
  let pos = 8, w = 0, h = 0, idat = [], colorType = 6, bitDepth = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (bitDepth !== 8 || !channels) throw new Error(`unsupported png: depth ${bitDepth} type ${colorType}`);
  const bpp = channels, stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[p + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v;
      if (filter === 0) v = rawByte;
      else if (filter === 1) v = rawByte + a;
      else if (filter === 2) v = rawByte + b;
      else if (filter === 3) v = rawByte + ((a + b) >> 1);
      else { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
             v = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[y * stride + x] = v & 0xff;
    }
    p += stride;
  }
  return {
    w, h, channels,
    px: (x, y) => [out[(y * w + x) * bpp], out[(y * w + x) * bpp + 1], out[(y * w + x) * bpp + 2]],
  };
};

(async () => {
  const list = await (await fetch('http://localhost:9222/json/list')).json();
  const page = list.find(t => t.type === 'page' && t.url.includes('localhost:8099'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const st = { id: 0, pending: new Map() };
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && st.pending.has(m.id)) { const p = st.pending.get(m.id); st.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++st.id; st.pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await new Promise(r => setTimeout(r, 1500));

  const evaluate = e => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then(r => r.result?.value);
  console.log('canvas format:', await evaluate('window.__format ? window.__format() : "n/a"'));

  for (const v of [1.0, 0.5, 0.25]) {
    await evaluate(`window.__clear(${v}, ${v}, ${v})`);
    await new Promise(r => setTimeout(r, 800));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const img = decodePng(Buffer.from(shot.data, 'base64'));
    if (v === 1.0) console.log(`  png ${img.w}x${img.h}, ${img.channels} channels; sidebar pixel ${img.px(img.w - 100, 30)}`);
    const [r, g, b] = img.px(200, 120);
    const expected = Math.round(v * 255);
    console.log(`clear ${v.toFixed(2)} -> expected ~${expected}, screen shows ${r},${g},${b}` +
      `   (ratio ${(r / 255 / v).toFixed(3)})`);
  }
  await evaluate('window.__clear(null)');
  ws.close(); process.exit(0);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
