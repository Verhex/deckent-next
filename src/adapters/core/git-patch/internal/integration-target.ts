import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { GitWorkspaceBroker, type GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { patchDigest, WorkspacePatchError, type IntegrationIntent, type IntegrationManifest, type IntegrationTarget, type WorkspacePatch, type PatchLimits } from '#engine/index.js';
import { diffAgainstBase, gitBlobOid, hashAlgorithmOf, listBase, readWorkspace, snapshotDigest, SnapshotBudget, type BaseListing, type Snapshot } from './snapshot.js';
import { observeIntegration } from './integration-observe.js';
/** Only the winning durable command creates a candidate. Interrupted allocation is held, never adopted. */
export class GitIntegrationTarget implements IntegrationTarget {
  constructor(private readonly options: GitWorkspaceOptions, private readonly limits: PatchLimits) {}
  observe(patch: WorkspacePatch) { return observeIntegration(this.options, this.limits, patch); }
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
  private async expected(command: IntegrationIntent['command'], patch: WorkspacePatch) {
    await this.directory(join(this.options.workspaceRoot, 'integrations')); await this.directory(this.location(command));
    const lease = await this.broker(command).openRecorded(command.identity);
    if (!lease || lease.baseCommit !== patch.baseCommit || lease.sourceBase.sourceFingerprint !== patch.source.sourceFingerprint) throw new WorkspacePatchError('PATCH_CONFLICT');
    // Base identity only: every `before` must be exactly the base object (mode and blob id); no base content is read.
    const listing = await listBase(lease, this.options, this.budget()); const algorithm = hashAlgorithmOf(patch.baseCommit);
    for (const change of patch.changes) {
      const entry = listing.get(change.path) ?? null;
      if ((entry === null) !== (change.before === null)) throw new WorkspacePatchError('PATCH_CORRUPT');
      if (entry && change.before && (entry.mode !== change.before.mode || gitBlobOid(Buffer.from(change.before.text, 'utf8'), algorithm) !== entry.oid)) throw new WorkspacePatchError('PATCH_CORRUPT');
    }
    return { lease, listing, algorithm };
  }
  /** The candidate must be exactly base + patch: the same changed path set and the patch's `after` content, nothing else. */
  private assertCandidate(listing: BaseListing, algorithm: 'sha1' | 'sha256', patch: WorkspacePatch, current: Snapshot) {
    if (JSON.stringify(diffAgainstBase(listing, current, algorithm)) !== JSON.stringify(patch.changes.map(change => change.path))) throw new WorkspacePatchError('PATCH_CONFLICT');
    for (const change of patch.changes) {
      if (JSON.stringify(current.get(change.path) ?? null) !== JSON.stringify(change.after)) throw new WorkspacePatchError('PATCH_CONFLICT');
    }
  }
  async prepare(intent: IntegrationIntent, patch: WorkspacePatch): Promise<IntegrationManifest> {
    if ((await this.observe(patch)).digest !== intent.observation) throw new WorkspacePatchError('PATCH_CONFLICT');
    await this.directory(this.options.workspaceRoot);
    const parent = join(this.options.workspaceRoot, 'integrations');
    await mkdir(parent, { recursive: true, mode: 0o700 }); await this.directory(parent);
    // Exclusive directory is a second fence against unknown filesystem residue.
    await mkdir(this.location(intent.command), { mode: 0o700 });
    const lease = await this.broker(intent.command).allocate({ schemaVersion: 1, identity: intent.command.identity, baseCommit: patch.baseCommit });
    const { listing, algorithm } = await this.expected(intent.command, patch);
    const initial = await readWorkspace(lease.workspace, this.budget());
    if (diffAgainstBase(listing, initial, algorithm).length) throw new WorkspacePatchError('PATCH_CONFLICT');
    for (const change of patch.changes) {
      if (JSON.stringify(initial.get(change.path) ?? null) !== JSON.stringify(change.before)) throw new WorkspacePatchError('PATCH_CONFLICT');
    }
    // Expected content is the fresh base checkout plus the patch; the manifest digest never depends on Git blob reads.
    const snapshot: Snapshot = new Map(initial);
    for (const change of patch.changes) { if (change.after) snapshot.set(change.path, change.after); else snapshot.delete(change.path); }
    const root = await open(lease.workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const change of patch.changes) {
        const parts = change.path.split('/'); let parentHandle = root; const handles = [];
        try {
          for (const part of parts.slice(0, -1)) {
            const path = `/proc/self/fd/${parentHandle.fd}/${part}`;
            try { await mkdir(path, { mode: 0o700 }); } catch (error) {
              if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
            }
            parentHandle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(parentHandle);
          }
          const path = `/proc/self/fd/${parentHandle.fd}/${parts.at(-1)}`;
          if (change.before) await unlink(path);
          if (change.after) {
            const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try { await file.writeFile(change.after.text); await file.chmod(change.after.mode === '100755' ? 0o755 : 0o644); await file.sync(); }
            finally { await file.close(); }
          }
          await parentHandle.sync();
        } finally { for (const handle of handles.reverse()) await handle.close(); }
      }
    } finally { await root.close(); }
    return { schemaVersion: 1, kind: 'integration-candidate', command: intent.command, patch: intent.patch,
      observation: intent.observation, workspace: lease.workspace, snapshotDigest: snapshotDigest(snapshot), application: 'candidate-only' };
  }
  async verify(manifest: IntegrationManifest, patch: WorkspacePatch) {
    const { lease, listing, algorithm } = await this.expected(manifest.command, patch);
    if (lease.workspace !== manifest.workspace) throw new WorkspacePatchError('PATCH_CORRUPT');
    for (let pass = 0; pass < 2; pass++) {
      const current = await readWorkspace(lease.workspace, this.budget());
      this.assertCandidate(listing, algorithm, patch, current);
      if (snapshotDigest(current) !== manifest.snapshotDigest) throw new WorkspacePatchError('PATCH_CONFLICT');
    }
  }
}
