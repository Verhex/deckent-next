import { createHash } from 'node:crypto';
import { TargetQueueError, sameAttemptIdentity, type AttemptIdentity, type TargetBinding, type TargetQueueRequest, type VerifiedPrincipal, type RunSnapshot } from '#domain/index.js';
import { AuditApplication } from '#engine/core/audit/index.js';
import { TargetQueueApplication, type TargetQueueStore, type TargetQueueBounds, type TargetQueueAudit } from '#engine/core/effect/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createWorkspaceQueueAdmission(queue: TargetQueueStore, authorization: DispatchIdentityAuthorization, principal: VerifiedPrincipal,
  policyRevision: string, bounds: TargetQueueBounds, integrity: ConstructorParameters<typeof AuditApplication>[1] | null,
  ports: { binding(ref: string): Promise<TargetBinding>; read(identity: AttemptIdentity): Promise<{ run: RunSnapshot | null; outputDigest: string | null }>; now(): number }) {
  const validate = async (request: TargetQueueRequest) => {
    const binding = await ports.binding(request.target.target.id);
    if (JSON.stringify(binding) !== JSON.stringify(request.target) || policyRevision !== request.policyRevision) throw new TargetQueueError('QUEUE_CONFLICT');
    const { run, outputDigest } = await ports.read(request.identity), task = run?.progress.find(row => row.taskId === request.identity.taskId);
    if (!run || run.revision < request.acceptedRevision || task?.phase !== 'accepted'
      || !run.bindings.some(row => sameAttemptIdentity(row.identity, request.identity)) || outputDigest !== request.outputDigest) throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
  };
  const audit: TargetQueueAudit = (store, record) => {
    if (!integrity) throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
    new AuditApplication(store, integrity).record({ schemaVersion: 1, eventId: `queue-${digest([record.request.identity.scopeId, record.request.commandId, record.revision])}`,
      scopeId: record.request.identity.scopeId, principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision, atMs: ports.now(),
      subject: { kind: 'target-queue', commandId: record.request.commandId, targetKey: record.key, ordinal: record.ordinal,
        revision: record.revision, state: record.state, payloadDigest: record.request.payloadDigest, recordDigest: digest(record) } });
  };
  const accepted = async (identity: AttemptIdentity) => {
    const { run, outputDigest } = await ports.read(identity);
    if (!run || !outputDigest) throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
    return { acceptedRevision: run.revision, outputDigest };
  };
  return { accepted, validate, app: new TargetQueueApplication(queue, { authorize: (request, actor, action) => authorization.authorizeIdentity(action === 'inspect' ? 'read-output' : 'prepare-integration', request.identity, actor), validate }, bounds, audit) };
}
