import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const port = Number(process.env.PORT ?? 4173);

try {
  const inUse = await new Promise((resolve, reject) => {
    const connection = createConnection({ host, port });
    connection.setTimeout(2500, () => connection.destroy(new Error('No se pudo comprobar el puerto local.')));
    connection.once('connect', () => {
      connection.destroy();
      resolve(true);
    });
    connection.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
  if (inUse) {
    throw new Error('Ya hay un servidor en http://' + host + ':' + port +
      '. Detén la ejecución anterior con Ctrl+C en su terminal y vuelve a ejecutar npm start.');
  }
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Inicia la aplicación con npm start.');
  const build = spawnSync(process.execPath, [npm, 'run', 'build'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stdio: 'inherit',
  });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error('La aplicación no se inició porque la compilación falló.');
  await import('../dist/server/index.js');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
