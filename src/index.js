const { loadConfig } = require('./config');
const { FileLogger } = require('./logger');
const { Monitor } = require('./monitor');
const { StatusStore } = require('./store');
const { createServer } = require('./server');

async function main() {
  const config = loadConfig();

  const logger = new FileLogger(config.logs);
  await logger.init();

  const store = new StatusStore(config.endpoints, { historyHours: config.historyHours });
  const monitors = config.endpoints.map(
    (ep) => new Monitor(ep, { store, logger, maxStartDelay: config.maxStartDelay })
  );

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
