import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type createAccounts, ValidationError } from './accounts.js';
import type { Audit } from './audit.js';
import type { createCash } from './cash.js';
import { activeShiftId } from './cash-ledger.js';
import { readJson, sendJson } from './http.js';
import { findProduct, recordInventoryMovement } from './inventory.js';

export function createSaleCorrections(database: DatabaseSync, accounts: ReturnType<typeof createAccounts>,
  cash: ReturnType<typeof createCash>, audit: Audit) {
  const directSales = `
    SELECT s.id, s.id AS saleId, s.account_id AS accountId, a.name AS customer,
      s.total, s.total AS saleTotal, 0 AS redemptionTokens, s.created_at AS createdAt,
      p.cash, p.transfer, p.tokens, p.token_value AS tokenValue, v.created_at AS voidedAt, v.reason AS voidReason,
      v.stock_returned AS stockReturned
    FROM cash_shift_sales tracking JOIN sales s ON s.id = tracking.sale_id
    LEFT JOIN customer_accounts a ON s.account_id = a.id
    LEFT JOIN account_payments p ON p.sale_id = s.id
    LEFT JOIN sale_voids v ON v.sale_id = s.id
    WHERE tracking.shift_id = ? AND EXISTS (SELECT 1 FROM sale_items WHERE sale_id = s.id)
  `;
  const physicalRedemptions = `
    SELECT r.id, r.sale_id AS saleId, r.account_id AS accountId, a.name AS customer,
      r.subtotal AS total, s.total AS saleTotal, r.tokens AS redemptionTokens, r.created_at AS createdAt,
      p.cash, p.transfer, p.tokens, p.token_value AS tokenValue, v.created_at AS voidedAt, v.reason AS voidReason,
      v.stock_returned AS stockReturned
    FROM cash_shift_redemptions tracking JOIN tejo_redemptions r ON r.id = tracking.redemption_id
    LEFT JOIN customer_accounts a ON r.account_id = a.id
    LEFT JOIN sales s ON s.id = r.sale_id
    LEFT JOIN account_payments p ON p.sale_id = r.sale_id
    LEFT JOIN tejo_redemption_voids v ON v.redemption_id = r.id
    WHERE tracking.shift_id = ? AND r.round_id IS NULL
  `;
  const scopes = {
    sales: { query: directSales, alias: 's', name: 'venta', auditKind: 'sale_void',
      items: database.prepare('SELECT product_id AS productId, label, quantity FROM sale_items WHERE sale_id = ? ORDER BY id') },
    redemptions: { query: physicalRedemptions, alias: 'r', name: 'canje', auditKind: 'redemption_void',
      items: database.prepare('SELECT product_id AS productId, label, quantity FROM tejo_redemption_items WHERE redemption_id = ? ORDER BY id') },
  } as const;
  const voidSale = database.prepare('INSERT INTO sale_voids VALUES (?, ?, ?, ?)');
  const voidRedemption = database.prepare('INSERT INTO tejo_redemption_voids VALUES (?, ?, ?, ?)');

  async function handle(request: IncomingMessage, response: ServerResponse, path: string) {
    try {
      const match = /^\/api\/corrections\/(sales|redemptions)(?:\/([1-9]\d*)\/void)?$/.exec(path);
      if (!match) throw new ValidationError(404, 'Ruta de correcciones no encontrada.');
      const kind = match[1] as keyof typeof scopes;
      const scope = scopes[kind];
      const redemption = kind === 'redemptions';
      const recordId = scope.alias + '.id';
      if (!match[2] && request.method === 'GET') {
        const shiftId = activeShiftId(database);
        const before = Number(new URL(request.url ?? '/', 'http://localhost').searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
        const entries = shiftId === null ? [] : database.prepare(scope.query + ' AND ' + recordId + ' < ? ORDER BY ' + recordId + ' DESC LIMIT 50')
          .all(shiftId, Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER);
        return sendJson(response, 200, { shiftId, [kind]: entries.map((entry) => {
          const shares = entry.saleId === null ? [] : accounts.readCreditShares(Number(entry.saleId));
          return { ...entry, total: redemption ? Number(entry.total) : shares.reduce((sum, part) => sum + part.amount, Number(entry.total)),
            items: scope.items.all(Number(entry.id)), creditShares: shares };
        }) });
      }
      if (request.method !== 'POST' || !Number.isSafeInteger(Number(match[2]))) {
        throw new ValidationError(404, 'Ruta de correcciones no encontrada.');
      }
      const id = Number(match[2]);
      const input = await readJson(request);
      const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
      const stockReturned = input?.stockReturned;
      if (!reason || reason.length > 300 || typeof stockReturned !== 'boolean' || input?.confirmed !== true) {
        throw new ValidationError(400, 'Escribe el motivo y confirma qué pasó con el pago y los productos.');
      }
      const result = accounts.writeOnce(input.requestId, JSON.stringify([path, reason, stockReturned]), () => {
        const shiftId = activeShiftId(database);
        if (shiftId === null) throw new ValidationError(409, 'Abre un turno para registrar una anulación.');
        const sale = database.prepare(scope.query + ' AND ' + recordId + ' = ?').get(shiftId, id);
        if (!sale) throw new ValidationError(409, 'La operación debe pertenecer al turno abierto.');
        if (sale.voidedAt !== null) throw new ValidationError(409, 'Ya se registró la anulación.');
        const paid = Number(sale.cash) + Number(sale.transfer) + Number(sale.tokens) * Number(sale.tokenValue);
        if (sale.saleId !== null && sale.accountId !== null &&
            Number(accounts.accountById(Number(sale.accountId)).balance) < Number(sale.saleTotal) - paid) {
          throw new ValidationError(409, 'El saldo pendiente ya no cubre el fiado de esta operación. Revisa los abonos aplicados a la cuenta.');
        }
        const shares = sale.saleId === null ? [] : accounts.readCreditShares(Number(sale.saleId));
        for (const share of shares) {
          if (Number(accounts.accountById(share.accountId).balance) < share.amount) {
            throw new ValidationError(409, 'El saldo de ' + share.name + ' ya no cubre su parte. Revisa los abonos de esa cuenta.');
          }
        }
        cash.verifyRefund(shiftId, Number(sale.cash), Number(sale.tokens) + Number(sale.redemptionTokens));
        const createdAt = new Date().toISOString();
        const detail = redemption ? 'Canje #' + id + ' · ' + reason : reason;
        if (redemption) voidRedemption.run(id, createdAt, reason, Number(stockReturned));
        if (sale.saleId !== null) voidSale.run(sale.saleId, createdAt, detail, Number(stockReturned));
        for (const share of shares) voidSale.run(share.saleId, createdAt, detail, 0);
        if (stockReturned) {
          for (const item of scope.items.all(id)) {
            const productId = Number(item.productId);
            const quantity = Number(item.quantity);
            const product = findProduct(database, productId);
            if (Number(product?.stock) + quantity > 1_000_000) throw new ValidationError(409, 'La devolución supera el límite de existencias.');
            recordInventoryMovement(database, { productId, units: quantity, quantity, unitsPerInput: 1,
              inputUnit: 'unidad', reason: 'Anulación de ' + scope.name + ' #' + id + ' · ' + reason, createdAt });
          }
        }
        audit.record(request, scope.auditKind, id, detail + (stockReturned ? ' · Productos devueltos al inventario.' : ' · Sin devolución a inventario.'));
        return id;
      });
      return sendJson(response, result.repeated ? 200 : 201, result);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return sendJson(response, error.status, { error: error.message });
    }
  }
  return handle;
}
