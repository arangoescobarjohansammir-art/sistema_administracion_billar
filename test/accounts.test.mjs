import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { testServer } from './support/local-server.mjs';

const none = { cash: 0, transfer: 0, tokens: 0 };

test('cobra y fía ventas sin duplicar inventario o abonos', { timeout: 20000 }, async (t) => {
  const { start, stop, json, cleanup } = await testServer();
  t.after(cleanup);
  await start();

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
