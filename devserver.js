// Tiny static server with a /result endpoint, used to verify the demo against a
// real GPU: the page posts its self-test result here and the runner prints it.
// Not part of the demo itself — `npx serve` or any static host works fine.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || 8099);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

http
  .createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/shot') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        const b64 = body.replace(/^data:image\/png;base64,/, '');
        fs.writeFileSync(path.join(ROOT, 'selftest-shot.png'), Buffer.from(b64, 'base64'));
        console.log('SHOT ' + b64.length);
        res.writeHead(204).end();
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/result') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        fs.writeFileSync(path.join(ROOT, 'selftest-result.json'), body);
        console.log('RESULT ' + body);
        res.writeHead(204).end();
      });
      return;
    }
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    // No caching. Without this Chrome happily serves stale ES modules after an
    // edit, which looks exactly like a shader change that did not take effect.
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log('serving ' + ROOT + ' on http://localhost:' + PORT));
