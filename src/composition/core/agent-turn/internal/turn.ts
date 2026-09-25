import { createHash } from 'node:crypto';
import { chatTurnCancellationSchema, chatTurnCommandSchema, modelInvocationProfileSchema, type AgentToolSpec, type AgentTurnMessage,
  type ChatTurnCancellationResult, type ChatTurnResult, type JsonObject, type ModelInvocationCommand } from '#domain/index.js';
import { AGENT_TURN_ANSWER_MAX_BYTES, AgentToolPolicyAuthorization, AgentTurnStoreError, agentCompactionSummarySchema, runDurableAgentTurn,
  type AgentCompactionSummary, type AgentRoundOutcome, type AgentTurnPorts,
  type ModelInvocationDelivery } from '#engine/index.js';
import { ErrorRegistry, loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { createWorkspaceReadTools, openSqliteAgentTurnStore, OPENAI_CHAT_COMPLETIONS_FAMILY, OPENAI_CHAT_TOOL_CALLS_CAPABILITY, readTerminalChatConfig,
  registerProviderConfig, type LocalPeerIdentity, type RuntimeServiceTurnChannel } from '#adapters/index.js';
import { invokePeerConfiguredModel, loadPeerInvocationContext, measurePeerConfiguredModel, type RuntimeModelInvocationHost } from '#composition/core/model-invocation/index.js';
import { inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { extractOpenAiChatTextFromInvocation, openAiChatMessageFromInvocation, openAiChatUsageFromInvocation } from '#composition/core/terminal-chat/index.js';

/** Service-owned state of running turns: cancellation by the starting principal, and service stop. */
export interface RuntimeChatTurnHost {
  readonly model: RuntimeModelInvocationHost;
  readonly signal: AbortSignal;
  readonly running: Map<string, { readonly principalKey: string; readonly controller: AbortController }>;
}
export function createRuntimeChatTurnHost(model: RuntimeModelInvocationHost, signal: AbortSignal): RuntimeChatTurnHost {
  return Object.freeze({ model, signal, running: new Map() });
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const principalKeyOf = (principal: { readonly issuer: string; readonly subject: string }) => sha256(`agent-turn-principal:1\0${principal.issuer}\0${principal.subject}`);
const runningKey = (scopeId: string, turnId: string) => `${scopeId}\0${turnId}`;
/** Tokens kept free beyond the completion limit (legacy default): chat template and tokenizer differences never overflow a round. */
export const CHAT_TURN_SAFETY_RESERVE_TOKENS = 2_048;
/**
 * Conservative prompt bound when the provider has no counter (legacy formula): every UTF-8 byte of messages and tools counts as a
 * token, plus fixed overheads per request, message and tool. It never under-counts; it is always labelled `upper-bound`.
 */
export function chatTurnPromptUpperBound(nativeRequest: JsonObject): number {
  const request = nativeRequest as { messages?: unknown[]; tools?: unknown[] };
  const messages = request.messages ?? [], tools = request.tools ?? [];
  return Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') + 64 + 16 * messages.length + 32 * tools.length;
}
/** Compaction command id: the n-th compaction of a turn is one governed invocation, never billed twice on replay. */
export const chatTurnCompactionCommandId = (scopeId: string, turnId: string, sequence: number) => sha256(`turn-compact:1\0${scopeId}\0${turnId}\0${sequence}`);
/** Model-facing instruction of the compaction call (protocol text, like tool descriptions). */
const COMPACTION_INSTRUCTION = 'You compress an earlier part of a conversation between a user and a coding assistant into one JSON object. Output only '
  + 'that object, with no prose and no markdown fences, of exactly this shape: {"objective":string,"findings":string[],"decisions":string[],'
  + '"unresolved":string[],"nextActions":string[],"inspectedAreas":string[]}. Every string is short, concrete and drawn from the conversation: '
  + 'facts found in files or tool results with their paths, decisions made, open questions, what should happen next, files and areas '
  + 'inspected. Invent nothing. Do not copy the user\'s messages or list the tool calls: Deckent records those itself. Write in the '
  + 'language of the conversation.';
/** Each message of the summary input is cut to this many characters (legacy bound). */
const COMPACTION_MESSAGE_CHARS = 2_000;

/** The older messages as plain text for a tools-off summary call, newest kept within `maxBytes` (older ones are named, not sent). */
export function chatTurnCompactionTranscript(messages: readonly AgentTurnMessage[], maxBytes: number): string {
  const cutText = (text: string) => text.length <= COMPACTION_MESSAGE_CHARS ? text : `${text.slice(0, COMPACTION_MESSAGE_CHARS)} …[cut]`;
  const lines = messages.map(message => message.role === 'assistant'
    ? `[assistant] ${cutText(message.content)}${message.toolCalls.map(call => `\n  → ${call.name} ${cutText(call.argumentsJson)}`).join('')}`
    : message.role === 'tool' ? `[tool result ${message.name}] ${cutText(message.content)}` : `[${message.role}] ${cutText(message.content)}`);
  const kept: string[] = [];
  let bytes = 0;
  for (const line of [...lines].reverse()) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size > maxBytes && kept.length > 0) break;
    kept.unshift(line); bytes += size;
  }
  const omitted = lines.length - kept.length;
  return [...(omitted ? [`[${omitted} earliest messages omitted from this summary input]`] : []), ...kept].join('\n');
}
function parseCompactionSummary(text: string | null): AgentCompactionSummary | null {
  if (!text) return null;
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { const parsed = agentCompactionSummarySchema.safeParse(JSON.parse(text.slice(start, end + 1))); return parsed.success ? parsed.data : null; }
  catch { return null; }
}

/** Round command id (Astra 2074 D3): the same turn and round is the same governed invocation, so a replay never bills twice. */
export const chatTurnRoundCommandId = (scopeId: string, turnId: string, round: number) => sha256(`turn-round:1\0${scopeId}\0${turnId}\0${round}`);

function nativeMessages(messages: readonly AgentTurnMessage[]) {
  return messages.map(message => message.role === 'assistant'
    ? { role: 'assistant', content: message.content, ...(message.toolCalls.length ? { tool_calls: message.toolCalls.map(call =>
      ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.argumentsJson } })) } : {}) }
    : message.role === 'tool' ? { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
      : { role: message.role, content: message.content });
}
const displayTarget = (args: Record<string, unknown>) => typeof args['path'] === 'string' ? args['path'] : typeof args['pattern'] === 'string' ? args['pattern'] : null;

/**
 * One terminal agent turn inside the runtime service (T-L3, runtime `chatTurn`). The principal comes from the connection; the model,
 * limits and tools from fresh configuration; the loop is the engine's. Every round is the existing governed invocation (policy,
 * activation, allocation, spending, receipt) under a command id derived from the turn and round; every tool call is authorized per
 * call by policy (`agent-tool`/`invoke`, fail closed) and runs as a workspace read tool on this project. Events go to the turn
 * channel, which the loop waits on between steps (no dropped history, bounded memory); a disconnected peer, `cancelChatTurn` of the
 * same principal, or service stop cancel the turn. Tools are declared to the model only when its binding declares tool calling.
 */
export async function runPeerConfiguredChatTurn(projectRoot: string, input: unknown, peer: LocalPeerIdentity, options: ConfigLoadOptions,
  delivery: ModelInvocationDelivery, host: RuntimeChatTurnHost, channel: RuntimeServiceTurnChannel): Promise<ChatTurnResult> {
  const parsed = chatTurnCommandSchema.safeParse(input);
  if (!parsed.success) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
  const command = parsed.data;
  registerProviderConfig();
  const context = await loadPeerInvocationContext(projectRoot, command.scopeId, options, peer);
  const config = await loadConfig(projectRoot, { ...options, heal: false }) as Record<string, unknown>;
  const chat = readTerminalChatConfig(config);
  if (!chat) throw ErrorRegistry.createError('TERMINAL_CHAT_NOT_CONFIGURED');
  const binding = await inspectModelBinding(projectRoot, chat.reference, options);
  if (binding.status !== 'declared') throw ErrorRegistry.createError('TERMINAL_CHAT_MODEL_NOT_DECLARED');
  const toolCapable = binding.definition.model.protocols.some(protocol => protocol.family === OPENAI_CHAT_COMPLETIONS_FAMILY
    && protocol.capabilities.some(capability => capability.id === OPENAI_CHAT_TOOL_CALLS_CAPABILITY && capability.version === 1 && capability.state === 'supported'));
  const workspace = toolCapable ? await createWorkspaceReadTools(projectRoot) : null;
  const tools: readonly AgentToolSpec[] = workspace?.specs ?? [];
  const principalKey = principalKeyOf(context.principal);
  const toolAuthority = new AgentToolPolicyAuthorization(context.policy);
  const requestDigest = sha256(`chat-turn-request:1\0${canonical({ messages: command.messages, reference: chat.reference, catalogRevision: binding.catalogRevision,
    binding: binding.binding, maxCompletionTokens: chat.maxCompletionTokens, tools: tools.map(tool => `${tool.name}@${tool.version}`) })}`);

  // The deployment's served window (profile data, T-L5); the provider's own report narrows it further.
  const profileWindow = ((config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles ?? [])
    .map(value => modelInvocationProfileSchema.safeParse(value)).flatMap(parsed => parsed.success ? [parsed.data] : [])
    .find(profile => profile.scopeId === command.scopeId && JSON.stringify(profile.reference) === JSON.stringify(chat.reference))?.contextWindowTokens ?? null;
  /** The one governed command of a round: measured and sent identically (the count is of exactly what is sent). */
  const roundCommand = (round: number, messages: readonly AgentTurnMessage[], declared: readonly AgentToolSpec[]): ModelInvocationCommand => ({
    schemaVersion: 1, commandId: chatTurnRoundCommandId(command.scopeId, command.turnId, round),
    scopeId: command.scopeId, reference: chat.reference, catalogRevision: binding.catalogRevision, expectedBinding: binding.binding,
    nativeRequest: { model: binding.definition.model.nativeId, messages: nativeMessages(messages), max_completion_tokens: chat.maxCompletionTokens,
      stream: true, stream_options: { include_usage: true },
      ...(declared.length ? { tools: declared.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description,
        parameters: tool.inputSchema } })), tool_choice: 'auto' } : {}) } as unknown as JsonObject });

  const key = runningKey(command.scopeId, command.turnId);
  const cancel = new AbortController();
  const signal = AbortSignal.any([channel.signal, cancel.signal, host.signal]);
  const store = await openSqliteAgentTurnStore(await context.path(), context.config.storage.sqlite, 'forbid');
  const registered = !host.running.has(key);
  if (registered) host.running.set(key, { principalKey, controller: cancel });
  try {
    const ports: AgentTurnPorts = {
      async invokeRound({ round, messages, tools: declared }, onDelta, roundSignal): Promise<AgentRoundOutcome> {
        await channel.drained();
        const invocation = roundCommand(round, messages, declared);
        let shownText = '', shownReasoning = '';
        let result: Awaited<ReturnType<typeof invokePeerConfiguredModel>>;
        try {
          // The round's result stays inside the service (bounded by the profile's response limit); no transport delivery applies.
          result = await invokePeerConfiguredModel(projectRoot, invocation, peer, options, undefined, host.model, delta => {
            if (delta.kind === 'text') shownText += delta.text; else shownReasoning += delta.text;
            onDelta(delta);
          }, roundSignal);
        } catch (error) {
          // The closure note names the typed failure (policy, activation, allocation, provider), never a raw cause.
          return { status: 'failed', state: roundSignal.aborted ? 'cancelled' : queryFailure(error).code };
        }
        const outcome = result.receipt.outcome;
        if (!outcome) return { status: 'failed', state: 'pending' };
        if (outcome.state !== 'responded') return { status: 'failed', state: outcome.state };
        const message = openAiChatMessageFromInvocation(result);
        if (!message) return { status: 'failed', state: 'unreadable' };
        // What was shown is always a prefix of the governed result; anything else ends the turn, never merged.
        if (!message.content.startsWith(shownText) || !message.reasoning.startsWith(shownReasoning)) return { status: 'failed', state: 'stream-mismatch' };
        if (message.reasoning.length > shownReasoning.length) onDelta({ kind: 'reasoning', text: message.reasoning.slice(shownReasoning.length) });
        if (message.content.length > shownText.length) onDelta({ kind: 'text', text: message.content.slice(shownText.length) });
        const usage = openAiChatUsageFromInvocation(result);
        return { status: 'responded', content: message.content, reasoning: message.reasoning, toolCalls: message.toolCalls,
          finish: typeof message.finish === 'string' ? message.finish : 'unknown',
          usage: usage ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens } : null };
      },
      authorize: tool => toolAuthority.decide(tool, command.scopeId, context.principal),
      async summarize({ sequence, messages: older }, summarySignal) {
        // Summary input is bounded in bytes (a UTF-8 byte is never fewer than one token): 40% of the known window, else 32k.
        const transcript = chatTurnCompactionTranscript(older, Math.floor(0.4 * (profileWindow ?? 32_768)));
        const invocation: ModelInvocationCommand = { schemaVersion: 1, commandId: chatTurnCompactionCommandId(command.scopeId, command.turnId, sequence),
          scopeId: command.scopeId, reference: chat.reference, catalogRevision: binding.catalogRevision, expectedBinding: binding.binding,
          nativeRequest: { model: binding.definition.model.nativeId, messages: [{ role: 'system', content: COMPACTION_INSTRUCTION },
            { role: 'user', content: transcript }], max_completion_tokens: chat.maxCompletionTokens, stream: false } as unknown as JsonObject };
        const result = await invokePeerConfiguredModel(projectRoot, invocation, peer, options, undefined, host.model, undefined, summarySignal).catch(() => null);
        if (result?.receipt.outcome?.state !== 'responded') return null;
        return parseCompactionSummary(extractOpenAiChatTextFromInvocation(result));
      },
      async measure({ round, messages, tools: declared }, measureSignal) {
        const invocation = roundCommand(round, messages, declared);
        const counted = await measurePeerConfiguredModel(projectRoot, invocation, peer, options, measureSignal).catch(() => null);
        const windows = [profileWindow, counted?.windowTokens ?? null].filter((value): value is number => value !== null);
        const windowTokens = windows.length ? Math.min(...windows) : null;
        if (counted) return { promptTokens: counted.promptTokens, windowTokens, quality: 'provider-count' as const };
        return { promptTokens: chatTurnPromptUpperBound(invocation.nativeRequest), windowTokens, quality: 'upper-bound' as const };
      },
      describe: (_tool, args) => displayTarget(args),
      async execute(tool, args, toolSignal) {
        await channel.drained();
        if (!workspace) return { status: 'error', text: `[deckent] ${tool.name}: error=unknown-tool` };
        return workspace.execute(tool.name, args, toolSignal);
      },
      now: () => Date.now(),
    };
    const result = await runDurableAgentTurn({ claim: { scopeId: command.scopeId, turnId: command.turnId, principalKey, requestDigest, claimedAtMs: Date.now() },
      messages: command.messages, tools, signal, emit: event => { if (event.kind !== 'done') channel.emit(event); },
      admission: { outputReserveTokens: chat.maxCompletionTokens, safetyReserveTokens: CHAT_TURN_SAFETY_RESERVE_TOKENS } }, store, ports);
    await channel.drained();
    const last = result.appended.at(-1);
    const answer = last?.role === 'assistant' && last.toolCalls.length === 0 && last.content ? last.content : null;
    const answerBytes = answer === null ? 0 : Buffer.byteLength(answer, 'utf8');
    // The answer came as text events; the result repeats it only while it fits the replay bound and the caller's delivery.
    const kept = answer !== null && answerBytes <= Math.min(AGENT_TURN_ANSWER_MAX_BYTES, Math.max(0, delivery.maxResultBytes - 1024)) ? answer : null;
    return Object.freeze({ schemaVersion: 1, turnId: command.turnId, finish: result.finish, note: result.note, rounds: result.rounds,
      toolCalls: result.toolCalls, answer: kept, answerBytes, replayed: result.replayed, recorded: result.recorded });
  } finally {
    if (registered) host.running.delete(key);
    store.close();
  }
}

/** Cancels a running turn of the same principal at once; another principal's turn or an unknown id is `not-running`. */
export async function cancelPeerConfiguredChatTurn(projectRoot: string, input: unknown, peer: LocalPeerIdentity, options: ConfigLoadOptions,
  host: RuntimeChatTurnHost): Promise<ChatTurnCancellationResult> {
  const parsed = chatTurnCancellationSchema.safeParse(input);
  if (!parsed.success) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
  const context = await loadPeerInvocationContext(projectRoot, parsed.data.scopeId, options, peer);
  const running = host.running.get(runningKey(parsed.data.scopeId, parsed.data.turnId));
  if (!running || running.principalKey !== principalKeyOf(context.principal)) return Object.freeze({ schemaVersion: 1, turnId: parsed.data.turnId, state: 'not-running' });
  running.controller.abort();
  return Object.freeze({ schemaVersion: 1, turnId: parsed.data.turnId, state: 'cancelling' });
}
