import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { ApprovalApplication, AuditApplication, authorizeApproval, approvalCommandSchema, approvalQuerySchema, approvalListSchema, approvalRenewalSchema, RuntimeServiceProtocolError,
  registerApprovalChannel, registeredApprovalChannels, parseApprovalAnswer, SessionApprovalAnswers, type ApprovalSubjectKind, type TurnDecisionCapabilities } from '#engine/index.js';
import { openSqliteApprovalStore, openSqliteAuditStore, openLocalIntegrityAuthority, readOperationsConfig, registerProviderConfig, resolveOperationCatalog, LocalOsSessionAuthority, createLocalPeerSession, type LocalPeerIdentity } from '#adapters/index.js';
import type { AuditEvent } from '#domain/index.js';
import { loadConfiguredScopeContext, loadConfiguredPeerScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
// Declared surface channels are records, never authority.
for (const id of ['local-terminal-card', 'local-cli', 'local-sdk', 'mcp']) registerApprovalChannel(id);
/** All surfaces converge here. Peer context is supplied only by the trusted transport; `decisions` is the service's turn capability ring (B1). */
export async function configuredApproval(projectRoot: string, action: 'list' | 'inspect' | 'decide' | 'renew', input: unknown,
  options: ConfigLoadOptions = {}, peer?: LocalPeerIdentity, capacity?: number, view: { readonly excludeSubjects?: readonly ApprovalSubjectKind[] } = {}, decisions?: TurnDecisionCapabilities, answers?: SessionApprovalAnswers) {
  try {
    const parsed = (action === 'list' ? approvalListSchema : action === 'inspect' ? approvalQuerySchema : action === 'renew' ? approvalRenewalSchema : approvalCommandSchema).parse(input);
    const access = action === 'list' || action === 'inspect' ? 'read' : 'write';
    const context = peer ? await loadConfiguredPeerScopeContext(projectRoot, parsed.scopeId, options, peer, access)
      : await loadConfiguredScopeContext(projectRoot, parsed.scopeId, options, access);
    const { config, layout, document, principal } = context; const id = 'approvalId' in parsed ? parsed.approvalId : parsed.scopeId;
    authorizeApproval(document, action === 'renew' ? 'renew' : action === 'decide' ? 'decide' : 'inspect', parsed.scopeId, id, principal);
    const clock = new SystemTrustedClock();
    const sessions = peer ? await createLocalPeerSession(peer, principal.scopeIds, config.approvals.sessionTtlMs, clock)
      : await LocalOsSessionAuthority.create(principal.scopeIds, config.approvals.sessionTtlMs, clock);
    const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile);
    const journal = openSqliteApprovalStore(await context.path(), config.storage.sqlite);
    try {
      const check = (result: unknown) => { if (Buffer.byteLength(JSON.stringify(result)) > (capacity ?? config.service.responseMaxBytes)) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT'); };
      // General surfaces cannot decide authority-surface approvals; K3 refusal is audited.
      registerProviderConfig();
      const restriction = action !== 'decide' ? undefined : { catalog: resolveOperationCatalog(readOperationsConfig(config as unknown as Record<string, unknown>)),
        refused: async (event: AuditEvent) => {
          const store = await openSqliteAuditStore(await context.path(), config.storage.sqlite, 'forbid');
          try { new AuditApplication(store, integrity).record(event); } finally { store.close(); }
        } };
      const app = new ApprovalApplication(journal.store, { verify: async () => principal }, sessions,
        { load: async () => (peer ? await loadConfiguredPeerScopeContext(projectRoot, parsed.scopeId, options, peer, access)
          : await loadConfiguredScopeContext(projectRoot, parsed.scopeId, options, access)).document }, integrity, clock,
        'local-sdk', config.approvals.pageSize, record => check('standing' in parsed ? { record, standing: { scope: 'session', status: 'unconfirmed', reason: 'result-unavailable' } } : record), restriction, { producers: decisions ? [decisions] : [], channels: registeredApprovalChannels(), peerPid: peer?.pid ?? null });
      const result = action === 'list' ? await app.list(parsed, undefined, view) : action === 'inspect' ? await app.inspect(parsed) : action === 'renew' ? await app.renew(parsed, config.approvals.requestTtlMs) : ('standing' in parsed && parsed.standing === 'session' ? await (answers ?? new SessionApprovalAnswers()).answer(approvalCommandSchema.parse(parsed), principal, peer?.pid ?? null, app) : await app.decide(parsed));
      const answer = action === 'decide' ? parseApprovalAnswer('standing' in parsed, result) : result;
      check(answer); return answer;
    } finally { journal.close(); }
  } catch (error) { throw queryFailure(error); }
}
