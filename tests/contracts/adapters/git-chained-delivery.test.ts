import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitIntegrationTarget, GitIntegrationDelivery, GitIntegrationAdoption, GitWorkspaceBroker, GitRunWorkspaceProvider, LocalOsSessionAuthority,
  applyAcceptedPredecessorPatches, listBase, readBaseBlobs, readWorkspace, diffAgainstBase, hashAlgorithmOf, type GitWorkspaceOptions } from '#adapters/index.js';
import { integrationManifestSchema, patchDigest, patchFile, patchExclusions, workspacePatchSchema, capturedWorkspacePatch, WorkspaceAdoptionApplication,
  WorkspaceDeliveryApplication, assertIntegrationBase, SnapshotBudget, type WorkspacePatch, type IntegrationDeliveryRecord, type IntegrationAdoptionRecord,
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
  const dependent = async (edit: Record<string, string>) => {
    const broker = new GitWorkspaceBroker(startOptions), lease = await broker.allocate({ schemaVersion: 1, identity: identity('d'), baseCommit: base });
    await applyAcceptedPredecessorPatches(lease, startOptions, limits, [{ source: predecessor.identity, receipt: receiptOf(predecessor), patch: predecessor }]);
    for (const [path, text] of Object.entries(edit)) await writeFile(join(lease.workspace, path), text);
    const budget = () => new SnapshotBudget(limits, Date.now() + 10000), listing = await listBase(lease, startOptions, budget()), algorithm = hashAlgorithmOf(base);
    const after = await readWorkspace(lease.workspace, budget(), { listing, algorithm }), changed = diffAgainstBase(listing, after, algorithm);
    const before = await readBaseBlobs(lease, startOptions, budget(), changed.flatMap(path => { const entry = listing.get(path); return entry ? [[path, entry] as const] : []; }));
    return capturedWorkspacePatch(identity('d'), source, base, changed, before, after);
  };
  return { git, base, targetRef, target, predecessor, deliver, adopt, dependent, raw: (args: string[]) => exec('/usr/bin/git', ['-C', sourceRoot, ...args]).then(out => out.stdout) };
}

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
  });
});
