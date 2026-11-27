import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { testServer } from './support/local-server.mjs';

test('recupera una venta, un aporte y un chico guardados aunque se pierdan sus confirmaciones', { timeout: 20000 }, async (t) => {
  const server = await testServer();
  t.after(server.cleanup);
  await server.start();
  const { id: shift } = await server.openShift(100_000, 10);
  const { id: productId } = await server.json('/api/products', 201, 'POST', {
    name: 'Cerveza de prueba', brand: '', presentation: 'Unidad', price: 8000, packageName: '', unitsPerPackage: 1, active: true,
  });
  await server.json('/api/products/' + productId + '/movements', 201, 'POST', {
    direction: 'in', unit: 'unit', quantity: 3, reason: 'Saldo inicial', requestId: randomUUID(),
  });
  const { id: group } = await server.json('/api/tejo', 201, 'POST', {
    courtType: 'maxi', courtNumber: 1, playerCount: 2, requestId: randomUUID(),
  });
  const requests = [
    { path: '/api/sales', fields: { accountId: null, items: [{ productId, quantity: 1, unitPrice: 8000 }],
      payment: { cash: 8000, transfer: 0, tokens: 0 } } },
    { path: '/api/cash/' + shift + '/movements', fields: {
      kind: 'purchase_in', amount: 50_000, category: 'Compras', reason: 'Aporte de prueba',
    } },
    { path: '/api/tejo/' + group + '/record', fields: { issueAll: true } },
  ];
  const drafts = requests.map(({ path, fields }) => ({ path, body: { ...fields, requestId: randomUUID() } }));
  for (const { path, body } of drafts) {
    const response = await server.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    assert.equal(response.status, 201);
    await response.body.cancel();
  }

  await server.stop();
  await server.start();
  for (const { path, body } of drafts) {
    const receiptPath = '/api/operations/' + body.requestId;
    const receipt = await server.json(receiptPath, 200);
    assert.equal(receipt.status, 'saved');
    assert.equal((await server.json(path, 200, 'POST', body)).id, receipt.id);
    assert.deepEqual(await server.json(receiptPath, 200, 'POST', {}), receipt);
  }
  const { totals } = await server.json('/api/cash/' + shift, 200);
  assert.equal(totals.cashReceived, 8000);
  assert.equal(totals.purchasesExpected, 50_000);
  assert.equal(totals.tokensIssued, 2);
  assert.equal(totals.expectedTokens, 8);
  assert.equal((await server.json('/api/products', 200))[0].stock, 2);
  assert.equal((await server.json('/api/tejo', 200)).active[0].rounds.length, 1);

  const pending = { ...drafts[1].body, requestId: randomUUID() };
  const pendingPath = '/api/operations/' + pending.requestId;
  assert.deepEqual(await server.json(pendingPath, 200), { status: 'missing', id: null });
  assert.deepEqual(await server.json(pendingPath, 200, 'POST', {}), { status: 'discarded', id: null });
  await server.json(drafts[1].path, 409, 'POST', pending);
  assert.equal((await server.json('/api/cash/' + shift, 200)).totals.purchasesExpected, 50_000);

  const next = { ...pending, requestId: randomUUID() };
  await server.json(drafts[1].path, 201, 'POST', next);
  assert.equal((await server.json('/api/cash/' + shift, 200)).totals.purchasesExpected, 100_000);
});
