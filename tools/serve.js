/* Telsiz'i bu bilgisayarda açmak için küçük yerel sunucu.
   Yalnızca bu bilgisayara (127.0.0.1) hizmet verir; mesajlar buradan geçmez,
   sadece uygulama dosyalarını tarayıcıya verir. Kullanım: node tools/serve.js [--open] */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'app');
const PORT = Number(process.env.PORT) || 4780;
const URL_ = 'http://localhost:' + PORT + '/';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function openBrowser() {
  if (!process.argv.includes('--open')) return;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', URL_]]
    : process.platform === 'darwin' ? ['open', [URL_]] : ['xdg-open', [URL_]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
}

const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, URL_).pathname); } catch { res.writeHead(400).end(); return; }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bulunamadı'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    }).end(data);
  });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') { console.log('Telsiz zaten açık: ' + URL_); openBrowser(); return; }
  throw err;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('Telsiz bu bilgisayarda hazır: ' + URL_);
  console.log('Kapatmak için bu pencereyi kapatın.');
  openBrowser();
});
