import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { accountingPeriod, accountingReport, colombianDay } from '../dist/shared/accounting.js';
import { readAccounting } from '../dist/server/accounting.js';
import { accountingMoney, accountingTables, accountingTotals } from '../dist/shared/accounting-tables.js';
import { testServer } from './support/local-server.mjs';

test('calcula el saldo al corte y aplica las correcciones en su fecha colombiana', async (t) => {
  const server = await testServer();
  let database;
  t.after(async () => { database?.close(); await server.cleanup(); });
  await server.start();
  await server.stop();
  database = new DatabaseSync(server.databasePath);
  database.exec(`
    INSERT INTO customer_accounts VALUES (1, 'Ana de prueba', 'ana', '2026-08-01T05:00:00.000Z');
    INSERT INTO cash_shifts (id, cashier, opened_at, opening_base, opening_note, opening_tokens, closed_at,
      sales_expected, sales_counted, purchases_expected, purchases_counted, transfer_expected, transfer_confirmed,
      expected_tokens, counted_tokens, next_base, closing_note)
      VALUES (1, 'Cajera ficticia', '2026-09-06T19:00:00.000Z', 100000, '', 100, '2026-09-07T05:00:00.000Z',
        115000, 114000, 0, 0, 10000, 10000, 100, 101, 100000, 'Revisar el conteo.');
    INSERT INTO sales VALUES
      (1, 1, 40000, '2026-09-07T04:59:59.999Z'),
      (2, NULL, 20000, '2026-09-07T05:00:00.000Z'),
      (3, 1, 30000, '2026-09-14T05:00:00.000Z');
    INSERT INTO account_payments VALUES
      (1, 1, NULL, 5000, 0, 0, 3000, '2026-09-06T15:00:00.000Z'),
      (2, NULL, 2, 10000, 6000, 1, 4000, '2026-09-07T05:00:00.000Z'),
      (3, 1, NULL, 0, 7000, 1, 3000, '2026-09-08T05:00:00.000Z');
    INSERT INTO account_payment_voids VALUES (3, '2026-09-09T05:00:00.000Z', 'Abono inválido');
    INSERT INTO sale_voids VALUES (2, '2026-09-10T05:00:00.000Z', 'Venta duplicada', 1);
    INSERT INTO cash_movements VALUES (1, 1, 'purchase_in', 500000, 0, 500000, 'Compras', 'Bebidas', '2026-09-07T04:59:00.000Z'),
      (2, 1, 'purchase_expense', 16000, 0, -16000, 'Compras', 'Proveedor', '2026-09-07T05:00:00.000Z');
  `);
  const period = accountingPeriod('week', '2026-09-12');
  assert.deepEqual(period, { from: '2026-09-07', to: '2026-09-13' });
  assert.equal(accountingPeriod('month', '2026-02').to, '2026-02-28');
  assert.equal(accountingPeriod('week', '2026-02-30'), null);
  const month = accountingPeriod('month', '2026-09');
  const cutoff = new Date('2026-09-30T19:00:00.000Z');
  const data = readAccounting(database, month, cutoff);
  const week = accountingReport(data, period);
  assert.deepEqual(week, accountingReport(readAccounting(database, period, cutoff), period));
  assert.deepEqual(week.accounts.map(({ opening, charges, payments, closing }) => [opening, charges, payments, closing]), [[35000, 0, 0, 35000]]);
  assert.deepEqual(week.days.map(({ day, sales, cash, transfer, tokens }) => [day, sales, cash, transfer, tokens]), [
    ['2026-09-07', 20000, 10000, 6000, 1],
    ['2026-09-08', 0, 0, 7000, 1],
    ['2026-09-09', 0, 0, -7000, -1],
    ['2026-09-10', -20000, -10000, -6000, -1],
  ]);
  assert.equal(week.amounts.voidedSales, 20000);
  assert.deepEqual(week.movements.map(({ id }) => id), [2]);
  assert.deepEqual(week.closes.map(({ id }) => id), [1]);
  assert.equal(accountingReport(data, month).accounts[0].closing, 65000);
});

test('descuenta el pago diario solo de ventas y lo muestra por empleado en los reportes', async (t) => {
  const server = await testServer();
  t.after(server.cleanup);
  await server.start();
  const { id } = await server.openShift(100000, 100);
  const path = '/api/cash/' + id;
  const post = (url, status, fields) => server.json(url, status, 'POST', { requestId: randomUUID(), ...fields });
  await post(path + '/movements', 201, { kind: 'purchase_in', amount: 91000, category: 'Compras', reason: 'Entrega de efectivo' });
  const payment = { kind: 'staff_payment', amount: 45000, category: 'Ana de prueba', reason: 'Pago de jornada' };
  await post(path + '/movements', 400, { ...payment, category: ' ' });
  await post(path + '/movements', 409, { ...payment, amount: 110000 });
  await post(path + '/movements', 201, payment);
  await post(path + '/movements', 201, { ...payment, category: 'ana de prueba', amount: 5000, reason: 'Horas adicionales' });
  const { totals } = await server.json(path, 200);
  assert.equal(totals.salesExpected, 50000);
  assert.equal(totals.purchasesExpected, 91000);
  assert.equal(totals.transferExpected, 0);
  assert.deepEqual(await server.json('/api/cash/purchase-references', 200), []);
  const month = colombianDay.format(new Date()).slice(0, 7);
  const data = await server.json('/api/reports?kind=month&anchor=' + month, 200);
  const report = accountingReport(data, accountingPeriod('month', month));
  assert.equal(Object.fromEntries(accountingTotals(report))['Pagos diarios al personal'], accountingMoney(50000));
  assert.deepEqual(accountingTables(report).find(({ title }) => title === 'Pagos diarios por empleado').rows,
    [['Ana de prueba', '2', accountingMoney(50000)]]);
  const audit = await server.json('/api/audit', 200);
  assert.ok(audit.some(({ kind, reason }) => kind === 'cash_movement' && reason.includes('Pago diario al personal')));
});

test('corrige un pago al personal y vincula su compensación una sola vez', async (t) => {
  const server = await testServer();
  t.after(server.cleanup);
  await server.start();
  const { id } = await server.openShift(100000, 100);
  const cash = '/api/cash/' + id;
  const page = '/api/corrections/staff-payments';
  const post = (url, status, fields) => server.json(url, status, 'POST', { requestId: randomUUID(), ...fields });
  const staff = (amount) => ({ kind: 'staff_payment', amount, category: 'Ana de prueba', reason: 'Pago de jornada' });
  const payment = await post(cash + '/movements', 201, staff(50000));
  const compensation = await post(cash + '/movements', 201, {
    kind: 'sales_in', amount: 45000, category: 'Compensación', reason: 'Error al digitar el pago',
  });
  const action = page + '/' + payment.id + '/adjust';
  const input = { requestId: randomUUID(), amount: 5000, compensationId: compensation.id,
    reason: 'El importe real fue cinco mil', confirmed: true };
  const before = await server.json(cash, 200);
  assert.equal(before.totals.salesExpected, 95000);
  const counted = await server.recordCashCount(id, { salesCounted: 95000, purchasesCounted: 0, transferConfirmed: 0, countedTokens: 100 });
  const operator = { username: 'cajera', secret: '128462' };
  await post('/api/operators', 201, { ...operator, name: 'Cajera ficticia' });
  await server.signIn('login', operator, 200);
  await server.json(page, 403);
  await post(action, 403, input);
  await server.signIn('login', { username: 'admin-prueba', secret: 'clave-ficticia-2026' }, 200);
  await post(action, 409, { ...input, amount: 6000 });
  await post(action, 201, input);
  await post(action, 200, input);
  await post(action, 409, { ...input, requestId: randomUUID() });
  const after = await server.json(cash, 200);
  assert.equal(after.totals.salesExpected, 95000);
  assert.equal(after.requiresRecount, true);
  assert.deepEqual(after.movements.map((row) => [row.amount, row.salesDelta, row.originalAmount]),
    [[0, 0, 45000], [5000, -5000, 50000]]);
  assert.equal(after.movements[0].compensatesPaymentId, payment.id);
  assert.equal(after.movements[1].correctionReason, input.reason);
  assert.equal((await server.json(page, 200)).compensations.length, 0);

  const unpaid = await post(cash + '/movements', 201, staff(10000));
  await post(page + '/' + unpaid.id + '/adjust', 201, { amount: 0, compensationId: null, reason: 'Nunca se entregó', confirmed: true });
  assert.equal((await server.json(cash, 200)).totals.salesExpected, 95000);
  const month = colombianDay.format(new Date()).slice(0, 7);
  const data = await server.json('/api/reports?kind=month&anchor=' + month, 200);
  const report = accountingReport(data, accountingPeriod('month', month));
  assert.equal(Object.fromEntries(accountingTotals(report))['Pagos diarios al personal'], accountingMoney(5000));
  assert.deepEqual(accountingTables(report).find(({ title }) => title === 'Pagos diarios por empleado').rows,
    [['Ana de prueba', '1', accountingMoney(5000)]]);
  const audit = await server.json('/api/audit', 200);
  assert.ok(audit.some(({ kind, actorName, targetId }) => kind === 'staff_payment_correction' &&
    actorName === 'Administrador de prueba' && targetId === payment.id));
  const finalCount = await server.recordCashCount(id, { salesCounted: 95000, purchasesCounted: 0, transferConfirmed: 0, countedTokens: 100 },
    counted.countId, 'Pago corregido');
  await post(cash + '/close', 201, { ...finalCount, nextBase: 90000, note: 'Se redujo la base para el próximo turno.' });
  await post(action, 409, { ...input, requestId: randomUUID() });
  assert.equal((await server.fetch(cash + '/report.pdf')).status, 200);
});
