import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { testServer } from './support/local-server.mjs';

test('cuadra ambos fondos, conserva diferencias y pasa la base al próximo turno', { timeout: 20000 }, async (t) => {
  const { start, stop, json, fetch, cleanup, openShift, recordCashCount } = await testServer();
  t.after(cleanup);
  await start();
  const post = (path, status, data) => json(path, status, 'POST', { ...data, requestId: data.requestId ?? randomUUID() });
  const customer = await json('/api/accounts', 201, 'POST', { name: 'Cliente de prueba' });
  const product = await json('/api/products', 201, 'POST', {
    name: 'Cerveza', brand: '', presentation: 'Botella', price: 1000, packageName: '', unitsPerPackage: 1, active: true,
  });
  const productMoves = '/api/products/' + product.id + '/movements';
  await post(productMoves, 201, { direction: 'in', unit: 'unit', quantity: 300, reason: 'Existencias de prueba' });
  const sale = (quantity, payment, accountId = null) => ({
    accountId, items: [{ productId: product.id, quantity, unitPrice: 1000 }], payment,
  });
  const cash = (cash) => ({ cash, transfer: 0, tokens: 0 });

  await post('/api/sales', 409, sale(243, cash(243_000)));
  assert.equal((await json('/api/products', 200))[0].stock, 300);
  const first = await openShift();
  const shift = '/api/cash/' + first.id;
  await json(shift + '/report.pdf', 409);
  await post('/api/cash', 409, { cashier: 'Otro', openingBase: 0, openingTokens: 0, note: '' });
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
  assert.deepEqual(await json('/api/cash/purchase-fund', 200), { shiftId: first.id, balance: 200_000 });
  await post(move, 201, movement('purchase_expense', 80_000, 'Pago al proveedor'));
  await post(move, 201, movement('sales_to_purchases', 5000, 'Traslado temporal'));
  await post(move, 201, movement('purchases_to_sales', 5000, 'Devolución del traslado'));
  assert.deepEqual(await json('/api/cash/purchase-fund', 200), { shiftId: first.id, balance: 120_000 });
  const references = await json('/api/cash/purchase-references', 200);
  assert.equal(references.length, 2);
  assert.ok(references.some((entry) => entry.id === expense.id));
  const receive = { direction: 'in', unit: 'unit', quantity: 12, reason: 'Compra imprevista', cashMovementId: expense.id, requestId: randomUUID() };
  await post(productMoves, 400, { ...receive, direction: 'out' });
  const received = await post(productMoves, 201, receive);
  assert.equal((await post(productMoves, 200, receive)).movementId, received.movementId);

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
  assert.equal(open.totals.expectedTokens, 101);
  assert.equal(open.totals.pendingBalance, 16_000);
  assert.equal(open.payments.length, 2);
  assert.equal(open.movements.find((item) => item.id === expense.id).inventoryLinks, 1);
  assert.equal((await json(productMoves, 200))[0].cashMovementId, expense.id);

  const count = { salesCounted: 280_000, purchasesCounted: 120_000, transferConfirmed: 9500, countedTokens: 101 };
  await post(shift + '/close', 409, { nextBase: 100_000, note: '' });
  const initialCount = await recordCashCount(first.id, { ...count, transferConfirmed: 9000 });
  await post(shift + '/count', 409, { ...count, reason: '', previousCountId: null });
  await post(shift + '/count', 400, { ...count, reason: '', previousCountId: initialCount.countId });
  await stop();
  await start();
  const reason = 'La cajera verificó otra notificación de transferencia.';
  const review = await recordCashCount(first.id, count, initialCount.countId, reason);
  const close = { ...review, nextBase: 100_000, note: '' };
  await post(shift + '/close', 409, { ...close, countId: initialCount.countId });
  await post(shift + '/close', 400, close);
  await post(shift + '/close', 400, { ...close, nextBase: 280_001 });
  const closing = { ...close, note: 'Queda una transferencia de $500 por verificar.', requestId: randomUUID() };
  await post(move, 201, movement('sales_in', 1000, 'Aporte para la prueba de recuento'));
  await post(shift + '/close', 409, closing);
  await post(move, 201, movement('sales_withdrawal', 1000, 'Devolución del aporte'));
  await post(shift + '/close', 409, closing);
  assert.equal((await json(shift, 200)).requiresRecount, true);
  const repeatedReason = 'Se contó de nuevo después del aporte y su devolución.';
  const refreshed = await recordCashCount(first.id, count, review.countId, repeatedReason);
  const finalClose = { ...closing, ...refreshed };
  await post(shift + '/close', 201, finalClose);
  await post(shift + '/close', 200, finalClose);
  const closed = await json(shift, 200);
  const report = await fetch(shift + '/report.pdf');
  assert.equal(report.status, 200);
  assert.equal(report.headers.get('content-type'), 'application/pdf');
  assert.match(report.headers.get('content-disposition'), /^attachment; filename="cierre-caja-1-\d{4}-\d{2}-\d{2}\.pdf"$/);
  const pdf = Buffer.from(await report.arrayBuffer());
  assert.match(pdf.subarray(0, 8).toString('ascii'), /^%PDF-/);
  assert.ok(pdf.length > 3000);
  assert.equal(closed.totals.salesDelivery, 180_000);
  assert.equal(closed.totals.purchasesDelivery, 120_000);
  assert.equal(closed.totals.salesDifference, 0);
  assert.equal(closed.totals.purchasesDifference, 0);
  assert.equal(closed.totals.transferDifference, -500);
  assert.equal(closed.shift.closingNote, closing.note);
  assert.deepEqual(closed.counts.map(({ transferConfirmed, reason }) => [transferConfirmed, reason]),
    [[9000, ''], [9500, reason], [9500, repeatedReason]]);
  assert.equal((await json('/api/cash', 200)).previousBase, 100_000);
  await post(move, 409, { ...purchase, requestId: randomUUID() });
  assert.equal((await post(productMoves, 200, receive)).movementId, received.movementId);
  await post(productMoves, 409, { ...receive, requestId: randomUUID() });

  await post('/api/cash', 400, { cashier: 'Cajero de prueba', openingBase: 90_000, openingTokens: 101, note: '' });
  const second = await openShift(100_000, 101);
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

test('exige volver a contar después de una entrada aunque se abra otra vez la revisión', { timeout: 20000 }, async (t) => {
  const server = await testServer();
  t.after(server.cleanup);
  await server.start();
  const { id } = await server.openShift();
  const path = '/api/cash/' + id;
  const original = { salesCounted: 100000, purchasesCounted: 0, transferConfirmed: 0, countedTokens: 100 };
  const counted = await server.recordCashCount(id, original);
  const before = await server.json(path, 200);
  const post = (operation, status, fields) => server.json(path + '/' + operation, status, 'POST', { ...fields, requestId: randomUUID() });
  await post('movements', 201, { kind: 'sales_in', amount: 20000, category: 'Efectivo', reason: 'Entrada posterior al conteo' });
  await server.stop();
  await server.start();
  const loaded = await server.json(path, 200);
  assert.equal(loaded.totals.salesExpected, 120000);
  assert.equal(loaded.requiresRecount, true);
  assert.equal((await post('close', 409, {
    countId: counted.countId, expected: loaded.totals, nextBase: 100000, note: 'Se volvió a abrir la revisión',
  })).error, 'El conteo quedó desactualizado. Guarda un recuento antes de cerrar el turno.');
  assert.equal((await post('count', 409, {
    ...original, previousCountId: counted.countId, reason: 'Intento de recuento',
    reconciliationRevision: before.shift.reconciliationRevision,
  })).error, 'Hubo movimientos mientras registrabas el conteo. Vuelve a contar y verificar la caja.');
  const confirmed = await server.recordCashCount(id, { ...original, salesCounted: 120000 }, counted.countId, 'Entrada posterior');
  assert.equal((await server.json(path, 200)).requiresRecount, false);
  await post('close', 201, { ...confirmed, nextBase: 100000, note: '' });
  const closed = await server.json(path, 200);
  assert.equal(closed.totals.salesDelivery, 20000);
  assert.equal(closed.totals.salesDifference, 0);
  assert.deepEqual(closed.counts.map(({ salesCounted }) => salesCounted), [100000, 120000]);
});

test('exige y guarda el motivo cuando cambia la base para el próximo turno', { timeout: 20000 }, async (t) => {
  const server = await testServer();
  t.after(server.cleanup);
  await server.start();
  const { id } = await server.openShift();
  const path = '/api/cash/' + id;
  const count = await server.recordCashCount(id, {
    salesCounted: 100_000, purchasesCounted: 0, transferConfirmed: 0, countedTokens: 100,
  });
  const close = (status, note) => server.json(path + '/close', status, 'POST', {
    ...count, requestId: randomUUID(), nextBase: 50_000, note,
  });
  for (const note of ['', ' \t ']) {
    assert.equal((await close(400, note)).error, 'Explica el cambio de la base para el próximo turno.');
  }
  assert.equal((await server.json(path, 200)).shift.closedAt, null);
  const reason = 'Humberto autorizó dejar una base menor.';
  await close(201, reason);
  const closed = await server.json(path, 200);
  assert.equal(closed.shift.closingNote, reason);
  assert.equal(closed.shift.nextBase, 50_000);
  assert.equal(closed.totals.salesDelivery, 50_000);

  const next = await server.openShift(50_000);
  const nextCount = await server.recordCashCount(next.id, {
    salesCounted: 50_000, purchasesCounted: 0, transferConfirmed: 0, countedTokens: 100,
  });
  const nextPath = '/api/cash/' + next.id;
  await server.json(nextPath + '/close', 201, 'POST', {
    ...nextCount, requestId: randomUUID(), nextBase: 50_000, note: '',
  });
  assert.equal((await server.json(nextPath, 200)).shift.closingNote, '');
});

test('confirma y conserva los juegos pendientes de un cierre cuando se liquidan en el turno siguiente', { timeout: 20000 }, async (t) => {
  const server = await testServer();
  t.after(server.cleanup);
  await server.start();
  const { id } = await server.openShift();
  const path = '/api/cash/' + id;
  const { json } = server;
  const post = (route, status, data) => json(route, status, 'POST', { requestId: randomUUID(), ...data });
  const { id: productId } = await post('/api/products', 201, {
    name: 'Cerveza ficticia', brand: '', presentation: 'Unidad', price: 4000, packageName: '', unitsPerPackage: 1, active: true,
  });
  await post('/api/products/' + productId + '/movements', 201,
    { direction: 'in', unit: 'unit', quantity: 3, reason: 'Prueba' });
  const table = await post('/api/billiards', 201, { table: 2 });
  const tablePath = '/api/billiards/' + table.id;
  await post(tablePath + '/items', 201, { productId, quantity: 2, unitPrice: 4000 });
  const session = await post('/api/tejo', 201, { courtType: 'maxi', courtNumber: 1, playerCount: 2 });
  const tejoPath = '/api/tejo/' + session.id;
  await post(tejoPath + '/record', 201, { issueAll: false });
  const count = await server.recordCashCount(id, { salesCounted: 100000, purchasesCounted: 0, transferConfirmed: 0, countedTokens: 100 });
  const review = await json(path, 200);
  assert.deepEqual([review.totals.salesTotal, review.totals.pendingBalance], [0, 0]);
  assert.deepEqual(review.pendingGames.billiards.map(({ table, products, running }) => [table, products, running]), [[2, 8000, true]]);
  assert.deepEqual(review.pendingGames.tejo.map(({ court, round, amount }) => [court, round, amount]), [[1, 1, 8000]]);
  const closing = { ...count, nextBase: 100000, note: '', gamesRevision: review.gamesRevision };
  await post(path + '/close', 409, closing);
  await post(tablePath + '/stop', 201, {});
  await post(path + '/close', 409, { ...closing, pendingGamesConfirmed: true });
  const checked = await json(path, 200);
  assert.equal(checked.requiresRecount, false);
  assert.equal(checked.pendingGames.billiards[0].running, false);
  const final = { ...closing, gamesRevision: checked.gamesRevision, pendingGamesConfirmed: true, requestId: randomUUID() };
  await post(path + '/close', 201, final);
  await post(path + '/close', 200, final);
  const closed = await json(path, 200);
  assert.deepEqual(closed.pendingGames.billiards, checked.pendingGames.billiards);
  assert.deepEqual(closed.pendingGames.tejo, checked.pendingGames.tejo);
  assert.equal(closed.pendingGames.capturedAt, closed.shift.closedAt);
  assert.equal((await server.fetch(path + '/report.pdf')).status, 200);
  const next = await server.openShift();
  const account = await post('/api/accounts', 201, { name: 'Cliente ficticio' });
  const bill = (await json('/api/billiards', 200)).active[0];
  const none = { cash: 0, transfer: 0, tokens: 0 };
  await post(tablePath + '/close', 201, { participants: [{
    accountId: account.id, time: bill.time, items: [{ id: bill.items[0].id, amount: 8000 }], payment: none,
  }] });
  const group = (await json('/api/tejo', 200)).active[0];
  await post(tejoPath + '/assign', 201, { losses: [{ playerId: group.players[0].id, count: 1, accountId: account.id }] });
  const following = await json('/api/cash/' + next.id, 200);
  assert.deepEqual([following.pendingGames.billiards, following.pendingGames.tejo], [[], []]);
  assert.equal(following.totals.salesTotal, 16000 + bill.time);
  assert.deepEqual((await json(path, 200)).pendingGames, closed.pendingGames);
});

test('conserva un turno abierto de una versión anterior al agregar el conteo de fichas', { timeout: 20000 }, async (t) => {
  const { start, stop, json, cleanup, openShift, databasePath, recordCashCount } = await testServer();
  t.after(cleanup);
  await start();
  const shift = await openShift();
  await stop();
  const fixture = new DatabaseSync(databasePath);
  try {
    fixture.exec('ALTER TABLE cash_shifts DROP COLUMN token_opening_note');
    fixture.exec('ALTER TABLE cash_shifts DROP COLUMN expected_tokens');
    fixture.exec('ALTER TABLE cash_shifts DROP COLUMN counted_tokens');
    fixture.exec('ALTER TABLE cash_shifts DROP COLUMN previous_tokens');
    fixture.exec('ALTER TABLE cash_shifts DROP COLUMN opening_tokens');
  } finally {
    fixture.close();
  }
  await start();
  const path = '/api/cash/' + shift.id;
  assert.equal((await json(path, 200)).totals.expectedTokens, null);
  const count = { salesCounted: 100_000, purchasesCounted: 0, transferConfirmed: 0, countedTokens: 40 };
  await json(path + '/count', 409, 'POST', { ...count, previousCountId: null, reason: '', requestId: randomUUID() });
  const initial = { openingTokens: 40, note: 'Conteo de la libreta de apertura' };
  await json(path + '/opening-tokens', 201, 'POST', { ...initial, requestId: randomUUID() });
  await json(path + '/opening-tokens', 409, 'POST', { ...initial, requestId: randomUUID() });
  const review = await recordCashCount(shift.id, count);
  await json(path + '/close', 201, 'POST', { ...review, nextBase: 100_000, note: '', requestId: randomUUID() });
  const result = await json(path, 200);
  assert.equal(result.shift.tokenOpeningNote, initial.note);
  assert.equal(result.totals.expectedTokens, 40);
  assert.equal(result.totals.tokenDifference, 0);
});
