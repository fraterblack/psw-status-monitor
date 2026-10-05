const fs = require('fs');
const path = require('path');

const FILE_PATTERN = /^status-(\d{4}-\d{2}-\d{2})\.txt$/;
const LINE_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) \| (.*)$/;
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

  /** Lê as linhas gravadas a partir de sinceMs, em ordem cronológica: [{ timestamp, text }]. */
  async readSince(sinceMs) {
    const firstDay = localDate(new Date(sinceMs));
    const entries = [];

    try {
      const files = (await fs.promises.readdir(this.dir))
        .filter((file) => {
          const match = FILE_PATTERN.exec(file);
          return match && match[1] >= firstDay;
        })
        .sort();

      for (const file of files) {
        const content = await fs.promises.readFile(path.join(this.dir, file), 'utf8');
        for (const line of content.split('\n')) {
          const m = LINE_PATTERN.exec(line);
          if (!m) continue;
          const timestamp = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();
          if (timestamp >= sinceMs) entries.push({ timestamp, text: m[8] });
        }
      }
    } catch (err) {
      console.error(`[logger] Falha ao ler o histórico: ${err.message}`);
    }

    return entries.sort((a, b) => a.timestamp - b.timestamp);
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
