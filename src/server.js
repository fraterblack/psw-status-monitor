const fs = require('fs');
const http = require('http');
const path = require('path');
const { ROOT_DIR } = require('./config');

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DEFAULT_BAR_SLOTS = 60;
const MIN_BAR_SLOTS = 10;
const MAX_BAR_SLOTS = 120;

const TEXT_PLAIN = 'text/plain; charset=utf-8';

// A página só carrega recursos do próprio servidor e não pode ser embutida em outros sites.
// img-src data: é necessário para o favicon dinâmico (SVG em data URI).
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

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
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function serveStatic(pathname, res) {
  let relative;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return send(res, 400, 'Bad Request', TEXT_PLAIN);
  }
  // Byte nulo faz o fs lançar exceção síncrona (que derrubaria o processo).
  if (relative.includes('\0')) return send(res, 400, 'Bad Request', TEXT_PLAIN);

  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 404, 'Not Found', TEXT_PLAIN);
  }

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not Found', TEXT_PLAIN);
    send(res, 200, data, MIME_TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

function handleRequest(req, res, { store, title }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' });
    return res.end();
  }

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, 'Bad Request', TEXT_PLAIN); // ex.: "GET http://[ HTTP/1.1"
  }

  if (url.pathname === '/api/status') {
    // ?bars=N define quantas barras de histórico a página exibe (o servidor agrupa as checagens)
    // ?hours=H define o período coberto pelas barras (padrão barsMinHours, limitado a historyHours)
    const requested = parseInt(url.searchParams.get('bars'), 10) || DEFAULT_BAR_SLOTS;
    const barSlots = Math.min(MAX_BAR_SLOTS, Math.max(MIN_BAR_SLOTS, requested));
    const hours = parseFloat(url.searchParams.get('hours'));
    const body = JSON.stringify({ title, ...store.snapshot(barSlots, hours) });
    return send(res, 200, body, 'application/json; charset=utf-8');
  }

  serveStatic(url.pathname, res);
}

function createServer(deps) {
  return http.createServer((req, res) => {
    try {
      handleRequest(req, res, deps);
    } catch (err) {
      // Rede de segurança: uma exceção não tratada aqui derrubaria o processo (e o monitoramento).
      console.error(`[server] Erro inesperado ao processar requisição: ${err.message}`);
      if (res.headersSent) res.destroy();
      else send(res, 500, 'Internal Server Error', TEXT_PLAIN);
    }
  });
}

module.exports = { createServer };
