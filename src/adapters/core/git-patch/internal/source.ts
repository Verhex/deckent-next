import { sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';
import { capturedWorkspacePatch, WorkspacePatchError, type DispatchRecord, type PatchLimits, type WorkspacePatchSource, type RunWorkspaceCustodyStore } from '#engine/index.js';
import { GitWorkspaceBroker, type GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { DockerSupervisor } from '#adapters/core/docker-supervisor/index.js';
import { completeHiddenBase, diffAgainstBase, hashAlgorithmOf, listBase, readBaseBlobs, readWorkspace, snapshotDigest, SnapshotBudget } from './snapshot.js';
/** Trusted composition only: exact ledger record, no caller-provided paths, shell commands or Git config. */
export class GitWorkspacePatchSource implements WorkspacePatchSource {
  /** `hiddenPaths` (C2): the attempt's ledger-pinned checkout shaping (composition reads it from the Run's frozen task profile). */
  constructor(private readonly options: GitWorkspaceOptions, private readonly limits: PatchLimits,
    private readonly custody: Pick<RunWorkspaceCustodyStore, 'loadRunWorkspaceCustody'>,
    private readonly hiddenPaths?: (identity: AttemptIdentity) => Promise<readonly string[] | null>) {}
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
      // The base is listed once (ids only); only paths whose content, mode or presence differs are read from Git.
      const listing = await listBase(lease, this.options, new SnapshotBudget(this.limits, deadline));
      const algorithm = hashAlgorithmOf(lease.baseCommit);
      const read = await readWorkspace(lease.workspace, new SnapshotBudget(this.limits, deadline), { listing, algorithm });
      const again = await readWorkspace(lease.workspace, new SnapshotBudget(this.limits, deadline), { listing, algorithm });
      if (snapshotDigest(read) !== snapshotDigest(again)) throw new WorkspacePatchError('PATCH_CONFLICT');
      await stopped();
      const after = await completeHiddenBase(lease, this.options, new SnapshotBudget(this.limits, deadline), { listing, algorithm },
        await this.hiddenPaths?.(record.request.identity), read);
      const changedPaths = diffAgainstBase(listing, after, algorithm);
      const base = await readBaseBlobs(lease, this.options, new SnapshotBudget(this.limits, deadline),
        changedPaths.flatMap(path => { const entry = listing.get(path); return entry ? [[path, entry] as const] : []; }));
      return capturedWorkspacePatch(lease.identity, custody.source, lease.baseCommit, changedPaths, base, after);
    } catch (error) {
      if (error instanceof WorkspacePatchError) throw error;
      throw new WorkspacePatchError('PATCH_UNSAFE');
    }
  }
  /** EXEC-RELEASE: the clone directory or the labelled container is gone; daemon or lease errors are not proof of release. */
  async released(record: DispatchRecord) {
    if (!(await new GitWorkspaceBroker(this.options).holds(record.request.identity))) return true;
    return (await (await DockerSupervisor.restoreProfile(record.profile)).inspectActivity(record.request)).state === 'missing';
  }
}
