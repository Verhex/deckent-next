import { randomUUID } from 'node:crypto';
import { modelInvocationProfileSchema, type SubscriptionConnectionRequest, type SubscriptionConnectionResult } from '#domain/index.js';
import { subscriptionActor, ModelInvocationPolicyAuthorization, modelInvocationBillingAxis, assertAuthorityWitness } from '#engine/index.js';
import { PROVIDER_CONNECT_REGISTRY, OPENAI_CHAT_COMPLETIONS_FAMILY, SIWC_INFERENCE, SIWC_USAGE_SUMMARY, siwcResponsesDefinitionSchema, readSqliteSubscriptionUsageSummary, attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { withConfiguredSiwc } from '#composition/core/siwc/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { connectConfiguredModel } from './connect.js';

const MILLISECONDS_PER_DAY = 86_400_000;
export async function executeConfiguredSiwc(root: string, request: SubscriptionConnectionRequest, options: ConfigLoadOptions,
  presentation: Readonly<{ signal?: AbortSignal; fallback?: (url: string) => void }> = {}): Promise<SubscriptionConnectionResult> {
  await assertAuthorityWitness('models.login', localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), { attest: () => attestLocalInteractiveTerminal() });
  const context = await loadConfiguredScopeContext(root, request.scopeId, options, request.operation === 'prepare' || request.operation === 'usage' ? 'read' : 'write');
  if (subscriptionActor(context.principal).principalClass !== 'person') throw ErrorRegistry.createError('HEADLESS_PERSON_REQUIRED');
  if (request.operation === 'prepare' || request.operation === 'usage') {
    const section = context.config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined, apiTargets = [], references = [];
    for (const value of section?.profiles ?? []) { // An unauthorized row is skipped without disclosure.
      const profile = modelInvocationProfileSchema.parse(value), metered = modelInvocationBillingAxis(profile) === 'metered' && profile.protocol.family === OPENAI_CHAT_COMPLETIONS_FAMILY;
      const usage = request.operation === 'usage' && profile.adapter.id === SIWC_INFERENCE.adapter.id && profile.adapter.definition['connectionId'] === request.connectionId;
      if (profile.scopeId !== request.scopeId || !metered && !usage) continue;
      try { await new ModelInvocationPolicyAuthorization({ load: async () => context.document }).authorize('inspect', profile, context.principal); } catch { continue; }
      if (metered) apiTargets.push({ id: profile.id, reference: profile.reference });
      if (usage) references.push(profile.reference);
    }
    if (request.operation === 'usage') {
      if (!request.connectionId) throw ErrorRegistry.createError('OAUTH_CONNECTION_INVALID');
      if (!references.length) throw ErrorRegistry.createError('OAUTH_CONNECTION_DENIED');
      const now = Date.now();
      return { usage: { ...await readSqliteSubscriptionUsageSummary(await context.path(), { scopeId: request.scopeId, connectionId: request.connectionId,
        owner: subscriptionActor(context.principal).owner, adapterId: SIWC_INFERENCE.adapter.id, fromMs: now - SIWC_USAGE_SUMMARY.days * MILLISECONDS_PER_DAY,
        untilMs: now, timeoutMs: SIWC_USAGE_SUMMARY.timeoutMs, ...(presentation.signal ? { signal: presentation.signal } : {}), maxEntries: SIWC_USAGE_SUMMARY.maxEntries, busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs, references }), days: SIWC_USAGE_SUMMARY.days } };
    }
    return { apiTargets, usageUrl: SIWC_USAGE_SUMMARY.manageUrl };
  }
  if (request.operation === 'logout' || request.operation === 'login' && !request.newAccount) return withConfiguredSiwc(root, request.scopeId, options,
    request.operation === 'logout' ? 'logout' : 'connect', async app => {
      const records = request.connectionId ? [] : request.operation === 'logout' ? await app.listForRevocation() : await app.list();
      if (!request.connectionId && records.length > 1) throw ErrorRegistry.createError('OAUTH_CONNECTION_INVALID');
      const connectionId = request.connectionId ?? records[0]?.connectionId;
      if (request.operation === 'logout' && !connectionId) throw ErrorRegistry.createError('OAUTH_CONNECTION_INVALID');
      const result = request.operation === 'logout' ? await app.disconnect(connectionId!, presentation.signal)
        : await app.connect({ ...(connectionId ? { connectionId, enablePlanUse: true } : {}), planUse: true }, presentation.signal);
      return result;
    }, presentation);
  const kind = PROVIDER_CONNECT_REGISTRY.kinds.find(row => row.connect?.adapter === SIWC_INFERENCE.adapter.id);
  if (!kind) throw ErrorRegistry.createError('MODEL_CONNECT_NOT_CONNECTABLE');
  const models = await connectConfiguredModel(root, { schemaVersion: 1, commandId: randomUUID(), scopeId: request.scopeId, connection: kind.id,
    model: { pull: 'available' }, delegate: request.delegate ?? [], subscription: { ...(request.newAccount ? { newAccount: true } : {}), ...(request.connectionId ? { connectionId: request.connectionId } : {}),
      apiContinuation: request.apiContinuation ?? null } }, options, { siwcPresentation: presentation });
  if (models.status !== 'connected') return { models, state: models.status };
  const latest = await loadConfiguredScopeContext(root, request.scopeId, options, 'read');
  const profiles = (latest.config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles ?? [];
  const profile = profiles.map(value => modelInvocationProfileSchema.parse(value)).find(row => row.scopeId === request.scopeId && JSON.stringify(row.reference) === JSON.stringify(models.reference));
  if (!profile) throw ErrorRegistry.createError('MODEL_INVOCATION_PROFILE_CONFLICT');
  const definition = siwcResponsesDefinitionSchema.parse(profile.adapter.definition);
  const view = await withConfiguredSiwc(root, request.scopeId, options, 'inspect', app => app.inspect(definition.connectionId));
  return { models, ...view, usageUrl: SIWC_USAGE_SUMMARY.manageUrl };
};
