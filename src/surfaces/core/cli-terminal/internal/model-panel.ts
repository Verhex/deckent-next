import { ErrorRegistry, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { ModelReference } from '#domain/index.js';
import type { ModelPanelChoice, ModelPanelSource, ModelPanelView } from '#surfaces/core/terminal-panels/index.js';
import type { ConfigCommandContext } from '#surfaces/core/config/index.js';
import type { TerminalLaunchContext } from './context.js';
import { providerDisplayName } from './provider-label.js';
import { modelInvocabilityText } from '#surfaces/core/model-invocability/index.js';

// The config surface reaches the terminal renderer; load it only when a default-model write happens (startup graph stays light).
const terminalConfigWrite = async (...args: Parameters<typeof import('#surfaces/core/config/index.js').terminalConfigWrite>) =>
  (await import('#surfaces/core/config/index.js')).terminalConfigWrite(...args);

type Host = Pick<TerminalLaunchContext, 'inspectDeclaredModels' | 'inspectModelActivation' | 'inspectModelBinding' | 'inspectModelCatalog' | 'describeTerminalChatPlan'
  | 'listSecretNames' | 'inspectProviderSpendAccount' | 'inspectInvocableModels' | 'inspectModelReadiness' | 'prepareModelSwitch' | 'providerConnect'> & Pick<ConfigCommandContext, 'configApplication' | 'resolveConfigPrincipal' | 'describeRuntimeService'>;
/** T4-B D1: the words of the setting that chose the model in effect (the `/model` window shows which layer wins). */
function winnerNote(source: string | null | undefined, model: string, locale: Locale): string | null {
  switch (source) {
    case 'project': return t('tui.model.winner.project', { model }, locale);
    case 'user-default': return t('tui.model.winner.userDefault', { model }, locale);
    case 'user': return t('tui.model.winner.user', { model }, locale);
    default: return null;
  }
}
const sameReference = (left: ModelReference, right: ModelReference) => left.providerId === right.providerId && left.providerVersion === right.providerVersion
  && left.modelId === right.modelId && left.modelVersion === right.modelVersion;
const errorCode = (error: unknown) => String((error as { code?: unknown })?.code ?? 'failed');
function readinessReason(error: unknown, locale: Locale): string {
  const params = (error as { params?: { requested?: unknown; currency?: unknown } })?.params;
  if (errorCode(error) === 'PROVIDER_SPEND_EXHAUSTED' && typeof params?.requested === 'number' && Number.isSafeInteger(params.requested)
    && params.requested >= 0 && typeof params.currency === 'string' && /^[A-Z]{3}$/u.test(params.currency)) return t('tui.model.reason.reservation', { amount: (params.requested / 100).toLocaleString(locale === 'tr' ? 'tr-TR' : 'en-US', { minimumFractionDigits: 2 }), currency: params.currency }, locale);
  const code = errorCode(error);
  if (code === 'MODEL_INVOCATION_REASONING_UNSUPPORTED') return t('tui.model.reason.reasoningOff', {}, locale);
  if (code === 'PROVIDER_SPEND_EXHAUSTED' || code === 'PROVIDER_SPEND_FROZEN' || code === 'PROVIDER_SPEND_UNAVAILABLE')
    return t('tui.model.reason.budget', { code }, locale);
  if (code === 'PROVIDER_SPEND_TARIFF_UNVERIFIED') return t('tui.model.reason.price', {}, locale);
  if (code === 'MODEL_INVOCATION_UNAVAILABLE' || code === 'OPENAI_CHAT_DEFINITION_INVALID' || code === 'OPENAI_CHAT_REQUEST_INVALID'
    || code === 'OPENAI_CHAT_MODEL_MISMATCH' || code === 'MODEL_INVOCATION_NATIVE_REQUEST_INVALID') return t('tui.model.reason.protocol', { code }, locale);
  return t('tui.model.reason.notRunnable', { code }, locale);
}

/** The /model window renders the shared scoped invocation read model; picking still rechecks through governed preparation. */
export function modelPanelSource(root: string, scopeId: string, host: Host, options: ConfigLoadOptions, locale: Locale): ModelPanelSource {
  const defaultBlocked = () => host.configApplication && host.resolveConfigPrincipal ? null : t('tui.model.defaultReadOnly', {}, locale);
  return {
    ...(host.prepareModelSwitch ? { async prepare(choice: ModelPanelChoice, reasoning?: 'off') {
      try { await host.prepareModelSwitch!(root, scopeId, choice.reference, options, reasoning); }
      catch (error) { throw ErrorRegistry.createError('TERMINAL_MODEL_SWITCH_REFUSED', { params: { reason: readinessReason(error, locale) } }); }
    } } : {}),
    async reasoningOffSupported(reference) {
      const declared = await host.inspectDeclaredModels?.(root, options);
      const plan = reference ? null : await host.describeTerminalChatPlan?.(root, options);
      const exact = reference ?? plan?.reference;
      return declared?.status === 'declared' && !!exact && declared.catalog.providers.some(provider => provider.id === exact.providerId && provider.version === exact.providerVersion
        && provider.models.some(model => model.id === exact.modelId && model.version === exact.modelVersion && model.protocols.some(protocol =>
          protocol.capabilities.some(capability => capability.id === 'chat-template-enable-thinking' && capability.version === 1 && capability.state === 'supported'))));
    },
    async inspect(): Promise<ModelPanelView> {
      const title = t('tui.model.title', { scope: scopeId }, locale), notes: string[] = [];
      const declared = host.inspectDeclaredModels ? await host.inspectDeclaredModels(root, options) : null;
      if (!declared || declared.status !== 'declared' || declared.catalog.providers.every(provider => provider.models.length === 0)) {
        return { title, choices: [], notes: [t('tui.model.noneDeclared', {}, locale)], defaultBlocked: defaultBlocked() };
      }
      const reading = await host.inspectInvocableModels?.(root, scopeId, options);
      if (reading?.models.some(model => model.availability.reason?.code === 'PROVIDER_SPEND_UNAVAILABLE')) notes.push(t('tui.budget.missing', { scope: scopeId }, locale));
      const plan = host.describeTerminalChatPlan ? await host.describeTerminalChatPlan(root, options).catch(() => null) : null;
      // Display names from the ledger catalog when it knows the model (best effort; the exact reference is always shown).
      const display = new Map<string, string>();
      if (host.inspectModelCatalog) {
        try {
          for (const channel of (await host.inspectModelCatalog(root, { schemaVersion: 1, scopeId }, options)).channels) {
            if (channel.access === 'denied') continue;
            for (const entry of channel.models) {
              const name = (entry.model as { displayName?: string }).displayName;
              if (name) display.set(`${channel.channelId}@${channel.providerVersion}/${entry.model.id}@${entry.model.version}`, name);
            }
          }
        } catch { /* names only; the reference stays the text */ }
      }
      const reservationBlocked = new Set<string>();
      const choices = await Promise.all(declared.catalog.providers.flatMap(provider => provider.models.map(async (model): Promise<ModelPanelChoice> => {
        const reference: ModelReference = { providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version };
        const exact = `${provider.id}@${provider.version}/${model.id}@${model.version}`;
        const entry = reading?.models.find(entry => sameReference(entry.reference, reference));
        const state = entry?.availability
          ?? { invocable: false as const, reason: { kind: 'unavailable' as const, code: 'MODEL_INVOCATION_UNAVAILABLE' } };
        const blocked = state.invocable ? null : modelInvocabilityText(state, locale);
        if (!state.invocable && state.reason.code === 'PROVIDER_SPEND_EXHAUSTED') reservationBlocked.add(exact);
        const command = entry && !state.invocable && (state.reason.kind === 'not-carried' || state.reason.kind === 'stale-activation')
          ? t('tui.model.command.activate', { scope: scopeId, provider: provider.id, providerVersion: provider.version, model: model.id, modelVersion: model.version,
            revision: state.reason.activationRevision ?? 0, digest: entry.bindingDigest, catalog: entry.catalogRevision }, locale) : null;
        return { reference, label: display.get(exact) ?? model.id, detail: modelInvocabilityText(state, locale),
          providerLabel: providerDisplayName(provider.id, host.providerConnect, locale),
          group: provider.id, blocked, exact: t('tui.model.exact', { reference: exact, native: model.nativeId }, locale), command,
          configured: plan?.reference ? sameReference(plan.reference, reference) : false };
      })));
      // A viable alternative passed all the same readiness checks in this snapshot; no price or cap guess.
      const alternative = reading ? choices.find(choice => choice.blocked === null) : undefined;
      for (const choice of choices) {
        if (reservationBlocked.has(`${choice.reference.providerId}@${choice.reference.providerVersion}/${choice.reference.modelId}@${choice.reference.modelVersion}`)) {
          (choice as { command: string | null }).command = alternative ? t('tui.model.budgetAlternative', { model: alternative.label, provider: alternative.providerLabel ?? alternative.group }, locale)
            : t('tui.model.budgetNoAlternative', {}, locale);
        }
      }
      const inEffect = plan?.reference ? choices.find(choice => sameReference(choice.reference, plan.reference!)) : undefined;
      const note = winnerNote(plan?.source, inEffect?.label ?? plan?.reference?.modelId ?? '-', locale);
      return { title, choices, notes: [...notes, ...(note ? [note] : [])], defaultBlocked: defaultBlocked() };
    },
    // "Also make default" (T4-B D1, Jev d84b248d): the user's `terminal.defaultModel` through the governed `/config` writer on the user (global)
    // layer — policy-checked, approval-aware, audited; the file is created when the person has none yet. Never the project file.
    ...(host.configApplication && host.resolveConfigPrincipal ? { async makeDefault(choice: { reference: ModelReference }) {
      const outcome = await terminalConfigWrite(root, { action: 'set', keyPath: 'terminal.defaultModel', value: { ...choice.reference }, layer: 'global' }, host, options, locale);
      const plan = host.describeTerminalChatPlan ? await host.describeTerminalChatPlan(root, options).catch(() => null) : null;
      // A project that names its own model keeps winning: the window then offers the two governed answers (owner 2026-10-08, Jev 77898686).
      const shadowed = outcome.status === 'applied' && plan?.source === 'project' && plan.reference;
      return { ...outcome, lines: [...outcome.lines, ...(shadowed ? [t('tui.model.defaultShadowed', {}, locale)] : [])],
        shadow: shadowed ? { projectModel: plan.reference!.modelId } : null };
    },
    // Only the project's `terminal.chat.reference` is written or removed (its chat siblings stay), through the same governed writer.
    async resolveShadow(choice: { reference: ModelReference; label: string }, action: 'remove' | 'align') {
      const outcome = await terminalConfigWrite(root, action === 'remove' ? { action: 'unset', keyPath: 'terminal.chat.reference', layer: 'project' }
        : { action: 'set', keyPath: 'terminal.chat.reference', value: { ...choice.reference }, layer: 'project' }, host, options, locale);
      return outcome.status !== 'applied' ? outcome : { ...outcome, lines: [action === 'remove' ? t('tui.model.shadow.removed', {}, locale)
        : t('tui.model.shadow.aligned', { model: choice.label }, locale), ...outcome.lines] };
    } } : {}),
  };
}
