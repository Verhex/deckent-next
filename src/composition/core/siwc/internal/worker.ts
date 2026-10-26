import { randomUUID } from 'node:crypto';
import type { AttemptIdentity, VerifiedPrincipal } from '#domain/index.js';
import { openSiwcWorkerRelay, siwcWorkerConnections, type SiwcWorkerConnection } from '#adapters/index.js';
import { DECKENT_VERSION, ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { withConfiguredSiwc } from './connection.js';

type Context = Readonly<{ config: Readonly<Record<string, unknown>>; principal: VerifiedPrincipal }>;
/** U9-7 producer input at Run admission: the admitting person's consented connections whose personal custody holds now (U9-1 lease check). */
export const configuredSiwcWorkerConnections = (root: string, context: Context, options: ConfigLoadOptions) => siwcWorkerConnections({ profiles: context.config['provider_invocation_profiles'],
  scopeIds: context.principal.scopeIds, actor: context.principal, custody: (scopeId, id) => withConfiguredSiwc(root, scopeId, options, 'inspect',
    async (app, caller) => !!await app.inspectForLease(id, caller), {}, context.principal) });
/**
 * U9-7 launch of one relay worker: the frozen connection must still be this person's, consented, in personal custody and at the generation seen at
 * launch, and the Attempt fence must hold — re-read before C is issued, before every upstream send and before every native effect. The bearer is
 * leased host-side per send (U9-1); approvals follow the profile's admitted unattended mode inside the worker, never wider (the client refuses
 * permission expansion and paths outside /workspace before asking). Relay records are sealed into the Core audit trail as the executing principal.
 */
export async function openConfiguredSiwcWorker(root: string, options: ConfigLoadOptions, input: Readonly<{ identity: AttemptIdentity; principal: VerifiedPrincipal;
  connection: Pick<SiwcWorkerConnection, 'connectionId' | 'owner'>; model: string; imageId: string; codexVersion: string; deadlineMs: number;
  turn: Readonly<{ prompt: string; instructions: string; config: readonly string[]; finalReport: boolean }>;
  directory: string; fence: () => Promise<boolean>; policyRevision: string; audit: (event: unknown) => Promise<void> }>) {
  const { scopeId } = input.identity, { connectionId, owner } = input.connection;
  const current = async () => { const context = await loadConfiguredScopeContext(root, scopeId, options, 'read');
    const view = await withConfiguredSiwc(root, scopeId, options, 'inspect', (app, caller) => app.inspectForLease(connectionId, caller), {}, input.principal);
    const row = (await siwcWorkerConnections({ profiles: context.config['provider_invocation_profiles'], scopeIds: [scopeId], actor: owner, custody: async (_, id) => id === connectionId }))
      .find(entry => entry.connectionId === connectionId && entry.modelId === input.model);
    return row && context.installationId ? { context, installationId: context.installationId, generation: view.generation, consent: row.consentAtMs } : null; };
  const start = await current();
  if (!start) throw ErrorRegistry.createError('SIWC_RELAY_REFUSED', { params: { reason: 'authority' } });
  const live = async () => { try { const now = await current(); return !!now && now.generation === start.generation && now.consent === start.consent && await input.fence(); } catch { return false; } };
  const principal = { issuer: input.principal.issuer, subject: input.principal.subject };
  return openSiwcWorkerRelay({ ...input.turn, directory: input.directory, deadlineMs: input.deadlineMs, version: DECKENT_VERSION, live, approve: live,
    audit: subject => input.audit({ schemaVersion: 1, eventId: randomUUID(), scopeId, principal, policyRevision: input.policyRevision, atMs: Date.now(), subject }),
    binding: { schemaVersion: 1, connectionId, installationId: start.installationId, companyId: start.context.config.company.id, person: owner, attempt: input.identity,
      model: input.model, imageId: input.imageId, codexVersion: input.codexVersion, generations: { connection: start.generation, custody: start.generation, consent: start.consent } },
    lease: (id, signal) => withConfiguredSiwc(root, scopeId, options, 'lease', (app, caller) => app.lease(id, caller, signal), {}, input.principal) });
}
