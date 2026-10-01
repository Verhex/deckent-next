import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConfiguredWorkspaceIntegration, deliverConfiguredWorkspaceIntegration, inspectConfiguredWorkers, prepareConfiguredWorkspaceIntegration, startConfiguredRuntimeService } from '../../../src/index.js';
import { sweepConfiguredAttemptCustody } from '../../../src/composition/core/runs/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { workspacePatchFixture } from '../support/workspace-patch-fixture.js';
const exec = promisify(execFile); const roots: string[] = []; const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  clearConfigCache(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const RELEASE = ['execute', 'read-output', 'recover-output', 'release'];
async function container(handle: string) {
  try { await exec('/usr/bin/docker', ['inspect', '--format', '{{.State.Status}}', handle]); return true; }
  catch (error) { if (String((error as { stderr?: string }).stderr).toLowerCase().includes('no such object')) return false; throw error; }
}
async function present(path: string) { try { await lstat(path); return true; } catch (error) { if ((error as { code?: string }).code === 'ENOENT') return false; throw error; } }
/** Fixture policy plus the scope `inspect` grant the worker observation surface needs. */
async function policy(f: Awaited<ReturnType<typeof workspacePatchFixture>>, actions: string[]) {
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(productResourcePath(f.runtime.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'custody-' + actions.join('-'), restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions, scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
    { id: 'inspect', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
  ] }), { mode: 0o600 });
}
const released = (container: string, workspace: string) => ({ schemaVersion: 1, status: 'released', container, workspace });

describe.skipIf(process.platform !== 'linux' || !process.env.DECKENT_TEST_DOCKER_IMAGE)('attempt custody release (EXEC-RELEASE)', () => {
  it('negative 4 + producer→surface: releases container and clone only after the verified patch is retained; consumers keep the exact content', async () => {
    const f = await workspacePatchFixture({ roots, cleanup }); await policy(f, RELEASE);
    const worker = await f.run(); await chmod(join(worker, 'note.txt'), 0o755);
    const record = (await f.runtime.store.loadBoundDispatch(f.identity))!;
    expect(await container(record.terminal!.handle)).toBe(true); expect(await present(dirname(worker))).toBe(true);
    const prepared = await f.prepare();
    expect(prepared.custody).toEqual(released('removed', 'removed'));
    expect(await container(record.terminal!.handle)).toBe(false);
    expect(await present(dirname(worker))).toBe(false);
    expect(prepared.patch.changes.map(change => change.path)).toEqual(['added.txt', 'note.txt', 'removed.txt']);
    expect(prepared.patch.changes[1]).toMatchObject({ before: { mode: '100644', text: 'before\n' }, after: { mode: '100755', text: 'after\n' } });
    const { custody: _custody, ...patchView } = prepared; void _custody;
    expect(await f.preview()).toEqual(patchView);
    // Replay after release: the retained patch answers (no new capture); nothing is left to remove.
    expect(await f.prepare()).toEqual({ ...patchView, custody: released('absent', 'absent') });
    const workers = (await inspectConfiguredWorkers(f.project, { schemaVersion: 1, scopeId: 's' }, f.options)).sources[0]!.workers;
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({ custody: 'released', process: 'missing', patchRecorded: true, outputRecorded: true, files: null, diagnostics: ['custody-released'] });
    await writeFile(join(f.project, 'note.txt'), 'before\n');
    await f.policy(['read-output', 'recover-output', 'prepare-integration', 'deliver-integration']);
    const checked = await checkConfiguredWorkspaceIntegration(f.project, f.identity, f.options);
    const command = { schemaVersion: 1 as const, commandId: 'candidate', identity: f.identity, proposal: checked.proposal };
    const candidate = await prepareConfiguredWorkspaceIntegration(f.project, command, f.options);
    expect(await readFile(join(candidate.manifest.workspace, 'note.txt'), 'utf8')).toBe('after\n');
    const delivered = await deliverConfiguredWorkspaceIntegration(f.project, { schemaVersion: 1, commandId: 'delivery', identity: f.identity, integrationCommandId: 'candidate' }, f.options);
    expect(await f.git('show', delivered.plan.ref + ':note.txt')).toBe('after');
    expect(await f.git('show', delivered.plan.ref + ':added.txt')).toBe('new');
    await expect(f.git('show', delivered.plan.ref + ':removed.txt')).rejects.toBeDefined();
    expect(await f.git('ls-tree', delivered.plan.ref, 'note.txt')).toMatch(/^100755 /);
    expect(candidate.manifest.snapshotDigest).toBe(delivered.plan.snapshotDigest);
  });
  it('negatives 1, 3 and 6: no patch, no release grant or a corrupt patch keep custody; the start sweep releases once the ledger proves the patch', async () => {
    const f = await workspacePatchFixture({ roots, cleanup }); await policy(f, RELEASE);
    const worker = await f.run(); const handle = (await f.runtime.store.loadBoundDispatch(f.identity))!.terminal!.handle;
    const sweep = async () => (await sweepConfiguredAttemptCustody(f.project, ['s'], f.options))[0]!;
    expect(await sweep()).toEqual({ schemaVersion: 1, scopeId: 's', released: 0, detachedKept: 0, entries: [], error: null });
    expect(await container(handle)).toBe(true); expect(await present(worker)).toBe(true);
    await policy(f, ['execute', 'read-output', 'recover-output']);
    const prepared = await f.prepare();
    expect(prepared.custody).toEqual({ schemaVersion: 1, status: 'held', reason: 'release-denied', code: 'POLICY_DENIED' });
    expect(await container(handle)).toBe(true); expect(await present(worker)).toBe(true);
    const artifact = (await f.runtime.artifacts.prepareReadOnlyFile('s', prepared.receipt)).path; const bytes = await readFile(artifact);
    await writeFile(artifact, Buffer.alloc(bytes.length, 32), { mode: 0o600 }); await policy(f, RELEASE);
    expect((await sweep()).entries).toEqual([{ identity: f.identity, outcome: { schemaVersion: 1, status: 'held', reason: 'patch-corrupt', code: 'ARTIFACT_CORRUPT' } }]);
    expect(await container(handle)).toBe(true); expect(await present(worker)).toBe(true);
    await writeFile(artifact, bytes, { mode: 0o600 });
    expect(await sweep()).toMatchObject({ released: 1, entries: [{ identity: f.identity, outcome: released('removed', 'removed') }], error: null });
    expect(await container(handle)).toBe(false); expect(await present(dirname(worker))).toBe(false);
    expect((await sweep()).entries).toEqual([]);
  });
  it('negatives 5, 6 and 7: a fence mismatch or a failed clone removal is typed and kept; an interrupted removal is finished by the sweep', async () => {
    const f = await workspacePatchFixture({ roots, cleanup }); await policy(f, ['execute', 'read-output', 'recover-output']);
    const worker = await f.run(); const directory = dirname(worker), workspaces = dirname(directory);
    const handle = (await f.runtime.store.loadBoundDispatch(f.identity))!.terminal!.handle;
    const lease = join(directory, 'lease.json'), original = await readFile(lease, 'utf8');
    const tamper = () => writeFile(lease, original.replace(/"fingerprint":"[a-f0-9]{64}"/, `"fingerprint":"${'0'.repeat(64)}"`));
    const sweep = async () => (await sweepConfiguredAttemptCustody(f.project, ['s'], f.options))[0]!;
    // Preparation itself needs the verified lease: capture refuses, nothing is retained or removed.
    await tamper(); await expect(f.prepare()).rejects.toMatchObject({ code: 'PATCH_UNSAFE' });
    expect((await f.runtime.store.loadBoundDispatch(f.identity))!.patch).toBeUndefined();
    await writeFile(lease, original); expect((await f.prepare()).custody).toMatchObject({ status: 'held', reason: 'release-denied' });
    await tamper(); await policy(f, RELEASE);
    expect((await sweep()).entries).toEqual([{ identity: f.identity, outcome: { schemaVersion: 1, status: 'held', reason: 'workspace-release-failed', code: 'WORKSPACE_IDENTITY_CONFLICT' } }]);
    expect(await present(worker)).toBe(true); expect(await container(handle)).toBe(false);
    // A removal interrupted after the atomic detach (here: an unremovable directory) leaves only a detached tree, never a half clone.
    await writeFile(lease, original); const pinned = join(worker, '.git', 'pinned'); await mkdir(pinned); await writeFile(join(pinned, 'x'), 'x'); await chmod(pinned, 0o500);
    expect((await sweep()).entries).toEqual([{ identity: f.identity, outcome: { schemaVersion: 1, status: 'held', reason: 'workspace-release-failed', code: 'EACCES' } }]);
    expect(await present(directory)).toBe(false);
    const detached = (await readdir(workspaces)).filter(name => name.startsWith('.released-')); expect(detached).toHaveLength(1);
    expect(detached[0]).toMatch(/^\.released-[a-f0-9]{64}-/);
    await chmod(join(workspaces, detached[0]!, 'tree', '.git', 'pinned'), 0o700);
    // Sol ER-R2: the detached removal is finished only by this attempt's own authorized release — denied release keeps it.
    await policy(f, ['execute', 'read-output', 'recover-output']);
    expect(await sweep()).toEqual({ schemaVersion: 1, scopeId: 's', released: 0, detachedKept: 1, error: null,
      entries: [{ identity: f.identity, outcome: { schemaVersion: 1, status: 'held', reason: 'release-denied', code: 'POLICY_DENIED' } }] });
    expect((await readdir(workspaces)).filter(name => name.startsWith('.released-'))).toEqual(detached);
    // Another scope's sweep in the same root never touches it.
    expect((await sweepConfiguredAttemptCustody(f.project, ['other'], f.options))[0]).toMatchObject({ scopeId: 'other', released: 0, entries: [] });
    expect((await readdir(workspaces)).filter(name => name.startsWith('.released-'))).toEqual(detached);
    await policy(f, RELEASE);
    expect(await sweep()).toEqual({ schemaVersion: 1, scopeId: 's', released: 1, detachedKept: 0, error: null, entries: [{ identity: f.identity, outcome: released('absent', 'removed') }] });
    expect((await readdir(workspaces)).filter(name => name.startsWith('.released-'))).toEqual([]);
    expect(await f.preview()).toMatchObject({ patch: { changes: [{ path: 'added.txt' }, { path: 'note.txt' }, { path: 'removed.txt' }] } });
  });
  it('service start: the runtime service sweeps under its ledger custody, honouring the configured retention', async () => {
    const f = await workspacePatchFixture({ roots, cleanup }); await policy(f, ['execute', 'read-output', 'recover-output']);
    const worker = await f.run(); const handle = (await f.runtime.store.loadBoundDispatch(f.identity))!.terminal!.handle;
    expect((await f.prepare()).custody).toMatchObject({ status: 'held', reason: 'release-denied' }); await policy(f, RELEASE);
    const base = JSON.parse(await readFile(f.configPath, 'utf8'));
    const configure = async (retention?: unknown) => { await writeFile(f.configPath, JSON.stringify({ ...base, execution: { ...base.execution, ...(retention ? { retention } : {}) },
      cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
      cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
      service: { inputMaxBytes: 65536, responseMaxBytes: 65536, maxConnections: 4, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 } })); clearConfigCache(); };
    const start = async () => {
      const swept: unknown[] = [];
      const service = await startConfiguredRuntimeService(f.project, { async onPage() {}, async onError() {}, onAttemptCustodySwept(result) { swept.push(result); } }, f.options);
      await service.stop(); await service.done; return swept;
    };
    await configure({ schemaVersion: 1, release: 'keep' });
    expect(await start()).toEqual([[{ schemaVersion: 1, scopeId: 's', released: 0, detachedKept: 0, entries: [], error: null }]]);
    expect(await container(handle)).toBe(true); expect(await present(worker)).toBe(true);
    await configure();
    expect(await start()).toEqual([[{ schemaVersion: 1, scopeId: 's', released: 1, detachedKept: 0, entries: [{ identity: f.identity, outcome: released('removed', 'removed') }], error: null }]]);
    expect(await container(handle)).toBe(false); expect(await present(dirname(worker))).toBe(false);
  });
});
