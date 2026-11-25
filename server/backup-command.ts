import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCashBackup, restoreCashBackup, verifyCashDatabase } from './backup-file.js';

const [action, first, second, third] = process.argv.slice(2);
try {
  if (action === 'create') {
    const project = fileURLToPath(new URL('../../', import.meta.url));
    const envFile = join(project, '.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    const source = resolve(first ?? process.env.CAJA_DB_PATH ?? join(project, 'data', 'caja.sqlite'));
    const folder = resolve(second ?? (process.env.CAJA_BACKUP_DIR || join(dirname(source), 'backups')));
    console.log(createCashBackup(source, folder, third ?? 'manual'));
  } else if (action === 'verify' && first && !second) {
    verifyCashDatabase(resolve(first));
    console.log('Copia verificada.');
  } else if (action === 'restore' && first && second && !third) {
    restoreCashBackup(resolve(first), resolve(second));
    console.log('Base restaurada y verificada en ' + resolve(second));
  } else {
    throw new Error('Usa create, verify <copia> o restore <copia> <archivo nuevo>.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Falló la operación de respaldo.');
  process.exitCode = 1;
}
