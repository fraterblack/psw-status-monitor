const STATUS = Object.freeze({
  PENDING: 'pending',
  OPERATIONAL: 'operational',
  DEGRADED: 'degraded',
  OUTAGE: 'outage',
});

const STATUS_LABEL = Object.freeze({
  [STATUS.PENDING]: 'Aguardando',
  [STATUS.OPERATIONAL]: 'Operacional',
  [STATUS.DEGRADED]: 'Degradado',
  [STATUS.OUTAGE]: 'Fora de Serviço',
});

module.exports = { STATUS, STATUS_LABEL };
