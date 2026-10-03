import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';

// umask belongs to this isolated publisher process, never the native implementation.
const [artifact, mask, repetitions = '128'] = process.argv.slice(2);
const addon = createRequire(import.meta.url)(artifact);
process.umask(Number.parseInt(mask, 8));
const root = mkdtempSync(join(tmpdir(), 'deckent-pub-'));
const endpoint = join(root, 'runtime.sock');
const state = new Int32Array(new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT));
const watcher = new Worker(`
  const { workerData, parentPort } = require('node:worker_threads');
  const { lstatSync } = require('node:fs');
  const state = new Int32Array(workerData.state);
  parentPort.postMessage('ready');
  while (!Atomics.load(state, 0)) {
    const generation = Atomics.load(state, 2);
    try {
      const stat = lstatSync(workerData.endpoint);
      Atomics.add(state, 3, 1);
      if (!stat.isSocket() || (stat.mode & 0o7777) !== 0o600) {
        Atomics.add(state, 4, 1); Atomics.store(state, 5, stat.mode & 0o7777);
      }
      Atomics.store(state, 1, generation); Atomics.notify(state, 1);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
`, { eval: true, workerData: { state: state.buffer, endpoint } });
let listener; let closed;
try {
  await once(watcher, 'message');
  for (let generation = 1; generation <= Number(repetitions); generation++) {
    Atomics.store(state, 2, generation);
    closed = new Promise(resolve => {
      listener = addon.createListener(endpoint, 8, () => {}, resolve, 25, 3);
    });
    const deadline = performance.now() + 5_000;
    while (Atomics.load(state, 1) !== generation && performance.now() < deadline) {
      Atomics.wait(state, 1, Atomics.load(state, 1), 100);
    }
    assert.equal(Atomics.load(state, 1), generation, 'watcher must observe every publication');
    assert.equal(process.umask(), Number.parseInt(mask, 8), 'native must preserve ambient umask');
    assert.equal(lstatSync(endpoint).mode & 0o7777, 0o600);
    assert.equal(Atomics.load(state, 4), 0, 'final name was observed unsafe');
    listener.close(); await closed; listener.removeEndpoint(); listener = undefined;
  }
} finally {
  Atomics.store(state, 0, 1); await watcher.terminate();
  if (listener) { listener.close(); await closed; listener.removeEndpoint(); }
  console.log(JSON.stringify({ node: process.version, umask: mask, repetitions: Number(repetitions),
    observations: Atomics.load(state, 3), unsafe: Atomics.load(state, 4), lastUnsafeMode: Atomics.load(state, 5).toString(8) }));
  rmSync(root, { recursive: true, force: true });
}
