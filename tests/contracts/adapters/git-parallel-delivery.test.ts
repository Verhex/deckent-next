import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, utimes, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitIntegrationTarget, GitIntegrationDelivery, GitIntegrationAdoption, GitWorkspaceBroker, GitRunWorkspaceProvider, LocalOsSessionAuthority, fingerprintGitSource,
  GitQueueTarget, GitWorkingTreeDelivery, captureWorkingTreeBase, removeRunBase, sweepRunBases, workerTreeDenied, openSqliteAttemptStore, resolveGitWorkTarget, type GitWorkspaceOptions } from '#adapters/index.js';
import { deliveryMode } from '#platform/index.js';
import { withExclusiveFileLock } from '#adapters/core/file-lock/index.js';
import { workingTreeRemovalPatterns } from '#adapters/core/git-patch/index.js';
import { integrationManifestSchema, integrationDeliveryPlanSchema, patchDigest, patchFile, patchExclusions, workspacePatchSchema, pinRunToDelivery, WorkspaceAdoptionApplication, WorkspaceDeliveryApplication,
  targetQueueKey, assertIntegrationBase, SnapshotBudget, gitBlobOid, classifyLaunchRefusal, WorkspacePatchError, WorkingTreeRollbackApplication, type WorkspacePatch, type IntegrationDeliveryRecord, type IntegrationAdoptionRecord, type IntegrationAdoptionStore, type IntegrationDeliveryStore } from '#engine/index.js';
import type { RunSnapshot } from '#domain/index.js';
import { terminalDeliveryPort } from '#surfaces/core/delivery-port/index.js';
import { homeEnv } from '../support/host-platform.js';

// F1 (Astra 3015): the person's save is injected exactly between the working-tree writer's steps; every other call is the real one.
type Hook = null | ((from: string, to: string) => Promise<void>);
const fsHook = vi.hoisted(() => ({ link: null as Hook, rename: null as Hook, open: null as Hook }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: (async (from: string, to: string) => { await fsHook.link?.(String(from), String(to)); return actual.link(from, to); }) as typeof actual.link,
    rename: (async (from: string, to: string) => { await fsHook.rename?.(String(from), String(to)); return actual.rename(from, to); }) as typeof actual.rename,
    open: (async (path: string, ...rest: unknown[]) => { await fsHook.open?.(String(path), ''); return (actual.open as (...args: unknown[]) => unknown)(path, ...rest); }) as typeof actual.open };
});
const exec = promisify(execFile), roots: string[] = [], json = async (path: string) => JSON.parse(await readFile(new URL(`../../../src/adapters/core/${path}`, import.meta.url), 'utf8'));
const format = await json('git-patch/internal/working-tree-format.json') as Record<'locks' | 'pending' | 'deliveries' | 'journal' | 'rollback' | 'lockOwner', string> & { journalVersion: number };
const removal = await json('installation-removal/internal/paths.json') as { archive: { members: string[] } };
const once = (kind: 'link' | 'rename' | 'open', match: (from: string, to: string) => boolean, run: () => Promise<void>) => { fsHook[kind] = async (from, to) => { if (match(from, to)) { fsHook[kind] = null; await run(); } }; };
afterEach(async () => { vi.restoreAllMocks(); fsHook.link = fsHook.rename = fsHook.open = null; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const limits = { maxBytes: 65536, maxEntries: 1000, maxDepth: 32, maxPathBytes: 1024 };
const confirmation = { async assertAvailable() {}, async confirm(card: import('#engine/index.js').EffectConfirmationView) {
  expect(card.resource).toMatch(/^refs\//); expect(card.to).toMatch(/^[a-f0-9]{40,64}$/); return async () => {};
} };
const actor = { id: 'owner', issuer: 'test', subject: 'owner' };
async function fixture(refOnly: boolean, format = 'sha1', workingTree = false) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-parallel-delivery-')); roots.push(root);
  const sourceRoot = join(root, 'source'), workspaceRoot = join(root, 'workspaces');
  await mkdir(sourceRoot, { mode: 0o700 }); await mkdir(workspaceRoot, { mode: 0o700 });
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', sourceRoot, ...args])).stdout.trim();
  await git('init', '-q', '--object-format=' + format); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(sourceRoot, 'a.txt'), 'a before\n'); await writeFile(join(sourceRoot, 'b.txt'), 'b before\n');
  await writeFile(join(sourceRoot, 'old.txt'), 'remove\n');
  await git('add', '.'); await git('-c', 'gc.auto=0', 'commit', '-qm', 'base');
  const base = await git('rev-parse', 'HEAD'), targetRef = 'refs/heads/adopted';
  await git('branch', 'adopted', base);
  const options: GitWorkspaceOptions = { sourceRoot, workspaceRoot, gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536,
    ...(refOnly ? { baseRef: targetRef } : {}), ...(workingTree ? { workingTree: true as const } : {}) };
  const target = new GitIntegrationTarget(options, limits), delivery = new GitIntegrationDelivery(options), adoption = new GitIntegrationAdoption(options), files = new GitWorkingTreeDelivery(options, limits);
  // R9n: a working-tree Run's base lives in its private base repository; on this clean tree it is HEAD itself.
  if (workingTree) expect((await captureWorkingTreeBase(options, { scopeId: 's', runId: 'wt' }, limits, workerTreeDenied)).commit).toBe(base);
  const file = (text: string) => patchFile(Buffer.from(text), '100644');
  const patch = (id: string, path: string, before: string | null, after: string | null): WorkspacePatch => workspacePatchSchema.parse({
    schemaVersion: 1, kind: 'workspace-patch', identity: { scopeId: 's', runId: id, taskId: 't', attemptId: id, layoutRevision: 'l', generation: 1 },
    source: { schemaVersion: 1, adapter: { id: 'git', version: workingTree ? 2 : 1 }, sourceFingerprint: fingerprintGitSource({ schemaVersion: 1, sourceRoot, repositoryRoot: sourceRoot }) },
    baseCommit: base, snapshotDigest: patchDigest(id), exclusions: patchExclusions,
    changes: [{ path, before: before === null ? null : file(before), after: after === null ? null : file(after) }] });
  const prepare = async (p: WorkspacePatch) => {
    const command = { schemaVersion: 1 as const, commandId: p.identity.runId, identity: p.identity, proposal: '0'.repeat(20) };
    const receipt = { schemaVersion: 1 as const, scopeId: 's', digest: patchDigest(JSON.stringify(p)), byteLength: Buffer.byteLength(JSON.stringify(p)) };
    const manifest = integrationManifestSchema.parse(await target.prepare({ schemaVersion: 1, command, patch: receipt,
      observation: (await target.observe(p)).digest, actor }, p));
    await target.verify(manifest, p);
    return { manifest, receipt };
  };
  const deliver = async (p: WorkspacePatch, candidate?: Awaited<ReturnType<typeof prepare>>, ask = confirmation) => {
    const { manifest, receipt } = candidate ?? await prepare(p);
    const command = { schemaVersion: 1 as const, commandId: p.identity.runId, identity: p.identity, integrationCommandId: manifest.command.commandId };
    let record: IntegrationDeliveryRecord | null = null;
    const store: IntegrationDeliveryStore = { async loadRun() { return { revision: 1, graph: { tasks: [{ id: p.identity.taskId, acceptanceCriteria: ['exit'] }] }, progress: [{ taskId: p.identity.taskId, phase: 'accepted' }] } as RunSnapshot; }, async loadDelivery() { return record; },
      async claimDelivery(intent) { return record = { intent, delivered: false }; }, async finishDelivery(intent) { return record = { intent, delivered: true }; } };
    const clock = { sample: () => ({ wallMs: 1000, monotonicMs: 1 }) }, sessions = await LocalOsSessionAuthority.create(['s'], 10000, clock);
    const patches = { async preview() { return { patch: p, receipt, scope: { status: 'unscoped' } }; }, assertScope() {} };
    const inspection = { async inspect() { return { manifest, receipt }; } };
    const app = new WorkspaceDeliveryApplication(patches as never, inspection as never, target, workingTree ? files : delivery, store, sessions,
      { async authorizeIdentity(action, identity) { expect(action).toBe('deliver-integration'); expect(identity).toEqual(p.identity); } }, clock, ask);
    const result = await app.deliver(command), plan = result.plan;
    expect(result.status).toBe(workingTree ? 'working-tree-delivered' : 'reference-delivered'); expect(await (workingTree ? files : delivery).delivered(plan)).toBe(true);
    expect(record!.delivered).toBe(true);
    return { manifest, plan, record: record! };
  };
  const adopt = async (record: IntegrationDeliveryRecord) => {
    const identity = record.intent.command.identity, observation = await adoption.observe(targetRef);
    let held: IntegrationAdoptionRecord | null = null;
    // The application ports supply accepted Task evidence; all Git preparation, publication and adoption effects are real.
    const store: IntegrationAdoptionStore = { async findDelivery() { return record; }, async loadAdoption() { return held; },
      async loadRun() { return { graph: { tasks: [{ id: identity.taskId, acceptanceCriteria: ['exit'] }] }, revision: 1, progress: [{ taskId: identity.taskId, phase: 'accepted' }], bindings: [{ identity }] } as RunSnapshot; },
      async loadRunWorkspaceCustody() { return null; },
      async claimAdoption(intent, observed) { return held = { intent, sequence: (observation.fence?.sequence ?? 0) + 1, settled: false, repository: observed.repository }; },
      async finishAdoption(intent) { return held = { intent, sequence: held!.sequence, settled: true }; } };
    const clock = { sample: () => ({ wallMs: 1000, monotonicMs: 1 }) }, sessions = await LocalOsSessionAuthority.create(['s'], 10000, clock);
    const source = new GitRunWorkspaceProvider(new GitWorkspaceBroker(options));
    const app = new WorkspaceAdoptionApplication(store, delivery, adoption, [targetRef], sessions,
      { async authorizeIdentity(action, authorized) { expect(action).toBe('adopt-integration'); expect(authorized).toEqual(identity); } }, clock,
      { requirement: null, criterionWithin: () => false, async authorizeRun() {}, registry: null, source }, confirmation);
    return app.adopt({ schemaVersion: 2, commandId: 'adopt-' + identity.runId, identity, deliveryCommandId: record.intent.command.commandId, targetRef });
  };
  const advance = async (commit: string) => {
    if (refOnly) await git('update-ref', targetRef, commit);
    else await git('reset', '--hard', commit); // Only this temporary fixture checkout; no author or owner WIP.
  };
  const state = async () => ({ head: await git('rev-parse', 'HEAD'), tip: await git('rev-parse', targetRef),
    index: await readFile(join(sourceRoot, '.git/index')), status: await git('status', '--porcelain'),
    refs: await git('for-each-ref', '--format=%(refname) %(objectname)'), candidates: await readdir(workspaceRoot) });
  return { sourceRoot, workspaceRoot, options, git, base, targetRef, target, delivery, files, adoption, patch, prepare, deliver, adopt, advance, state };
}

describe.skipIf(process.platform !== 'linux').each([false, true])('parallel delivery (ref-only = %s)', refOnly => {
  it.each(['sha1', 'sha256'])('adopts disjoint original-base patches on the advanced tip and pins verify to the actual %s candidate', async format => {
    const f = await fixture(refOnly, format);
    const a = f.patch('a', 'a.txt', 'a before\n', 'a after\n'), b = f.patch('b', 'b.txt', 'b before\n', 'b after\n');
    b.changes.push(...[f.patch('b', 'dir/new.txt', null, 'added\n').changes[0]!, f.patch('b', 'old.txt', 'remove\n', null).changes[0]!]);
    const approved = JSON.stringify(b), first = await f.deliver(a);
    expect(await f.adopt(first.record)).toMatchObject({ status: 'adopted', fromCommit: f.base, toCommit: first.plan.commit });
    if (!refOnly) await f.advance(first.plan.commit);
    const before = await f.state(), second = await f.deliver(b);
    expect(await f.state()).toEqual({ ...before, refs: [...before.refs.split('\n'), `${second.plan.ref} ${second.plan.commit}`].sort().join('\n') });
    expect(second.manifest).toMatchObject({ schemaVersion: 2, baseCommit: f.base, effectiveBaseCommit: first.plan.commit });
    expect(second.plan).toMatchObject({ schemaVersion: 2, baseCommit: f.base, effectiveBaseCommit: first.plan.commit });
    expect(await f.git('rev-parse', second.plan.commit + '^')).toBe(first.plan.commit);
    expect(await readFile(join(second.manifest.workspace, 'a.txt'), 'utf8')).toBe('a after\n');
    expect(await readFile(join(second.manifest.workspace, 'b.txt'), 'utf8')).toBe('b after\n');
    expect(await f.git('show', second.plan.commit + ':dir/new.txt')).toBe('added');
    await expect(f.git('show', second.plan.commit + ':old.txt')).rejects.toBeDefined();
    expect(JSON.stringify(b)).toBe(approved);
    const provider = new GitRunWorkspaceProvider(new GitWorkspaceBroker(f.options));
    const custody = await pinRunToDelivery({ async findDelivery() { return second.record; } }, f.delivery, provider,
      async identity => { expect(identity).toEqual(b.identity); }, { scopeId: 's', runId: 'verify', deliveryCommandId: 'b' });
    expect(custody.baseRevision).toBe(second.plan.commit);
    const lease = await provider.allocate({ ...b.identity, runId: 'verify', attemptId: 'verify' }, custody);
    expect((await exec('/usr/bin/git', ['-C', lease.workspace, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(second.plan.commit);
    expect(await readFile(join(lease.workspace, 'a.txt'), 'utf8')).toBe('a after\n');
    expect(await f.adopt(second.record)).toMatchObject({ status: 'adopted', fromCommit: first.plan.commit, toCommit: second.plan.commit });
    expect(await f.git('rev-parse', f.targetRef)).toBe(second.plan.commit);
  });
  it.each(['content', 'mode', 'absent-created', 'deleted', 'rewritten', 'grafted', 'directory', 'ancestor-file'])('refuses %s with PATCH_BASE_ADVANCED before candidate or reference writes', async kind => {
    const f = await fixture(refOnly);
    const path = kind === 'absent-created' ? 'new.txt' : kind === 'directory' ? 'dir' : kind === 'ancestor-file' ? 'dir/new.txt' : 'a.txt';
    const p = f.patch('loser', path, ['absent-created', 'directory', 'ancestor-file'].includes(kind) ? null : 'a before\n', 'approved after\n');
    let moved: string;
    if (kind === 'rewritten' || kind === 'grafted') moved = await f.git('commit-tree', `${f.base}^{tree}`, '-m', 'rewritten root');
    else {
      const winner = kind === 'mode' ? { ...f.patch('winner', 'a.txt', 'a before\n', 'placeholder\n'),
        changes: [{ path: 'a.txt', before: p.changes[0]!.before, after: patchFile(Buffer.from('a before\n'), '100755') }] }
        : f.patch('winner', kind === 'directory' ? 'dir/child.txt' : kind === 'ancestor-file' ? 'dir' : path,
          ['absent-created', 'directory', 'ancestor-file'].includes(kind) ? null : 'a before\n', kind === 'deleted' ? null : 'other worker\n');
      moved = (await f.deliver(winner)).plan.commit;
    }
    await f.advance(moved);
    if (kind === 'grafted') await writeFile(join(f.sourceRoot, '.git/info/grafts'), `${moved} ${f.base}\n`);
    const before = await f.state();
    await expect(f.prepare(p)).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
    expect(await f.state()).toEqual(before);
  });
  it('refuses a changed-then-restored touched path even when the final base tree matches', async () => {
    const f = await fixture(refOnly), p = f.patch('loser', 'a.txt', 'a before\n', 'approved\n');
    const changed = (await f.deliver(f.patch('winner', 'a.txt', 'a before\n', 'temporary\n'))).plan.commit;
    const restored = await f.git('commit-tree', `${f.base}^{tree}`, '-p', changed, '-m', 'restored');
    await f.advance(restored); const before = await f.state();
    await expect(f.prepare(p)).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
    expect(await f.state()).toEqual(before);
  });
  it('refuses both rename endpoints without modifying owner HEAD, index or WIP', async () => {
    const f = await fixture(refOnly), p = f.patch('loser', 'a.txt', 'a before\n', 'approved\n');
    // Only the temporary fixture checkout creates the historical rename; preparation remains private.
    await f.git('mv', 'a.txt', 'renamed.txt'); await f.git('commit', '-qm', 'rename');
    const renamed = await f.git('rev-parse', 'HEAD'); await f.advance(renamed);
    const before = await f.state();
    await expect(f.prepare(p)).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
    expect(await f.state()).toEqual(before);
  });
  it('checks every path before writing when only a later touched path changed', async () => {
    const f = await fixture(refOnly), p = f.patch('loser', 'a.txt', 'a before\n', 'approved\n');
    p.changes.push(f.patch('loser', 'b.txt', 'b before\n', 'approved\n').changes[0]!);
    await f.advance((await f.deliver(f.patch('winner', 'b.txt', 'b before\n', 'other\n'))).plan.commit);
    const before = await f.state(); await expect(f.prepare(p)).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
    expect(await f.state()).toEqual(before);
  });
  it('keeps source fingerprint mismatch PATCH_CONFLICT even after a forward move', async () => {
    const f = await fixture(refOnly), p = f.patch('p', 'a.txt', 'a before\n', 'after\n');
    const moved = await f.git('commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'advance'); await f.advance(moved);
    const before = await f.state();
    await expect(f.prepare({ ...p, source: { ...p.source, sourceFingerprint: 'f'.repeat(64) } })).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    expect(await f.state()).toEqual(before);
  });
  it('verifies the entire advanced-base candidate, including the earlier worker change', async () => {
    const f = await fixture(refOnly);
    await f.advance((await f.deliver(f.patch('a', 'a.txt', 'a before\n', 'first worker\n'))).plan.commit);
    const p = f.patch('b', 'b.txt', 'b before\n', 'second worker\n'), { manifest } = await f.prepare(p);
    const refs = await f.git('for-each-ref', '--format=%(refname) %(objectname)');
    await writeFile(join(manifest.workspace, 'a.txt'), 'verification drift\n');
    await expect(f.target.verify(manifest, p)).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    expect(await f.git('for-each-ref', '--format=%(refname) %(objectname)')).toBe(refs);
  });
  it('atomically refuses a publication race against the pinned effective base', async () => {
    const f = await fixture(refOnly), p = f.patch('p', 'a.txt', 'a before\n', 'after\n'), candidate = await f.prepare(p);
    const plan = await f.delivery.plan({ schemaVersion: 1, commandId: 'p', identity: p.identity, integrationCommandId: 'p' }, candidate.manifest, p);
    const moved = await f.git('commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'racing advance'); await f.advance(moved);
    const before = await f.state(); await expect(f.delivery.publish(plan, candidate.manifest, p)).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
    expect(await f.state()).toEqual(before); expect(await f.delivery.delivered(plan)).toBe(false);
  });
  it('refuses an already prepared candidate after a safe advance before claiming delivery', async () => {
    const f = await fixture(refOnly), p = f.patch('p', 'a.txt', 'a before\n', 'after\n'), candidate = await f.prepare(p);
    await f.advance(await f.git('commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'advance after prepare'));
    const before = await f.state(); await expect(f.deliver(p, candidate)).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
    expect(await f.state()).toEqual(before);
  });
  it('reads retained v1 candidates and plans without changing their recorded representation', async () => {
    const f = await fixture(refOnly), p = f.patch('p', 'a.txt', 'a before\n', 'after\n'), candidate = await f.prepare(p);
    const { baseCommit: _base, effectiveBaseCommit: _effective, ...rest } = candidate.manifest as Extract<typeof candidate.manifest, { schemaVersion: 2 }>;
    void _base; void _effective;
    const legacy = integrationManifestSchema.parse({ ...rest, schemaVersion: 1 }); await f.target.verify(legacy, p);
    const plan = await f.delivery.plan({ schemaVersion: 1, commandId: 'legacy', identity: p.identity, integrationCommandId: 'p' }, legacy, p);
    const { effectiveBaseCommit: _parent, ...oldPlan } = plan as Extract<typeof plan, { schemaVersion: 2 }>; void _parent;
    const parsed = integrationDeliveryPlanSchema.parse({ ...oldPlan, schemaVersion: 1 });
    await f.delivery.publish(parsed, legacy, p); expect(await f.delivery.delivered(parsed)).toBe(true);
  });
});

describe.skipIf(process.platform !== 'linux')('source custody after a safe forward move', () => {
  it.each(['staged', 'untracked'])('keeps checkout %s touched-path drift PATCH_CONFLICT without writes', async kind => {
    const f = await fixture(false);
    const moved = await f.git('commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'advance'); await f.advance(moved);
    const p = f.patch('p', kind === 'staged' ? 'a.txt' : 'new.txt', kind === 'staged' ? 'a before\n' : null, 'approved\n');
    await writeFile(join(f.sourceRoot, p.changes[0]!.path), 'source WIP\n');
    if (kind === 'staged') { await f.git('add', 'a.txt'); await writeFile(join(f.sourceRoot, 'a.txt'), 'a before\n'); }
    const before = await f.state(); await expect(f.prepare(p)).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    expect(await f.state()).toEqual(before);
  });
  it('keeps ref-only checkout/index WIP untouched and builds from the effective branch tree', async () => {
    const f = await fixture(true), p = f.patch('p', 'b.txt', 'b before\n', 'approved\n');
    await f.advance((await f.deliver(f.patch('a', 'a.txt', 'a before\n', 'first worker\n'))).plan.commit);
    await writeFile(join(f.sourceRoot, 'b.txt'), 'staged owner\n'); await f.git('add', 'b.txt');
    await writeFile(join(f.sourceRoot, 'b.txt'), 'unstaged owner\n'); const before = await f.state();
    const second = await f.deliver(p);
    expect(await f.state()).toEqual({ ...before, refs: [...before.refs.split('\n'), `${second.plan.ref} ${second.plan.commit}`].sort().join('\n') });
    expect(await readFile(join(f.sourceRoot, 'b.txt'), 'utf8')).toBe('unstaged owner\n');
    expect(await f.git('show', second.plan.commit + ':a.txt')).toBe('first worker');
    expect(await f.git('show', second.plan.commit + ':b.txt')).toBe('approved');
  });
});

// DOGFOOD-50 friction 14: a release that edits a tracked `.deckent/docs` file made every older ticket PATCH_UNSAFE on re-preparation, because the
// intervening history was validated with the patch's own write rules. History written by others is only "touched"; the patch rules stay intact.
describe.skipIf(process.platform !== 'linux').each([false, true])('intervening history under paths a patch may not write (ref-only = %s)', refOnly => {
  /** A commit by someone else on the target, made in the temporary fixture checkout only. */
  const advanceWith = async (f: Awaited<ReturnType<typeof fixture>>, path: string, text: string) => {
    await mkdir(join(f.sourceRoot, path, '..'), { recursive: true }); await writeFile(join(f.sourceRoot, path), text);
    await f.git('add', '--', path); await f.git('-c', 'gc.auto=0', 'commit', '-qm', `others: ${path}`);
    const moved = await f.git('rev-parse', 'HEAD'); await f.advance(moved); return moved;
  };
  it('re-prepares a docs/ patch over a tracked .deckent/docs edit and keeps that edit in the candidate', async () => {
    const f = await fixture(refOnly);
    await advanceWith(f, '.deckent/docs/x.md', 'first\n');
    const edited = await advanceWith(f, '.deckent/docs/x.md', 'edited by the release\n');
    const p = f.patch('docs', 'docs/guide.md', null, 'guide\n'), { manifest } = await f.prepare(p);
    expect(manifest).toMatchObject({ schemaVersion: 2, baseCommit: f.base, effectiveBaseCommit: edited });
    expect(await readFile(join(manifest.workspace, 'docs/guide.md'), 'utf8')).toBe('guide\n');
    expect(await readFile(join(manifest.workspace, '.deckent/docs/x.md'), 'utf8')).toBe('edited by the release\n');
  });
  it('still conflicts with PATCH_BASE_ADVANCED when the excluded history path lies under a path the patch writes', async () => {
    const f = await fixture(refOnly);
    await advanceWith(f, 'pkg/.deckent/state.json', '{}\n');
    const before = await f.state();
    await expect(f.prepare(f.patch('pkg', 'pkg', null, 'a file where others made a directory\n'))).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
    expect(await f.state()).toEqual(before);
  });
  it('the patch itself still may not write .deckent/: refused with typed PATCH_UNSAFE over the same advanced history', async () => {
    const f = await fixture(refOnly);
    const moved = await advanceWith(f, '.deckent/docs/x.md', 'edited by the release\n'), valid = f.patch('own', 'docs/guide.md', null, 'guide\n');
    const own = { ...valid, changes: [{ path: '.deckent/docs/x.md', before: null, after: patchFile(Buffer.from('worker write\n'), '100644') }] } as WorkspacePatch;
    expect(workspacePatchSchema.safeParse(own).success).toBe(false);
    const git = async (args: string[]) => (await exec('/usr/bin/git', ['-C', f.sourceRoot, ...args])).stdout;
    await expect(assertIntegrationBase(git, own, moved, new SnapshotBudget(limits, Date.now() + 10_000))).rejects.toMatchObject({ code: 'PATCH_UNSAFE' });
    await expect(assertIntegrationBase(git, valid, moved, new SnapshotBudget(limits, Date.now() + 10_000))).resolves.toBeUndefined();
  });
});

describe.skipIf(process.platform !== 'linux')('queue private prefixes and physical generations', () => {
  it('prepares C1→C2 before publication and allocates the exact private commit with original source custody', async () => {
    const f = await fixture(true), before = await f.state(), a = f.patch('private-a', 'a.txt', 'a before\n', 'a after\n'), b = f.patch('private-b', 'b.txt', 'b before\n', 'b after\n');
    const first = await f.prepare(a), metadata = { title: 'check', acceptance: { phase: 'accepted', criteria: 1, runRevision: 1, modelUnverified: false }, deliveredAtMs: 1000 };
    const plan1 = await f.delivery.plan({ schemaVersion: 1, commandId: 'publish-a', identity: a.identity, integrationCommandId: first.manifest.command.commandId }, first.manifest, a, metadata);
    const target = new GitIntegrationTarget(f.options, limits, { commit: plan1.commit, repository: first.manifest.workspace });
    const command = { schemaVersion: 1 as const, commandId: 'private-b', identity: b.identity, proposal: '0'.repeat(20) }, receipt = { schemaVersion: 1 as const, scopeId: 's', digest: patchDigest(JSON.stringify(b)), byteLength: Buffer.byteLength(JSON.stringify(b)) };
    const manifest = await target.prepare({ schemaVersion: 1, command, patch: receipt, observation: (await target.observe(b)).digest, actor }, b);
    await target.verify(manifest, b);
    const plan2 = await f.delivery.plan({ schemaVersion: 1, commandId: 'publish-b', identity: b.identity, integrationCommandId: command.commandId }, manifest, b, metadata);
    expect(manifest).toMatchObject({ schemaVersion: 2, effectiveBaseCommit: plan1.commit });
    const provider = new GitRunWorkspaceProvider(new GitWorkspaceBroker(f.options, { repositoryRoot: manifest.workspace, baseCommit: plan2.commit }));
    const captured = await provider.captureSource(plan2.commit);
    expect(captured.source.sourceFingerprint).toBe(a.source.sourceFingerprint);
    const identity = { ...b.identity, runId: 'verification', attemptId: 'verification' }, lease = await provider.allocate(identity, { schemaVersion: 1, scopeId: 's', runId: 'verification', ...captured });
    expect(await readFile(join(lease.workspace, 'a.txt'), 'utf8')).toBe('a after\n');
    expect(await readFile(join(lease.workspace, 'b.txt'), 'utf8')).toBe('b after\n');
    expect((await exec('/usr/bin/git', ['-C', lease.workspace, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(plan2.commit);
    await expect(f.git('cat-file', '-e', plan1.commit)).rejects.toBeDefined();
    const after = await f.state();
    for (const field of ['head', 'tip', 'index', 'status', 'refs'] as const) expect(after[field]).toEqual(before[field]);
    expect(after.candidates).toContain('integrations');
  });
  it('refuses suspended old publication, adoption and rollback writers after a generation advance', async () => {
    const f = await fixture(true), patch = f.patch('epoch', 'a.txt', 'a before\n', 'a after\n'), prepared = await f.prepare(patch);
    const plan = await f.delivery.plan({ schemaVersion: 1, commandId: 'epoch-delivery', identity: patch.identity, integrationCommandId: prepared.manifest.command.commandId }, prepared.manifest, patch);
    const queue = new GitQueueTarget(f.options, 'installation', 'registered', [f.targetRef], []), binding = await queue.binding(f.targetRef), key = targetQueueKey(binding);
    const old = await queue.fence(key, 'old', 1), current = await queue.fence(key, 'current', 2);
    await expect(new GitIntegrationDelivery(f.options, old).publish(plan, prepared.manifest, patch)).rejects.toBeDefined();
    expect(await f.delivery.delivered(plan)).toBe(false);
    await new GitIntegrationDelivery(f.options, current).publish(plan, prepared.manifest, patch);
    const first = { sequence: 1, scopeId: 's', commandId: 'epoch-adoption' };
    await expect(new GitIntegrationAdoption(f.options, old).move(f.targetRef, f.base, plan.commit, null, first)).rejects.toBeDefined();
    expect(await f.git('rev-parse', f.targetRef)).toBe(f.base);
    await new GitIntegrationAdoption(f.options, current).move(f.targetRef, f.base, plan.commit, null, first);
    const rollback = { sequence: 2, scopeId: 's', commandId: 'epoch-rollback' };
    await expect(new GitIntegrationAdoption(f.options, old).move(f.targetRef, plan.commit, f.base, first, rollback)).rejects.toBeDefined();
    await expect(new GitIntegrationAdoption(f.options).move(f.targetRef, plan.commit, f.base, first, rollback)).rejects.toBeDefined();
    expect(await f.git('rev-parse', f.targetRef)).toBe(plan.commit);
    await new GitIntegrationAdoption(f.options, current).move(f.targetRef, plan.commit, f.base, first, rollback);
    expect(await f.git('rev-parse', f.targetRef)).toBe(f.base);
  });
  it('derives physical identities and refuses main, default, protected, checked-out and foreign targets despite allow-list entries', async () => {
    const f = await fixture(true), other = await fixture(true);
    const make = (options: GitWorkspaceOptions, protectedRefs: string[] = []) => new GitQueueTarget(options, 'i', 'registered', [f.targetRef, 'refs/heads/main', 'refs/heads/master', 'refs/heads/foreign'], protectedRefs);
    const a = await make(f.options).binding(f.targetRef), b = await make(other.options).binding(other.targetRef);
    expect(targetQueueKey(a)).not.toBe(targetQueueKey(b));
    for (const ref of ['refs/heads/main', 'refs/heads/master']) await expect(make({ ...f.options, baseRef: ref }).binding(ref)).rejects.toMatchObject({ code: 'QUEUE_AUTHORITY_REQUIRED' });
    await expect(make(f.options, [f.targetRef]).binding(f.targetRef)).rejects.toMatchObject({ code: 'QUEUE_AUTHORITY_REQUIRED' });
    await expect(make(f.options).binding('refs/heads/foreign')).rejects.toMatchObject({ code: 'QUEUE_AUTHORITY_REQUIRED' });
    await f.git('config', 'init.defaultBranch', 'adopted');
    await expect(make(f.options).binding(f.targetRef)).rejects.toMatchObject({ code: 'QUEUE_AUTHORITY_REQUIRED' });
    await f.git('config', '--unset', 'init.defaultBranch'); await f.git('checkout', 'adopted');
    await expect(make(f.options).binding(f.targetRef)).rejects.toMatchObject({ code: 'QUEUE_AUTHORITY_REQUIRED' });
  });
});

// Astra 2616 F2: a claim records the repository it was made in. An interrupted claim may resume (move and settle) only in that repository;
// a re-registered clone that holds the same base and candidate objects, no fence and the branch at the base is refused, never moved.
describe.skipIf(process.platform !== 'linux')('adoption custody stays with the claiming repository (BENIMSEME-DEPO-KIMLIGI, Astra 2616 F2)', () => {
  it('an adoption interrupted before its move resumes in its own repository only; a pre-v58 claim never starts a new move', async () => {
    const f = await fixture(true), { record, plan } = await f.deliver(f.patch('a', 'a.txt', 'a before\n', 'a after\n'));
    const identity = record.intent.command.identity, ledger = join(f.workspaceRoot, '..', 'ledger.db');
    const journal = await openSqliteAttemptStore(ledger, { busyTimeoutMs: 1_000, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86_400_000 });
    try {
      const store: IntegrationAdoptionStore = { async findDelivery() { return record; }, async loadRunWorkspaceCustody() { return null; },
        async loadRun() { return { graph: { tasks: [{ id: identity.taskId, acceptanceCriteria: ['exit'] }] }, revision: 1, progress: [{ taskId: identity.taskId, phase: 'accepted' }], bindings: [{ identity }] } as RunSnapshot; },
        loadAdoption: (scopeId, commandId) => journal.loadAdoption(scopeId, commandId), claimAdoption: (intent, observed) => journal.claimAdoption(intent, observed),
        assertAdoptionFence: (targetRef, observed) => journal.assertAdoptionFence(targetRef, observed), finishAdoption: intent => journal.finishAdoption(intent),
        releaseAdoption: intent => journal.releaseAdoption(intent) };
      const clock = { sample: () => ({ wallMs: 1000, monotonicMs: 1 }) }, sessions = await LocalOsSessionAuthority.create(['s'], 10000, clock);
      const app = (options: GitWorkspaceOptions) => new WorkspaceAdoptionApplication(store, new GitIntegrationDelivery(options), new GitIntegrationAdoption(options), [f.targetRef], sessions,
        { async authorizeIdentity() {} }, clock, { requirement: null, criterionWithin: () => false, async authorizeRun() {}, registry: null, source: new GitRunWorkspaceProvider(new GitWorkspaceBroker(options)) }, confirmation);
      const command = { schemaVersion: 2 as const, commandId: 'adopt-a', identity, deliveryCommandId: record.intent.command.commandId, targetRef: f.targetRef };
      // A: the journal claim is written, then the process dies before the Git move.
      vi.spyOn(GitIntegrationAdoption.prototype, 'move').mockRejectedValueOnce(new Error('crash before move'));
      await expect(app(f.options).adopt(command)).rejects.toThrow('crash before move');
      const claimed = (await journal.loadAdoption('s', 'adopt-a'))!;
      expect(claimed).toMatchObject({ sequence: 1, settled: false, repository: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      // B: an independent clone of A carrying the base and the candidate objects, the branch at the base, no fence.
      const other = join(f.workspaceRoot, '..', 'clone');
      await exec('/usr/bin/git', ['clone', '-q', f.sourceRoot, other]);
      await f.git('push', '-q', other, `${plan.commit}:refs/heads/candidate-copy`);
      const gitB = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', other, ...args])).stdout.trim();
      await gitB('branch', '-D', 'candidate-copy'); await gitB('branch', '-f', 'adopted', f.base);
      expect(await gitB('cat-file', '-t', plan.commit)).toBe('commit');
      const optionsB = { ...f.options, sourceRoot: other }, fenceB = () => gitB('for-each-ref', 'refs/deckent/adoption-fences/');
      await expect(app(optionsB).adopt(command)).rejects.toMatchObject({ code: 'ADOPTION_REPOSITORY_CHANGED' });
      expect(await gitB('rev-parse', f.targetRef)).toBe(f.base); expect(await fenceB()).toBe('');
      expect(await journal.loadAdoption('s', 'adopt-a')).toEqual(claimed);
      // A claim recorded before ledger v58 names no repository: no observation can attribute it, so it never starts a new move, here or there.
      const db = new DatabaseSync(ledger);
      db.prepare("UPDATE workspace_adoptions SET repository='pre-v58' WHERE command_id='adopt-a'").run();
      for (const options of [f.options, optionsB]) await expect(app(options).adopt(command)).rejects.toMatchObject({ code: 'ADOPTION_REPOSITORY_CHANGED' });
      expect(await f.git('rev-parse', f.targetRef)).toBe(f.base); expect(await gitB('rev-parse', f.targetRef)).toBe(f.base);
      db.prepare('UPDATE workspace_adoptions SET repository=? WHERE command_id=?').run(claimed.repository!, 'adopt-a'); db.close();
      // The legitimate crash replay in A still moves and settles the same record.
      expect(await app(f.options).adopt(command)).toMatchObject({ status: 'adopted', sequence: 1, toCommit: plan.commit });
      expect(await f.git('rev-parse', f.targetRef)).toBe(plan.commit); expect(await gitB('rev-parse', f.targetRef)).toBe(f.base);
      expect(await journal.loadAdoption('s', 'adopt-a')).toMatchObject({ settled: true, repository: claimed.repository });
    } finally { journal.close(); }
  });
});

const metadata = { title: 't', acceptance: { phase: 'accepted', criteria: 1, runRevision: 1, modelUnverified: false }, deliveredAtMs: 1000 };
const objects = async (root: string) => (await exec('find', [join(root, '.git', 'objects'), '-type', 'f'])).stdout.split('\n').sort();
const planned = async (f: Awaited<ReturnType<typeof fixture>>, p: WorkspacePatch) => { const { manifest } = await f.prepare(p);
  return { manifest, plan: await f.files.plan({ schemaVersion: 1, commandId: p.identity.runId, identity: p.identity, integrationCommandId: manifest.command.commandId }, manifest, p, metadata) }; };
describe.skipIf(process.platform !== 'linux')('working-tree delivery (owner 2026-11-05 R9p)', () => {
  it('writes the accepted change into the files only; other WIP, index, HEAD, refs and the object store stay; originals and permissions are kept', async () => {
    const f = await fixture(false, 'sha1', true);
    await exec('chmod', ['600', join(f.sourceRoot, 'a.txt')]); await writeFile(join(f.sourceRoot, 'b.txt'), 'b person WIP\n'); await writeFile(join(f.sourceRoot, 'notes.txt'), 'untracked\n');
    const p = f.patch('wt', 'a.txt', 'a before\n', 'a after\n');
    p.changes.push(f.patch('wt', 'dir/new.txt', null, 'added\n').changes[0]!, f.patch('wt', 'old.txt', 'remove\n', null).changes[0]!);
    const before = await f.state(), index = await readFile(join(f.sourceRoot, '.git/index')), stored = await objects(f.sourceRoot), { plan } = await f.deliver(p);
    expect(await readFile(join(f.sourceRoot, 'a.txt'), 'utf8')).toBe('a after\n'); expect(await readFile(join(f.sourceRoot, 'dir/new.txt'), 'utf8')).toBe('added\n');
    await expect(readFile(join(f.sourceRoot, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await exec('stat', ['-c', '%a', join(f.sourceRoot, 'a.txt')])).stdout.trim()).toBe('600');
    expect(await readFile(join(f.sourceRoot, 'b.txt'), 'utf8')).toBe('b person WIP\n'); expect(await readFile(join(f.sourceRoot, 'notes.txt'), 'utf8')).toBe('untracked\n');
    expect(await readFile(join(f.sourceRoot, '.git/index'))).toEqual(index); const after = await f.state();
    expect([after.head, after.tip, after.refs]).toEqual([before.head, before.tip, before.refs]); expect(after.refs).not.toContain('refs/deckent/');
    expect(await objects(f.sourceRoot)).toEqual(stored);
    const journal = join(f.workspaceRoot, 'working-tree-deliveries', plan.ref.split('/').pop()!);
    expect(JSON.parse(await readFile(join(journal, 'journal.json'), 'utf8'))).toMatchObject({ state: 'written', written: ['a.txt', 'dir/new.txt', 'old.txt'] });
    expect([await readFile(join(journal, 'original-0'), 'utf8'), await readFile(join(journal, 'original-2'), 'utf8')]).toEqual(['a before\n', 'remove\n']);
  });
  it('R9n: the base is the current files in a private Run repository; secrets, links and hard links stay out, nothing enters the person\'s repository, the yes writes onto the WIP line', async () => {
    const f = await fixture(false, 'sha1', true), s = f.sourceRoot, withheld = ['TOKEN=synthetic\n', 'synthetic-key\n', 'hard\n'];
    await writeFile(join(s, 'a.txt'), 'a before\nikinci satır\n'); await writeFile(join(s, 'todo.txt'), 'untracked\n'); await writeFile(join(s, '.env'), withheld[0]!);
    await writeFile(join(s, 'secret.pem'), withheld[1]!); await exec('ln', ['-s', '/etc/hostname', join(s, 'link.txt')]);
    await writeFile(join(f.workspaceRoot, 'shared'), withheld[2]!); await exec('ln', [join(f.workspaceRoot, 'shared'), join(s, 'hard.txt')]);
    // The person's repository (refs, HEAD, status, index bytes, object files); Deckent's own workspace root is not part of it.
    const person = async () => { const { candidates, ...state } = await f.state(); void candidates; return [state, await readFile(join(s, '.git/index')), await objects(s)]; }, before = await person();
    const base = await captureWorkingTreeBase(f.options, { scopeId: 's', runId: 'r9n' }, limits, workerTreeDenied);
    // DENY: credential-table exclusions precede the caller's deny-path rule; the files and their order stay pinned.
    expect(base.excluded.map(entry => [entry.path, entry.rule])).toEqual([['.env', 'patch-excluded'], ['hard.txt', 'hard-link'], ['link.txt', 'symlink'], ['secret.pem', 'patch-excluded']]);
    const identity = { scopeId: 's', runId: 'r9n', taskId: 't', attemptId: 'w', layoutRevision: 'l', generation: 1 };
    const lease = await new GitWorkspaceBroker(base.options).allocate({ schemaVersion: 1, identity, baseCommit: base.commit });
    expect(lease.sourceBase.adapter.version).toBe(2); expect((await readdir(lease.workspace)).filter(name => name !== '.git').sort()).toEqual(['a.txt', 'b.txt', 'old.txt', 'todo.txt']);
    expect(await readFile(join(lease.workspace, 'a.txt'), 'utf8')).toBe('a before\nikinci satır\n');
    for (const text of withheld) for (const root of [s, base.options.runBase!, lease.workspace]) await expect(exec('/usr/bin/git', ['-C', root, 'cat-file', '-e', gitBlobOid(Buffer.from(text), 'sha1')])).rejects.toBeDefined();
    expect(await person()).toEqual(before);
    await f.deliver(workspacePatchSchema.parse({ ...f.patch('r9n', 'a.txt', 'a before\nikinci satır\n', 'a before\nikinci satır\nworker\n'), baseCommit: base.commit }));
    expect(await readFile(join(s, 'a.txt'), 'utf8')).toBe('a before\nikinci satır\nworker\n'); expect(await readFile(join(s, 'todo.txt'), 'utf8')).toBe('untracked\n');
    expect(await person()).toEqual(before);
    // L1c: a subfolder project and an unignored file list over `outputBytes` are typed permanent refusals before any private repository exists.
    const bases = await readdir(join(f.workspaceRoot, 'run-bases')); await mkdir(join(s, 'sub')); await mkdir(join(s, 'build'));
    for (let index = 0; index < 40; index++) await writeFile(join(s, 'build', `generated-output-file-with-a-long-name-${index}.js`), '');
    await expect(captureWorkingTreeBase({ ...f.options, sourceRoot: join(s, 'sub') }, { scopeId: 's', runId: 'sub' }, limits, workerTreeDenied)).rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_SUBFOLDER' });
    await expect(captureWorkingTreeBase({ ...f.options, outputBytes: s.length + 200 }, { scopeId: 's', runId: 'big' }, limits, workerTreeDenied))
      .rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_LISTING_LIMIT', params: { limit: s.length + 200, maxEntries: limits.maxEntries } });
    // A6-6: the copy of HEAD's objects into the private repository stops at `copyBytes` (both Git processes end), a typed permanent refusal.
    await expect(captureWorkingTreeBase({ ...f.options, copyBytes: 64 }, { scopeId: 's', runId: 'copy' }, limits, workerTreeDenied)).rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_COPY_LIMIT', params: { limit: 64 } });
    expect(['PATCH_WORKING_TREE_SUBFOLDER', 'PATCH_WORKING_TREE_LISTING_LIMIT', 'PATCH_WORKING_TREE_COPY_LIMIT'].map(code => classifyLaunchRefusal(new WorkspacePatchError(code as never)).disposition)).toEqual(['permanent', 'permanent', 'permanent']);
    expect(await readdir(join(f.workspaceRoot, 'run-bases'))).toEqual(bases); await rm(join(s, 'build'), { recursive: true });
    // L1c lifecycle: a settled Run's base goes (verified, detached, removed); its later use is typed; a stale capture remnant is swept, a fresh one kept.
    const stale = join(f.workspaceRoot, 'run-bases', '.00000000-0000-4000-8000-000000000000'), young = join(f.workspaceRoot, 'run-bases', '.00000000-0000-4000-8000-000000000001');
    await mkdir(join(stale, 'objects'), { recursive: true, mode: 0o700 }); await mkdir(young, { mode: 0o700 }); await utimes(stale, new Date(0), new Date(0));
    expect(await sweepRunBases(f.workspaceRoot, f.options.timeoutMs, 16)).toEqual({ removed: 1, kept: 1, runs: expect.arrayContaining([{ scopeId: 's', runId: 'r9n' }, { scopeId: 's', runId: 'wt' }]) });
    expect([await removeRunBase(f.workspaceRoot, { scopeId: 's', runId: 'r9n' }), await removeRunBase(f.workspaceRoot, { scopeId: 's', runId: 'r9n' })]).toEqual(['removed', 'absent']);
    await expect(new GitWorkspaceBroker(base.options).captureSourceBase()).rejects.toMatchObject({ code: 'WORKSPACE_RUN_BASE_REMOVED' });
    expect((await readdir(join(f.workspaceRoot, 'run-bases'))).sort()).toEqual([...bases.filter(name => !name.startsWith('.') && name !== base.options.runBase!.split('/').pop()), '.00000000-0000-4000-8000-000000000001'].sort());
    expect(await person()).toEqual(before);
    // A non-Linux host is refused before anything is read (no silently empty base).
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!; Object.defineProperty(process, 'platform', { value: 'darwin' });
    try { await expect(captureWorkingTreeBase(f.options, { scopeId: 's', runId: 'mac' }, limits, workerTreeDenied)).rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_UNSUPPORTED' }); }
    finally { Object.defineProperty(process, 'platform', platform); }
  });
  it('A6-1 (alpha.64): no filter driver runs in the service; a filtered path keeps its HEAD blob in every attribute view, is withheld, and a patch writing it is refused', async () => {
    const f = await fixture(false, 'sha1', true), s = f.sourceRoot, marker = join(f.workspaceRoot, 'ran'), git = (...args: string[]) => exec('/usr/bin/git', ['-C', s, ...args]);
    const capture = (runId: string, options = f.options) => captureWorkingTreeBase(options, { scopeId: 's', runId }, limits, workerTreeDenied);
    // An encrypting driver (base64, standing in for git-crypt) and an LFS path (pointer committed, real bytes in the file; git-lfs is not installed).
    const plain = 'TOKEN=synthetic-plaintext\n', pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 10\n';
    await git('config', 'filter.crypt.clean', `sh -c 'echo ran >> ${marker}; base64'`); await git('config', 'filter.crypt.smudge', `sh -c 'echo ran >> ${marker}; base64 -d'`);
    await writeFile(join(s, '.gitattributes'), '*.sec filter=crypt\n*.bin filter=lfs\n'); await writeFile(join(s, 'key.sec'), plain); await writeFile(join(s, 'big.bin'), pointer);
    await exec('ln', ['-s', 'a.txt', join(s, 'same.lnk')]); // an unchanged tracked symlink is HEAD's own entry, never withheld (F2: the reader names it with its target)
    await git('add', '.'); await git('commit', '-qm', 'filtered');
    const cipher = (await git('cat-file', 'blob', 'HEAD:key.sec')).stdout; expect(cipher).toBe(Buffer.from(plain).toString('base64') + '\n');
    // A racy filtered entry: `diff-index` (alpha.63) hashes it through the driver (proved below on the same fixture).
    const at = new Date(Math.floor(Date.now() / 1000) * 1000); await utimes(join(s, 'key.sec'), at, at); await git('update-index', '--refresh'); await utimes(join(s, '.git/index'), at, at);
    await rm(marker); await writeFile(join(s, 'big.bin'), 'real bytes'); // the test's own Git ran the driver above; from here only Deckent runs Git
    const withheld = [['big.bin', 'filter:lfs'], ['key.sec', 'filter:crypt']];
    const holdsHead = async (runId: string) => {
      const base = await capture(runId); expect(base.excluded.map(entry => [entry.path, entry.rule])).toEqual(withheld);
      const lease = await new GitWorkspaceBroker(base.options).allocate({ schemaVersion: 1, identity: { scopeId: 's', runId, taskId: 't', attemptId: runId, layoutRevision: 'l', generation: 1 }, baseCommit: base.commit });
      expect([await readFile(join(lease.workspace, 'key.sec'), 'utf8'), await readFile(join(lease.workspace, 'big.bin'), 'utf8')]).toEqual([cipher, pointer]);
      for (const root of [s, base.options.runBase!, lease.workspace]) await expect(exec('/usr/bin/git', ['-C', root, 'cat-file', '-e', gitBlobOid(Buffer.from(plain), 'sha1')])).rejects.toBeDefined();
      return base;
    };
    const base = await holdsHead('a61');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' }); await git('diff-index', '--name-only', 'HEAD');
    await readFile(marker); await rm(marker); // the fixture is armed: Git's own `diff-index` ran the driver here
    // M2: attributes removed in the worktree, `.git/info/attributes` and `core.attributesFile` still leave HEAD's view: the path stays filtered.
    await rm(join(s, '.gitattributes')); await writeFile(join(s, '.git/info/attributes'), '* -filter\n'); await writeFile(join(f.workspaceRoot, 'attributes'), '* !filter\n');
    await git('config', 'core.attributesFile', join(f.workspaceRoot, 'attributes')); await holdsHead('a61-removed');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    // K-1: a patch writing a filtered path is refused before delivery reads or writes any file.
    const refused = workspacePatchSchema.parse({ ...f.patch('a61', 'key.sec', cipher, 'edited\n'), baseCommit: base.commit });
    await expect(f.prepare(refused)).rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_FILTERED', params: { count: 1, paths: 'key.sec', omitted: 0 } });
    expect(await readFile(join(s, 'key.sec'), 'utf8')).toBe(plain);
    // A configured driver no attribute names (Astra 3038: an empty name is one too) and a Git below the `check-attr --source` floor are typed permanent refusals.
    const bases = await readdir(join(f.workspaceRoot, 'run-bases')); await writeFile(join(s, '.git/config'), `${await readFile(join(s, '.git/config'), 'utf8')}[filter ""]\n\tclean = cat\n`);
    await expect(capture('orphan')).rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_FILTER', params: { drivers: '""' } });
    const old = join(f.workspaceRoot, 'git-2.39'); await writeFile(old, `#!/bin/sh\nfor a; do last=$a; done\n[ "$last" = version ] && { echo 'git version 2.39.0'; exit 0; }\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
    await expect(capture('old', { ...f.options, gitExecutable: old })).rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_GIT_VERSION', params: { found: '2.39.0', required: '2.40.0' } });
    expect(await readdir(join(f.workspaceRoot, 'run-bases'))).toEqual(bases); await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(['PATCH_WORKING_TREE_FILTER', 'PATCH_WORKING_TREE_GIT_VERSION'].map(code => classifyLaunchRefusal(new WorkspacePatchError(code as never)).disposition)).toEqual(['permanent', 'permanent']);
  });
});
describe.skipIf(process.platform !== 'linux')('working-tree delivery conflicts, crash recovery and rollback (R9p, L1c, Astra 3015)', () => {
  it('one touched path differing from its base writes nothing (PATCH_CONFLICT before any write)', async () => {
    const f = await fixture(false, 'sha1', true), p = f.patch('wt', 'a.txt', 'a before\n', 'a after\n');
    p.changes.push(f.patch('wt', 'b.txt', 'b before\n', 'b after\n').changes[0]!);
    const { manifest, plan } = await planned(f, p);
    await writeFile(join(f.sourceRoot, 'b.txt'), 'saved by the person meanwhile\n');
    await expect(f.files.publish(plan, manifest, p)).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    expect(await readFile(join(f.sourceRoot, 'a.txt'), 'utf8')).toBe('a before\n'); expect(await f.files.delivered(plan)).toBe(false);
    // F1 (Astra 3015): the person's save injected exactly between the writer's steps on the path being written is never written over or unlinked.
    p.changes.push(f.patch('wt', 'old.txt', 'remove\n', null).changes[0]!);
    const s = f.sourceRoot, kept = join(f.workspaceRoot, 'working-tree-deliveries', plan.ref.split('/').pop()!), file = (name: string) => readFile(join(s, name), 'utf8');
    const reset = () => Promise.all([writeFile(join(s, 'a.txt'), 'a before\n'), writeFile(join(s, 'b.txt'), 'b before\n'), writeFile(join(s, 'old.txt'), 'remove\n')]);
    const save = async (name: string, text: string) => { await writeFile(join(s, 'saved.tmp'), text); await rename(join(s, 'saved.tmp'), join(s, name)); }; // an editor's atomic save
    const taking = (name: string) => (from: string, to: string) => from.endsWith(`/${name}`) && to.endsWith('.aside'), placing = (from: string) => from.endsWith('.tmp');
    const conflict = async (text: string) => { await expect(f.files.publish(plan, manifest, p)).rejects.toMatchObject({ code: 'PATCH_CONFLICT' }); expect(await file('a.txt')).toBe(text); };
    const clean = async () => expect((await readdir(s)).filter(name => name.startsWith('.deckent-') || name === 'saved.tmp')).toEqual([]);
    let handle: FileHandle | undefined;
    // (a) saved after the last read, right before the take (the reported window): the taken file is the person's and goes straight back.
    await reset(); once('rename', taking('a.txt'), () => save('a.txt', 'person A\n')); await conflict('person A\n'); await clean();
    // (b) card i: saved by rename right after the taken file compared equal: the no-clobber link leaves the person's file in place.
    await reset(); once('link', placing, () => save('a.txt', 'person B\n')); await conflict('person B\n'); await clean();
    // (c) card ii: written in place right after that compare, through a handle the editor opened before the take: the person's file returns over ours.
    await reset(); once('rename', taking('a.txt'), async () => { handle = await open(join(s, 'a.txt'), 'r+'); });
    once('link', placing, async () => { await handle!.write('person C\n', 0); await handle!.close(); }); await conflict('person C\n'); await clean();
    // (d) a removal saved right before its take: put back; the files written before it are named.
    await reset(); once('rename', taking('old.txt'), () => save('old.txt', 'person D\n'));
    await expect(f.files.publish(plan, manifest, p)).rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_PARTIAL', params: { written: 'a.txt, b.txt', pending: 'old.txt' } });
    expect(await file('old.txt')).toBe('person D\n'); await clean();
    // (e) the remaining window, such a handle writing after the last compare: the taken inode itself moves into the journal directory, so the bytes stay.
    await reset(); once('rename', taking('a.txt'), async () => { handle = await open(join(s, 'a.txt'), 'r+');
      once('rename', (from, to) => from.endsWith('.aside') && to.startsWith(kept), async () => { await handle!.write('late!!!!\n', 0); await handle!.close(); }); });
    await f.files.publish(plan, manifest, p); expect([await file('a.txt'), await file('b.txt')]).toEqual(['a after\n', 'b after\n']); await clean();
    expect(await Promise.all((await readdir(kept)).filter(name => name.endsWith('.aside')).map(name => readFile(join(kept, name), 'utf8')))).toContain('late!!!!\n');
    // (f) R1 (Astra 3017), EXDEV (the journal directory on another filesystem, e.g. a WSL /mnt/c project): the handle writes AFTER the last comparison, as the
    // taken file would leave. Nothing is unlinked: both taken files stay beside their names, are returned for the person's note and named in the journal,
    // and Deckent never deletes them (lead, Astra 3019: no automatic cleanup).
    await captureWorkingTreeBase(f.options, { scopeId: 's', runId: 'wt4' }, limits, workerTreeDenied);
    const q = f.patch('wt4', 'a.txt', 'a before\n', 'a fourth\n'); q.changes.push(f.patch('wt4', 'b.txt', 'b before\n', 'b fourth\n').changes[0]!); await reset();
    const exdev = await planned(f, q), moved = join(f.workspaceRoot, 'working-tree-deliveries', exdev.plan.ref.split('/').pop()!), aside = /^\.deckent-[0-9a-f-]{36}\.aside$/;
    handle = undefined;
    fsHook.rename = async (from, to) => {
      if (from.endsWith('/a.txt') && to.endsWith('.aside') && !handle) handle = await open(join(s, 'a.txt'), 'r+'); // an editor's handle, opened before the take
      if (!from.endsWith('.aside') || !to.startsWith(moved)) return;
      if (handle) { await handle.write('exdev!!!\n', 0); await handle.close(); handle = undefined; }
      throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    };
    expect(await f.files.publish(exdev.plan, exdev.manifest, q)).toEqual([expect.stringMatching(aside), expect.stringMatching(aside)]); fsHook.rename = null;
    const beside = async () => Promise.all((await readdir(s)).filter(name => aside.test(name)).map(file)), recorded = async () => JSON.parse(await readFile(join(moved, 'journal.json'), 'utf8')).setAside;
    expect([(await beside()).sort(), (await recorded()).length, await file('a.txt'), await file('b.txt')]).toEqual([['b before\n', 'exdev!!!\n'], 2, 'a fourth\n', 'b fourth\n']);
  });
  it('refuses a symlinked directory on the way (PATCH_UNSAFE); nothing is written outside the checkout', async () => {
    const f = await fixture(false, 'sha1', true), outside = join(f.workspaceRoot, 'outside'); await mkdir(outside); await exec('ln', ['-s', outside, join(f.sourceRoot, 'link')]);
    const p = f.patch('wt', 'a.txt', 'a before\n', 'a after\n'), { manifest, plan } = await planned(f, p);
    p.changes.push(f.patch('wt', 'link/x.txt', null, 'escaped\n').changes[0]!);
    await expect(f.files.publish(plan, manifest, p)).rejects.toMatchObject({ code: 'PATCH_UNSAFE' });
    expect(await readdir(outside)).toEqual([]); expect(await readFile(join(f.sourceRoot, 'a.txt'), 'utf8')).toBe('a before\n');
    // B2-6 (owner 2026-11-09): a file carrying a setuid, setgid or sticky bit is refused before anything is written; its bits and bytes stay.
    p.changes.pop(); for (const bits of ['4644', '2644', '1644']) { await exec('chmod', [bits, join(f.sourceRoot, 'a.txt')]); await expect(f.files.publish(plan, manifest, p)).rejects.toMatchObject({ code: 'PATCH_UNSAFE' });
      expect([(await exec('stat', ['-c', '%a', join(f.sourceRoot, 'a.txt')])).stdout.trim(), await readFile(join(f.sourceRoot, 'a.txt'), 'utf8')]).toEqual([bits, 'a before\n']); }
  });
  it('serializes deliveries into one checkout: a held lock is waited for, and still held at the bound it is a typed refusal', async () => {
    const f = await fixture(false, 'sha1', true), p = f.patch('wt', 'a.txt', 'a before\n', 'a after\n'), { manifest, plan } = await planned(f, p);
    // B1-12 (owner 2026-11-09): the shared kernel lock; held by another description it is waited for, and still held at the bound it is BUSY.
    const lock = join(f.workspaceRoot, format.locks, patchDigest(f.sourceRoot)); await mkdir(join(f.workspaceRoot, format.locks), { recursive: true });
    const holder = (await withExclusiveFileLock(lock, { waitMs: 0, pollMs: 0 }))!, quick = new GitWorkingTreeDelivery({ ...f.options, timeoutMs: 150 }, limits);
    await expect(quick.publish(plan, manifest, p)).rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_BUSY' });
    expect(await readFile(join(f.sourceRoot, 'a.txt'), 'utf8')).toBe('a before\n');
    const waiting = f.files.publish(plan, manifest, p); setTimeout(() => holder.release(), 200); await waiting;
    expect(await readFile(join(f.sourceRoot, 'a.txt'), 'utf8')).toBe('a after\n'); expect(await f.files.delivered(plan)).toBe(true);
    // L1c: a holder that died mid-write left its journal `writing` and its custody entry (written before `writing`); the next holder classifies it from the files first, never rewritten.
    await captureWorkingTreeBase(f.options, { scopeId: 's', runId: 'wt2' }, limits, workerTreeDenied);
    const other = f.patch('wt2', 'b.txt', 'b before\n', 'b after\n'), second = await planned(f, other), custody = join(f.workspaceRoot, format.pending, patchDigest(f.sourceRoot));
    const crashed = join(f.workspaceRoot, format.deliveries, 'c'.repeat(64)); await mkdir(crashed, { recursive: true });
    // F2/F3 (Astra 3015): the journal keeps each path's full state (existence, digest, Git mode).
    const seen = (text: string, mode = '100644') => ({ digest: patchDigest(text), mode }), journal = async () => JSON.parse(await readFile(join(crashed, format.journal), 'utf8'));
    const died = async (changes: object[], version = format.journalVersion) => { await mkdir(custody, { recursive: true }); await writeFile(join(custody, 'c'.repeat(64)), '');
      await writeFile(join(crashed, format.journal), JSON.stringify({ schemaVersion: version, state: 'writing', written: [], changes }), { mode: 0o600 }); };
    const crash = async (changes: object[]) => { await died(changes); return f.files.publish(second.plan, second.manifest, other); };
    await writeFile(join(f.sourceRoot, 'a.txt'), 'a third\n'); // the crashed delivery wrote a.txt, not yet old.txt: mixed
    await expect(crash([{ path: 'a.txt', before: seen('a after\n'), after: seen('a third\n') }, { path: 'old.txt', before: seen('remove\n'), after: null }]))
      .rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_PARTIAL', params: { written: 'a.txt', pending: 'old.txt' } });
    expect(await journal()).toMatchObject({ state: 'partial', written: ['a.txt'] });
    expect([await readFile(join(f.sourceRoot, 'b.txt'), 'utf8'), await readFile(join(f.sourceRoot, 'old.txt'), 'utf8')]).toEqual(['b before\n', 'remove\n']);
    await f.files.publish(second.plan, second.manifest, other); expect(await readFile(join(f.sourceRoot, 'b.txt'), 'utf8')).toBe('b after\n'); // the lock is free again
    // F2: a mode-only change (same digest) whose holder died before its replace is not written: interrupted, not a false `written`.
    await crash([{ path: 'b.txt', before: seen('b after\n'), after: seen('b after\n', '100755') }]); expect(await journal()).toMatchObject({ state: 'interrupted', written: [] });
    // F2 + F1 crash: content written (died between its link and the temporary file's unlink: two names, one inode) and a mode change taken aside, not
    // yet replaced (its name empty): the temporary name goes, the taken file returns, and the mix is PARTIAL.
    const token = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    await exec('ln', [join(f.sourceRoot, 'a.txt'), join(f.sourceRoot, `.deckent-${token(1)}.tmp`)]); await writeFile(join(f.sourceRoot, `.deckent-${token(1)}.aside`), 'a after\n');
    await rename(join(f.sourceRoot, 'b.txt'), join(f.sourceRoot, `.deckent-${token(2)}.aside`));
    await expect(crash([{ path: 'a.txt', token: token(1), before: seen('a after\n'), after: seen('a third\n') }, { path: 'b.txt', token: token(2), before: seen('b after\n'), after: seen('b after\n', '100755') }]))
      .rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_PARTIAL', params: { written: 'a.txt', pending: 'b.txt' } });
    expect([await readFile(join(f.sourceRoot, 'a.txt'), 'utf8'), await readFile(join(f.sourceRoot, 'b.txt'), 'utf8')]).toEqual(['a third\n', 'b after\n']);
    expect((await readdir(f.sourceRoot)).filter(name => name.startsWith('.deckent-'))).toEqual([]); expect(await readdir(crashed)).toContain(`.deckent-${token(1)}.aside`);
    await f.files.publish(second.plan, second.manifest, other); // the lock is free again
    // R2 (Astra 3017): A died mid-write (mixed); B took the lock and died too before settling A. A's operation stayed in durable custody, so C finds
    // and settles it: PARTIAL, and C writes nothing.
    once('open', path => path === f.sourceRoot, () => Promise.reject(new Error('B died before settling A'))); // B's first open under the lock is A's settle
    await expect(crash([{ path: 'a.txt', before: seen('a after\n'), after: seen('a third\n') }, { path: 'old.txt', before: seen('remove\n'), after: null }])).rejects.toThrow('B died');
    expect([await readdir(custody), (await journal()).state]).toEqual([['c'.repeat(64)], 'writing']);
    await captureWorkingTreeBase(f.options, { scopeId: 's', runId: 'wt5' }, limits, workerTreeDenied);
    await writeFile(join(f.sourceRoot, 'b.txt'), 'b before\n'); const late = f.patch('wt5', 'b.txt', 'b before\n', 'b fifth\n'), third = await planned(f, late);
    await expect(f.files.publish(third.plan, third.manifest, late)).rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_PARTIAL', params: { written: 'a.txt', pending: 'old.txt' } });
    expect([await readFile(join(f.sourceRoot, 'b.txt'), 'utf8'), (await journal()).state, await readdir(custody)]).toEqual(['b before\n', 'partial', []]);
    // R3017: a journal of another version, an earlier version's lock directory, and (F3, A6-5) a journal path outside the patch form are
    // an explicit typed refusal naming what to check and remove: nothing settled, walked or written.
    await died([], 1);
    await expect(f.files.publish(third.plan, third.manifest, late)).rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_RECORD_UNSUPPORTED', params: { path: crashed } });
    const escape = join(f.sourceRoot, '..', `.deckent-${token(3)}.aside`); await writeFile(escape, 'outside\n'); await died([{ path: '../escape.txt', token: token(3), before: seen('outside\n'), after: null }]);
    await expect(f.files.publish(third.plan, third.manifest, late)).rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_RECORD_UNSUPPORTED', params: { path: crashed } });
    await expect(readFile(join(f.sourceRoot, '..', 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(escape, 'utf8')).toBe('outside\n');
    await rm(crashed, { recursive: true }); await rm(lock); await mkdir(lock); await writeFile(join(lock, `${format.lockOwner}${token(4)}.json`), '{}');
    await expect(f.files.publish(third.plan, third.manifest, late)).rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_RECORD_UNSUPPORTED', params: { path: lock } });
    await rm(lock, { recursive: true }); await f.files.publish(third.plan, third.manifest, late);
    expect([await readFile(join(f.sourceRoot, 'b.txt'), 'utf8'), await readdir(custody)]).toEqual(['b fifth\n', []]);
    // R3019: custody that cannot be read (anything but absent) is a typed refusal before any work; nothing is written.
    await writeFile(join(f.sourceRoot, 'b.txt'), 'b before\n'); const sixth = f.patch('wt6', 'b.txt', 'b before\n', 'b sixth\n');
    await captureWorkingTreeBase(f.options, { scopeId: 's', runId: 'wt6' }, limits, workerTreeDenied); const blocked = await planned(f, sixth); await exec('chmod', ['000', custody]);
    try { await expect(f.files.publish(blocked.plan, blocked.manifest, sixth)).rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_RECORD_UNSUPPORTED', params: { path: custody } }); }
    finally { await exec('chmod', ['700', custody]); }
    expect(await readFile(join(f.sourceRoot, 'b.txt'), 'utf8')).toBe('b before\n'); await f.files.publish(blocked.plan, blocked.manifest, sixth);
    expect(await readFile(join(f.sourceRoot, 'b.txt'), 'utf8')).toBe('b sixth\n');
    // F7: the uninstall inventory rows of these files are the formats' own (paths.json pinned equal), and every file left here matches one.
    const rows = workingTreeRemovalPatterns(), left = (await exec('find', [f.workspaceRoot, '-type', 'f', '(', '-path', '*/working-tree-*', '-o', '-path', '*/run-bases/*', ')'])).stdout.split('\n').filter(Boolean);
    expect([removal.archive.members.filter(row => /^\^workspaces\/(run-bases|working-tree-)/u.test(row)), left.filter(file => !rows.some(row => new RegExp(`^${row}`, 'u').test(relative(f.workspaceRoot, file))))])
      .toEqual([rows.map(row => `^workspaces/${row}`), []]);
  });
  it('L1c rollback: the yes puts the delivery\'s originals back with the delivery\'s card and authority; a file changed since is refused and nothing is written', async () => {
    const f = await fixture(false, 'sha1', true), p = f.patch('wt', 'a.txt', 'a before\n', 'a after\n'); p.changes.push(f.patch('wt', 'dir/new.txt', null, 'added\n').changes[0]!);
    const cards: import('#engine/index.js').EffectConfirmationView[] = [];
    const root = join(f.workspaceRoot, 'preview'); await mkdir(join(root, '.deckent'), { recursive: true });
    await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ execution: { docker: { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}`, memoryBytes: 2147483648, pids: 128, cpus: 2,
      logMaxSizeKiB: 1024, logMaxFiles: 2, tmpBytes: 1048576, deadlineMs: 60000, controlTimeoutMs: 5000, outputBytes: 65536 }, git: { gitExecutable: 'git', timeoutMs: 5000 } } }));
    const port = terminalDeliveryPort(root, { inspectInventory: async () => ({ page: { entries: [{ identity: p.identity }], nextAfter: null } }),
      previewWorkspacePatch: async () => ({ patch: p }), checkWorkspaceIntegration: async () => ({ observation: { source: 'source', head: p.baseCommit }, proposal: 'proposal', scope: { status: 'unscoped' } }),
      prepareWorkspaceIntegration: async () => ({}), renderUnifiedDiff: () => '', interactiveDelivery: () => ({}) } as never, { env: homeEnv(join(root, 'home')) })!;
    const shown = await port.preview({ key: 'k', title: 't', ...p.identity });
    const { record } = await f.deliver(p, undefined, { async assertAvailable() {}, async confirm(card) { cards.push(card); return async () => {}; } });
    const forward = [{ path: 'a.txt', before: patchDigest('a before\n'), after: patchDigest('a after\n') }, { path: 'dir/new.txt', before: null, after: patchDigest('added\n') }];
    expect(shown.changes).toEqual(forward); expect(cards[0]!.changes).toEqual(forward);
    const receipt = record.intent.patch, clock = { sample: () => ({ wallMs: 1000, monotonicMs: 1 }) };
    const store = { async findDelivery() { return record; }, async loadRun() { return { revision: 1, graph: { tasks: [{ id: 't', acceptanceCriteria: ['exit'] }] }, progress: [{ taskId: 't', phase: 'accepted' }] } as RunSnapshot; } };
    const app = new WorkingTreeRollbackApplication({ async preview() { return { patch: p, receipt, scope: { status: 'unscoped' } }; } } as never, f.files, store, await LocalOsSessionAuthority.create(['s'], 10000, clock),
      { async authorizeIdentity(action) { expect(action).toBe('deliver-integration'); } }, clock, { async assertAvailable() {}, async confirm(card) { cards.push(card); return async () => {}; } });
    const command = { schemaVersion: 1 as const, commandId: 'undo', identity: p.identity, deliveryCommandId: record.intent.command.commandId };
    await writeFile(join(f.sourceRoot, 'a.txt'), 'changed by the person\n');
    await expect(app.rollback(command)).rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_CHANGED' });
    expect([await readFile(join(f.sourceRoot, 'a.txt'), 'utf8'), await readFile(join(f.sourceRoot, 'dir/new.txt'), 'utf8')]).toEqual(['changed by the person\n', 'added\n']);
    await writeFile(join(f.sourceRoot, 'a.txt'), 'a after\n');
    expect(await app.rollback(command)).toMatchObject({ status: 'working-tree-rolled-back', paths: ['a.txt', 'dir/new.txt'] });
    expect(await readFile(join(f.sourceRoot, 'a.txt'), 'utf8')).toBe('a before\n'); await expect(readFile(join(f.sourceRoot, 'dir/new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(cards.at(-1)).toMatchObject({ operation: 'rollback-working-tree', changes: [{ path: 'a.txt', before: patchDigest('a after\n'), after: patchDigest('a before\n') }, { path: 'dir/new.txt', before: patchDigest('added\n'), after: null }] });
    expect(await app.rollback({ ...command, commandId: 'undo-again' })).toMatchObject({ status: 'working-tree-rolled-back' }); // already back: nothing rewritten
    await expect(new WorkingTreeRollbackApplication({} as never, f.files, store, await LocalOsSessionAuthority.create(['s'], 10000, clock), { async authorizeIdentity() {} }, clock, undefined).rollback(command))
      .rejects.toMatchObject({ code: 'DELIVERY_INTERACTIVE_REQUIRED' });
    // F3 (Astra 3015): a rollback that died after its first file. Its custody entry names the rollback's journal, so the next delivery settles the
    // rollback's own journal (mixed: PARTIAL and stops; all before: interrupted; all after: written), never the delivery's written one.
    await captureWorkingTreeBase(f.options, { scopeId: 's', runId: 'wt3' }, limits, workerTreeDenied);
    const other = f.patch('wt3', 'b.txt', 'b before\n', 'b after\n'), next = await planned(f, other), custody = join(f.workspaceRoot, format.pending, patchDigest(f.sourceRoot));
    const seen = (text: string) => ({ digest: patchDigest(text), mode: '100644' }), id = record.intent.plan.ref.split('/').pop()!;
    const journal = async (suffix: string) => JSON.parse(await readFile(join(f.workspaceRoot, format.deliveries, id + suffix, format.journal), 'utf8'));
    for (const [a, added, state] of [['a before\n', 'added\n', 'partial'], ['a after\n', 'added\n', 'interrupted'], ['a before\n', null, 'written']] as const) {
      await writeFile(join(f.sourceRoot, 'a.txt'), a); await (added ? writeFile(join(f.sourceRoot, 'dir/new.txt'), added) : rm(join(f.sourceRoot, 'dir/new.txt'), { force: true }));
      await mkdir(custody, { recursive: true }); await writeFile(join(custody, id + format.rollback), '');
      await writeFile(join(f.workspaceRoot, format.deliveries, id + format.rollback, format.journal), JSON.stringify({ schemaVersion: format.journalVersion, state: 'writing', written: [],
        changes: [{ path: 'a.txt', before: seen('a after\n'), after: seen('a before\n') }, { path: 'dir/new.txt', before: seen('added\n'), after: null }] }), { mode: 0o600 });
      const taken = f.files.publish(next.plan, next.manifest, other);
      if (state === 'partial') { await expect(taken).rejects.toMatchObject({ code: 'PATCH_WORKING_TREE_PARTIAL', params: { written: 'a.txt', pending: 'dir/new.txt' } }); expect(await readFile(join(f.sourceRoot, 'b.txt'), 'utf8')).toBe('b before\n'); }
      else await taken;
      expect([(await journal('.rollback')).state, (await journal('')).state]).toEqual([state, 'written']);
    }
    expect(await readFile(join(f.sourceRoot, 'b.txt'), 'utf8')).toBe('b after\n');
  });
  it('the mode: live and N1 (work target + adoption targets) stay reference; a project with neither writes its files; an explicit field wins without a work target', async () => {
    const git = { gitExecutable: '/usr/bin/git', timeoutMs: 1000, outputBytes: 65536 }, adoption = { targets: ['refs/heads/deckent/teslim'] };
    const target = { schemaVersion: 2 as const, targets: [{ id: 'teslim-n1', kind: 'git' as const, path: '/nonexistent', baseRef: 'refs/heads/deckent/teslim', scope: { mode: 'warn' as const } }] };
    expect([deliveryMode({ adoption, workTargets: target }), deliveryMode({ adoption, workTargets: target, deliveryMode: 'working-tree' }), deliveryMode({ adoption }),
      deliveryMode({ adoption: { targets: [] } }), deliveryMode({ adoption, deliveryMode: 'working-tree' })]).toEqual(['reference', 'reference', 'reference', 'working-tree', 'working-tree']);
    const layout = { root: '/nonexistent', bootstrapConfigPath: '/nonexistent/config.json' };
    expect((await resolveGitWorkTarget('/p', { git, adoption }, layout)).git).toEqual({ sourceRoot: '/p' });
    expect((await resolveGitWorkTarget('/p', { git, adoption: { targets: [] } }, layout)).git).toEqual({ sourceRoot: '/p', workingTree: true });
  });
});
