import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export async function testServer() {
  const folder = await mkdtemp(join(tmpdir(), 'tejo-billar-test-'));
  let child;
  let base;

  async function start() {
    child = spawn(process.execPath, ['dist/server/index.js'], {
      env: { ...process.env, PORT: '0', CAJA_DB_PATH: join(folder, 'test.sqlite') },
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
  }

  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
  }

  function fetchLocal(path, options) {
    return fetch(base + path, options);
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
    start, stop, fetch: fetchLocal, json,
    async cleanup() {
      await stop();
      await rm(folder, { recursive: true, force: true });
    },
  };
}
