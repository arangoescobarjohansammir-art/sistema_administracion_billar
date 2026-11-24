import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { testServer } from './support/local-server.mjs';

test('cuadra ambos fondos, conserva diferencias y pasa la base al próximo turno', { timeout: 20000 }, async (t) => {
  const { start, stop, json, cleanup, openShift } = await testServer();
  t.after(cleanup);
  await start();
  const post = (path, status, data) => json(path, status, 'POST', { ...data, requestId: data.requestId ?? randomUUID() });
  const customer = await json('/api/accounts', 201, 'POST', { name: 'Cliente de prueba' });
  const product = await json('/api/products', 201, 'POST', {
    name: 'Cerveza', brand: '', presentation: 'Botella', price: 1000, packageName: '', unitsPerPackage: 1, active: true,
  });
  const productMoves = '/api/products/' + product.id + '/movements';
  await json(productMoves, 201, 'POST', { direction: 'in', unit: 'unit', quantity: 300, reason: 'Existencias de prueba' });
  const sale = (quantity, payment, accountId = null) => ({
    accountId, items: [{ productId: product.id, quantity, unitPrice: 1000 }], payment,
  });
  const cash = (cash) => ({ cash, transfer: 0, tokens: 0 });

  await post('/api/sales', 409, sale(243, cash(243_000)));
  assert.equal((await json('/api/products', 200))[0].stock, 300);
  const first = await openShift();
  const shift = '/api/cash/' + first.id;
  await post('/api/cash', 409, { cashier: 'Otro', openingBase: 0, note: '' });
  await post('/api/sales', 201, sale(243, cash(243_000)));
  await post('/api/sales', 201, sale(20, { cash: 7000, transfer: 10_000, tokens: 1 }));
  await post('/api/sales', 201, sale(16, cash(0), customer.id));

  const movement = (kind, amount, reason, requestId) => ({ kind, amount, category: 'Cerveza', reason, requestId });
  const move = shift + '/movements';
  await post(move, 409, movement('purchase_expense', 80_000, 'Pago antes de recibir dinero'));
  const purchase = movement('sales_expense', 70_000, 'Compra imprevista', randomUUID());
  const expense = await post(move, 201, purchase);
  assert.equal((await post(move, 200, purchase)).id, expense.id);
  await post(move, 201, movement('purchase_in', 200_000, 'Dinero entregado por el administrador'));
  await post(move, 201, movement('purchase_expense', 80_000, 'Pago al proveedor'));
  await post(move, 201, movement('sales_to_purchases', 5000, 'Traslado temporal'));
  await post(move, 201, movement('purchases_to_sales', 5000, 'Devolución del traslado'));
  const references = await json('/api/cash/purchase-references', 200);
  assert.equal(references.length, 2);
  assert.ok(references.some((entry) => entry.id === expense.id));
  const receive = { direction: 'in', unit: 'unit', quantity: 12, reason: 'Compra imprevista', cashMovementId: expense.id };
  await json(productMoves, 400, 'POST', { ...receive, direction: 'out' });
  await json(productMoves, 201, 'POST', receive);

  await stop();
  await start();
  const open = (await json('/api/cash', 200)).active;
  assert.equal(open.shift.id, first.id);
  assert.equal(open.totals.salesTotal, 279_000);
  assert.equal(open.totals.cashReceived, 250_000);
  assert.equal(open.totals.salesExpected, 280_000);
  assert.equal(open.totals.purchasesExpected, 120_000);
  assert.equal(open.totals.transferExpected, 10_000);
  assert.equal(open.totals.tokenAmount, 3000);
  assert.equal(open.totals.pendingBalance, 16_000);
  assert.equal(open.payments.length, 2);
  assert.equal(open.movements.find((item) => item.id === expense.id).inventoryLinks, 1);
  assert.equal((await json(productMoves, 200))[0].cashMovementId, expense.id);

  const close = { salesCounted: 280_000, purchasesCounted: 120_000, transferConfirmed: 9500, nextBase: 100_000, note: '' };
  await post(shift + '/close', 400, close);
  await post(shift + '/close', 400, { ...close, nextBase: 280_001 });
  const closing = { ...close, note: 'Queda una transferencia de $500 por verificar.', requestId: randomUUID() };
  await post(shift + '/close', 201, closing);
  await post(shift + '/close', 200, closing);
  const closed = await json(shift, 200);
  assert.equal(closed.totals.salesDelivery, 180_000);
  assert.equal(closed.totals.purchasesDelivery, 120_000);
  assert.equal(closed.totals.salesDifference, 0);
  assert.equal(closed.totals.purchasesDifference, 0);
  assert.equal(closed.totals.transferDifference, -500);
  assert.equal(closed.shift.closingNote, closing.note);
  assert.equal((await json('/api/cash', 200)).previousBase, 100_000);
  await post(move, 409, { ...purchase, requestId: randomUUID() });
  await json(productMoves, 409, 'POST', receive);

  await post('/api/cash', 400, { cashier: 'Cajero de prueba', openingBase: 90_000, note: '' });
  const second = await openShift();
  await post('/api/accounts/' + customer.id + '/payments', 201, { payment: cash(16_000) });
  const next = await json('/api/cash/' + second.id, 200);
  assert.equal(next.shift.previousBase, 100_000);
  assert.equal(next.totals.salesTotal, 0);
  assert.equal(next.totals.accountCollections, 16_000);
  assert.equal(next.totals.cashReceived, 16_000);
  assert.equal(next.totals.salesExpected, 116_000);
  assert.equal(next.totals.pendingBalance, 0);
  assert.equal((await json(shift, 200)).totals.pendingBalance, 16_000);
});
