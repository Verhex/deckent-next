import { ErrorRegistry, loadConfig, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { MODEL_TIERS, type ModelReference, type ModelTier } from '#domain/index.js';
import { composeModelRolePolicy } from '#engine/index.js';
import type { ModelPanelChoice, ModelPanelSource, ModelPanelView } from '#surfaces/core/terminal-panels/index.js';
import type { ConfigCommandContext } from '#surfaces/core/config/index.js';
import type { TerminalLaunchContext } from './context.js';
import { providerDisplayName } from '#surfaces/core/terminal-provider/index.js';
import { modelInvocabilityText, reservationAmountText } from '#surfaces/core/model-invocability/index.js';

// The config surface reaches the terminal renderer; load it only when a default-model write happens (startup graph stays light).
const terminalConfigWrite = async (...args: Parameters<typeof import('#surfaces/core/config/index.js').terminalConfigWrite>) =>
  (await import('#surfaces/core/config/index.js')).terminalConfigWrite(...args);
const setBrainOffer = async (...args: Parameters<typeof import('#surfaces/core/config/index.js').setBrainOffer>) =>
  (await import('#surfaces/core/config/index.js')).setBrainOffer(...args);

type Host = Pick<TerminalLaunchContext, 'admitModelActivation' | 'inspectDeclaredModels' | 'inspectModelActivation' | 'inspectModelBinding' | 'inspectModelCatalog' | 'describeTerminalChatPlan'
  | 'listSecretNames' | 'inspectBrainModels' | 'inspectProviderSpendAccount' | 'inspectInvocableModels' | 'inspectModelReadiness' | 'prepareModelSwitch' | 'providerConnect' | 'siwc'> & Pick<ConfigCommandContext, 'configApplication' | 'resolveConfigPrincipal' | 'describeRuntimeService'>;
/** T4-B D1: the words of the setting that chose the model in effect (the `/model` window shows which layer wins). */
function winnerNote(source: string | null | undefined, model: string, locale: Locale): string | null {
  switch (source) {
    case 'project': return t('tui.model.winner.project', { model }, locale);
    case 'user-default': return t('tui.model.winner.userDefault', { model }, locale);
    case 'user': return t('tui.model.winner.user', { model }, locale); case 'connected': return t('tui.model.winner.connected', { model }, locale);
    default: return null;
  }
}
const sameReference = (left: ModelReference, right: ModelReference) => left.providerId === right.providerId && left.providerVersion === right.providerVersion
  && left.modelId === right.modelId && left.modelVersion === right.modelVersion;
/** R9b: the person's Brain model in effect (`brain_planner.reference`, project over user), or null. */
const brainModel = (root: string, options: ConfigLoadOptions) => loadConfig(root, options)
  .then(config => (config['brain_planner'] as { reference?: ModelReference } | undefined)?.reference ?? null, () => null);
/** Owner 2026-11-06: the catalog models (channel id, exact model id) the person switched off as Brain (`brain_planner.excluded`). */
const brainSwitchedOff = (root: string, options: ConfigLoadOptions) => loadConfig(root, options)
  .then(config => (config['brain_planner'] as { excluded?: readonly Readonly<{ channelId: string; modelId: string }>[] } | undefined)?.excluded ?? [], () => []);
/** In an attached project (no installation of its own; its scope id is generated) the person reads the folder name; the scope id stays in details. */
export const attachedScopeLabel = (root: string, scopeId: string, options: ConfigLoadOptions) => loadConfig(root, options)
  .then(config => (config['installation'] as { sharedRegistrationId?: unknown } | undefined)?.sharedRegistrationId ? basename(root) || scopeId : scopeId, () => scopeId);
/** R2c: the scope's invocation profiles' declared billing axes (an undeclared axis stays metered for the budget row). */
const billingAxes = (root: string, options: ConfigLoadOptions) => loadConfig(root, options).then(config => ((config['provider_invocation_profiles'] as
  { profiles?: readonly Readonly<{ scopeId: string; reference: ModelReference; billingAxis?: unknown }>[] } | undefined)?.profiles ?? []), () => []);
/** F2-14: each catalog model's tier from the tier/role registry (`model_roles`, the only tier owner), or none when the policy is unreadable. */
const modelTiers = (root: string, options: ConfigLoadOptions) => loadConfig(root, options).then(config => composeModelRolePolicy(config['model_roles']).models, () => []);
/** F2-14 (owner: newest and higher tier first): runnable first, then the higher registry tier (unknown last), then the catalog's own `priority`
 * (lower first; undeclared after declared), then the declared order. The catalog carries no release date, so recency is the catalog's own order. */
export function orderModelChoices<T extends Readonly<{ blocked: string | null }>>(choices: readonly T[], facts: (choice: T) => Readonly<{ tier: ModelTier | null; priority: number | null }>): T[] {
  const rank = (choice: T, index: number) => { const fact = facts(choice);
    return [Number(choice.blocked !== null), fact.tier === null ? MODEL_TIERS.length : MODEL_TIERS.length - 1 - MODEL_TIERS.indexOf(fact.tier), fact.priority ?? Number.MAX_SAFE_INTEGER, index]; };
  const ranked = choices.map((choice, index) => ({ choice, key: rank(choice, index) }));
  return ranked.sort((a, b) => { for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i]! - b.key[i]!; return 0; }).map(row => row.choice);
}
const errorCode = (error: unknown) => String((error as { code?: unknown })?.code ?? 'failed');
function readinessReason(error: unknown, locale: Locale): string {
  const params = (error as { params?: { requested?: unknown; currency?: unknown } })?.params;
  if (errorCode(error) === 'PROVIDER_SPEND_EXHAUSTED' && typeof params?.requested === 'number' && Number.isSafeInteger(params.requested)
    && params.requested >= 0 && typeof params.currency === 'string' && /^[A-Z]{3}$/u.test(params.currency)) return t('tui.model.reason.reservation', { amount: reservationAmountText(params.requested, params.currency, locale), currency: params.currency }, locale);
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
  /** BeUser AYSE-16: the exact model's declared protocol family and all its capabilities, or null when it is not declared. */
  const protocolOf = async (reference: ModelReference | null) => {
    const declared = await host.inspectDeclaredModels?.(root, options), exact = reference ?? (await host.describeTerminalChatPlan?.(root, options))?.reference;
    const model = declared?.status === 'declared' && exact ? declared.catalog.providers.find(row => row.id === exact.providerId && row.version === exact.providerVersion)?.models.find(row => row.id === exact.modelId && row.version === exact.modelVersion) : undefined;
    return model?.protocols.length ? { family: model.protocols[0]!.family, capabilities: model.protocols.flatMap(protocol => protocol.capabilities) } : null;
  };
  return {
    ...(host.prepareModelSwitch ? { async prepare(choice: ModelPanelChoice, reasoning?: 'off') {
      try { await host.prepareModelSwitch!(root, scopeId, choice.reference, options, reasoning); }
      catch (error) { throw ErrorRegistry.createError('TERMINAL_MODEL_SWITCH_REFUSED', { params: { reason: readinessReason(error, locale) } }); }
    } } : {}),
    ...(host.admitModelActivation && host.inspectModelBinding && host.inspectModelActivation ? { async fix(choice: ModelPanelChoice, action: 'activate' | 'deactivate' | 'reconcile') {
      const binding = await host.inspectModelBinding!(root, choice.reference, options);
      if (binding.status !== 'declared') throw ErrorRegistry.createError('MODEL_ACTIVATION_NOT_FOUND');
      const current = await host.inspectModelActivation!(root, { schemaVersion: 1, scopeId, reference: choice.reference }, options);
      const workers = await host.inspectModelCatalog?.(root, { schemaVersion: 1, scopeId, channelId: choice.reference.providerId }, options);
      const channel = workers?.channels.find(row => row.access === 'allowed');
      const row = channel?.access === 'allowed' ? channel.models.find(row => row.model.id === choice.reference.modelId && row.model.version === choice.reference.modelVersion) : null;
      const token = JSON.stringify([current.activation?.revision ?? 0, channel?.access === 'allowed' ? channel.activation : null, row?.activation ?? null, binding.catalogRevision, binding.binding.digest]);
      if (choice.stateToken !== token) throw ErrorRegistry.createError('MODEL_ACTIVATION_REVISION_CONFLICT');
      const desired = action === 'reconcile' ? current.activation?.state === 'active' ? 'activate' : 'deactivate' : action;
      if (desired === 'deactivate' && !current.activation) throw ErrorRegistry.createError('MODEL_ACTIVATION_NOT_FOUND');
      await host.admitModelActivation!(root, { schemaVersion: 1, commandId: `model-state-${randomUUID()}`, scopeId, reference: choice.reference,
        action: desired, expectedRevision: current.activation?.revision ?? 0, expectedBinding: binding.binding,
        ...(desired === 'activate' ? { catalogRevision: binding.catalogRevision } : {}) } as never, options);
    } } : {}),
    async reasoningOffSupported(reference) { return (await protocolOf(reference))?.capabilities.some(row => row.id === 'chat-template-enable-thinking' && row.version === 1 && row.state === 'supported') ?? false; },
    async toolsDeclared(reference) { const protocol = await protocolOf(reference); const state = protocol?.capabilities.find(row => row.id === 'tool-calls' && row.version === 1)?.state; return state === 'supported' ? true : state === 'unsupported' ? false : null; }, // domain OPENAI_CHAT_TOOL_CALLS_CAPABILITY
    async inspect(): Promise<ModelPanelView> {
      const label = await attachedScopeLabel(root, scopeId, options), title = t('tui.model.title', { scope: label }, locale);
      const notes: string[] = label === scopeId ? [] : [t('tui.model.scopeNote', { scope: scopeId }, locale)];
      const declared = host.inspectDeclaredModels ? await host.inspectDeclaredModels(root, options) : null;
      if (!declared || declared.status !== 'declared' || declared.catalog.providers.every(provider => provider.models.length === 0)) {
        return { title, choices: [], notes: [...notes, host.providerConnect ? t('tui.model.noneDeclared', {}, locale) : t('tui.model.noneDeclaredNoConnect', {}, locale)], defaultBlocked: defaultBlocked() };
      }
      const reading = await host.inspectInvocableModels?.(root, scopeId, options);
      if (reading?.models.some(model => model.availability.reason?.code === 'PROVIDER_SPEND_UNAVAILABLE')) notes.push(t('tui.budget.missing', { scope: scopeId }, locale));
      const plan = host.describeTerminalChatPlan ? await host.describeTerminalChatPlan(root, options).catch(() => null) : null;
      // Display names from the ledger catalog when it knows the model (best effort; the exact reference is always shown).
      const display = new Map<string, string>(), priority = new Map<string, number>(), workers = new Map<string, boolean>(), workerTokens = new Map<string, readonly unknown[]>();
      if (host.inspectModelCatalog) {
        try {
          for (const channel of (await host.inspectModelCatalog(root, { schemaVersion: 1, scopeId }, options)).channels) {
            if (channel.access === 'denied') continue;
            for (const entry of channel.models) {
              workerTokens.set(`${channel.channelId}@${channel.providerVersion}/${entry.model.id}@${entry.model.version}`, [channel.activation, entry.activation]);
              workers.set(`${channel.channelId}@${channel.providerVersion}/${entry.model.id}@${entry.model.version}`, channel.activation?.state === 'active' && entry.activation?.state === 'active');
              const name = (entry.model as { displayName?: string }).displayName;
              if (name) display.set(`${channel.channelId}@${channel.providerVersion}/${entry.model.id}@${entry.model.version}`, name);
              const order = (entry.model as { priority?: number }).priority;
              if (order !== undefined) priority.set(`${channel.channelId}@${channel.providerVersion}/${entry.model.id}@${entry.model.version}`, order);
            }
          }
        } catch { /* names only; the reference stays the text */ }
      }
      const reservationBlocked = new Set<string>(), recommended = new Set<string>();
      // R9b (owner D3, 2026-11-06): the models recommended for the Brain role (tier or a current exception) and the one chosen; every model may be
      // chosen, the /do gate decides (an installation's written model_roles policy binds there).
      const brainRows = await host.inspectBrainModels?.(root, scopeId, options).catch(() => null), brainNow = await brainModel(root, options), switchedOff = await brainSwitchedOff(root, options);
      const writer = Boolean(host.configApplication && host.resolveConfigPrincipal), axes = await billingAxes(root, options), tiers = await modelTiers(root, options);
      const natives = new Map<string, string>(declared.catalog.providers.flatMap(provider => provider.models.map(model => [`${provider.id}@${provider.version}/${model.id}@${model.version}`, model.nativeId] as const)));
      const choices = await Promise.all(declared.catalog.providers.flatMap(provider => provider.models.map(async (model): Promise<ModelPanelChoice> => {
        const reference: ModelReference = { providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version };
        const exact = `${provider.id}@${provider.version}/${model.id}@${model.version}`;
        const entry = reading?.models.find(entry => sameReference(entry.reference, reference));
        const state = entry?.availability
          ?? { invocable: false as const, reason: { kind: 'unavailable' as const, code: 'MODEL_INVOCATION_UNAVAILABLE' } };
        const binding = await host.inspectModelBinding?.(root, reference, options);
        const chat = await host.inspectModelActivation?.(root, { schemaVersion: 1, scopeId, reference }, options);
        const on = chat?.activation?.state === 'active', tokens = workerTokens.get(exact), workersMissing = on && tokens !== undefined && (!tokens[0] || !tokens[1]); // never activated: /setup
        const conflict = !workersMissing && workers.has(exact) && workers.get(exact) !== on;
        const fixes: NonNullable<ModelPanelChoice['fixes']>[number][] = host.admitModelActivation ? [{ id: on ? 'deactivate' : 'activate', label: on ? t('tui.model.fix.deactivate', {}, locale) : t('tui.model.fix.activate', {}, locale) }, ...(conflict ? [{ id: 'reconcile' as const, label: t('tui.model.reconcile.align', {}, locale) }] : [])] : [];
        if (!state.invocable && state.reason.code.startsWith('PROVIDER_SPEND')) fixes.push({ id: 'budget', label: t('tui.model.fix.budget', {}, locale) });
        if (!state.invocable && !state.reason.code.startsWith('PROVIDER_SPEND') && host.providerConnect) fixes.push({ id: 'provider', label: t('tui.model.fix.provider', {}, locale) });
        const axis = axes.find(row => row.scopeId === scopeId && sameReference(row.reference, reference))?.billingAxis;
        const billing = axis === 'subscription' || axis === 'local' || axis === 'metered' ? { billing: axis } as const : {};
        const off = switchedOff.some(row => row.channelId === provider.id && row.modelId === model.nativeId); // not offered as Brain (owner 2026-11-06)
        const brain = !off && (brainRows?.models.some(row => row.channelId === provider.id && row.modelId === model.nativeId) ?? false), isBrain = brainNow !== null && sameReference(brainNow, reference);
        if (brain) recommended.add(exact);
        if (state.invocable && writer && !off) fixes.push({ id: 'brain-global', label: t('tui.model.brain.setGlobal', {}, locale) }, { id: 'brain-project', label: t('tui.model.brain.setProject', {}, locale) });
        if (writer && (off || state.invocable)) fixes.push(off ? { id: 'brain-on', label: t('tui.model.brain.offer', {}, locale) } : { id: 'brain-off', label: t('tui.model.brain.withdraw', {}, locale) });
        const cliPlan = host.providerConnect?.kinds.find(kind => kind.headlessLogin && (kind.catalogProviderId ?? kind.id) === provider.id);
        const readiness = !state.invocable && state.reason.code === 'MODEL_INVOCATION_UNAVAILABLE' && cliPlan && !cliPlan.terminalTextChat
          ? t('tui.provider.login.brainOnlyNote', {}, locale) : modelInvocabilityText(state, locale);
        const blocked = state.invocable ? null : readiness;
        const planKind = host.siwc && host.providerConnect?.kinds.find(kind => kind.id === host.siwc!.connection);
        const personalPlan = planKind?.catalogProviderId === provider.id;
        if (!state.invocable && state.reason.code === 'PROVIDER_SPEND_EXHAUSTED') reservationBlocked.add(exact);
        const command = entry && !state.invocable && (state.reason.kind === 'not-carried' || state.reason.kind === 'stale-activation')
          ? t('tui.model.command.activate', { scope: scopeId, provider: provider.id, providerVersion: provider.version, model: model.id, modelVersion: model.version,
            revision: state.reason.activationRevision ?? 0, digest: entry.bindingDigest, catalog: entry.catalogRevision }, locale) : null;
        const tools = cliPlan?.terminalTextChat ? t('terminal.admin.model.toolsUnsupported', {}, locale) : model.protocols.some(protocol => protocol.capabilities.some(row => row.id === 'tool-calls' && row.version === 1 && row.state === 'supported')) ? t('terminal.admin.model.toolsSupported', {}, locale) : model.protocols.some(protocol => protocol.capabilities.some(row => row.id === 'tool-calls' && row.version === 1 && row.state === 'unsupported')) ? t('terminal.admin.model.toolsUnsupported', {}, locale) : t('terminal.admin.model.toolsUnknown', {}, locale);
        return { ...billing, reference, label: display.get(exact) ?? model.nativeId, stateToken: JSON.stringify([chat?.activation?.revision ?? 0, ...(workerTokens.get(exact) ?? [null, null]), binding?.status === 'declared' ? binding.catalogRevision : null, binding?.status === 'declared' ? binding.binding.digest : null]), fixes, detail: `${(on ? t('tui.model.state.on', {}, locale) : t('tui.model.state.off', {}, locale))} · ${conflict ? t('tui.model.reconcile.title', {}, locale) : workersMissing ? t('tui.model.workers.notSetUp', {}, locale) : readiness}${personalPlan ? ` · ${t('siwc.preview', {}, locale)}${state.invocable ? ` · ${t('siwc.status.usingPlan', {}, locale)}` : ''}` : ''} · ${tools}${cliPlan?.terminalTextChat ? ` · ${t('tui.model.textChatSubscription', {}, locale)}` : ''}${!isBrain && brain ? ` · ${t('tui.model.brain.eligible', {}, locale)}` : ''}${off ? ` · ${t('tui.model.brain.off', {}, locale)}` : ''}`, ...(isBrain ? { brain: true } : {}),
          providerLabel: providerDisplayName(provider.id, host.providerConnect, locale),
          group: provider.id, blocked, exact: t('tui.model.exact', { reference: exact, native: model.nativeId }, locale), command: personalPlan && host.siwc?.usageUrl ? [command, t('siwc.usage.manage', { url: host.siwc.usageUrl }, locale)].filter(Boolean).join('\n') : command,
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
      const exactOf = (choice: ModelPanelChoice) => `${choice.reference.providerId}@${choice.reference.providerVersion}/${choice.reference.modelId}@${choice.reference.modelVersion}`;
      choices.splice(0, choices.length, ...orderModelChoices(choices, choice => ({ priority: priority.get(exactOf(choice)) ?? null,
        tier: tiers.find(row => row.channelId === choice.reference.providerId && row.modelId === natives.get(exactOf(choice)))?.tier ?? null })));
      // R9b: with no Brain model chosen, the recommended models that can run now are suggested (never chosen for the person).
      const planners = brainNow ? [] : choices.filter(choice => choice.blocked === null && choice.fixes?.some(fix => fix.id === 'brain-project') && recommended.has(`${choice.reference.providerId}@${choice.reference.providerVersion}/${choice.reference.modelId}@${choice.reference.modelVersion}`));
      if (planners.length) notes.push(t('tui.model.brain.suggest', { models: planners.map(choice => choice.label).join(', ') }, locale));
      return { title, choices, fixTitle: t('tui.model.reconcile.title', {}, locale), fixApply: t('cli.init.policyModes.cardApply', {}, locale), fixKeep: t('tui.model.reconcile.keep', {}, locale), notes: [...notes, ...(note ? [note] : [])], defaultBlocked: defaultBlocked() };
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
    // R9b (owner D3): the Brain's own model on the user or project layer, through the same governed writer; a project value keeps winning.
    async setBrain(choice: { reference: ModelReference; label: string }, layer: 'global' | 'project') {
      const outcome = await terminalConfigWrite(root, { action: 'set', keyPath: 'brain_planner.reference', value: { ...choice.reference }, layer }, host, options, locale);
      if (outcome.status !== 'applied') return outcome;
      const now = await brainModel(root, options), shadowed = layer === 'global' && now !== null && !sameReference(now, choice.reference);
      return { ...outcome, lines: [shadowed ? t('tui.model.brain.shadowed', {}, locale) : t('tui.model.brain.done', { model: choice.label }, locale), ...outcome.lines] };
    },
    // Owner 2026-11-06 ("can be Brain"): the row's switch, the same governed writer as `deckent models catalog brain`.
    async setBrainOffer(choice: { reference: ModelReference }, offered: boolean) {
      const declared = await host.inspectDeclaredModels?.(root, options), native = declared?.status === 'declared' ? declared.catalog.providers.find(row => row.id === choice.reference.providerId
        && row.version === choice.reference.providerVersion)?.models.find(row => row.id === choice.reference.modelId && row.version === choice.reference.modelVersion)?.nativeId : undefined;
      if (!native) throw ErrorRegistry.createError('MODEL_CATALOG_NOT_FOUND');
      return setBrainOffer(root, { channelId: choice.reference.providerId, modelId: native }, offered, host, options, locale);
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
