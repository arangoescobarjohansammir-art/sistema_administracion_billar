import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { testServer } from './support/local-server.mjs';

const noPayment = { cash: 0, transfer: 0, tokens: 0 };

test('separa las canchas y registra cada chico y canje una sola vez', { timeout: 20000 }, async (t) => {
  const { start, stop, json, cleanup } = await testServer();
  t.after(cleanup);
  await start();
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
  assert.deepEqual(overview.physicalRedemptions.map(({ subtotal, extra }) => [subtotal, extra]), [[6000, 2000], [4000, 0], [3000, 0]]);
  const closedLargo = overview.recent.find(({ id }) => id === largo.id);
  assert.equal(closedLargo.rounds[0].benefits.find((item) => item.accountId === antonio.id).redemption.extra, 2000);
  assert.deepEqual((await json(catalog + '/' + premium.productId + '/movements', 200)).map((row) => row.units), [-1, -1, 5]);
  assert.equal((await json(account, 200)).account.balance, 2000);
  await post('/api/tejo', 201, opening);
});
