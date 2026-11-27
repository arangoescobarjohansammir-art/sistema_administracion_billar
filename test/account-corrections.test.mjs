import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { accountingPeriod, accountingReport, colombianDay } from '../dist/shared/accounting.js';
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

test('traslada solo la parte fiada de billar y conserva la liquidación y el cuadre', { timeout: 20000 }, async (t) => {
  const server = await testServer();
  t.after(server.cleanup);
  await server.start();
  const { json } = server;
  const post = (path, status, data) => json(path, status, 'POST', { requestId: randomUUID(), ...data });
  const { id: shift } = await server.openShift();
  const shiftPath = '/api/cash/' + shift;
  const [ana, luis, carlos, beatriz] = await Promise.all(['Ana', 'Luis', 'Carlos', 'Beatriz'].map((name) =>
    post('/api/accounts', 201, { name })));
  const detail = (account) => json('/api/accounts/' + account.id, 200);
  const { id: productId } = await post('/api/products', 201, {
    name: 'Cerveza', brand: '', presentation: 'Botella', price: 8000, packageName: '', unitsPerPackage: 1, active: true,
  });
  await post('/api/products/' + productId + '/movements', 201, {
    direction: 'in', quantity: 5, unit: 'unit', reason: 'Saldo inicial',
  });
  const { id: session } = await post('/api/billiards', 201, { table: 2 });
  const tablePath = '/api/billiards/' + session;
  await post(tablePath + '/items', 201, { productId, quantity: 3, unitPrice: 8000 });
  await post(tablePath + '/stop', 201, {});
  const [table] = (await json('/api/billiards', 200)).active;
  const noPayment = { cash: 0, transfer: 0, tokens: 0 };
  const part = (account, time = 0, payment = noPayment) => ({
    accountId: account.id, time, items: [{ id: table.items[0].id, amount: 8000 }], payment,
  });
  await post(tablePath + '/close', 201, { participants: [
    part(ana), part(carlos), part(beatriz, table.time, { cash: 2000, transfer: 3000, tokens: 1 }),
  ] });
  const path = '/api/corrections/billiards';
  const { entries } = await json(path, 200);
  assert.equal(entries.length, 3);
  const wrong = entries.find(({ accountId }) => accountId === ana.id);
  const paid = entries.find(({ accountId }) => accountId === beatriz.id);
  assert.deepEqual([wrong.total, wrong.tableNumber, wrong.sessionId, wrong.hasPayment, paid.hasPayment], [8000, 2, session, 0, 1]);
  const movePath = path + '/' + wrong.id + '/move';
  const transfer = { requestId: randomUUID(), accountId: luis.id, reason: 'La mesa correspondía a Luis', confirmed: true };
  const cashier = { name: 'Cajera', username: 'cajera', secret: '138246' };
  await post('/api/operators', 201, cashier);
  await server.signIn('login', cashier, 200);
  await json(path, 403);
  await post(movePath, 403, transfer);
  await server.signIn('login', { username: 'admin-prueba', secret: 'clave-ficticia-2026' }, 200);
  await post(movePath, 400, { ...transfer, accountId: ana.id });
  await post(movePath, 400, { ...transfer, reason: '   ' });
  await post(path + '/' + paid.id + '/move', 409, { ...transfer, requestId: randomUUID() });
  const { id: paymentId } = await post('/api/accounts/' + ana.id + '/payments', 201, {
    payment: { ...noPayment, cash: 1000 },
  });
  await post(movePath, 409, transfer);
  await post('/api/corrections/payments/' + paymentId + '/void', 201, { reason: 'Prueba del saldo', confirmed: true });

  const { totals: before } = await json(shiftPath, 200);
  const legalSales = (await detail(ana)).sales[0].items;
  const moved = await post(movePath, 201, transfer);
  assert.equal((await post(movePath, 200, transfer)).id, moved.id);
  await post(movePath, 409, { ...transfer, requestId: randomUUID() });
  const original = await detail(ana);
  assert.equal(original.account.balance, 0);
  assert.ok(original.sales[0].transferred && original.sales[0].voided);
  assert.ok(original.history.closed.flatMap(({ movements }) => movements)
    .some(({ reason }) => reason?.includes(transfer.reason)));
  const corrected = await detail(luis);
  assert.equal(corrected.account.balance, 8000);
  assert.deepEqual(corrected.sales[0].items, legalSales);
  assert.equal((await detail(carlos)).account.balance, 8000);
  const [{ shares }] = (await json('/api/billiards', 200)).recent;
  assert.deepEqual(shares.map(({ name }) => name).sort(), ['Beatriz', 'Carlos', 'Luis']);
  assert.equal((await json('/api/products', 200))[0].stock, 2);
  assert.deepEqual((await json(shiftPath, 200)).totals, before);
  const audit = await json('/api/audit', 200);
  assert.equal(audit.find(({ kind, targetId }) => kind === 'billiard_charge_move' && targetId === wrong.id)?.actorName, 'Administrador de prueba');

  const day = colombianDay.format(new Date());
  const period = accountingPeriod('month', day);
  const data = await json('/api/reports?kind=month&anchor=' + day.slice(0, 7), 200);
  const report = accountingReport(data, period);
  assert.deepEqual([report.amounts.sales, report.amounts.voidedSales, report.days.find((row) => row.day === day).transactions],
    [24_000 + table.time, 0, 3]);
  assert.equal(report.accounts.find(({ name }) => name === 'Luis').closing, 8000);
  const count = await server.recordCashCount(shift, {
    salesCounted: 102000, purchasesCounted: 0, transferConfirmed: 3000, countedTokens: 101,
  });
  await post(shiftPath + '/close', 201, { ...count, nextBase: 100000, note: '' });
  assert.equal((await server.fetch(shiftPath + '/report.pdf')).status, 200);
  await server.openShift(100000, 101);
  await post(path + '/' + moved.id + '/move', 409, { ...transfer, accountId: ana.id, requestId: randomUUID() });
});
