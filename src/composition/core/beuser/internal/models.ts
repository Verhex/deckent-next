import { createBeuserModelPort, BeuserCallBudget, BeuserContractError, providerSpendLocalZeroTariff, providerSpendLocalZeroTariffProfile, type BeuserContext, type BeuserModelComposition } from '#engine/index.js';
import { openSqliteModelActivationReader, extractOpenAiChatTextFromInvocation } from '#adapters/index.js';
import { inspectConfiguredModelCatalog } from '#composition/core/model-activation/index.js';
import { invokeConfiguredModelAs, prepareConfiguredModelAs } from '#composition/core/model-invocation/index.js';
import { prepareTerminalChatCommand } from '#composition/core/terminal-chat/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { modelInvocationCommandSchema, openAiChatUsageSchema } from '#domain/index.js';
import { currencyAmountText } from '#platform/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';

/** Role/activation/catalog and invocation authority are re-read for every call. No host fallback or hidden model substitution. */
export function configuredBeuserModels(root: string, options: ConfigLoadOptions, context: BeuserContext,
  choices: BeuserModelComposition['choices'], contributorModels: readonly unknown[], budget: BeuserCallBudget, completionTokens: number,
  evaluatorInput: () => unknown) {
  const pins = new Map<string, Awaited<ReturnType<typeof prepareConfiguredModelAs>>>();
  const models = createBeuserModelPort({ choices, contributorModels, walkerModels: [], independence: 'required', credential: undefined,
    now: Date.now,
    async sources(ctx) {
      const c = await loadConfiguredScopeContext(root, ctx.binding.identity.scopeId, options, 'read');
      const catalog = await inspectConfiguredModelCatalog(root, { schemaVersion: 1, scopeId: ctx.binding.identity.scopeId }, options);
      return { roles: { modelRoles: c.config['model_roles'], providerCatalog: c.config['provider_catalog'], async activation(scopeId, reference) {
        const reader = await openSqliteModelActivationReader(await c.path(), { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
        try { return await reader.loadRecord(scopeId, reference); } finally { reader.close(); }
      } }, profiles: c.config['provider_invocation_profiles'], catalog };
    },
    async prepare(ctx, role, reference, input, remaining) {
      const prepared = await prepareTerminalChatCommand({ projectRoot: root, scopeId: ctx.binding.identity.scopeId, options,
        messages: [{ role: 'user', content: JSON.stringify(role === 'beuser-evaluator' ? { input, evidence: evaluatorInput() } : input) }] }, false, reference, { maxCompletionTokens: completionTokens });
      const pinned = await prepareConfiguredModelAs(root, prepared.command, ctx.principal, options, ctx.signal);
      const profile = pinned.profile;
      const spending = pinned.spending;
      const measured = pinned.measurement;
      if (!measured || measured.quality !== 'provider-count') throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE');
      const tokens = measured.promptTokens + completionTokens;
      if (!profile?.contextWindowTokens || !Number.isSafeInteger(measured.promptTokens) || measured.promptTokens < 0
        || !Number.isSafeInteger(tokens) || tokens > profile.contextWindowTokens || (measured.windowTokens !== null && tokens > measured.windowTokens)
        || tokens > remaining.tokens || profile.limits.timeoutMs > ctx.limits.maxWallMs
        || profile.limits.responseMaxBytes > ctx.limits.maxArtifactBytes) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE');
      const local = profile.schemaVersion === 2 && profile.billingAxis === 'local' && providerSpendLocalZeroTariffProfile(profile)
        && !spending?.budget && (!spending?.quote || providerSpendLocalZeroTariff(profile, spending.quote));
      if ((!spending?.quote && !local && !(profile.schemaVersion === 2 && profile.billingAxis === 'subscription'))
        || spending?.quote && spending.quote.currency !== remaining.currency) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE');
      const cost = spending?.quote ? Number(currencyAmountText(spending.quote.maxChargeMinorUnits, remaining.currency, 'en', false).replaceAll(',', '')) : 0;
      pins.set(prepared.command.commandId, pinned);
      return { command: prepared.command, tokens, cost, currency: remaining.currency };
    },
    tokensUsed(result) {
      const usage = openAiChatUsageSchema.safeParse(result.response?.usage);
      return usage.success ? usage.data.total_tokens : null;
    },
    invocation: { async invoke(input, _credential, signal) {
      const command = modelInvocationCommandSchema.parse(input) as import('#domain/index.js').ModelInvocationCommand;
      const pin = pins.get(command.commandId); if (!pin) throw new BeuserContractError('BEUSER_INPUT_INVALID');
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      try { return await invokeConfiguredModelAs(root, command, context.principal, options, signal, {
        async profile(value) { if (!same(value, pin.profile)) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE'); },
        spending(value) { if (!same(value, pin.spending)) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE'); },
      }); } finally { pins.delete(command.commandId); }
    } },
    async cancel() { throw new BeuserContractError('BEUSER_INPUT_INVALID'); },
  }, budget);
  return { models, decode: (value: Parameters<typeof extractOpenAiChatTextFromInvocation>[0]) => {
    const text = extractOpenAiChatTextFromInvocation(value); if (!text) throw new BeuserContractError('BEUSER_INPUT_INVALID');
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).some(key => !['kind', 'key', 'text', 'ms'].includes(key))) throw new BeuserContractError('BEUSER_INPUT_INVALID');
    return { schemaVersion: 1, binding: context.binding, action: parsed };
  } };
}
