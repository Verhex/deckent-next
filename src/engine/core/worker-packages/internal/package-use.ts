import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NATIVE_NODE_DEPENDENCY_LAYOUT as layout, type NativeNodeDependencyReference } from '#domain/index.js';
import { type AuditApplication } from '#engine/core/audit/index.js';
import { packageConsentDigest, samePackagePerson } from '#engine/core/config/index.js';
import { authorizeWorkTargetUse } from '#engine/core/policy/index.js';
import { getConfigKnownSecrets, redactForRecord, type WorkerPackageAllowance } from '#platform/index.js';
import { activePackageRow, packageActivitySubject, packageAllowance, packagePartition, packagePublication, packageRefused, packageRetirement, packageRowDigest,
  readManagedPackageRows, recordPackageAuthority, retirePackageGeneration, verifyPackagePerson, withPackagePartition, withPackagePartitions } from './package-activity.js';
import { recheckPackageSecrets, scanPackageSecrets } from './package-secrets.js';
import type { PackageBinding, PackageContext, PackageKnownSecrets, PackageProfile, WorkerPackagePorts } from './ports.js';

const sameCustody = (before: PackageContext, after: PackageContext) =>
  isDeepStrictEqual(before.layout, after.layout) && isDeepStrictEqual(before.installationLayout, after.installationLayout)
  && samePackagePerson(before.principal, after.principal);

async function checkCurrentVersion<C extends PackageContext>(ports: WorkerPackagePorts<C>, context: C, audit: AuditApplication,
  scopeId: string, row: WorkerPackageAllowance, profile: PackageProfile, known?: PackageKnownSecrets) {
  const current = await ports.prepare(context, scopeId, undefined, known);
  if (await packagePartition(ports, context, scopeId, profile, { ...current, layout: layout.id }) !== row.partition) throw packageRefused();
  const { digest: listDigest } = await current.review(), { lockfileDigest } = current;
  await current.assertCurrent();
  if (row.listDigest !== listDigest || row.lockfileDigest !== lockfileDigest) {
    retirePackageGeneration(audit, context, scopeId, row, { listDigest, lockfileDigest });
    throw packageRefused();
  }
  return () => current.assertCurrent();
}

export async function pinPackageAllowance<C extends PackageContext>(ports: WorkerPackagePorts<C>, context: C, binding: PackageBinding): Promise<NativeNodeDependencyReference> {
  if (!context.config.toolchains.packageAllowances) return binding.reference;
  const rows = await readManagedPackageRows(ports, context);
  if (!rows.length) return binding.reference;
  const { reference, profile } = binding, scope = reference.approval.scopeId;
  const partition = await packagePartition(ports, context, scope, profile, reference);
  if (!rows.some(row => row.partition === partition)) return reference;
  return withPackagePartition(ports, context, partition, async audit => {
    const fresh = await ports.loadScope(scope, 'read');
    if (!sameCustody(context, fresh)) throw packageRefused();
    const row = activePackageRow(audit, scope, partition, await readManagedPackageRows(ports, fresh));
    if (!row) throw packageRefused();
    await checkCurrentVersion(ports, fresh, audit, scope, row, profile);
    if (row.listDigest !== reference.listDigest || row.lockfileDigest !== reference.lockfileDigest) throw packageRefused();
    return { ...reference, approval: { scopeId: scope, commandId: row.generation }, allowance: { partition, decisionId: row.decisionId, version: row.version } };
  });
}

export async function describePackageDecision<C extends PackageContext>(ports: WorkerPackagePorts<C>, context: C, reference: NativeNodeDependencyReference) {
  const row = packageAllowance(reference), { scopeId } = reference.approval;
  return ports.withAudit(context, async audit => {
    const historical = packagePublication(audit, scopeId, row.partition, row.generation);
    const subject = packageActivitySubject(historical, row.partition);
    if (subject?.action !== 'set' || subject.digest !== packageRowDigest(row)) throw packageRefused();
    const proof = await verifyPackagePerson(ports, context, scopeId, row);
    const retirement = packageRetirement(audit, scopeId, row);
    return { person: redactForRecord(proof.person, getConfigKnownSecrets(context.config)), decidedAt: proof.decidedAt,
      decisionId: proof.decisionId, version: proof.version, ...(retirement ? { retirement } : {}) };
  }, false, 'read');
}

/** Scans before entering the writer locks. Only a scan of the still-current authority can cross the effect boundary. */
export function withPackageUse<C extends PackageContext, T>(ports: WorkerPackagePorts<C>, context: C, bindings: readonly [PackageBinding, ...PackageBinding[]],
  action: 'admit' | 'open', useId: string, work: () => Promise<T>, prepare?: (fresh: C, binding: PackageBinding, known: PackageKnownSecrets) => Promise<void>): Promise<T> {
  const inputs = bindings.map(binding => ({ binding, row: packageAllowance(binding.reference) }));
  const { scopeId } = bindings[0].reference.approval;
  const load = () => ports.loadScope(scopeId, 'read');
  return withPackagePartitions(ports, context, inputs.map(({ row }) => row.partition), async audit => {
    const scanned = await load(), execution = scanned.config.execution;
    if (!execution || !sameCustody(context, scanned)) throw packageRefused();
    const target = await ports.resolveTarget(scanned), rows = await readManagedPackageRows(ports, scanned);
    await authorizeWorkTargetUse(ports.policySource(scanned, scanned.document), target.id, scopeId, scanned.principal);
    const { registered, known } = await scanPackageSecrets(ports.secrets, scanned.config);
    const checks: { row: WorkerPackageAllowance; assertCurrent: () => Promise<void>; verify: () => Promise<void> }[] = [];
    for (const { binding, row } of inputs) {
      const { reference, profile } = binding;
      if (reference.approval.scopeId !== scopeId || target.workTarget !== reference.workTarget
        || await packagePartition(ports, scanned, scopeId, profile, reference) !== row.partition
        || !isDeepStrictEqual(activePackageRow(audit, scopeId, row.partition, rows), row)) throw packageRefused();
      await verifyPackagePerson(ports, scanned, scopeId, row);
      const assertCurrent = await checkCurrentVersion(ports, scanned, audit, scopeId, row, profile, known);
      await prepare?.(scanned, binding, known);
      const verify = await ports.verifyObject(scanned, reference, known);
      checks.push({ row, assertCurrent, verify });
    }
    // Custody precedes policy in the existing custody → config → policy chain, and this path never takes the config writer lock.
    return ports.secrets.exclusive(selected => ports.lockPolicy(scanned, async () => {
      const fresh = await load();
      if (!sameCustody(scanned, fresh) || !isDeepStrictEqual(scanned.config, fresh.config) || !isDeepStrictEqual(scanned.document, fresh.document)) throw packageRefused();
      await recheckPackageSecrets(ports.secrets, fresh.config, selected, registered);
      for (const { assertCurrent, verify } of checks) {
        await assertCurrent();
        await verify();
      }
      for (const { row } of checks) recordPackageAuthority(audit, fresh, scopeId, row.partition, useId, randomUUID(),
        action === 'admit' ? 'package-admit' : 'package-open', packageRowDigest(row), packageConsentDigest('worker-package-use:1', { action, useId }));
      return work();
    }));
  });
}
