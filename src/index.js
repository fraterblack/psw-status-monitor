const { loadConfig } = require('./config');
const { FileLogger } = require('./logger');
const { Monitor, parseLogLine } = require('./monitor');
const { StatusStore } = require('./store');
const { createServer } = require('./server');

/** Reconstrói o histórico da janela historyHours a partir dos arquivos de log. */
async function restoreHistory({ historyHours }, logger, monitors) {
  const resultsById = new Map(monitors.map((m) => [m.endpoint.id, []]));
  const entries = await logger.readSince(Date.now() - historyHours * 60 * 60 * 1000);

  for (const { timestamp, text } of entries) {
    const result = parseLogLine(text);
    // Ignora linhas malformadas e endpoints que não estão mais na configuração.
    if (result && resultsById.has(result.id)) resultsById.get(result.id).push({ ...result, timestamp });
  }

  let total = 0;
  for (const monitor of monitors) {
    const results = resultsById.get(monitor.endpoint.id);
    monitor.restore(results);
    total += results.length;
  }
  return total;
}

async function main() {
  const config = loadConfig();

  const logger = new FileLogger(config.logs);
  await logger.init();

  const store = new StatusStore(config.endpoints, {
    historyHours: config.historyHours,
    barsMinHours: config.barsMinHours,
  });
  const monitors = config.endpoints.map(
    (ep) => new Monitor(ep, { store, logger, maxStartDelay: config.maxStartDelay })
  );

  const restored = await restoreHistory(config, logger, monitors);
  console.log(`[app] Histórico restaurado dos logs: ${restored} verificações das últimas ${config.historyHours}h`);

  const server = createServer({ store, title: config.title });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, resolve);
  });

  console.log(`[app] Página de status em http://${config.server.host}:${config.server.port}`);
  console.log(`[app] Logs em ${config.logs.dir} (retenção de ${config.logs.retentionDays} dias)`);

  for (const monitor of monitors) {
    const delayMs = monitor.start();
    const ep = monitor.endpoint;
    console.log(
      `[app] ${ep.id}: ${ep.method} ${ep.url} a cada ${ep.interval}s ` +
        `(retries ${ep.retries}, 1ª verificação em ${(delayMs / 1000).toFixed(1)}s)`
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[app] ${signal} recebido, encerrando...`);
    monitors.forEach((m) => m.stop());
    server.close();
    await logger.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[app] Falha ao iniciar: ${err.message}`);
  process.exit(1);
});
