import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { testServer } from './support/local-server.mjs';

test('registra diferencias por producto y aplica un ajuste auditado sin repetir movimientos', { timeout: 20000 }, async (t) => {
  const server = await testServer();
  t.after(server.cleanup);
  await server.start();
  const { json } = server;
  const post = (path, status, data) => json(path, status, 'POST', { ...data, requestId: data.requestId ?? randomUUID() });
  const product = (name, presentation, active = true) => post('/api/products', 201, {
    name, presentation, price: 4000, brand: 'Marca de prueba', packageName: '', unitsPerPackage: 1, active,
  });
  const beer = await product('Cerveza', 'Botella');
  const liquor = await product('Aguardiente', 'Media');
  const excluded = await product('Inactivo', 'Botella', false);
  const untouched = await product('Papas', 'Paquete');
  const receive = (id, quantity) => post('/api/products/' + id + '/movements', 201, {
    direction: 'in', quantity, unit: 'unit', reason: 'Entrada de prueba',
  });
  await receive(beer.id, 10);
  await receive(liquor.id, 2);
  await receive(untouched.id, 8);
  await post('/api/operators', 201, { name: 'Cajera de prueba', username: 'conteo', secret: '159753' });
  await server.signIn('login', { username: 'conteo', secret: '159753' }, 200);
  await server.openShift();
  const base = '/api/inventory-counts';
  async function prepare(items) {
    const products = await json(base + '/products', 200);
    assert.ok(products.every((item) => !Object.hasOwn(item, 'expected') && !Object.hasOwn(item, 'stock') && item.id !== excluded.id));
    return items.map(([product, counted]) => ({
      productId: product.id, counted, version: products.find((item) => item.id === product.id).version,
    }));
  }

  const original = await prepare([[beer, 7], [liquor, 4]]);
  await receive(beer.id, 1);
  await post('/api/sales', 201, {
    accountId: null, items: [{ productId: beer.id, quantity: 1, unitPrice: 4000 }],
    payment: { cash: 4000, transfer: 0, tokens: 0 },
  });
  await post(base, 409, { items: original, note: '' });
  assert.deepEqual(await json(base, 200), []);
  const items = await prepare([[beer, 0], [liquor, 4]]);
  await post(base, 400, { items: [items[0], items[0]], note: '' });
  const countPayload = { items, note: 'Conteo del turno', requestId: randomUUID() };
  const { id } = await post(base, 201, countPayload);
  assert.equal((await post(base, 200, countPayload)).id, id);
  const detailPath = base + '/' + id;
  const saved = await json(detailPath, 200);
  assert.equal(saved.countedBy, 'Cajera de prueba');
  assert.deepEqual(saved.items.map((line) => [line.expected, line.counted]), [[2, 4], [10, 0]]);
  await post(detailPath + '/apply', 403, { note: 'No autorizado' });
  assert.equal((await json('/api/products', 200)).find((row) => row.id === beer.id).stock, 10);

  const pending = await post(base, 201, { items: await prepare([[untouched, 5]]), note: '' });
  await receive(untouched.id, 1);
  await server.signIn('login', { username: 'admin-prueba', secret: 'clave-ficticia-2026' }, 200);
  assert.equal((await json(base + '/' + pending.id, 200)).items[0].changed, true);
  await post(base + '/' + pending.id + '/apply', 409, { note: 'El conteo ya cambió' });
  await post(detailPath + '/apply', 400, { note: ' ' });
  const adjustment = { note: 'Verificado físicamente por el administrador', requestId: randomUUID() };
  await post(detailPath + '/apply', 201, adjustment);
  await post(detailPath + '/apply', 200, adjustment);
  await post(detailPath + '/apply', 409, { ...adjustment, requestId: randomUUID() });
  const catalog = await json('/api/products', 200);
  assert.equal(catalog.find((row) => row.id === beer.id).stock, 0);
  assert.equal(catalog.find((row) => row.id === liquor.id).stock, 4);
  assert.equal(catalog.find((row) => row.id === untouched.id).stock, 9);
  assert.equal((await json('/api/products/' + beer.id + '/movements', 200))[0].units, -10);
  const approved = await json(detailPath, 200);
  assert.equal(approved.adjustedBy, 'Administrador de prueba');
  assert.equal(approved.adjustmentNote, adjustment.note);
  assert.equal(approved.items.some((item) => item.changed), false);
  const logs = await json('/api/audit', 200);
  assert.ok(logs.some((entry) => entry.kind === 'inventory_count' && entry.targetId === id && entry.actorName === 'Cajera de prueba'));
  assert.equal(logs.filter((entry) => entry.kind === 'inventory_count_adjustment' && entry.targetId === id).length, 1);
  const balanced = await post(base, 201, { items: await prepare([[beer, 0]]), note: '' });
  assert.equal((await json(base + '/' + balanced.id, 200)).differences, 0);
  await post(base + '/' + balanced.id + '/apply', 409, { note: 'Sin diferencias' });
});
