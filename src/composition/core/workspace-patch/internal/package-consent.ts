import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { clientCommandIdSchema, executionRegistrySchema, NATIVE_CODING_TEMPLATE_ADAPTER_ID } from '#domain/index.js';
import { createConfigFileDocuments, nativeCodingDependencyLayout, openLocalIntegrityAuthority, openSqliteApprovalStore, resolveGitWorkTarget, selectWorkTarget } from '#adapters/index.js';
import { authorizeWorkTargetUse, ConfigChangeApprovalBroker, evaluateConfigWrite, isConfigConsentPerson, isPackageScopeAdministrator, planConfigChange, samePackagePerson, validateConfigLayers,
  type AuditApplication, type ConfigChangeSubject, type ConfigDocumentPort, type ConfigWriteInput } from '#engine/index.js';
import { digestText, ErrorRegistry, redactForRecord, serializeJsonDocument, SystemTrustedClock, t, terminalSafeText, type ConfigLoadOptions, type Locale, WORKER_PACKAGE_ALLOWANCE_KEY as keyPath, WORKER_PACKAGE_CONSENT, workerPackageAllowancesSchema, type WorkerPackageAllowance } from '#platform/index.js';
import { configPersonWitness, snapshotConfiguredConfig } from '#composition/core/config/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { configuredPreparedInput } from './prepared-input.js';
import { packageReviewSecrets, verifyPackageObject } from './package-use.js';
import { managedPackageRows, packageActivity, packageActivitySubject, packageBasis, packageIntentId, packagePartition, packagePublication, packageRefused,
  packageRowDigest, recordPackagePublication, verifyPackagePerson, withPackagePartition, type PackageContext } from './package-activity.js';

export type PackageConsentRequest = Readonly<{ scopeId: string; kind: string; action: 'grant' | 'withdraw'; locale: Locale; commandId?: string }>;
export type PackageConsentCard = Readonly<{ title: string; lines: readonly string[]; action: PackageConsentRequest['action'] }>;
function profileFor(context: PackageContext, kind: string) {
  const registry = executionRegistrySchema.parse(context.config.admission?.registry);
  const selected = registry.kinds.find(entry => entry.kind === kind)?.profile;
  const profile = registry.profiles.find(row => row.id === selected?.id && row.version === selected.version);
  if (!profile || profile.adapter.id !== NATIVE_CODING_TEMPLATE_ADAPTER_ID
    || profile.parameters['dependencyLayout'] !== nativeCodingDependencyLayout().id) throw packageRefused();
  return profile;
}
const resolveContext = (root: string, scopeId: string, options: ConfigLoadOptions) =>
  loadConfiguredScopeContext(root, scopeId, { ...options, heal: false, force: true }, 'write');
const person = async (context: PackageContext) => {
  if (!isConfigConsentPerson(context.principal)) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: WORKER_PACKAGE_CONSENT } });
  await configPersonWitness()(WORKER_PACKAGE_CONSENT);
};

function publishPackageRows(documents: ConfigDocumentPort, input: ConfigWriteInput & { layer: 'project' },
  current: PackageContext, audit: AuditApplication, partition: string, expectedDigest: string | null,
  rows: readonly WorkerPackageAllowance[], approvalId?: string) {
  const { scopeId, commandId, layer } = input, unset = rows.length === 0;
  return documents.publish(input, async previous => {
    if (previous.digest !== expectedDigest) throw packageRefused();
    const document = planConfigChange(previous.document, keyPath, rows, unset);
    validateConfigLayers(previous, document);
    const eventId = packageIntentId(partition, commandId);
    const subject = { kind: 'config-change' as const, action: unset ? 'unset' as const : 'set' as const, layer, keyPath,
      commandId, beforeDigest: previous.digest, afterDigest: digestText(serializeJsonDocument(document)), ...(approvalId ? { approvalId } : {}) };
    const prior = audit.load(scopeId, eventId);
    if (prior && !isDeepStrictEqual(prior.event.subject, subject)) throw packageRefused();
    const record = prior ?? audit.record({ schemaVersion: 1, eventId, scopeId, principal: { issuer: current.principal.issuer, subject: current.principal.subject },
      policyRevision: current.document.revision, atMs: Date.now(), subject });
    return { document, event: record.event };
  });
}

export async function changeConfiguredPackageAllowance(root: string, request: PackageConsentRequest, options: ConfigLoadOptions,
  confirm: (card: PackageConsentCard) => Promise<boolean>) {
  const { scopeId, action, locale } = request, commandId = clientCommandIdSchema.parse(request.commandId ?? randomUUID()), layer = 'project' as const;
  if (!workerPackageAllowancesSchema.element.shape.generation.safeParse(commandId).success) throw ErrorRegistry.createError('CLI_USAGE');
  // The same witness gates image consent before input discovery.
  await configPersonWitness()(WORKER_PACKAGE_CONSENT);
  const context = await resolveContext(root, scopeId, options);
  await person(context);
  const input = { keyPath, layer, scopeId, commandId, principal: context.principal };
  const layout = nativeCodingDependencyLayout(), profile = profileFor(context, request.kind);
  const keyFor = async (current: PackageContext) => {
    const execution = current.config.execution;
    if (!execution) throw packageRefused();
    const project = await realpath(resolve(root)), target = await resolveGitWorkTarget(project, execution, current.layout);
    return packagePartition(current, scopeId, profileFor(current, request.kind), {
      project, workTarget: target.git.sourceRoot, layout: layout.id, platform: `${process.platform}-${process.arch}`,
    });
  };
  const partition = await keyFor(context);
  const original = await withPackagePartition(context, partition, async audit => ({
    ...packageActivity(audit, scopeId, partition),
    publication: packagePublication(audit, scopeId, partition, commandId),
    intent: audit.load(scopeId, packageIntentId(partition, commandId)),
  }));
  const snapshot = await snapshotConfiguredConfig(root, options);
  const before = original, originalSubject = packageActivitySubject(original.publication, partition);
  if (originalSubject) {
    if (originalSubject.action !== (action === 'grant' ? 'set' : 'unset')
      || !samePackagePerson(context.principal, original.publication!.event.principal)) throw packageRefused();
    const exact = await withPackagePartition(context, partition, async audit => {
      const activity = packageActivity(audit, scopeId, partition, original.publication!.sequence);
      const grant = activity.grant ? audit.load(scopeId, packageIntentId(partition, activity.grant))?.event.subject : null;
      if (grant?.kind !== 'config-change' || !grant.approvalId) throw packageRefused();
      return { decisionId: grant.approvalId, version: activity.version };
    });
    const row = managedPackageRows(snapshot.document).find(entry => entry.partition === partition && entry.decisionId === exact.decisionId);
    if (action === 'grant') {
      if (!row || original.latest?.sequence !== original.publication!.sequence) return { status: 'historical' as const, ...exact };
      await verifyPackagePerson(context, scopeId, row);
      if (originalSubject.digest !== packageRowDigest(row)) throw packageRefused();
      return { status: 'active' as const, ...exact };
    }
    if (!row) return { status: 'withdrawn' as const, ...exact };
  }
  const documents = createConfigFileDocuments(root, options);

  async function checkActor() {
    const current = await resolveContext(root, scopeId, options);
    await person(current);
    if (!samePackagePerson(current.principal, context.principal) || await keyFor(current) !== partition) throw packageRefused();
    return current;
  }
  const authorizeGrant = async (current: PackageContext) => {
    const policy = evaluateConfigWrite(current.document, current.principal, input);
    await authorizeWorkTargetUse(contextPolicySource(current), selectWorkTarget(current.config.execution)?.id ?? null, scopeId, current.principal);
    return policy;
  };
  if (action === 'withdraw') {
    const rows = managedPackageRows(snapshot.document), existing = rows.find(row => row.partition === partition);
    if (!existing) return { status: 'absent' as const };
    const decideWithdraw = async (current: PackageContext) => {
      if (isPackageScopeAdministrator(current.document, scopeId, current.principal)) return;
      const evidence = await verifyPackagePerson(current, scopeId, existing);
      if (!samePackagePerson(evidence.actor, current.principal)) throw ErrorRegistry.createError('POLICY_DENIED');
      if ((await authorizeGrant(current)).decision !== 'allow') throw ErrorRegistry.createError('POLICY_APPROVAL_UNSUPPORTED');
    };
    await decideWithdraw(context);
    const title = t('coding.dependencies.allowance.withdrawTitle', {}, locale);
    if (!await confirm({ title, lines: [t('coding.dependencies.allowance.withdrawEffect', existing, locale)], action })) return { status: 'declined' as const };
    return withPackagePartition(context, partition, async audit => {
      const current = await checkActor();
      await decideWithdraw(current);
      const fresh = await snapshotConfiguredConfig(root, options), own = managedPackageRows(fresh.document);
      const activity = packageActivity(audit, scopeId, partition);
      const needsWithdrawal = activity.subject?.action === 'set' || activity.subject?.action === 'retire';
      if (!isDeepStrictEqual(existing, own.find(row => row.partition === partition)) || (needsWithdrawal && activity.subject?.digest !== packageRowDigest(existing))) throw packageRefused();
      if (needsWithdrawal) recordPackagePublication(audit, current, scopeId, partition, commandId, existing, 'withdraw');
      await publishPackageRows(documents, input, current, audit, partition, fresh.digest, own.filter(row => row.partition !== partition));
      return { status: 'withdrawn' as const, decisionId: existing.decisionId, version: existing.version };
    });
  }

  const decisionPolicy = await authorizeGrant(context);
  const known = await packageReviewSecrets(context, options);
  const source = await configuredPreparedInput(root, context, scopeId, layout, undefined, options, known);
  const reviewed = await source.review();
  const binding = { layout: layout.id, project: source.project, workTarget: source.workTarget, platform: source.platform,
    listDigest: reviewed.digest, lockfileDigest: source.lockfileDigest };
  if (await packagePartition(context, scopeId, profile, binding) !== partition) throw packageRefused();
  const existing = managedPackageRows(snapshot.document).find(row => row.partition === partition);
  const version = existing?.generation === commandId ? existing.version : before.version + 1;
  const proposed = { operation: WORKER_PACKAGE_CONSENT, partition, generation: commandId, version,
    listDigest: binding.listDigest, lockfileDigest: binding.lockfileDigest } as const;
  const basis = packageBasis(proposed);
  const summary = t('coding.dependencies.allowance.reuse', {}, locale);
  const lines = [summary, t('coding.dependencies.allowance.profile', { id: profile.id, version: profile.version, scope: scopeId }, locale),
    ...t('coding.dependencies.reference', { ...binding, target: binding.workTarget, lockfile: layout.lockfile, mount: layout.mount }, locale).split('\n'),
    t('coding.dependencies.patternRisk', {}, locale),
    ...reviewed.manifest.entries.flatMap(({ path, kind, size, mode, digest, rules, ...entry }) => [
      t('coding.dependencies.entry', { path, kind, size, mode: mode.toString(8), digest: digest ?? '-', target: 'target' in entry ? entry.target : '-' }, locale),
      ...rules.map(rule => t('coding.dependencies.pattern', { path, rule, digest: digest ?? '-' }, locale)),
    ])];
  if (lines.some(line => /[\p{Cc}\p{Cf}]/u.test(line) || terminalSafeText(line) !== line || redactForRecord(line, known) !== line)) throw packageRefused();
  if (!await confirm({ title: t('coding.dependencies.allowance.grantTitle', {}, locale), lines, action })) return { status: 'declined' as const };

  const subject: ConfigChangeSubject = { kind: 'config-change', layer, commandId, action: 'set', keyPath,
    before: String(before.version), after: basis, valueDigest: basis, expectDigest: original.intent?.event.subject.kind === 'config-change' ? original.intent.event.subject.beforeDigest : snapshot.digest, ruleId: decisionPolicy.ruleId ?? 'policy' };
  const { config } = context, integrity = await openLocalIntegrityAuthority(context.layout, config.approvals.keyFile, true);
  const journal = openSqliteApprovalStore(await context.path(), config.storage.sqlite, 'forbid');
  let decisionId: string;
  try {
    const clock = new SystemTrustedClock(), ttl = config.approvals.requestTtlMs;
    const broker = new ConfigChangeApprovalBroker(journal.store, integrity, clock, { requestTtlMs: ttl, admitWithinMs: ttl });
    const approval = broker.admit({ scopeId, requester: { id: input.principal.id, issuer: input.principal.issuer, subject: input.principal.subject },
      subject, policy: context.document, policyRevision: decisionPolicy.revision, summary, witnessedConsent: true });
    if ('pending' in approval) {
      decisionId = approval.pending.approvalId;
      await configuredApproval(root, 'decide', { schemaVersion: 1, scopeId, approvalId: decisionId, commandId: randomUUID(),
        expectedRevision: approval.pending.revision, decision: 'allow', reason: basis, channel: 'local-terminal-card' }, options);
    } else decisionId = approval.approved.approvalId;
  } finally { journal.close(); }

  const row = { ...proposed, decisionId };
  await source.seal({ ...binding, approval: { scopeId } });
  return withPackagePartition(context, partition, async audit => {
    const current = await checkActor();
    await authorizeGrant(current);
    const settled = packagePublication(audit, scopeId, partition, commandId);
    if (settled) {
      if (packageActivitySubject(settled, partition)?.digest !== packageRowDigest(row)) throw packageRefused();
      return { status: 'active' as const, decisionId, version };
    }
    const fresh = await snapshotConfiguredConfig(root, options), activity = packageActivity(audit, scopeId, partition);
    const evidence = await verifyPackagePerson(current, scopeId, row, true);
    if (activity.latest?.sequence !== before.latest?.sequence || activity.version + 1 !== version) throw packageRefused();
    const freshKnown = await packageReviewSecrets(current, options);
    const now = await configuredPreparedInput(root, current, scopeId, layout, undefined, options, freshKnown);
    if (now.lockfileDigest !== row.lockfileDigest || (await now.review()).digest !== row.listDigest) throw packageRefused();
    const verify = await verifyPackageObject(current, { ...binding, state: 'sealed', approval: { scopeId, commandId } }, freshKnown);
    await verify();
    await now.assertCurrent();
    const intended = audit.load(scopeId, packageIntentId(partition, commandId))?.event.subject;
    const own = managedPackageRows(fresh.document);
    const recovered = intended?.kind === 'config-change' && intended.afterDigest === fresh.digest && intended.approvalId === decisionId
      && isDeepStrictEqual(own.find(record => record.partition === partition), row);
    if (!recovered) {
      if (evidence.expectDigest !== fresh.digest) throw packageRefused();
      await publishPackageRows(documents, input, current, audit, partition, fresh.digest, [...own.filter(record => record.partition !== partition), row], decisionId);
    }
    recordPackagePublication(audit, current, scopeId, partition, commandId, row, 'grant');
    return { status: 'active' as const, decisionId, version };
  });
}
