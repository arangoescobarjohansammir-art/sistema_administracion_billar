import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { Operator } from '../shared/operators.js';
import { ValidationError } from './accounts.js';
import { readJson, sendJson } from './http.js';

const cookieName = 'caja_sesion';
const sessionSeconds = 12 * 60 * 60;
const attemptsLimit = 5;
const lockMs = 30_000;
const attemptsWindowMs = 5 * 60_000;
const operatorsByRequest = new WeakMap<IncomingMessage, Operator>();
export const requestOperator = (request: IncomingMessage) => operatorsByRequest.get(request);

function publicOperator(row: Record<string, SQLOutputValue>): Operator {
  return {
    id: Number(row.id), name: String(row.name), username: String(row.username),
    role: row.role === 'admin' ? 'admin' : 'cashier', active: Boolean(row.active),
  };
}

const normalizedUsername = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validPin = (value: unknown): value is string => typeof value === 'string' && /^\d{6}$/.test(value);
const validPassword = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length >= 10 && value.length <= 100;
const hash = (secret: string, salt: Uint8Array) => scryptSync(secret, salt, 64);

export function createOperators(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS cash_operators (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'cashier')), active INTEGER NOT NULL CHECK (active IN (0, 1)),
      salt BLOB NOT NULL, verifier BLOB NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_local_admin ON cash_operators(role) WHERE role = 'admin';
  `);
  const sessions = new Map<string, { operatorId: number; expiry: number }>();
  const dummySalt = randomBytes(16);
  let failedAttempts = 0;
  let attemptsSince = 0;
  let lockedUntil = 0;

  const hasOwner = () => Boolean(database.prepare("SELECT id FROM cash_operators WHERE role = 'admin'").get());
  const tokenFor = (request: IncomingMessage) => request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);

  function sessionFor(request: IncomingMessage) {
    const token = tokenFor(request);
    const session = token && sessions.get(token);
    if (!token || !session) return null;
    const operator = session.expiry > Date.now()
      ? database.prepare('SELECT id, name, username, role, active FROM cash_operators WHERE id = ? AND active = 1').get(session.operatorId)
      : undefined;
    if (!operator) {
      sessions.delete(token);
      return null;
    }
    const safe = publicOperator(operator);
    operatorsByRequest.set(request, safe);
    return safe;
  }

  function removeSessions(operatorId: number) {
    for (const [token, session] of sessions) if (session.operatorId === operatorId) sessions.delete(token);
  }

  function issueSession(request: IncomingMessage, response: ServerResponse, status: number, operator: Operator) {
    const previous = tokenFor(request);
    if (previous) sessions.delete(previous);
    const now = Date.now();
    for (const [token, session] of sessions) if (session.expiry <= now) sessions.delete(token);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { operatorId: operator.id, expiry: now + sessionSeconds * 1000 });
    response.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionSeconds}`);
    return sendJson(response, status, { setupNeeded: false, operator });
  }

  function addOperator(input: Record<string, unknown> | null, role: Operator['role']) {
    const name = typeof input?.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    const username = normalizedUsername(input?.username);
    const validSecret = role === 'admin' ? validPassword : validPin;
    if (name.length < 2 || name.length > 80 || !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username) || !validSecret(input?.secret)) {
      throw new ValidationError(400, role === 'admin'
        ? 'Indica el nombre, un usuario válido y una contraseña de 10 a 100 caracteres.'
        : 'Indica el nombre, un usuario válido y un PIN de seis dígitos.');
    }
    const salt = randomBytes(16);
    const result = database.prepare(`
      INSERT INTO cash_operators (name, username, role, active, salt, verifier)
      VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(username) DO NOTHING
    `).run(name, username, role, salt, hash(input.secret, salt));
    if (!result.changes) throw new ValidationError(409, 'Ese nombre de usuario ya existe.');
    return { id: Number(result.lastInsertRowid), name, username, role, active: true } satisfies Operator;
  }

  async function handle(request: IncomingMessage, response: ServerResponse, path: string) {
    try {
      if (path === '/api/session' && request.method === 'GET') {
        return sendJson(response, 200, { setupNeeded: !hasOwner(), setupCodeRequired: !hasOwner() && Boolean(process.env.CAJA_SETUP_CODE),
          operator: sessionFor(request) });
      }
      if (path === '/api/session/setup' && request.method === 'POST') {
        const input = await readJson(request);
        if (hasOwner()) throw new ValidationError(409, 'La caja ya tiene un administrador.');
        const setupCode = process.env.CAJA_SETUP_CODE;
        if (setupCode && input?.setupCode !== setupCode) throw new ValidationError(403, 'El código de configuración no coincide.');
        return issueSession(request, response, 201, addOperator(input, 'admin'));
      }
      if (path === '/api/session/login' && request.method === 'POST') {
        const input = await readJson(request);
        const now = Date.now();
        if (lockedUntil > now) throw new ValidationError(429, 'Espera 30 segundos y vuelve a intentar.');
        if (now - attemptsSince > attemptsWindowMs) failedAttempts = 0;
        if (failedAttempts === 0) attemptsSince = now;
        const secret = typeof input?.secret === 'string' && input.secret.length <= 100 ? input.secret : '';
        const row = database.prepare('SELECT * FROM cash_operators WHERE username = ? AND active = 1').get(normalizedUsername(input?.username));
        const derived = hash(secret, row?.salt instanceof Uint8Array ? row.salt : dummySalt);
        if (!(row?.verifier instanceof Uint8Array) || !timingSafeEqual(derived, row.verifier)) {
          if (++failedAttempts >= attemptsLimit) { lockedUntil = now + lockMs; failedAttempts = 0; }
          throw new ValidationError(401, 'Usuario, contraseña o PIN incorrectos.');
        }
        failedAttempts = 0;
        return issueSession(request, response, 200, publicOperator(row));
      }
      if (path === '/api/session/logout' && request.method === 'POST') {
        const token = tokenFor(request);
        if (token) sessions.delete(token);
        response.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
        return sendJson(response, 200, { setupNeeded: !hasOwner(), operator: null });
      }
      if (sessionFor(request)?.role !== 'admin') throw new ValidationError(403, 'Esta función es para el administrador.');
      if (path === '/api/operators' && request.method === 'GET') {
        const rows = database.prepare('SELECT id, name, username, role, active FROM cash_operators ORDER BY id').all();
        return sendJson(response, 200, rows.map(publicOperator));
      }
      if (path === '/api/operators' && request.method === 'POST') {
        return sendJson(response, 201, addOperator(await readJson(request), 'cashier'));
      }
      const match = /^\/api\/operators\/([1-9]\d*)$/.exec(path);
      if (match && request.method === 'POST') {
        const input = await readJson(request);
        const id = Number(match[1]);
        const user = database.prepare("SELECT id FROM cash_operators WHERE id = ? AND role = 'cashier'").get(id);
        if (!user) throw new ValidationError(404, 'Usuario de caja no encontrado.');
        if (typeof input?.active === 'boolean') {
          database.prepare('UPDATE cash_operators SET active = ? WHERE id = ?').run(Number(input.active), id);
        } else if (validPin(input?.secret)) {
          const salt = randomBytes(16);
          database.prepare('UPDATE cash_operators SET salt = ?, verifier = ? WHERE id = ?').run(salt, hash(input.secret, salt), id);
        } else {
          throw new ValidationError(400, 'Escribe un PIN de seis dígitos o elige el estado de la cuenta.');
        }
        removeSessions(id);
        return sendJson(response, 200, { id });
      }
      return sendJson(response, 404, { error: 'Ruta de usuarios no encontrada.' });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return sendJson(response, error.status, { error: error.message });
    }
  }

  return { sessionFor, handle };
}
