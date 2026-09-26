import { authenticateSession } from '../../../src/engine/core/authentication/index.js';
import { SystemTrustedClock } from '../../../src/platform/core/clock/index.js';
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalRuntimeSocketError, createLocalPeerSession, requestLocalRuntime, startLocalRuntimeSocketServer,
  type LocalRuntimeSocketOptions } from '../../../src/adapters/core/local-runtime-socket/index.js';
import { encodeServiceFrame, ServiceFrameError } from '../../../src/adapters/core/local-runtime-socket/index.js';

const owned: string[] = [];
async function fixture(): Promise<{ root: string; options: LocalRuntimeSocketOptions }> {
  const root = await mkdtemp(join(tmpdir(), 'deckent-runtime-'));
  owned.push(root);
  const parent = join(root, 'private');
  await mkdir(parent, { mode: 0o700 });
  return { root, options: { endpoint: join(parent, 'runtime.sock'), maxConnections: 8, inputMaxBytes: 4096,
    responseMaxBytes: 4096, acceptRetryDelayMs: 25, acceptRetryLimit: 3, headerTimeoutMs: 1_000, responseTimeoutMs: 1_000 } };
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

describe.skipIf(process.platform !== 'linux')('local runtime socket request admission', () => {
  it('rejects an oversized complete request before it connects to the owned endpoint', async () => {
    const { options } = await fixture(); let connections = 0;
    const raw = createServer(() => { connections++; });
    await new Promise<void>((resolve, reject) => {
      raw.once('error', reject); raw.listen(options.endpoint, () => { raw.off('error', reject); resolve(); });
    });
    await chmod(options.endpoint, 0o600);
    try {
      await expect(requestLocalRuntime({ ...options, inputMaxBytes: 64 }, { schemaVersion: 14, requestId: 'request-1',
        operation: 'inspectRun', input: { payload: 'x'.repeat(128) } })).rejects.toSatisfy(error => {
          expect(error).toBeInstanceOf(ServiceFrameError); expect((error as ServiceFrameError).code).toBe('SERVICE_FRAME_LIMIT'); return true;
        });
      expect(connections).toBe(0);
    } finally { await new Promise<void>(resolve => raw.close(() => resolve())); }
  });

  it('rejects a pre-aborted client signal without dispatching a handler', async () => {
    const { options } = await fixture(); let calls = 0; const signal = new AbortController(); signal.abort();
    const server = await startLocalRuntimeSocketServer(options, async request => {
      calls++; return { schemaVersion: 14, requestId: request.requestId, ok: true, result: null };
    });
    try {
      await expect(requestLocalRuntime(options, { schemaVersion: 14, requestId: 'request-1', operation: 'inspectRun', input: {} }, signal.signal))
        .rejects.toSatisfy(error => { expectCode(error, 'LOCAL_RUNTIME_TRANSPORT'); return true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(calls).toBe(0);
    } finally { await server.dispose(); }
  });

  it('serves one correlated framed request per connection with strict endpoint permissions', async () => {
    const { options } = await fixture();
    const server = await startLocalRuntimeSocketServer(options, async request => ({ schemaVersion: 14,
      requestId: request.requestId, ok: true, result: { operation: request.operation } }));
    try {
      expect((await lstat(options.endpoint)).mode & 0o777).toBe(0o600);
      await expect(requestLocalRuntime(options, { schemaVersion: 14, requestId: 'request-1',
        operation: 'inspectRun', input: {} })).resolves.toMatchObject({ requestId: 'request-1', ok: true,
          result: { operation: 'inspectRun' } });
    } finally { await server.dispose(); }
  });

  it('keeps describe and shutdown reachable in the previous protocol version and answers in that version; nothing else', async () => {
    const { options } = await fixture(); const seen: string[] = [];
    const server = await startLocalRuntimeSocketServer(options, async request => {
      seen.push(`${request.schemaVersion}:${request.operation}`); return { schemaVersion: 14, requestId: request.requestId, ok: true, result: { operation: request.operation } };
    });
    try {
      // An older (v10) client describing a service started from a newer build gets a v10 answer.
      await expect(requestLocalRuntime(options, { schemaVersion: 13, requestId: 'request-1', operation: 'describeService', input: {} }))
        .resolves.toMatchObject({ requestId: 'request-1', ok: true, result: { operation: 'describeService' } });
      // Effectful or other operations stay current-version only (refused before dispatch, no client-side downgrade either).
      await expect(requestLocalRuntime(options, { schemaVersion: 13, requestId: 'request-2', operation: 'inspectRun', input: {} } as never)).rejects.toThrow();
      const raw = await connect(options.endpoint);
      raw.end(encodeServiceFrame({ schemaVersion: 13, requestId: 'request-3', operation: 'inspectRun', input: {} }, options.inputMaxBytes));
      await once(raw, 'close');
      expect(seen).toEqual(['14:describeService']);
    } finally { await server.dispose(); }
  });

  it('carries bounded typed-error parameters in the current and the previous (v13) lifecycle envelope', async () => {
    const { options } = await fixture();
    const server = await startLocalRuntimeSocketServer(options, async request => ({ schemaVersion: 14, requestId: request.requestId, ok: false,
      error: { code: 'CONFIG_VALIDATION', category: 'config', params: { issues: 'terminal.scopeId: unrecognized key' } } }));
    try {
      await expect(requestLocalRuntime(options, { schemaVersion: 14, requestId: 'request-1', operation: 'inspectRun', input: {} }))
        .resolves.toMatchObject({ ok: false, error: { code: 'CONFIG_VALIDATION', params: { issues: 'terminal.scopeId: unrecognized key' } } });
      const older = await requestLocalRuntime(options, { schemaVersion: 13, requestId: 'request-2', operation: 'describeService', input: {} });
      // The client normalizes the previous version's envelope to the current one; the parameters survive the round trip.
      expect(older).toEqual({ schemaVersion: 14, requestId: 'request-2', ok: false,
        error: { code: 'CONFIG_VALIDATION', category: 'config', params: { issues: 'terminal.scopeId: unrecognized key' } } });
    } finally { await server.dispose(); }
  });

  it('rejects the retired v7 request envelope before dispatch', async () => {
    const { options } = await fixture(); let calls = 0;
    const server = await startLocalRuntimeSocketServer(options, async request => {
      calls++; return { schemaVersion: 14, requestId: request.requestId, ok: true, result: null };
    });
    try {
      const socket = await connect(options.endpoint);
      socket.end(encodeServiceFrame({ schemaVersion: 7, requestId: 'retired-v7', operation: 'inspectRun', input: {} }, 4096));
      await new Promise<void>(resolve => socket.once('close', () => resolve()));
      expect(calls).toBe(0);
    } finally { await server.dispose(); }
  });

  it('does not dispatch malformed or extra frames', async () => {
    const { options } = await fixture();
    let calls = 0;
    const server = await startLocalRuntimeSocketServer(options, async request => {
      calls += 1; return { schemaVersion: 14, requestId: request.requestId, ok: true, result: null };
    });
    try {
      const socket = await connect(options.endpoint);
      const frame = encodeServiceFrame({ schemaVersion: 14, requestId: 'request-1', operation: 'inspectRun', input: {} }, 4096);
      socket.end(Buffer.concat([frame, Buffer.from([0])]));
      await new Promise<void>(resolve => socket.once('close', () => resolve()));
      expect(calls).toBe(0);
    } finally { await server.dispose(); }
  });
});

describe.skipIf(process.platform !== 'linux')('local runtime socket peer identity and endpoint custody', () => {
  it('delivers immutable kernel peer identity instead of client supplied actor fields', async () => {
    const { options } = await fixture();
    const server = await startLocalRuntimeSocketServer(options, async (request, peer) => {
      expect(Object.isFrozen(peer)).toBe(true);
      return { schemaVersion: 14, requestId: request.requestId, ok: true, result: peer };
    });
    try {
      await expect(requestLocalRuntime(options, { schemaVersion: 14, requestId: 'peer-proof',
        operation: 'inspectRun', input: { actor: { uid: 0, pid: 1 } } })).resolves.toMatchObject({
        ok: true, result: { uid: process.getuid!(), gid: process.getgid!(), pid: process.pid, assurance: 'linux-so-peercred' },
      });
    } finally { await server.dispose(); }
  });

  it('authenticates a live native peer and revokes its session when that connection closes', async () => {
    const { options } = await fixture(); const clock = new SystemTrustedClock();
    let retained: Awaited<ReturnType<typeof createLocalPeerSession>> | undefined;
    let session: Awaited<ReturnType<typeof authenticateSession>>['session'] | undefined;
    const server = await startLocalRuntimeSocketServer(options, async (request, peer) => {
      retained = await createLocalPeerSession(peer, ['scope'], 10_000, clock);
      const authenticated = await authenticateSession(retained, retained, clock, undefined, 'scope');
      session = authenticated.session;
      return { schemaVersion: 14, requestId: request.requestId, ok: true, result: { active: true } };
    });
    try {
      await expect(requestLocalRuntime(options, { schemaVersion: 14, requestId: 'session-proof',
        operation: 'inspectRun', input: {} })).resolves.toMatchObject({ ok: true, result: { active: true } });
      await server.dispose();
      expect(await retained!.isSessionActive(session!)).toBe(false);
    } finally { await server.dispose(); }
  });

  it('rejects a fully disconnected live client before a privileged mutation while allowing request half-close', async () => {
    const { options } = await fixture(); const clock = new SystemTrustedClock();
    let ready!: () => void; const admitted = new Promise<void>(resolve => { ready = resolve; });
    let proceed!: () => void; const barrier = new Promise<void>(resolve => { proceed = resolve; });
    let finish!: (value: { active: boolean; eventAborted: boolean }) => void;
    const active = new Promise<{ active: boolean; eventAborted: boolean }>(resolve => { finish = resolve; });
    const server = await startLocalRuntimeSocketServer(options, async (request, peer) => {
      const authority = await createLocalPeerSession(peer, ['scope'], 10_000, clock);
      const verified = await authenticateSession(authority, authority, clock, undefined, 'scope');
      ready(); await barrier;
      finish({ active: await authority.isSessionActive(verified.session), eventAborted: peer.connection!.aborted });
      return { schemaVersion: 14, requestId: request.requestId, ok: true, result: null };
    });
    const client = await connect(options.endpoint); client.on('error', () => undefined);
    try {
      client.end(encodeServiceFrame({ schemaVersion: 14, requestId: 'disconnect', operation: 'inspectRun', input: {} }, options.inputMaxBytes));
      await admitted;
      const closed = once(client, 'close'); client.destroy(); await closed; proceed();
      expect(await active).toEqual({ active: false, eventAborted: false }); // Kernel witness rejects before the delayed Node close event.
    } finally { proceed(); client.destroy(); await server.dispose(); }
  });

  it('releases the guard when endpoint cleanup is refused without deleting the replacement', async () => {
    const { options } = await fixture();
    const handler = async (request: { requestId: string }) => ({ schemaVersion: 14 as const,
      requestId: request.requestId, ok: true as const, result: null });
    const server = await startLocalRuntimeSocketServer(options, handler);
    await rm(options.endpoint); await writeFile(options.endpoint, 'replacement', { mode: 0o600 });
    await expect(server.dispose()).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_ENDPOINT_UNSAFE' });
    expect(await readFile(options.endpoint, 'utf8')).toBe('replacement');
    await rm(options.endpoint);
    const next = await startLocalRuntimeSocketServer(options, handler);
    await next.dispose();
  });

  it('holds exclusive ownership and releases it on ordered close', async () => {
    const { options } = await fixture();
    const first = await startLocalRuntimeSocketServer(options, async request => ({ schemaVersion: 14,
      requestId: request.requestId, ok: true, result: null }));
    try {
      await expect(startLocalRuntimeSocketServer(options, async request => ({ schemaVersion: 14,
        requestId: request.requestId, ok: true, result: null }))).rejects.toSatisfy(error => {
          expectCode(error, 'LOCAL_RUNTIME_ALREADY_RUNNING'); return true;
        });
      first.stopAccepting();
      await expect(startLocalRuntimeSocketServer(options, async request => ({ schemaVersion: 14,
        requestId: request.requestId, ok: true, result: null }))).rejects.toSatisfy(error => {
          expectCode(error, 'LOCAL_RUNTIME_ALREADY_RUNNING'); return true;
        });
    } finally { await first.dispose(); }
    const restarted = await startLocalRuntimeSocketServer(options, async request => ({ schemaVersion: 14,
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
      const restarted = await startLocalRuntimeSocketServer(options, async request => ({ schemaVersion: 14,
        requestId: request.requestId, ok: true, result: null }));
      await restarted.dispose();
    } finally { await terminate(child); }
  });

  it('never deletes an unsafe endpoint file or symlink', async () => {
    const regular = await fixture();
    await writeFile(regular.options.endpoint, 'keep');
    await expect(startLocalRuntimeSocketServer(regular.options, async request => ({ schemaVersion: 14,
      requestId: request.requestId, ok: true, result: null }))).rejects.toSatisfy(error => {
        expectCode(error, 'LOCAL_RUNTIME_ENDPOINT_UNSAFE'); return true;
      });
    expect(await readFile(regular.options.endpoint, 'utf8')).toBe('keep');

    const linked = await fixture();
    const target = join(linked.root, 'target');
    await writeFile(target, 'keep');
    await symlink(target, linked.options.endpoint);
    await expect(startLocalRuntimeSocketServer(linked.options, async request => ({ schemaVersion: 14,
      requestId: request.requestId, ok: true, result: null }))).rejects.toSatisfy(error => {
        expectCode(error, 'LOCAL_RUNTIME_ENDPOINT_UNSAFE'); return true;
      });
    expect(await readFile(target, 'utf8')).toBe('keep');
  });


});

describe.skipIf(process.platform !== 'linux')('local runtime socket response delivery', () => {
  it('disconnects only the aborting client after admission while its held handler settles once', async () => {
    const { options } = await fixture(); const controller = new AbortController();
    let release!: () => void; let entered!: () => void; let calls = 0; let settled = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    const server = await startLocalRuntimeSocketServer(options, async request => {
      calls++; entered(); await gate; settled++;
      return { schemaVersion: 14, requestId: request.requestId, ok: true, result: null };
    });
    try {
      const pending = requestLocalRuntime(options, { schemaVersion: 14, requestId: 'request-1', operation: 'inspectRun', input: {} }, controller.signal);
      await started; controller.abort();
      await expect(pending).rejects.toSatisfy(error => { expectCode(error, 'LOCAL_RUNTIME_TRANSPORT'); return true; });
      expect(calls).toBe(1); expect(settled).toBe(0);
      release();
      for (let i = 0; i < 20 && settled === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(settled).toBe(1); expect(calls).toBe(1);
    } finally { release(); await server.dispose(); }
  });

  it('continues an admitted handler after the client disconnects', async () => {
    const { options } = await fixture();
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    const server = await startLocalRuntimeSocketServer(options, async request => {
      await new Promise(resolve => setTimeout(resolve, 20));
      complete();
      return { schemaVersion: 14, requestId: request.requestId, ok: true, result: null };
    });
    try {
      const socket = await connect(options.endpoint);
      socket.end(encodeServiceFrame({ schemaVersion: 14, requestId: 'request-1', operation: 'inspectRun', input: {} }, 4096));
      socket.destroy();
      await completed;
    } finally { await server.dispose(); }
  });

  it('hands a wrapped reply off once after its successful response flush', async () => {
    const { options } = await fixture(); let handoffs = 0;
    const server = await startLocalRuntimeSocketServer(options, async request => ({ response: { schemaVersion: 14,
      requestId: request.requestId, ok: true, result: null }, afterResponseOrDisconnect() { handoffs++; } }));
    try {
      await expect(requestLocalRuntime(options, { schemaVersion: 14, requestId: 'request-1', operation: 'inspectRun', input: {} }))
        .resolves.toMatchObject({ ok: true });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(handoffs).toBe(1);
    } finally { await server.dispose(); }
  });

  it('hands a wrapped reply off after a client disconnects before its handler resolves', async () => {
    const { options } = await fixture(); let release!: () => void; let entered!: () => void; let handoffs = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    const server = await startLocalRuntimeSocketServer(options, async request => {
      entered(); await gate;
      return { response: { schemaVersion: 14, requestId: request.requestId, ok: true, result: null }, afterResponseOrDisconnect() { handoffs++; } };
    });
    try {
      const socket = await connect(options.endpoint);
      socket.end(encodeServiceFrame({ schemaVersion: 14, requestId: 'request-1', operation: 'inspectRun', input: {} }, 4096));
      await started; socket.destroy(); release();
      for (let i = 0; i < 20 && handoffs === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(handoffs).toBe(1);
    } finally { await server.dispose(); }
  });

  it('does not provide a handoff when the handler throws a plain transport response', async () => {
    const { options } = await fixture(); let handlers = 0;
    const server = await startLocalRuntimeSocketServer(options, async () => { handlers++; throw new Error('private'); });
    try {
      await expect(requestLocalRuntime(options, { schemaVersion: 14, requestId: 'request-1', operation: 'inspectRun', input: {} }))
        .resolves.toMatchObject({ ok: false });
      expect(handlers).toBe(1);
    } finally { await server.dispose(); }
  });

  it('delivers a typed response limit and hands the admitted effect off exactly once', async () => {
    const { options } = await fixture(); let handoffs = 0;
    const server = await startLocalRuntimeSocketServer(options, async request => ({ response: { schemaVersion: 14,
      requestId: request.requestId, ok: true, result: 'x'.repeat(options.responseMaxBytes) }, afterResponseOrDisconnect() { handoffs++; } }));
    try {
      await expect(requestLocalRuntime(options, { schemaVersion: 14, requestId: 'request-1', operation: 'inspectRun', input: {} }))
        .resolves.toEqual({ schemaVersion: 14, requestId: 'request-1', ok: false, error: { code: 'RUNTIME_SERVICE_RESPONSE_LIMIT', category: 'error' } });
      for (let i = 0; i < 20 && handoffs === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(handoffs).toBe(1);
    } finally { await server.dispose(); }
  });

  it('checks the actual correlated error envelope before dispatch at the exact byte boundary', async () => {
    const { options } = await fixture(); const requestId = 'çağrı-"\\-界'; let effects = 0;
    const expected = { schemaVersion: 14, requestId, ok: false, error: { code: 'RUNTIME_SERVICE_RESPONSE_LIMIT', category: 'error' } };
    const errorBytes = Buffer.byteLength(JSON.stringify(expected), 'utf8');
    for (const responseMaxBytes of [errorBytes - 1, errorBytes]) {
      const bounded = { ...options, responseMaxBytes };
      const server = await startLocalRuntimeSocketServer(bounded, async request => {
        effects++;
        return { schemaVersion: 14, requestId: request.requestId, ok: true, result: 'x'.repeat(options.responseMaxBytes) };
      });
      try {
        const response = requestLocalRuntime(bounded, { schemaVersion: 14, requestId, operation: 'inspectRun', input: {} });
        if (responseMaxBytes < errorBytes) { await expect(response).rejects.toBeDefined(); expect(effects).toBe(0); }
        else { await expect(response).resolves.toEqual(expected); expect(effects).toBe(1); }
      } finally { await server.dispose(); }
    }
  });

  it('disconnects a client without cancelling an admitted handler', async () => {
    const { options } = await fixture();
    let release!: () => void; let entered!: () => void; let completed = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const server = await startLocalRuntimeSocketServer(options, async request => {
      entered(); await gate; completed = true;
      return { schemaVersion: 14, requestId: request.requestId, ok: true, result: null };
    });
    try {
      const socket = await connect(options.endpoint);
      socket.end(encodeServiceFrame({ schemaVersion: 14, requestId: 'request-1', operation: 'inspectRun', input: {} }, 4096));
      await started; server.stopAccepting(); const disposed = server.dispose(); server.disconnectClients();
      await disposed; expect(completed).toBe(false); release();
      for (let i = 0; i < 20 && !completed; i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(completed).toBe(true);
    } finally { server.disconnectClients(); await server.dispose(); }
  });

  it('rejects a handler response with the wrong correlation identity', async () => {
    const { options } = await fixture();
    const server = await startLocalRuntimeSocketServer(options, async () => ({ schemaVersion: 14,
      requestId: 'foreign-request', ok: true, result: 'private' }));
    try {
      await expect(requestLocalRuntime(options, { schemaVersion: 14, requestId: 'request-1', operation: 'inspectRun', input: {} }))
        .resolves.toEqual({ schemaVersion: 14, requestId: 'request-1', ok: false,
          error: { code: 'RUNTIME_SERVICE_TRANSPORT', category: 'error' } });
    } finally { await server.dispose(); }
  });
});

describe.skipIf(process.platform !== 'linux')('local runtime socket lifecycle edges', () => {
  it('sanitizes a synchronous handler failure and does not strand the server', async () => {
    const { options } = await fixture();
    const server = await startLocalRuntimeSocketServer(options, () => { throw new Error('private'); });
    try {
      await expect(requestLocalRuntime(options, { schemaVersion: 14, requestId: 'request-1', operation: 'inspectRun', input: {} }))
        .resolves.toEqual({ schemaVersion: 14, requestId: 'request-1', ok: false,
          error: { code: 'RUNTIME_SERVICE_TRANSPORT', category: 'error' } });
    } finally { await server.dispose(); }
  });

  it('disconnects a pre-admission half-open request while retaining the guard until disposal', async () => {
    const fixtureValue = await fixture();
    const options = { ...fixtureValue.options, headerTimeoutMs: 1_000 };
    const server = await startLocalRuntimeSocketServer(options, async request => ({ schemaVersion: 14,
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
      await expect(requestLocalRuntime(options, { schemaVersion: 14, requestId: 'request-1', operation: 'inspectRun', input: {} }))
        .rejects.toSatisfy(error => { expectCode(error, 'LOCAL_RUNTIME_TRANSPORT'); return true; });
    } finally { await new Promise<void>(resolve => raw.close(() => resolve())); }
  });
});
