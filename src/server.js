const fs = require('fs');
const http = require('http');
const path = require('path');
const { ROOT_DIR } = require('./config');

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function serveStatic(pathname, res) {
  let relative;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return send(res, 400, 'Bad Request', 'text/plain; charset=utf-8');
  }

  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
  }

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
    send(res, 200, data, MIME_TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

function createServer({ store, title }) {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }

    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/api/status') {
      return send(res, 200, JSON.stringify({ title, ...store.snapshot() }), 'application/json; charset=utf-8');
    }

    serveStatic(pathname, res);
  });
}

module.exports = { createServer };
