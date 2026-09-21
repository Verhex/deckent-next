import { sameAttemptIdentity } from '#domain/index.js';
import { patchExclusions, workspacePatchSchema, WorkspacePatchError, type DispatchRecord, type PatchLimits, type WorkspacePatchSource, type RunWorkspaceCustodyStore } from '#engine/index.js';
import { GitWorkspaceBroker, type GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { DockerSupervisor } from '#adapters/core/docker-supervisor/index.js';
import { readBase, readWorkspace, snapshotDigest, SnapshotBudget } from './snapshot.js';
/** Trusted composition only: exact ledger record, no caller-provided paths, shell commands or Git config. */
export class GitWorkspacePatchSource implements WorkspacePatchSource {
  constructor(private readonly options: GitWorkspaceOptions, private readonly limits: PatchLimits,
    private readonly custody: Pick<RunWorkspaceCustodyStore, 'loadRunWorkspaceCustody'>) {}
  async capture(record: DispatchRecord) {
    try {
      if (!record.terminal) throw new WorkspacePatchError('PATCH_UNAVAILABLE');
      const broker = new GitWorkspaceBroker(this.options);
      const lease = await broker.openRecorded(record.request.identity);
      const custody = await this.custody.loadRunWorkspaceCustody(record.request.identity.scopeId, record.request.identity.runId);
      if (!lease || !custody || !sameAttemptIdentity(lease.identity, record.request.identity)
        || lease.workspace !== record.request.workspace || custody.baseRevision !== lease.baseCommit
        || custody.source.sourceFingerprint !== lease.sourceBase.sourceFingerprint
        || custody.source.adapter.id !== 'git' || custody.source.adapter.version !== 1) throw new WorkspacePatchError('PATCH_CONFLICT');
      await broker.assertSourceBase(lease.sourceBase);
      const supervisor = await DockerSupervisor.restoreProfile(record.profile);
      const stopped = async () => {
        const observed = await supervisor.observe(record.request);
        if (observed.handle !== record.terminal!.handle || observed.result.kind !== 'exited'
          || observed.result.exitCode !== record.terminal!.exitCode) throw new WorkspacePatchError('PATCH_UNAVAILABLE');
      };
      await stopped();
      const deadline = Date.now() + this.options.timeoutMs;
      const base = await readBase(lease, this.options, new SnapshotBudget(this.limits, deadline));
      const after = await readWorkspace(lease.workspace, new SnapshotBudget(this.limits, deadline));
      const again = await readWorkspace(lease.workspace, new SnapshotBudget(this.limits, deadline));
      if (snapshotDigest(after) !== snapshotDigest(again)) throw new WorkspacePatchError('PATCH_CONFLICT');
      await stopped();
      const changes = [...new Set([...base.keys(), ...after.keys()])].sort().flatMap(path => {
        const before = base.get(path) ?? null; const next = after.get(path) ?? null;
        return JSON.stringify(before) === JSON.stringify(next) ? [] : [{ path, before, after: next }];
      });
      return workspacePatchSchema.parse({ schemaVersion: 1, kind: 'workspace-patch', identity: lease.identity,
        source: custody.source, baseCommit: lease.baseCommit, snapshotDigest: snapshotDigest(after), exclusions: patchExclusions, changes });
    } catch (error) {
      if (error instanceof WorkspacePatchError) throw error;
      throw new WorkspacePatchError('PATCH_UNSAFE');
    }
  }
}
