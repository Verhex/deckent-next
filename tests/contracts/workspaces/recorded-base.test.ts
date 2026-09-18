import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { GitWorkspaceBroker, fingerprintGitSource } from '#adapters/index.js';

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
  const f = await fixture(); const sourceBase = await f.broker.captureSourceBase(); const baseCommit = sourceBase.baseCommit;
  await writeFile(join(f.source, 'tracked'), 'owner-wip');
  const lease = await f.broker.allocate({ schemaVersion: 1, identity: f.identity, baseCommit });
  expect(lease.sourceBase).toEqual(sourceBase);
  expect(await readFile(join(lease.workspace, 'tracked'), 'utf8')).toBe('base');
  await f.git('add', 'tracked'); await f.git('commit', '-m', 'advanced');
  expect(await f.git('rev-parse', 'HEAD')).not.toBe(baseCommit);
  await rm(f.source, { recursive: true });
  expect(await f.broker.openRecorded(f.identity)).toEqual(lease);
  expect(await readFile(join(lease.workspace, 'tracked'), 'utf8')).toBe('base');
});

it('validates an explicit immutable commit without sampling an advanced HEAD', async () => {
  const f = await fixture(); const first = await f.broker.captureSourceBase();
  await writeFile(join(f.source, 'tracked'), 'advanced'); await f.git('add', 'tracked'); await f.git('commit', '-m', 'advanced');
  expect((await f.broker.captureSourceBase()).baseCommit).not.toBe(first.baseCommit);
  expect(await f.broker.captureSourceBase(first.baseCommit)).toEqual(first);
  expect(await f.broker.assertSourceBase(first)).toEqual(first);
  const unavailable = new GitWorkspaceBroker({ ...f.options, gitExecutable: '/unavailable/git' });
  await expect(unavailable.captureSourceBase('HEAD')).rejects.toMatchObject({ code: 'WORKSPACE_REQUEST_INVALID' });
});

it('returns null for an identity without a recorded directory and rejects changed adapter configuration', async () => {
  const f = await fixture(); expect(await f.broker.openRecorded(f.identity)).toBeNull();
  const baseCommit = (await f.broker.captureSourceBase()).baseCommit; await f.broker.allocate({ schemaVersion: 1, identity: f.identity, baseCommit });
  const changed = new GitWorkspaceBroker({ ...f.options, outputBytes: f.options.outputBytes + 1 });
  await expect(changed.openRecorded(f.identity)).rejects.toThrow('WORKSPACE_IDENTITY_CONFLICT');
});

it.each(['malformed', 'incomplete', 'unsafe', 'symlink'] as const)('fails closed for a %s recorded lease', async kind => {
  const f = await fixture(); const baseCommit = (await f.broker.captureSourceBase()).baseCommit;
  const lease = await f.broker.allocate({ schemaVersion: 1, identity: f.identity, baseCommit });
  const directory = join(f.workspaceRoot, lease.id); const recordPath = join(directory, 'lease.json');
  if (kind === 'malformed') await writeFile(recordPath, '{not-json', { mode: 0o600 });
  if (kind === 'incomplete') { const record = JSON.parse(await readFile(recordPath, 'utf8')); record.status = 'allocating'; await writeFile(recordPath, JSON.stringify(record)); }
  if (kind === 'unsafe') await chmod(recordPath, 0o666);
  if (kind === 'symlink') { await rm(lease.workspace, { recursive: true }); await symlink(f.source, lease.workspace); }
  await expect(f.broker.openRecorded(f.identity)).rejects.toThrow('WORKSPACE_ALLOCATION_INCOMPLETE');
});

it('rejects an old schema-one lease as unconvertible instead of inventing source custody', async () => {
  const f = await fixture(); const lease = await f.broker.allocate({ schemaVersion: 1, identity: f.identity, baseCommit: (await f.broker.captureSourceBase()).baseCommit });
  const recordPath = join(f.workspaceRoot, lease.id, 'lease.json'); const record = JSON.parse(await readFile(recordPath, 'utf8'));
  delete record.sourceBase; record.schemaVersion = 1; await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
  await expect(f.broker.openRecorded(f.identity)).rejects.toMatchObject({ code: 'WORKSPACE_CUSTODY_UNCONVERTIBLE' });
});

it('rejects tampered typed source custody even when its inner source hash is recomputed', async () => {
  const f = await fixture(); const lease = await f.broker.allocate({ schemaVersion: 1, identity: f.identity, baseCommit: (await f.broker.captureSourceBase()).baseCommit });
  const recordPath = join(f.workspaceRoot, lease.id, 'lease.json'); const record = JSON.parse(await readFile(recordPath, 'utf8'));
  record.sourceBase.source.repositoryRoot = f.workspaceRoot;
  record.sourceBase.sourceFingerprint = fingerprintGitSource(record.sourceBase.source);
  await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
  await expect(f.broker.openRecorded(f.identity)).rejects.toThrow('WORKSPACE_IDENTITY_CONFLICT');
});

it.each(['inner-hash', 'base-binding', 'noncanonical-path'] as const)('rejects %s even when the outer allocation fingerprint is recomputed', async kind => {
  const f = await fixture(); const lease = await f.broker.allocate({ schemaVersion: 1, identity: f.identity, baseCommit: (await f.broker.captureSourceBase()).baseCommit });
  const recordPath = join(f.workspaceRoot, lease.id, 'lease.json'); const record = JSON.parse(await readFile(recordPath, 'utf8'));
  if (kind === 'inner-hash') record.sourceBase.sourceFingerprint = 'b'.repeat(64);
  if (kind === 'base-binding') record.sourceBase.baseCommit = 'b'.repeat(40);
  if (kind === 'noncanonical-path') {
    record.sourceBase.source.sourceRoot = join(f.source, '..', 'source');
    record.sourceBase.sourceFingerprint = fingerprintGitSource(record.sourceBase.source);
  }
  record.fingerprint = createHash('sha256').update(JSON.stringify({ request: record.request, sourceBase: record.sourceBase, options: f.options })).digest('hex');
  await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
  await expect(f.broker.openRecorded(f.identity)).rejects.toThrow('WORKSPACE_IDENTITY_CONFLICT');
});
