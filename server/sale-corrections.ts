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
    SELECT s.id, s.account_id AS accountId, a.name AS customer, s.total, s.created_at AS createdAt,
      p.cash, p.transfer, p.tokens, p.token_value AS tokenValue, v.created_at AS voidedAt, v.reason AS voidReason,
      v.stock_returned AS stockReturned
    FROM cash_shift_sales tracking JOIN sales s ON s.id = tracking.sale_id
    LEFT JOIN customer_accounts a ON s.account_id = a.id
    LEFT JOIN account_payments p ON p.sale_id = s.id
    LEFT JOIN sale_voids v ON v.sale_id = s.id
    WHERE tracking.shift_id = ? AND EXISTS (SELECT 1 FROM sale_items WHERE sale_id = s.id)
  `;
  const itemsForSale = database.prepare('SELECT product_id AS productId, label, quantity FROM sale_items WHERE sale_id = ? ORDER BY id');

  async function handle(request: IncomingMessage, response: ServerResponse, path: string) {
    try {
      if (path === '/api/corrections/sales' && request.method === 'GET') {
        const shiftId = activeShiftId(database);
        const before = Number(new URL(request.url ?? '/', 'http://localhost').searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
        const sales = shiftId === null ? [] : database.prepare(directSales + ' AND s.id < ? ORDER BY s.id DESC LIMIT 50')
          .all(shiftId, Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER);
        return sendJson(response, 200, { shiftId, sales: sales.map((sale) => {
          const id = Number(sale.id);
          const shares = accounts.readCreditShares(id);
          return { ...sale, total: shares.reduce((sum, part) => sum + part.amount, Number(sale.total)),
            items: itemsForSale.all(id), creditShares: shares };
        }) });
      }
      const match = /^\/api\/corrections\/sales\/([1-9]\d*)\/void$/.exec(path);
      if (!match || request.method !== 'POST' || !Number.isSafeInteger(Number(match[1]))) {
        throw new ValidationError(404, 'Ruta de correcciones no encontrada.');
      }
      const id = Number(match[1]);
      const input = await readJson(request);
      const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
      const stockReturned = input?.stockReturned;
      if (!reason || reason.length > 300 || typeof stockReturned !== 'boolean' || input?.confirmed !== true) {
        throw new ValidationError(400, 'Escribe el motivo y confirma qué pasó con el pago y los productos.');
      }
      const result = accounts.writeOnce(input.requestId, JSON.stringify([path, reason, stockReturned]), () => {
        const shiftId = activeShiftId(database);
        if (shiftId === null) throw new ValidationError(409, 'Abre un turno para anular una venta.');
        const sale = database.prepare(directSales + ' AND s.id = ?').get(shiftId, id);
        if (!sale) throw new ValidationError(409, 'Solo se pueden anular ventas de productos registradas en el turno abierto.');
        if (sale.voidedAt !== null) throw new ValidationError(409, 'La venta ya está anulada.');
        const paid = Number(sale.cash) + Number(sale.transfer) + Number(sale.tokens) * Number(sale.tokenValue);
        if (sale.accountId !== null && Number(accounts.accountById(Number(sale.accountId)).balance) < Number(sale.total) - paid) {
          throw new ValidationError(409, 'El saldo pendiente ya no cubre el fiado de esta venta. Revisa los abonos aplicados a la cuenta.');
        }
        const shares = accounts.readCreditShares(id);
        for (const share of shares) {
          if (Number(accounts.accountById(share.accountId).balance) < share.amount) {
            throw new ValidationError(409, 'El saldo de ' + share.name + ' ya no cubre su parte. Revisa los abonos de esa cuenta.');
          }
        }
        cash.verifyRefund(shiftId, Number(sale.cash), Number(sale.tokens));
        const createdAt = new Date().toISOString();
        const voidSale = database.prepare('INSERT INTO sale_voids VALUES (?, ?, ?, ?)');
        voidSale.run(id, createdAt, reason, Number(stockReturned));
        for (const share of shares) voidSale.run(share.saleId, createdAt, reason, 0);
        if (stockReturned) {
          for (const item of itemsForSale.all(id)) {
            const productId = Number(item.productId);
            const quantity = Number(item.quantity);
            const product = findProduct(database, productId);
            if (Number(product?.stock) + quantity > 1_000_000) throw new ValidationError(409, 'La devolución supera el límite de existencias.');
            recordInventoryMovement(database, { productId, units: quantity, quantity, unitsPerInput: 1,
              inputUnit: 'unidad', reason: 'Anulación de venta #' + id + ' · ' + reason, createdAt });
          }
        }
        audit.record(request, 'sale_void', id, reason + (stockReturned ? ' · Productos devueltos al inventario.' : ' · Sin devolución a inventario.'));
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
