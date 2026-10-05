const { httpCheck } = require('./checker');
const { STATUS, STATUS_LABEL } = require('./status');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STATUS_BY_LOG_LABEL = Object.fromEntries(
  Object.entries(STATUS_LABEL).map(([status, label]) => [label.toUpperCase(), status])
);

function isSlow(endpoint, responseTime) {
  return endpoint.slowThresholdMs !== null && responseTime > endpoint.slowThresholdMs;
}

/** Texto explicativo exibido na página para resultados não operacionais. */
function describeResult(endpoint, result) {
  if (result.failed) {
    return `falhou em ${result.failures.length} tentativa(s): ${result.failures.join('; ')}`;
  }
  const reasons = [];
  if (result.attempts > 1) {
    reasons.push(`respondeu após ${result.attempts} tentativas (${result.failures.join('; ')})`);
  }
  if (isSlow(endpoint, result.responseTime)) {
    reasons.push(`resposta lenta: ${result.responseTime} ms (limite ${endpoint.slowThresholdMs} ms)`);
  }
  return reasons.join('; ') || null;
}

/**
 * Interpreta o trecho de uma linha de log gerado por Monitor#formatLogLine (sem a data/hora).
 * Devolve null se a linha não estiver no formato esperado.
 */
function parseLogLine(text) {
  const [id, label, outcome, responseTime, attempts, , ...rest] = text.split(' | ');
  const status = STATUS_BY_LOG_LABEL[label && label.trim()];
  const rt = /^(\d+) ms$/.exec(responseTime || '');
  const att = /^tentativas (\d+)\/(\d+)$/.exec(attempts || '');
  if (!id || !status || !rt || !att) return null;

  const failuresText = rest.join(' | ').replace(/^falhas: /, '');
  const failures = failuresText ? failuresText.split('; ') : [];
  const failed = failures.length >= Number(att[1]);
  const http = /^HTTP (\d{3})$/.exec(outcome);

  return {
    id,
    status,
    failed,
    statusCode: http ? Number(http[1]) : null,
    responseTime: Number(rt[1]),
    attempts: Number(att[1]),
    maxAttempts: Number(att[2]),
    failures,
    error: failed ? outcome : null,
  };
}

/**
 * Agenda e executa as verificações de um endpoint.
 *
 * Regras de status de cada ciclo:
 *  - Operacional:     respondeu com sucesso na 1ª tentativa (e dentro de slowThresholdMs, se configurado)
 *  - Degradado:       só respondeu após novas tentativas, ou respondeu acima de slowThresholdMs,
 *                     ou falhou em todas as tentativas mas ainda não atingiu failuresBeforeOutage
 *  - Fora de Serviço: falhou em todas as tentativas por failuresBeforeOutage ciclos consecutivos
 */
class Monitor {
  constructor(endpoint, { store, logger, maxStartDelay }) {
    this.endpoint = endpoint;
    this.store = store;
    this.logger = logger;
    this.maxStartDelay = maxStartDelay;
    this.consecutiveFailures = 0;
    this.timer = null;
    this.stopped = false;
  }

  /** Inicia com atraso aleatório para que os endpoints não sejam chamados todos ao mesmo tempo. */
  start() {
    const delayMs = Math.round(Math.random() * Math.min(this.endpoint.interval, this.maxStartDelay) * 1000);
    this.schedule(delayMs);
    return delayMs;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Recarrega resultados anteriores (lidos dos logs, em ordem cronológica) antes de iniciar. */
  restore(results) {
    if (!results.length) return;
    for (const result of results) {
      this.consecutiveFailures = result.failed ? this.consecutiveFailures + 1 : 0;
    }
    const last = results[results.length - 1];
    this.store.restore(this.endpoint.id, results, { ...last, message: describeResult(this.endpoint, last) });
  }

  schedule(delayMs) {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.run(), delayMs);
  }

  async run() {
    const startedAt = Date.now();
    try {
      const result = await this.check();
      if (this.stopped) return;

      const previous = this.store.record(this.endpoint.id, result);
      this.logger.write(new Date(result.timestamp), this.formatLogLine(result));

      if (previous !== result.status) {
        console.log(
          `[monitor] ${this.endpoint.id}: ${STATUS_LABEL[previous]} -> ${STATUS_LABEL[result.status]}` +
            (result.message ? ` (${result.message})` : '')
        );
      }
    } catch (err) {
      console.error(`[monitor] Erro inesperado ao verificar ${this.endpoint.id}:`, err);
    }

    // O intervalo conta a partir do início do ciclo; se o ciclo (com retries) demorou mais, roda em seguida.
    this.schedule(Math.max(0, this.endpoint.interval * 1000 - (Date.now() - startedAt)));
  }

  isExpectedStatus(code) {
    const expected = this.endpoint.expectedStatus;
    return expected ? expected.includes(code) : code >= 200 && code < 400;
  }

  async check() {
    const ep = this.endpoint;
    const maxAttempts = ep.retries + 1;
    const failures = [];
    let last = null;
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt++;
      last = await httpCheck(ep);
      if (!last.error && !this.isExpectedStatus(last.statusCode)) {
        last.error = `HTTP ${last.statusCode}`;
      }
      if (!last.error) break;

      failures.push(last.error);
      if (attempt < maxAttempts && !this.stopped) await sleep(ep.retryDelay * 1000);
      if (this.stopped) break;
    }

    const failed = Boolean(last.error);
    this.consecutiveFailures = failed ? this.consecutiveFailures + 1 : 0;

    let status;
    if (failed) {
      status = this.consecutiveFailures >= ep.failuresBeforeOutage ? STATUS.OUTAGE : STATUS.DEGRADED;
    } else {
      status = attempt > 1 || isSlow(ep, last.responseTime) ? STATUS.DEGRADED : STATUS.OPERATIONAL;
    }

    const result = {
      timestamp: Date.now(),
      status,
      failed,
      statusCode: last.statusCode ?? null,
      responseTime: last.responseTime,
      attempts: attempt,
      maxAttempts,
      failures,
      error: failed ? last.error : null,
    };
    result.message = describeResult(ep, result);
    return result;
  }

  formatLogLine(result) {
    const outcome = result.error || `HTTP ${result.statusCode}`;
    const parts = [
      this.endpoint.id,
      STATUS_LABEL[result.status].toUpperCase().padEnd(15),
      outcome,
      `${result.responseTime} ms`,
      `tentativas ${result.attempts}/${result.maxAttempts}`,
      `${this.endpoint.method} ${this.endpoint.url}`,
    ];
    if (result.failures.length) parts.push(`falhas: ${result.failures.join('; ')}`);
    return parts.join(' | ');
  }
}

module.exports = { Monitor, parseLogLine };
