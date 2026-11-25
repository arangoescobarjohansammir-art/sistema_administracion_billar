import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { testServer } from './support/local-server.mjs';

const command = (...args) => execFileSync(process.execPath, ['dist/server/backup-command.js', ...args], { encoding: 'utf8' });

async function awaitCopy(folder, label) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const files = await readdir(folder).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const name = files.find((file) => file.includes(label) && file.endsWith('.sqlite'));
    if (name) return join(folder, name);
    await setTimeout(50);
  }
  assert.fail('No se creó la copia ' + label);
}

test('respalda un cierre y restaura ventas, inventario y fotos en una base nueva', { timeout: 20000 }, async (t) => {
  const server = await testServer();
  t.after(server.cleanup);
  await server.start();
  const folder = join(dirname(server.databasePath), 'backups');
  const daily = await awaitCopy(folder, '-diaria-');
  assert.match(command('verify', daily), /Copia verificada/);

  const opened = await server.openShift();
  const product = await server.json('/api/products', 201, 'POST', {
    name: 'Producto de prueba', presentation: 'Botella', brand: '', price: 4000, packageName: '',
    unitsPerPackage: 1, active: true, photo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACElEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=',
  });
  await server.json('/api/products/' + product.id + '/movements', 201, 'POST', {
    direction: 'in', unit: 'unit', quantity: 7, reason: 'Prueba',
  });
  await server.json('/api/sales', 201, 'POST', {
    requestId: randomUUID(), accountId: null, items: [{ productId: product.id, quantity: 1, unitPrice: 4000 }],
    payment: { cash: 4000, transfer: 0, tokens: 0 },
  });
  const url = '/api/cash/' + opened.id + '/close';
  const review = await server.recordCashCount(opened.id, {
    salesCounted: 104000, purchasesCounted: 0, transferConfirmed: 0, countedTokens: 100,
  });
  const close = { ...review, requestId: randomUUID(), nextBase: 100000, note: '' };
  await server.json(url, 201, 'POST', close);
  await server.json(url, 200, 'POST', close);
  const snapshot = await awaitCopy(folder, '-turno-' + opened.id + '-');
  assert.equal((await readdir(folder)).filter((file) => file.includes('-turno-' + opened.id + '-')).length, 1);

  const restored = join(dirname(server.databasePath), 'recovery', 'caja.sqlite');
  assert.match(command('restore', snapshot, restored), /Base restaurada y verificada/);
  const db = new DatabaseSync(restored, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT total FROM sales').get().total, 4000);
    assert.equal(db.prepare('SELECT SUM(units) AS quantity FROM inventory_movements').get().quantity, 6);
    assert.equal(db.prepare('SELECT hex(substr(photo, 1, 8)) AS png FROM products').get().png, '89504E470D0A1A0A');
    assert.ok(db.prepare('SELECT closed_at FROM cash_shifts').get().closed_at);
    assert.equal(db.prepare('SELECT sales_counted FROM cash_counts').get().sales_counted, 104000);
  } finally {
    db.close();
  }
  assert.throws(() => command('restore', snapshot, server.databasePath), /El destino ya existe/);
  const corrupt = join(dirname(server.databasePath), 'bad.sqlite');
  await writeFile(corrupt, 'archivo sin datos de caja');
  assert.throws(() => command('restore', corrupt, restored + '.bad'));
  assert.equal((await readFile(restored)).subarray(0, 15).toString(), 'SQLite format 3');
});
