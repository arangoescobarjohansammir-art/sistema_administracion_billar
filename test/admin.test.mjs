import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAccounts } from '../dist/server/accounts.js';
import { createAdminSnapshot, startAdminSync } from '../dist/server/admin.js';
import { createBilliards } from '../dist/server/billiards.js';
import { createCash } from '../dist/server/cash.js';
import { createCatalog } from '../dist/server/catalog.js';
import { createTejo } from '../dist/server/tejo.js';
import { dashboardRefreshMs } from '../dist/shared/admin.js';
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
    day: '2026-11-23', sales: 24000, transactions: 1, cash: 0, transfer: 0, tokens: 0, tokenAmount: 0,
  });
  assert.deepEqual(snapshot.daily.at(-1), {
    day: '2026-11-24', sales: 20000, transactions: 1, cash: 10000, transfer: 9000, tokens: 2, tokenAmount: 7000,
  });
  assert.equal(snapshot.active, null);
  assert.equal(snapshot.closures[0].salesDifference, -500);
  assert.equal(snapshot.closures[0].closingNote, 'Faltante.');
  assert.deepEqual(snapshot.openBalances, [{ id: 1, name: 'Cliente de prueba', balance: 18000 }]);
  assert.equal(snapshot.pendingBalance, 18000);
  assert.deepEqual(snapshot.inventory, [{ id: 1, name: 'Cerveza de prueba', brand: 'Ejemplo', presentation: 'Botella', stock: 12 }]);
  assert.deepEqual(snapshot.play, { billiard: [{ table: 2, paused: true }], tejo: [{ type: 'largo', court: 4, rounds: 1 }] });
});

test('reintenta con la caja actual y reemplaza la misma copia al volver la conexión', async (t) => {
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
  const calls = [];
  const retries = [];
  const timers = t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    retries.push(callback);
    assert.equal(delay, dashboardRefreshMs);
    return { unref() {} };
  });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'info', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (calls.length === 1) throw new Error('Sin internet');
    return { ok: true };
  });

  startAdminSync(database, cash, accounts);
  await new Promise(setImmediate);
  assert.equal(retries.length, 1);
  database.exec("INSERT INTO sales (total, created_at) VALUES (4000, '" + new Date().toISOString() + "')");
  retries.shift()();
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  assert.equal(timers.mock.callCount(), 2);
  assert.equal(calls[0].body.id, calls[1].body.id);
  assert.equal(calls[0].body.payload.daily.at(-1).sales, 0);
  assert.equal(calls[1].body.payload.daily.at(-1).sales, 4000);
  assert.equal(calls[1].url, 'https://patio-bonito-test.supabase.co/rest/v1/admin_snapshots?on_conflict=id');
  assert.equal(calls[1].options.headers.Prefer, 'resolution=merge-duplicates,return=minimal');
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
