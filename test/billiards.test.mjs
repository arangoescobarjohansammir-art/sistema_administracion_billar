import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { roundedTimeCharge, timeCharge } from '../dist/shared/billiard.js';
import { testServer } from './support/local-server.mjs';

const noPayment = { cash: 0, transfer: 0, tokens: 0 };

test('reanuda la mesa sin cobrar la pausa y conserva sus horas', { timeout: 20000 }, async (t) => {
  const { start, stop, json, cleanup, databasePath } = await testServer();
  t.after(cleanup);
  await start();
  const post = (path, status, fields = {}) => json(path, status, 'POST', { requestId: randomUUID(), ...fields });
  const { id } = await post('/api/billiards', 201, { table: 2 });
  const path = '/api/billiards/' + id;
  await post(path + '/resume', 409);
  await post(path + '/stop', 201);
  await stop();
  const fixture = new DatabaseSync(databasePath);
  const began = Date.now() - 650_000;
  try {
    fixture.prepare('UPDATE billiard_sessions SET started_at = ?, stopped_at = ? WHERE id = ?').run(began, began + 600_000, id);
  } finally { fixture.close(); }
  await start();
  assert.equal((await json('/api/billiards', 200)).active[0].seconds, 600);
  const requestId = randomUUID();
  await post(path + '/resume', 201, { requestId });
  await post(path + '/resume', 200, { requestId });
  const resumed = (await json('/api/billiards', 200)).active[0];
  assert.equal(resumed.startedAt, began);
  assert.equal(resumed.stoppedAt, null);
  assert.ok(resumed.pausedMs >= 50_000);
  assert.ok(resumed.seconds >= 600 && resumed.seconds < 625);
  await post(path + '/stop', 201);
  await stop();
  await start();
  const ended = (await json('/api/billiards', 200)).active[0];
  assert.equal(ended.startedAt, began);
  assert.ok(ended.stoppedAt > began + 600_000);
  assert.equal(ended.pausedMs, resumed.pausedMs);
  assert.equal(ended.time, roundedTimeCharge(ended.seconds));
});

test('conserva la mesa, reparte tiempo y consumos, y descuenta inventario solo al entregar', { timeout: 20000 }, async (t) => {
  assert.equal(timeCharge(4800), 8000);
  assert.equal(timeCharge(2700), 4500);
  assert.equal(timeCharge(1), 2);
  const { start, stop, json, cleanup, databasePath, openShift } = await testServer();
  t.after(cleanup);
  await start();
  await openShift();
  const open = { table: 6, requestId: randomUUID() };
  const session = await json('/api/billiards', 201, 'POST', open);
  assert.equal((await json('/api/billiards', 200, 'POST', open)).id, session.id);
  await json('/api/billiards', 409, 'POST', { ...open, requestId: randomUUID() });
  await json('/api/billiards', 400, 'POST', { table: 7, requestId: randomUUID() });
  const base = '/api/billiards/' + session.id;
  const accidental = await json('/api/billiards', 201, 'POST', { table: 1, requestId: randomUUID() });
  await json('/api/billiards/' + accidental.id + '/cancel', 201, 'POST', { requestId: randomUUID() });
  const archived = (await json('/api/billiards', 200)).recent[0];
  assert.ok(archived.canceledAt);
  assert.equal(archived.total, 0);
  assert.equal(archived.shares.length, 0);
  const snapshot = (await json('/api/billiards', 200)).active[0];
  assert.equal(snapshot.rate, 6000);
  assert.equal(snapshot.stoppedAt, null);
  await json(base + '/close', 409, 'POST', { participants: [], requestId: randomUUID() });

  const product = await json('/api/products', 201, 'POST', {
    name: 'Cerveza de prueba', brand: '', presentation: 'Botella',
    price: 4000, packageName: '', unitsPerPackage: 1, active: true,
  });
  const stock = '/api/products/' + product.id + '/movements';
  await json(stock, 201, 'POST', { direction: 'in', unit: 'unit', quantity: 8, reason: 'Saldo inicial', requestId: randomUUID() });
  const order = { productId: product.id, quantity: 3, unitPrice: 4000, requestId: randomUUID() };
  await json(base + '/items', 201, 'POST', order);
  await json(base + '/items', 200, 'POST', order);
  await json(base + '/cancel', 409, 'POST', { requestId: randomUUID() });
  assert.equal((await json('/api/products', 200))[0].stock, 5);
  const client = await json('/api/accounts', 201, 'POST', { name: 'Jugador de prueba' });
  assert.equal((await json('/api/accounts/' + client.id, 200)).account.balance, 0);

  await stop();
  await start();
  const restored = (await json('/api/billiards', 200)).active[0];
  assert.equal(restored.startedAt, snapshot.startedAt);
  assert.equal(restored.items.length, 1);
  assert.equal(restored.items[0].quantity, 3);
  await json(base + '/stop', 201, 'POST', { requestId: randomUUID() });
  assert.ok((await json('/api/billiards', 200)).active[0].stoppedAt >= snapshot.startedAt);

  // Use a fixed completed 80-minute interval in the temporary database.
  await stop();
  const fixture = new DatabaseSync(databasePath);
  try {
    const began = 1_700_000_000_000;
    fixture.prepare('UPDATE billiard_sessions SET started_at = ?, stopped_at = ? WHERE id = ?')
      .run(began, began + 4_800_000, session.id);
  } finally {
    fixture.close();
  }
  await start();
  const table = (await json('/api/billiards', 200)).active[0];
  assert.equal(table.seconds, 4800);
  assert.equal(table.time, 8000);
  assert.equal(table.total, 20_000);
  const itemId = table.items[0].id;
  const charge = {
    requestId: randomUUID(),
    participants: [
      { accountId: client.id, time: 4000, items: [{ id: itemId, amount: 8000 }], payment: noPayment },
      { accountId: null, time: 4000, items: [{ id: itemId, amount: 4000 }],
        payment: { cash: 5000, transfer: 0, tokens: 1 } },
    ],
  };
  await json(base + '/close', 400, 'POST', {
    ...charge, participants: charge.participants.map((part, index) => index === 0
      ? { ...part, time: 3900, items: [{ id: itemId, amount: 8100 }] } : part),
  });
  assert.equal((await json('/api/accounts/' + client.id, 200)).account.balance, 0);
  assert.equal((await json('/api/billiards', 200)).active.length, 1);
  await json(base + '/close', 201, 'POST', charge);
  await json(base + '/close', 200, 'POST', charge);

  const data = await json('/api/billiards', 200);
  assert.equal(data.active.length, 0);
  assert.deepEqual(data.recent[0].shares.map((entry) => entry.total), [12_000, 8000]);
  const detail = await json('/api/accounts/' + client.id, 200);
  assert.equal(detail.account.balance, 12_000);
  assert.equal(detail.sales.length, 1);
  assert.deepEqual(detail.sales[0].items.map((line) => line.unitPrice), [4000, 8000]);
  const [direct] = await json('/api/sales', 200);
  assert.equal(direct.total, 8000);
  assert.equal(direct.payment.tokens, 1);
  assert.deepEqual((await json(stock, 200)).map((row) => row.units), [-3, 8]);
  await json('/api/billiards', 201, 'POST', { table: 6, requestId: randomUUID() });
});

test('redondea el tiempo al cobrar y conserva los consumos y las liquidaciones anteriores', { timeout: 20000 }, async (t) => {
  assert.deepEqual([3088, 3240, 3150, 149, 150, 3600].map((seconds) => roundedTimeCharge(seconds)),
    [5000, 5500, 5500, 0, 500, 6000]);
  assert.equal(timeCharge(3088), 5147);
  assert.equal(timeCharge(3240), 5400);
  const { start, stop, json, cleanup, databasePath, openShift } = await testServer();
  t.after(cleanup);
  await start();
  const { id: shift } = await openShift();
  await stop();
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      INSERT INTO billiard_sessions (id, table_number, rate, started_at, stopped_at, closed_at)
      VALUES (1, 1, 6000, 1700000000000, 1700003088000, 1700003088000),
             (2, 2, 6000, 1700000000000, 1700003088000, NULL),
             (3, 3, 6000, 1700000000000, 1700003240000, NULL),
             (4, 4, 6000, 1700000000000, 1700000149000, NULL);
    `);
  } finally { db.close(); }
  await start();
  const post = (path, status, body) => json(path, status, 'POST', { requestId: randomUUID(), ...body });
  const product = await post('/api/products', 201, {
    name: 'Gaseosa', brand: '', presentation: 'Botella', price: 4123, packageName: '', unitsPerPackage: 1, active: true,
  });
  await post('/api/products/' + product.id + '/movements', 201, { direction: 'in', unit: 'unit', quantity: 2, reason: 'Saldo inicial' });
  await post('/api/billiards/3/items', 201, { productId: product.id, quantity: 1, unitPrice: 4123 });
  const { active, recent } = await json('/api/billiards', 200);
  assert.deepEqual(active.map(({ time, total }) => [time, total]), [[5000, 5000], [5500, 9623], [0, 0]]);
  assert.equal(recent[0].total, 5147);
  const { pendingGames } = await json('/api/cash/' + shift, 200);
  assert.deepEqual(pendingGames.billiards.map(({ time, products }) => [time, products]), [[5000, 0], [5500, 4123], [0, 0]]);

  const cash = (cash) => ({ cash, transfer: 0, tokens: 0 });
  const payTime = (time) => ({ accountId: null, time, items: [], payment: cash(time) });
  await post('/api/billiards/2/close', 400, { participants: [payTime(5147)] });
  await post('/api/billiards/2/close', 201, { participants: [payTime(5000)] });
  const client = await post('/api/accounts', 201, { name: 'Cliente de prueba' });
  await post('/api/billiards/3/close', 201, { participants: [
    payTime(2500),
    { accountId: client.id, time: 3000, items: [{ id: active[1].items[0].id, amount: 4123 }], payment: noPayment },
  ] });
  await post('/api/billiards/4/close', 201, { participants: [] });
  const { totals } = await json('/api/cash/' + shift, 200);
  assert.deepEqual([totals.salesTotal, totals.cashReceived, totals.pendingBalance], [14623, 7500, 7123]);
  const { account, sales } = await json('/api/accounts/' + client.id, 200);
  assert.equal(account.balance, 7123);
  assert.deepEqual(sales[0].items.map(({ unitPrice }) => unitPrice), [3000, 4123]);
  await stop();
  await start();
  const history = (await json('/api/billiards', 200)).recent;
  assert.deepEqual(history.sort((a, b) => a.id - b.id).map(({ time, total }) => [time, total]),
    [[5147, 5147], [5000, 5000], [5500, 9623], [0, 0]]);
});
