import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAccounts } from '../dist/server/accounts.js';
import { createAdminSnapshot, startAdminSync } from '../dist/server/admin.js';
import { createBilliards } from '../dist/server/billiards.js';
import { createCash } from '../dist/server/cash.js';
import { createCatalog } from '../dist/server/catalog.js';
import { createTejo } from '../dist/server/tejo.js';
import { dashboardRefreshMs } from '../dist/shared/admin.js';
import { accountingPeriod, accountingReport } from '../dist/shared/accounting.js';
import { testServer } from './support/local-server.mjs';

function databaseFixture(t) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  createCatalog(database);
  const accounts = createAccounts(database);
  createBilliards(database, accounts);
  createTejo(database, accounts);
  const cash = createCash(database, accounts);
  return { database, accounts, cash };
}

test('resume ventas y cobros por día colombiano y conserva el cierre guardado', (t) => {
  const { database, cash, accounts } = databaseFixture(t);
  database.exec(`
    INSERT INTO customer_accounts VALUES (1, 'Cliente de prueba', 'cliente', '2026-11-20T12:00:00.000Z');
    INSERT INTO cash_shifts (id, cashier, opened_at, opening_base, opening_note, opening_tokens)
      VALUES (1, 'Cajero de prueba', '2026-11-24T02:00:00.000Z', 100000, '', 100);
    INSERT INTO sales VALUES
      (1, 1, 24000, '2026-11-24T04:59:59.999Z'),
      (2, NULL, 20000, '2026-11-24T05:00:00.000Z');
    INSERT INTO account_payments VALUES
      (1, NULL, 2, 10000, 6000, 1, 4000, '2026-11-24T05:00:05.000Z'),
      (2, 1, NULL, 0, 3000, 1, 3000, '2026-11-24T05:00:06.000Z');
    UPDATE cash_shifts SET closed_at = '2026-11-24T05:01:00.000Z', next_base = 100000, closing_note = 'Faltante.',
      sales_counted = 109500, sales_expected = 110000, purchases_counted = 0, purchases_expected = 0,
      transfer_confirmed = 9000, transfer_expected = 9000, pending_balance = 18000, counted_tokens = 102, expected_tokens = 102;
    INSERT INTO cash_movements VALUES
      (1, 1, 'sales_expense', 12000, -12000, 0, 'Bebidas', 'Compra imprevista', '2026-11-18T05:00:00.000Z'),
      (2, 1, 'sales_withdrawal', 5000, -5000, 0, 'Mantenimiento', 'Repuesto', '2026-11-24T05:00:10.000Z'),
      (3, 1, 'purchase_expense', 8000, 0, -8000, 'Bebidas', 'Proveedor habitual', '2026-11-24T05:00:11.000Z'),
      (4, 1, 'sales_withdrawal', 1000, -1000, 0, 'Caja', 'Fuera del período', '2026-11-18T04:59:59.999Z');
    INSERT INTO products (id, name, brand, presentation, price, package_name, units_per_package, active)
      VALUES (1, 'Cerveza de prueba', 'Ejemplo', 'Botella', 4000, '', 1, 1), (2, 'Inactivo', '', '', 0, '', 1, 0);
    INSERT INTO inventory_movements (product_id, units, reason, created_at, quantity, input_unit, units_per_input)
      VALUES (1, 12, '', '2026-11-24T05:00:06.000Z', 12, 'unit', 1);
    INSERT INTO billiard_sessions (table_number, rate, started_at, stopped_at) VALUES (2, 6000, 1, 2);
    INSERT INTO tejo_sessions (court_type, court_number, opened_at) VALUES ('largo', 4, '2026-11-24T05:00:06.000Z');
    INSERT INTO tejo_played (session_id, number, rate, player_count, created_at)
      VALUES (1, 1, 4000, 2, '2026-11-24T05:00:06.000Z');
  `);
  const snapshot = createAdminSnapshot(database, cash, accounts, new Date('2026-11-24T05:30:00.000Z'));
  assert.equal(snapshot.daily.length, 30);
  assert.deepEqual(snapshot.daily.at(-2), {
    day: '2026-11-23', sales: 24000, transactions: 1, cash: 0, transfer: 0, tokens: 0, tokenAmount: 0, voidedSales: 0,
  });
  assert.deepEqual(snapshot.daily.at(-1), {
    day: '2026-11-24', sales: 20000, transactions: 1, cash: 10000, transfer: 9000, tokens: 2, tokenAmount: 7000, voidedSales: 0,
  });
  assert.equal(snapshot.active, null);
  assert.equal(snapshot.closures[0].salesDifference, -500);
  assert.equal(snapshot.closures[0].closingNote, 'Faltante.');
  assert.deepEqual(snapshot.unexpectedWithdrawals, [
    { id: 2, shiftId: 1, kind: 'sales_withdrawal', amount: 5000, category: 'Mantenimiento', reason: 'Repuesto',
      createdAt: '2026-11-24T05:00:10.000Z' },
    { id: 1, shiftId: 1, kind: 'sales_expense', amount: 12000, category: 'Bebidas', reason: 'Compra imprevista',
      createdAt: '2026-11-18T05:00:00.000Z' },
  ]);
  assert.deepEqual(snapshot.openBalances, [{ id: 1, name: 'Cliente de prueba', balance: 18000 }]);
  assert.equal(snapshot.pendingBalance, 18000);
  assert.deepEqual(snapshot.inventory, [{ id: 1, name: 'Cerveza de prueba', brand: 'Ejemplo', presentation: 'Botella', stock: 12 }]);
  assert.deepEqual(snapshot.play, { billiard: [{ table: 2, paused: true }], tejo: [{ type: 'largo', court: 4, rounds: 1 }] });
});

test('concilia ventas y reportes cuando una venta y un abono se anulan la semana siguiente', (t) => {
  const { database, cash, accounts } = databaseFixture(t);
  database.exec(`
    INSERT INTO customer_accounts VALUES (1, 'Cliente de prueba', 'cliente', '2026-11-20T05:00:00.000Z');
    INSERT INTO sales VALUES
      (1, NULL, 8000, '2026-11-23T04:59:59.999Z'),
      (2, 1, 12000, '2026-11-21T05:00:00.000Z'),
      (3, NULL, 9999, '2026-11-23T06:00:00.000Z');
    INSERT INTO account_payments VALUES
      (1, NULL, 1, 4000, 1000, 1, 3000, '2026-11-23T04:59:59.999Z'),
      (2, 1, NULL, 2000, 0, 0, 3000, '2026-11-23T04:59:59.999Z');
    INSERT INTO sale_voids VALUES (1, '2026-11-23T05:00:00.000Z', 'Registrada el lunes', 0);
    INSERT INTO account_payment_voids VALUES (2, '2026-11-23T05:00:01.000Z', 'Abono inválido');
  `);
  const snapshot = createAdminSnapshot(database, cash, accounts, new Date('2026-11-23T05:30:00.000Z'));
  const sunday = { day: '2026-11-22', sales: 8000, transactions: 1, cash: 6000, transfer: 1000,
    tokens: 1, tokenAmount: 3000, voidedSales: 0 };
  const monday = { day: '2026-11-23', sales: -8000, transactions: 0, cash: -6000, transfer: -1000,
    tokens: -1, tokenAmount: -3000, voidedSales: 8000 };
  assert.deepEqual(snapshot.daily.slice(-2), [sunday, monday]);
  for (const expected of [sunday, monday]) {
    const report = accountingReport(snapshot.accounting, accountingPeriod('week', expected.day));
    const { day, sales, transactions, cash, transfer, tokens, tokenValue, voidedSales, installments } =
      report.days.find((row) => row.day === expected.day);
    assert.deepEqual({ day, sales, transactions, cash, transfer, tokens, tokenAmount: tokenValue, voidedSales }, expected);
    assert.equal(installments, day === sunday.day ? 2000 : -2000);
    assert.equal(report.amounts.sales, day === sunday.day ? 20000 : -8000);
  }
});

test('sincroniza aportes una vez incluso si se pierde la confirmación y conserva la copia de caja', async (t) => {
  const { database, cash, accounts } = databaseFixture(t);
  const env = { ...process.env };
  t.after(() => {
    for (const key of ['CAJA_SUPABASE_URL', 'CAJA_SUPABASE_SECRET_KEY']) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });
  process.env.CAJA_SUPABASE_URL = 'https://patio-bonito-test.supabase.co';
  process.env.CAJA_SUPABASE_SECRET_KEY = 'sb_secret_ficticia';
  const openedAt = new Date().toISOString();
  database.prepare("INSERT INTO cash_shifts (id, cashier, opened_at, opening_base, opening_note, opening_tokens) VALUES (1, 'Caja de prueba', ?, 100000, '', 100)").run(openedAt);
  const funding = {
    id: randomUUID(), shift_id: 1, shift_opened_at: openedAt,
    amount: 500000, note: 'Pedido del proveedor', created_at: openedAt, requested_by: randomUUID(),
  };
  const oldFunding = { ...funding, id: randomUUID(), shift_opened_at: '2026-10-01T12:00:00Z' };
  const snapshots = [];
  const receipts = [];
  const retries = [];
  let online = false;
  const timers = t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    retries.push(callback);
    assert.equal(delay, dashboardRefreshMs);
    return { unref() {} };
  });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'info', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/admin_snapshots?')) {
      snapshots.push({ url, options, body: JSON.parse(options.body) });
      if (!online) throw new Error('Sin internet');
      return { ok: true };
    }
    if (!online) throw new Error('Sin internet');
    if (options.method !== 'PATCH') return { ok: true, json: async () => [funding, oldFunding] };
    receipts.push({ url, ...JSON.parse(options.body) });
    return { ok: receipts.length > 1 };
  });

  startAdminSync(database, cash, accounts);
  await new Promise(setImmediate);
  assert.equal(retries.length, 1);
  assert.equal(receipts.length, 0);
  assert.equal(cash.adminOverview().active.totals.purchasesExpected, 0);
  database.exec("INSERT INTO sales (total, created_at) VALUES (4000, '" + new Date().toISOString() + "')");
  online = true;
  retries.shift()();
  await new Promise(setImmediate);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'applied');
  retries.shift()();
  await new Promise(setImmediate);
  assert.equal(receipts.length, 3);
  assert.equal(receipts[1].movement_id, receipts[0].movement_id);
  assert.match(receipts[1].url, new RegExp(funding.id));
  assert.equal(receipts[2].status, 'rejected');
  assert.match(receipts[2].url, new RegExp(oldFunding.id));
  assert.equal(database.prepare('SELECT count(*) AS count FROM cash_movements').get().count, 1);
  assert.equal(database.prepare('SELECT requested_by AS actor FROM cash_remote_purchase_funding').get().actor, funding.requested_by);
  assert.equal(snapshots.length, 3);
  assert.equal(timers.mock.callCount(), 3);
  assert.equal(snapshots[0].body.id, snapshots[2].body.id);
  assert.equal(snapshots[0].body.payload.daily.at(-1).sales, 0);
  const current = snapshots[2].body.payload;
  assert.equal(current.daily.at(-1).sales, 4000);
  assert.equal(current.active.purchasesExpected, 500000);
  assert.equal(current.active.salesExpected, 100000);
  assert.equal(snapshots[2].url, 'https://patio-bonito-test.supabase.co/rest/v1/admin_snapshots?on_conflict=id');
  assert.equal(snapshots[2].options.headers.Prefer, 'resolution=merge-duplicates,return=minimal');
});

test('sirve el panel móvil como aplicación independiente de la API de caja', async (t) => {
  const server = await testServer();
  t.after(server.cleanup);
  await server.start();
  const page = await server.fetch('/admin?demo=1');
  assert.equal(page.status, 200);
  assert.match(page.url, /\/admin\/\?demo=1$/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  const src = html.match(/src="\.\/(assets\/[^"]+\.js)"/)?.[1];
  assert.ok(src);
  assert.equal((await server.fetch('/admin/' + src)).status, 200);
  assert.equal((await server.fetch('/api/admin')).status, 404);
});
