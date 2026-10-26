import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { ErrorRegistry, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { ApprovalApplication, AuditApplication, authorizeApproval, approvalCommandSchema, approvalQuerySchema, approvalListSchema, approvalRenewalSchema, RuntimeServiceProtocolError,
  resolveAuditedApprovalAssurance, registerApprovalChannel, registeredApprovalChannels, parseApprovalAnswer, SessionApprovalAnswers, type ApprovalSubjectKind, type TurnDecisionCapabilities,
  EffectApplication, OperationApprovalBroker, OperationPolicyAuthorization, type EffectTarget } from '#engine/index.js';
import { attestLocalInteractiveTerminal, openSqliteApprovalStore, openSqliteAuditStore, openLocalIntegrityAuthority, readOperationsConfig, resolveOperationCatalog, LocalOsSessionAuthority, createLocalPeerSession, openSqliteAttemptStore, type LocalPeerIdentity } from '#adapters/index.js';
import { PRINCIPAL_EFFECT_PRODUCER, type AuditEvent, type EffectCommand, type OperationDescriptor } from '#domain/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext, loadConfiguredPeerScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
for (const id of ['local-terminal-card', 'local-cli', 'local-sdk', 'mcp']) registerApprovalChannel(id);
export async function configuredApproval(projectRoot: string, action: 'list' | 'inspect' | 'decide' | 'renew', input: unknown,
  options: ConfigLoadOptions = {}, peer?: LocalPeerIdentity, capacity?: number, view: { readonly excludeSubjects?: readonly ApprovalSubjectKind[] } = {}, decisions?: TurnDecisionCapabilities, answers?: SessionApprovalAnswers) {
  try {
    const parsed = (action === 'list' ? approvalListSchema : action === 'inspect' ? approvalQuerySchema : action === 'renew' ? approvalRenewalSchema : approvalCommandSchema).parse(input);
    const access = action === 'list' || action === 'inspect' ? 'read' : 'write';
    const context = peer ? await loadConfiguredPeerScopeContext(projectRoot, parsed.scopeId, options, peer, access)
      : await loadConfiguredScopeContext(projectRoot, parsed.scopeId, options, access);
    const { config, layout, document, principal } = context; const id = 'approvalId' in parsed ? parsed.approvalId : parsed.scopeId;
    if (action === 'decide' && ApprovalApplication.requiresInteractiveTerminal(principal) && !await attestLocalInteractiveTerminal(peer?.pid, peer?.uid)) throw ErrorRegistry.createError('APPROVAL_INTERACTIVE_REQUIRED');
    authorizeApproval(document, action === 'renew' ? 'renew' : action === 'decide' ? 'decide' : 'inspect', parsed.scopeId, id, principal);
    const clock = new SystemTrustedClock();
    const sessions = peer ? await createLocalPeerSession(peer, principal.scopeIds, config.approvals.sessionTtlMs, clock)
      : await LocalOsSessionAuthority.create(principal.scopeIds, config.approvals.sessionTtlMs, clock);
    if (action === 'decide' && ApprovalApplication.requiresInteractiveTerminal(principal)) sessions.requireInteractiveTerminal();
    const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile);
    const journal = openSqliteApprovalStore(await context.path(), config.storage.sqlite);
    let audit: Awaited<ReturnType<typeof openSqliteAuditStore>> | undefined;
    try {
      if (action === 'decide') audit = await openSqliteAuditStore(await context.path(), config.storage.sqlite, 'forbid');
      const check = (result: unknown) => { if (Buffer.byteLength(JSON.stringify(result)) > (capacity ?? config.service.responseMaxBytes)) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT'); };
      const restriction = action !== 'decide' ? undefined : { catalog: resolveOperationCatalog(readOperationsConfig(config as unknown as Record<string, unknown>)),
        refused: (event: AuditEvent) => { new AuditApplication(audit!, integrity).record(event); } };
      const producers = action !== 'decide' ? [] : resolveAuditedApprovalAssurance(config.approvals.assuranceProducers, decisions,
        { scopeId: parsed.scopeId, principal, policyRevision: document.revision, atMs: clock.sample().wallMs }, event => { new AuditApplication(audit!, integrity).record(event); });
      const app = new ApprovalApplication(journal.store, { verify: async () => principal }, sessions,
        { load: async () => (peer ? await loadConfiguredPeerScopeContext(projectRoot, parsed.scopeId, options, peer, access)
          : await loadConfiguredScopeContext(projectRoot, parsed.scopeId, options, access)).document }, integrity, clock,
        'local-sdk', config.approvals.pageSize, record => check('standing' in parsed ? { record, standing: { scope: 'session', status: 'unconfirmed', reason: 'result-unavailable' } } : record), restriction, { producers, channels: registeredApprovalChannels(), peerPid: peer?.pid ?? null, interactive: () => attestLocalInteractiveTerminal(peer?.pid, peer?.uid) });
      const result = action === 'list' ? await app.list(parsed, undefined, view) : action === 'inspect' ? await app.inspect(parsed) : action === 'renew' ? await app.renew(parsed, config.approvals.requestTtlMs) : ('standing' in parsed && parsed.standing === 'session' ? await (answers ?? new SessionApprovalAnswers()).answer(approvalCommandSchema.parse(parsed), principal, peer?.pid ?? null, app) : await app.decide(parsed));
      const answer = action === 'decide' ? parseApprovalAnswer('standing' in parsed, result) : result;
      check(answer); return answer;
    } finally { audit?.close(); journal.close(); }
  } catch (error) { throw queryFailure(error); }
}
/** A person's confirmed card applies its exact commands through the scope's operation broker and the shared effect contract. The card already
 * confirmed the complete preview: a pending approval is decided once (reason = the card digest; normal approval authority still applies). */
export async function applyConfirmedEffects(root: string, context: Awaited<ReturnType<typeof loadConfiguredScopeContext>>, descriptor: OperationDescriptor,
  target: EffectTarget, commands: readonly EffectCommand[], reason: string, options: ConfigLoadOptions) {
  const { config, layout, principal } = context;
  const clock = new SystemTrustedClock(), policy = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes);
  const sessions = await LocalOsSessionAuthority.create(principal.scopeIds, config.approvals.sessionTtlMs, clock);
  const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true), path = await context.path();
  const store = await openSqliteAttemptStore(path, config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
  const approvals = openSqliteApprovalStore(path, config.storage.sqlite);
  try {
    const broker = new OperationApprovalBroker(approvals.store, integrity, policy, clock,
      { requestTtlMs: config.approvals.requestTtlMs, defaultAdmitWithinMs: config.approvals.requestTtlMs });
    const app = new EffectApplication({ resolve: async ref => ref.id === descriptor.operation.id && ref.version === descriptor.operation.version ? descriptor : null },
      { resolve: kind => kind === target.kind ? target : null }, store, broker, sessions, new OperationPolicyAuthorization(policy), clock, { producer: PRINCIPAL_EFFECT_PRODUCER });
    const outcomes = [];
    for (const command of commands) {
      let outcome = await app.submit('execute', command);
      if (outcome.status === 'approval-pending') {
        await configuredApproval(root, 'decide', { schemaVersion: 1, commandId: randomUUID(), scopeId: command.scopeId, approvalId: outcome.approval.approvalId,
          expectedRevision: outcome.approval.revision, decision: 'allow', reason, channel: 'local-terminal-card' }, options);
        outcome = await app.submit('execute', command);
      }
      outcomes.push(outcome);
    }
    return outcomes;
  } finally { approvals.close(); store.close(); }
}
