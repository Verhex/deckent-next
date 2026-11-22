import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { createInstallationSecretCustody, nativeCodingDependencyLayout, openConfiguredSecretStore, reopenWorkerTree, resolveGitWorkTarget,
  sealedWorkerTreeLocation, verifySealedWorkerTree } from '#adapters/index.js';
import type { NativeNodeDependencyReference } from '#domain/index.js';
import { authorizeWorkTargetUse, ENV_SECRET_STORE_ID, packageConsentDigest, samePackagePerson, type AuditApplication } from '#engine/index.js';
import { combineKnownSecrets, getConfigKnownSecrets, knownSecretValues, productResourcePath, redactForRecord,
  type ConfigLoadOptions, type WorkerPackageAllowance } from '#platform/index.js';
import { contextPolicySource, withLayoutPolicyWriteLock } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext, withScopeAudit } from '#composition/core/scoped-request/index.js';
import { activePackageRow, packageActivitySubject, packageAllowance, packagePartition, packagePublication, packageRefused, packageRetirement, packageRowDigest,
  readManagedPackageRows, recordPackageAuthority, retirePackageGeneration, verifyPackagePerson, withPackagePartition, withPackagePartitions,
  type PackageContext, type PackageProfile } from './package-activity.js';
import { configuredPreparedInput } from './prepared-input.js';

type Reference = NativeNodeDependencyReference;
type Binding = Readonly<{ reference: Reference; profile: PackageProfile }>;
const sameCustody = (before: PackageContext, after: PackageContext) =>
  isDeepStrictEqual(before.layout, after.layout) && isDeepStrictEqual(before.installationLayout, after.installationLayout)
  && samePackagePerson(before.principal, after.principal);

async function checkCurrentVersion(root: string, context: PackageContext, options: ConfigLoadOptions, audit: AuditApplication,
  scopeId: string, row: WorkerPackageAllowance, profile: PackageProfile) {
  const layout = nativeCodingDependencyLayout();
  const current = await configuredPreparedInput(root, context, scopeId, layout, undefined, options);
  if (await packagePartition(context, scopeId, profile, { ...current, layout: layout.id }) !== row.partition) throw packageRefused();
  const { digest: listDigest } = await current.review(), { lockfileDigest } = current;
  await current.assertCurrent();
  if (row.listDigest !== listDigest || row.lockfileDigest !== lockfileDigest) {
    retirePackageGeneration(audit, context, scopeId, row, { listDigest, lockfileDigest });
    throw packageRefused();
  }
  return () => current.assertCurrent();
}

export async function pinPackageAllowance(root: string, context: PackageContext, options: ConfigLoadOptions, binding: Binding): Promise<Reference> {
  if (!context.config.toolchains.packageAllowances) return binding.reference;
  const rows = await readManagedPackageRows(root, context, options);
  if (!rows.length) return binding.reference;
  const { reference, profile } = binding, scope = reference.approval.scopeId;
  const partition = await packagePartition(context, scope, profile, reference);
  if (!rows.some(row => row.partition === partition)) return reference;
  return withPackagePartition(context, partition, async audit => {
    const fresh = await loadConfiguredScopeContext(root, scope, { ...options, heal: false, force: true }, 'read');
    if (!sameCustody(context, fresh)) throw packageRefused();
    const row = activePackageRow(audit, scope, partition, await readManagedPackageRows(root, fresh, options));
    if (!row) throw packageRefused();
    await checkCurrentVersion(root, fresh, options, audit, scope, row, profile);
    if (row.listDigest !== reference.listDigest || row.lockfileDigest !== reference.lockfileDigest) throw packageRefused();
    return { ...reference, approval: { scopeId: scope, commandId: row.generation }, allowance: { partition, decisionId: row.decisionId, version: row.version } };
  });
}

export async function verifyPackageObject(context: PackageContext, reference: Reference, known = getConfigKnownSecrets(context.config)) {
  if (!context.config.execution) throw packageRefused();
  const limits = context.config.execution.secretGate, object = sealedWorkerTreeLocation(productResourcePath(context.installationLayout, 'artifacts'), reference);
  const { source } = await reopenWorkerTree(object, nativeCodingDependencyLayout().mount, reference.listDigest, limits, known);
  const identity = await lstat(source, { bigint: true });
  return async () => {
    const checked = await verifySealedWorkerTree(object, reference.listDigest, limits);
    const fresh = await lstat(checked.source, { bigint: true });
    if (checked.source !== source || fresh.dev !== identity.dev || fresh.ino !== identity.ino || fresh.ctimeNs !== identity.ctimeNs) throw packageRefused();
  };
}

export async function describePackageDecision(context: PackageContext, reference: Reference) {
  const row = packageAllowance(reference), { scopeId } = reference.approval;
  return withScopeAudit(context, async audit => {
    const historical = packagePublication(audit, scopeId, row.partition, row.generation);
    const subject = packageActivitySubject(historical, row.partition);
    if (subject?.action !== 'set' || subject.digest !== packageRowDigest(row)) throw packageRefused();
    const proof = await verifyPackagePerson(context, scopeId, row);
    const retirement = packageRetirement(audit, scopeId, row);
    return { person: redactForRecord(proof.person, getConfigKnownSecrets(context.config)), decidedAt: proof.decidedAt,
      decisionId: proof.decisionId, version: proof.version, ...(retirement ? { retirement } : {}) };
  }, false, 'read');
}

async function registeredSecretValues(context: PackageContext, env: NonNullable<ConfigLoadOptions['env']>, platform: string, selected?: string) {
  const store = openConfiguredSecretStore(context.config, env, platform), backend = store.descriptor.id, values: string[] = [];
  if (selected !== undefined && selected !== backend) throw packageRefused();
  if (backend !== ENV_SECRET_STORE_ID) {
    for (const name of await store.listNames()) {
      const value = await store.get(name);
      if (value === undefined) throw packageRefused();
      values.push(value);
    }
  }
  return { backend, values: [...new Set(values)].sort() };
}

const packageSecrets = (context: PackageContext, values: readonly string[]) =>
  combineKnownSecrets(getConfigKnownSecrets(context.config), knownSecretValues(values));

export async function packageReviewSecrets(context: PackageContext, options: ConfigLoadOptions) {
  const { values } = await registeredSecretValues(context, options.env ?? process.env, options.platform ?? process.platform);
  return packageSecrets(context, values);
}

/** Scans before entering the writer locks. Only a scan of the still-current authority can cross the effect boundary. */
export function withPackageUse<T>(root: string, context: PackageContext, options: ConfigLoadOptions, bindings: readonly [Binding, ...Binding[]],
  action: 'admit' | 'open', useId: string, work: () => Promise<T>, prepare?: (fresh: PackageContext, binding: Binding) => Promise<void>): Promise<T> {
  const inputs = bindings.map(binding => ({ binding, row: packageAllowance(binding.reference) }));
  const { scopeId } = bindings[0].reference.approval, env = options.env ?? process.env, platform = options.platform ?? process.platform;
  const load = () => loadConfiguredScopeContext(root, scopeId, { ...options, heal: false, force: true }, 'read');
  return withPackagePartitions(context, inputs.map(({ row }) => row.partition), async audit => {
    const scanned = await load(), execution = scanned.config.execution;
    if (!execution || !sameCustody(context, scanned)) throw packageRefused();
    const target = await resolveGitWorkTarget(root, execution, scanned.layout), rows = await readManagedPackageRows(root, scanned, options);
    await authorizeWorkTargetUse(contextPolicySource(scanned, scanned.document), target.id, scopeId, scanned.principal);
    const secrets = await registeredSecretValues(scanned, env, platform);
    const known = packageSecrets(scanned, secrets.values);
    const checks: { row: WorkerPackageAllowance; assertCurrent: () => Promise<void>; verify: () => Promise<void> }[] = [];
    for (const { binding, row } of inputs) {
      const { reference, profile } = binding;
      if (reference.approval.scopeId !== scopeId || target.git.sourceRoot !== reference.workTarget
        || await packagePartition(scanned, scopeId, profile, reference) !== row.partition
        || !isDeepStrictEqual(activePackageRow(audit, scopeId, row.partition, rows), row)) throw packageRefused();
      await verifyPackagePerson(scanned, scopeId, row);
      const assertCurrent = await checkCurrentVersion(root, scanned, options, audit, scopeId, row, profile);
      await prepare?.(scanned, binding);
      const verify = await verifyPackageObject(scanned, reference, known);
      checks.push({ row, assertCurrent, verify });
    }
    const custody = createInstallationSecretCustody(env, platform);
    // Custody precedes policy in the existing custody → config → policy chain, and this path never takes the config writer lock.
    return custody.exclusive(() => withLayoutPolicyWriteLock(scanned.layout, async () => {
      const fresh = await load();
      if (!sameCustody(scanned, fresh) || !isDeepStrictEqual(scanned.config, fresh.config) || !isDeepStrictEqual(scanned.document, fresh.document)
        || !isDeepStrictEqual(secrets, await registeredSecretValues(fresh, env, platform, await custody.selected()))) throw packageRefused();
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
