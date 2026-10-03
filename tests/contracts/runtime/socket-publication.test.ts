import { createRequire } from 'node:module';
import { access, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNTIME_SERVICE_SCHEMA_VERSION } from '#engine/index.js';
import { prepareProductSocket, resolveProductLayout } from '#platform/index.js';
import { startLocalRuntimeSocketServer, type LocalRuntimeSocketOptions } from '#adapters/core/local-runtime-socket/index.js';

const roots: string[] = [];
const options = (endpoint: string): LocalRuntimeSocketOptions => ({ endpoint, maxConnections: 8, inputMaxBytes: 4096,
  responseMaxBytes: 4096, headerTimeoutMs: 1000, responseTimeoutMs: 1000, acceptRetryDelayMs: 25, acceptRetryLimit: 3 });
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'deckent-pub-')); roots.push(path); return path;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe.skipIf(process.platform !== 'linux')('private runtime socket publication', () => {
  it('native publication immediately satisfies the unchanged managed-file guard and cleans staging on disposal', async () => {
    const path = await root(); const parent = join(path, 'state'); await mkdir(parent, { mode: 0o700 });
    const endpoint = join(parent, 'runtime.sock'); const layout = resolveProductLayout({ projectRoot: path, root: path });
    const server = await startLocalRuntimeSocketServer(options(endpoint), async request => ({
      schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: true, result: null,
    }));
    try {
      expect((await lstat(endpoint)).mode & 0o7777).toBe(0o600);
      await expect(prepareProductSocket(layout, 'runtimeSocket', false)).resolves.toBe(endpoint);
      expect(await readdir(parent)).toEqual(['runtime.sock']);
    } finally { await server.dispose(); }
    expect(await readdir(parent)).toEqual([]);
  });

  it('refuses a staging path over the UTF-8 byte budget before acquiring custody or creating files', async () => {
    const path = await root(); const prefix = 'é';
    const parent = join(path, prefix + 'a'.repeat(97 - Buffer.byteLength(path) - 1 - Buffer.byteLength(prefix)));
    await mkdir(parent, { mode: 0o700 }); const endpoint = join(parent, 'x');
    expect(Buffer.byteLength(endpoint)).toBeLessThan(108);
    await expect(startLocalRuntimeSocketServer(options(endpoint), async () => { throw new Error('never dispatch'); }))
      .rejects.toMatchObject({ code: 'LOCAL_RUNTIME_OPTIONS' });
    expect(await readdir(parent)).toEqual([]);
  });

  it('maps unsupported NOREPLACE to a typed surface refusal, releases custody and permits a supported fresh start', async () => {
    const path = await root(); const endpoint = join(path, 'runtime.sock');
    const require = createRequire(import.meta.url);
    const artifact = require.resolve(resolve('src/adapters/core/local-runtime-socket/native/build/Release/peer_credentials.node'));
    const production = require(artifact) as Record<string, unknown>;
    const injected = require(resolve('src/adapters/core/local-runtime-socket/native/build/Test/peer_credentials.node')) as {
      __testFailNextStart(mode: number): void; createListener: (...args: unknown[]) => unknown;
    };
    const cached = require.cache[artifact]; if (!cached) throw new Error('NATIVE_FIXTURE_CACHE');
    cached.exports = { ...production, createListener: (...args: unknown[]) => {
      injected.__testFailNextStart(6); return injected.createListener(...args);
    } };
    try {
      await expect(startLocalRuntimeSocketServer(options(endpoint), async () => { throw new Error('never dispatch'); }))
        .rejects.toMatchObject({ code: 'LOCAL_RUNTIME_UNSUPPORTED', cause: { code: 'LOCAL_PEER_PUBLICATION_UNSUPPORTED' } });
      await expect(access(endpoint)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(path)).toEqual([]);
    } finally { cached.exports = production; }
    const server = await startLocalRuntimeSocketServer(options(endpoint), async request => ({
      schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: true, result: null,
    }));
    await server.dispose(); expect(await readdir(path)).toEqual([]);
  });
});
