import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { testServer } from './support/local-server.mjs';

const noPayment = { cash: 0, transfer: 0, tokens: 0 };

test('registra chicos con fichas pendientes y entrega solo las disponibles', { timeout: 20000 }, async (t) => {
  const { start, json, fetch, cleanup, openShift } = await testServer();
  t.after(cleanup);
  await start();
  await openShift(100_000, 1);
  const post = (path, status, data) => json(path, status, 'POST', { ...data, requestId: data.requestId ?? randomUUID() });
  const readCash = async () => (await json('/api/cash', 200)).active.totals;
  const { id } = await post('/api/tejo', 201, { courtType: 'largo', courtNumber: 1, playerCount: 2 });
  const path = '/api/tejo/' + id;
  const registration = { issueAll: true, requestId: randomUUID() };
  const { id: roundId } = await post(path + '/record', 201, registration);
  const { active: [group], availableTokens } = await json('/api/tejo', 200);
  assert.equal(availableTokens, 1);
  assert.equal(group.rounds.length, 1);
  assert.deepEqual(group.rounds[0].benefits.map(({ issuedAt }) => issuedAt), [null, null]);
  assert.equal((await readCash()).expectedTokens, 1);

  const attempts = group.players.map(({ id: playerId }) => ({
    roundId, playerId, choice: 'token', requestId: randomUUID(),
  }));
  const responses = await Promise.all(attempts.map((attempt) => fetch(path + '/flex-benefits', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(attempt),
  })));
  assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 409]);
  const deliveredIndex = responses.findIndex(({ status }) => status === 201);
  await post(path + '/flex-benefits', 200, attempts[deliveredIndex]);
  assert.equal((await readCash()).expectedTokens, 0);

  await post(path + '/assign', 201, { losses: [{ playerId: group.players[0].id, count: 1, name: 'Laura' }] });
  const [account] = await json('/api/accounts', 200);
  await post('/api/accounts/' + account.id + '/payments', 201, { payment: { ...noPayment, tokens: 1 } });
  assert.equal((await readCash()).expectedTokens, 1);
  assert.equal((await post(path + '/record', 200, registration)).id, roundId);
  await post(path + '/flex-benefits', 201, attempts[1 - deliveredIndex]);
  const { tokensIssued, tokensReceived, expectedTokens } = await readCash();
  assert.deepEqual({ tokensIssued, tokensReceived, expectedTokens }, { tokensIssued: 2, tokensReceived: 1, expectedTokens: 0 });
  await post(path + '/close', 201, {});

  const second = await json('/api/accounts', 201, 'POST', { name: 'Andrés' });
  const legacy = await post('/api/tejo', 201, { courtType: 'maxi', courtNumber: 1, players: [account.id, second.id] });
  const legacyPath = '/api/tejo/' + legacy.id;
  const legacyRound = await post(legacyPath + '/rounds', 201, { loserId: second.id, issueAll: true, payment: noPayment });
  await post(legacyPath + '/benefits', 409, { roundId: legacyRound.id, playerId: second.id, choice: 'token' });
  const updated = await json('/api/tejo', 200);
  assert.deepEqual(updated.active[0].rounds[0].benefits.map(({ issuedAt }) => issuedAt), [null, null]);
  assert.equal((await readCash()).expectedTokens, 0);
});

test('separa las canchas y registra cada chico y canje una sola vez', { timeout: 20000 }, async (t) => {
  const { start, stop, json, cleanup, openShift, recordCashCount } = await testServer();
  t.after(cleanup);
  await start();
  const shift = await openShift();
  const post = (path, status, data) => json(path, status, 'POST', { ...data, requestId: data.requestId ?? randomUUID() });
  const antonio = await json('/api/accounts', 201, 'POST', { name: 'Antonio' });
  const beatriz = await json('/api/accounts', 201, 'POST', { name: 'Beatriz' });
  const people = [antonio.id, beatriz.id];
  const opening = { courtType: 'maxi', courtNumber: 6, players: people };
  await post('/api/tejo', 400, { ...opening, courtNumber: 7 });
  await post('/api/tejo', 400, { ...opening, players: [antonio.id, antonio.id] });
  const maxi = await post('/api/tejo', 201, opening);
  const largo = await post('/api/tejo', 201, { ...opening, courtType: 'largo' });
  await post('/api/tejo', 409, opening);
  const maxiPath = '/api/tejo/' + maxi.id;
  const largoPath = '/api/tejo/' + largo.id;
  const result = { loserId: antonio.id, issueAll: true, payment: noPayment, requestId: randomUUID() };
  const first = await post(maxiPath + '/rounds', 201, result);
  assert.equal((await post(maxiPath + '/rounds', 200, result)).id, first.id);
  await post(maxiPath + '/rounds', 201, { ...result, requestId: randomUUID() });
  await post(maxiPath + '/rounds', 201, { ...result, requestId: randomUUID() });

  const account = '/api/accounts/' + antonio.id;
  assert.equal((await json(account, 200)).account.balance, 24_000);
  let overview = await json('/api/tejo', 200);
  assert.deepEqual(overview.active.find(({ id }) => id === maxi.id).rounds.map(({ number, total, benefits }) => [
    number, total, benefits.filter(({ issuedAt }) => issuedAt).length,
  ]), [[3, 8000, 2], [2, 8000, 2], [1, 8000, 2]]);
  assert.equal(overview.active.find(({ id }) => id === largo.id).rounds.length, 0);
  assert.equal(overview.tokenCounts.issued, 6);
  await post(account + '/payments', 201, { payment: { cash: 15_000, transfer: 0, tokens: 3 } });
  assert.equal((await json(account, 200)).account.balance, 0);
  await post(maxiPath + '/close', 201, {});

  const catalog = '/api/products';
  async function product(name, price) {
    const data = await json(catalog, 201, 'POST', {
      name, brand: '', presentation: 'Unidad', price, packageName: '', unitsPerPackage: 1, active: true,
    });
    await json(catalog + '/' + data.id + '/movements', 201, 'POST', {
      direction: 'in', unit: 'unit', quantity: 5, reason: 'Existencia inicial',
    });
    return { productId: data.id, quantity: 1, unitPrice: price };
  }
  const beer = await product('Cerveza', 4000);
  const premium = await product('Jugo especial', 6000);
  const snacks = await product('Papas', 3000);
  const supplement = await product('Dulce', 1000);
  const round = await post(largoPath + '/rounds', 201, {
    loserId: beatriz.id, issueAll: false, payment: { cash: 5000, transfer: 3000, tokens: 0 },
  });
  await post(largoPath + '/close', 409, {});

  const benefit = { roundId: round.id, playerId: antonio.id, choice: 'products', items: [premium], payment: noPayment, requestId: randomUUID() };
  await post(largoPath + '/benefits', 201, benefit);
  await post(largoPath + '/benefits', 200, benefit);
  await post(largoPath + '/benefits', 409, { roundId: round.id, playerId: antonio.id, choice: 'token' });
  assert.equal((await json(account, 200)).account.balance, 2000);
  const covered = { roundId: round.id, playerId: beatriz.id, choice: 'products', items: [beer], payment: noPayment };
  await post(largoPath + '/benefits', 201, covered);
  assert.equal((await json('/api/accounts/' + beatriz.id, 200)).account.balance, 0);
  assert.deepEqual((await json(catalog + '/' + premium.productId + '/movements', 200)).map((row) => row.units), [-1, 5]);
  await post(largoPath + '/close', 201, {});

  const physical = '/api/tejo/redemptions';
  await post(physical, 400, { tokens: 1, accountId: null, items: [premium], payment: noPayment });
  await post(physical, 400, { tokens: 1, accountId: null, items: [snacks], payment: { ...noPayment, cash: 1000 } });
  await post(physical, 201, { tokens: 1, accountId: null, items: [snacks], payment: noPayment });
  await post(physical, 201, { tokens: 1, accountId: null, items: [snacks, supplement], payment: noPayment });
  await post(physical, 201, { tokens: 1, accountId: null, items: [premium], payment: { ...noPayment, transfer: 2000 } });

  await stop();
  await start();
  overview = await json('/api/tejo', 200);
  assert.equal(overview.active.length, 0);
  assert.deepEqual(overview.tokenCounts, { issued: 6, redeemed: 3, receivedAsPayment: 3 });
  const cash = (await json('/api/cash', 200)).active.totals;
  assert.equal(cash.tokensIssued, 6);
  assert.equal(cash.tokensRedeemed, 3);
  assert.equal(cash.tokensReceived, 3);
  assert.equal(cash.tokenAmount, 9000);
  assert.equal(cash.expectedTokens, 100);
  assert.deepEqual(overview.physicalRedemptions.map(({ subtotal, extra }) => [subtotal, extra]), [[6000, 2000], [4000, 0], [3000, 0]]);
  assert.deepEqual(await json('/api/tejo/redemptions', 200), overview.physicalRedemptions);
  const closedLargo = overview.recent.find(({ id }) => id === largo.id);
  assert.equal(closedLargo.rounds[0].benefits.find((item) => item.accountId === antonio.id).redemption.extra, 2000);
  assert.deepEqual((await json(catalog + '/' + premium.productId + '/movements', 200)).map((row) => row.units), [-1, -1, 5]);
  assert.equal((await json(account, 200)).account.balance, 2000);
  const count = {
    salesCounted: cash.salesExpected, purchasesCounted: cash.purchasesExpected,
    transferConfirmed: cash.transferExpected, countedTokens: 98,
  };
  const cashPath = '/api/cash/' + shift.id;
  const close = { ...await recordCashCount(shift.id, count), nextBase: 100_000, note: '' };
  await post(cashPath + '/close', 400, close);
  await post(cashPath + '/close', 201, { ...close, note: 'El conteo físico quedó corto por dos fichas.' });
  const closed = await json(cashPath, 200);
  assert.equal(closed.shift.openingTokens, 100);
  assert.equal(closed.shift.countedTokens, 98);
  assert.equal(closed.totals.tokenDifference, -2);
  assert.equal((await json('/api/cash', 200)).previousTokens, 98);
  await post('/api/cash', 400, { cashier: 'Siguiente', openingBase: 100_000, openingTokens: 100, note: '' });
  const nextShift = await openShift(100_000, 98);
  assert.equal((await json('/api/cash/' + nextShift.id, 200)).totals.expectedTokens, 98);
  await post('/api/tejo', 201, opening);
});

test('distingue diez fichas de canje por productos de las fichas de abono', { timeout: 20000 }, async (t) => {
  const { start, json, cleanup, openShift } = await testServer();
  t.after(cleanup);
  await start();
  await openShift();
  const post = (path, status, data) => json(path, status, 'POST', { ...data, requestId: data.requestId ?? randomUUID() });
  const customer = await json('/api/accounts', 201, 'POST', { name: 'Cuenta pendiente' });
  const bottle = await json('/api/products', 201, 'POST', {
    name: 'Aguardiente', brand: '', presentation: 'Botella', price: 60000,
    packageName: '', unitsPerPackage: 1, active: true,
  });
  await json('/api/products/' + bottle.id + '/movements', 201, 'POST', {
    direction: 'in', unit: 'unit', quantity: 2, reason: 'Prueba',
  });
  const items = [{ productId: bottle.id, quantity: 1, unitPrice: 60000 }];
  const sale = { accountId: null, items, tokens: 10, payment: { ...noPayment, cash: 20000 }, requestId: randomUUID() };
  await post('/api/tejo/redemptions', 201, sale);
  await post('/api/tejo/redemptions', 200, sale);
  const [redemption] = await json('/api/tejo/redemptions', 200);
  assert.deepEqual([redemption.tokens, redemption.allowance, redemption.subtotal, redemption.extra], [10, 40000, 60000, 20000]);
  await post('/api/sales', 201, { accountId: customer.id, items, payment: noPayment });
  await post('/api/accounts/' + customer.id + '/payments', 201, { payment: { ...noPayment, tokens: 10 } });
  const account = await json('/api/accounts/' + customer.id, 200);
  assert.equal(account.account.balance, 30000);
  assert.equal(account.payments[0].tokenValue, 3000);
  assert.equal((await json('/api/products', 200))[0].stock, 0);
  const { totals } = (await json('/api/cash', 200)).active;
  assert.equal(totals.tokensRedeemed, 10);
  assert.equal(totals.tokensReceived, 10);
  assert.equal(totals.cashReceived, 20000);
});

test('acepta jugadores sin nombre y asigna los chicos por cantidad después de jugar', { timeout: 20000 }, async (t) => {
  const { start, stop, json, cleanup, openShift } = await testServer();
  t.after(cleanup);
  await start();
  await openShift();
  const post = (path, status, data) => json(path, status, 'POST', { ...data, requestId: data.requestId ?? randomUUID() });
  const { id } = await post('/api/tejo', 201, { courtType: 'largo', courtNumber: 4, playerCount: 2 });
  const path = '/api/tejo/' + id;
  const beer = await json('/api/products', 201, 'POST', {
    name: 'Cerveza', brand: '', presentation: 'Unidad', price: 4000,
    packageName: '', unitsPerPackage: 1, active: true,
  });
  const stockPath = '/api/products/' + beer.id + '/movements';
  await json(stockPath, 201, 'POST', { direction: 'in', unit: 'unit', quantity: 2, reason: 'Existencias' });
  const first = await post(path + '/record', 201, { issueAll: false });
  let group = (await json('/api/tejo', 200)).active.find((item) => item.id === id);
  const [one, two] = group.players;
  assert.equal(one.name, 'Jugador 1');
  assert.equal(one.accountId, null);
  const benefit = {
    roundId: first.id, playerId: one.id, choice: 'products', items: [{ productId: beer.id, unitPrice: 4000, quantity: 1 }],
    payment: noPayment, accountId: null, requestId: randomUUID(),
  };
  await post(path + '/flex-benefits', 201, benefit);
  await post(path + '/flex-benefits', 200, benefit);
  await post(path + '/flex-benefits', 201, { roundId: first.id, playerId: two.id, choice: 'token' });
  const secondRequest = { issueAll: true, requestId: randomUUID() };
  await post(path + '/record', 201, secondRequest);
  await post(path + '/record', 200, secondRequest);
  const third = await post(path + '/guest', 201, {});
  await post(path + '/record', 201, { issueAll: true });
  assert.deepEqual(await json('/api/accounts', 200), []);
  assert.equal((await json('/api/cash', 200)).active.totals.salesTotal, 0);
  await post(path + '/close', 409, {});
  await post(path + '/assign', 400, { losses: [{ playerId: third.id, count: 2, name: 'No asignado' }] });
  await post(path + '/assign', 400, { losses: [{ playerId: one.id, count: 1 }] });
  assert.deepEqual(await json('/api/accounts', 200), []);
  await stop();
  await start();
  const settlement = { requestId: randomUUID(), losses: [
    { playerId: one.id, count: 2, name: 'Laura' },
    { playerId: third.id, count: 1, name: 'Andrés' },
  ] };
  await post(path + '/assign', 201, settlement);
  await post(path + '/assign', 200, settlement);
  const accounts = await json('/api/accounts', 200);
  assert.deepEqual(accounts.map(({ name, balance }) => [name, balance]), [['Laura', 16000], ['Andrés', 12000]]);
  const cash = (await json('/api/cash', 200)).active.totals;
  assert.equal(cash.tokensIssued, 6);
  assert.equal(cash.expectedTokens, 94);
  assert.deepEqual((await json(stockPath, 200)).map((item) => item.units), [-1, 2]);
  group = (await json('/api/tejo', 200)).active.find((item) => item.id === id);
  assert.deepEqual(group.rounds.map(({ loser, total }) => [loser, total]), [['Andrés', 12000], ['Laura', 8000], ['Laura', 8000]]);
  await post(path + '/close', 201, {});
});

test('continúa una cancha abierta antes de la actualización, con sus chicos y fichas pendientes', { timeout: 20000 }, async (t) => {
  const { start, stop, json, cleanup, openShift } = await testServer();
  t.after(cleanup);
  await start();
  await openShift();
  const post = (path, status, data) => json(path, status, 'POST', { ...data, requestId: randomUUID() });
  const first = await json('/api/accounts', 201, 'POST', { name: 'Camila' });
  const second = await json('/api/accounts', 201, 'POST', { name: 'Miguel' });
  const session = await post('/api/tejo', 201, {
    courtType: 'maxi', courtNumber: 2, players: [first.id, second.id],
  });
  const path = '/api/tejo/' + session.id;
  const round = await post(path + '/rounds', 201, { loserId: first.id, issueAll: false, payment: noPayment });
  await stop();
  await start();
  const [group] = (await json('/api/tejo', 200)).active;
  assert.equal(group.flexible, true);
  assert.equal(group.rounds[0].loser, 'Camila');
  assert.equal(group.rounds[0].loserId, group.players.find((player) => player.name === 'Camila').id);
  const newcomer = await post(path + '/guest', 201, {});
  await post(path + '/record', 201, { issueAll: true });
  await post(path + '/assign', 201, { losses: [{ playerId: newcomer.id, count: 1, name: 'Sara' }] });
  const [updated] = (await json('/api/tejo', 200)).active;
  assert.deepEqual(updated.rounds.map(({ number, loser, total }) => [number, loser, total]), [[2, 'Sara', 12000], [1, 'Camila', 8000]]);
  await post(path + '/close', 409, {});
  for (const person of [first, second]) {
    await post(path + '/benefits', 201, { roundId: round.id, playerId: person.id, choice: 'token' });
  }
  await post(path + '/close', 201, {});
  assert.equal((await json('/api/cash', 200)).active.totals.tokensIssued, 5);
});
