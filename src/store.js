const { STATUS, worstStatus } = require('./status');

/** Estado em memória: último resultado e histórico recente de cada endpoint. */
class StatusStore {
  constructor(endpoints, { historyHours, barsMinHours }) {
    this.historyMs = historyHours * 60 * 60 * 1000;
    this.historyHours = historyHours;
    this.barsMinHours = barsMinHours;
    this.services = new Map(endpoints.map((ep) => [ep.id, { endpoint: ep, current: null, history: [] }]));
  }

  /** Registra o resultado de um ciclo e devolve o status anterior. */
  record(id, result) {
    const service = this.services.get(id);
    const previous = service.current ? service.current.status : STATUS.PENDING;

    service.current = result;
    service.history.push(toHistoryEntry(result));

    const cutoff = result.timestamp - this.historyMs;
    const firstKept = service.history.findIndex((h) => h.t >= cutoff);
    if (firstKept > 0) service.history.splice(0, firstKept);

    return previous;
  }

  /** Substitui histórico e último resultado (usado ao recarregar os logs na inicialização). */
  restore(id, results, current) {
    const service = this.services.get(id);
    service.history = results.map(toHistoryEntry);
    service.current = current;
  }

  /**
   * @param {number} barSlots quantidade de barras que a página vai exibir por serviço
   * @param {number} [requestedHours] período coberto pelas barras (inválido = barsMinHours; máximo historyHours)
   */
  snapshot(barSlots, requestedHours) {
    const barsHours = Number.isFinite(requestedHours) && requestedHours > 0
      ? Math.min(requestedHours, this.historyHours)
      : this.barsMinHours;

    const services = [...this.services.values()].map(({ endpoint, current, history }) => {
      const succeeded = history.filter((h) => !h.f);
      const { checksPerBar, bars } = buildBars(history, endpoint.interval, barSlots, barsHours * 60 * 60);
      return {
        id: endpoint.id,
        name: endpoint.name,
        interval: endpoint.interval,
        status: current ? current.status : STATUS.PENDING,
        lastCheck: current ? current.timestamp : null,
        statusCode: current ? current.statusCode : null,
        responseTime: current ? current.responseTime : null,
        attempts: current ? current.attempts : null,
        maxAttempts: endpoint.retries + 1,
        message: current ? current.message : null,
        // Uptime e média usam as checagens reais (uma falha isolada reduz o uptime, mas não colore as barras).
        uptime: history.length ? (succeeded.length / history.length) * 100 : null,
        avgResponseTime: averageResponseTime(history),
        slowThresholdMs: endpoint.slowThresholdMs,
        severeThresholdMs: endpoint.slowThresholdMs === null ? null : endpoint.slowThresholdMs * endpoint.severeMultiplier,
        checksPerBar,
        bars,
      };
    });

    return {
      generatedAt: Date.now(),
      historyHours: this.historyHours,
      barsMinHours: this.barsMinHours,
      barsHours,
      barSlots,
      overall: services.map((s) => s.status).reduce(worstStatus, STATUS.PENDING),
      services,
    };
  }
}

/**
 * Agrupa as checagens mais recentes em até `slots` barras, cobrindo no mínimo `minSeconds`.
 * Cada barra reúne `checksPerBar` checagens consecutivas (a mais recente fica à direita);
 * a barra mais antiga pode ficar incompleta quando ainda não há histórico suficiente.
 */
function buildBars(history, interval, slots, minSeconds) {
  const checksNeeded = Math.max(slots, Math.ceil(minSeconds / interval));
  const checksPerBar = Math.ceil(checksNeeded / slots);
  const recent = history.slice(-slots * checksPerBar);

  const bars = [];
  for (let end = recent.length; end > 0; end -= checksPerBar) {
    bars.unshift(summarizeBar(recent.slice(Math.max(0, end - checksPerBar), end)));
  }
  return { checksPerBar, bars };
}

/** A barra assume o pior status do serviço no período (status já suavizado pela janela). */
function summarizeBar(entries) {
  const counts = { [STATUS.OPERATIONAL]: 0, [STATUS.DEGRADED]: 0, [STATUS.SEVERE]: 0, [STATUS.OUTAGE]: 0 };
  let worst = STATUS.OPERATIONAL;
  for (const h of entries) {
    counts[h.s]++;
    worst = worstStatus(worst, h.s);
  }
  return {
    from: entries[0].t,
    to: entries[entries.length - 1].t,
    status: worst,
    checks: entries.length,
    counts,
    avgResponseTime: averageResponseTime(entries),
  };
}

/** Média das checagens com sucesso (timeouts e erros distorceriam a média). */
function averageResponseTime(entries) {
  const succeeded = entries.filter((h) => !h.f);
  return succeeded.length ? Math.round(succeeded.reduce((sum, h) => sum + h.rt, 0) / succeeded.length) : null;
}

/** s = status do serviço após a checagem; f = a checagem em si falhou. */
function toHistoryEntry(result) {
  return { t: result.timestamp, s: result.status, rt: result.responseTime, f: result.failed };
}

module.exports = { StatusStore };
