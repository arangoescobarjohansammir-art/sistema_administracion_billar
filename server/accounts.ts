import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { readJson, sendJson } from './http.js';
import { findProduct, recordInventoryMovement } from './inventory.js';
import { activeShiftId } from './cash-ledger.js';

const tokenValue = 3000;
const maxMoney = 1_000_000_000;

type Payment = { cash: number; transfer: number; tokens: number };
type SaleItem = { productId: number; quantity: number; unitPrice: number };

export function whole(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function paymentFields(value: unknown): Payment | null {
  const { cash, transfer, tokens } = record(value) ?? {};
  if (!whole(cash, 0, maxMoney) || !whole(transfer, 0, maxMoney) || !whole(tokens, 0, Math.floor(maxMoney / tokenValue))) return null;
  const payment = { cash, transfer, tokens };
  return paymentTotal(payment) <= maxMoney ? payment : null;
}

export function paymentTotal(payment: Payment) {
  return payment.cash + payment.transfer + payment.tokens * tokenValue;
}

export function saleItems(value: unknown): SaleItem[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return null;
  const products = new Set<number>();
  const items: SaleItem[] = [];
  for (const valueItem of value) {
    const { productId, quantity, unitPrice } = record(valueItem) ?? {};
    if (!whole(productId, 1, Number.MAX_SAFE_INTEGER) ||
      !whole(quantity, 1, 1_000_000) || !whole(unitPrice, 0, maxMoney) || products.has(productId)) return null;
    products.add(productId);
    items.push({ productId, quantity, unitPrice });
  }
  return items;
}

export class ValidationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function createAccounts(database: DatabaseSync) {
  database.exec([
    'CREATE TABLE IF NOT EXISTS customer_accounts (',
    '  id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS sales (',
    '  id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES customer_accounts(id),',
    '  total INTEGER NOT NULL CHECK (total >= 0), created_at TEXT NOT NULL',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS sale_items (',
    '  id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id),',
    '  product_id INTEGER NOT NULL REFERENCES products(id), label TEXT NOT NULL,',
    '  quantity INTEGER NOT NULL CHECK (quantity > 0), unit_price INTEGER NOT NULL CHECK (unit_price >= 0),',
    '  movement_id INTEGER NOT NULL UNIQUE REFERENCES inventory_movements(id)',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS sale_allocated_lines (',
    '  id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id),',
    '  label TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0)',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS account_payments (',
    '  id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES customer_accounts(id),',
    '  sale_id INTEGER UNIQUE REFERENCES sales(id),',
    '  cash INTEGER NOT NULL CHECK (cash >= 0), transfer INTEGER NOT NULL CHECK (transfer >= 0),',
    '  tokens INTEGER NOT NULL CHECK (tokens >= 0), token_value INTEGER NOT NULL CHECK (token_value > 0),',
    '  created_at TEXT NOT NULL, CHECK (account_id IS NOT NULL OR sale_id IS NOT NULL),',
    '  CHECK (cash + transfer + tokens * token_value > 0)',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS account_operations (',
    '  request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_id INTEGER NOT NULL',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS sales_by_account ON sales(account_id, id);',
    'CREATE INDEX IF NOT EXISTS items_by_sale ON sale_items(sale_id, id);',
    'CREATE INDEX IF NOT EXISTS allocated_lines_by_sale ON sale_allocated_lines(sale_id, id);',
    'CREATE INDEX IF NOT EXISTS payments_by_account ON account_payments(account_id, id);',
  ].join('\n'));

  const accountsSelect = [
    'SELECT a.id, a.name, a.created_at AS createdAt,',
    'COALESCE((SELECT SUM(total) FROM sales WHERE account_id = a.id), 0) -',
    'COALESCE((SELECT SUM(cash + transfer + tokens * token_value) FROM account_payments WHERE account_id = a.id), 0) AS balance',
    'FROM customer_accounts a',
  ].join(' ');

  function accountById(id: number) {
    const account = database.prepare(accountsSelect + ' WHERE a.id = ?').get(id);
    if (!account) throw new ValidationError(404, 'Cuenta no encontrada.');
    return account;
  }

  function writeOnce(requestId: unknown, fingerprint: string, write: () => number) {
    if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      throw new ValidationError(400, 'Identificador de operación inválido.');
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      const previous = database.prepare('SELECT fingerprint, result_id AS id FROM account_operations WHERE request_id = ?').get(requestId);
      if (previous && previous.fingerprint !== fingerprint) {
        throw new ValidationError(409, 'Este identificador pertenece a otra operación.');
      }
      const id = previous ? Number(previous.id) : write();
      if (!previous) {
        database.prepare('INSERT INTO account_operations VALUES (?, ?, ?)').run(requestId, fingerprint, id);
      }
      database.exec('COMMIT');
      return { id, repeated: Boolean(previous) };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  function requireShift() {
    if (activeShiftId(database) === null) throw new ValidationError(409, 'Abre un turno en Caja antes de registrar esta operación.');
  }

  function insertPayment(accountId: number | null, saleId: number | null, payment: Payment, createdAt: string) {
    requireShift();
    return Number(database.prepare(
      'INSERT INTO account_payments (account_id, sale_id, cash, transfer, tokens, token_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(accountId, saleId, payment.cash, payment.transfer, payment.tokens, tokenValue, createdAt).lastInsertRowid);
  }

  function insertSale(accountId: number | null, total: number, createdAt: string) {
    requireShift();
    return Number(database.prepare('INSERT INTO sales (account_id, total, created_at) VALUES (?, ?, ?)')
      .run(accountId, total, createdAt).lastInsertRowid);
  }

  function insertAllocatedLine(saleId: number, label: string, amount: number) {
    database.prepare('INSERT INTO sale_allocated_lines (sale_id, label, amount) VALUES (?, ?, ?)').run(saleId, label, amount);
  }

  async function registerSale(request: IncomingMessage, response: ServerResponse) {
    const input = await readJson(request, 12_000);
    const account = input?.accountId;
    const items = saleItems(input?.items);
    const payment = paymentFields(input?.payment);
    if ((account !== null && !whole(account, 1, Number.MAX_SAFE_INTEGER)) || !items || !payment) {
      throw new ValidationError(400, 'Revisa los productos, las cantidades y los medios de pago.');
    }
    const accountId = account as number | null;
    const total = items.reduce((amount, item) => amount + item.quantity * item.unitPrice, 0);
    const paid = paymentTotal(payment);
    if (total > maxMoney || paid > total) throw new ValidationError(400, 'El pago supera el total o el importe es demasiado alto.');
    if (accountId === null && paid !== total) throw new ValidationError(400, 'Selecciona una cuenta por nombre para dejar saldo pendiente.');

    const result = writeOnce(input?.requestId, JSON.stringify(['sale', accountId, items, payment]), () => {
      if (accountId !== null) accountById(accountId);
      const delivered = items.map((item) => {
        const product = findProduct(database, item.productId);
        if (!product?.active) throw new ValidationError(409, 'Uno de los productos ya no está disponible.');
        const label = [product.name, product.brand, product.presentation].filter(Boolean).join(' · ');
        if (Number(product.stock) < item.quantity) throw new ValidationError(409, 'Existencias insuficientes para ' + label + '.');
        if (product.price !== item.unitPrice) throw new ValidationError(409, 'Cambió el precio de ' + label + '. Recarga el catálogo antes de confirmar.');
        return { ...item, label };
      });
      const createdAt = new Date().toISOString();
      const saleId = insertSale(accountId, total, createdAt);
      for (const item of delivered) {
        const movementId = recordInventoryMovement(database, {
          productId: item.productId, units: -item.quantity, quantity: item.quantity,
          reason: 'Venta #' + saleId, createdAt, inputUnit: 'unidad', unitsPerInput: 1,
        });
        database.prepare(
          'INSERT INTO sale_items (sale_id, product_id, label, quantity, unit_price, movement_id) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(saleId, item.productId, item.label, item.quantity, item.unitPrice, movementId);
      }
      if (paid) insertPayment(accountId, saleId, payment, createdAt);
      return saleId;
    });
    return sendJson(response, result.repeated ? 200 : 201, result);
  }

  async function payAccount(request: IncomingMessage, response: ServerResponse, id: number) {
    const input = await readJson(request);
    const payment = paymentFields(input?.payment);
    if (!payment || paymentTotal(payment) === 0) throw new ValidationError(400, 'Registra un importe positivo.');
    const result = writeOnce(input?.requestId, JSON.stringify(['payment', id, payment]), () => {
      if (paymentTotal(payment) > Number(accountById(id).balance)) {
        throw new ValidationError(409, 'El abono supera el saldo pendiente.');
      }
      return insertPayment(id, null, payment, new Date().toISOString());
    });
    return sendJson(response, result.repeated ? 200 : 201, result);
  }

  function getSales(accountId: number | null) {
    const filter = accountId === null ? ' WHERE account_id IS NULL ORDER BY id DESC LIMIT 30' : ' WHERE account_id = ? ORDER BY id DESC';
    const sales = database.prepare('SELECT id, total, created_at AS createdAt FROM sales' + filter)
      .all(...(accountId === null ? [] : [accountId]));
    const items = database.prepare('SELECT label, quantity, unit_price AS unitPrice FROM sale_items WHERE sale_id = ? ORDER BY id');
    const allocations = database.prepare('SELECT label, 1 AS quantity, amount AS unitPrice FROM sale_allocated_lines WHERE sale_id = ? ORDER BY id');
    return sales.map((sale) => ({
      id: Number(sale.id),
      total: Number(sale.total),
      createdAt: String(sale.createdAt),
      items: [...items.all(Number(sale.id)), ...allocations.all(Number(sale.id))],
    }));
  }

  const paymentsSelect = 'SELECT id, sale_id AS saleId, cash, transfer, tokens, token_value AS tokenValue, created_at AS createdAt FROM account_payments';

  async function handle(request: IncomingMessage, response: ServerResponse, path: string) {
    try {
      if (path === '/api/sales' && request.method === 'POST') return await registerSale(request, response);
      if (path === '/api/sales' && request.method === 'GET') {
        const sales = getSales(null);
        const paymentBySale = database.prepare(paymentsSelect + ' WHERE sale_id = ?');
        return sendJson(response, 200, sales.map((sale) => ({ ...sale, payment: paymentBySale.get(Number(sale.id)) ?? null })));
      }
      if (path === '/api/accounts' && request.method === 'GET') {
        return sendJson(response, 200, database.prepare(accountsSelect + ' ORDER BY balance DESC, name COLLATE NOCASE, id').all());
      }
      if (path === '/api/accounts' && request.method === 'POST') {
        const input = await readJson(request);
        const name = typeof input?.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
        if (!name || name.length > 100) throw new ValidationError(400, 'Escribe un nombre o apodo de hasta 100 caracteres.');
        const key = name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es');
        const result = database.prepare(
          'INSERT INTO customer_accounts (name, name_key, created_at) VALUES (?, ?, ?) ON CONFLICT(name_key) DO NOTHING',
        ).run(name, key, new Date().toISOString());
        if (!result.changes) throw new ValidationError(409, 'Ya existe una cuenta con ese nombre. Busca la cuenta o usa un apodo distinto.');
        return sendJson(response, 201, accountById(Number(result.lastInsertRowid)));
      }
      const match = /^\/api\/accounts\/([1-9]\d*)(\/payments)?$/.exec(path);
      if (!match || !Number.isSafeInteger(Number(match[1]))) throw new ValidationError(404, 'Ruta de cuentas no encontrada.');
      const id = Number(match[1]);
      if (match[2] && request.method === 'POST') return await payAccount(request, response, id);
      if (!match[2] && request.method === 'GET') {
        return sendJson(response, 200, {
          account: accountById(id),
          sales: getSales(id),
          payments: database.prepare(paymentsSelect + ' WHERE account_id = ? ORDER BY id DESC').all(id),
        });
      }
      return sendJson(response, 405, { error: 'Método no permitido.' });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return sendJson(response, error.status, { error: error.message });
    }
  }
  return { handle, accountById, writeOnce, insertSale, insertPayment, insertAllocatedLine, requireShift };
}
