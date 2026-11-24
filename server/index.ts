import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createCatalog } from './catalog.js';
import { createAccounts } from './accounts.js';
import { readJson, sendJson } from './http.js';

const host = '127.0.0.1';
const port = Number(process.env.PORT ?? 4173);
const client = new URL('../client/', import.meta.url);
const databasePath = process.env.CAJA_DB_PATH ??
  fileURLToPath(new URL('../../data/caja.sqlite', import.meta.url));

mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  CREATE TABLE IF NOT EXISTS local_note (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    text TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT
`);

const handleCatalog = createCatalog(database);
const handleAccounts = createAccounts(database);

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  const addressPort = request.socket.localPort;
  const allowedHosts = [`${host}:${addressPort}`, `localhost:${addressPort}`];
  if (!request.headers.host || !allowedHosts.includes(request.headers.host)) {
    return sendJson(response, 403, { error: 'La caja solo acepta conexiones locales.' });
  }

  const path = new URL(request.url ?? '/', `http://${host}`).pathname;
  const origin = request.headers.origin;
  if (request.method !== 'GET' && origin &&
    !allowedHosts.some((allowed) => origin === `http://${allowed}`)) {
    return sendJson(response, 403, { error: 'Origen no autorizado.' });
  }
  if (path === '/api/products' || path.startsWith('/api/products/')) {
    return handleCatalog(request, response, path);
  }
  if (path === '/api/sales' || path === '/api/accounts' || path.startsWith('/api/accounts/')) {
    return handleAccounts(request, response, path);
  }
  if (path === '/api/local-note') {
    if (request.method === 'GET') {
      const note = database.prepare('SELECT text, updated_at AS updatedAt FROM local_note WHERE id = 1').get();
      return sendJson(response, 200, note ?? { text: '', updatedAt: null });
    }
    if (request.method === 'PUT') {
      const input = await readJson(request);
      if (typeof input?.text !== 'string' || input.text.length > 500) {
        return sendJson(response, 400, { error: 'Escribe hasta 500 caracteres.' });
      }
      const text = input.text.trim();
      const updatedAt = new Date().toISOString();
      database.prepare(`
        INSERT INTO local_note (id, text, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
      `).run(text, updatedAt);
      return sendJson(response, 200, { text, updatedAt });
    }
    response.setHeader('Allow', 'GET, PUT');
    return sendJson(response, 405, { error: 'Método no permitido.' });
  }

  const file = path === '/' ? 'index.html' : /^\/assets\/[\w.-]+$/.test(path) ? path.slice(1) : null;
  if (request.method !== 'GET' || !file) return sendJson(response, 404, { error: 'Página no encontrada.' });
  try {
    const body = await readFile(new URL(file, client));
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    sendJson(response, 404, { error: 'Archivo no encontrado. Ejecuta npm run build.' });
  }
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    console.error(error);
    if (!response.headersSent) sendJson(response, 500, { error: 'Error al acceder a la caja local.' });
    else response.end();
  });
});
server.listen(port, host, () => {
  const address = server.address();
  if (address && typeof address === 'object') console.log(`Caja local en http://${host}:${address.port}`);
});
