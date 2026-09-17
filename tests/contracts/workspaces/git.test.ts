import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorkspaceBroker } from '#adapters/index.js';
const exec = promisify(execFile); const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-git-workspace-')); roots.push(root);
  const source = join(root, 'source'); const workspaces = join(root, 'workspaces'); await mkdir(source); await mkdir(workspaces);
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', source, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(source, 'tracked'), 'base'); await git('add', 'tracked'); await git('commit', '-m', 'fixture');
  const baseCommit = await git('rev-parse', 'HEAD');
  await writeFile(join(source, 'tracked'), 'owner-wip'); await mkdir(join(source, '.deckent')); await writeFile(join(source, '.deckent/secret'), 'private');
  const marker = join(root, 'hook-ran'); const hook = join(source, '.git/hooks/post-checkout');
  await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`); await chmod(hook, 0o755);
  const broker = new GitWorkspaceBroker({ sourceRoot: source, workspaceRoot: workspaces, gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 });
  const request = { schemaVersion: 1 as const, identity: { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', generation: 1, layoutRevision: 'layout' }, baseCommit };
  return { root, source, workspaces, broker, request, git, marker };
}
describe('private Git workspace allocation', () => {
  it('pins committed content without carrying owner WIP, runtime files or source hooks', async () => {
    const f = await fixture(); const lease = await f.broker.allocate(f.request);
    expect(await readFile(join(lease.workspace, 'tracked'), 'utf8')).toBe('base');
    expect(await readFile(join(f.source, 'tracked'), 'utf8')).toBe('owner-wip');
    await expect(stat(join(lease.workspace, '.deckent'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await exec('/usr/bin/git', ['-C', lease.workspace, 'remote'])).stdout.trim()).toBe('');
    const blob = await f.git('rev-parse', f.request.baseCommit + ':tracked');
    const a = await stat(join(f.source, '.git/objects', blob.slice(0, 2), blob.slice(2)));
    const b = await stat(join(lease.workspace, '.git/objects', blob.slice(0, 2), blob.slice(2)));
    expect(a.ino).not.toBe(b.ino);
    await f.broker.release(f.request); await expect(stat(lease.workspace)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(f.source, 'tracked'), 'utf8')).toBe('owner-wip');
  });
  it('reuses its lease without discarding worker changes and rejects identity substitution', async () => {
    const f = await fixture(); const lease = await f.broker.allocate(f.request);
    await writeFile(join(lease.workspace, 'tracked'), 'worker-change');
    expect(await f.broker.allocate(f.request)).toEqual(lease);
    expect(await readFile(join(lease.workspace, 'tracked'), 'utf8')).toBe('worker-change');
    await expect(f.broker.allocate({ ...f.request, baseCommit: 'a'.repeat(40) })).rejects.toThrow('WORKSPACE_IDENTITY_CONFLICT');
    await expect(f.broker.allocate({ ...f.request, baseCommit: 'HEAD' })).rejects.toThrow('WORKSPACE_REQUEST_INVALID');
  });
  it('dissociates borrowed objects from a source using alternates', async () => {
    const f = await fixture(); const borrowed = join(f.root, 'borrowed');
    await exec('/usr/bin/git', ['clone', '--shared', '--no-checkout', f.source, borrowed]);
    const broker = new GitWorkspaceBroker({ sourceRoot: borrowed, workspaceRoot: f.workspaces, gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 });
    const lease = await broker.allocate(f.request);
    await expect(stat(join(lease.workspace, '.git/objects/info/alternates'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(borrowed, { recursive: true }); await rm(f.source, { recursive: true });
    expect((await exec('/usr/bin/git', ['-C', lease.workspace, 'show', 'HEAD:tracked'])).stdout).toBe('base');
  });
  it('retains incomplete allocation instead of silently resetting an attempt directory', async () => {
    const f = await fixture(); const invalid = { ...f.request, baseCommit: 'a'.repeat(40) };
    await expect(f.broker.allocate(invalid)).rejects.toThrow('WORKSPACE_GIT_FAILED');
    await expect(f.broker.allocate(invalid)).rejects.toThrow('WORKSPACE_ALLOCATION_INCOMPLETE');
  });

});
