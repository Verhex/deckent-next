import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GitWorkspaceBroker } from '#adapters/index.js';

const exec = promisify(execFile); const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-recorded-base-')); roots.push(root);
  const source = join(root, 'source'); const workspaceRoot = join(root, 'workspaces'); await mkdir(source); await mkdir(workspaceRoot);
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', source, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(source, 'tracked'), 'base'); await git('add', 'tracked'); await git('commit', '-m', 'base');
  const options = { sourceRoot: source, workspaceRoot, gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 };
  const broker = new GitWorkspaceBroker(options);
  const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', generation: 1, layoutRevision: 'layout' };
  return { root, source, workspaceRoot, options, broker, identity, git };
}

it('captures committed HEAD and reopens its recorded base without source or owner state', async () => {
  const f = await fixture(); const baseCommit = await f.broker.captureBaseCommit();
  await writeFile(join(f.source, 'tracked'), 'owner-wip');
  const lease = await f.broker.allocate({ schemaVersion: 1, identity: f.identity, baseCommit });
  expect(await readFile(join(lease.workspace, 'tracked'), 'utf8')).toBe('base');
  await f.git('add', 'tracked'); await f.git('commit', '-m', 'advanced');
  expect(await f.git('rev-parse', 'HEAD')).not.toBe(baseCommit);
  await rm(f.source, { recursive: true });
  expect(await f.broker.openRecorded(f.identity)).toEqual(lease);
  expect(await readFile(join(lease.workspace, 'tracked'), 'utf8')).toBe('base');
});

it('returns null for an identity without a recorded directory and rejects changed adapter configuration', async () => {
  const f = await fixture(); expect(await f.broker.openRecorded(f.identity)).toBeNull();
  const baseCommit = await f.broker.captureBaseCommit(); await f.broker.allocate({ schemaVersion: 1, identity: f.identity, baseCommit });
  const changed = new GitWorkspaceBroker({ ...f.options, outputBytes: f.options.outputBytes + 1 });
  await expect(changed.openRecorded(f.identity)).rejects.toThrow('WORKSPACE_IDENTITY_CONFLICT');
});

it.each(['malformed', 'incomplete', 'unsafe', 'symlink'] as const)('fails closed for a %s recorded lease', async kind => {
  const f = await fixture(); const baseCommit = await f.broker.captureBaseCommit();
  const lease = await f.broker.allocate({ schemaVersion: 1, identity: f.identity, baseCommit });
  const directory = join(f.workspaceRoot, lease.id); const recordPath = join(directory, 'lease.json');
  if (kind === 'malformed') await writeFile(recordPath, '{not-json', { mode: 0o600 });
  if (kind === 'incomplete') { const record = JSON.parse(await readFile(recordPath, 'utf8')); record.status = 'allocating'; await writeFile(recordPath, JSON.stringify(record)); }
  if (kind === 'unsafe') await chmod(recordPath, 0o666);
  if (kind === 'symlink') { await rm(lease.workspace, { recursive: true }); await symlink(f.source, lease.workspace); }
  await expect(f.broker.openRecorded(f.identity)).rejects.toThrow('WORKSPACE_ALLOCATION_INCOMPLETE');
});
