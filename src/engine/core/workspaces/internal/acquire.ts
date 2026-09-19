import { attemptIdentitySchema, sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';
import { workspaceCustodyConflict, RunWorkspaceCustodyError, type RunWorkspaceCustody, type RunWorkspaceCustodyStore, type WorkspaceSource } from './run-custody.js';
import type { WorkspaceLease } from './port.js';

export interface RunWorkspaceProvider {
  openRecorded(identity: AttemptIdentity): Promise<Readonly<{ lease: WorkspaceLease; source: WorkspaceSource }> | null>;
  captureSource(baseRevision?: string): Promise<Readonly<{ source: WorkspaceSource; baseRevision: string }>>;
  allocate(identity: AttemptIdentity, custody: RunWorkspaceCustody): Promise<WorkspaceLease>;
}
function exact(custody: RunWorkspaceCustody, source: WorkspaceSource, baseRevision: string) {
  return JSON.stringify(custody.source) === JSON.stringify(source) && custody.baseRevision === baseRevision;
}
export class RunWorkspaceAcquisitionApplication {
  constructor(private readonly store: RunWorkspaceCustodyStore, private readonly provider: RunWorkspaceProvider) {}
  async acquire(input: unknown): Promise<WorkspaceLease> {
    const identity = attemptIdentitySchema.parse(input);
    // Read durable Run custody before any operation that may sample a mutable source HEAD.
    let custody = await this.store.loadRunWorkspaceCustody(identity.scopeId, identity.runId);
    const recorded = await this.provider.openRecorded(identity);
    if (recorded) {
      const candidate = { schemaVersion: 1 as const, scopeId: identity.scopeId, runId: identity.runId,
        source: recorded.source, baseRevision: recorded.lease.baseCommit };
      custody ??= await this.store.resolveRunWorkspaceCustody(candidate);
      if (!exact(custody, recorded.source, recorded.lease.baseCommit)) throw workspaceCustodyConflict(custody.source, recorded.source);
      this.verify(recorded.lease, identity, custody); return recorded.lease;
    }
    if (custody) {
      const captured = await this.provider.captureSource(custody.baseRevision);
      if (!exact(custody, captured.source, captured.baseRevision)) throw workspaceCustodyConflict(custody.source, captured.source);
    } else {
      const captured = await this.provider.captureSource();
      custody = await this.store.resolveRunWorkspaceCustody({ schemaVersion: 1, scopeId: identity.scopeId, runId: identity.runId,
        source: captured.source, baseRevision: captured.baseRevision });
      if (!exact(custody, captured.source, captured.baseRevision)) {
        const winner = await this.provider.captureSource(custody.baseRevision);
        if (!exact(custody, winner.source, winner.baseRevision)) throw workspaceCustodyConflict(custody.source, winner.source);
      }
    }
    const lease = await this.provider.allocate(identity, custody); this.verify(lease, identity, custody); return lease;
  }
  private verify(lease: WorkspaceLease, identity: AttemptIdentity, custody: RunWorkspaceCustody) {
    if (!sameAttemptIdentity(lease.identity, identity) || lease.baseCommit !== custody.baseRevision) {
      throw new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CORRUPT');
    }
  }
}
