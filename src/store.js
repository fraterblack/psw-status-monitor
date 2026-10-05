const { STATUS } = require('./status');

const MAX_HISTORY_IN_RESPONSE = 90;

/** Estado em memória: último resultado e histórico recente de cada endpoint. */
class StatusStore {
  constructor(endpoints, { historyHours }) {
    this.historyMs = historyHours * 60 * 60 * 1000;
    this.historyHours = historyHours;
    this.services = new Map(endpoints.map((ep) => [ep.id, { endpoint: ep, current: null, history: [] }]));
  }

  /** Registra o resultado de um ciclo e devolve o status anterior. */
  record(id, result) {
    const service = this.services.get(id);
    const previous = service.current ? service.current.status : STATUS.PENDING;

    service.current = result;
    service.history.push({ t: result.timestamp, s: result.status, rt: result.responseTime });

    const cutoff = result.timestamp - this.historyMs;
    const firstKept = service.history.findIndex((h) => h.t >= cutoff);
    if (firstKept > 0) service.history.splice(0, firstKept);

    return previous;
  }

  snapshot() {
    const services = [...this.services.values()].map(({ endpoint, current, history }) => {
      const up = history.filter((h) => h.s !== STATUS.OUTAGE);
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
        uptime: history.length ? (up.length / history.length) * 100 : null,
        avgResponseTime: up.length ? Math.round(up.reduce((sum, h) => sum + h.rt, 0) / up.length) : null,
        history: history.slice(-MAX_HISTORY_IN_RESPONSE),
      };
    });

    return {
      generatedAt: Date.now(),
      historyHours: this.historyHours,
      overall: overallStatus(services.map((s) => s.status)),
      services,
    };
  }
}

function overallStatus(statuses) {
  if (statuses.includes(STATUS.OUTAGE)) return STATUS.OUTAGE;
  if (statuses.includes(STATUS.DEGRADED)) return STATUS.DEGRADED;
  if (statuses.includes(STATUS.OPERATIONAL)) return STATUS.OPERATIONAL;
  return STATUS.PENDING;
}

module.exports = { StatusStore };
