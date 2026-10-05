const http = require('http');
const https = require('https');

const DEFAULT_HEADERS = { 'user-agent': 'psw-status-monitor/1.0' };

function describeError(err) {
  return err.code || err.message || 'Erro desconhecido';
}

/**
 * Executa uma única requisição HTTP ao endpoint.
 * Nunca rejeita: devolve { responseTime, statusCode } ou { responseTime, error }.
 * O tempo de resposta inclui DNS, conexão, TLS e leitura completa do corpo.
 */
function httpCheck(endpoint) {
  return new Promise((resolve) => {
    const url = new URL(endpoint.url);
    const client = url.protocol === 'https:' ? https : http;
    const start = process.hrtime.bigint();
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ responseTime: Math.round(Number(process.hrtime.bigint() - start) / 1e6), ...result });
    };

    // agent: false força uma conexão nova a cada verificação (sem reaproveitar sockets).
    const req = client.request(
      url,
      { method: endpoint.method, headers: { ...DEFAULT_HEADERS, ...endpoint.headers }, agent: false },
      (res) => {
        res.on('error', (err) => finish({ error: describeError(err) }));
        res.on('end', () => finish({ statusCode: res.statusCode }));
        res.resume(); // descarta o corpo
      }
    );

    timer = setTimeout(() => {
      finish({ error: `Timeout (${endpoint.timeout}s)` });
      req.destroy();
    }, endpoint.timeout * 1000);

    req.on('error', (err) => finish({ error: describeError(err) }));
    req.end();
  });
}

module.exports = { httpCheck };
