import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { testServer } from './support/local-server.mjs';

test('mantiene unidos el servidor y la pantalla si se recompila mientras está abierto', { timeout: 20000 }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'tejo-billar-build-'));
  const build = join(folder, 'dist');
  const server = await testServer(join(build, 'server', 'index.js'));
  t.after(async () => {
    await server.cleanup();
    await rm(folder, { recursive: true, force: true });
  });
  await cp('dist', build, { recursive: true });
  await writeFile(join(folder, 'package.json'), '{"type":"module"}');
  await server.start();

  const response = await server.fetch('/');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  const js = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(js);
  const original = await (await server.fetch(js)).text();

  await writeFile(join(build, 'client', 'index.html'), '<h1>Compilación nueva</h1>');
  await rm(join(build, 'client', js.slice(1)));
  assert.equal(await (await server.fetch('/')).text(), html);
  assert.equal(await (await server.fetch(js)).text(), original);
  assert.equal((await server.json('/api/cash', 200)).active, null);
  assert.equal((await server.json('/api/ruta-inexistente', 404)).code, 'API_ROUTE_NOT_FOUND');
});
