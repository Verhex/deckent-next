import { chmod, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalRuntimeSocketError, requestLocalRuntime, startLocalRuntimeSocketServer,
  type LocalRuntimeSocketOptions } from '../../../src/adapters/core/local-runtime-socket/index.js';
import { encodeServiceFrame } from '../../../src/adapters/core/local-runtime-socket/index.js';

const owned: string[] = [];
async function fixture(): Promise<{ root: string; options: LocalRuntimeSocketOptions }> {
  const root = await mkdtemp(join(tmpdir(), 'deckent-runtime-'));
  owned.push(root);
  const parent = join(root, 'private');
  await mkdir(parent, { mode: 0o700 });
  return { root, options: { endpoint: join(parent, 'runtime.sock'), maxConnections: 8, inputMaxBytes: 4096,
    responseMaxBytes: 4096, headerTimeoutMs: 1_000 } };
}
afterEach(async () => { await Promise.all(owned.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function expectCode(error: unknown, code: LocalRuntimeSocketError['code']): void {
  expect(error).toBeInstanceOf(LocalRuntimeSocketError);
  expect((error as LocalRuntimeSocketError).code).toBe(code);
}
function connect(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket({ allowHalfOpen: true });
    socket.once('error', reject);
    socket.connect(endpoint, () => { socket.off('error', reject); resolve(socket); });
  });
}
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await once(child, 'exit');
}

describe.skipIf(process.platform !== 'linux')('local runtime socket', () => {
  it('serves one correlated framed request per connection with strict endpoint permissions', async () => {
    const { options } = await fixture();
    const server = await startLocalRuntimeSocketServer(options, async request => ({ schemaVersion: 1,
      requestId: request.requestId, ok: true, result: { operation: request.operation } }));
    try {
      expect((await lstat(options.endpoint)).mode & 0o777).toBe(0o600);
      await expect(requestLocalRuntime(options, { schemaVersion: 1, requestId: 'request-1',
        operation: 'inspectRun', input: {} })).resolves.toMatchObject({ requestId: 'request-1', ok: true,
          result: { operation: 'inspectRun' } });
    } finally { await server.dispose(); }
  });

  it('holds exclusive ownership and releases it on ordered close', async () => {
    const { options } = await fixture();
    const first = await startLocalRuntimeSocketServer(options, async request => ({ schemaVersion: 1,
      requestId: request.requestId, ok: true, result: null }));
    try {
      await expect(startLocalRuntimeSocketServer(options, async request => ({ schemaVersion: 1,
        requestId: request.requestId, ok: true, result: null }))).rejects.toSatisfy(error => {
          expectCode(error, 'LOCAL_RUNTIME_ALREADY_RUNNING'); return true;
        });
      first.stopAccepting();
      await expect(startLocalRuntimeSocketServer(options, async request => ({ schemaVersion: 1,
        requestId: request.requestId, ok: true, result: null }))).rejects.toSatisfy(error => {
          expectCode(error, 'LOCAL_RUNTIME_ALREADY_RUNNING'); return true;
        });
    } finally { await first.dispose(); }
    const restarted = await startLocalRuntimeSocketServer(options, async request => ({ schemaVersion: 1,
      requestId: request.requestId, ok: true, result: null }));
    await restarted.dispose();
  });

  it('reclaims only the stale filesystem socket after a killed owner releases the kernel guard', async () => {
    const { options } = await fixture();
    const childSource = `
      const { createHash } = require('node:crypto');
      const { chmodSync } = require('node:fs');
      const { createServer } = require('node:net');
      const endpoint = process.argv[1];
      const guard = '\\0deckent-' + createHash('sha256').update(endpoint + '\\0' + process.getuid()).digest('hex');
      const held = createServer({ allowHalfOpen: true });
      held.listen(guard, () => {
        const service = createServer({ allowHalfOpen: true });
        service.listen(endpoint, () => { chmodSync(endpoint, 0o600); process.stdout.write('READY\\n'); });
      });`;
    const child = spawn(process.execPath, ['-e', childSource, options.endpoint], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const ready = await Promise.race([
        once(child.stdout!, 'data').then(([chunk]) => String(chunk)),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('child readiness timeout')), 2_000)),
      ]);
      expect(ready).toContain('READY');
      await terminate(child);
      expect((await lstat(options.endpoint)).isSocket()).toBe(true);
      const restarted = await startLocalRuntimeSocketServer(options, async request => ({ schemaVersion: 1,
        requestId: request.requestId, ok: true, result: null }));
      await restarted.dispose();
    } finally { await terminate(child); }
  });

  it('never deletes an unsafe endpoint file or symlink', async () => {
    const regular = await fixture();
    await writeFile(regular.options.endpoint, 'keep');
    await expect(startLocalRuntimeSocketServer(regular.options, async request => ({ schemaVersion: 1,
      requestId: request.requestId, ok: true, result: null }))).rejects.toSatisfy(error => {
        expectCode(error, 'LOCAL_RUNTIME_ENDPOINT_UNSAFE'); return true;
      });
    expect(await readFile(regular.options.endpoint, 'utf8')).toBe('keep');

    const linked = await fixture();
    const target = join(linked.root, 'target');
    await writeFile(target, 'keep');
    await symlink(target, linked.options.endpoint);
    await expect(startLocalRuntimeSocketServer(linked.options, async request => ({ schemaVersion: 1,
      requestId: request.requestId, ok: true, result: null }))).rejects.toSatisfy(error => {
        expectCode(error, 'LOCAL_RUNTIME_ENDPOINT_UNSAFE'); return true;
      });
    expect(await readFile(target, 'utf8')).toBe('keep');
  });

  it('does not dispatch malformed or extra frames', async () => {
    const { options } = await fixture();
    let calls = 0;
    const server = await startLocalRuntimeSocketServer(options, async request => {
      calls += 1; return { schemaVersion: 1, requestId: request.requestId, ok: true, result: null };
    });
    try {
      const socket = await connect(options.endpoint);
      const frame = encodeServiceFrame({ schemaVersion: 1, requestId: 'request-1', operation: 'inspectRun', input: {} }, 4096);
      socket.end(Buffer.concat([frame, Buffer.from([0])]));
      await new Promise<void>(resolve => socket.once('close', () => resolve()));
      expect(calls).toBe(0);
    } finally { await server.dispose(); }
  });

  it('continues an admitted handler after the client disconnects', async () => {
    const { options } = await fixture();
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    const server = await startLocalRuntimeSocketServer(options, async request => {
      await new Promise(resolve => setTimeout(resolve, 20));
      complete();
      return { schemaVersion: 1, requestId: request.requestId, ok: true, result: null };
    });
    try {
      const socket = await connect(options.endpoint);
      socket.end(encodeServiceFrame({ schemaVersion: 1, requestId: 'request-1', operation: 'inspectRun', input: {} }, 4096));
      socket.destroy();
      await completed;
    } finally { await server.dispose(); }
  });

  it('disconnects a client without cancelling an admitted handler', async () => {
    const { options } = await fixture();
    let release!: () => void; let entered!: () => void; let completed = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const server = await startLocalRuntimeSocketServer(options, async request => {
      entered(); await gate; completed = true;
      return { schemaVersion: 1, requestId: request.requestId, ok: true, result: null };
    });
    try {
      const socket = await connect(options.endpoint);
      socket.end(encodeServiceFrame({ schemaVersion: 1, requestId: 'request-1', operation: 'inspectRun', input: {} }, 4096));
      await started; server.stopAccepting(); const disposed = server.dispose(); server.disconnectClients();
      await disposed; expect(completed).toBe(false); release();
      for (let i = 0; i < 20 && !completed; i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(completed).toBe(true);
    } finally { server.disconnectClients(); await server.dispose(); }
  });

  it('rejects a handler response with the wrong correlation identity', async () => {
    const { options } = await fixture();
    const server = await startLocalRuntimeSocketServer(options, async () => ({ schemaVersion: 1,
      requestId: 'foreign-request', ok: true, result: 'private' }));
    try {
      await expect(requestLocalRuntime(options, { schemaVersion: 1, requestId: 'request-1', operation: 'inspectRun', input: {} }))
        .resolves.toEqual({ schemaVersion: 1, requestId: 'request-1', ok: false,
          error: { code: 'RUNTIME_SERVICE_TRANSPORT', category: 'error' } });
    } finally { await server.dispose(); }
  });
});

describe.skipIf(process.platform !== 'linux')('local runtime socket lifecycle edges', () => {
  it('sanitizes a synchronous handler failure and does not strand the server', async () => {
    const { options } = await fixture();
    const server = await startLocalRuntimeSocketServer(options, () => { throw new Error('private'); });
    try {
      await expect(requestLocalRuntime(options, { schemaVersion: 1, requestId: 'request-1', operation: 'inspectRun', input: {} }))
        .resolves.toEqual({ schemaVersion: 1, requestId: 'request-1', ok: false,
          error: { code: 'RUNTIME_SERVICE_TRANSPORT', category: 'error' } });
    } finally { await server.dispose(); }
  });

  it('disconnects a pre-admission half-open request while retaining the guard until disposal', async () => {
    const fixtureValue = await fixture();
    const options = { ...fixtureValue.options, headerTimeoutMs: 1_000 };
    const server = await startLocalRuntimeSocketServer(options, async request => ({ schemaVersion: 1,
      requestId: request.requestId, ok: true, result: null }));
    const socket = await connect(options.endpoint);
    socket.write(Buffer.from([0, 0]));
    server.stopAccepting();
    const guard = `\0deckent-${createHash('sha256').update(`${options.endpoint}\0${process.getuid!()}`).digest('hex')}`;
    const intruder = await connect(guard);
    let disposed = false;
    const disposing = server.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(disposed).toBe(false);
    server.disconnectClients(); await expect(disposing).resolves.toBeUndefined();
    intruder.destroy();
    socket.destroy();
  });

  it('rejects a peer that closes without a response instead of hanging', async () => {
    const { options } = await fixture();
    const raw = createServer({ allowHalfOpen: true }, socket => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      raw.once('error', reject); raw.listen(options.endpoint, () => { raw.off('error', reject); resolve(); });
    });
    await chmod(options.endpoint, 0o600);
    try {
      await expect(requestLocalRuntime(options, { schemaVersion: 1, requestId: 'request-1', operation: 'inspectRun', input: {} }))
        .rejects.toSatisfy(error => { expectCode(error, 'LOCAL_RUNTIME_TRANSPORT'); return true; });
    } finally { await new Promise<void>(resolve => raw.close(() => resolve())); }
  });
});
