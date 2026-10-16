import { mkdir, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { GitWorkspaceBroker, type GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { prepareIntegrationSnapshot, assertIntegrationBefore, assertIntegrationSnapshot, patchDigest, WorkspacePatchError, type IntegrationIntent, type IntegrationManifest, type IntegrationTarget, type WorkspacePatch, type PatchLimits } from '#engine/index.js';
import { hashAlgorithmOf, readWorkspace, snapshotDigest, SnapshotBudget } from './snapshot.js';
import { parseBaseListing } from '#engine/index.js';
import { GitCommand } from './git-command.js';
import { assertIntegrationBase } from './integration-base.js';
import { copyPrivateCommit } from './copy-private.js';
import { applyWorkspacePatchChanges } from './patch-apply.js';
import { observeIntegration } from './integration-observe.js';
/** Only the winning durable command creates a candidate. Interrupted allocation is held, never adopted. */
export class GitIntegrationTarget implements IntegrationTarget {
  constructor(private readonly options: GitWorkspaceOptions, private readonly limits: PatchLimits,
    private readonly prospective?: Readonly<{ commit: string; repository: string }>) {}
  async observe(patch: WorkspacePatch) {
    const current = await observeIntegration(this.options, this.limits, patch);
    if (!this.prospective) return current;
    const git = new GitCommand({ ...this.options, sourceRoot: this.prospective.repository }); await git.custody();
    await assertIntegrationBase(args => git.run(args), patch, this.prospective.commit, this.budget());
    return { source: current.source, head: this.prospective.commit, digest: patchDigest(JSON.stringify({ current, prospective: this.prospective.commit })) };
  }
  private location(command: IntegrationIntent['command']) {
    return join(this.options.workspaceRoot, 'integrations', patchDigest(JSON.stringify({ scopeId: command.identity.scopeId, commandId: command.commandId })));
  }
  private async directory(path: string) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.mode & 0o022 || await realpath(path) !== path)
      throw new WorkspacePatchError('PATCH_UNSAFE');
  }
  private broker(command: IntegrationIntent['command']) { return new GitWorkspaceBroker({ ...this.options, workspaceRoot: this.location(command) }); }
  private budget() { return new SnapshotBudget(this.limits, Date.now() + this.options.timeoutMs); }
  private async expected(command: IntegrationIntent['command'], patch: WorkspacePatch, baseCommit: string) {
    await this.directory(join(this.options.workspaceRoot, 'integrations')); await this.directory(this.location(command));
    const lease = await this.broker(command).openRecorded(command.identity);
    if (!lease || lease.sourceBase.sourceFingerprint !== patch.source.sourceFingerprint) throw new WorkspacePatchError('PATCH_CONFLICT');
    // Base identity only: every `before` must be exactly the base object (mode and blob id); no base content is read.
    const git = new GitCommand({ ...this.options, sourceRoot: lease.workspace }); await git.custody();
    await assertIntegrationBase(args => git.run(args), patch, baseCommit, this.budget());
    const listing = parseBaseListing(await git.run(['ls-tree', '-r', '-z', '-l', '--full-tree', baseCommit]), this.budget()); const algorithm = hashAlgorithmOf(baseCommit);
    assertIntegrationBefore(listing, algorithm, patch);
    return { lease, listing, algorithm };
  }
  async prepare(intent: IntegrationIntent, patch: WorkspacePatch): Promise<IntegrationManifest> {
    const observation = await this.observe(patch);
    if (observation.digest !== intent.observation) throw new WorkspacePatchError('PATCH_CONFLICT');
    await this.directory(this.options.workspaceRoot);
    const parent = join(this.options.workspaceRoot, 'integrations');
    await mkdir(parent, { recursive: true, mode: 0o700 }); await this.directory(parent);
    // Exclusive directory is a second fence against unknown filesystem residue.
    await mkdir(this.location(intent.command), { mode: 0o700 });
    const actual = await observeIntegration(this.options, this.limits, patch);
    const lease = await this.broker(intent.command).allocate({ schemaVersion: 1, identity: intent.command.identity, baseCommit: actual.head });
    if (this.prospective) {
      await copyPrivateCommit(this.options, this.prospective.repository, lease.workspace, observation.head, actual.head);
      await new GitCommand({ ...this.options, sourceRoot: lease.workspace }).run(['checkout', '--detach', observation.head]);
    }
    const { listing, algorithm } = await this.expected(intent.command, patch, observation.head);
    const kept = new Set(patch.changes.map(change => change.path));
    const initial = await readWorkspace(lease.workspace, this.budget(), { listing, algorithm, keep: kept });
    const snapshot = prepareIntegrationSnapshot(listing, algorithm, patch, initial);
    await applyWorkspacePatchChanges(lease.workspace, patch.changes);
    return { schemaVersion: 2, kind: 'integration-candidate', baseCommit: patch.baseCommit, effectiveBaseCommit: observation.head, command: intent.command, patch: intent.patch,
      observation: intent.observation, workspace: lease.workspace, snapshotDigest: snapshotDigest(snapshot), application: 'candidate-only' };
  }
  async verify(manifest: IntegrationManifest, patch: WorkspacePatch) {
    if (manifest.schemaVersion === 2 && manifest.baseCommit !== patch.baseCommit) throw new WorkspacePatchError('PATCH_CORRUPT');
    const { lease, listing, algorithm } = await this.expected(manifest.command, patch, manifest.schemaVersion === 2 ? manifest.effectiveBaseCommit : patch.baseCommit);
    if (lease.workspace !== manifest.workspace) throw new WorkspacePatchError('PATCH_CORRUPT');
    for (let pass = 0; pass < 2; pass++) {
      const current = await readWorkspace(lease.workspace, this.budget(), { listing, algorithm, keep: new Set(patch.changes.map(change => change.path)) });
      assertIntegrationSnapshot(listing, algorithm, patch, current);
      if (snapshotDigest(current) !== manifest.snapshotDigest) throw new WorkspacePatchError('PATCH_CONFLICT');
    }
  }
}
