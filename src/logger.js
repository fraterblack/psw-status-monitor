const fs = require('fs');
const path = require('path');

const FILE_PATTERN = /^status-(\d{4}-\d{2}-\d{2})\.txt$/;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const pad = (n, size = 2) => String(n).padStart(size, '0');

function localDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTimestamp(date) {
  return (
    `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:` +
    `${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

/**
 * Grava uma linha por verificação em logs/status-AAAA-MM-DD.txt (um arquivo por dia, horário local)
 * e remove arquivos fora do período de retenção.
 */
class FileLogger {
  constructor({ dir, retentionDays }) {
    this.dir = dir;
    this.retentionDays = retentionDays;
    this.queue = Promise.resolve();
    this.cleanupTimer = null;
  }

  async init() {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await this.cleanup();
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  write(date, line) {
    const file = path.join(this.dir, `status-${localDate(date)}.txt`);
    // Fila serializada: mantém a ordem das linhas e evita escritas concorrentes no mesmo arquivo.
    this.queue = this.queue
      .then(() => fs.promises.appendFile(file, `${localTimestamp(date)} | ${line}\n`, 'utf8'))
      .catch((err) => console.error(`[logger] Falha ao gravar em ${file}: ${err.message}`));
    return this.queue;
  }

  /** Mantém o dia atual + (retentionDays - 1) dias anteriores. */
  async cleanup() {
    const now = new Date();
    const oldestKept = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (this.retentionDays - 1)));

    try {
      const files = await fs.promises.readdir(this.dir);
      for (const file of files) {
        const match = FILE_PATTERN.exec(file);
        if (match && match[1] < oldestKept) {
          await fs.promises.unlink(path.join(this.dir, file));
          console.log(`[logger] Log antigo removido: ${file}`);
        }
      }
    } catch (err) {
      console.error(`[logger] Falha na limpeza de logs: ${err.message}`);
    }
  }

  async close() {
    clearInterval(this.cleanupTimer);
    await this.queue;
  }
}

module.exports = { FileLogger };
