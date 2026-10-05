import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, link, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLocalRuntimeSocketGuard, LocalRuntimeSocketError, type LocalRuntimeSocketOptions } from '../../../src/adapters/core/local-runtime-socket/index.js';

// LEDGER-SINGLETON (owner 2026-09-28): the runtime service's custody of its ledger is a kernel lock on the ledger's private
// companion file, taken before the endpoint guard, held with it and released with it. It is independent of the endpoint path and
// of the network namespace, and the kernel frees it when the holder dies: no exec'd child of the holder inherits it.
const owned: string[] = [], pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  await Promise.all(owned.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-ledger-lock-')); owned.push(root);
  const parent = join(root, 'private'); await mkdir(parent, { mode: 0o700 });
  const options = (name: string): LocalRuntimeSocketOptions => ({ endpoint: join(parent, `${name}.sock`), maxConnections: 8, inputMaxBytes: 4096,
    responseMaxBytes: 4096, acceptRetryDelayMs: 25, acceptRetryLimit: 3, headerTimeoutMs: 1_000, responseTimeoutMs: 1_000 });
  return { root, parent, lock: join(parent, 'ledger.db-lock'), options };
}
async function code(work: Promise<unknown>): Promise<string> {
  try { await work; return 'resolved'; }
  catch (error) { expect(error).toBeInstanceOf(LocalRuntimeSocketError); return (error as LocalRuntimeSocketError).code; }
}
const handler = async (request: { requestId: string }) => ({ schemaVersion: 20 as const, requestId: request.requestId, ok: true as const, result: null });
/** Descriptors of this process open on `path`, with their open flags from /proc. */
async function descriptors(path: string) {
  const found: { fd: string; flags: number }[] = [];
  for (const fd of await readdir('/proc/self/fd')) {
    let target: string; try { target = await readlink(`/proc/self/fd/${fd}`); } catch { continue; }
    if (target !== path) continue;
    const flags = /^flags:\s+([0-7]+)$/m.exec(await readFile(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1];
    found.push({ fd, flags: Number.parseInt(flags ?? 'x', 8) });
  }
  return found;
}

describe.skipIf(process.platform !== 'linux')('runtime ledger custody', () => {
  it('refuses a second custody of the same ledger through another endpoint, without taking that endpoint, until the first is released', async () => {
    const f = await fixture();
    const first = await acquireLocalRuntimeSocketGuard(f.options('a'), f.lock);
    expect(await code(acquireLocalRuntimeSocketGuard(f.options('b'), f.lock))).toBe('LOCAL_RUNTIME_ALREADY_RUNNING');
    // The refused start never held endpoint b: another ledger can use it at once.
    const other = await acquireLocalRuntimeSocketGuard(f.options('b'), join(f.parent, 'other.db-lock'));
    await other.release();
    await first.release();
    const second = await acquireLocalRuntimeSocketGuard(f.options('b'), f.lock);
    await second.release();
  });

  it('keeps the ledger custody while the listener runs and releases it only at dispose, like the endpoint guard', async () => {
    const f = await fixture();
    const server = await (await acquireLocalRuntimeSocketGuard(f.options('a'), f.lock)).start(handler);
    expect(await code(acquireLocalRuntimeSocketGuard(f.options('b'), f.lock))).toBe('LOCAL_RUNTIME_ALREADY_RUNNING');
    server.stopAccepting();
    expect(await code(acquireLocalRuntimeSocketGuard(f.options('b'), f.lock))).toBe('LOCAL_RUNTIME_ALREADY_RUNNING');
    await server.dispose();
    await (await acquireLocalRuntimeSocketGuard(f.options('b'), f.lock)).release();
  });

  it('releases the ledger custody when the listener cannot start', async () => {
    const f = await fixture();
    await writeFile(f.options('a').endpoint, 'not a socket', { mode: 0o600 });
    expect(await code((await acquireLocalRuntimeSocketGuard(f.options('a'), f.lock)).start(handler))).toBe('LOCAL_RUNTIME_ENDPOINT_UNSAFE');
    await (await acquireLocalRuntimeSocketGuard(f.options('b'), f.lock)).release();
  });

  it('holds the lock on one close-on-exec descriptor of a private single-link file', async () => {
    const f = await fixture();
    const guard = await acquireLocalRuntimeSocketGuard(f.options('a'), f.lock);
    try {
      const held = await descriptors(f.lock);
      expect(held).toHaveLength(1);
      expect(held[0]!.flags & 0o2000000).toBe(0o2000000);
    } finally { await guard.release(); }
    expect(await descriptors(f.lock)).toEqual([]);
  });

  it('refuses an unsafe lock file (symlink, shared mode, second link) and takes no custody', async () => {
    const f = await fixture();
    await writeFile(join(f.parent, 'target'), '', { mode: 0o600 });
    await symlink(join(f.parent, 'target'), f.lock);
    expect(await code(acquireLocalRuntimeSocketGuard(f.options('a'), f.lock))).toBe('LOCAL_RUNTIME_ENDPOINT_UNSAFE');
    await rm(f.lock); await writeFile(f.lock, '', { mode: 0o600 }); await chmod(f.lock, 0o644);
    expect(await code(acquireLocalRuntimeSocketGuard(f.options('a'), f.lock))).toBe('LOCAL_RUNTIME_ENDPOINT_UNSAFE');
    await chmod(f.lock, 0o600); await link(f.lock, join(f.parent, 'second-link'));
    expect(await code(acquireLocalRuntimeSocketGuard(f.options('a'), f.lock))).toBe('LOCAL_RUNTIME_ENDPOINT_UNSAFE');
    expect(await code(acquireLocalRuntimeSocketGuard(f.options('a'), 'relative/ledger.db-lock'))).toBe('LOCAL_RUNTIME_OPTIONS');
    // Nothing was held by the refusals: the endpoint is free.
    await (await acquireLocalRuntimeSocketGuard(f.options('a'))).release();
  });

  it('is freed by the kernel when its holder is SIGKILLed, although a detached child of the holder is still alive', async () => {
    const f = await fixture();
    const adapter = resolve('dist/adapters/core/local-runtime-socket/index.js');
    const holder = spawn(process.execPath, ['--input-type=module', '-e', `
      import { spawn } from 'node:child_process';
      const { acquireLocalRuntimeSocketGuard } = await import(${JSON.stringify(adapter)});
      await acquireLocalRuntimeSocketGuard(${JSON.stringify(f.options('a'))}, ${JSON.stringify(f.lock)});
      const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' }); child.unref();
      process.stdout.write('held ' + child.pid + '\\n');
      setInterval(() => undefined, 1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    holder.stdout!.on('data', chunk => { stdout += String(chunk); }); holder.stderr!.on('data', chunk => { stderr += String(chunk); });
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error(`HOLDER_TIMEOUT:${stderr}`)), 10_000);
        holder.stdout!.on('data', () => { if (/held \d+\n/.test(stdout)) { clearTimeout(timer); done(); } });
        holder.once('exit', () => { clearTimeout(timer); reject(new Error(`HOLDER_EXIT:${stderr}`)); });
      });
      const grandchild = Number(/held (\d+)/.exec(stdout)![1]); pids.push(grandchild);
      expect(await code(acquireLocalRuntimeSocketGuard(f.options('b'), f.lock))).toBe('LOCAL_RUNTIME_ALREADY_RUNNING');
      holder.kill('SIGKILL'); await once(holder, 'exit');
      process.kill(grandchild, 0); // still alive
      await (await acquireLocalRuntimeSocketGuard(f.options('b'), f.lock)).release();
    } finally { if (holder.exitCode === null && holder.signalCode === null) { holder.kill('SIGKILL'); await once(holder, 'exit'); } }
  }, 30_000);
});
