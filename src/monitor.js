const { httpCheck } = require('./checker');
const { STATUS, STATUS_LABEL, worstStatus } = require('./status');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STATUS_BY_LOG_LABEL = Object.fromEntries(
  Object.entries(STATUS_LABEL).map(([status, label]) => [label.toUpperCase(), status])
);
const IGNORED_LOG_LABEL = 'IGNORADO';

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Status do serviço a partir das últimas checagens (janela de `statusWindow`). Vale o pior entre:
 *  - disponibilidade: falhas na janela >= outageFailures → Fora de Serviço; >= degradedFailures → Degradado
 *  - latência: mediana das checagens com sucesso > slowThresholdMs × severeMultiplier → Degradado grave;
 *              > slowThresholdMs → Degradado
 * Uma falha isolada (abaixo de degradedFailures) ou um pico de latência isolado não alteram o status.
 */
function evaluateWindow(endpoint, window) {
  const failed = window.filter((c) => c.failed);
  const succeeded = window.filter((c) => !c.failed);
  const reasons = [];
  let status = STATUS.OPERATIONAL;

  if (failed.length >= endpoint.degradedFailures) {
    status = failed.length >= endpoint.outageFailures ? STATUS.OUTAGE : STATUS.DEGRADED;
    reasons.push(
      `${failed.length} falha${failed.length > 1 ? 's' : ''} nas últimas ${window.length} verificações ` +
        `(última: ${failed[failed.length - 1].error})`
    );
  }

  if (endpoint.slowThresholdMs !== null && succeeded.length) {
    const typical = median(succeeded.map((c) => c.responseTime));
    const severeLimit = endpoint.slowThresholdMs * endpoint.severeMultiplier;
    if (typical > severeLimit) {
      status = worstStatus(status, STATUS.SEVERE);
      reasons.push(`tempo de resposta mediano de ${typical} ms (acima de ${severeLimit} ms)`);
    } else if (typical > endpoint.slowThresholdMs) {
      status = worstStatus(status, STATUS.DEGRADED);
      reasons.push(`tempo de resposta mediano de ${typical} ms (limite ${endpoint.slowThresholdMs} ms)`);
    }
  }

  return { status, message: reasons.join('; ') || null };
}

/**
 * Interpreta o trecho de uma linha de log gerado por Monitor#formatLogLine (sem a data/hora).
 * Devolve null se a linha não estiver no formato esperado ou for de um ciclo IGNORADO.
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
 * Cada ciclo gera uma checagem (OK se alguma tentativa teve sucesso, falha se todas falharam);
 * o status do serviço é calculado sobre a janela das últimas checagens (ver evaluateWindow).
 */
class Monitor {
  constructor(endpoint, { store, logger, maxStartDelay }) {
    this.endpoint = endpoint;
    this.store = store;
    this.logger = logger;
    this.maxStartDelay = maxStartDelay;
    this.recent = []; // janela de checagens usada no cálculo do status
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

  /**
   * Recarrega checagens anteriores (lidas dos logs, em ordem cronológica) antes de iniciar.
   * Os status são recalculados com as regras e a configuração atuais.
   */
  restore(checks) {
    if (!checks.length) return;
    const results = checks.map((check) => this.evaluate(check));
    this.store.restore(this.endpoint.id, results, results[results.length - 1]);
  }

  /** Inclui a checagem na janela e devolve o resultado com o status do serviço. */
  evaluate(check) {
    this.recent.push(check);
    if (this.recent.length > this.endpoint.statusWindow) this.recent.shift();
    return { ...check, ...evaluateWindow(this.endpoint, this.recent) };
  }

  schedule(delayMs) {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.run(), delayMs);
  }

  async run() {
    const startedAt = Date.now();
    try {
      const check = await this.check();
      if (this.stopped) return;
      this.handle(check);
    } catch (err) {
      console.error(`[monitor] Erro inesperado ao verificar ${this.endpoint.id}:`, err);
    }

    // O intervalo conta a partir do início do ciclo; se o ciclo (com retries) demorou mais, roda em seguida.
    this.schedule(Math.max(0, this.endpoint.interval * 1000 - (Date.now() - startedAt)));
  }

  handle(check) {
    if (check.ignored) {
      // Fica só no log, para acompanhar a frequência; status, histórico e uptime não mudam.
      this.logger.write(new Date(check.timestamp), this.formatLogLine(check));
      return;
    }

    const result = this.evaluate(check);
    const previous = this.store.record(this.endpoint.id, result);
    this.logger.write(new Date(result.timestamp), this.formatLogLine(result));

    if (previous !== result.status) {
      console.log(
        `[monitor] ${this.endpoint.id}: ${STATUS_LABEL[previous]} -> ${STATUS_LABEL[result.status]}` +
          (result.message ? ` (${result.message})` : '')
      );
    }
  }

  isExpectedStatus(code) {
    const expected = this.endpoint.expectedStatus;
    return expected ? expected.includes(code) : code >= 200 && code < 400;
  }

  /** Executa um ciclo com retries. Sucesso em qualquer tentativa conta como checagem OK. */
  async check() {
    const ep = this.endpoint;
    const maxAttempts = ep.retries + 1;
    const failures = [];
    let last = null;
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt++;
      last = await httpCheck(ep);
      if (!last.error && ep.ignoreStatus.includes(last.statusCode)) {
        // Ex.: 429 (rate limit) não diz nada sobre a saúde do serviço: descarta o ciclo,
        // sem novas tentativas (repetir só agravaria o limite).
        return {
          timestamp: Date.now(),
          ignored: true,
          statusCode: last.statusCode,
          responseTime: last.responseTime,
          attempts: attempt,
          maxAttempts,
          failures,
        };
      }
      if (!last.error && !this.isExpectedStatus(last.statusCode)) {
        last.error = `HTTP ${last.statusCode}`;
      }
      if (!last.error) break;

      failures.push(last.error);
      if (attempt < maxAttempts && !this.stopped) await sleep(ep.retryDelay * 1000);
      if (this.stopped) break;
    }

    const failed = Boolean(last.error);
    return {
      timestamp: Date.now(),
      failed,
      statusCode: last.statusCode ?? null,
      responseTime: last.responseTime,
      attempts: attempt,
      maxAttempts,
      failures,
      error: failed ? last.error : null,
    };
  }

  /**
   * O status gravado é o do serviço; o resultado bruto da checagem fica em resultado/tentativas/falhas.
   * Ciclos descartados (ignoreStatus) são gravados como IGNORADO e não são relidos na inicialização.
   */
  formatLogLine(result) {
    const outcome = result.error || `HTTP ${result.statusCode}`;
    const label = result.ignored ? IGNORED_LOG_LABEL : STATUS_LABEL[result.status].toUpperCase();
    const parts = [
      this.endpoint.id,
      label.padEnd(15),
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
