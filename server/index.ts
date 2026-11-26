import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createCatalog } from './catalog.js';
import { createAccounts } from './accounts.js';
import { createBilliards } from './billiards.js';
import { createTejo } from './tejo.js';
import { createCash } from './cash.js';
import { startAdminSync } from './admin.js';
import { createAutomaticBackups } from './backups.js';
import { createOperators } from './operators.js';
import { createAudit } from './audit.js';
import { createSaleCorrections } from './sale-corrections.js';
import { createAccountCorrections } from './account-corrections.js';
import { createInventoryCounts } from './inventory-counts.js';
import { readJson, sendJson } from './http.js';
import { accountingPeriod, colombianDay } from '../shared/accounting.js';
import { readAccounting } from './accounting.js';

const host = '127.0.0.1';
const port = Number(process.env.PORT ?? 4173);
const client = new URL('../client/', import.meta.url);
const databasePath = process.env.CAJA_DB_PATH ??
  fileURLToPath(new URL('../../data/caja.sqlite', import.meta.url));

mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec('PRAGMA busy_timeout = 5000');
database.exec(`
  CREATE TABLE IF NOT EXISTS local_note (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    text TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT
`);

const operators = createOperators(database);
const audit = createAudit(database);
const handleCatalog = createCatalog(database, audit);
const accounts = createAccounts(database, audit);
const handleBilliards = createBilliards(database, accounts);
const handleTejo = createTejo(database, accounts);
const cash = createCash(database, accounts, (id) => backups.afterClose(id), audit);
const backups = createAutomaticBackups(database, databasePath);
const saleCorrections = createSaleCorrections(database, accounts, cash, audit);
const accountCorrections = createAccountCorrections(database, accounts, cash, audit);
const inventoryCounts = createInventoryCounts(database, accounts, audit);

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};
// Keep serving the frontend that was built with this process, even if a new build runs.
const assets = new Map<string, Buffer>();
function loadFrontend(root: URL, prefix: string) {
  const page = readFileSync(new URL('index.html', root));
  assets.set(prefix, page);
  for (const entry of readdirSync(new URL('assets/', root), { withFileTypes: true })) {
    if (entry.isFile()) {
      const name = 'assets/' + entry.name;
      assets.set(prefix + name, readFileSync(new URL(name, root)));
    }
  }
}
loadFrontend(client, '/');
loadFrontend(new URL('../admin/', import.meta.url), '/admin/');

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
  if (path === '/api/session' || path.startsWith('/api/session/') ||
      path === '/api/operators' || path.startsWith('/api/operators/')) {
    return operators.handle(request, response, path);
  }
  const operator = path.startsWith('/api/') ? operators.sessionFor(request) : null;
  if (path.startsWith('/api/') && !operator) {
    return sendJson(response, 401, { code: 'CASH_SESSION_REQUIRED', error: 'Inicia sesión para usar la caja.' });
  }
  if (path === '/api/audit' || path.startsWith('/api/corrections/')) {
    if (operator?.role !== 'admin') return sendJson(response, 403, { error: 'Esta función es para el administrador.' });
    if (path === '/api/audit') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Método no permitido.' });
      const before = Number(new URL(request.url ?? '/', `http://${host}`).searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
      return sendJson(response, 200, audit.list(Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER));
    }
    if (path === '/api/corrections/sales' || path.startsWith('/api/corrections/sales/')) {
      return saleCorrections(request, response, path);
    }
    return accountCorrections(request, response, path);
  }
  if (path === '/api/products' || path.startsWith('/api/products/')) {
    return handleCatalog(request, response, path);
  }
  if (path === '/api/inventory-counts' || path.startsWith('/api/inventory-counts/')) {
    return inventoryCounts(request, response, path);
  }
  if (path === '/api/sales' || path === '/api/accounts' || path.startsWith('/api/accounts/')) {
    return accounts.handle(request, response, path);
  }
  if (path === '/api/billiards' || path.startsWith('/api/billiards/')) {
    return handleBilliards(request, response, path);
  }
  if (path === '/api/tejo' || path.startsWith('/api/tejo/')) {
    return handleTejo(request, response, path);
  }
  if (path === '/api/cash' || path.startsWith('/api/cash/')) {
    if (path === '/api/cash/backups') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Método no permitido.' });
      return sendJson(response, 200, backups.status());
    }
    return cash.handle(request, response, path);
  }
  if (path === '/api/reports') {
    if (operator?.role !== 'admin') return sendJson(response, 403, { error: 'Los reportes son para el administrador.' });
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Método no permitido.' });
    const query = new URL(request.url ?? '/', `http://${host}`).searchParams;
    const period = accountingPeriod(query.get('kind'), query.get('anchor'));
    const now = new Date();
    if (!period || period.from > colombianDay.format(now)) {
      return sendJson(response, 400, { error: 'Elige una semana o un mes con una fecha válida.' });
    }
    return sendJson(response, 200, readAccounting(database, period, now));
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

  if (path.startsWith('/api/')) {
    return sendJson(response, 404, { code: 'API_ROUTE_NOT_FOUND', error: 'La ruta de la aplicación no existe.' });
  }
  if (request.method === 'GET' && path === '/admin') {
    response.writeHead(308, { Location: '/admin/' + new URL(request.url ?? '/', `http://${host}`).search });
    return response.end();
  }
  const body = request.method === 'GET' ? assets.get(path) : undefined;
  if (!body) return sendJson(response, 404, { error: 'Página no encontrada.' });
  response.writeHead(200, {
    'Content-Type': contentTypes[path.endsWith('/') ? '.html' : extname(path)] ?? 'application/octet-stream',
    'Cache-Control': path.endsWith('/') ? 'no-store' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
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
  startAdminSync(database, cash, accounts);
  backups.start();
});
