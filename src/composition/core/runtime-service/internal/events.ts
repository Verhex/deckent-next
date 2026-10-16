import { dirname } from 'node:path';
import { watch } from 'node:fs';
import { sha256, type ConfigLoadOptions, type RuntimeEventsSettings } from '#platform/index.js';
import { openRuntimeObservationLedger, readRuntimeObservationBudget, openLocalIntegrityAuthority, readLiveWorkerMetadata, localPrincipalChannel, type LocalPeerIdentity } from '#adapters/index.js';
import { RuntimeEventsApplication, RuntimeEventsError, ProviderSpendAccountPolicyAuthorization, authorizeRuntimeObservationTopics, runtimeObservationRecordAuthorizer, openRuntimeObservationSource,
  type RuntimeEventsAdmission, type RuntimeEventsSelection } from '#engine/index.js';
import { loadConfiguredPeerScopeContext } from '#composition/core/scoped-request/index.js';

type Context = Awaited<ReturnType<typeof loadConfiguredPeerScopeContext>>;
/** Fresh peer context for every batch and frame; a read cannot bootstrap an identity, migrate, or widen policy. */
export async function authorizeRuntimeEvents(root: string, query: RuntimeEventsSelection, peer: LocalPeerIdentity, options: ConfigLoadOptions): Promise<RuntimeEventsAdmission & { context: Context; ledger: string; integrity: Awaited<ReturnType<typeof openLocalIntegrityAuthority>> | undefined }> {
  const c = await loadConfiguredPeerScopeContext(root, query.scopeId, { ...options, force: true }, peer, 'read');
  if (!c.installationId || !c.projectId) throw new RuntimeEventsError('RUNTIME_EVENTS_UNAVAILABLE');
  const source = { load: async () => c.document };
  await authorizeRuntimeObservationTopics(query, c.document, c.principal);
  const integrity = query.topics.includes('approval') ? await openLocalIntegrityAuthority(c.layout, c.config.approvals.keyFile, false) : undefined;
  const ledger = await c.path();
  if (query.topics.includes('usage')) {
    await new ProviderSpendAccountPolicyAuthorization(source).authorize('inspect', readRuntimeObservationBudget(ledger, c.config.storage.sqlite, query.scopeId), c.principal);
  }
  const binding = sha256(JSON.stringify([c.installationId, c.projectId, c.config.company.id, ledger, query.scopeId,
    c.principal.issuer, c.principal.subject, localPrincipalChannel() ?? 'local', query.topics, c.document, c.config.service.events, integrity?.keyId]));
  return { binding, principalKey: JSON.stringify([c.principal.issuer, c.principal.subject]), context: c, ledger, integrity,
    allows: runtimeObservationRecordAuthorizer(query, c.document, c.principal) };
}

/** One application per service; the verified peer is an out-of-band credential, never query data. */
export function createConfiguredRuntimeEvents(root: string, limits: RuntimeEventsSettings, options: ConfigLoadOptions) {
  return new RuntimeEventsApplication(limits, {
    authorize(query, credential) { return authorizeRuntimeEvents(root, query, credential as LocalPeerIdentity, options); },
    async open(query, admission) {
      const a = admission as Awaited<ReturnType<typeof authorizeRuntimeEvents>>;
      return openRuntimeObservationSource(a, limits, {
        watch: notify => watch(dirname(a.ledger), notify),
        open: () => openRuntimeObservationLedger(a.ledger, a.context.config.storage.sqlite, query, limits, a.integrity),
        live: row => readLiveWorkerMetadata(dirname(row.workspace!), limits),
      });
    },
    now: () => performance.now(), wallNow: () => Date.now(),
  });
}
