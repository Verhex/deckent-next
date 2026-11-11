import type { ModelInspectionSnapshot } from '#composition/core/model-inspection/index.js';
import { resolveTerminalModel } from '#adapters/index.js';
import { inspectNativeChat, nativeChatVerifiedAtMs } from './native.js';
import { configuredNativeChatReadiness, type SubscriptionReadinessReader } from '#composition/core/subscription-readiness/index.js';
import { NATIVE_CLI_HEADLESS_ADAPTER_ID, type ModelInvocationProfile } from '#domain/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, ModelInvocationCancellationCommand, ModelInvocationCommand, ModelReference } from '#domain/index.js';
import { textOnlyModelInvocationRequest, agentTurnAdmission, modelInvocationRequestDigest, configuredInvocationProfiles, type AgentTurnAdmission, type ModelInvocationResult } from '#engine/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { extractOpenAiChatTextFromInvocation, openAiChatStoppedAtLength, readTerminalChatConfig, effectiveTerminalOutputCap,
  OPENAI_CHAT_TOOL_CALLS_CAPABILITY, OPENAI_CHAT_ENABLE_THINKING_CAPABILITY, OPENAI_CHAT_JSON_OBJECT_CAPABILITY, openAiChatProtocol, nativeCliHeadless, type TerminalModelChoice, type TerminalModelSource } from '#adapters/index.js';
import { inspectDeclaredModels, inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { configuredTerminalModel } from '#composition/core/config/index.js';
type TerminalChatMessage = Readonly<{ role: 'system' | 'user' | 'assistant'; content: string }>;
type TerminalChatPlan = Readonly<{
  schemaVersion: 1;
  status: 'ready' | 'not-configured' | 'model-not-declared';
  reference: ModelReference | null;
  /** T4-B D1: which setting chose `reference` (null when not configured). */
  source: TerminalModelSource | null;
  catalogRevision: string | null;
  maxCompletionTokens: number | null;
  historyMessages: number | null;
  tools: 'available' | 'none' | 'unknown' | 'unverified'; // R4b `unverified`: a subscription CLI's tools not observed yet (its first turn verifies them)
  skippedDefault?: ModelReference; // BeUser M-08: the user's default that this project does not declare, so it was not used here
  /** NF-7: with `tools: 'unverified'` only because the last verification passed the K16 age, when it was recorded (the next turn rechecks). */
  toolsVerifiedAtMs?: number;
}>;
/** BeUser M-08/AYSE-13 (T4-B D1 order kept): the user's default applies only where this project declares it; with no setting in effect, the only declared model here is used. */
export async function terminalModelHere(projectRoot: string, options: ConfigLoadOptions = {}, snapshot?: ModelInspectionSnapshot): Promise<{ choice: TerminalModelChoice | null; skipped: ModelReference | null }> {
  const choose = async (skipDefault = false) => snapshot ? resolveTerminalModel(await snapshot.documents(), null, skipDefault) : configuredTerminalModel(projectRoot, options, null, skipDefault);
  let choice = await choose(), skipped: ModelReference | null = null;
  if (choice?.source === 'user-default' && (await (snapshot?.bindings.inspect(choice.reference) ?? inspectModelBinding(projectRoot, choice.reference, options))).status !== 'declared') { skipped = choice.reference; choice = await choose(true); }
  const declared = choice ? null : snapshot?.declared ?? await inspectDeclaredModels(projectRoot, options).catch(() => null);
  const only = declared?.status === 'declared' ? declared.catalog.providers.flatMap(provider => provider.models.map(model => ({ providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version }))) : [];
  return { choice: choice ?? (only.length === 1 ? Object.freeze({ reference: only[0]!, source: 'connected' as const }) : null), skipped };
}
/** Governed model invocation service; the shipped executable wires the local runtime client. */
export interface TerminalChatInvocationPorts {
  invoke(projectRoot: string, command: ModelInvocationCommand, options: ConfigLoadOptions, signal?: AbortSignal): Promise<ModelInvocationResult>;
  cancel(projectRoot: string, command: ModelInvocationCancellationCommand, options: ConfigLoadOptions): Promise<unknown>;
}
interface TerminalChatTurnInput {
  readonly projectRoot: string;
  readonly scopeId: string;
  readonly messages: readonly TerminalChatMessage[];
  readonly options: ConfigLoadOptions;
  readonly signal?: AbortSignal;
}
const describeModel = (reference: ModelReference): string => `${reference.providerId}/${reference.modelId}@${reference.modelVersion}`;
const nativeChatProfile = (profiles: readonly ModelInvocationProfile[], scopeId: string | undefined, reference: ModelReference) => profiles.find(profile => profile.scopeId === scopeId
  && profile.adapter.id === NATIVE_CLI_HEADLESS_ADAPTER_ID && isDeepStrictEqual(profile.reference, reference));
/** R8e: the host's chat readiness read for `/provider` and `/model` (read only: no preflight, spawn or sign-in). KG6 F5: one view build is one call,
 * one forced config load and one typed profile read; each model still reads its own observation, and nothing is kept for the next build. */
export async function inspectConfiguredNativeChat(projectRoot: string, query: Readonly<{ scopeId: string; surface: string; references: readonly ModelReference[] }>, options: ConfigLoadOptions = {}, snapshot?: ModelInspectionSnapshot) {
  const profiles = query.surface === 'chat' ? configuredInvocationProfiles(snapshot?.config ?? await loadComposedConfig(projectRoot, { ...options, force: true, heal: false }) as Record<string, unknown>) : [];
  const readiness = configuredNativeChatReadiness(projectRoot, options, true, profiles);
  return Promise.all(query.references.map(reference => { const profile = nativeChatProfile(profiles, query.scopeId, reference);
    return profile ? inspectNativeChat(profile, { readiness }) : { state: 'unknown', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' } as const; }));
}
export async function describeTerminalChat(projectRoot: string, options: ConfigLoadOptions = {}, runtime?: { readonly readiness: SubscriptionReadinessReader }, snapshot?: ModelInspectionSnapshot): Promise<TerminalChatPlan> {
  runtime ??= { readiness: configuredNativeChatReadiness(projectRoot, options, Boolean(snapshot), snapshot ? configuredInvocationProfiles(snapshot.config) : undefined) };
  const config = snapshot?.config ?? await loadComposedConfig(projectRoot, options) as Record<string, unknown>, chat = readTerminalChatConfig(config);
  if (!chat) return Object.freeze({ schemaVersion: 1, status: 'not-configured', tools: 'unknown', reference: null, source: null, catalogRevision: null, maxCompletionTokens: null, historyMessages: null });
  // T4-B D1: the same precedence the service applies (a project's model, else the user's default, else the user's configured model).
  const { choice, skipped } = await terminalModelHere(projectRoot, options, snapshot), reference = choice?.reference ?? chat.reference, more = skipped ? { skippedDefault: skipped } : {};
  if (!reference) return Object.freeze({ schemaVersion: 1, status: 'not-configured', tools: 'unknown', reference: null, source: null, catalogRevision: null, maxCompletionTokens: null, historyMessages: null, ...more });
  const binding = await (snapshot?.bindings.inspect(reference) ?? inspectModelBinding(projectRoot, reference, options));
  const profile = nativeChatProfile(configuredInvocationProfiles(config), (config['terminal'] as { scopeId?: string } | undefined)?.scopeId, reference);
  const native = profile ? await inspectNativeChat(profile, runtime) : null;
  // NF-7: the age keeps gating turns; the person is told when tools were last verified instead of "not verified yet".
  const verifiedAtMs = profile && native?.state === 'unknown' ? await nativeChatVerifiedAtMs(profile, configuredNativeChatReadiness(projectRoot, options, true, snapshot ? configuredInvocationProfiles(snapshot.config) : undefined)).catch(() => null) : null;

  return Object.freeze({ schemaVersion: 1, status: binding.status === 'declared' ? 'ready' : 'model-not-declared', reference, source: choice?.source ?? 'user',
    tools: binding.status !== 'declared' ? 'unknown' : binding.definition.model.protocols.some(protocol => nativeCliHeadless(protocol.family) !== null) ? native?.state === 'ready' ? 'available' : native?.state === 'unknown' ? 'unverified' : 'none' : binding.definition.model.protocols.some(protocol => protocol.capabilities.some(capability => capability.id === OPENAI_CHAT_TOOL_CALLS_CAPABILITY && capability.version === 1 && capability.state === 'supported')) ? 'available' : binding.definition.model.protocols.some(protocol => protocol.capabilities.some(capability => capability.id === OPENAI_CHAT_TOOL_CALLS_CAPABILITY && capability.version === 1 && capability.state === 'unsupported')) ? 'none' : 'unknown',
    catalogRevision: binding.catalogRevision, maxCompletionTokens: chat.maxCompletionTokens, historyMessages: chat.historyMessages, ...more, ...(verifiedAtMs !== null ? { toolsVerifiedAtMs: verifiedAtMs } : {}) });
}
export async function prepareTerminalChatCommand(input: TerminalChatTurnInput, streamed: boolean, pinned?: ModelReference,
  settings: Readonly<{ maxCompletionTokens?: number; reasoning?: 'off'; jsonOutput?: 'if-supported' }> = {}) {
  const config = await loadComposedConfig(input.projectRoot, input.options) as Record<string, unknown>;
  const configuredChat = readTerminalChatConfig(config);
  if (!configuredChat) throw ErrorRegistry.createError('TERMINAL_CHAT_NOT_CONFIGURED');
  const reference = pinned ?? (await configuredTerminalModel(input.projectRoot, input.options))?.reference ?? configuredChat.reference; // SDK/Brain contract: the configured model only (the terminal passes its own choice explicitly)
  if (!reference) throw ErrorRegistry.createError('TERMINAL_CHAT_NOT_CONFIGURED');
  const chat = { ...configuredChat, maxCompletionTokens: settings.maxCompletionTokens ?? effectiveTerminalOutputCap(config, input.scopeId, reference) };
  const binding = await inspectModelBinding(input.projectRoot, reference, input.options);
  if (binding.status !== 'declared') throw ErrorRegistry.createError('TERMINAL_CHAT_MODEL_NOT_DECLARED', { params: { model: describeModel(reference) } });
  // S3-4: a CLI headless step has no thinking switch; Brain `reasoning: off` there means no effort flag (the CLI's own default), never a refusal.
  const cliStep = binding.definition.model.protocols.some(protocol => nativeCliHeadless(protocol.family) !== null), thinkingOff = settings.reasoning === 'off' && !cliStep;
  if (thinkingOff && !binding.definition.model.protocols.some(protocol => protocol.family === openAiChatProtocol.family
    && protocol.version === openAiChatProtocol.version && protocol.capabilities.some(capability => capability.id === OPENAI_CHAT_ENABLE_THINKING_CAPABILITY
      && capability.version === 1 && capability.state === 'supported'))) throw ErrorRegistry.createError('MODEL_INVOCATION_REASONING_UNSUPPORTED');
  const jsonOutput = settings.jsonOutput === 'if-supported' && binding.definition.model.protocols.some(protocol => protocol.family === openAiChatProtocol.family
    && protocol.version === openAiChatProtocol.version && protocol.capabilities.some(capability => capability.id === OPENAI_CHAT_JSON_OBJECT_CAPABILITY
      && capability.version === 1 && capability.state === 'supported'));
  const nativeRequest = {
    model: binding.definition.model.nativeId,
    messages: input.messages.map(message => ({ role: message.role, content: message.content })),
    max_completion_tokens: chat.maxCompletionTokens,
    ...(jsonOutput ? { response_format: { type: 'json_object' } } : {}),
    ...(thinkingOff ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    ...(streamed ? { stream: true, stream_options: { include_usage: true } } : { stream: false }),
  } as unknown as JsonObject;
  const command: ModelInvocationCommand = { schemaVersion: 1, commandId: randomUUID(), scopeId: input.scopeId,
    reference, catalogRevision: binding.catalogRevision, expectedBinding: binding.binding,
    nativeRequest: cliStep ? textOnlyModelInvocationRequest(nativeRequest) : nativeRequest };
  return { chat, command };
}
function terminalChatCancellation(command: ModelInvocationCommand): ModelInvocationCancellationCommand {
  return { schemaVersion: 1, commandId: randomUUID(), scopeId: command.scopeId, targetCommandId: command.commandId,
    reference: command.reference, expectedRequestDigest: modelInvocationRequestDigest(command) };
}
/**
 * One chat turn is one governed model invocation: principal, policy, activation and spending are enforced by the
 * invocation service for the caller's scope. Abort stops the wait and requests cancellation of that invocation.
 */
export async function completeTerminalChatTurn(input: TerminalChatTurnInput, ports: TerminalChatInvocationPorts): Promise<string> {
  const { chat, command } = await prepareTerminalChatCommand(input, false);
  let outcome: ModelInvocationResult;
  try {
    outcome = await ports.invoke(input.projectRoot, command, input.options, input.signal);
  } catch (error) {
    if (!input.signal?.aborted) throw error;
    await ports.cancel(input.projectRoot, terminalChatCancellation(command), input.options).catch(() => undefined);
    throw ErrorRegistry.createError('TERMINAL_CHAT_CANCELLED');
  }
  const text = extractOpenAiChatTextFromInvocation(outcome);
  if (!text) {
    throw openAiChatStoppedAtLength(outcome)
      ? ErrorRegistry.createError('TERMINAL_CHAT_TRUNCATED', { params: { maxCompletionTokens: chat.maxCompletionTokens } })
      : ErrorRegistry.createError('TERMINAL_CHAT_EMPTY');
  }
  return text;
}
/**
 * The same configuration check the plain turn makes, before an agent turn contacts the service; returns the service's admission from
 * that configuration, so the stream can name the summarizing phase (TL-A).
 */
export async function assertTerminalChatReady(projectRoot: string, options: ConfigLoadOptions = {}, reference?: ModelReference, scopeId?: string): Promise<AgentTurnAdmission> {
  const plan = await describeTerminalChat(projectRoot, options);
  // PRE-10: a session pin is a model choice of its own; only an unpinned turn needs a persistent model. Terminal chat settings are still required.
  if (plan.status === 'not-configured' && !reference) throw ErrorRegistry.createError('TERMINAL_CHAT_NOT_CONFIGURED');
  // T4 MODEL-SWITCH (S19): a session pin is checked as itself; the configured model's state neither blocks nor stands in for it.
  const declared = reference ? (await inspectModelBinding(projectRoot, reference, options)).status === 'declared' : plan.status !== 'model-not-declared';
  if (!declared) throw ErrorRegistry.createError('TERMINAL_CHAT_MODEL_NOT_DECLARED', { params: { model: describeModel(reference ?? plan.reference!) } });
  const config = await loadComposedConfig(projectRoot, options) as { service: { inputMaxBytes: number } };
  const chat = readTerminalChatConfig(config as unknown as Record<string, unknown>);
  if (!chat) throw ErrorRegistry.createError('TERMINAL_CHAT_NOT_CONFIGURED');
  const configuredScope = (config as unknown as { terminal?: { scopeId?: string } }).terminal?.scopeId ?? '';
  return agentTurnAdmission(effectiveTerminalOutputCap(config as unknown as Record<string, unknown>, scopeId ?? configuredScope, (reference ?? plan.reference)!), config.service.inputMaxBytes, chat.compactionThresholdTokens);
}
