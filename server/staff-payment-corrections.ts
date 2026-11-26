import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { type createAccounts, ValidationError, whole } from './accounts.js';
import type { Audit } from './audit.js';
import type { createCash } from './cash.js';
import { activeShiftId } from './cash-ledger.js';
import { readJson, sendJson } from './http.js';

export function createStaffPaymentCorrections(database: DatabaseSync, accounts: ReturnType<typeof createAccounts>,
  cash: ReturnType<typeof createCash>, audit: Audit) {
  const payments = `
    SELECT id, category AS employee, reason, original_amount AS originalAmount, amount, created_at AS createdAt,
      corrected_at AS correctedAt, correction_reason AS correctionReason, compensation_id AS compensationId
    FROM effective_cash_movements WHERE shift_id = ? AND kind = 'staff_payment'
  `;
  const compensations = `
    SELECT id, category, amount, reason, created_at AS createdAt FROM effective_cash_movements
    WHERE shift_id = ? AND kind = 'sales_in' AND compensates_payment_id IS NULL
  `;
  return async (request: IncomingMessage, response: ServerResponse, path: string) => {
    try {
      if (path === '/api/corrections/staff-payments' && request.method === 'GET') {
        const shiftId = activeShiftId(database);
        return sendJson(response, 200, {
          shiftId,
          payments: shiftId === null ? [] : database.prepare(payments + ' ORDER BY id DESC').all(shiftId),
          compensations: shiftId === null ? [] : database.prepare(compensations + ' ORDER BY id DESC').all(shiftId),
        });
      }
      const match = /^\/api\/corrections\/staff-payments\/([1-9]\d*)\/adjust$/.exec(path);
      if (request.method !== 'POST' || !match || !Number.isSafeInteger(Number(match[1]))) {
        throw new ValidationError(404, 'Ruta de corrección de pagos al personal no encontrada.');
      }
      const id = Number(match[1]);
      const input = await readJson(request);
      const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
      const amount = input?.amount;
      const compensationId = input?.compensationId;
      if (!whole(amount, 0, 1_000_000_000) || !reason || reason.length > 300 || input?.confirmed !== true ||
          (compensationId !== null && !whole(compensationId, 1, Number.MAX_SAFE_INTEGER))) {
        throw new ValidationError(400, 'Indica el importe real, el motivo y confirma la corrección.');
      }
      const result = accounts.writeOnce(input.requestId, JSON.stringify([path, amount, compensationId, reason]), () => {
        const shiftId = activeShiftId(database);
        const payment = shiftId === null ? undefined : database.prepare(payments + ' AND id = ?').get(shiftId, id);
        if (shiftId === null || !payment) throw new ValidationError(409, 'El pago debe pertenecer al turno abierto.');
        if (payment.correctedAt !== null) throw new ValidationError(409, 'Este pago ya tiene una corrección.');
        const original = Number(payment.originalAmount);
        if (amount === original) throw new ValidationError(400, 'El importe real debe ser diferente del registrado.');
        const difference = original - amount;
        if (compensationId !== null) {
          const entry = database.prepare(compensations + ' AND id = ? AND id > ? AND amount = ?')
            .get(shiftId, compensationId, id, difference);
          if (!entry) throw new ValidationError(409, 'Elige una entrada posterior, disponible y por el valor exacto de la diferencia.');
        }
        cash.verifyRefund(shiftId, Math.max(0, -difference), 0);
        database.prepare('INSERT INTO cash_staff_payment_corrections VALUES (?, ?, ?, ?, ?)')
          .run(id, amount, compensationId, new Date().toISOString(), reason);
        audit.record(request, 'staff_payment_correction', id, String(payment.employee) + ' · De $' + original + ' a $' + amount +
          (compensationId === null ? '' : ' · Entrada #' + compensationId + ' vinculada') + ' · ' + reason);
        return id;
      });
      return sendJson(response, result.repeated ? 200 : 201, result);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return sendJson(response, error.status, { error: error.message });
    }
  };
}
