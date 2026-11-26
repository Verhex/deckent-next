import { contextPolicySource } from '#composition/core/policy/index.js';
import { randomUUID } from 'node:crypto';
import { type ModelConnectCommand, type SubscriptionConnectionRequest, type SubscriptionConnectionResult } from '#domain/index.js';
import { configuredInvocationProfiles, subscriptionActor, ModelInvocationPolicyAuthorization, modelInvocationBillingAxis, assertAuthorityWitness, policySecretChangeAuthorization, policyVerdictRefusal, OAuthConnectionError, PersonalCustodyError } from '#engine/index.js';
import { PROVIDER_CONNECT_REGISTRY, OPENAI_CHAT_COMPLETIONS_FAMILY, SIWC_INFERENCE, SIWC_USAGE_SUMMARY, siwcResponsesDefinitionSchema, readSqliteSubscriptionUsageSummary, attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, installationSecretRoot, unsafeStoreDirectory, SIWC_PROTOCOL } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { DeckentError, ErrorRegistry } from '#platform/index.js';
import { withConfiguredSiwc } from '#composition/core/siwc/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { connectConfiguredModel } from './connect.js';
import { assertConfiguredActivationWitness } from '#composition/core/model-activation/index.js';

const MILLISECONDS_PER_DAY = 86_400_000;
/** One gate and one error boundary for the CLI and the terminal window: sign-in follows the kind's registry availability (logout and usage
 * stay reachable), and an OAuth/custody refusal reaches the person as its registered EN/TR message with the cause-specific next step. */
export async function executeConfiguredSiwc(root: string, request: SubscriptionConnectionRequest, options: ConfigLoadOptions,
  presentation: Readonly<{ signal?: AbortSignal; fallback?: (url: string) => void }> = {}): Promise<SubscriptionConnectionResult> {
  const kind = PROVIDER_CONNECT_REGISTRY.kinds.find(row => row.connect?.adapter === SIWC_INFERENCE.adapter.id);
  if (!kind || !kind.available && request.operation !== 'logout' && request.operation !== 'usage') throw ErrorRegistry.createError('MODEL_CONNECT_NOT_CONNECTABLE');
  try { return await siwcOperation(root, request, options, presentation, kind.id); }
  catch (error) {
    if (error instanceof DeckentError && error.params?.['connectionState'] === 'connected') throw error;
    // `connect` arrives already registered (connectConfiguredModel); login/logout/inspect arrive as the OAuth owner's typed refusal.
    const typed = error instanceof OAuthConnectionError || error instanceof PersonalCustodyError ? { code: error.code, reason: error.reason }
      : error instanceof DeckentError && error.code === 'SIWC_STORE_NOT_PERSONAL' ? { code: error.code, reason: error.params?.['reason'] } : null;
    if (!typed) throw error;
    // The person's own terminal learns which folder is open and its mode (ssh-style); the refusal itself carries only the reason.
    const storeRoot = typed.reason === 'unsafe-root' ? installationSecretRoot(options.env ?? process.env, options.platform) : null;
    const open = storeRoot && process.getuid ? await unsafeStoreDirectory(storeRoot, process.getuid()).catch(() => null) : null;
    throw ErrorRegistry.createError(typed.code, { params: { ...(typeof typed.reason === 'string' ? { reason: typed.reason } : {}), ...(open ? { path: open.path, mode: open.mode, folder: open.parent ? 'parent' : 'root' } : {}) } });
  }
}
async function siwcOperation(root: string, request: SubscriptionConnectionRequest, options: ConfigLoadOptions,
  presentation: Readonly<{ signal?: AbortSignal; fallback?: (url: string) => void }>, connection: string): Promise<SubscriptionConnectionResult> {
  const observes = request.operation === 'prepare' || request.operation === 'usage';
  const baseAuthority = observes || request.operation === 'logout';
  if (baseAuthority) await assertAuthorityWitness('models.login', localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined),
    { attest: () => attestLocalInteractiveTerminal() });
  const context = await loadConfiguredScopeContext(root, request.scopeId, options, request.operation === 'logout' ? 'write' : 'read');
  if (!baseAuthority) await assertConfiguredActivationWitness('models.login', context, options);
  if (subscriptionActor(context.principal).principalClass !== 'person') throw ErrorRegistry.createError('HEADLESS_PERSON_REQUIRED');
  if (request.operation === 'prepare' || request.operation === 'usage') {
    const profiles = configuredInvocationProfiles(context.config), apiTargets = [], references = [];
    for (const profile of profiles) { // An unauthorized row is skipped without disclosure.
      const metered = modelInvocationBillingAxis(profile) === 'metered' && profile.protocol.family === OPENAI_CHAT_COMPLETIONS_FAMILY;
      const usage = request.operation === 'usage' && profile.adapter.id === SIWC_INFERENCE.adapter.id && profile.adapter.definition['connectionId'] === request.connectionId;
      if (profile.scopeId !== request.scopeId || !metered && !usage) continue;
      try { await new ModelInvocationPolicyAuthorization(contextPolicySource(context, context.document)).authorize('inspect', profile, context.principal); } catch { continue; }
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
  if (request.operation === 'login' && !request.newAccount) await authorizeSiwcConnect(context, request.scopeId, request.connectionId);
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
  const models = await connectConfiguredModel(root, { schemaVersion: 1, commandId: randomUUID(), scopeId: request.scopeId, connection,
    model: { pull: 'available' }, delegate: request.delegate ?? [], subscription: { ...(request.newAccount ? { newAccount: true } : {}), ...(request.connectionId ? { connectionId: request.connectionId } : {}),
      apiContinuation: request.apiContinuation ?? null } }, options, { siwcPresentation: presentation });
  if (models.status !== 'connected') return { models, state: models.status };
  const latest = await loadConfiguredScopeContext(root, request.scopeId, options, 'read');
  const profiles = configuredInvocationProfiles(latest.config);
  const profile = profiles.find(row => row.scopeId === request.scopeId && JSON.stringify(row.reference) === JSON.stringify(models.reference));
  if (!profile) throw ErrorRegistry.createError('MODEL_INVOCATION_PROFILE_CONFLICT');
  const definition = siwcResponsesDefinitionSchema.parse(profile.adapter.definition);
  const view = await withConfiguredSiwc(root, request.scopeId, options, 'inspect', app => app.inspect(definition.connectionId));
  return { models, ...view, usageUrl: SIWC_USAGE_SUMMARY.manageUrl };
};
/** A connected account's lease authorizes a refresh only if one is due; reauthorization requires that exact account's set permission.
 * Returns the deciding secret-cell decision, re-runnable on a later policy document, when one was made. */
export async function authorizeSiwcConnect(context: Awaited<ReturnType<typeof loadConfiguredScopeContext>>, scopeId: string, connectionId?: string,
  request?: { root: string; options: ConfigLoadOptions; command: ModelConnectCommand }) {
  type Context = typeof context;
  if (request && context.installationId) {
    if (request.command.subscription?.newAccount) return;
    const rows = await withConfiguredSiwc(request.root, scopeId, request.options, 'inspect', app => app.list()).catch(() => null);
    const selected = connectionId ? rows?.find(row => row.connectionId === connectionId) : rows?.length === 1 ? rows[0] : undefined;
    if (rows && (!selected || selected.state === 'connected' && selected.planUse)) return;
    connectionId = selected?.connectionId ?? connectionId;
  }
  const name = connectionId ? `${SIWC_PROTOCOL.connectionSecretPrefix}${connectionId.replaceAll('-', '').toUpperCase()}` : SIWC_PROTOCOL.hostSecretName;
  const decide = async (at: Context) => {
    const decision = await policySecretChangeAuthorization(at.document, at.principal)({ principal: at.principal, scopeId, name, action: 'set' });
    const refusal = policyVerdictRefusal(decision.effect, { deny: 'OAUTH_CONNECTION_DENIED' });
    if (refusal) throw new OAuthConnectionError(refusal);
    return decision;
  };
  await decide(context);
  return decide;
}
