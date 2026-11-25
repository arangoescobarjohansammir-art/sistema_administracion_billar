import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { expectedCashCounts } from '../../dist/shared/cash.js';

export async function testServer(entry = 'dist/server/index.js') {
  const folder = await mkdtemp(join(tmpdir(), 'tejo-billar-test-'));
  const databasePath = join(folder, 'test.sqlite');
  let child;
  let base;
  let cookie = '';
  const admin = { name: 'Administrador de prueba', username: 'admin-prueba', secret: 'clave-ficticia-2026' };

  async function start({ authenticate = true, secondaryBackupDirectory = '' } = {}) {
    child = spawn(process.execPath, [entry], {
      env: { ...process.env, PORT: '0', CAJA_DB_PATH: databasePath, CAJA_BACKUP_DIR: '',
        CAJA_BACKUP_SECONDARY_DIR: secondaryBackupDirectory,
        CAJA_SUPABASE_URL: '', CAJA_SUPABASE_SECRET_KEY: '', CAJA_SETUP_CODE: '' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const lines = createInterface({ input: child.stdout });
    try {
      const [line] = await Promise.race([
        once(lines, 'line'),
        once(child, 'exit').then(([code]) => { throw new Error('El servidor cerró con código ' + code); }),
      ]);
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(line);
      assert.ok(match, 'el servidor debe anunciar su dirección local');
      base = match[0];
    } finally {
      lines.close();
    }
    cookie = '';
    if (authenticate) {
      const response = await fetchLocal('/api/session');
      const { setupNeeded } = await response.json();
      await signIn(setupNeeded ? 'setup' : 'login', admin, setupNeeded ? 201 : 200);
    }
  }

  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
  }

  function fetchLocal(path, options) {
    const headers = new Headers(options?.headers);
    if (cookie && !headers.has('Cookie')) headers.set('Cookie', cookie);
    return fetch(base + path, { ...options, headers });
  }

  async function signIn(action, credentials, status) {
    const response = await fetchLocal('/api/session/' + action, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    cookie = response.headers.get('Set-Cookie')?.split(';')[0] ?? cookie;
    return data.operator;
  }
  async function json(path, status, method = 'GET', data) {
    const response = await fetchLocal(path, {
      method,
      headers: data ? { 'Content-Type': 'application/json' } : undefined,
      body: data ? JSON.stringify(data) : undefined,
    });
    const payload = await response.json();
    assert.equal(response.status, status, JSON.stringify(payload));
    return payload;
  }

  return {
    start, stop, fetch: fetchLocal, json, databasePath, signIn,
    openShift(openingBase = 100_000, openingTokens = 100) {
      return json('/api/cash', 201, 'POST', {
        requestId: randomUUID(), cashier: 'Cajero de prueba', openingBase, openingTokens, note: '',
      });
    },
    async recordCashCount(shiftId, count, previousCountId = null, reason = '') {
      const path = '/api/cash/' + shiftId;
      const { id } = await json(path + '/count', 201, 'POST', { ...count, previousCountId, reason, requestId: randomUUID() });
      const { totals } = await json(path, 200);
      return { countId: id, expected: expectedCashCounts(totals) };
    },
    async cleanup() {
      await stop();
      await rm(folder, { recursive: true, force: true });
    },
  };
}
