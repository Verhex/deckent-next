import type { AuditRecord, NativeNodeDependencyReference } from '#domain/index.js';
import { ErrorRegistry, WORKER_PACKAGE_ALLOWANCE_KEY, WORKER_PACKAGE_CONSENT, workerPackageAllowancesSchema, type WorkerPackageAllowance } from '#platform/index.js';
import { admitDecided, approvalRequestDigest, configChangeApprovalActionDigest, verifyApproval } from '#engine/core/approval/index.js';
import { AUDIT_PAGE_MAX, type AuditApplication } from '#engine/core/audit/index.js';
import { packageConsentDigest as packageDigest, samePackagePerson } from '#engine/core/config/index.js';
import type { PackageContext, PackageProfile, WorkerPackagePorts } from './ports.js';

export type PackageInput = Pick<NativeNodeDependencyReference, 'layout' | 'platform' | 'project' | 'workTarget'>;
export const packageRefused = () => ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED');
export async function packagePartition<C extends PackageContext>(ports: WorkerPackagePorts<C>, context: C, scope: string, profile: PackageProfile, input: PackageInput) {
  const { installationId, projectId, config } = context;
  if (!installationId || !projectId) throw packageRefused();
  const target = await ports.targetIdentity(input.workTarget);
  if (!target.isDirectory) throw packageRefused();
  return packageDigest('worker-package-partition:1', { installationId, companyId: config.company.id, scope, projectId, project: input.project,
    workTarget: { path: input.workTarget, id: ports.selectedTarget(context), device: target.device, inode: target.inode },
    platform: input.platform, layout: input.layout, profile: { id: profile.id, version: profile.version } });
}

export function packageAllowance(reference: NativeNodeDependencyReference): WorkerPackageAllowance {
  if (!reference.allowance) throw packageRefused();
  return { operation: WORKER_PACKAGE_CONSENT, ...reference.allowance, generation: reference.approval.commandId,
    listDigest: reference.listDigest, lockfileDigest: reference.lockfileDigest };
}

export function packageBasis(row: Omit<WorkerPackageAllowance, 'decisionId'>) {
  const { operation, partition, generation, version, listDigest, lockfileDigest } = row;
  return packageDigest('worker-package-consent:1', { operation, partition, generation, version, listDigest, lockfileDigest,
    use: 'until-withdrawal-or-version-change' });
}

export function managedPackageRows(document: Record<string, unknown>) {
  const tools = document['toolchains'] as { packageAllowances?: unknown } | undefined;
  return workerPackageAllowancesSchema.parse(tools?.packageAllowances ?? []);
}

export async function readManagedPackageRows<C extends PackageContext>(ports: WorkerPackagePorts<C>, context: C) {
  const snapshot = await ports.snapshotConfig();
  const rows = managedPackageRows(snapshot.document);
  if (rows.length && !await ports.rowsArePrivate(context)) throw packageRefused();
  return rows;
}

export const packageIntentId = (partition: string, commandId: string) => packageDigest('worker-package-intent:1', { partition, commandId });
const activityId = (partition: string, commandId: string) => packageDigest('worker-package-publication:1', { partition, commandId });
export function packageActivitySubject(record: AuditRecord | null, partition: string) {
  const subject = record?.event.subject;
  if (subject?.kind !== 'authority-decision' || subject.resource.kind !== 'config' || subject.resource.id !== partition) return null;
  if (subject.action === 'package-grant') return { action: 'set' as const, digest: subject.inputDigest, commandId: subject.envelope.commandId };
  if (subject.action === 'package-withdraw') return { action: 'unset' as const, digest: subject.inputDigest, commandId: subject.envelope.commandId };
  if (subject.action === 'package-retire') return { action: 'retire' as const, digest: subject.inputDigest, commandId: subject.envelope.commandId };
  return null;
}
export function packageActivity(audit: AuditApplication, scopeId: string, partition: string, through?: number) {
  let after = 0, latest: AuditRecord | null = null, grant: string | null = null, version = 0;
  const result = () => ({ latest, grant, subject: packageActivitySubject(latest, partition), version });
  for (;;) {
    const page = audit.listKind(scopeId, 'authority-decision', after, AUDIT_PAGE_MAX);
    for (const record of page) {
      if (through !== undefined && record.sequence > through) return result();
      const subject = packageActivitySubject(record, partition);
      if (!subject) continue;
      latest = record;
      if (subject.action === 'set') { version++; grant = subject.commandId; }
    }
    if (page.length < AUDIT_PAGE_MAX) return result();
    after = page.at(-1)!.sequence;
  }
}
export function packagePublication(audit: AuditApplication, scopeId: string, partition: string, commandId: string) {
  const record = audit.load(scopeId, activityId(partition, commandId));
  if (record && !packageActivitySubject(record, partition)) throw packageRefused();
  return record;
}
export const packageRowDigest = (row: WorkerPackageAllowance) => packageDigest('worker-package-project-row:1', row);
const retirementId = (row: WorkerPackageAllowance) => packageDigest('worker-package-retirement:1', { partition: row.partition, generation: row.generation });
export function packageRetirement(audit: AuditApplication, scopeId: string, row: WorkerPackageAllowance) {
  const record = audit.load(scopeId, retirementId(row));
  if (!record) return null;
  const subject = packageActivitySubject(record, row.partition);
  if (subject?.action !== 'retire' || subject.digest !== packageRowDigest(row)) throw packageRefused();
  return { reason: 'version-changed' as const, at: record.event.atMs };
}
export function retirePackageGeneration(audit: AuditApplication, context: PackageContext, scopeId: string, row: WorkerPackageAllowance,
  current: Pick<WorkerPackageAllowance, 'listDigest' | 'lockfileDigest'>) {
  const id = retirementId(row);
  recordPackageAuthority(audit, context, scopeId, row.partition, id, id, 'package-retire',
    packageRowDigest(row), packageDigest('worker-package-current-version:1', current));
}
export function recordPackageAuthority(audit: AuditApplication, context: PackageContext, scopeId: string, partition: string, commandId: string,
  eventId: string, action: 'package-grant' | 'package-withdraw' | 'package-retire' | 'package-admit' | 'package-open', inputDigest: string, basisDigest: string | null) {
  const { id, issuer, subject } = context.principal, revision = context.document.revision;
  return audit.record({ schemaVersion: 1, eventId, scopeId, principal: { issuer, subject }, policyRevision: revision, atMs: Date.now(),
    subject: { kind: 'authority-decision', schemaVersion: 1, envelope: { schemaVersion: 1, commandId, scopeId, principalRef: { id, issuer, subject },
      idempotencyKeyHash: packageDigest('worker-package-command-key:1', commandId) }, action, resource: { kind: 'config', id: partition },
      inputDigest, basisDigest, policyDigest: packageDigest('policy:1', context.document), verdict: { decision: 'allow', revision, reason: 'GRANTED' } } });
}
export function recordPackagePublication(audit: AuditApplication, context: PackageContext, scopeId: string, partition: string, commandId: string,
  row: WorkerPackageAllowance, action: 'grant' | 'withdraw') {
  return recordPackageAuthority(audit, context, scopeId, partition, commandId, activityId(partition, commandId),
    action === 'grant' ? 'package-grant' : 'package-withdraw', packageRowDigest(row), null);
}

export function activePackageRow(audit: AuditApplication, scopeId: string, partition: string, rows: readonly WorkerPackageAllowance[]) {
  const { subject, version } = packageActivity(audit, scopeId, partition);
  const row = rows.find(value => value.partition === partition);
  if (subject?.action === 'set' && row?.version === version && subject.digest === packageRowDigest(row)) return row;
  if (row || subject?.action === 'set') throw packageRefused();
  return null;
}

export function verifyPackagePerson<C extends PackageContext>(ports: WorkerPackagePorts<C>, context: C, scopeId: string, row: WorkerPackageAllowance, publishing = false) {
  return ports.withApprovals(context, false, (store, integrity) => {
    const record = verifyApproval(store.load(scopeId, row.decisionId), integrity), { request } = record;
    const subject = request.schemaVersion === 3 ? request.subject : null;
    const refusal = (verification: string) => ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED', { params: { verification } });
    if (request.scopeId !== scopeId || request.approvalId !== row.decisionId || request.schemaVersion !== 3
      || request.facts.risk?.source !== 'effect-class' || !request.facts.risk.authority) throw refusal('sealed-person-request');
    if (subject?.kind !== 'config-change' || subject.keyPath !== WORKER_PACKAGE_ALLOWANCE_KEY || subject.layer !== 'project'
      || subject.action !== 'set' || subject.commandId !== row.generation) throw refusal('allowance-subject');
    if (subject.valueDigest !== packageBasis(row)) throw refusal('package-basis');
    if (request.actionDigest !== configChangeApprovalActionDigest(scopeId, subject, request.requester)) throw refusal('configuration-action');
    if (publishing && request.policyRevision !== context.document.revision) throw refusal('policy-revision');
    if (publishing && !samePackagePerson(context.principal, request.requester)) throw refusal('current-requester');
    const answered = record.decision;
    const decision = admitDecided(record, publishing ? { now: Date.now(), window: context.config.approvals.requestTtlMs } : null,
      answered !== null && 'deciderClass' in answered && answered.deciderClass === 'human-tty'
      && answered.assurance !== 'ai-policy' && samePackagePerson(answered.actor, request.requester)
      && answered.channel === 'local-terminal-card' && answered.reason === subject.valueDigest);
    if (decision.requestDigest !== approvalRequestDigest(request)) throw packageRefused();
    return { actor: decision.actor, person: decision.actor.id, decidedAt: decision.decidedAt, decisionId: row.decisionId, version: row.version, expectDigest: subject.expectDigest };
  });
}

export function withPackagePartition<C extends PackageContext, T>(ports: WorkerPackagePorts<C>, context: C, partition: string, work: (audit: AuditApplication) => Promise<T>) {
  return withPackagePartitions(ports, context, [partition], work);
}
export function withPackagePartitions<C extends PackageContext, T>(ports: WorkerPackagePorts<C>, context: C, partitions: readonly string[], work: (audit: AuditApplication) => Promise<T>) {
  let held = () => ports.withAudit(context, work);
  for (const partition of [...new Set(partitions)].sort().reverse()) {
    const inner = held;
    held = () => ports.lockPartition(context, partition, inner);
  }
  return held();
}
