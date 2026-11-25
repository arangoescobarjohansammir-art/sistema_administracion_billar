import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, workerData } from 'node:worker_threads';

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

if (!isMainThread) {
  const { source, folder, reason } = workerData as { source: string; folder: string; reason: string };
  createCashBackup(source, folder, reason);
}
