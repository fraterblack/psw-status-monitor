const { httpCheck } = require('./checker');
const { STATUS, STATUS_LABEL } = require('./status');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      last = await httpCheck(ep);
      if (!last.error && !this.isExpectedStatus(last.statusCode)) {
        last.error = `HTTP ${last.statusCode}`;
      }

      if (!last.error) {
        this.consecutiveFailures = 0;
        const slow = ep.slowThresholdMs !== null && last.responseTime > ep.slowThresholdMs;
        const reasons = [];
        if (attempt > 1) reasons.push(`respondeu após ${attempt} tentativas (${failures.join('; ')})`);
        if (slow) reasons.push(`resposta lenta: ${last.responseTime} ms (limite ${ep.slowThresholdMs} ms)`);

        return {
          timestamp: Date.now(),
          status: reasons.length ? STATUS.DEGRADED : STATUS.OPERATIONAL,
          statusCode: last.statusCode,
          responseTime: last.responseTime,
          attempts: attempt,
          maxAttempts,
          failures,
          error: null,
          message: reasons.join('; ') || null,
        };
      }

      failures.push(last.error);
      if (attempt < maxAttempts && !this.stopped) await sleep(ep.retryDelay * 1000);
      if (this.stopped) break;
    }

    this.consecutiveFailures++;
    const outage = this.consecutiveFailures >= ep.failuresBeforeOutage;
    return {
      timestamp: Date.now(),
      status: outage ? STATUS.OUTAGE : STATUS.DEGRADED,
      statusCode: last.statusCode ?? null,
      responseTime: last.responseTime,
      attempts: failures.length,
      maxAttempts,
      failures,
      error: last.error,
      message: `falhou em ${failures.length} tentativa(s): ${failures.join('; ')}`,
    };
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

module.exports = { Monitor };
