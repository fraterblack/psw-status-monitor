const STATUS = Object.freeze({
  PENDING: 'pending',
  OPERATIONAL: 'operational',
  DEGRADED: 'degraded',
  SEVERE: 'severe',
  OUTAGE: 'outage',
});

const STATUS_LABEL = Object.freeze({
  [STATUS.PENDING]: 'Aguardando',
  [STATUS.OPERATIONAL]: 'Operacional',
  [STATUS.DEGRADED]: 'Degradado',
  [STATUS.SEVERE]: 'Degradado grave',
  [STATUS.OUTAGE]: 'Fora de Serviço',
});

// Gravidade de cada status (maior = pior).
const STATUS_SEVERITY = Object.freeze({
  [STATUS.PENDING]: -1,
  [STATUS.OPERATIONAL]: 0,
  [STATUS.DEGRADED]: 1,
  [STATUS.SEVERE]: 2,
  [STATUS.OUTAGE]: 3,
});

function worstStatus(a, b) {
  return STATUS_SEVERITY[b] > STATUS_SEVERITY[a] ? b : a;
}

module.exports = { STATUS, STATUS_LABEL, worstStatus };
