import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

const requiredTables = ['cash_shifts', 'sales', 'customer_accounts', 'inventory_movements', 'products'];

export function verifyCashDatabase(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const checks = db.prepare('PRAGMA integrity_check').all();
    if (checks.length !== 1 || checks[0].integrity_check !== 'ok') {
      throw new Error('La base de datos no pasó la comprobación de integridad.');
    }
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
    if (!requiredTables.every((table) => tables.has(table))) {
      throw new Error('El archivo no contiene la base de datos de caja.');
    }
    if (db.prepare('PRAGMA foreign_key_check').get()) {
      throw new Error('La base tiene referencias incompletas y requiere revisión.');
    }
  } finally {
    db.close();
  }
}

export function createCashBackup(source: string, folder: string, reason: string) {
  if (!/^(diaria|manual|turno-[1-9]\d*)$/.test(reason)) throw new Error('Motivo de copia inválido.');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const time = new Date().toISOString().replaceAll(':', '-').replace('.', '-');
  const destination = join(folder, `caja-${time}-${reason}-${randomUUID()}.sqlite`);
  const partial = destination + '.partial';
  try {
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare('VACUUM INTO ?').run(partial);
    } finally {
      db.close();
    }
    verifyCashDatabase(partial);
    renameSync(partial, destination);
    return destination;
  } finally {
    if (existsSync(partial)) unlinkSync(partial);
  }
}

export function restoreCashBackup(source: string, destination: string) {
  if (['', '-wal', '-shm', '-journal'].some((suffix) => existsSync(destination + suffix))) {
    throw new Error('El destino ya existe. Elige un archivo nuevo de SQLite en otra carpeta.');
  }
  if (['-wal', '-shm', '-journal'].some((suffix) => existsSync(source + suffix))) {
    throw new Error('Selecciona una copia de seguridad terminada, con solo un archivo SQLite.');
  }
  verifyCashDatabase(source);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  verifyCashDatabase(destination);
}

function recentVerifiedBackup(folder: string, cutoff: number) {
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const candidates = entries.flatMap((entry) => {
    if (!entry.isFile()) return [];
    const match = /^caja-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(?:diaria|manual|turno-\d+)-[a-f0-9-]{36}\.sqlite$/.exec(entry.name);
    if (!match) return [];
    const time = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
    return time >= cutoff && time <= Date.now() ? [{ name: entry.name, time }] : [];
  }).sort((first, second) => second.time - first.time);
  for (const candidate of candidates) {
    try {
      verifyCashDatabase(join(folder, candidate.name));
      return new Date(candidate.time).toISOString();
    } catch {
      // An unreadable or damaged file does not count as a verified copy.
    }
  }
  return null;
}

if (!isMainThread) {
  const { source, folder, reason, cutoff } = workerData as {
    source: string; folder: string; reason: string; cutoff: number | null;
  };
  let copiedAt = cutoff === null ? null : recentVerifiedBackup(folder, cutoff);
  if (copiedAt === null) {
    copiedAt = new Date().toISOString();
    createCashBackup(source, folder, reason);
  }
  parentPort!.postMessage({ copiedAt, verifiedAt: new Date().toISOString() });
}
