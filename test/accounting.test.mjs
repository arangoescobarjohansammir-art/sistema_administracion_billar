import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { accountingPeriod, accountingReport } from '../dist/shared/accounting.js';
import { readAccounting } from '../dist/server/accounting.js';
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
