import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

const maxAgeMs = 24 * 60 * 60 * 1000;
const retryMs = 5 * 60 * 1000;

export function createAutomaticBackups(database: DatabaseSync, databasePath: string) {
  const source = resolve(databasePath);
  const folder = resolve(process.env.CAJA_BACKUP_DIR || join(dirname(source), 'backups'));
  const lastClose = database.prepare('SELECT MAX(closed_at) AS time FROM cash_shifts');
  const requested = new Set<number | null>();
  let running = false;
  let lastWarning = '';

  async function recentCopyExists() {
    let files;
    try {
      files = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const closedAt = lastClose.get()?.time;
    const cutoff = Math.max(Date.now() - maxAgeMs, typeof closedAt === 'string' ? Date.parse(closedAt) : 0);
    return files.some((file) => {
      if (!file.isFile()) return false;
      const match = /^caja-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(?:diaria|manual|turno-\d+)-[a-f0-9-]{36}\.sqlite$/.exec(file.name);
      if (!match) return false;
      const date = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
      return date >= cutoff && date <= Date.now();
    });
  }

  async function drain() {
    running = true;
    try {
      for (const shiftId of requested) {
        if (shiftId !== null || !(await recentCopyExists())) {
          const reason = shiftId === null ? 'diaria' : 'turno-' + shiftId;
          await new Promise<void>((resolve, reject) => {
            const worker = new Worker(new URL('./backup-file.js', import.meta.url), { workerData: { source, folder, reason } });
            worker.once('error', reject);
            worker.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Código de salida ' + code)));
          });
          console.info('Copia de seguridad verificada (' + reason + ').');
        }
        requested.delete(shiftId);
      }
      lastWarning = '';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error desconocido.';
      if (message !== lastWarning) console.warn('No se pudo guardar el respaldo. Se reintentará. ' + message);
      lastWarning = message;
    } finally {
      running = false;
    }
  }

  function request(shiftId: number | null) {
    requested.add(shiftId);
    if (!running) void drain();
  }

  return {
    afterClose: (shiftId: number) => request(shiftId),
    start() {
      request(null);
      setInterval(() => request(null), retryMs).unref();
    },
  };
}
