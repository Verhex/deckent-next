import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GitRunWorkspaceProvider, GitWorkspaceBroker, openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { RunWorkspaceAcquisitionApplication } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';

const exec = promisify(execFile); const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
const options = { busyTimeoutMs: 100, journalMode: 'wal' as const, durability: 'full' as const };
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-run-base-acquire-')); roots.push(root);
  const sourceRoot = join(root, 'source'), workspaceRoot = join(root, 'workspaces'); await mkdir(sourceRoot); await mkdir(workspaceRoot);
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', sourceRoot, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(sourceRoot, 'tracked'), 'first'); await git('add', 'tracked'); await git('commit', '-m', 'first');
  const path = join(root, 'ledger.db'); const store = await openSqliteAttemptStore(path, options); stores.push(store);
  const identities = ['a', 'b'].map((attemptId, index) => ({ scopeId: 's', runId: 'r', taskId: `t${index}`, attemptId, generation: 1, layoutRevision: 'l' }));
  await admitRunAttempts(store, identities);
  const brokerOptions = { sourceRoot, workspaceRoot, gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 };
  return { path, store, identities, sourceRoot, workspaceRoot, git, brokerOptions };
}

it('pins one base for two Run attempts across restart despite source HEAD advancement', async () => {
  const f = await fixture(); const firstApp = new RunWorkspaceAcquisitionApplication(f.store, new GitRunWorkspaceProvider(new GitWorkspaceBroker(f.brokerOptions)));
  const first = await firstApp.acquire(f.identities[0]); const custody = await f.store.loadRunWorkspaceCustody('s', 'r');
  expect(custody?.baseRevision).toBe(first.baseCommit);
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  await writeFile(join(f.sourceRoot, 'tracked'), 'second'); await f.git('add', 'tracked'); await f.git('commit', '-m', 'second');
  expect(await f.git('rev-parse', 'HEAD')).not.toBe(first.baseCommit);
  const reopened = await openSqliteAttemptStore(f.path, options, 'forbid'); stores.push(reopened);
  const second = await new RunWorkspaceAcquisitionApplication(reopened,
    new GitRunWorkspaceProvider(new GitWorkspaceBroker(f.brokerOptions))).acquire(f.identities[1]);
  expect(second.baseCommit).toBe(first.baseCommit); expect(await reopened.loadRunWorkspaceCustody('s', 'r')).toEqual(custody);
});

it('adopts an existing typed lease into missing Run custody without sampling current HEAD', async () => {
  const f = await fixture(); const broker = new GitWorkspaceBroker(f.brokerOptions); const recorded = await broker.captureSourceBase();
  const lease = await broker.allocate({ schemaVersion: 1, identity: f.identities[0]!, baseCommit: recorded.baseCommit });
  expect(await f.store.loadRunWorkspaceCustody('s', 'r')).toBeNull();
  await writeFile(join(f.sourceRoot, 'tracked'), 'advanced'); await f.git('add', 'tracked'); await f.git('commit', '-m', 'advanced');
  const acquired = await new RunWorkspaceAcquisitionApplication(f.store, new GitRunWorkspaceProvider(broker)).acquire(f.identities[0]);
  expect(acquired).toEqual(lease);
  expect(await f.store.loadRunWorkspaceCustody('s', 'r')).toMatchObject({ baseRevision: recorded.baseCommit,
    source: { sourceFingerprint: recorded.sourceFingerprint } });
});
