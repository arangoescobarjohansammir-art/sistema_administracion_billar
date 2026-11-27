import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { billiardRate, billiardTables, durationLabel, elapsedSeconds, roundedTimeCharge, timeCharge } from '../shared/billiard.js';
import { type createAccounts, paymentFields, paymentTotal, record, ValidationError, whole } from './accounts.js';
import { readJson, sendJson } from './http.js';
import { findProduct, recordInventoryMovement } from './inventory.js';

type Accounts = ReturnType<typeof createAccounts>;
type BilliardItem = {
  id: number; productId: number; label: string; quantity: number; unitPrice: number;
};
type Participant = {
  accountId: number | null;
  time: number;
  items: { id: number; amount: number }[];
  payment: NonNullable<ReturnType<typeof paymentFields>>;
};

const chargeLimit = 1_000_000_000;

function readParticipants(value: unknown): Participant[] {
  if (!Array.isArray(value) || value.length > 20) throw new ValidationError(400, 'Puedes repartir la cuenta entre hasta 20 personas.');
  return value.map((entry) => {
    const { accountId, time, items, payment } = record(entry) ?? {};
    const methods = paymentFields(payment);
    if ((accountId !== null && !whole(accountId, 1, Number.MAX_SAFE_INTEGER)) ||
      !whole(time, 0, chargeLimit) || !Array.isArray(items) || items.length > 50 || !methods) {
      throw new ValidationError(400, 'Revisa las partes y los medios de pago.');
    }
    const seen = new Set<number>();
    const lines = items.map((item) => {
      const { id, amount } = record(item) ?? {};
      if (!whole(id, 1, Number.MAX_SAFE_INTEGER) || !whole(amount, 1, chargeLimit) || seen.has(id)) {
        throw new ValidationError(400, 'Revisa la distribución de los consumos.');
      }
      seen.add(id);
      return { id, amount };
    });
    return { accountId, time, items: lines, payment: methods };
  });
}

export function createBilliards(database: DatabaseSync, accounts: Accounts) {
  database.exec([
    'CREATE TABLE IF NOT EXISTS billiard_sessions (',
    '  id INTEGER PRIMARY KEY, table_number INTEGER NOT NULL CHECK (table_number BETWEEN 1 AND 6),',
    '  rate INTEGER NOT NULL CHECK (rate > 0), started_at INTEGER NOT NULL,',
    '  stopped_at INTEGER, closed_at INTEGER,',
    '  CHECK (stopped_at IS NULL OR stopped_at >= started_at),',
    '  CHECK (closed_at IS NULL OR (stopped_at IS NOT NULL AND closed_at >= stopped_at))',
    ') STRICT;',
    'CREATE UNIQUE INDEX IF NOT EXISTS billiard_occupied_tables ON billiard_sessions(table_number) WHERE closed_at IS NULL;',
    'CREATE TABLE IF NOT EXISTS billiard_items (',
    '  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES billiard_sessions(id),',
    '  product_id INTEGER NOT NULL REFERENCES products(id), label TEXT NOT NULL,',
    '  quantity INTEGER NOT NULL CHECK (quantity > 0), unit_price INTEGER NOT NULL CHECK (unit_price >= 0),',
    '  movement_id INTEGER NOT NULL UNIQUE REFERENCES inventory_movements(id)',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS billiard_items_by_session ON billiard_items(session_id, id);',
    'CREATE TABLE IF NOT EXISTS billiard_shares (',
    '  session_id INTEGER NOT NULL REFERENCES billiard_sessions(id), sale_id INTEGER NOT NULL UNIQUE REFERENCES sales(id),',
    '  PRIMARY KEY (session_id, sale_id)',
    ') STRICT;',
  ].join('\n'));

  const columns = new Set(database.prepare('PRAGMA table_info(billiard_sessions)').all().map(({ name }) => name));
  if (!columns.has('canceled_at')) {
    database.exec('ALTER TABLE billiard_sessions ADD COLUMN canceled_at INTEGER');
  }
  if (!columns.has('paused_ms')) {
    database.exec('ALTER TABLE billiard_sessions ADD COLUMN paused_ms INTEGER NOT NULL DEFAULT 0 CHECK (paused_ms >= 0)');
  }
  if (!columns.has('settled_time')) {
    database.exec('ALTER TABLE billiard_sessions ADD COLUMN settled_time INTEGER CHECK (settled_time >= 0)');
  }
  const sessions = [
    'SELECT id, table_number AS tableNumber, rate, started_at AS startedAt, stopped_at AS stoppedAt,',
    'closed_at AS closedAt, canceled_at AS canceledAt, paused_ms AS pausedMs, settled_time AS settledTime FROM billiard_sessions',
  ].join(' ');

  function sessionItems(id: number): BilliardItem[] {
    return database.prepare(
      'SELECT id, product_id AS productId, label, quantity, unit_price AS unitPrice FROM billiard_items WHERE session_id = ? ORDER BY id',
    ).all(id).map((row) => ({
      id: Number(row.id), productId: Number(row.productId), label: String(row.label),
      quantity: Number(row.quantity), unitPrice: Number(row.unitPrice),
    }));
  }

  function openSession(id: number) {
    const session = database.prepare(sessions + ' WHERE id = ? AND closed_at IS NULL').get(id);
    if (!session) throw new ValidationError(409, 'La cuenta de esta mesa ya no está abierta.');
    return session;
  }

  function describe(session: Record<string, unknown>, now: number) {
    const seconds = elapsedSeconds(Number(session.startedAt), Number(session.stoppedAt ?? now), Number(session.pausedMs));
    const items = sessionItems(Number(session.id));
    const rate = Number(session.rate);
    let time = timeCharge(seconds, rate);
    if (session.canceledAt !== null) time = 0;
    else if (session.closedAt !== null) time = Number(session.settledTime ?? time);
    else if (session.stoppedAt !== null) time = roundedTimeCharge(seconds, rate);
    return { ...session, seconds, time, total: time + items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0), items };
  }

  function startTable(table: unknown) {
    if (!whole(table, 1, billiardTables)) throw new ValidationError(400, 'Selecciona una de las seis mesas.');
    if (database.prepare('SELECT id FROM billiard_sessions WHERE table_number = ? AND closed_at IS NULL').get(table)) {
      throw new ValidationError(409, 'Esta mesa ya tiene una cuenta abierta.');
    }
    return Number(database.prepare('INSERT INTO billiard_sessions (table_number, rate, started_at) VALUES (?, ?, ?)')
      .run(table, billiardRate, Date.now()).lastInsertRowid);
  }

  function stopTable(id: number) {
    const session = openSession(id);
    if (session.stoppedAt !== null) throw new ValidationError(409, 'El cronómetro ya está detenido.');
    database.prepare('UPDATE billiard_sessions SET stopped_at = ? WHERE id = ?')
      .run(Math.max(Date.now(), Number(session.startedAt)), id);
    return id;
  }

  function resumeTable(id: number) {
    const session = openSession(id);
    if (session.stoppedAt === null) throw new ValidationError(409, 'El cronómetro ya está en marcha.');
    const pausedMs = Math.max(0, Date.now() - Number(session.stoppedAt));
    database.prepare('UPDATE billiard_sessions SET paused_ms = paused_ms + ?, stopped_at = NULL WHERE id = ?')
      .run(pausedMs, id);
    return id;
  }

  function cancelTable(id: number) {
    const session = openSession(id);
    if (sessionItems(id).length) throw new ValidationError(409, 'La mesa tiene productos entregados. Debe liquidarse para conservar los consumos.');
    const now = Math.max(Date.now(), Number(session.stoppedAt ?? session.startedAt));
    database.prepare('UPDATE billiard_sessions SET stopped_at = COALESCE(stopped_at, ?), closed_at = ?, canceled_at = ? WHERE id = ?')
      .run(now, now, now, id);
    return id;
  }

  function deliver(id: number, productId: unknown, quantity: unknown, unitPrice: unknown) {
    const session = openSession(id);
    if (!whole(productId, 1, Number.MAX_SAFE_INTEGER) || !whole(quantity, 1, 1_000_000) || !whole(unitPrice, 0, chargeLimit)) {
      throw new ValidationError(400, 'Revisa el producto, el precio y la cantidad.');
    }
    const product = findProduct(database, productId);
    if (!product?.active) throw new ValidationError(409, 'El producto ya no está disponible.');
    const label = [product.name, product.brand, product.presentation].filter(Boolean).join(' · ');
    if (Number(product.stock) < quantity) throw new ValidationError(409, 'Existencias insuficientes para ' + label + '.');
    if (product.price !== unitPrice) throw new ValidationError(409, 'Cambió el precio de ' + label + '. Actualiza los datos antes de registrar.');
    const items = sessionItems(id);
    if (items.length >= 50 || items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0) + quantity * unitPrice > chargeLimit) {
      throw new ValidationError(409, 'La mesa alcanzó el límite de consumos de una cuenta.');
    }
    const movementId = recordInventoryMovement(database, {
      productId, units: -quantity, quantity, inputUnit: 'unidad', unitsPerInput: 1,
      reason: 'Billar · mesa ' + session.tableNumber + ' · sesión #' + id,
      createdAt: new Date().toISOString(),
    });
    database.prepare(
      'INSERT INTO billiard_items (session_id, product_id, label, quantity, unit_price, movement_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, productId, label, quantity, unitPrice, movementId);
    return id;
  }

  function closeTable(id: number, participants: Participant[]) {
    const session = openSession(id);
    if (session.stoppedAt === null) throw new ValidationError(409, 'Detén el cronómetro antes de liquidar la mesa.');
    const details = describe(session, Date.now());
    const remaining = new Map(details.items.map((item) => [item.id, item.quantity * item.unitPrice]));
    const productLines = new Map(details.items.map((item) => [item.id, item]));
    let unassignedTime = details.time;
    const named = new Set<number>();
    for (const participant of participants) {
      if (participant.accountId !== null) {
        if (named.has(participant.accountId)) throw new ValidationError(400, 'Agrupa los importes de una persona en una sola parte.');
        named.add(participant.accountId);
        accounts.accountById(participant.accountId);
      }
      unassignedTime -= participant.time;
      let total = participant.time;
      for (const item of participant.items) {
        const available = remaining.get(item.id);
        if (available === undefined || item.amount > available) throw new ValidationError(400, 'Un consumo quedó repartido por encima de su valor.');
        remaining.set(item.id, available - item.amount);
        total += item.amount;
      }
      const paid = paymentTotal(participant.payment);
      if (!total || total > chargeLimit || paid > total || (participant.accountId === null && paid !== total)) {
        throw new ValidationError(400, 'Cada parte debe tener un importe válido. Selecciona una cuenta por nombre para dejar un saldo fiado.');
      }
    }
    if (unassignedTime !== 0 || [...remaining.values()].some((value) => value !== 0)) {
      throw new ValidationError(400, 'El reparto debe coincidir con el tiempo y con cada consumo de la mesa.');
    }

    const closedAt = Math.max(Date.now(), Number(session.stoppedAt));
    const createdAt = new Date(closedAt).toISOString();
    const heading = 'Billar · mesa ' + session.tableNumber;
    const linkSale = database.prepare('INSERT INTO billiard_shares (session_id, sale_id) VALUES (?, ?)');
    for (const participant of participants) {
      const total = participant.time + participant.items.reduce((sum, item) => sum + item.amount, 0);
      const saleId = accounts.insertSale(participant.accountId, total, createdAt);
      linkSale.run(id, saleId);
      if (participant.time) accounts.insertAllocatedLine(saleId, heading + ' · tiempo ' + durationLabel(details.seconds), participant.time);
      for (const item of participant.items) {
        accounts.insertAllocatedLine(saleId, heading + ' · ' + productLines.get(item.id)!.label, item.amount);
      }
      if (paymentTotal(participant.payment) > 0) accounts.insertPayment(participant.accountId, saleId, participant.payment, createdAt);
    }
    database.prepare('UPDATE billiard_sessions SET closed_at = ?, settled_time = ? WHERE id = ?')
      .run(closedAt, details.time, id);
    return id;
  }

  return async function handle(request: IncomingMessage, response: ServerResponse, path: string) {
    try {
      if (path === '/api/billiards' && request.method === 'GET') {
        const now = Date.now();
        const active = database.prepare(sessions + ' WHERE closed_at IS NULL ORDER BY table_number').all();
        const recent = database.prepare(sessions + ' WHERE closed_at IS NOT NULL ORDER BY closed_at DESC, id DESC LIMIT 10').all();
        const shares = database.prepare([
          'SELECT sales.id AS saleId, customer_accounts.name, sales.total',
          'FROM billiard_shares JOIN sales ON sales.id = billiard_shares.sale_id',
          'LEFT JOIN customer_accounts ON customer_accounts.id = sales.account_id',
          'WHERE session_id = ? ORDER BY saleId',
        ].join(' '));
        return sendJson(response, 200, {
          now, rate: billiardRate,
          active: active.map((session) => describe(session, now)),
          recent: recent.map((session) => ({ ...describe(session, now), shares: shares.all(Number(session.id)) })),
        });
      }
      if (request.method !== 'POST') throw new ValidationError(405, 'Método no permitido.');
      const input = await readJson(request, 65_536);
      if (!input) throw new ValidationError(400, 'No se recibió una operación válida.');
      let action: () => number;
      let fingerprint: unknown;
      if (path === '/api/billiards') {
        fingerprint = input.table;
        action = () => startTable(input.table);
      } else {
        const match = /^\/api\/billiards\/([1-9]\d*)\/(stop|resume|items|close|cancel)$/.exec(path);
        if (!match || !Number.isSafeInteger(Number(match[1]))) throw new ValidationError(404, 'Ruta de billar no encontrada.');
        const id = Number(match[1]);
        if (match[2] === 'stop' || match[2] === 'resume' || match[2] === 'cancel') {
          const operations = { stop: stopTable, resume: resumeTable, cancel: cancelTable };
          const operation = operations[match[2]];
          action = () => operation(id);
          fingerprint = null;
        } else if (match[2] === 'items') {
          const { productId, quantity, unitPrice } = input;
          fingerprint = [productId, quantity, unitPrice];
          action = () => deliver(id, productId, quantity, unitPrice);
        } else {
          const participants = readParticipants(input.participants);
          fingerprint = participants;
          action = () => closeTable(id, participants);
        }
      }
      const result = accounts.writeOnce(input.requestId, JSON.stringify([path, fingerprint]), action);
      return sendJson(response, result.repeated ? 200 : 201, result);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return sendJson(response, error.status, { error: error.message });
    }
  };
}
