import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { testServer } from './support/local-server.mjs';

test('identifica al cajero y conserva la venta original al anular su pago, crédito e inventario', { timeout: 20000 }, async (t) => {
  const server = await testServer();
  t.after(server.cleanup);
  await server.start({ authenticate: false });
  const cashierCredentials = { username: 'diana', secret: '138246' };
  const admin = { name: 'Administrador de prueba', username: 'humberto', secret: 'contraseña-ficticia-local' };
  const { json } = server;
  const post = (path, status, data) => json(path, status, 'POST', { ...data, requestId: data.requestId ?? randomUUID() });
  assert.equal((await json('/api/cash', 401)).code, 'CASH_SESSION_REQUIRED');
  assert.equal((await json('/api/session', 200)).setupNeeded, true);
  await server.signIn('setup', admin, 201);
  await post('/api/session/setup', 409, admin);
  await post('/api/operators', 400, { name: 'Diana Pérez', ...cashierCredentials, secret: '123' });
  const cashier = await post('/api/operators', 201, { name: 'Diana Pérez', ...cashierCredentials });
  assert.equal(Object.hasOwn(cashier, 'verifier'), false);

  await post('/api/session/login', 401, { ...cashierCredentials, secret: '111111' });
  await server.signIn('login', cashierCredentials, 200);
  const cashierCopy = await server.fetch('/api/session/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: '' },
    body: JSON.stringify(cashierCredentials) });
  const cashierCookie = cashierCopy.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await json('/api/session', 200)).operator.name, 'Diana Pérez');
  await json('/api/audit', 403);
  await json('/api/corrections/sales', 403);
  await post('/api/operators', 403, { name: 'Otro', username: 'otro', secret: '123456' });
  const shift = await server.openShift();
  const shiftPath = '/api/cash/' + shift.id;
  assert.equal((await json(shiftPath, 200)).shift.cashier, 'Diana Pérez');
  const product = await post('/api/products', 201, {
    name: 'Cerveza de prueba', presentation: 'Botella', brand: '', price: 4000,
    packageName: '', unitsPerPackage: 1, active: true,
  });
  const stockPath = '/api/products/' + product.id + '/movements';
  const inventory = await post(stockPath, 201, { direction: 'in', unit: 'unit', quantity: 8, reason: 'Compra para el turno' });
  const account = await post('/api/accounts', 201, { name: 'Cliente de ejemplo' });
  const sale = await post('/api/sales', 201, {
    accountId: account.id, items: [{ productId: product.id, quantity: 4, unitPrice: 4000 }],
    payment: { cash: 4000, transfer: 4000, tokens: 1 },
  });
  const withdrawal = await post(shiftPath + '/movements', 201, {
    kind: 'sales_withdrawal', amount: 1000, category: 'Compras', reason: 'Retiro de prueba',
  });
  const voidPath = '/api/corrections/sales/' + sale.id + '/void';
  const correction = { requestId: randomUUID(), reason: 'Pedido duplicado', confirmed: true, stockReturned: true };
  await post(voidPath, 403, correction);
  const before = await json(shiftPath, 200);
  assert.equal(before.totals.salesExpected, 103000);
  assert.equal(before.totals.transferExpected, 4000);
  assert.equal(before.totals.expectedTokens, 101);
  assert.equal(before.totals.pendingBalance, 5000);
  assert.equal((await json('/api/products', 200))[0].stock, 4);

  await server.signIn('login', admin, 200);
  await post(voidPath, 400, { ...correction, reason: ' ', requestId: randomUUID() });
  await post(voidPath, 201, correction);
  await post(voidPath, 200, correction);
  await post(voidPath, 409, { ...correction, requestId: randomUUID() });
  const after = await json(shiftPath, 200);
  assert.deepEqual([
    after.totals.salesTotal, after.totals.cashReceived, after.totals.salesExpected,
    after.totals.transferExpected, after.totals.expectedTokens, after.totals.pendingBalance,
  ], [0, 0, 99000, 0, 100, 0]);
  assert.equal(after.payments[0].voided, 1);
  assert.equal((await json('/api/products', 200))[0].stock, 8);
  const detail = await json('/api/accounts/' + account.id, 200);
  assert.equal(detail.account.balance, 0);
  assert.equal(detail.sales[0].voided, true);
  assert.equal(detail.sales[0].total, 16000);
  assert.deepEqual((await json(stockPath, 200)).map((row) => row.units), [4, -4, 8]);

  const log = await json('/api/audit', 200);
  for (const [kind, id, actor] of [
    ['sale_void', sale.id, admin.name], ['sale', sale.id, 'Diana Pérez'],
    ['cash_movement', withdrawal.id, 'Diana Pérez'], ['inventory_movement', inventory.id, 'Diana Pérez'],
  ]) {
    assert.equal(log.find((row) => row.kind === kind && row.targetId === id)?.actorName, actor);
  }

  const credit = await post('/api/sales', 201, {
    accountId: account.id, items: [{ productId: product.id, quantity: 1, unitPrice: 4000 }],
    payment: { cash: 0, transfer: 0, tokens: 0 },
  });
  await post('/api/accounts/' + account.id + '/payments', 201, { payment: { cash: 2000, transfer: 0, tokens: 0 } });
  await post('/api/corrections/sales/' + credit.id + '/void', 409, { ...correction, requestId: randomUUID() });

  await post('/api/operators/' + cashier.id, 200, { secret: '982416' });
  assert.equal((await server.fetch('/api/cash', { headers: { Cookie: cashierCookie } })).status, 401);
  await post('/api/session/login', 401, cashierCredentials);
  await server.signIn('login', { ...cashierCredentials, secret: '982416' }, 200);
  await post('/api/session/logout', 200, {});
  assert.equal((await server.fetch('/api/cash')).status, 401);
});
