import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitWorkspaceBroker } from '#adapters/index.js';
const exec = promisify(execFile); const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { await exec('/usr/bin/chmod', ['-R', 'u+rwx', root]).catch(() => undefined); await rm(root, { recursive: true, force: true }); } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-attempt-release-')); roots.push(root);
  const source = join(root, 'source'); const workspaces = join(root, 'workspaces'); await mkdir(source); await mkdir(workspaces, { mode: 0o700 });
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', source, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(source, 'tracked'), 'base'); await git('add', 'tracked'); await git('commit', '-m', 'fixture');
  const broker = new GitWorkspaceBroker({ sourceRoot: source, workspaceRoot: workspaces, gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 });
  const request = { schemaVersion: 1 as const, identity: { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', generation: 1, layoutRevision: 'layout' }, baseCommit: await git('rev-parse', 'HEAD') };
  const lease = await broker.allocate(request);
  return { root, workspaces, broker, request, lease, directory: dirname(lease.workspace) };
}
const present = (path: string) => stat(path).then(() => true, () => false);

describe.skipIf(process.platform === 'win32')('requires POSIX private Git custody: attempt clone release (EXEC-RELEASE)', () => {
  it('detaches then removes only the exact recorded checkout and tells removal from absence', async () => {
    const f = await fixture();
    expect(await f.broker.holds(f.request.identity)).toBe(true);
    await expect(f.broker.releaseAttempt(f.request, join(f.root, 'elsewhere', 'tree'))).rejects.toThrow('WORKSPACE_IDENTITY_CONFLICT');
    await expect(f.broker.releaseAttempt({ ...f.request, baseCommit: 'a'.repeat(40) }, f.lease.workspace)).rejects.toThrow();
    expect(await present(f.lease.workspace)).toBe(true);
    expect(await f.broker.releaseAttempt(f.request, f.lease.workspace)).toBe('removed');
    expect(await present(f.directory)).toBe(false); expect(await f.broker.holds(f.request.identity)).toBe(false);
    expect(await readdir(f.workspaces)).toEqual([]);
    expect(await f.broker.releaseAttempt(f.request, f.lease.workspace)).toBe('absent');
  });
  it('negative 7: never removes an unverified clone (tampered lease, missing lease, unsafe directory)', async () => {
    const f = await fixture(); const leasePath = join(f.directory, 'lease.json'); const original = await readFile(leasePath, 'utf8');
    await writeFile(leasePath, original.replace(/"fingerprint":"[a-f0-9]{64}"/, `"fingerprint":"${'0'.repeat(64)}"`));
    await expect(f.broker.releaseAttempt(f.request, f.lease.workspace)).rejects.toThrow('WORKSPACE_IDENTITY_CONFLICT');
    await rm(leasePath); await expect(f.broker.releaseAttempt(f.request, f.lease.workspace)).rejects.toThrow('WORKSPACE_ALLOCATION_INCOMPLETE');
    await writeFile(leasePath, original, { mode: 0o600 }); await chmod(f.directory, 0o777);
    await expect(f.broker.releaseAttempt(f.request, f.lease.workspace)).rejects.toThrow('WORKSPACE_UNSAFE');
    expect(await readFile(join(f.lease.workspace, 'tracked'), 'utf8')).toBe('base');
    await chmod(f.directory, 0o700); expect(await f.broker.releaseAttempt(f.request, f.lease.workspace)).toBe('removed');
  });
  it('a lost ready rename (allocating record of the exact request) is removable only on the ledger-proof path', async () => {
    const f = await fixture(); const leasePath = join(f.directory, 'lease.json');
    await writeFile(leasePath, (await readFile(leasePath, 'utf8')).replace('"status":"ready"', '"status":"allocating"'));
    await expect(f.broker.release(f.request)).rejects.toThrow('WORKSPACE_ALLOCATION_INCOMPLETE');
    expect(await present(f.lease.workspace)).toBe(true);
    expect(await f.broker.releaseAttempt(f.request, f.lease.workspace)).toBe('removed');
  });
  it('negative 7 (fsync): lease records and the detach are flushed (file data, then the directory entries)', async () => {
    const probe = await open(tmpdir(), 'r'); const prototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> }; await probe.close();
    const sync = vi.spyOn(prototype, 'sync');
    try {
      const f = await fixture();
      // allocating lease file + its directory + the root, then the pending ready file + its directory after the rename.
      expect(sync.mock.calls.length).toBeGreaterThanOrEqual(5);
      sync.mockClear(); expect(await f.broker.releaseAttempt(f.request, f.lease.workspace)).toBe('removed');
      expect(sync).toHaveBeenCalledTimes(1);
    } finally { sync.mockRestore(); }
  });
  it('Sol ER-R2: an interrupted detach is completed only for its exact attempt; other scopes and unverifiable tombstones are kept', async () => {
    const f = await fixture(); const requestB = { ...f.request, identity: { ...f.request.identity, scopeId: 'b', attemptId: 'b' } };
    const leaseB = await f.broker.allocate(requestB); const tombstones = async () => (await readdir(f.workspaces)).filter(name => name.startsWith('.released-')).sort();
    // B's removal is interrupted after the atomic detach: an unremovable directory inside its checkout.
    const pinned = join(leaseB.workspace, '.git', 'pinned'); await mkdir(pinned); await writeFile(join(pinned, 'x'), 'x'); await chmod(pinned, 0o500);
    await expect(f.broker.releaseAttempt(requestB, leaseB.workspace)).rejects.toMatchObject({ code: 'EACCES' });
    const [detachedB] = await tombstones(); expect(detachedB).toMatch(/^\.released-[a-f0-9]{64}-[0-9a-f-]{36}$/);
    expect(await present(dirname(leaseB.workspace))).toBe(false); expect(await f.broker.holds(requestB.identity)).toBe(true);
    // A's release in the same root never touches B's tombstone, a foreign prefixed directory or a leaseless tombstone named for B.
    const foreign = join(f.workspaces, '.released-foreign'); await mkdir(foreign, { mode: 0o700 }); await writeFile(join(foreign, 'x'), 'x');
    const leaseless = join(f.workspaces, detachedB!.replace(/-[0-9a-f-]{36}$/, '-' + randomUUID())); await mkdir(leaseless, { mode: 0o700 });
    expect(await f.broker.releaseAttempt(f.request, f.lease.workspace)).toBe('removed');
    expect(await tombstones()).toHaveLength(3); expect(await f.broker.countDetached()).toBe(3);
    // B itself: an unverifiable tombstone of B is kept and typed, a tampered lease is refused, the verified one completes once fixed.
    const detachedPath = join(f.workspaces, detachedB!); await chmod(join(detachedPath, 'tree', '.git', 'pinned'), 0o700);
    const leasePath = join(detachedPath, 'lease.json'), original = await readFile(leasePath, 'utf8');
    await writeFile(leasePath, original.replace(/"fingerprint":"[a-f0-9]{64}"/, `"fingerprint":"${'0'.repeat(64)}"`));
    await expect(f.broker.releaseAttempt(requestB, leaseB.workspace)).rejects.toThrow('WORKSPACE_IDENTITY_CONFLICT');
    expect(await present(detachedPath)).toBe(true);
    await writeFile(leasePath, original);
    await expect(f.broker.releaseAttempt(requestB, leaseB.workspace)).rejects.toThrow('WORKSPACE_IDENTITY_CONFLICT');
    expect(await present(detachedPath)).toBe(false); expect(await present(leaseless)).toBe(true); expect(await present(foreign)).toBe(true);
    await rm(leaseless, { recursive: true }); expect(await f.broker.releaseAttempt(requestB, leaseB.workspace)).toBe('absent');
    expect(await f.broker.holds(requestB.identity)).toBe(false); expect(await tombstones()).toEqual(['.released-foreign']);
  });
});
