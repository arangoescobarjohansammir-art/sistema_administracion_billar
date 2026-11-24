import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

const photo = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVYQAAAAASUVORK5CYII=',
  'base64',
);

test('persiste el catálogo y rechaza movimientos inválidos', { timeout: 20000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tejo-billar-inventory-'));
  let server;
  let base;

  async function start() {
    server = spawn(process.execPath, ['dist/server/index.js'], {
      env: { ...process.env, PORT: '0', CAJA_DB_PATH: join(folder, 'inventory.sqlite') },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const lines = createInterface({ input: server.stdout });
    try {
      const [line] = await Promise.race([
        once(lines, 'line'),
        once(server, 'exit').then(([code]) => { throw new Error('El servidor cerró con código ' + code); }),
      ]);
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(line);
      assert.ok(match, 'el servidor debe anunciar su dirección local');
      base = match[0];
    } finally {
      lines.close();
    }
  }

  async function stop() {
    if (server && server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, 'exit');
      server.kill();
      await stopped;
    }
  }

  async function json(path, status, method = 'GET', data) {
    const response = await fetch(base + path, {
      method,
      headers: data ? { 'Content-Type': 'application/json' } : undefined,
      body: data ? JSON.stringify(data) : undefined,
    });
    const payload = await response.json();
    assert.equal(response.status, status, JSON.stringify(payload));
    return payload;
  }

  const form = {
    name: 'Cerveza de prueba', brand: 'Marca de prueba', presentation: 'Botella',
    price: 4000, packageName: 'Canasta', unitsPerPackage: 30, active: true,
  };
  const purchase = { direction: 'in', unit: 'package', quantity: 2, reason: 'Compra de dos canastas' };
  const withdrawal = { direction: 'out', unit: 'unit', quantity: 1, reason: 'Unidad dañada' };

  try {
    await start();
    assert.equal((await fetch(base)).status, 200);
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
    const uploaded = await fetch(base + path + '/photo');
    assert.equal(uploaded.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), photo);
    assert.equal((await json('/api/local-note', 200)).text, 'Nota de prueba');
    await json(path, 200, 'PUT', { ...form, photo: null });
    await json(path + '/photo', 404);
  } finally {
    await stop();
    await rm(folder, { recursive: true, force: true });
  }
});
