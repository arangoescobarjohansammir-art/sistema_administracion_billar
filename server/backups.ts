import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { BackupStatus } from '../shared/backup.js';

const maxAgeMs = 24 * 60 * 60 * 1000;
const retryMs = 5 * 60 * 1000;
type VerifiedCopy = Pick<BackupStatus, 'copiedAt' | 'verifiedAt'>;
const comparablePath = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;

function verifyOrCreate(source: string, folder: string, reason: string, cutoff: number | null) {
  return new Promise<VerifiedCopy>((resolve, reject) => {
    const worker = new Worker(new URL('./backup-file.js', import.meta.url), { workerData: { source, folder, reason, cutoff } });
    let verified: VerifiedCopy | undefined;
    worker.once('message', (copy: VerifiedCopy) => { verified = copy; });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0 && verified) resolve(verified);
      else reject(new Error('El proceso de respaldo no pudo verificar la copia.'));
    });
  });
}

export function createAutomaticBackups(database: DatabaseSync, databasePath: string) {
  const source = resolve(databasePath);
  const localFolder = resolve(process.env.CAJA_BACKUP_DIR || join(dirname(source), 'backups'));
  const secondaryPath = process.env.CAJA_BACKUP_SECONDARY_DIR?.trim();
  const lastClose = database.prepare('SELECT MAX(closed_at) AS time FROM cash_shifts');

  function target(folder: string | null, label: string, secondary = false) {
    let status: BackupStatus = {
      state: folder ? 'pending' : 'unconfigured', copiedAt: null, verifiedAt: null, error: null,
    };
    let pending: number | null | undefined;
    let running = false;
    let lastWarning = '';

    async function drain() {
      if (!folder) return;
      running = true;
      let failureMessage = secondary
        ? 'No se pudo verificar la segunda copia. Revisa que el disco esté conectado y permita guardar archivos.'
        : 'No se pudo verificar la copia local. Revisa el espacio y los permisos del disco de caja.';
      try {
        if (secondary) {
          const [primaryPath, copyPath] = await Promise.all([
            realpath(localFolder).catch(() => localFolder), realpath(folder).catch(() => folder),
          ]);
          if (comparablePath(primaryPath) === comparablePath(copyPath)) {
            failureMessage = 'Elige una carpeta secundaria distinta de la carpeta del respaldo local.';
            throw new Error(failureMessage);
          }
        }
        while (pending !== undefined) {
          const shiftId = pending;
          pending = undefined;
          const closedAt = lastClose.get()?.time;
          const cutoff = Math.max(Date.now() - maxAgeMs, typeof closedAt === 'string' ? Date.parse(closedAt) : 0);
          status = { ...status, state: 'checking' };
          try {
            const reason = shiftId === null ? 'diaria' : 'turno-' + shiftId;
            const copy = await verifyOrCreate(source, folder, reason, shiftId === null ? cutoff : null);
            status = { ...copy, state: 'verified', error: null };
            lastWarning = '';
          } catch (error) {
            if (pending === undefined) pending = shiftId;
            throw error;
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Error desconocido.';
        if (detail !== lastWarning) console.warn('Respaldo ' + label + ': ' + detail);
        lastWarning = detail;
        status = { ...status, state: 'error', error: failureMessage };
      } finally {
        running = false;
      }
    }

    return {
      status: () => status,
      request(shiftId: number | null) {
        if (!folder) return;
        if (shiftId !== null || pending === undefined) pending = shiftId;
        if (!running) void drain();
      },
    };
  }

  const local = target(localFolder, 'local');
  const secondary = target(secondaryPath ? resolve(secondaryPath) : null, 'secundario', true);
  function request(shiftId: number | null) {
    local.request(shiftId);
    secondary.request(shiftId);
  }

  return {
    afterClose: (shiftId: number) => request(shiftId),
    status: () => ({ local: local.status(), secondary: secondary.status() }),
    start() {
      request(null);
      setInterval(() => request(null), retryMs).unref();
    },
  };
}
