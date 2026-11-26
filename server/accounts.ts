import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { readJson, sendJson } from './http.js';
import { findProduct, recordInventoryMovement } from './inventory.js';
import { activeShiftId } from './cash-ledger.js';
import type { Audit } from './audit.js';
import { createAccountHistory } from './account-history.js';

import { accountTokenValue as tokenValue } from '../shared/tender.js';
const maxMoney = 1_000_000_000;
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Payment = { cash: number; transfer: number; tokens: number };
type SaleItem = { productId: number; quantity: number; unitPrice: number };
type CreditShare = { accountId: number; amount: number };

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

export function creditShares(value: unknown, owner: number | null, remaining: number): CreditShare[] {
  if (value === undefined) return [];
  if (owner !== null || !Array.isArray(value) || value.length < 2) {
    throw new ValidationError(400, 'Elige al menos dos cuentas para repartir el saldo fiado.');
  }
  const shares = value.map((entry) => {
    const { accountId, amount } = record(entry) ?? {};
    if (!whole(accountId, 1, Number.MAX_SAFE_INTEGER) || !whole(amount, 1, maxMoney)) {
      throw new ValidationError(400, 'Indica la cuenta y el importe positivo de cada parte.');
    }
    return { accountId, amount };
  });
  if (new Set(shares.map((part) => part.accountId)).size !== shares.length ||
    shares.reduce((sum, part) => sum + part.amount, 0) !== remaining) {
    throw new ValidationError(400, 'Usa cuentas distintas. Sus importes deben sumar el saldo por fiar.');
  }
  return shares;
}

export function createAccounts(database: DatabaseSync, audit?: Audit) {
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
    'CREATE TABLE IF NOT EXISTS sale_voids (',
    '  sale_id INTEGER PRIMARY KEY REFERENCES sales(id), created_at TEXT NOT NULL, reason TEXT NOT NULL,',
    '  stock_returned INTEGER NOT NULL CHECK (stock_returned IN (0, 1))',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS account_payment_voids (',
    '  payment_id INTEGER PRIMARY KEY REFERENCES account_payments(id),',
    '  created_at TEXT NOT NULL, reason TEXT NOT NULL',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS sale_credit_shares (',
    '  sale_id INTEGER NOT NULL REFERENCES sales(id),',
    '  share_sale_id INTEGER PRIMARY KEY REFERENCES sales(id)',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS credit_shares_by_sale ON sale_credit_shares(sale_id);',
    'CREATE VIEW IF NOT EXISTS valid_sales AS SELECT * FROM sales WHERE id NOT IN (SELECT sale_id FROM sale_voids);',
    'CREATE INDEX IF NOT EXISTS sales_by_account ON sales(account_id, id);',
    'CREATE INDEX IF NOT EXISTS sales_by_date ON sales(created_at);',
    'CREATE INDEX IF NOT EXISTS items_by_sale ON sale_items(sale_id, id);',
    'CREATE INDEX IF NOT EXISTS allocated_lines_by_sale ON sale_allocated_lines(sale_id, id);',
    'CREATE INDEX IF NOT EXISTS payments_by_account ON account_payments(account_id, id);',
    'CREATE INDEX IF NOT EXISTS payments_by_date ON account_payments(created_at);',
  ].join('\n'));
  const paymentsView = database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'valid_account_payments' AND type = 'view'").get();
  if (!String(paymentsView?.sql ?? '').includes('account_payment_voids')) {
    database.exec(`
      BEGIN IMMEDIATE;
      DROP VIEW IF EXISTS valid_account_payments;
      CREATE VIEW valid_account_payments AS SELECT * FROM account_payments
      WHERE (sale_id IS NULL OR sale_id NOT IN (SELECT sale_id FROM sale_voids))
        AND id NOT IN (SELECT payment_id FROM account_payment_voids);
      COMMIT;
    `);
  }
  const historyFor = createAccountHistory(database);

  const accountsSelect = [
    'SELECT a.id, a.name, a.created_at AS createdAt,',
    'COALESCE((SELECT SUM(total) FROM valid_sales WHERE account_id = a.id), 0) -',
    'COALESCE((SELECT SUM(cash + transfer + tokens * token_value) FROM valid_account_payments WHERE account_id = a.id), 0) AS balance',
    'FROM customer_accounts a',
  ].join(' ');

  function openBalances() {
    return database.prepare('SELECT id, name, balance FROM (' + accountsSelect + ') WHERE balance > 0 ORDER BY balance DESC, id')
      .all().map((row) => ({ id: Number(row.id), name: String(row.name), balance: Number(row.balance) }));
  }

  function accountById(id: number) {
    const account = database.prepare(accountsSelect + ' WHERE a.id = ?').get(id);
    if (!account) throw new ValidationError(404, 'Cuenta no encontrada.');
    return account;
  }

  function accountForName(value: unknown, reuse: boolean) {
    const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 100) throw new ValidationError(400, 'Escribe un nombre o apodo de hasta 100 caracteres.');
    const key = name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es');
    const result = database.prepare(
      'INSERT INTO customer_accounts (name, name_key, created_at) VALUES (?, ?, ?) ON CONFLICT(name_key) DO NOTHING',
    ).run(name, key, new Date().toISOString());
    if (result.changes) return accountById(Number(result.lastInsertRowid));
    if (!reuse) throw new ValidationError(409, 'Ya existe una cuenta con ese nombre. Busca la cuenta o usa un apodo distinto.');
    const account = database.prepare('SELECT id FROM customer_accounts WHERE name_key = ?').get(key);
    return accountById(Number(account?.id));
  }

  function writeOnce(requestId: unknown, fingerprint: string, write: () => number) {
    if (typeof requestId !== 'string' || !requestIdPattern.test(requestId)) {
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

  function recordCreditShares(saleId: number, shares: CreditShare[], products: string, createdAt: string) {
    const link = database.prepare('INSERT INTO sale_credit_shares (sale_id, share_sale_id) VALUES (?, ?)');
    for (const { accountId, amount } of shares) {
      accountById(accountId);
      const shareSaleId = insertSale(accountId, amount, createdAt);
      insertAllocatedLine(shareSaleId, 'Parte fiada · venta #' + saleId + ' · ' + products, amount);
      link.run(saleId, shareSaleId);
    }
  }

  const creditSharesFor = database.prepare(`
    SELECT portion.id AS saleId, portion.account_id AS accountId, customer_accounts.name, portion.total AS amount
    FROM sale_credit_shares share JOIN sales portion ON portion.id = share.share_sale_id
    JOIN customer_accounts ON customer_accounts.id = portion.account_id
    WHERE share.sale_id = ? ORDER BY portion.id
  `);
  function readCreditShares(saleId: number) {
    return creditSharesFor.all(saleId).map((row) => ({
      saleId: Number(row.saleId), accountId: Number(row.accountId), name: String(row.name), amount: Number(row.amount),
    }));
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
    const shares = creditShares(input?.creditShares, accountId, total - paid);
    if (accountId === null && !shares.length && paid !== total) {
      throw new ValidationError(400, 'Selecciona una cuenta por nombre para dejar saldo pendiente.');
    }

    const fingerprint = ['sale', accountId, items, payment, ...(shares.length ? [shares] : [])];
    const result = writeOnce(input?.requestId, JSON.stringify(fingerprint), () => {
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
      const saleId = insertSale(accountId, shares.length ? paid : total, createdAt);
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
      if (shares.length) recordCreditShares(saleId, shares, delivered.map((item) => item.quantity + ' × ' + item.label).join(', '), createdAt);
      audit?.record(request, 'sale', saleId, 'Total: $' + total);
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
      const paymentId = insertPayment(id, null, payment, new Date().toISOString());
      audit?.record(request, 'account_payment', paymentId, 'Abono por $' + paymentTotal(payment));
      return paymentId;
    });
    return sendJson(response, result.repeated ? 200 : 201, result);
  }

  const paymentReceipt = database.prepare(`
    SELECT payment.id FROM account_operations operation
    JOIN account_payments payment ON payment.id = operation.result_id
    WHERE operation.request_id = ? AND json_extract(operation.fingerprint, '$[0]') = 'payment'
      AND payment.account_id = ? AND payment.sale_id IS NULL
  `);

  function getSales(accountId: number | null) {
    const filter = accountId === null ? ' WHERE account_id IS NULL ORDER BY id DESC LIMIT 30' : ' WHERE account_id = ? ORDER BY id DESC';
    const sales = database.prepare('SELECT id, total, created_at AS createdAt, (id IN (SELECT sale_id FROM sale_voids)) AS voided FROM sales' + filter)
      .all(...(accountId === null ? [] : [accountId]));
    const items = database.prepare('SELECT label, quantity, unit_price AS unitPrice FROM sale_items WHERE sale_id = ? ORDER BY id');
    const allocations = database.prepare('SELECT label, 1 AS quantity, amount AS unitPrice FROM sale_allocated_lines WHERE sale_id = ? ORDER BY id');
    return sales.map((sale) => ({
      id: Number(sale.id),
      total: Number(sale.total),
      createdAt: String(sale.createdAt),
      voided: Boolean(sale.voided),
      items: [...items.all(Number(sale.id)), ...allocations.all(Number(sale.id))],
    }));
  }

  const paymentsSelect = 'SELECT id, sale_id AS saleId, cash, transfer, tokens, token_value AS tokenValue, created_at AS createdAt, ' +
    '(id IN (SELECT payment_id FROM account_payment_voids) OR COALESCE(sale_id IN (SELECT sale_id FROM sale_voids), 0)) AS voided ' +
    'FROM account_payments';

  async function handle(request: IncomingMessage, response: ServerResponse, path: string) {
    try {
      if (path === '/api/sales' && request.method === 'POST') return await registerSale(request, response);
      if (path === '/api/sales' && request.method === 'GET') {
        const sales = getSales(null);
        const paymentBySale = database.prepare(paymentsSelect + ' WHERE sale_id = ?');
        return sendJson(response, 200, sales.map((sale) => {
          const shares = readCreditShares(sale.id);
          return { ...sale, total: shares.reduce((sum, part) => sum + part.amount, sale.total),
            payment: paymentBySale.get(sale.id) ?? null, creditShares: shares };
        }));
      }
      if (path === '/api/accounts' && request.method === 'GET') {
        return sendJson(response, 200, database.prepare(accountsSelect + ' ORDER BY balance DESC, name COLLATE NOCASE, id').all());
      }
      if (path === '/api/accounts' && request.method === 'POST') {
        const input = await readJson(request);
        return sendJson(response, 201, accountForName(input?.name, false));
      }
      const match = /^\/api\/accounts\/([1-9]\d*)(\/payments)?$/.exec(path);
      if (!match || !Number.isSafeInteger(Number(match[1]))) throw new ValidationError(404, 'Ruta de cuentas no encontrada.');
      const id = Number(match[1]);
      if (match[2] && request.method === 'POST') return await payAccount(request, response, id);
      if (match[2] && request.method === 'GET') {
        const requestId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('requestId');
        if (!requestId || !requestIdPattern.test(requestId)) throw new ValidationError(400, 'Identificador de operación inválido.');
        return sendJson(response, 200, { id: paymentReceipt.get(requestId, id)?.id ?? null });
      }
      if (!match[2] && request.method === 'GET') {
        return sendJson(response, 200, {
          account: accountById(id),
          sales: getSales(id),
          payments: database.prepare(paymentsSelect + ' WHERE account_id = ? ORDER BY id DESC').all(id),
          history: historyFor(id),
        });
      }
      return sendJson(response, 405, { error: 'Método no permitido.' });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return sendJson(response, error.status, { error: error.message });
    }
  }
  return { handle, accountById, accountForName, writeOnce, insertSale, insertPayment, insertAllocatedLine,
    recordCreditShares, readCreditShares, requireShift, openBalances };
}
