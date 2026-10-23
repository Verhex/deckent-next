// f5: the realm's process bounds have no unbounded fallback: a missing limiter, or one that does not apply the registry's bounds, closes the channel
// typed before the CLI runs. The registry's limiter path is replaced here only (fake CLI, no model call).
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initLine, resultLine } from '../../fixtures/native-headless/stream.js';
import { cleanupConnections, connection } from '../../fixtures/native-headless/connection.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

const state = vi.hoisted(() => ({ limiter: null as string | null }));
vi.mock('#adapters/core/native-cli-registry/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('#adapters/core/native-cli-registry/index.js')>();
  return { ...original, nativeCliHeadless: (family: string) => {
    const found = original.nativeCliHeadless(family);
    if (!found || state.limiter === null) return found;
    const isolation = { ...found.headless.isolation, limits: { ...found.headless.isolation.limits, limiter: state.limiter } };
    return { ...found, headless: { ...found.headless, isolation } };
  } };
});
afterEach(async () => { state.limiter = null; await cleanupConnections(); });
const sandbox = (await measureTestShellHost()).bubblewrap.status === 'available';

describe.skipIf(process.platform !== 'linux' || !sandbox)('f5 the realm bounds are applied or the CLI never runs', () => {
  it('refuses typed before any spawn when the limiter is missing', async () => {
    const c = await connection({ steps: [{ line: initLine() }, { line: resultLine('{}') }] });
    state.limiter = join(c.root, 'no-such-prlimit');
    await expect(c.port.preflight(c.profile)).rejects.toMatchObject({ code: 'HEADLESS_ISOLATION_UNAVAILABLE', params: { check: 'limits' } });
    expect(await c.log()).toEqual([]);
  });
  it('refuses typed when the limiter runs the relay without the registry bounds (the relay checks its own limits first)', async () => {
    const c = await connection({ steps: [{ line: initLine() }, { line: resultLine('{}') }] });
    // A limiter that skips its options and runs the rest unbounded.
    const limiter = join(c.root, 'bin', 'unbounded-limiter');
    await writeFile(limiter, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n'); await chmod(limiter, 0o700);
    state.limiter = limiter;
    await expect(c.port.preflight(c.profile)).rejects.toMatchObject({ code: 'HEADLESS_ISOLATION_UNAVAILABLE', params: { check: 'limits' } });
    expect(await c.log()).toEqual([]);
  });
});
