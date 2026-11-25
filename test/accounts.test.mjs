import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { testServer } from './support/local-server.mjs';

const none = { cash: 0, transfer: 0, tokens: 0 };

test('reparte el fiado de una sola compra entre dos cuentas y registra una vez el pago y los productos', { timeout: 20000 }, async (t) => {
  const server = await testServer();
  t.after(server.cleanup);
  await server.start();
  await server.openShift();
  const post = (path, status, data) => server.json(path, status, 'POST', { ...data, requestId: data.requestId ?? randomUUID() });
  const one = await post('/api/accounts', 201, { name: 'Ana' });
  const two = await post('/api/accounts', 201, { name: 'Luis' });
  const product = await post('/api/products', 201, {
    name: 'Botella compartida', brand: '', presentation: 'Unidad', price: 60000,
    packageName: '', unitsPerPackage: 1, active: true,
  });
  const movement = '/api/products/' + product.id + '/movements';
  await post(movement, 201, { direction: 'in', unit: 'unit', quantity: 4, reason: 'Prueba' });
  const items = [{ productId: product.id, quantity: 1, unitPrice: 60000 }];
  const shares = (first, second) => [{ accountId: one.id, amount: first }, { accountId: two.id, amount: second }];
  const detail = (id) => server.json('/api/accounts/' + id, 200);
  const totals = async () => (await server.json('/api/cash', 200)).active.totals;
  const sale = { accountId: null, items, payment: none, creditShares: shares(40000, 20000), requestId: randomUUID() };
  await post('/api/sales', 400, { ...sale, creditShares: shares(39000, 20000) });
  await post('/api/sales', 400, { ...sale, creditShares: sale.creditShares.map((part) => ({ ...part, accountId: one.id })) });
  await post('/api/sales', 404, { ...sale, creditShares: [sale.creditShares[0], { accountId: 999, amount: 20000 }] });
  assert.equal((await server.json(movement, 200)).length, 1);
  assert.equal((await detail(one.id)).account.balance, 0);
  const receipt = await post('/api/sales', 201, sale);
  assert.equal((await post('/api/sales', 200, sale)).id, receipt.id);
  const [saved] = await server.json('/api/sales', 200);
  assert.equal(saved.total, 60000);
  assert.deepEqual(saved.creditShares.map(({ name, amount }) => [name, amount]), [['Ana', 40000], ['Luis', 20000]]);
  assert.equal((await detail(one.id)).history.current.movements[0].amount, 40000);
  assert.equal((await detail(two.id)).history.current.movements[0].amount, 20000);
  assert.deepEqual(await totals().then(({ salesCount, salesTotal, cashReceived }) => [salesCount, salesTotal, cashReceived]), [1, 60000, 0]);

  const { id: redemption } = await post('/api/tejo/redemptions', 201, {
    accountId: null, items, tokens: 5, payment: { ...none, cash: 5000, transfer: 10000 }, creditShares: shares(15000, 10000),
  });
  const [savedRedemption] = await server.json('/api/tejo/redemptions', 200);
  assert.equal(savedRedemption.id, redemption);
  assert.deepEqual(savedRedemption.creditShares.map(({ amount }) => amount), [15000, 10000]);
  assert.deepEqual(await totals().then(({ salesCount, salesTotal, cashReceived, transferExpected, tokensRedeemed }) =>
    [salesCount, salesTotal, cashReceived, transferExpected, tokensRedeemed]), [2, 100000, 5000, 10000, 5]);
  assert.deepEqual((await server.json(movement, 200)).map(({ units }) => units), [-1, -1, 4]);
  assert.equal((await detail(one.id)).account.balance, 55000);
  assert.equal((await detail(two.id)).account.balance, 30000);

  await post('/api/corrections/sales/' + receipt.id + '/void', 201, {
    confirmed: true, stockReturned: true, reason: 'Anular venta repartida',
  });
  assert.equal((await detail(one.id)).account.balance, 15000);
  assert.equal((await detail(two.id)).account.balance, 10000);
  assert.equal((await detail(two.id)).history.current.movements.at(-1).kind, 'void');
  assert.deepEqual((await server.json(movement, 200)).map(({ units }) => units), [1, -1, -1, 4]);
});

test('conserva el historial con abonos parciales, archiva al saldar y recupera movimientos antiguos', { timeout: 20000 }, async (t) => {
  const server = await testServer();
  t.after(server.cleanup);
  await server.start();
  await server.openShift();
  const post = (path, status, data) => server.json(path, status, 'POST', { ...data, requestId: data.requestId ?? randomUUID() });
  const product = await post('/api/products', 201, {
    name: 'Producto de prueba', brand: '', presentation: 'Unidad', price: 4000,
    packageName: '', unitsPerPackage: 1, active: true,
  });
  await post('/api/products/' + product.id + '/movements', 201, { direction: 'in', unit: 'unit', quantity: 12, reason: 'Prueba' });
  const customer = await post('/api/accounts', 201, { name: 'Cliente de prueba' });
  const path = '/api/accounts/' + customer.id;
  const detail = () => server.json(path, 200);
  const sale = (quantity, cash = 0) => post('/api/sales', 201, {
    accountId: customer.id, items: [{ productId: product.id, quantity, unitPrice: 4000 }], payment: { ...none, cash },
  });
  const pay = (cash) => post(path + '/payments', 201, { payment: { ...none, cash } });
  const opening = await sale(4, 6000);
  const openingHistory = (await detail()).history.current;
  assert.deepEqual(openingHistory.movements.map(({ kind, balanceAfter }) => [kind, balanceAfter]), [['sale', 16000], ['payment', 10000]]);
  const partial = await pay(2000);
  assert.equal((await detail()).history.current.id, openingHistory.id);
  assert.equal((await detail()).history.current.movements.at(-1).balanceAfter, 8000);
  const final = await pay(8000);
  const settled = (await detail()).history;
  assert.equal(settled.current, null);
  assert.equal(settled.closed[0].id, openingHistory.id);
  assert.equal(settled.closed[0].movements.at(-1).sourceId, final.id);
  const second = await sale(1);
  assert.deepEqual((await detail()).history.current.movements.map(({ sourceId }) => sourceId), [second.id]);

  await server.stop();
  const legacy = new DatabaseSync(server.databasePath);
  const started = '2025-01-05T21:30:00.000Z';
  const closedAt = '2025-01-06T03:08:43.000Z';
  try {
    legacy.exec(`
      DROP TRIGGER account_history_sale;
      DROP TRIGGER account_history_payment;
      DROP TRIGGER account_history_void;
      DROP TABLE account_history_events;
    `);
    legacy.prepare('UPDATE sales SET created_at = ? WHERE id = ?').run(started, opening.id);
    legacy.prepare('UPDATE account_payments SET created_at = ? WHERE sale_id = ?').run(started, opening.id);
    legacy.prepare('UPDATE account_payments SET created_at = ? WHERE id = ?').run('2025-01-05T22:35:00.000Z', partial.id);
    legacy.prepare('UPDATE account_payments SET created_at = ? WHERE id = ?').run(closedAt, final.id);
    legacy.prepare('UPDATE sales SET created_at = ? WHERE id = ?').run('2025-01-06T03:08:44.000Z', second.id);
  } finally {
    legacy.close();
  }
  await server.start();
  const restored = await detail();
  assert.equal(restored.account.balance, 4000);
  assert.deepEqual(restored.history.closed.map(({ openedAt, closedAt: at }) => [openedAt, at]), [[started, closedAt]]);
  assert.deepEqual(restored.history.closed[0].movements.map(({ balanceAfter }) => balanceAfter), [16000, 10000, 8000, 0]);
  assert.deepEqual(restored.history.current.movements.map(({ kind, sourceId }) => [kind, sourceId]), [['sale', second.id]]);

  await pay(4000);
  const paidInFull = await sale(1, 4000);
  const another = await sale(1);
  await post('/api/corrections/sales/' + paidInFull.id + '/void', 201, {
    confirmed: true, stockReturned: true, reason: 'Anulación de prueba',
  });
  const current = await detail();
  assert.equal(current.account.balance, 4000);
  assert.deepEqual(current.history.current.movements.map(({ sourceId }) => sourceId), [another.id]);
  assert.deepEqual(current.history.closed[0].movements.map(({ kind, amount, balanceAfter }) => [kind, amount, balanceAfter]),
    [['sale', 4000, 4000], ['payment', 4000, 0], ['void', 0, 0]]);
});

test('cobra y fía ventas sin duplicar inventario o abonos', { timeout: 20000 }, async (t) => {
  const { start, stop, json, cleanup, openShift } = await testServer();
  t.after(cleanup);
  await start();
  await openShift();

  const form = {
    name: 'Cerveza de prueba', brand: '', presentation: 'Botella',
    price: 4000, packageName: '', unitsPerPackage: 1, active: true,
  };
  const beer = await json('/api/products', 201, 'POST', form);
  const juice = await json('/api/products', 201, 'POST', { ...form, name: 'Jugo de prueba' });
  const stockPath = '/api/products/' + beer.id + '/movements';
  await json(stockPath, 201, 'POST', { direction: 'in', unit: 'unit', quantity: 12, reason: 'Saldo inicial de prueba' });
  const customer = await json('/api/accounts', 201, 'POST', { name: '  José   Prueba  ' });
  assert.equal(customer.name, 'José Prueba');
  await json('/api/accounts', 409, 'POST', { name: 'jose prueba' });
  const accountPath = '/api/accounts/' + customer.id;
  const beerItem = { productId: beer.id, quantity: 4, unitPrice: 4000 };
  const credit = {
    requestId: randomUUID(), accountId: customer.id, items: [beerItem],
    payment: { ...none, cash: 6000 },
  };

  await json('/api/sales', 400, 'POST', { ...credit, accountId: null });
  await json('/api/sales', 409, 'POST', {
    ...credit, items: [beerItem, { productId: juice.id, quantity: 1, unitPrice: 4000 }],
  });
  assert.equal((await json(stockPath, 200)).length, 1);
  assert.equal((await json(accountPath, 200)).account.balance, 0);

  const sale = await json('/api/sales', 201, 'POST', credit);
  assert.deepEqual(await json('/api/sales', 200, 'POST', credit), { id: sale.id, repeated: true });
  await json('/api/sales', 409, 'POST', { ...credit, payment: { ...none, cash: 5000 } });
  assert.equal((await json(accountPath, 200)).account.balance, 10_000);
  assert.deepEqual((await json(stockPath, 200)).map((row) => row.units), [-4, 12]);

  const direct = await json('/api/sales', 201, 'POST', {
    requestId: randomUUID(), accountId: null,
    items: [{ ...beerItem, quantity: 5 }],
    payment: { cash: 7000, transfer: 10_000, tokens: 1 },
  });
  const stockAfterSales = await json(stockPath, 200);
  assert.deepEqual(stockAfterSales.map((row) => row.units), [-5, -4, 12]);
  const [recent] = await json('/api/sales', 200);
  assert.equal(recent.id, direct.id);
  assert.equal(recent.total, 20_000);
  assert.deepEqual(
    [recent.payment.cash, recent.payment.transfer, recent.payment.tokens, recent.payment.tokenValue],
    [7000, 10_000, 1, 3000],
  );

  await json('/api/products/' + beer.id, 200, 'PUT', { ...form, price: 5000 });
  await json('/api/sales', 409, 'POST', { ...credit, requestId: randomUUID(), items: [{ ...beerItem, quantity: 1 }], payment: none });
  await stop();
  await start();
  await json(accountPath + '/payments', 409, 'POST', { requestId: randomUUID(), payment: { ...none, cash: 10_001 } });
  const settle = { requestId: randomUUID(), payment: { ...none, cash: 7000, tokens: 1 } };
  const receipt = await json(accountPath + '/payments', 201, 'POST', settle);
  assert.deepEqual(await json(accountPath + '/payments', 200, 'POST', settle), { id: receipt.id, repeated: true });
  const detail = await json(accountPath, 200);
  assert.equal(detail.account.balance, 0);
  assert.equal(detail.sales.length, 1);
  assert.equal(detail.sales[0].items[0].unitPrice, 4000);
  assert.equal(detail.payments.length, 2);
  assert.equal(detail.payments[0].saleId, null);
  assert.deepEqual(await json(stockPath, 200), stockAfterSales);
});
