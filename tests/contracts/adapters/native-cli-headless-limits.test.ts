// f5: the realm's process bounds have no unbounded fallback: a missing limiter, or one that does not apply the registry's bounds, closes the channel
// typed before the CLI runs. Item 5: no spawn beside the CLI's own refresh lock or another Deckent spawn on the same login dir. The registry's limiter
// path and lock wait are replaced here only (fake CLI, no model call).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { headless, initLine, resultLine } from '../../fixtures/native-headless/stream.js';
import { cleanupConnections, connection } from '../../fixtures/native-headless/connection.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

const state = vi.hoisted(() => ({ limiter: null as string | null, waitMs: null as number | null }));
vi.mock('#adapters/core/native-cli-registry/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('#adapters/core/native-cli-registry/index.js')>();
  return { ...original, nativeCliHeadless: (family: string) => {
    const found = original.nativeCliHeadless(family);
    if (!found || (state.limiter === null && state.waitMs === null)) return found;
    const { isolation: base } = found.headless;
    const isolation = { ...base, limits: { ...base.limits, limiter: state.limiter ?? base.limits.limiter }, refreshLock: { ...base.refreshLock, waitMs: state.waitMs ?? base.refreshLock.waitMs } };
    return { ...found, headless: { ...found.headless, isolation } };
  } };
});
afterEach(async () => { state.limiter = null; state.waitMs = null; await cleanupConnections(); });
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
  it('item 5: waits while the CLI\'s own refresh lock name exists in the login dir, then runs once it is gone; refuses typed past the wait', async () => {
    const c = await connection({ steps: [{ line: initLine() }, { line: resultLine('{}') }] }), lock = join(c.configDir, headless.isolation.refreshLock.names[0]!);
    await mkdir(lock);
    state.waitMs = 300;
    await expect(c.port.preflight(c.profile)).rejects.toMatchObject({ code: 'HEADLESS_LOGIN_BUSY', params: { holder: 'cli' } });
    expect(await c.log()).toEqual([]);
    state.waitMs = null;
    setTimeout(() => { void rm(lock, { recursive: true }); }, 400);
    await c.port.preflight(c.profile);
    expect((await c.log()).map(entry => entry.mode)).toContain('version');
  });
  it('item 5: serializes Deckent spawns per login dir: a live holder makes a second one wait and refuse typed; a dead or old holder is stale', async () => {
    const c = await connection({ steps: [{ line: initLine() }, { line: resultLine('{}') }] });
    const dir = join(c.root, 'login-locks'), path = join(dir, `${createHash('sha256').update(c.configDir).digest('hex').slice(0, 32)}.lock`);
    await mkdir(dir, { mode: 0o700 });
    await writeFile(path, JSON.stringify({ pid: process.pid, atMs: Date.now(), token: 'other' }), { mode: 0o600 });
    state.waitMs = 300;
    await expect(c.port.preflight(c.profile)).rejects.toMatchObject({ code: 'HEADLESS_LOGIN_BUSY', params: { holder: 'deckent' } });
    expect(await c.log()).toEqual([]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ token: 'other' });
    // A holder whose process is gone (beyond pid_max) is stale and replaced; the lock is gone again after the spawns.
    await writeFile(path, JSON.stringify({ pid: 2 ** 30, atMs: Date.now(), token: 'dead' }), { mode: 0o600 });
    await c.port.preflight(c.profile);
    expect((await c.log()).map(entry => entry.mode)).toContain('version'); expect(existsSync(path)).toBe(false);
  });
});
