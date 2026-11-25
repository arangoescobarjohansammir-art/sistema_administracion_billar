import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { type createAccounts, ValidationError, whole } from './accounts.js';
import type { Audit } from './audit.js';
import type { createCash } from './cash.js';
import { activeShiftId } from './cash-ledger.js';
import { readJson, sendJson } from './http.js';

export function createAccountCorrections(database: DatabaseSync, accounts: ReturnType<typeof createAccounts>,
  cash: ReturnType<typeof createCash>, audit: Audit) {
  const payments = `
    SELECT payment.id, customer.name AS customer, payment.cash, payment.transfer, payment.tokens,
      payment.token_value AS tokenValue, payment.created_at AS createdAt, reversal.created_at AS voidedAt, reversal.reason AS voidReason
    FROM cash_shift_payments tracked JOIN account_payments payment ON payment.id = tracked.payment_id
    JOIN customer_accounts customer ON customer.id = payment.account_id
    LEFT JOIN account_payment_voids reversal ON reversal.payment_id = payment.id
    WHERE tracked.shift_id = ? AND payment.sale_id IS NULL
  `;
  const tejoCharges = `
    WITH charges AS (
      SELECT sale_id, session_id, number AS chico, 'legacy' AS source FROM tejo_rounds
      UNION ALL SELECT sale_id, session_id, number, 'individual' FROM tejo_played WHERE sale_id IS NOT NULL
      UNION ALL SELECT charge.sale_id, played.session_id, played.number, 'team'
        FROM tejo_team_charges charge JOIN tejo_played played ON played.id = charge.round_id
    )
    SELECT sale.id, sale.account_id AS accountId, customer.name AS customer, sale.total, sale.created_at AS createdAt,
      charges.chico, charges.source, session.court_type AS courtType, session.court_number AS courtNumber,
      EXISTS (SELECT 1 FROM account_payments WHERE sale_id = sale.id) AS hasPayment
    FROM charges JOIN valid_sales sale ON sale.id = charges.sale_id
    JOIN cash_shift_sales tracked ON tracked.sale_id = sale.id
    JOIN tejo_sessions session ON session.id = charges.session_id
    JOIN customer_accounts customer ON customer.id = sale.account_id
    WHERE tracked.shift_id = ?
  `;
  const updateCharge = {
    legacy: database.prepare('UPDATE tejo_rounds SET sale_id = ? WHERE sale_id = ?'),
    individual: database.prepare('UPDATE tejo_played SET sale_id = ? WHERE sale_id = ?'),
    team: database.prepare('UPDATE tejo_team_charges SET sale_id = ? WHERE sale_id = ?'),
  };

  function voidPayment(request: IncomingMessage, shiftId: number, id: number, reason: string) {
    const payment = database.prepare(payments + ' AND payment.id = ?').get(shiftId, id);
    if (!payment) throw new ValidationError(409, 'Solo se pueden anular abonos independientes del turno abierto.');
    if (payment.voidedAt !== null) throw new ValidationError(409, 'Este abono ya está anulado.');
    cash.verifyRefund(shiftId, Number(payment.cash), Number(payment.tokens));
    database.prepare('INSERT INTO account_payment_voids VALUES (?, ?, ?)').run(id, new Date().toISOString(), reason);
    audit.record(request, 'account_payment_void', id, String(payment.customer) + ' · ' + reason);
    return id;
  }

  function moveCharge(request: IncomingMessage, shiftId: number, id: number, targetId: number, reason: string) {
    const charge = database.prepare(tejoCharges + ' AND sale.id = ?').get(shiftId, id);
    if (!charge) throw new ValidationError(409, 'El cargo del chico debe estar vigente y pertenecer al turno abierto.');
    if (charge.accountId === targetId) throw new ValidationError(400, 'Elige una cuenta diferente.');
    const amount = Number(charge.total);
    if (charge.hasPayment || Number(accounts.accountById(Number(charge.accountId)).balance) < amount) {
      throw new ValidationError(409, 'El cargo tiene pagos asociados o supera el saldo pendiente de la cuenta. Revisa los abonos antes de corregirlo.');
    }
    const target = accounts.accountById(targetId);
    const now = new Date().toISOString();
    const newSale = accounts.insertSale(targetId, amount, now);
    database.prepare(`
      INSERT INTO sale_allocated_lines (sale_id, label, amount)
      SELECT ?, label, amount FROM sale_allocated_lines WHERE sale_id = ? ORDER BY id
    `).run(newSale, id);
    updateCharge[charge.source as keyof typeof updateCharge].run(newSale, id);
    const detail = 'Cargo #' + id + ' de ' + charge.customer + ' trasladado a ' + target.name + ' como cargo #' + newSale + ' · ' + reason;
    database.prepare('INSERT INTO sale_voids VALUES (?, ?, ?, 0)').run(id, now, detail);
    audit.record(request, 'tejo_charge_move', id, detail);
    return newSale;
  }

  return async function handle(request: IncomingMessage, response: ServerResponse, path: string) {
    try {
      if (request.method === 'GET' && (path === '/api/corrections/payments' || path === '/api/corrections/tejo')) {
        const shiftId = activeShiftId(database);
        const before = Number(new URL(request.url ?? '/', 'http://localhost').searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
        const cursor = whole(before, 1, Number.MAX_SAFE_INTEGER) ? before : Number.MAX_SAFE_INTEGER;
        const query = path.endsWith('/payments')
          ? payments + ' AND payment.id < ? ORDER BY payment.id DESC LIMIT 50'
          : tejoCharges + ' AND sale.id < ? ORDER BY sale.id DESC LIMIT 50';
        return sendJson(response, 200, { shiftId, entries: shiftId === null ? [] : database.prepare(query).all(shiftId, cursor) });
      }
      const payment = /^\/api\/corrections\/payments\/([1-9]\d*)\/void$/.exec(path);
      const match = payment ?? /^\/api\/corrections\/tejo\/([1-9]\d*)\/move$/.exec(path);
      const id = Number(match?.[1]);
      if (request.method !== 'POST' || !whole(id, 1, Number.MAX_SAFE_INTEGER)) {
        throw new ValidationError(404, 'Ruta de correcciones no encontrada.');
      }
      const input = await readJson(request);
      const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
      if (!reason || reason.length > 300 || input?.confirmed !== true) {
        throw new ValidationError(400, 'Escribe el motivo y confirma la corrección.');
      }
      const targetId = input.accountId;
      if (!payment && !whole(targetId, 1, Number.MAX_SAFE_INTEGER)) throw new ValidationError(400, 'Elige la cuenta correcta.');
      const result = accounts.writeOnce(input.requestId, JSON.stringify([path, reason, payment ? null : targetId]), () => {
        const shiftId = activeShiftId(database);
        if (shiftId === null) throw new ValidationError(409, 'Abre un turno de caja para registrar la corrección.');
        return payment ? voidPayment(request, shiftId, id, reason) : moveCharge(request, shiftId, id, Number(targetId), reason);
      });
      return sendJson(response, result.repeated ? 200 : 201, result);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return sendJson(response, error.status, { error: error.message });
    }
  };
}
