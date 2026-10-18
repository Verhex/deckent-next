import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitIntegrationTarget, GitIntegrationDelivery, GitIntegrationAdoption, GitWorkspaceBroker, GitRunWorkspaceProvider, LocalOsSessionAuthority,
  applyAcceptedPredecessorPatches, listBase, readBaseBlobs, readWorkspace, diffAgainstBase, hashAlgorithmOf, type GitWorkspaceOptions } from '#adapters/index.js';
import { integrationManifestSchema, patchDigest, patchFile, patchExclusions, workspacePatchSchema, capturedWorkspacePatch, WorkspaceAdoptionApplication,
  WorkspaceDeliveryApplication, assertIntegrationBase, assertIntegrationBefore, assertIntegrationSnapshot, prepareIntegrationSnapshot, parseBaseListing, predecessorLineage,
  SnapshotBudget, type WorkspacePatch, type IntegrationDeliveryRecord, type IntegrationAdoptionRecord,
  type IntegrationAdoptionStore, type IntegrationDeliveryStore } from '#engine/index.js';
import type { RunSnapshot } from '#domain/index.js';

const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const limits = { maxBytes: 65536, maxEntries: 1000, maxDepth: 32, maxPathBytes: 1024 };
const confirmation = { async assertAvailable() {}, async confirm() { return async () => {}; } };
const actor = { id: 'owner', issuer: 'test', subject: 'owner' };
const identity = (taskId: string) => ({ scopeId: 's', runId: 'chain', taskId, attemptId: taskId + '1', layoutRevision: 'l', generation: 1 });
const receiptOf = (p: WorkspacePatch) => ({ schemaVersion: 1 as const, scopeId: 's', digest: patchDigest(JSON.stringify(p)), byteLength: Buffer.byteLength(JSON.stringify(p)) });

/** Real Git end to end: the predecessor is prepared, delivered and adopted through the product applications; the dependent starts from the
 * predecessor's accepted patch through the product handoff start and is captured through the same snapshot functions as the worker patch source. */
async function chain() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-chained-delivery-')); roots.push(root);
  const sourceRoot = join(root, 'source'), workspaceRoot = join(root, 'workspaces'), startRoot = join(root, 'starts');
  for (const path of [sourceRoot, workspaceRoot, startRoot]) await mkdir(path, { mode: 0o700 });
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', sourceRoot, ...args])).stdout.trim();
  await git('init', '-q'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(sourceRoot, 'a.txt'), 'a base\n'); await writeFile(join(sourceRoot, 'b.txt'), 'b base\n');
  await git('add', '.'); await git('-c', 'gc.auto=0', 'commit', '-qm', 'base');
  const base = await git('rev-parse', 'HEAD'), targetRef = 'refs/heads/adopted';
  await git('branch', 'adopted', base);
  const options: GitWorkspaceOptions = { sourceRoot, workspaceRoot, gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536, baseRef: targetRef };
  const target = new GitIntegrationTarget(options, limits), delivery = new GitIntegrationDelivery(options), adoption = new GitIntegrationAdoption(options);
  const startOptions: GitWorkspaceOptions = { ...options, workspaceRoot: startRoot };
  const sourceBase = await new GitWorkspaceBroker(startOptions).captureSourceBase(base);
  const source = { schemaVersion: 1 as const, adapter: sourceBase.adapter, sourceFingerprint: sourceBase.sourceFingerprint };
  const file = (text: string) => patchFile(Buffer.from(text), '100644');
  const predecessor = workspacePatchSchema.parse({ schemaVersion: 1, kind: 'workspace-patch', identity: identity('p'), source, baseCommit: base,
    snapshotDigest: patchDigest('p'), exclusions: patchExclusions, changes: [{ path: 'a.txt', before: file('a base\n'), after: file('a pred\n') }] });

  const deliver = async (p: WorkspacePatch) => {
    const receipt = receiptOf(p), command = { schemaVersion: 1 as const, commandId: 'candidate-' + p.identity.taskId, identity: p.identity, proposal: '0'.repeat(20) };
    const manifest = integrationManifestSchema.parse(await target.prepare({ schemaVersion: 1, command, patch: receipt, observation: (await target.observe(p)).digest, actor }, p));
    await target.verify(manifest, p);
    let record: IntegrationDeliveryRecord | null = null;
    const store: IntegrationDeliveryStore = { async loadRun() { return { revision: 1, graph: { tasks: [{ id: p.identity.taskId, acceptanceCriteria: ['exit'] }] }, progress: [{ taskId: p.identity.taskId, phase: 'accepted' }] } as RunSnapshot; },
      async loadDelivery() { return record; }, async claimDelivery(intent) { return record = { intent, delivered: false }; }, async finishDelivery(intent) { return record = { intent, delivered: true }; } };
    const clock = { sample: () => ({ wallMs: 1000, monotonicMs: 1 }) }, sessions = await LocalOsSessionAuthority.create(['s'], 10000, clock);
    const app = new WorkspaceDeliveryApplication({ async preview() { return { patch: p, receipt, scope: { status: 'unscoped' } }; }, assertScope() {} } as never,
      { async inspect() { return { manifest, receipt }; } } as never, target, delivery, store, sessions, { async authorizeIdentity() {} }, clock, confirmation);
    await app.deliver({ schemaVersion: 1, identity: p.identity, commandId: 'delivery-' + p.identity.taskId, integrationCommandId: command.commandId });
    return record!;
  };
  const adopt = async (record: IntegrationDeliveryRecord) => {
    const id = record.intent.command.identity, observation = await adoption.observe(targetRef);
    let held: IntegrationAdoptionRecord | null = null;
    const store: IntegrationAdoptionStore = { async findDelivery() { return record; }, async loadAdoption() { return held; },
      async loadRun() { return { graph: { tasks: [{ id: id.taskId, acceptanceCriteria: ['exit'] }] }, revision: 1, progress: [{ taskId: id.taskId, phase: 'accepted' }], bindings: [{ identity: id }] } as RunSnapshot; },
      async loadRunWorkspaceCustody() { return null; },
      async claimAdoption(intent, observed) { return held = { intent, sequence: (observation.fence?.sequence ?? 0) + 1, settled: false, repository: observed.repository }; },
      async finishAdoption(intent) { return held = { intent, sequence: held!.sequence, settled: true }; } } as IntegrationAdoptionStore;
    const clock = { sample: () => ({ wallMs: 1000, monotonicMs: 1 }) }, sessions = await LocalOsSessionAuthority.create(['s'], 10000, clock);
    const app = new WorkspaceAdoptionApplication(store, delivery, adoption, [targetRef], sessions, { async authorizeIdentity() {} }, clock,
      { requirement: null, criterionWithin: () => false, async authorizeRun() {}, registry: null, source: new GitRunWorkspaceProvider(new GitWorkspaceBroker(options)) }, confirmation);
    return app.adopt({ schemaVersion: 2, commandId: 'adopt-' + id.taskId, identity: id, deliveryCommandId: record.intent.command.commandId, targetRef });
  };
  /** The dependent's worker: starts from the accepted predecessor patch, edits, and the patch is captured against the Run's original base. */
  const dependent = async (edit: Record<string, string>, taskId = 'd') => {
    const broker = new GitWorkspaceBroker(startOptions), lease = await broker.allocate({ schemaVersion: 1, identity: identity(taskId), baseCommit: base });
    await applyAcceptedPredecessorPatches(lease, startOptions, limits, [{ source: predecessor.identity, receipt: receiptOf(predecessor), patch: predecessor }]);
    for (const [path, text] of Object.entries(edit)) await writeFile(join(lease.workspace, path), text);
    const budget = () => new SnapshotBudget(limits, Date.now() + 10000), listing = await listBase(lease, startOptions, budget()), algorithm = hashAlgorithmOf(base);
    const after = await readWorkspace(lease.workspace, budget(), { listing, algorithm }), changed = diffAgainstBase(listing, after, algorithm);
    const before = await readBaseBlobs(lease, startOptions, budget(), changed.flatMap(path => { const entry = listing.get(path); return entry ? [[path, entry] as const] : []; }));
    return capturedWorkspacePatch(identity(taskId), source, base, changed, before, after);
  };
  /** A commit written behind the product's back (plumbing, private index): the history another writer or an attacker could produce. */
  const commitOn = async (parent: string, files: Record<string, string>, message: string) => {
    const env = { ...process.env, GIT_INDEX_FILE: join(root, 'scratch-index') }, plumb = async (args: string[], input?: string) => {
      const child = execFile('/usr/bin/git', ['-C', sourceRoot, ...args], { env });
      if (input !== undefined) child.stdin!.end(input);
      return new Promise<string>((done, fail) => { let out = ''; child.stdout!.on('data', chunk => out += chunk); child.on('close', code => code ? fail(new Error(String(code))) : done(out.trim())); });
    };
    await plumb(['read-tree', parent]);
    for (const [path, text] of Object.entries(files)) await plumb(['update-index', '--add', '--cacheinfo', `100644,${await plumb(['hash-object', '-w', '--stdin'], text)},${path}`]);
    return plumb(['commit-tree', await plumb(['write-tree']), '-p', parent, '-m', message]);
  };
  /** The target version's tree as the candidate preparation lists and checks it out. */
  const checkout = async (commit: string, taskId: string) => {
    const lease = await new GitWorkspaceBroker(startOptions).allocate({ schemaVersion: 1, identity: identity(taskId), baseCommit: commit });
    const budget = () => new SnapshotBudget(limits, Date.now() + 10000), listing = parseBaseListing(await git('ls-tree', '-r', '-z', '-l', '--full-tree', commit) + '\0', budget());
    return { lease, listing, read: () => readWorkspace(lease.workspace, budget(), { listing, algorithm: hashAlgorithmOf(commit), keep: new Set(['a.txt', 'b.txt']) }) };
  };
  return { git, base, targetRef, target, predecessor, deliver, adopt, dependent, commitOn, checkout,
    raw: (args: string[]) => exec('/usr/bin/git', ['-C', sourceRoot, ...args]).then(out => out.stdout) };
}
const budget = () => new SnapshotBudget(limits, Date.now() + 10000);

describe.skipIf(process.platform !== 'linux')('chained delivery (accepted-patch edge)', () => {
  it('SPIKE: the dependent patch is cumulative against the original base and conflicts once the predecessor is adopted', async () => {
    const f = await chain();
    const d = await f.dependent({ 'b.txt': 'b dep\n' });
    // Cumulative: the dependent carries the predecessor's change (before = original base content) plus its own.
    expect(d.baseCommit).toBe(f.base);
    expect(d.changes.map(change => [change.path, change.before?.text ?? null, change.after?.text ?? null]))
      .toEqual([['a.txt', 'a base\n', 'a pred\n'], ['b.txt', 'b base\n', 'b dep\n']]);
    const adopted = await f.adopt(await f.deliver(f.predecessor));
    expect(adopted).toMatchObject({ status: 'adopted', fromCommit: f.base });
    expect(await f.git('rev-parse', f.targetRef)).toBe(adopted.toCommit);
    // Today: the adopted predecessor's own commit is the intervening history that refuses the dependent.
    await expect(assertIntegrationBase(f.raw, d, adopted.toCommit, new SnapshotBudget(limits, Date.now() + 10000))).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
    await expect(f.target.observe(d)).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
    // Past the base check, the candidate checks compare the dependent's original-base `before` with the adopted tree and refuse too.
    const tip = await f.checkout(adopted.toCommit, 'tip');
    expect(() => assertIntegrationBefore(tip.listing, 'sha1', d)).toThrow(expect.objectContaining({ code: 'PATCH_CORRUPT' }));
    expect(() => prepareIntegrationSnapshot(tip.listing, 'sha1', d, new Map())).toThrow(expect.objectContaining({ code: 'PATCH_CONFLICT' }));
    const initial = await tip.read();
    expect(() => prepareIntegrationSnapshot(tip.listing, 'sha1', d, initial)).toThrow(expect.objectContaining({ code: 'PATCH_CONFLICT' }));
    // The candidate after applying the dependent on the adopted tree: `a.txt` no longer differs, so the changed path set mismatches.
    expect(() => assertIntegrationSnapshot(tip.listing, 'sha1', d, new Map(initial).set('b.txt', d.changes[1]!.after!)))
      .toThrow(expect.objectContaining({ code: 'PATCH_CONFLICT' }));
  });

  it('known-limits workaround: the last task of the chain delivers alone, and its delivery holds the predecessor change too', async () => {
    const f = await chain(), d = await f.dependent({ 'b.txt': 'b dep\n' });
    const delivered = await f.deliver(d), commit = delivered.intent.plan.commit;
    expect(await f.git('rev-parse', commit + '^')).toBe(f.base);
    expect([await f.git('show', commit + ':a.txt'), await f.git('show', commit + ':b.txt')]).toEqual(['a pred', 'b dep']);
  });

  describe('R1-a lineage rule: only the exact recorded adopted predecessor version is accepted', () => {
    const adoptedChain = async () => {
      const f = await chain(), d = await f.dependent({ 'b.txt': 'b dep\n' }), adopted = await f.adopt(await f.deliver(f.predecessor));
      return { f, d, version: adopted.toCommit, lineage: [{ adoptedVersion: adopted.toCommit, changes: f.predecessor.changes }] };
    };
    it('accepts the adopted predecessor commit, also behind later disjoint history, and expects its after identity', async () => {
      const { f, d, version, lineage } = await adoptedChain();
      await expect(assertIntegrationBase(f.raw, d, version, budget(), lineage)).resolves.toBeUndefined();
      const later = await f.commitOn(version, { 'c.txt': 'unrelated\n' }, 'disjoint');
      await expect(assertIntegrationBase(f.raw, d, later, budget(), lineage)).resolves.toBeUndefined();
      // Not yet adopted (target still at the original base): the dependent's own `before` is expected, as today.
      await expect(assertIntegrationBase(f.raw, d, f.base, budget(), lineage)).resolves.toBeUndefined();
      // Zero lineage is exactly today's rule.
      await expect(assertIntegrationBase(f.raw, d, later, budget())).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
    });
    it('refuses an unrelated intervening commit, even one writing the predecessor content byte for byte', async () => {
      const { f, d, version, lineage } = await adoptedChain();
      const lookalike = await f.commitOn(f.base, { 'a.txt': 'a pred\n' }, 'same content, not the adopted version');
      expect(lookalike).not.toBe(version);
      await expect(assertIntegrationBase(f.raw, d, lookalike, budget(), lineage)).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
      // A later commit on a predecessor path (changed-then-restored included) is still stale input.
      const touched = await f.commitOn(version, { 'a.txt': 'a other\n' }, 'touch'), restored = await f.commitOn(touched, { 'a.txt': 'a pred\n' }, 'restore');
      await expect(assertIntegrationBase(f.raw, d, restored, budget(), lineage)).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
      const own = await f.commitOn(version, { 'b.txt': 'b other\n' }, 'own path');
      await expect(assertIntegrationBase(f.raw, d, own, budget(), lineage)).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
    });
    it('refuses a tampered predecessor output: the recorded version does not hold the recorded predecessor change', async () => {
      const { f, d, version } = await adoptedChain();
      const tampered = await f.commitOn(f.base, { 'a.txt': 'a evil\n' }, 'tampered');
      await expect(assertIntegrationBase(f.raw, d, tampered, budget(), [{ adoptedVersion: tampered, changes: f.predecessor.changes }]))
        .rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
      const forged = f.predecessor.changes.map(change => ({ ...change, after: patchFile(Buffer.from('a evil\n'), '100644') }));
      await expect(assertIntegrationBase(f.raw, d, version, budget(), [{ adoptedVersion: version, changes: forged }])).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
    });
    it('refuses a predecessor adopted at a different tree or as a different version', async () => {
      const { f, d, version, lineage } = await adoptedChain();
      const wider = await f.commitOn(f.base, { 'a.txt': 'a pred\n', 'extra.txt': 'more\n' }, 'wider tree');
      await expect(assertIntegrationBase(f.raw, d, wider, budget(), [{ adoptedVersion: wider, changes: f.predecessor.changes }]))
        .rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
      const other = await f.commitOn(f.base, { 'a.txt': 'a pred\n' }, 'same tree, other version');
      expect(await f.git('rev-parse', other + '^{tree}')).toBe(await f.git('rev-parse', version + '^{tree}'));
      await expect(assertIntegrationBase(f.raw, d, other, budget(), lineage)).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
    });
    it('refuses a dependent that does not carry the predecessor change it claims to have started from', async () => {
      const { f, version, lineage } = await adoptedChain();
      const reverted = await f.dependent({ 'a.txt': 'a base\n', 'b.txt': 'b dep\n' }, 'e');
      expect(reverted.changes.map(change => change.path)).toEqual(['b.txt']);
      await expect(assertIntegrationBase(f.raw, reverted, version, budget(), lineage)).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
    });
    it('refuses malformed lineage: the same version or path claimed twice', () => {
      const change = { path: 'a.txt', before: null, after: patchFile(Buffer.from('x'), '100644') };
      const patch = { changes: [change] } as unknown as WorkspacePatch;
      expect(() => predecessorLineage(patch, [{ adoptedVersion: 'a'.repeat(40), changes: [change] }, { adoptedVersion: 'a'.repeat(40), changes: [] }]))
        .toThrow(expect.objectContaining({ code: 'PATCH_CORRUPT' }));
      expect(() => predecessorLineage(patch, [{ adoptedVersion: 'a'.repeat(40), changes: [change] }, { adoptedVersion: 'b'.repeat(40), changes: [change] }]))
        .toThrow(expect.objectContaining({ code: 'PATCH_CORRUPT' }));
    });
  });
});
