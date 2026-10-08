import { isDeepStrictEqual } from 'node:util';
import { modelInvocationProfileSchema, type ModelBindingDefinition, type ModelInvocationProfile } from '#domain/index.js';
import { ProviderSpendError, type ModelInvocationNativePort, type ModelInvocationSpendingAuthority, type ModelInvocationSpendingInput } from '#engine/index.js';
import { createOpenAiChatPricedNative, isOpenAiChatHttpAdapter, parseOpenAiChatHttpDefinition, createOpenRouterPricedNative, OPENROUTER_CHAT_HTTP_ADAPTER_ID, OPENROUTER_CHAT_HTTP_ADAPTER_VERSION, parseOpenRouterChatDefinition, type OpenRouterPricedNative, fetchOpenRouterTariff, createOpenRouterTariffCache, type OpenRouterMetadataObservation, providerSpendingBudgetFor, openSqliteProviderSpendAccountReader, createAnthropicMessagesPricedNative, parseAnthropicMessagesDefinition, createDecisionHttpNativePort, decisionHttpAdapter, parseDecisionHttpDefinition, quoteDecisionHttpOperatorTariff, ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID, ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION, type AnthropicMessagesPricedNative, localPrefixCacheSalt } from '#adapters/index.js';
import type { ConfigLoadOptions, TrustedClock } from '#platform/index.js';
import { scopedInvocationCredentialResolver } from './credential.js';
import type { loadInvocationContext } from './context.js';
import { invocationEffectAuthority } from './authority.js';
/** One tariff per (endpoint, model, tag, CA) for the process lifetime of the freshness window: calls inside it make no metadata request. The fetcher is resolved per miss. */
const tariffCache = createOpenRouterTariffCache((options, now, signal) => fetchOpenRouterTariff(options, now, signal));
type InvocationNativeContext = Awaited<ReturnType<typeof loadInvocationContext>>;
/** VLLM-CACHE-SALT: the installation's own salt secret (created on first use in an older installation), never the integrity key. */
const installationCacheSalt = (context: InvocationNativeContext, scopeId: string) => localPrefixCacheSalt(context.layout, scopeId, context.config.approvals.keyFile, true);
/** One invocation-scoped registry owns the exact OpenRouter native/quote pair. Metadata acquisition is unauthenticated and completes before pure preparation; credential resolution remains send-only. Tariff acquisition, preparation, quote and send read one trusted clock: the host wall may step backwards between them (I40), and the platform floor, not raw Date.now, keeps them ordered within this process. */
export function createConfiguredModelInvocationNative(context: InvocationNativeContext, options: ConfigLoadOptions, clock: TrustedClock) {
  const now = () => clock.sample().wallMs;
  const budgetFor = async (scopeId: string) => {
    const configured = providerSpendingBudgetFor(await context.freshConfig(), scopeId);
    const reader = await openSqliteProviderSpendAccountReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs });
    try {
      const snapshot = await reader.loadSnapshot({ schemaVersion: 1, scopeId, budgetId: configured.budgetId, budgetRevision: configured.revision });
      const current = snapshot.checkpoint?.account.budget;
      if (!current) return configured;
      if (current.budgetId !== configured.budgetId || current.currency !== configured.currency || current.revision < configured.revision)
        throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
      return current;
    } finally { reader.close(); }
  };
  let selected: { profile: ModelInvocationProfile; priced: OpenRouterPricedNative; cell: { observation?: OpenRouterMetadataObservation } } | undefined;
  let anthropic: { profile: ModelInvocationProfile; priced: AnthropicMessagesPricedNative } | undefined;
  let openai: ReturnType<typeof createOpenAiChatPricedNative> | undefined;
  const natives = Object.freeze({
    resolve(profileInput: ModelInvocationProfile): ModelInvocationNativePort | null {
      const profile = modelInvocationProfileSchema.parse(profileInput);
      if(profile.adapter.id===decisionHttpAdapter.id&&profile.adapter.version===decisionHttpAdapter.version){
        const definition=parseDecisionHttpDefinition(profile.adapter.definition); return createDecisionHttpNativePort({resolveCredential:scopedInvocationCredentialResolver(context,profile,definition.authentication,options)});
      }
      if (profile.adapter.id === ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID && profile.adapter.version === ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION) {
        const definition = parseAnthropicMessagesDefinition(profile.adapter.definition);
        const priced = createAnthropicMessagesPricedNative({ resolveCredential: scopedInvocationCredentialResolver(context, profile, definition.authentication, options) });
        anthropic = { profile, priced }; return priced.native;
      }
      if (isOpenAiChatHttpAdapter(profile.adapter)) {
        const definition = parseOpenAiChatHttpDefinition(profile.adapter.definition); openai = createOpenAiChatPricedNative({ resolveCredential: scopedInvocationCredentialResolver(context, profile, definition.authentication, options),
          cacheSalt: scopeId => installationCacheSalt(context, scopeId) }); return openai.native;
      }
      if (profile.adapter.id !== OPENROUTER_CHAT_HTTP_ADAPTER_ID || profile.adapter.version !== OPENROUTER_CHAT_HTTP_ADAPTER_VERSION) return null;
      const definition = parseOpenRouterChatDefinition(profile.adapter.definition); const cell: { observation?: OpenRouterMetadataObservation } = {};
      const priced = createOpenRouterPricedNative({
        currentObservation: () => { if (!cell.observation) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE'); return cell.observation; },
        now, resolveCredential: scopedInvocationCredentialResolver(context, profile, definition.transport.authentication, options),
      });
      selected = { profile, priced, cell }; return priced.native;
    },
    async acquire(input: { readonly profile: ModelInvocationProfile; readonly definition: ModelBindingDefinition; readonly native: ModelInvocationNativePort }, signal?: AbortSignal): Promise<void> {
      if (input.profile.adapter.id !== OPENROUTER_CHAT_HTTP_ADAPTER_ID) return;
      const current = selected;
      if (!current || input.native !== current.priced.native || !isDeepStrictEqual(input.profile, current.profile)) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
      // Reject absent/revoked scope authority before the metadata network effect.
      providerSpendingBudgetFor(await invocationEffectAuthority(context, input.profile)(signal), input.profile.scopeId);
      const definition = parseOpenRouterChatDefinition(input.profile.adapter.definition);
      current.cell.observation = await tariffCache.get({ endpoint: definition.metadataEndpoint, modelId: input.definition.model.nativeId, endpointTag: definition.endpointTag,
        ...definition.metadataLimits, ...(definition.transport.tls ? { caPem: definition.transport.tls.caPem } : {}) }, now, signal);
    },
  });
  const spending: ModelInvocationSpendingAuthority = Object.freeze({
    async authorize(input: ModelInvocationSpendingInput) {
      if(input.profile.adapter.id===decisionHttpAdapter.id&&input.profile.adapter.version===decisionHttpAdapter.version){
        const budget=await budgetFor(input.command.scopeId); return Object.freeze({budget,quote:quoteDecisionHttpOperatorTariff(input)});
      }
      if (isOpenAiChatHttpAdapter(input.profile.adapter)) {
        // Operator-declared tariff: the same scope budget, reservation and ledger settlement as priced providers.
        const budget = await budgetFor(input.command.scopeId); return Object.freeze({ budget, quote: (() => { if (!openai) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE'); return openai.quote(input); })() });
      }
      if (input.profile.adapter.id === ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID && input.profile.adapter.version === ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION) {
        // Published tariff from the profile: the same scope budget and reservation as priced providers (settlement limit: review.md, checkpoint A).
        if (!anthropic || !isDeepStrictEqual(input.profile, anthropic.profile)) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
        const budget = await budgetFor(input.command.scopeId); return Object.freeze({ budget, quote: anthropic.priced.quote(input) });
      }
      const current = selected;
      if (!current || input.profile.adapter.id !== OPENROUTER_CHAT_HTTP_ADAPTER_ID
        || !isDeepStrictEqual(input.profile, current.profile)) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
      const budget = await budgetFor(input.command.scopeId); return Object.freeze({ budget, quote: current.priced.quote(input) });
    },
  });
  return Object.freeze({ natives, spending });
}
