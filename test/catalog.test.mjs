import assert from 'node:assert/strict';
import test from 'node:test';
import { testServer } from './support/local-server.mjs';

const photo = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVYQAAAAASUVORK5CYII=',
  'base64',
);

test('persiste el catálogo y rechaza movimientos inválidos', { timeout: 20000 }, async (t) => {
  const { start, stop, fetch, json, cleanup } = await testServer();
  t.after(cleanup);

  const form = {
    name: 'Cerveza de prueba', brand: 'Marca de prueba', presentation: 'Botella',
    price: 4000, packageName: 'Canasta', unitsPerPackage: 30, active: true,
  };
  const purchase = { direction: 'in', unit: 'package', quantity: 2, reason: 'Compra de dos canastas' };
  const withdrawal = { direction: 'out', unit: 'unit', quantity: 1, reason: 'Unidad dañada' };

  await start();
  assert.equal((await fetch('/')).status, 200);
  await json('/api/local-note', 200, 'PUT', { text: 'Nota de prueba' });
  const catalog = '/api/products';
  await json(catalog, 400, 'POST', { ...form, photo: 'data:image/png;base64,AAAA' });
  const product = await json(catalog, 201, 'POST', { ...form, photo: 'data:image/png;base64,' + photo.toString('base64') });
  const path = catalog + '/' + product.id;
  const stock = path + '/movements';
  assert.equal(product.stock, 0);
  assert.equal((await json(stock, 201, 'POST', purchase)).stock, 60);
  assert.equal((await json(stock, 201, 'POST', withdrawal)).stock, 59);
  await json(stock, 409, 'POST', { ...withdrawal, quantity: 60 });
  await json(path, 200, 'PUT', { ...form, active: false, price: 4500, unitsPerPackage: 24 });
  await json(stock, 409, 'POST', purchase);

  await stop();
  await start();
  const [persisted] = await json(catalog, 200);
  assert.equal(persisted.active, 0);
  assert.equal(persisted.stock, 59);
  assert.equal(persisted.price, 4500);
  assert.equal(persisted.unitsPerPackage, 24);
  const history = await json(stock, 200);
  assert.deepEqual(history.map(({ units, unitsPerInput }) => [units, unitsPerInput]), [[-1, 1], [60, 30]]);
  const uploaded = await fetch(path + '/photo');
  assert.equal(uploaded.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), photo);
  assert.equal((await json('/api/local-note', 200)).text, 'Nota de prueba');
  await json(path, 200, 'PUT', { ...form, photo: null });
  await json(path + '/photo', 404);
});
