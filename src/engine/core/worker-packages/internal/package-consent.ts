import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { clientCommandIdSchema, executionRegistrySchema, NATIVE_CODING_TEMPLATE_ADAPTER_ID, NATIVE_NODE_DEPENDENCY_LAYOUT as layout, type AuditRecord } from '#domain/index.js';
import { ConfigChangeApprovalBroker } from '#engine/core/approval/index.js';
import type { AuditApplication } from '#engine/core/audit/index.js';
import { evaluateConfigWrite, isConfigConsentPerson, isPackageScopeAdministrator, planConfigChange, samePackagePerson, validateConfigLayers,
  type ConfigChangeSubject, type ConfigDocumentPort, type ConfigWriteInput } from '#engine/core/config/index.js';
import { authorizeWorkTargetUse } from '#engine/core/policy/index.js';
import { digestText, ErrorRegistry, redactForRecord, serializeJsonDocument, SystemTrustedClock, t, terminalSafeText, type Locale, WORKER_PACKAGE_ALLOWANCE_KEY as keyPath, WORKER_PACKAGE_CONSENT, workerPackageAllowancesSchema, type WorkerPackageAllowance } from '#platform/index.js';
import { managedPackageRows, packageActivity, packageActivitySubject, packageBasis, packageIntentId, packagePartition, packagePublication, packageRefused,
  packageRowDigest, recordPackagePublication, verifyPackagePerson, withPackagePartition } from './package-activity.js';
import type { PackageContext, WorkerPackagePorts } from './ports.js';

export type PackageConsentRequest = Readonly<{ scopeId: string; kind: string; action: 'grant' | 'withdraw'; locale: Locale; commandId?: string }>;
export type PackageConsentCard = Readonly<{ title: string; lines: readonly string[]; action: PackageConsentRequest['action'] }>;
function profileFor(context: PackageContext, kind: string) {
  const registry = executionRegistrySchema.parse(context.config.admission?.registry);
  const selected = registry.kinds.find(entry => entry.kind === kind)?.profile;
  const profile = registry.profiles.find(row => row.id === selected?.id && row.version === selected.version);
  if (!profile || profile.adapter.id !== NATIVE_CODING_TEMPLATE_ADAPTER_ID
    || profile.parameters['dependencyLayout'] !== layout.id) throw packageRefused();
  return profile;
}
async function person<C extends PackageContext>(ports: WorkerPackagePorts<C>, context: C) {
  if (!isConfigConsentPerson(context.principal)) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: WORKER_PACKAGE_CONSENT } });
  await ports.witness(WORKER_PACKAGE_CONSENT);
}

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

export async function changePackageAllowance<C extends PackageContext>(ports: WorkerPackagePorts<C>, request: PackageConsentRequest,
  confirm: (card: PackageConsentCard) => Promise<boolean>) {
  const { scopeId, action, locale } = request, commandId = clientCommandIdSchema.parse(request.commandId ?? randomUUID()), layer = 'project' as const;
  if (!workerPackageAllowancesSchema.element.shape.generation.safeParse(commandId).success) throw ErrorRegistry.createError('CLI_USAGE');
  // The same witness gates image consent before input discovery.
  await ports.witness(WORKER_PACKAGE_CONSENT);
  const context = await ports.loadScope(scopeId, 'write');
  await person(ports, context);
  const input = { keyPath, layer, scopeId, commandId, principal: context.principal };
  const profile = profileFor(context, request.kind);
  const keyFor = async (current: C) => {
    if (!current.config.execution) throw packageRefused();
    const { project, workTarget } = await ports.resolveTarget(current, true);
    return packagePartition(ports, current, scopeId, profileFor(current, request.kind), {
      project, workTarget, layout: layout.id, platform: ports.platform,
    });
  };
  const partition = await keyFor(context);
  async function replayDecision(current: C, audit: AuditApplication, publication: AuditRecord,
    activity: ReturnType<typeof packageActivity>, expected?: WorkerPackageAllowance) {
    const subject = packageActivitySubject(publication, partition);
    if (subject?.action !== (action === 'grant' ? 'set' : 'unset') || !samePackagePerson(current.principal, publication.event.principal)
      || (expected && subject.digest !== packageRowDigest(expected))) throw packageRefused();
    const latest = activity.latest?.sequence === publication.sequence;
    const atPublication = latest ? activity : packageActivity(audit, scopeId, partition, publication.sequence);
    const grant = atPublication.grant ? audit.load(scopeId, packageIntentId(partition, atPublication.grant))?.event.subject : null;
    if (grant?.kind !== 'config-change' || !grant.approvalId) throw packageRefused();
    const exact = { decisionId: grant.approvalId, version: atPublication.version };
    const snapshot = await ports.snapshotConfig();
    const row = managedPackageRows(snapshot.document).find(entry => entry.partition === partition && entry.decisionId === exact.decisionId);
    if (action === 'withdraw') return row ? undefined : { status: 'withdrawn' as const, ...exact };
    if (!row || !latest) return { status: 'historical' as const, ...exact };
    if (subject.digest !== packageRowDigest(row)) throw packageRefused();
    await verifyPackagePerson(ports, current, scopeId, row);
    return { status: 'active' as const, ...exact };
  }
  const { before, intent, replay } = await withPackagePartition(ports, context, partition, async audit => {
    const before = packageActivity(audit, scopeId, partition), publication = packagePublication(audit, scopeId, partition, commandId);
    return { before, intent: audit.load(scopeId, packageIntentId(partition, commandId)),
      replay: publication ? await replayDecision(context, audit, publication, before) : undefined };
  });
  if (replay) return replay;
  const snapshot = await ports.snapshotConfig();
  const documents = ports.configDocuments();

  async function checkActor() {
    const current = await ports.loadScope(scopeId, 'write');
    await person(ports, current);
    if (!samePackagePerson(current.principal, context.principal) || await keyFor(current) !== partition) throw packageRefused();
    return current;
  }
  const authorizeGrant = async (current: C) => {
    const policy = evaluateConfigWrite(current.document, current.principal, input);
    await authorizeWorkTargetUse(ports.policySource(current), ports.selectedTarget(current), scopeId, current.principal);
    return policy;
  };
  if (action === 'withdraw') {
    const rows = managedPackageRows(snapshot.document), existing = rows.find(row => row.partition === partition);
    if (!existing) return { status: 'absent' as const };
    const decideWithdraw = async (current: C) => {
      if (isPackageScopeAdministrator(current.document, scopeId, current.principal)) return;
      const evidence = await verifyPackagePerson(ports, current, scopeId, existing);
      if (!samePackagePerson(evidence.actor, current.principal)) throw ErrorRegistry.createError('POLICY_DENIED');
      if ((await authorizeGrant(current)).decision !== 'allow') throw ErrorRegistry.createError('POLICY_APPROVAL_UNSUPPORTED');
    };
    await decideWithdraw(context);
    const title = t('coding.dependencies.allowance.withdrawTitle', {}, locale);
    if (!await confirm({ title, lines: [t('coding.dependencies.allowance.withdrawEffect', existing, locale)], action })) return { status: 'declined' as const };
    return withPackagePartition(ports, context, partition, async audit => {
      const current = await checkActor();
      await decideWithdraw(current);
      const fresh = await ports.snapshotConfig(), own = managedPackageRows(fresh.document);
      const activity = packageActivity(audit, scopeId, partition);
      const needsWithdrawal = activity.subject?.action === 'set' || activity.subject?.action === 'retire';
      if (!isDeepStrictEqual(existing, own.find(row => row.partition === partition)) || (needsWithdrawal && activity.subject?.digest !== packageRowDigest(existing))) throw packageRefused();
      if (needsWithdrawal) recordPackagePublication(audit, current, scopeId, partition, commandId, existing, 'withdraw');
      await publishPackageRows(documents, input, current, audit, partition, fresh.digest, own.filter(row => row.partition !== partition));
      return { status: 'withdrawn' as const, decisionId: existing.decisionId, version: existing.version };
    });
  }

  const decisionPolicy = await authorizeGrant(context);
  const source = await ports.prepare(context, scopeId);
  const { known } = source;
  const reviewed = await source.review();
  const binding = { layout: layout.id, project: source.project, workTarget: source.workTarget, platform: source.platform,
    listDigest: reviewed.digest, lockfileDigest: source.lockfileDigest };
  if (await packagePartition(ports, context, scopeId, profile, binding) !== partition) throw packageRefused();
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
  if (known.matchesPackageValue?.([profile.id, scopeId]) ||
    lines.some(line => /[\p{Cc}\p{Cf}]/u.test(line) || terminalSafeText(line) !== line || redactForRecord(line, known) !== line)) throw packageRefused();
  // Publishing starts here. The promise for the person's answer outlives custody.
  const { answer } = await source.withCurrentSecrets(async () => {
    const answer = confirm({ title: t('coding.dependencies.allowance.grantTitle', {}, locale), lines, action });
    void answer.catch(() => undefined); // The caller awaits the original promise once custody is released.
    return { answer };
  });
  if (!await answer) return { status: 'declined' as const };

  const subject: ConfigChangeSubject = { kind: 'config-change', layer, commandId, action: 'set', keyPath,
    before: String(before.version), after: basis, valueDigest: basis, expectDigest: intent?.event.subject.kind === 'config-change' ? intent.event.subject.beforeDigest : snapshot.digest, ruleId: decisionPolicy.ruleId ?? 'policy' };
  const decisionId = await ports.withApprovals(context, true, async (store, integrity) => {
    const clock = new SystemTrustedClock(), ttl = context.config.approvals.requestTtlMs;
    const broker = new ConfigChangeApprovalBroker(store, integrity, clock, { requestTtlMs: ttl, admitWithinMs: ttl });
    const approval = broker.admit({ scopeId, requester: { id: input.principal.id, issuer: input.principal.issuer, subject: input.principal.subject },
      subject, policy: context.document, policyRevision: decisionPolicy.revision, summary, witnessedConsent: true });
    if ('approved' in approval) return approval.approved.approvalId;
    const { approvalId, revision } = approval.pending;
    await ports.decideApproval({ schemaVersion: 1, scopeId, approvalId, commandId: randomUUID(),
      expectedRevision: revision, decision: 'allow', reason: basis, channel: 'local-terminal-card' });
    return approvalId;
  });

  const row = { ...proposed, decisionId };
  await source.seal({ ...binding, approval: { scopeId } });
  return withPackagePartition(ports, context, partition, async audit => {
    const current = await checkActor();
    await authorizeGrant(current);
    const settled = packagePublication(audit, scopeId, partition, commandId);
    const activity = packageActivity(audit, scopeId, partition);
    if (settled) {
      const replay = await replayDecision(current, audit, settled, activity, row);
      if (!replay) throw packageRefused();
      return replay;
    }
    const fresh = await ports.snapshotConfig();
    const evidence = await verifyPackagePerson(ports, current, scopeId, row, true);
    if (activity.latest?.sequence !== before.latest?.sequence || activity.version + 1 !== version) throw packageRefused();
    const now = await ports.prepare(current, scopeId);
    if (now.lockfileDigest !== row.lockfileDigest || (await now.review()).digest !== row.listDigest) throw packageRefused();
    const verify = await ports.verifyObject(current, { ...binding, state: 'sealed', approval: { scopeId, commandId } }, now.known);
    await verify();
    await now.assertCurrent();
    const intended = audit.load(scopeId, packageIntentId(partition, commandId))?.event.subject;
    const own = managedPackageRows(fresh.document);
    const recovered = intended?.kind === 'config-change' && intended.afterDigest === fresh.digest && intended.approvalId === decisionId
      && isDeepStrictEqual(own.find(record => record.partition === partition), row);
    return now.withCurrentSecrets(async () => {
      if (!recovered) {
        if (evidence.expectDigest !== fresh.digest) throw packageRefused();
        await publishPackageRows(documents, input, current, audit, partition, fresh.digest, [...own.filter(record => record.partition !== partition), row], decisionId);
      }
      recordPackagePublication(audit, current, scopeId, partition, commandId, row, 'grant');
      return { status: 'active' as const, decisionId, version };
    });
  });
}
