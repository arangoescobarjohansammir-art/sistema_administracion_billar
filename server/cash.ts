import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { cashMovements, expectedCashCounts, type CashMovementKind, type SavedCashCount } from '../shared/cash.js';
import { type createAccounts, record, ValidationError, whole } from './accounts.js';
import { activeShiftId } from './cash-ledger.js';
import { cashReportFilename, renderCashReport } from './cash-report.js';
import { readJson, sendJson } from './http.js';

type Accounts = ReturnType<typeof createAccounts>;
const maxCash = 1_000_000_000;
const maxTokens = 1_000_000;
const readText = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim().length <= max ? value.trim() : null;

export function createCash(database: DatabaseSync, accounts: Accounts, afterClose?: (shiftId: number) => void) {
  database.exec([
    'CREATE TABLE IF NOT EXISTS cash_shifts (',
    '  id INTEGER PRIMARY KEY, cashier TEXT NOT NULL, opened_at TEXT NOT NULL,',
    '  opening_base INTEGER NOT NULL CHECK (opening_base >= 0), previous_base INTEGER, opening_note TEXT NOT NULL,',
    '  closed_at TEXT, sales_counted INTEGER, purchases_counted INTEGER, transfer_confirmed INTEGER,',
    '  next_base INTEGER, closing_note TEXT, sales_expected INTEGER, purchases_expected INTEGER,',
    '  transfer_expected INTEGER, pending_balance INTEGER,',
    '  opening_tokens INTEGER CHECK (opening_tokens >= 0), previous_tokens INTEGER CHECK (previous_tokens >= 0),',
    '  counted_tokens INTEGER CHECK (counted_tokens >= 0), expected_tokens INTEGER, token_opening_note TEXT',
    ') STRICT;',
    'CREATE UNIQUE INDEX IF NOT EXISTS cash_single_open_shift ON cash_shifts((1)) WHERE closed_at IS NULL;',
    'CREATE TABLE IF NOT EXISTS cash_counts (',
    '  id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL REFERENCES cash_shifts(id),',
    '  sales_counted INTEGER NOT NULL, purchases_counted INTEGER NOT NULL,',
    '  transfer_confirmed INTEGER NOT NULL, counted_tokens INTEGER NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS cash_counts_by_shift ON cash_counts(shift_id, id);',
    'CREATE TABLE IF NOT EXISTS cash_movements (',
    '  id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL REFERENCES cash_shifts(id), kind TEXT NOT NULL,',
    '  amount INTEGER NOT NULL CHECK (amount > 0), sales_delta INTEGER NOT NULL, purchases_delta INTEGER NOT NULL,',
    '  category TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS cash_movements_by_shift ON cash_movements(shift_id, id);',
    'CREATE TABLE IF NOT EXISTS cash_inventory_links (',
    '  inventory_movement_id INTEGER PRIMARY KEY REFERENCES inventory_movements(id),',
    '  cash_movement_id INTEGER NOT NULL REFERENCES cash_movements(id)',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS cash_inventory_by_expense ON cash_inventory_links(cash_movement_id);',
    'CREATE TABLE IF NOT EXISTS cash_shift_sales (sale_id INTEGER PRIMARY KEY REFERENCES sales(id), shift_id INTEGER NOT NULL REFERENCES cash_shifts(id)) STRICT;',
    'CREATE TABLE IF NOT EXISTS cash_shift_payments (payment_id INTEGER PRIMARY KEY REFERENCES account_payments(id), shift_id INTEGER NOT NULL REFERENCES cash_shifts(id)) STRICT;',
    'CREATE TABLE IF NOT EXISTS cash_shift_redemptions (redemption_id INTEGER PRIMARY KEY REFERENCES tejo_redemptions(id), shift_id INTEGER NOT NULL REFERENCES cash_shifts(id)) STRICT;',
    'CREATE TABLE IF NOT EXISTS cash_shift_tokens (',
    '  round_id INTEGER NOT NULL, account_id INTEGER NOT NULL, shift_id INTEGER NOT NULL REFERENCES cash_shifts(id),',
    '  PRIMARY KEY (round_id, account_id), FOREIGN KEY (round_id, account_id) REFERENCES tejo_benefits(round_id, account_id)',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS cash_sales_by_shift ON cash_shift_sales(shift_id, sale_id);',
    'CREATE INDEX IF NOT EXISTS cash_payments_by_shift ON cash_shift_payments(shift_id, payment_id);',
    'CREATE INDEX IF NOT EXISTS cash_redemptions_by_shift ON cash_shift_redemptions(shift_id, redemption_id);',
    'CREATE INDEX IF NOT EXISTS cash_tokens_by_shift ON cash_shift_tokens(shift_id);',
    'CREATE TABLE IF NOT EXISTS cash_shift_slot_tokens (',
    '  benefit_id INTEGER PRIMARY KEY REFERENCES tejo_slot_benefits(id), shift_id INTEGER NOT NULL REFERENCES cash_shifts(id)',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS cash_slot_tokens_by_shift ON cash_shift_slot_tokens(shift_id);',
    'CREATE TRIGGER IF NOT EXISTS cash_track_sale AFTER INSERT ON sales BEGIN',
    '  INSERT INTO cash_shift_sales SELECT NEW.id, id FROM cash_shifts WHERE closed_at IS NULL;',
    'END;',
    'CREATE TRIGGER IF NOT EXISTS cash_track_payment AFTER INSERT ON account_payments BEGIN',
    '  INSERT INTO cash_shift_payments SELECT NEW.id, id FROM cash_shifts WHERE closed_at IS NULL;',
    'END;',
    'CREATE TRIGGER IF NOT EXISTS cash_track_redemption AFTER INSERT ON tejo_redemptions BEGIN',
    '  INSERT INTO cash_shift_redemptions SELECT NEW.id, id FROM cash_shifts WHERE closed_at IS NULL;',
    'END;',
    'CREATE TRIGGER IF NOT EXISTS cash_track_issued_token_insert AFTER INSERT ON tejo_benefits WHEN NEW.issued_at IS NOT NULL BEGIN',
    '  INSERT INTO cash_shift_tokens SELECT NEW.round_id, NEW.account_id, id FROM cash_shifts WHERE closed_at IS NULL;',
    'END;',
    'CREATE TRIGGER IF NOT EXISTS cash_track_slot_token_insert AFTER INSERT ON tejo_slot_benefits WHEN NEW.issued_at IS NOT NULL BEGIN',
    '  INSERT INTO cash_shift_slot_tokens SELECT NEW.id, id FROM cash_shifts WHERE closed_at IS NULL;',
    'END;',
    'CREATE TRIGGER IF NOT EXISTS cash_track_slot_token_update AFTER UPDATE OF issued_at ON tejo_slot_benefits',
    'WHEN NEW.issued_at IS NOT NULL AND OLD.issued_at IS NULL BEGIN',
    '  INSERT INTO cash_shift_slot_tokens SELECT NEW.id, id FROM cash_shifts WHERE closed_at IS NULL;',
    'END;',
    'CREATE TRIGGER IF NOT EXISTS cash_track_issued_token_update AFTER UPDATE OF issued_at ON tejo_benefits',
    'WHEN NEW.issued_at IS NOT NULL AND OLD.issued_at IS NULL BEGIN',
    '  INSERT INTO cash_shift_tokens SELECT NEW.round_id, NEW.account_id, id FROM cash_shifts WHERE closed_at IS NULL;',
    'END;',
  ].join('\n'));

  const existingColumns = new Set(database.prepare('PRAGMA table_info(cash_shifts)').all().map(({ name }) => name));
  const tokenColumns = {
    opening_tokens: 'INTEGER CHECK (opening_tokens >= 0)',
    previous_tokens: 'INTEGER CHECK (previous_tokens >= 0)',
    counted_tokens: 'INTEGER CHECK (counted_tokens >= 0)',
    expected_tokens: 'INTEGER',
    token_opening_note: 'TEXT',
  };
  for (const [column, definition] of Object.entries(tokenColumns)) {
    if (!existingColumns.has(column)) database.exec('ALTER TABLE cash_shifts ADD COLUMN ' + column + ' ' + definition);
  }

  const shiftSelect = [
    'SELECT id, cashier, opened_at AS openedAt, opening_base AS openingBase, previous_base AS previousBase,',
    'opening_note AS openingNote, closed_at AS closedAt, sales_counted AS salesCounted,',
    'purchases_counted AS purchasesCounted, transfer_confirmed AS transferConfirmed, next_base AS nextBase,',
    'closing_note AS closingNote, sales_expected AS salesExpected, purchases_expected AS purchasesExpected,',
    'transfer_expected AS transferExpected, pending_balance AS pendingBalance, opening_tokens AS openingTokens,',
    'previous_tokens AS previousTokens, counted_tokens AS countedTokens, expected_tokens AS expectedTokens,',
    'token_opening_note AS tokenOpeningNote FROM cash_shifts',
  ].join(' ');

  function previousClose() {
    const row = database.prepare([
      'SELECT next_base AS base, counted_tokens AS tokens FROM cash_shifts',
      'WHERE closed_at IS NOT NULL ORDER BY id DESC LIMIT 1',
    ].join(' ')).get();
    return {
      previousBase: row ? Number(row.base) : null,
      previousTokens: row?.tokens == null ? null : Number(row.tokens),
    };
  }

  function shiftById(id: number) {
    const shift = database.prepare(shiftSelect + ' WHERE id = ?').get(id);
    if (!shift) throw new ValidationError(404, 'No se encontró el turno.');
    return shift;
  }

  function openShift(input: Record<string, unknown>) {
    const { openingBase, openingTokens } = input;
    const cashier = readText(input.cashier, 100);
    const note = readText(input.note, 300);
    if (!cashier || !whole(openingBase, 0, maxCash) || !whole(openingTokens, 0, maxTokens) || note === null) {
      throw new ValidationError(400, 'Escribe el nombre del cajero, la base de efectivo y el número de fichas contadas.');
    }
    if (activeShiftId(database) !== null) throw new ValidationError(409, 'Ya hay un turno de caja abierto.');
    const { previousBase, previousTokens } = previousClose();
    if (!note && ((previousBase !== null && previousBase !== openingBase) ||
      (previousTokens !== null && previousTokens !== openingTokens))) {
      throw new ValidationError(400, 'Explica la diferencia con el efectivo o las fichas que dejó el turno anterior.');
    }
    return Number(database.prepare(
      'INSERT INTO cash_shifts (cashier, opened_at, opening_base, previous_base, opening_note, opening_tokens, previous_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(cashier, new Date().toISOString(), openingBase, previousBase, note, openingTokens, previousTokens).lastInsertRowid);
  }

  function readPendingBalance() {
    return Number(database.prepare([
      'SELECT (SELECT COALESCE(SUM(total), 0) FROM sales WHERE account_id IS NOT NULL) -',
      '(SELECT COALESCE(SUM(cash + transfer + tokens * token_value), 0) FROM account_payments WHERE account_id IS NOT NULL) AS total',
    ].join(' ')).get()?.total);
  }

  function summarize(shift: ReturnType<typeof shiftById>) {
    const id = Number(shift.id);
    const sale = database.prepare([
      'SELECT COUNT(*) AS count, COALESCE(SUM(sales.total), 0) AS total',
      'FROM cash_shift_sales JOIN sales ON sales.id = sale_id WHERE shift_id = ?',
    ].join(' ')).get(id);
    const payment = database.prepare([
      'SELECT COALESCE(SUM(cash), 0) AS cash, COALESCE(SUM(transfer), 0) AS transfer,',
      'COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(tokens * token_value), 0) AS tokenAmount,',
      'COALESCE(SUM(CASE WHEN account_payments.sale_id IS NULL THEN cash + transfer + tokens * token_value ELSE 0 END), 0) AS accountCollections',
      'FROM cash_shift_payments JOIN account_payments ON account_payments.id = payment_id WHERE shift_id = ?',
    ].join(' ')).get(id);
    const movement = database.prepare([
      'SELECT COALESCE(SUM(sales_delta), 0) AS sales, COALESCE(SUM(purchases_delta), 0) AS purchases',
      'FROM cash_movements WHERE shift_id = ?',
    ].join(' ')).get(id);
    const salesExpected = shift.salesExpected ?? (Number(shift.openingBase) + Number(payment?.cash) + Number(movement?.sales));
    const purchasesExpected = shift.purchasesExpected ?? Number(movement?.purchases);
    const transferExpected = shift.transferExpected ?? Number(payment?.transfer);
    const pending = shift.pendingBalance ?? readPendingBalance();
    const issued = database.prepare([
      'SELECT (SELECT COUNT(*) FROM cash_shift_tokens WHERE shift_id = ?) +',
      '(SELECT COUNT(*) FROM cash_shift_slot_tokens WHERE shift_id = ?) AS value',
    ].join(' ')).get(id, id);
    const redeemed = database.prepare([
      'SELECT COALESCE(SUM(tokens), 0) AS value FROM cash_shift_redemptions',
      'JOIN tejo_redemptions ON tejo_redemptions.id = redemption_id WHERE shift_id = ?',
    ].join(' ')).get(id);
    const tokensReceived = Number(payment?.tokens);
    const tokensIssued = Number(issued?.value);
    const tokensRedeemed = Number(redeemed?.value);
    const expectedTokens = shift.expectedTokens === null
      ? shift.openingTokens === null ? null : Number(shift.openingTokens) + tokensReceived + tokensRedeemed - tokensIssued
      : Number(shift.expectedTokens);
    return {
      salesCount: Number(sale?.count), salesTotal: Number(sale?.total),
      cashReceived: Number(payment?.cash), transferExpected: Number(transferExpected),
      tokensReceived, tokenAmount: Number(payment?.tokenAmount),
      accountCollections: Number(payment?.accountCollections), pendingBalance: Number(pending),
      tokensIssued, tokensRedeemed, expectedTokens,
      tokenDifference: shift.countedTokens === null || expectedTokens === null ? null : Number(shift.countedTokens) - expectedTokens,
      salesExpected: Number(salesExpected), purchasesExpected: Number(purchasesExpected),
      salesDifference: shift.salesCounted === null ? null : Number(shift.salesCounted) - Number(salesExpected),
      purchasesDifference: shift.purchasesCounted === null ? null : Number(shift.purchasesCounted) - Number(purchasesExpected),
      transferDifference: shift.transferConfirmed === null ? null : Number(shift.transferConfirmed) - Number(transferExpected),
      salesDelivery: shift.salesCounted === null ? null : Number(shift.salesCounted) - Number(shift.nextBase),
      purchasesDelivery: shift.purchasesCounted === null ? null : Number(shift.purchasesCounted),
    };
  }

  function openById(id: number) {
    const shift = shiftById(id);
    if (shift.closedAt !== null) throw new ValidationError(409, 'El turno ya está cerrado.');
    return shift;
  }

  function recordOpeningTokens(id: number, input: Record<string, unknown>) {
    const shift = openById(id);
    if (shift.openingTokens !== null) throw new ValidationError(409, 'El conteo inicial de fichas ya quedó registrado.');
    const note = readText(input.note, 300);
    if (!whole(input.openingTokens, 0, maxTokens) || !note) {
      throw new ValidationError(400, 'Registra las fichas que había al inicio y explica cómo se obtuvo ese conteo.');
    }
    const { previousTokens } = previousClose();
    database.prepare('UPDATE cash_shifts SET opening_tokens = ?, previous_tokens = ?, token_opening_note = ? WHERE id = ?')
      .run(input.openingTokens, previousTokens, note, id);
    return id;
  }

  function recordMovement(id: number, input: Record<string, unknown>) {
    const shift = openById(id);
    const { kind, amount } = input;
    const category = readText(input.category, 80);
    const reason = readText(input.reason, 300);
    if (typeof kind !== 'string' || !Object.hasOwn(cashMovements, kind) ||
      !whole(amount, 1, maxCash) || !category || !reason) {
      throw new ValidationError(400, 'Indica el movimiento, su importe, la categoría y el motivo.');
    }
    const movement = cashMovements[kind as CashMovementKind];
    const totals = summarize(shift);
    if (totals.salesExpected + movement.sales * amount < 0 || totals.purchasesExpected + movement.purchases * amount < 0) {
      throw new ValidationError(409, 'El fondo de origen no tiene efectivo suficiente para ese movimiento.');
    }
    return Number(database.prepare([
      'INSERT INTO cash_movements (shift_id, kind, amount, sales_delta, purchases_delta, category, reason, created_at)',
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ].join(' ')).run(id, kind, amount, movement.sales * amount, movement.purchases * amount, category, reason, new Date().toISOString()).lastInsertRowid);
  }

  const countRows = database.prepare(`
    SELECT id, sales_counted AS salesCounted, purchases_counted AS purchasesCounted,
      transfer_confirmed AS transferConfirmed, counted_tokens AS countedTokens, created_at AS createdAt, reason
    FROM cash_counts WHERE shift_id = ? ORDER BY id
  `);

  function readCounts(id: number): SavedCashCount[] {
    return countRows.all(id).map((row) => ({
      id: Number(row.id), salesCounted: Number(row.salesCounted), purchasesCounted: Number(row.purchasesCounted),
      transferConfirmed: Number(row.transferConfirmed), countedTokens: Number(row.countedTokens),
      createdAt: String(row.createdAt), reason: String(row.reason),
    }));
  }

  function recordCount(id: number, input: Record<string, unknown>) {
    const shift = openById(id);
    if (shift.openingTokens === null) throw new ValidationError(409, 'Registra primero el conteo inicial de fichas de este turno.');
    const { salesCounted, purchasesCounted, transferConfirmed, countedTokens, previousCountId } = input;
    const reason = readText(input.reason, 300);
    if (!whole(salesCounted, 0, maxCash) || !whole(purchasesCounted, 0, maxCash) ||
      !whole(transferConfirmed, 0, maxCash) || !whole(countedTokens, 0, maxTokens) || reason === null) {
      throw new ValidationError(400, 'Registra el efectivo, las transferencias verificadas y las fichas contadas.');
    }
    const previous = readCounts(id).at(-1);
    if (previousCountId !== (previous?.id ?? null)) {
      throw new ValidationError(409, 'Ya se registró otro conteo. Revisa el conteo guardado.');
    }
    if (previous && !reason) throw new ValidationError(400, 'Explica por qué hiciste un nuevo conteo.');
    return Number(database.prepare(`
      INSERT INTO cash_counts (shift_id, sales_counted, purchases_counted, transfer_confirmed, counted_tokens, created_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, salesCounted, purchasesCounted, transferConfirmed, countedTokens, new Date().toISOString(), reason).lastInsertRowid);
  }

  function closeShift(id: number, input: Record<string, unknown>) {
    const shift = openById(id);
    const count = readCounts(id).at(-1);
    if (!count) throw new ValidationError(409, 'Confirma el conteo antes de cerrar el turno.');
    if (input.countId !== count.id) throw new ValidationError(409, 'Hay un conteo más reciente. Revisa el cuadre antes de cerrar.');
    const { salesCounted, purchasesCounted, transferConfirmed, countedTokens } = count;
    const { nextBase } = input;
    const note = readText(input.note, 300);
    if (!whole(nextBase, 0, maxCash) || note === null) {
      throw new ValidationError(400, 'Registra la base siguiente y revisa la nota de cierre.');
    }
    if (nextBase > salesCounted) throw new ValidationError(400, 'La base siguiente no puede superar el efectivo contado en ventas.');
    const totals = summarize(shift);
    if (totals.expectedTokens === null) throw new ValidationError(409, 'Registra primero el conteo inicial de fichas de este turno.');
    const expected = record(input.expected);
    if (!Object.entries(expectedCashCounts(totals)).every(([key, value]) => expected?.[key] === value)) {
      throw new ValidationError(409, 'Hubo movimientos desde la revisión. Revisa las diferencias actualizadas antes de cerrar.');
    }
    if (!note && (salesCounted !== totals.salesExpected || purchasesCounted !== totals.purchasesExpected ||
      transferConfirmed !== totals.transferExpected || countedTokens !== totals.expectedTokens)) {
      throw new ValidationError(400, 'Explica las diferencias antes de cerrar el turno.');
    }
    database.prepare([
      'UPDATE cash_shifts SET closed_at = ?, sales_counted = ?, purchases_counted = ?, transfer_confirmed = ?,',
      'next_base = ?, closing_note = ?, sales_expected = ?, purchases_expected = ?, transfer_expected = ?, pending_balance = ?,',
      'counted_tokens = ?, expected_tokens = ? WHERE id = ?',
    ].join(' ')).run(new Date().toISOString(), salesCounted, purchasesCounted, transferConfirmed, nextBase, note,
      totals.salesExpected, totals.purchasesExpected, totals.transferExpected, totals.pendingBalance,
      countedTokens, totals.expectedTokens, id);
    return id;
  }

  function describe(id: number) {
    const shift = shiftById(id);
    const movements = database.prepare([
      'SELECT id, kind, amount, category, reason, created_at AS createdAt, sales_delta AS salesDelta, purchases_delta AS purchasesDelta,',
      '(SELECT COUNT(*) FROM cash_inventory_links WHERE cash_movement_id = cash_movements.id) AS inventoryLinks',
      'FROM cash_movements WHERE shift_id = ? ORDER BY id DESC',
    ].join(' ')).all(id);
    const payments = database.prepare([
      'SELECT account_payments.id, sale_id AS saleId, a.name, cash, transfer, tokens, token_value AS tokenValue,',
      'account_payments.created_at AS createdAt',
      'FROM cash_shift_payments JOIN account_payments ON account_payments.id = payment_id',
      'LEFT JOIN customer_accounts a ON a.id = account_payments.account_id WHERE shift_id = ? ORDER BY payment_id DESC',
    ].join(' ')).all(id);
    return { shift, totals: summarize(shift), movements, payments, counts: readCounts(id) };
  }

  function adminOverview() {
    function details(id: number) {
      const shift = shiftById(id);
      return { shift, totals: summarize(shift) };
    }
    const id = activeShiftId(database);
    const closures = database.prepare('SELECT id FROM cash_shifts WHERE closed_at IS NOT NULL ORDER BY id DESC LIMIT 30').all();
    const active = id === null ? null : details(id);
    return { active, pendingBalance: active?.totals.pendingBalance ?? readPendingBalance(),
      closures: closures.map((row) => details(Number(row.id))) };
  }

  async function handle(request: IncomingMessage, response: ServerResponse, path: string) {
    try {
      const report = request.method === 'GET' ? /^\/api\/cash\/([1-9]\d*)\/report\.pdf$/.exec(path) : null;
      if (report) {
        const id = Number(report[1]);
        if (!whole(id, 1, Number.MAX_SAFE_INTEGER)) throw new ValidationError(404, 'No se encontró el turno.');
        const detail = describe(id);
        if (detail.shift.closedAt === null) throw new ValidationError(409, 'Cierra el turno para descargar el informe.');
        const filename = cashReportFilename(id, String(detail.shift.closedAt));
        const pdf = await renderCashReport(database, detail);
        response.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="' + filename + '"',
          'Content-Length': pdf.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return response.end(pdf);
      }
      if (request.method === 'GET' && path === '/api/cash/purchase-references') {
        const id = activeShiftId(database);
        const purchases = id === null ? [] : database.prepare([
          "SELECT id, amount, category, reason FROM cash_movements WHERE shift_id = ? AND kind IN ('sales_expense', 'purchase_expense')",
          'ORDER BY id DESC LIMIT 100',
        ].join(' ')).all(id);
        return sendJson(response, 200, purchases);
      }
      if (request.method === 'GET' && path === '/api/cash') {
        const id = activeShiftId(database);
        const recent = database.prepare(shiftSelect + ' WHERE closed_at IS NOT NULL ORDER BY id DESC LIMIT 30').all();
        return sendJson(response, 200, { active: id === null ? null : describe(id), ...previousClose(), recent });
      }
      if (request.method === 'GET') {
        const match = /^\/api\/cash\/([1-9]\d*)$/.exec(path);
        if (!match || !whole(Number(match[1]), 1, Number.MAX_SAFE_INTEGER)) throw new ValidationError(404, 'Ruta de caja no encontrada.');
        return sendJson(response, 200, describe(Number(match[1])));
      }
      if (request.method !== 'POST') throw new ValidationError(405, 'Método no permitido.');
      const input = await readJson(request);
      if (!input) throw new ValidationError(400, 'No se recibió una operación válida.');
      const { requestId, ...fields } = input;
      let action: () => number;
      if (path === '/api/cash') action = () => openShift(fields);
      else {
        const match = /^\/api\/cash\/([1-9]\d*)\/(movements|count|close|opening-tokens)$/.exec(path);
        if (!match || !whole(Number(match[1]), 1, Number.MAX_SAFE_INTEGER)) throw new ValidationError(404, 'Ruta de caja no encontrada.');
        const id = Number(match[1]);
        switch (match[2]) {
          case 'close': action = () => closeShift(id, fields); break;
          case 'count': action = () => recordCount(id, fields); break;
          case 'opening-tokens': action = () => recordOpeningTokens(id, fields); break;
          default: action = () => recordMovement(id, fields);
        }
      }
      const result = accounts.writeOnce(requestId, JSON.stringify([path, fields]), action);
      sendJson(response, result.repeated ? 200 : 201, result);
      if (path.endsWith('/close') && !result.repeated) afterClose?.(result.id);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return sendJson(response, error.status, { error: error.message });
    }
  }
  return { handle, adminOverview };
}
