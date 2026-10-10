import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitIntegrationTarget, GitIntegrationDelivery, GitIntegrationAdoption, GitWorkspaceBroker, GitRunWorkspaceProvider, LocalOsSessionAuthority, fingerprintGitSource,
  type GitWorkspaceOptions } from '#adapters/index.js';
import { integrationManifestSchema, integrationDeliveryPlanSchema, patchDigest, patchFile, patchExclusions, workspacePatchSchema, pinRunToDelivery, WorkspaceAdoptionApplication, WorkspaceDeliveryApplication,
  type WorkspacePatch, type IntegrationDeliveryRecord, type IntegrationAdoptionRecord, type IntegrationAdoptionStore, type IntegrationDeliveryStore } from '#engine/index.js';
import type { RunSnapshot } from '#domain/index.js';

const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const limits = { maxBytes: 65536, maxEntries: 1000, maxDepth: 32, maxPathBytes: 1024 };
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
    const store: IntegrationDeliveryStore = { async loadDelivery() { return record; },
      async claimDelivery(intent) { return record = { intent, delivered: false }; }, async finishDelivery(intent) { return record = { intent, delivered: true }; } };
    const clock = { sample: () => ({ wallMs: 1000, monotonicMs: 1 }) }, sessions = await LocalOsSessionAuthority.create(['s'], 10000, clock);
    const patches = { async preview() { return { patch: p, receipt, scope: { status: 'unscoped' } }; }, assertScope() {} };
    const inspection = { async inspect() { return { manifest, receipt }; } };
    const app = new WorkspaceDeliveryApplication(patches as never, inspection as never, target, delivery, store, sessions,
      { async authorizeIdentity(action, identity) { expect(action).toBe('deliver-integration'); expect(identity).toEqual(p.identity); } }, clock);
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
      async loadRun() { return { revision: 1, progress: [{ taskId: identity.taskId, phase: 'accepted' }], bindings: [{ identity }] } as RunSnapshot; },
      async loadRunWorkspaceCustody() { return null; },
      async claimAdoption(intent) { return held = { intent, sequence: (observation.fence?.sequence ?? 0) + 1, settled: false }; },
      async finishAdoption(intent) { return held = { intent, sequence: held!.sequence, settled: true }; } };
    const clock = { sample: () => ({ wallMs: 1000, monotonicMs: 1 }) }, sessions = await LocalOsSessionAuthority.create(['s'], 10000, clock);
    const source = new GitRunWorkspaceProvider(new GitWorkspaceBroker(options));
    const app = new WorkspaceAdoptionApplication(store, delivery, adoption, [targetRef], sessions,
      { async authorizeIdentity(action, authorized) { expect(action).toBe('adopt-integration'); expect(authorized).toEqual(identity); } }, clock,
      { requirement: null, criterionWithin: () => false, async authorizeRun() {}, registry: null, source });
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
    const before = await f.state(); await expect(f.delivery.publish(plan)).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
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
    await f.delivery.publish(parsed); expect(await f.delivery.delivered(parsed)).toBe(true);
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
