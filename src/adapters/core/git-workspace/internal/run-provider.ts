import type { AttemptIdentity } from '#domain/index.js';
import { RunWorkspaceCustodyError, type RunWorkspaceCustody, type RunWorkspaceProvider, type WorkspaceSource } from '#engine/index.js';
import { GitWorkspaceBroker } from './broker.js';
import type { GitSourceBase } from './source-base.js';

function source(value: GitSourceBase): WorkspaceSource {
  return Object.freeze({ schemaVersion: 1, adapter: value.adapter, sourceFingerprint: value.sourceFingerprint });
}
export class GitRunWorkspaceProvider implements RunWorkspaceProvider {
  constructor(private readonly broker: GitWorkspaceBroker) {}
  async openRecorded(identity: AttemptIdentity) {
    const lease = await this.broker.openRecorded(identity); return lease ? Object.freeze({ lease, source: source(lease.sourceBase) }) : null;
  }
  async captureSource(baseRevision?: string) {
    const captured = await this.broker.captureSourceBase(baseRevision);
    return Object.freeze({ source: source(captured), baseRevision: captured.baseCommit });
  }
  async allocate(identity: AttemptIdentity, custody: RunWorkspaceCustody) {
    const captured = await this.broker.captureSourceBase(custody.baseRevision);
    if (JSON.stringify(source(captured)) !== JSON.stringify(custody.source)) throw new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CONFLICT');
    return this.broker.allocate({ schemaVersion: 1, identity, baseCommit: custody.baseRevision });
  }
}
