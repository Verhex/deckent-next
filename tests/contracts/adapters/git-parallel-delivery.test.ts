import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitIntegrationTarget, GitIntegrationDelivery, GitIntegrationAdoption, GitWorkspaceBroker, GitRunWorkspaceProvider, LocalOsSessionAuthority, fingerprintGitSource,
  GitQueueTarget, openSqliteAttemptStore, type GitWorkspaceOptions } from '#adapters/index.js';
import { integrationManifestSchema, integrationDeliveryPlanSchema, patchDigest, patchFile, patchExclusions, workspacePatchSchema, pinRunToDelivery, WorkspaceAdoptionApplication, WorkspaceDeliveryApplication,
  targetQueueKey, assertIntegrationBase, SnapshotBudget, type WorkspacePatch, type IntegrationDeliveryRecord, type IntegrationAdoptionRecord, type IntegrationAdoptionStore, type IntegrationDeliveryStore } from '#engine/index.js';
import type { RunSnapshot } from '#domain/index.js';

const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const limits = { maxBytes: 65536, maxEntries: 1000, maxDepth: 32, maxPathBytes: 1024 };
const confirmation = { async assertAvailable() {}, async confirm(card: import('#engine/index.js').EffectConfirmationView) {
  expect(card.resource).toMatch(/^refs\//); expect(card.to).toMatch(/^[a-f0-9]{40,64}$/); return async () => {};
} };
const actor = { id: 'owner', issuer: 'test', subject: 'owner' };
async function fixture(refOnly: boolean, format = 'sha1') {
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
    ...(refOnly ? { baseRef: targetRef } : {}) };
  const target = new GitIntegrationTarget(options, limits), delivery = new GitIntegrationDelivery(options), adoption = new GitIntegrationAdoption(options);
  const file = (text: string) => patchFile(Buffer.from(text), '100644');
  const patch = (id: string, path: string, before: string | null, after: string | null): WorkspacePatch => workspacePatchSchema.parse({
    schemaVersion: 1, kind: 'workspace-patch', identity: { scopeId: 's', runId: id, taskId: 't', attemptId: id, layoutRevision: 'l', generation: 1 },
    source: { schemaVersion: 1, adapter: { id: 'git', version: 1 }, sourceFingerprint: fingerprintGitSource({ schemaVersion: 1, sourceRoot, repositoryRoot: sourceRoot }) },
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
  const deliver = async (p: WorkspacePatch, candidate?: Awaited<ReturnType<typeof prepare>>) => {
    const { manifest, receipt } = candidate ?? await prepare(p);
    const command = { schemaVersion: 1 as const, commandId: p.identity.runId, identity: p.identity, integrationCommandId: manifest.command.commandId };
    let record: IntegrationDeliveryRecord | null = null;
    const store: IntegrationDeliveryStore = { async loadRun() { return { revision: 1, graph: { tasks: [{ id: p.identity.taskId, acceptanceCriteria: ['exit'] }] }, progress: [{ taskId: p.identity.taskId, phase: 'accepted' }] } as RunSnapshot; }, async loadDelivery() { return record; },
      async claimDelivery(intent) { return record = { intent, delivered: false }; }, async finishDelivery(intent) { return record = { intent, delivered: true }; } };
    const clock = { sample: () => ({ wallMs: 1000, monotonicMs: 1 }) }, sessions = await LocalOsSessionAuthority.create(['s'], 10000, clock);
    const patches = { async preview() { return { patch: p, receipt, scope: { status: 'unscoped' } }; }, assertScope() {} };
    const inspection = { async inspect() { return { manifest, receipt }; } };
    const app = new WorkspaceDeliveryApplication(patches as never, inspection as never, target, delivery, store, sessions,
      { async authorizeIdentity(action, identity) { expect(action).toBe('deliver-integration'); expect(identity).toEqual(p.identity); } }, clock, confirmation);
    const result = await app.deliver(command), plan = result.plan;
    expect(result.status).toBe('reference-delivered'); expect(await delivery.delivered(plan)).toBe(true);
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
  return { sourceRoot, workspaceRoot, options, git, base, targetRef, target, delivery, adoption, patch, prepare, deliver, adopt, advance, state };
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
