import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { testServer } from './support/local-server.mjs';

test('revierte un abono mixto y traslada el cargo individual sin duplicar el chico ni sus fichas', { timeout: 20000 }, async (t) => {
  const server = await testServer();
  t.after(server.cleanup);
  await server.start();
  const { json } = server;
  const post = (path, status, data) => json(path, status, 'POST', { requestId: randomUUID(), ...data });
  const { id: shiftId } = await server.openShift();
  const shiftPath = '/api/cash/' + shiftId;
  const ana = await post('/api/accounts', 201, { name: 'Ana' });
  const luis = await post('/api/accounts', 201, { name: 'Luis' });
  const detail = (account) => json('/api/accounts/' + account.id, 200);
  const { id: sessionId } = await post('/api/tejo', 201, { courtType: 'maxi', courtNumber: 1, playerCount: 2 });
  const tejo = async () => (await json('/api/tejo', 200)).active.find(({ id }) => id === sessionId);
  await post('/api/tejo/' + sessionId + '/record', 201, { issueAll: true });
  const [{ id: playerId }] = (await tejo()).players;
  await post('/api/tejo/' + sessionId + '/assign', 201, { losses: [{ playerId, count: 1, accountId: ana.id }] });
  const [charge] = (await json('/api/corrections/tejo', 200)).entries;
  assert.equal(charge.total, 8000);
  const beforePayment = (await detail(ana)).history.current;
  const { id: paymentId } = await post('/api/accounts/' + ana.id + '/payments', 201, {
    payment: { cash: 2000, transfer: 3000, tokens: 1 },
  });
  const paymentsPath = '/api/corrections/payments';
  const voidPath = paymentsPath + '/' + paymentId + '/void';
  const movePath = '/api/corrections/tejo/' + charge.id + '/move';
  const reversal = { requestId: randomUUID(), reason: 'Abono digitado por error', confirmed: true };
  const transfer = { requestId: randomUUID(), accountId: luis.id, reason: 'Cliente equivocado', confirmed: true };
  assert.equal((await detail(ana)).history.current, null);
  assert.equal((await json(paymentsPath, 200)).entries[0].id, paymentId);
  await post(movePath, 409, transfer);

  const cashier = { name: 'Cajera', username: 'cajera', secret: '138246' };
  await post('/api/operators', 201, cashier);
  await server.signIn('login', cashier, 200);
  await json(paymentsPath, 403);
  await post(voidPath, 403, reversal);
  await post(movePath, 403, transfer);
  await server.signIn('login', { username: 'admin-prueba', secret: 'clave-ficticia-2026' }, 200);

  await post(voidPath, 400, { ...reversal, confirmed: false });
  await post(voidPath, 201, reversal);
  await post(voidPath, 200, reversal);
  await post(voidPath, 409, { ...reversal, requestId: randomUUID() });
  const reopened = await detail(ana);
  assert.equal(reopened.account.balance, 8000);
  assert.equal(reopened.history.current.id, beforePayment.id);
  assert.deepEqual(reopened.history.current.movements.map(({ kind, balanceAfter }) => [kind, balanceAfter]),
    [['sale', 8000], ['payment', 0], ['payment_void', 8000]]);
  const { totals, payments } = await json(shiftPath, 200);
  assert.deepEqual([totals.cashReceived, totals.transferExpected, totals.expectedTokens, totals.accountCollections], [0, 0, 98, 0]);
  assert.equal(payments.find(({ id }) => id === paymentId)?.voidReason, reversal.reason);
  assert.equal((await json(paymentsPath, 200)).entries[0].voidReason, reversal.reason);

  await post(movePath, 400, { ...transfer, accountId: ana.id });
  const moved = await post(movePath, 201, transfer);
  assert.equal((await post(movePath, 200, transfer)).id, moved.id);
  await post(movePath, 409, { ...transfer, requestId: randomUUID() });
  const oldAccount = await detail(ana);
  assert.equal(oldAccount.account.balance, 0);
  assert.equal(oldAccount.sales.find(({ id }) => id === charge.id)?.voided, true);
  assert.equal(oldAccount.payments.find(({ id }) => id === paymentId)?.voided, 1);
  assert.equal((await detail(luis)).account.balance, 8000);
  const [round] = (await tejo()).rounds;
  assert.deepEqual([round.saleId, round.chargedTo, round.loserId, round.loser], [moved.id, 'Luis', playerId, 'Ana']);
  const after = (await json(shiftPath, 200)).totals;
  assert.deepEqual([after.salesCount, after.salesTotal, after.expectedTokens], [1, 8000, 98]);
  const audit = await json('/api/audit', 200);
  assert.equal(audit.find(({ kind, targetId }) => kind === 'account_payment_void' && targetId === paymentId)?.actorName, 'Administrador de prueba');
  assert.equal(audit.find(({ kind, targetId }) => kind === 'tejo_charge_move' && targetId === charge.id)?.actorName, 'Administrador de prueba');

  const team = await post('/api/tejo', 201, { courtType: 'maxi', courtNumber: 2, playerCount: 4, teamSize: 2 });
  const teamPath = '/api/tejo/' + team.id;
  const teamRound = async () => (await json('/api/tejo', 200)).active.find(({ id }) => id === team.id);
  await post(teamPath + '/record', 201, { issueAll: true });
  const [first, second] = (await teamRound()).players;
  await post(teamPath + '/assign', 201, { losses: [{ team: 'A', count: 1, players: [
    { playerId: first.id, name: 'Ana' }, { playerId: second.id, name: 'Carlos' },
  ] }] });
  const teamCharge = (await json('/api/corrections/tejo', 200)).entries.find(({ courtNumber, customer }) => courtNumber === 2 && customer === 'Ana');
  await post('/api/corrections/tejo/' + teamCharge.id + '/move', 201, { ...transfer, requestId: randomUUID() });
  const [played] = (await teamRound()).rounds;
  assert.equal(played.losingTeam, 'A');
  assert.deepEqual(played.charges.map(({ name, amount }) => [name, amount]), [['Luis', 8000], ['Carlos', 8000]]);
  assert.equal((await json(shiftPath, 200)).totals.expectedTokens, 94);

  const counted = await server.recordCashCount(shiftId, { salesCounted: 100000, purchasesCounted: 0, transferConfirmed: 0, countedTokens: 94 });
  await post(shiftPath + '/close', 201, { ...counted, nextBase: 100000, note: '' });
  assert.deepEqual((await json('/api/corrections/tejo', 200)).entries, []);
  await post('/api/corrections/tejo/' + moved.id + '/move', 409, { ...transfer, accountId: ana.id, requestId: randomUUID() });
  await server.openShift(100000, 94);
  await post('/api/corrections/tejo/' + moved.id + '/move', 409, { ...transfer, accountId: ana.id, requestId: randomUUID() });
});
