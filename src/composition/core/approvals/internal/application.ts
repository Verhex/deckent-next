import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { ApprovalApplication, authorizeApproval, approvalCommandSchema, approvalQuerySchema, approvalListSchema, approvalRenewalSchema, RuntimeServiceProtocolError,
  type ApprovalSubjectKind } from '#engine/index.js';
import { openSqliteApprovalStore, openLocalIntegrityAuthority, LocalOsSessionAuthority, createLocalPeerSession, type LocalPeerIdentity } from '#adapters/index.js';
import { loadConfiguredScopeContext, loadConfiguredPeerScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** All surfaces converge here. Peer context is supplied only by the trusted transport. */
export async function configuredApproval(projectRoot: string, action: 'list' | 'inspect' | 'decide' | 'renew', input: unknown,
  options: ConfigLoadOptions = {}, peer?: LocalPeerIdentity, capacity?: number, view: { readonly excludeSubjects?: readonly ApprovalSubjectKind[] } = {}) {
  try {
    const parsed = (action === 'list' ? approvalListSchema : action === 'inspect' ? approvalQuerySchema : action === 'renew' ? approvalRenewalSchema : approvalCommandSchema).parse(input);
    // Query/command split (Astra 2126 R1): list and inspect are reads and never pin a scope; decide and renew are write admissions.
    const access = action === 'list' || action === 'inspect' ? 'read' : 'write';
    const context = peer ? await loadConfiguredPeerScopeContext(projectRoot, parsed.scopeId, options, peer, access)
      : await loadConfiguredScopeContext(projectRoot, parsed.scopeId, options, access);
    const { config, layout, document, principal } = context;
    const id = 'approvalId' in parsed ? parsed.approvalId : parsed.scopeId;
    authorizeApproval(document, action === 'renew' ? 'renew' : action === 'decide' ? 'decide' : 'inspect', parsed.scopeId, id, principal);
    const clock = new SystemTrustedClock();
    const sessions = peer ? await createLocalPeerSession(peer, principal.scopeIds, config.approvals.sessionTtlMs, clock)
      : await LocalOsSessionAuthority.create(principal.scopeIds, config.approvals.sessionTtlMs, clock);
    const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile);
    const journal = openSqliteApprovalStore(await context.path(), config.storage.sqlite);
    try {
      const check = (result: unknown) => {
        if (Buffer.byteLength(JSON.stringify(result)) > (capacity ?? config.service.responseMaxBytes)) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT');
      };
      const app = new ApprovalApplication(journal.store, { verify: async () => principal }, sessions,
        { load: async () => (peer ? await loadConfiguredPeerScopeContext(projectRoot, parsed.scopeId, options, peer, access)
          : await loadConfiguredScopeContext(projectRoot, parsed.scopeId, options, access)).document }, integrity, clock,
        peer ? 'local-runtime' : 'local-sdk', config.approvals.pageSize, check);
      const result = action === 'list' ? await app.list(parsed, undefined, view) : action === 'inspect' ? await app.inspect(parsed) : action === 'renew' ? await app.renew(parsed, config.approvals.requestTtlMs) : await app.decide(parsed);
      check(result); return result;
    } finally { journal.close(); }
  } catch (error) { throw queryFailure(error); }
}
