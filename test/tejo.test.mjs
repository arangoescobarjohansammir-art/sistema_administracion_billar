import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { testServer } from './support/local-server.mjs';

const noPayment = { cash: 0, transfer: 0, tokens: 0 };

test('registra productos y canastas como apuesta y separa su entrega de las fichas y el cobro', { timeout: 20000 }, async (t) => {
  const { start, stop, json, cleanup, openShift } = await testServer();
  t.after(cleanup);
  await start();
  await openShift();
  const post = (path, status, data) => json(path, status, 'POST', { ...data, requestId: data.requestId ?? randomUUID() });
  const product = (name, price, packageName, unitsPerPackage) => post('/api/products', 201, {
    name, price, packageName, unitsPerPackage, brand: '', presentation: 'Botella', active: true,
  });
  const bottle = await product('Aguardiente', 60001, '', 1);
  const beer = await product('Cerveza', 4000, 'Canasta', 30);
  const move = (id, direction, quantity) => post('/api/products/' + id + '/movements', 201, {
    direction, quantity, unit: 'unit', reason: 'Inventario de prueba',
  });
  await move(bottle.id, 'in', 1);
  await move(beer.id, 'in', 31);
  const { id } = await post('/api/tejo', 201, { courtType: 'maxi', courtNumber: 1, playerCount: 4, teamSize: 2 });
  const path = '/api/tejo/' + id;
  const onlyProducts = { withTokens: false, issueAll: false, products: [
    { productId: bottle.id, quantity: 1, unit: 'unit', unitsPerInput: 1, unitPrice: 60001 },
    { productId: beer.id, quantity: 1, unit: 'package', unitsPerInput: 30, unitPrice: 4000 },
  ] };
  await post(path + '/record', 400, { ...onlyProducts, products: [] });
  await post(path + '/record', 409, { ...onlyProducts, products: [{ ...onlyProducts.products[1], unitsPerInput: 24 }] });
  const wager = await post(path + '/record', 201, onlyProducts);
  const mixed = await post(path + '/record', 201, { withTokens: true, issueAll: true, products: [
    { ...onlyProducts.products[1], unit: 'unit', unitsPerInput: 1 },
  ] });
  const regular = await post(path + '/record', 201, { issueAll: true });
  const stock = async () => Object.fromEntries((await json('/api/products', 200)).map((item) => [item.name, item.stock]));
  assert.deepEqual(await stock(), { Aguardiente: 1, Cerveza: 31 });
  const { active: [group] } = await json('/api/tejo', 200);
  assert.deepEqual(group.rounds.map(({ id, total, benefits }) => [id, total, benefits.length]), [
    [regular.id, 16000, 4], [mixed.id, 20000, 4], [wager.id, 180001, 0],
  ]);
  await post(path + '/flex-benefits', 404, { roundId: wager.id, playerId: group.players[0].id, choice: 'token' });
  const members = (start) => group.players.slice(start, start + 2)
    .map((player, index) => ({ playerId: player.id, name: 'Jugador de prueba ' + (start + index + 1) }));
  const lossesA = [{ team: 'A', count: 1, players: members(0) }];
  const lossesB = [{ team: 'B', count: 1, players: members(2) }];
  await post(path + '/assign', 201, { roundId: regular.id, losses: lossesA });
  await post(path + '/assign', 400, { losses: lossesB });
  await post(path + '/assign', 201, { roundId: mixed.id, losses: lossesB });
  await post(path + '/assign', 201, { roundId: wager.id, losses: lossesA });
  assert.deepEqual((await json('/api/accounts', 200)).map(({ balance }) => balance), [98001, 98000, 10000, 10000]);
  await post(path + '/close', 409, {});

  await move(beer.id, 'out', 2);
  await post(path + '/stake-delivery', 409, { roundId: wager.id });
  assert.deepEqual(await stock(), { Aguardiente: 1, Cerveza: 29 });
  await move(beer.id, 'in', 2);
  const delivery = { roundId: wager.id, requestId: randomUUID() };
  await post(path + '/stake-delivery', 201, delivery);
  await post(path + '/stake-delivery', 200, delivery);
  await post(path + '/stake-delivery', 409, { roundId: wager.id });
  await post(path + '/stake-delivery', 201, { roundId: mixed.id });
  assert.deepEqual(await stock(), { Aguardiente: 0, Cerveza: 0 });
  await post(path + '/close', 201, {});
  await stop();
  await start();
  const { recent: [archived] } = await json('/api/tejo', 200);
  assert.ok(archived.rounds.filter(({ stake }) => stake.length > 0)
    .every(({ stake }) => stake.every(({ movementId }) => movementId !== null)));
  const { totals } = (await json('/api/cash', 200)).active;
  assert.deepEqual([totals.salesTotal, totals.tokensIssued, totals.cashReceived], [216001, 8, 0]);
});

test('reparte los chicos pendientes entre los integrantes del equipo perdedor', { timeout: 20000 }, async (t) => {
  const { start, stop, json, cleanup, openShift } = await testServer();
  t.after(cleanup);
  await start();
  await openShift();
  const post = (path, status, data) => json(path, status, 'POST', { ...data, requestId: data.requestId ?? randomUUID() });
  const byId = async (id) => (await json('/api/tejo', 200)).active.find((group) => group.id === id);
  await post('/api/tejo', 400, { courtType: 'maxi', courtNumber: 1, playerCount: 5, teamSize: 2 });
  for (const size of [2, 3, 4]) {
    const { id } = await post('/api/tejo', 201, { courtType: 'maxi', courtNumber: size, playerCount: size * 2, teamSize: size });
    const path = '/api/tejo/' + id;
    await post(path + '/guest', 409, {});
    await post(path + '/record', 201, { issueAll: true });
    await post(path + '/record', 201, { issueAll: true });
    let group = await byId(id);
    assert.equal(group.teamSize, size);
    assert.equal(group.rounds[0].total, size * 8000);
    assert.equal(group.rounds[0].benefits.filter(({ issuedAt }) => issuedAt).length, size * 2);
    await post(path + '/close', 409, {});
    const names = (team) => group.players.slice(team === 'A' ? 0 : size, team === 'A' ? size : undefined)
      .map(({ id: playerId }, index) => ({ playerId, name: 'Mesa ' + size + ' equipo ' + team + ' jugador ' + (index + 1) }));
    const teamA = { team: 'A', count: 1, players: names('A') };
    const teamB = { team: 'B', count: 1, players: names('B') };
    await post(path + '/assign', 400, { losses: [{ ...teamA, players: [teamB.players[0]] }] });
    await post(path + '/assign', 400, { losses: [teamA, { ...teamB, players: teamB.players.slice(1) }] });
    assert.ok((await byId(id)).rounds.every(({ losingTeam, charges }) => losingTeam === null && charges.length === 0));
    const assignment = { losses: [teamB, teamA], requestId: randomUUID() };
    await post(path + '/assign', 201, assignment);
    await post(path + '/assign', 200, assignment);
    await post(path + '/assign', 400, { losses: [teamA] });
    group = await byId(id);
    assert.deepEqual(group.rounds.map(({ losingTeam }) => losingTeam), ['B', 'A']);
    for (const round of group.rounds) {
      assert.deepEqual(round.charges.map(({ name, amount }) => [name, amount]),
        names(round.losingTeam).map(({ name }) => [name, 8000]));
    }
    await post(path + '/close', 201, {});
  }
  await stop();
  await start();
  const { recent } = await json('/api/tejo', 200);
  assert.equal(recent.length, 3);
  assert.deepEqual(recent.flatMap((group) => group.rounds.map(({ charges }) => charges.length)), [4, 4, 3, 3, 2, 2]);
  const customers = await json('/api/accounts', 200);
  assert.equal(customers.length, 18);
  assert.ok(customers.every(({ balance }) => balance === 8000));
  const { totals } = (await json('/api/cash', 200)).active;
  assert.deepEqual([totals.salesTotal, totals.tokensIssued, totals.cashReceived], [144000, 36, 0]);
});

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

test('limita fichas completas y permite anular canjes del turno con su inventario y excedente', { timeout: 20000 }, async (t) => {
  const server = await testServer();
  t.after(server.cleanup);
  await server.start();
  const { id: shiftId } = await server.openShift();
  const { json } = server;
  const post = (path, status, fields) => json(path, status, 'POST', { requestId: randomUUID(), ...fields });
  const path = '/api/tejo/redemptions';
  const corrections = '/api/corrections/redemptions';
  async function product(name, price) {
    const { id } = await post('/api/products', 201, { name, price, brand: '', presentation: 'Unidad',
      packageName: '', unitsPerPackage: 1, active: true });
    await post('/api/products/' + id + '/movements', 201, { direction: 'in', unit: 'unit', quantity: 2, reason: 'Prueba' });
    return { productId: id, quantity: 1, unitPrice: price };
  }
  const beer = await product('Cerveza ficticia', 4000);
  const snack = await product('Mecato ficticio', 3000);
  const bottle = await product('Botella ficticia', 60000);
  const sale = (tokens, item) => ({ accountId: null, tokens, items: [item], payment: noPayment });
  await post(path, 400, sale(10, beer));
  await post(path, 400, sale(2, snack));
  const closePath = '/api/cash/' + shiftId;
  assert.equal((await json(closePath, 200)).totals.expectedTokens, 100);

  const old = await post(path, 201, sale(1, beer));
  await server.stop();
  const previous = new DatabaseSync(server.databasePath);
  try {
    previous.prepare('UPDATE tejo_redemptions SET tokens = 10, allowance = 40000 WHERE id = ?').run(old.id);
  } finally { previous.close(); }
  await server.start();
  const existing = (await json(corrections, 200)).redemptions[0];
  assert.deepEqual([existing.id, existing.saleId, existing.redemptionTokens], [old.id, null, 10]);
  const count = await server.recordCashCount(shiftId, { salesCounted: 100000, purchasesCounted: 0, transferConfirmed: 0, countedTokens: 101 });
  const reversal = { requestId: randomUUID(), reason: 'Diez digitadas por error', stockReturned: true, confirmed: true };
  const oldVoid = corrections + '/' + old.id + '/void';
  await post(oldVoid, 201, reversal);
  await post(oldVoid, 200, reversal);
  await post(oldVoid, 409, { ...reversal, requestId: randomUUID() });
  const corrected = await json(closePath, 200);
  assert.equal(corrected.requiresRecount, true);
  assert.equal(corrected.totals.expectedTokens, 100);

  const partial = await post(path, 201, sale(1, snack));
  await post(corrections + '/' + partial.id + '/void', 201, { ...reversal, requestId: randomUUID(), stockReturned: false });
  const first = await post('/api/accounts', 201, { name: 'Ana de prueba' });
  const second = await post('/api/accounts', 201, { name: 'Luis de prueba' });
  const mixed = await post(path, 201, { ...sale(10, bottle), payment: { ...noPayment, cash: 5000, transfer: 4000 },
    creditShares: [{ accountId: first.id, amount: 6000 }, { accountId: second.id, amount: 5000 }] });
  const mixedVoid = corrections + '/' + mixed.id + '/void';
  const cashier = { username: 'cajera', secret: '138246' };
  await post('/api/operators', 201, { ...cashier, name: 'Cajera de prueba' });
  await server.signIn('login', cashier, 200);
  await json(corrections, 403);
  await post(mixedVoid, 403, { ...reversal, requestId: randomUUID() });
  await server.signIn('login', { username: 'admin-prueba', secret: 'clave-ficticia-2026' }, 200);
  await post(mixedVoid, 201, { ...reversal, requestId: randomUUID() });
  const totals = (await json(closePath, 200)).totals;
  assert.deepEqual([totals.salesTotal, totals.cashReceived, totals.transferExpected, totals.pendingBalance, totals.tokensRedeemed],
    [0, 0, 0, 0, 0]);
  assert.deepEqual((await json(path, 200)).map(({ voidedAt }) => Boolean(voidedAt)), [true, true, true]);
  assert.equal((await json('/api/tejo', 200)).tokenCounts.redeemed, 0);
  assert.deepEqual(Object.fromEntries((await json('/api/products', 200)).map(({ id, stock }) => [id, stock])),
    { [beer.productId]: 2, [snack.productId]: 1, [bottle.productId]: 2 });
  const newCount = await server.recordCashCount(shiftId,
    { salesCounted: 100000, purchasesCounted: 0, transferConfirmed: 0, countedTokens: 100 }, count.countId, 'Canjes anulados');
  await post(closePath + '/close', 201, { ...newCount, nextBase: 100000, note: '' });
  assert.equal((await server.fetch(closePath + '/report.pdf')).status, 200);
  assert.equal((await json('/api/audit', 200)).filter(({ kind }) => kind === 'redemption_void').length, 3);
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
  const thirdRound = await post(path + '/record', 201, { issueAll: true });
  assert.deepEqual(await json('/api/accounts', 200), []);
  assert.equal((await json('/api/cash', 200)).active.totals.salesTotal, 0);
  await post(path + '/close', 409, {});
  await post(path + '/assign', 400, { losses: [{ playerId: third.id, count: 2, name: 'No asignado' }] });
  await post(path + '/assign', 400, { losses: [{ playerId: one.id, count: 1 }] });
  assert.deepEqual(await json('/api/accounts', 200), []);
  await stop();
  await start();
  await post(path + '/assign', 201, { roundId: thirdRound.id, losses: [
    { playerId: third.id, count: 1, name: 'Andrés' },
  ] });
  const settlement = { requestId: randomUUID(), losses: [
    { playerId: one.id, count: 2, name: 'Laura' },
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

test('identifica el chico perdido cuando los pendientes tienen distintos importes', { timeout: 20000 }, async (t) => {
  const { start, json, cleanup, openShift } = await testServer();
  t.after(cleanup);
  await start();
  await openShift();
  const post = (path, status, data) => json(path, status, 'POST', { ...data, requestId: data.requestId ?? randomUUID() });
  const { id } = await post('/api/tejo', 201, { courtType: 'maxi', courtNumber: 1, playerCount: 2 });
  const path = '/api/tejo/' + id;
  const first = await post(path + '/record', 201, { issueAll: true });
  const guest = await post(path + '/guest', 201, {});
  const second = await post(path + '/record', 201, { issueAll: true });
  const { players: [one, two] } = (await json('/api/tejo', 200)).active[0];
  const losses = [
    { playerId: one.id, count: 1, name: 'Ana' },
    { playerId: two.id, count: 1, name: 'Luis' },
  ];
  const blocked = await post(path + '/assign', 400, { losses });
  assert.match(blocked.error, /chicos pendientes de distinto valor/);
  await post(path + '/assign', 400, { roundId: first.id, losses: [{ playerId: guest.id, count: 1, name: 'Invitado' }] });
  assert.deepEqual(await json('/api/accounts', 200), []);
  assert.equal((await json('/api/cash', 200)).active.totals.salesTotal, 0);

  const assignment = { roundId: second.id, losses: [losses[1]], requestId: randomUUID() };
  await post(path + '/assign', 201, assignment);
  await post(path + '/assign', 200, assignment);
  await post(path + '/assign', 400, { ...assignment, requestId: randomUUID() });
  await post(path + '/assign', 201, { roundId: first.id, losses: [losses[0]] });
  const { rounds } = (await json('/api/tejo', 200)).active[0];
  assert.deepEqual(rounds.map(({ id, loser, total }) => [id, loser, total]),
    [[second.id, 'Luis', 12_000], [first.id, 'Ana', 8000]]);
  assert.deepEqual((await json('/api/accounts', 200)).map(({ name, balance }) => [name, balance]),
    [['Luis', 12_000], ['Ana', 8000]]);
  const { salesTotal, tokensIssued } = (await json('/api/cash', 200)).active.totals;
  assert.deepEqual([salesTotal, tokensIssued], [20_000, 5]);
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
