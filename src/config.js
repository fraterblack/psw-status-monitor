const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(ROOT_DIR, 'config', 'config.json');

const ENDPOINT_DEFAULTS = {
  method: 'GET',
  timeout: 10, // segundos
  retries: 3, // novas tentativas após a primeira falha
  retryDelay: 5, // segundos entre tentativas
  failuresBeforeOutage: 1, // ciclos consecutivos com todas as tentativas falhando até virar "Fora de Serviço"
  slowThresholdMs: null, // acima disso a resposta é considerada lenta (Degradado)
  expectedStatus: null, // null = qualquer 2xx/3xx
  headers: {},
};

function fail(message) {
  throw new Error(`Configuração inválida: ${message}`);
}

function requirePositive(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`"${field}" deve ser um número maior que zero (recebido: ${JSON.stringify(value)})`);
  }
  return value;
}

function requireNonNegativeInt(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    fail(`"${field}" deve ser um inteiro >= 0 (recebido: ${JSON.stringify(value)})`);
  }
  return value;
}

function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeExpectedStatus(value, field) {
  if (value === null || value === undefined) return null;
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || !list.every((code) => Number.isInteger(code) && code >= 100 && code <= 599)) {
    fail(`"${field}" deve ser um código HTTP ou uma lista de códigos (ex.: [200, 204])`);
  }
  return list;
}

function normalizeEndpoint(raw, index, defaults) {
  const where = `endpoints[${index}]`;
  const ep = { ...defaults, ...raw, headers: { ...defaults.headers, ...raw.headers } };

  if (!ep.url) fail(`${where}.url é obrigatório`);
  let url;
  try {
    url = new URL(ep.url);
  } catch {
    fail(`${where}.url não é uma URL válida: ${ep.url}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`${where}.url deve usar http ou https: ${ep.url}`);
  }

  const name = ep.name || url.host;
  const id = ep.id ? String(ep.id) : slugify(name);
  if (!id) fail(`${where}: não foi possível gerar um "id"; informe-o explicitamente`);

  const failuresBeforeOutage = requireNonNegativeInt(ep.failuresBeforeOutage, `${where}.failuresBeforeOutage`);
  if (failuresBeforeOutage < 1) fail(`"${where}.failuresBeforeOutage" deve ser >= 1`);

  return {
    id,
    name,
    url: url.toString(),
    method: String(ep.method).toUpperCase(),
    headers: ep.headers,
    interval: requirePositive(ep.interval, `${where}.interval`),
    timeout: requirePositive(ep.timeout, `${where}.timeout`),
    retries: requireNonNegativeInt(ep.retries, `${where}.retries`),
    retryDelay: ep.retryDelay === 0 ? 0 : requirePositive(ep.retryDelay, `${where}.retryDelay`),
    failuresBeforeOutage,
    slowThresholdMs:
      ep.slowThresholdMs === null || ep.slowThresholdMs === undefined
        ? null
        : requirePositive(ep.slowThresholdMs, `${where}.slowThresholdMs`),
    expectedStatus: normalizeExpectedStatus(ep.expectedStatus, `${where}.expectedStatus`),
  };
}

function loadConfig(configPath = process.env.CONFIG_PATH || DEFAULT_CONFIG_PATH) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Não foi possível ler a configuração em ${configPath}: ${err.message}`);
  }

  const defaults = { ...ENDPOINT_DEFAULTS, ...raw.defaults };

  if (!Array.isArray(raw.endpoints) || raw.endpoints.length === 0) {
    fail('"endpoints" deve ser uma lista com pelo menos um item');
  }
  const endpoints = raw.endpoints.map((ep, i) => normalizeEndpoint(ep, i, defaults));

  const seen = new Set();
  for (const ep of endpoints) {
    if (seen.has(ep.id)) fail(`id de endpoint duplicado: "${ep.id}"`);
    seen.add(ep.id);
  }

  const server = raw.server || {};
  const logs = raw.logs || {};
  const retentionDays = requireNonNegativeInt(logs.retentionDays ?? 5, 'logs.retentionDays');
  if (retentionDays < 1) fail('"logs.retentionDays" deve ser >= 1');

  return {
    title: raw.title || 'Status dos Serviços',
    server: {
      host: server.host || '0.0.0.0',
      port: Number(process.env.PORT) || server.port || 4300,
    },
    logs: {
      dir: path.resolve(ROOT_DIR, logs.dir || './logs'),
      retentionDays,
    },
    maxStartDelay: requireNonNegativeInt(raw.maxStartDelay ?? 30, 'maxStartDelay'),
    historyHours: requirePositive(raw.historyHours ?? 24, 'historyHours'),
    endpoints,
  };
}

module.exports = { loadConfig, ROOT_DIR };
