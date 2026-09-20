import { isDeepStrictEqual } from 'node:util';
import { modelInvocationProfileSchema,
  type ModelBindingDefinition, type ModelInvocationProfile } from '#domain/index.js';
import { ProviderSpendError, type ModelInvocationNativePort,
  type ModelInvocationSpendingAuthority, type ModelInvocationSpendingInput } from '#engine/index.js';
import { createOpenAiChatNativePort, OPENAI_CHAT_HTTP_ADAPTER_ID, OPENAI_CHAT_HTTP_ADAPTER_VERSION,
  parseOpenAiChatHttpDefinition, createOpenRouterPricedNative, OPENROUTER_CHAT_HTTP_ADAPTER_ID,
  OPENROUTER_CHAT_HTTP_ADAPTER_VERSION, parseOpenRouterChatDefinition,
  type OpenRouterPricedNative, fetchOpenRouterTariff, type OpenRouterMetadataObservation,
  providerSpendingSchema } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { scopedInvocationCredentialResolver } from './credential.js';
import type { loadInvocationContext } from './context.js';
import { invocationEffectAuthority } from './authority.js';

type InvocationNativeContext = Awaited<ReturnType<typeof loadInvocationContext>>;

function budgetFrom(config: Record<string, unknown>, scopeId: string) {
  const parsed = providerSpendingSchema.safeParse(config['provider_spending']);
  if (!parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
  const value = parsed.data.budgets.find(candidate => candidate.scopeId === scopeId);
  if (!value) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
  return value;
}

/** One invocation-scoped registry owns the exact OpenRouter native/quote pair. Metadata acquisition
 * is unauthenticated and completes before pure preparation; credential resolution remains send-only.
 */
export function createConfiguredModelInvocationNative(context: InvocationNativeContext, options: ConfigLoadOptions) {
  let selected: { profile: ModelInvocationProfile; priced: OpenRouterPricedNative;
    cell: { observation?: OpenRouterMetadataObservation } } | undefined;
  const natives = Object.freeze({
    resolve(profileInput: ModelInvocationProfile): ModelInvocationNativePort | null {
      const profile = modelInvocationProfileSchema.parse(profileInput);
      if (profile.adapter.id === OPENAI_CHAT_HTTP_ADAPTER_ID && profile.adapter.version === OPENAI_CHAT_HTTP_ADAPTER_VERSION) {
        const definition = parseOpenAiChatHttpDefinition(profile.adapter.definition);
        return createOpenAiChatNativePort({ resolveCredential: scopedInvocationCredentialResolver(context, profile, definition.authentication, options) });
      }
      if (profile.adapter.id !== OPENROUTER_CHAT_HTTP_ADAPTER_ID || profile.adapter.version !== OPENROUTER_CHAT_HTTP_ADAPTER_VERSION) return null;
      const definition = parseOpenRouterChatDefinition(profile.adapter.definition);
      const cell: { observation?: OpenRouterMetadataObservation } = {};
      const priced = createOpenRouterPricedNative({
        currentObservation: () => {
          if (!cell.observation) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
          return cell.observation;
        },
        now: Date.now,
        resolveCredential: scopedInvocationCredentialResolver(context, profile, definition.transport.authentication, options),
      });
      selected = { profile, priced, cell };
      return priced.native;
    },
    async acquire(input: { readonly profile: ModelInvocationProfile; readonly definition: ModelBindingDefinition;
      readonly native: ModelInvocationNativePort }, signal?: AbortSignal): Promise<void> {
      if (input.profile.adapter.id !== OPENROUTER_CHAT_HTTP_ADAPTER_ID) return;
      const current = selected;
      if (!current || input.native !== current.priced.native || !isDeepStrictEqual(input.profile, current.profile)) {
        throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
      }
      // Reject absent/revoked scope authority before the metadata network effect.
      budgetFrom(await invocationEffectAuthority(context, input.profile)(signal), input.profile.scopeId);
      const definition = parseOpenRouterChatDefinition(input.profile.adapter.definition);
      current.cell.observation = await fetchOpenRouterTariff({ endpoint: definition.metadataEndpoint,
        modelId: input.definition.model.nativeId, endpointTag: definition.endpointTag,
        ...definition.metadataLimits, ...(definition.transport.tls ? { caPem: definition.transport.tls.caPem } : {}) }, Date.now, signal);
    },
  });
  const spending: ModelInvocationSpendingAuthority = Object.freeze({
    async authorize(input: ModelInvocationSpendingInput) {
      const current = selected;
      if (!current || input.profile.adapter.id !== OPENROUTER_CHAT_HTTP_ADAPTER_ID
        || !isDeepStrictEqual(input.profile, current.profile)) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
      const budget = budgetFrom(await context.freshConfig(), input.command.scopeId);
      return Object.freeze({ budget, quote: current.priced.quote(input) });
    },
  });
  return Object.freeze({ natives, spending });
}
