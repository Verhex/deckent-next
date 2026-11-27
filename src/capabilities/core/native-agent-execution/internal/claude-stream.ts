import { nativeBuiltinPlugins } from './plugins.js';
import { CodedError } from '#platform/index.js';
import { isDeepStrictEqual } from 'node:util';
import type { ModelInvocationDeltaSink } from '#domain/index.js';
import { nativeAgentInitReason } from './guards.js';
import { nativeAgentCorrelationSchema, nativeAgentToolResultSchema, toolSessionSchema, type NativeAgentCorrelation, type NativeAgentToolResult, type ToolSessionPort } from './session.js';
import type { NativeAgentReadinessReason } from './contract.js';
import type { parseNativeCliRegistry } from './command-registry.js';
import { emitDelta, reportedCounters } from './stream.js';
import { classifyClaudeRateLimit, nativeClaudeResultRefusal, nativeModelRefusal, type ClaudeQuotaPolicy, type ClaudeRateLimit } from './quota.js';
type StreamExit = Readonly<{ reason: string; exitCode: number | null; stdoutTruncated: boolean; stderrTruncated: boolean }>;
type Registry = ReturnType<typeof parseNativeCliRegistry>;
type Command = Registry['adapters'][string];
type Entry = { id: string; command: Command; headless: NonNullable<Command['headless']>; agent: NonNullable<Command['agent']>; bridge: NonNullable<Registry['agentBridge']> };
type Call = Parameters<ToolSessionPort['propose']>[0];
type ToolResult = Awaited<ReturnType<ToolSessionPort['propose']>>;
type Rejection = ReturnType<typeof nativeModelRefusal>;
type Failure = Readonly<{ kind: 'refused'; reason: NativeAgentReadinessReason; field: string; detail?: string; limit?: ClaudeRateLimit; rejection?: Rejection }>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type ClaudeAgentResult = Failure | Readonly<{ kind: 'cancelled' | 'failed'; subtype: 'error_during_execution' | 'incomplete' | 'provider-error'; rejection?: Rejection }>
  | Readonly<{ kind: 'completed'; text: string; usage: Readonly<Record<string, number>>; stopReason: string | null }>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type ClaudeAgentDriver = ToolSessionPort & Readonly<{ signal: AbortSignal; line(raw: string, signal?: AbortSignal): 'stop' | void | Promise<'stop' | void>;
  finish(exit: StreamExit): ClaudeAgentResult; notices(): readonly string[]; builtinPlugins(): readonly string[]; paidExtraUsage(): ClaudeRateLimit | null;
  /** N0: what the guard itself saw: every validated built-in plugin entry, the first overage report as classified (before a stop rewrites it)
   * and whether it accepted the terminal result line. */
  observedFacts(): Readonly<{ builtinPluginCount: number; paidExtraUsage: ClaudeRateLimit | null; terminal: boolean }> }>;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const objectJson = (value: string) => { try { return record(JSON.parse(value)); } catch { return null; } };
/** R5b: shape facts for a refusal's record. Identifier-shaped names and codes only (never arguments, text or CLI output), at most 64 characters. */
const fact = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,48}$/u.test(value) ? value : '?';
const facts = (parts: readonly string[]) => parts.join(' ').slice(0, 64);
/** Only fixed diagnostic keys leave this adapter; CLI output and token-bearing I/O errors never become error messages. */
export class ClaudeAgentError extends CodedError {
  constructor(readonly reason: NativeAgentReadinessReason, readonly field: string) { super(reason); this.name = 'ClaudeAgentError'; }
}
function invalid(field: string): never { throw new ClaudeAgentError('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', field); }

/** Private observations shared by the two wire readers. K1 owns challenge and settlement validation. */
interface PlanningWire {
  readonly active: boolean;
  readonly delivered: boolean;
  session(id: string): void;
  delivery(envelope: NativeAgentToolResult): void;
  replay(envelope: NativeAgentToolResult): void;
  terminal(id: string, text: string): void;
  response(): string;
}

/** K4 wraps this ToolSessionPort, K1 remains its delegate. Feed stdout through line; pass signal to the existing isolated process runner.
 * Finish only after process exit. A facade call may precede its assistant tool_use (A0-4); both channels must agree before completion. */
export function createClaudeAgentDriver(options: Readonly<{ entry: Entry; port: ToolSessionPort; model: string; cliVersion: string; runDir: string;
  outputMaxBytes: number; planning?: PlanningWire; quotaPolicy: ClaudeQuotaPolicy; paidExtraUsage?: 'continue' | 'stop-at-limit'; onPaidUsage?: (limit: ClaudeRateLimit, signal?: AbortSignal) => Promise<void>; onDelta?: ModelInvocationDeltaSink }>): ClaudeAgentDriver {
  const { entry, port, model, cliVersion, runDir } = options, session = toolSessionSchema.parse(port.session), controller = new AbortController();
  if (entry.agent.transport.kind !== 'claude-mcp' || !Number.isSafeInteger(options.outputMaxBytes) || options.outputMaxBytes <= 0) invalid('definition');
  type Seen = { name: string; input: Record<string, unknown>; streamed: boolean; deckentCallId?: string; promise?: Promise<ToolResult>; settled?: boolean };
  const wire = options.planning, oldMessages = new Set<string>();
  let sessionId: unknown, priorIdentityUnknown = false, finalId: string | undefined, finalRequestId: string | undefined, finalText = '';
  let lastProseId: string | undefined, proseEndsWithWhitespace = true, toolBetweenProse = false;
  const calls = new Map<string, Seen>(), deckentIds = new Map<string, string>();
  // Owner 2026-11-05: an unrecognised event is recorded as a note (identifier only, bounded) and the turn goes on; a registry stop event stops it.
  const pluginPolicy = entry.agent.transport.guards.plugins;
  let builtinPlugins: readonly string[] = [];
  const notices = new Set<string>(), stopEvents = new Set(entry.agent.transport.guards.stopEvents);
  const notice = (value: Record<string, unknown>): 'stop' | undefined => {
    // Case-folded so a spelling variant cannot pass a stop event; a non-identifier name ('?') stops too.
    const type = fact(value.type).toLowerCase(), name = `${type}${value.subtype === undefined ? '' : `/${fact(value.subtype).toLowerCase()}`}`;
    if (name.includes('?') || stopEvents.has(name) || stopEvents.has(type)) return fail('event', undefined, facts([name]));
    if (!wire?.active && notices.size < 8) notices.add(name.slice(0, 64)); return undefined;
  };
  let init = false, ended = false, terminal = false, bytes = 0, failure: Failure | null = null, result: Record<string, unknown> | null = null, final: ClaudeAgentResult | undefined;
  let paidUsage: ClaudeRateLimit | null = null, firstOverage: ClaudeRateLimit | null = null, builtinPluginCount = 0;
  let usage: Readonly<Record<string, number>> | null = null;
  const fail = (field: string, reason: NativeAgentReadinessReason = 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', detail?: string, limit?: ClaudeRateLimit): 'stop' => {
    failure ??= { kind: 'refused', reason, field, ...(detail === undefined ? {} : { detail }), ...(limit ? { limit } : {}) }; controller.abort(); return 'stop';
  };
  const failModel = (field: string, models: readonly unknown[]): 'stop' => {
    failure ??= { kind: 'refused', reason: 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', field, rejection: nativeModelRefusal(field, models) };
    controller.abort(); return 'stop';
  };
  const charge = (size: number) => { bytes += size; return Number.isSafeInteger(bytes) && bytes <= options.outputMaxBytes; };
  // A model-chosen name is echoed only when it is a tool Deckent offered: an arbitrary name could carry anything.
  const offeredName = (value: unknown) => typeof value === 'string' && value.startsWith(entry.bridge.toolPrefix)
    && session.tools.some(tool => tool.name === value.slice(entry.bridge.toolPrefix.length)) ? value : '?';
  const checkCall = (name: unknown, input: unknown): input is Record<string, unknown> => typeof name === 'string'
    && session.tools.some(tool => tool.name === name) && record(input) !== null;
  const addStreamCall = (block: Record<string, unknown>) => {
    const prefixed = typeof block.name === 'string' && block.name.startsWith(entry.bridge.toolPrefix), offered = prefixed && session.tools.some(tool => tool.name === (block.name as string).slice(entry.bridge.toolPrefix.length));
    const toolFacts = () => facts([`name=${offeredName(block.name)}`, `prefix=${prefixed ? 1 : 0}`, `offered=${offered ? 1 : 0}`]);
    if (typeof block.id !== 'string' || !block.id || block.id.length > 256 || block.id.includes('\0') || typeof block.name !== 'string'
      || !prefixed) return fail('tool-use', undefined, toolFacts());
    const name = block.name.slice(entry.bridge.toolPrefix.length), input = block.input;
    if (!checkCall(name, input)) return fail('tool-use', undefined, toolFacts());
    const prior = calls.get(block.id);
    if (wire?.active && !prior) return fail('planning-tool');
    if (prior && (prior.streamed || prior.name !== name || !isDeepStrictEqual(prior.input, input))) return fail('correlation');
    if (prior) prior.streamed = true; else calls.set(block.id, { name, input, streamed: true });
    return undefined;
  };
  const line = (raw: string, signal?: AbortSignal): 'stop' | void | Promise<'stop' | void> => {
    if (failure) return 'stop';
    if (ended || terminal) return fail('after-result');
    if (Buffer.byteLength(raw) > entry.headless.limits.maxLineBytes || !charge(Buffer.byteLength(raw) + 1)) return fail('size');
    const value = objectJson(raw);
    if (!value || typeof value.type !== 'string') return fail('json');
    if (value.type === 'system' && value.subtype === 'init') {
      if (init) return fail('init');
      const reason = nativeAgentInitReason(entry.agent, entry.bridge, session, value);
      if (reason) return fail('init', reason);
      if (value.model !== model) return failModel('init-binding', [value.model]);
      if (value.claude_code_version !== cliVersion || value.cwd !== runDir
        || value.plugin_errors !== undefined && (!Array.isArray(value.plugin_errors) || value.plugin_errors.length !== 0)) return fail('init-binding');
      builtinPlugins = nativeBuiltinPlugins(value.plugins, pluginPolicy)!; builtinPluginCount = (value.plugins as readonly unknown[]).length;
      sessionId = value.session_id;
      if (typeof sessionId === 'string' && sessionId) wire?.session(sessionId);
      init = true; return;
    }
    // A0's inert invalidation may precede init; other system events follow the registry stop rules.
    if (value.type === 'system' && value.subtype === 'ui_invalidate') return;
    if (!init) return value.type === 'system' ? notice(value) : fail('before-init');
    if (wire?.active && (!sessionId || value.session_id !== sessionId)) return fail('planning-session');
    // CLI 2.1.318 thinking progress: two token estimates, no content.
    if (value.type === 'system' && value.subtype === 'thinking_tokens' && value.parent_tool_use_id == null
      && [value.estimated_tokens, value.estimated_tokens_delta].every(n => typeof n === 'number' && Number.isFinite(n))) return;
    // CLI keepalive (A0 claude-keepalive): each 30 s of a pending offered call it names that call as parent and carries no content.
    const parentId = typeof value.parent_tool_use_id === 'string' ? value.parent_tool_use_id : '', parent = calls.get(parentId);
    if (value.type === 'tool_progress' && value.heartbeat === true && parent && value.tool_name === entry.bridge.toolPrefix + parent.name
      && typeof value.tool_use_id === 'string' && value.tool_use_id.startsWith(parentId) && /^-heartbeat-\d{1,9}$/u.test(value.tool_use_id.slice(parentId.length))) return;
    if (value.parent_tool_use_id !== undefined && value.parent_tool_use_id !== null) return fail('subagent');
    if (value.type === 'assistant') {
      const message = record(value.message);
      if (!message) return fail('assistant');
      if (message.model !== model) return failModel('assistant', [message.model]);
      if (!Array.isArray(message.content)) return fail('assistant');
      if (wire) {
        const id = message.id, top = typeof id === 'string' && id.length > 0 && message.type === 'message' && message.role === 'assistant'
          && value.parent_tool_use_id === null && value.session_id === sessionId;
        if (wire.delivered) {
          if (!top || priorIdentityUnknown || oldMessages.has(id) || finalId !== undefined && finalId !== id
            || message.stop_reason != null && message.stop_reason !== 'end_turn') return fail('planning-message');
          if (typeof value.request_id === 'string') {
            if (finalRequestId !== undefined && value.request_id !== finalRequestId) return fail('planning-request-id');
            finalRequestId = value.request_id;
          }
          finalId = id;
        } else if (top) oldMessages.add(id);
        else priorIdentityUnknown = true;
      }
      // Validate the whole message before emitting any text or accepting its tool records.
      for (const input of message.content) {
        const block = record(input);
        if (!block) return fail('block');
        if (block.type === 'tool_use') {
          if (wire?.delivered) return fail('planning-tool');
          if (addStreamCall(block)) return 'stop';
        }
        else if (block.type === 'text') { if (typeof block.text !== 'string') return fail('text'); }
        else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') return fail('block');
      }
      // Claude can emit separate records for the content blocks of one message.
      const messageId = typeof message.id === 'string' && message.id ? message.id : undefined;
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type === 'tool_use' && calls.get(block.id as string)?.settled) toolBetweenProse = true;
        if (block.type !== 'text') continue;
        const text = block.text as string;
        if (wire?.delivered) finalText += text;
        else if (!wire?.active && text) {
          const separates = toolBetweenProse && messageId !== undefined && lastProseId !== undefined && messageId !== lastProseId
            && !proseEndsWithWhitespace && !/^\s/u.test(text);
          toolBetweenProse = false;
          emitDelta(options.onDelta, separates ? '\n\n' + text : text);
          lastProseId = messageId;
          proseEndsWithWhitespace = /\s$/u.test(text);
        }
      }
      return;
    }
    if (value.type === 'user') {
      const message = record(value.message);
      const foreign = !message || !Array.isArray(message.content) ? null : message.content.find(input => {
        const block = record(input); return !block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string' || !calls.has(block.tool_use_id);
      });
      if (foreign === null || foreign !== undefined) return fail('tool-result', undefined, foreign === null ? 'shape'
        : facts([`type=${fact(record(foreign)?.type)}`, `known=${typeof record(foreign)?.tool_use_id === 'string' && calls.has(record(foreign)!.tool_use_id as string) ? 1 : 0}`]));
      if (wire?.active) {
        const blocks = message!.content as Record<string, unknown>[];
        if (value.parent_tool_use_id !== null || message!.role !== 'user' || blocks.length !== 1 || wire.delivered) return fail('planning-delivery');
        const block = blocks[0]!, call = calls.get(block.tool_use_id as string);
        if (Array.isArray(value.tool_result_meta) && value.tool_result_meta.some(entry => {
          const id = record(entry)?.id;
          return id != null && id !== block.tool_use_id;
        })) return fail('planning-delivery-id');
        const content = block.content, text = Array.isArray(content) && content.length === 1 ? record(content[0]) : null;
        if (!call?.settled || !call.streamed || block.is_error !== undefined && block.is_error !== false
          || text?.type !== 'text' || typeof text.text !== 'string'
          || value.tool_use_result !== undefined && !isDeepStrictEqual(value.tool_use_result, content)) return fail('planning-delivery');
        const decoded = nativeAgentToolResultSchema.safeParse(objectJson(text.text));
        if (!decoded.success || decoded.data.deckentCallId !== call.deckentCallId || decoded.data.outcome.status !== 'ok') return fail('planning-delivery');
        wire.delivery(decoded.data);
      }
      return;
    }
    if (value.type === 'tool_progress') return typeof value.tool_use_id === 'string' && calls.has(value.tool_use_id) ? undefined : fail('tool-progress');
    if (value.type === 'rate_limit_event') {
      const guards = entry.headless.guards;
      const limit = classifyClaudeRateLimit(record(value.rate_limit_info) ?? {}, options.quotaPolicy, 'creditsErrors' in guards ? guards.creditsErrors : [], options.paidExtraUsage);
      if (limit.kind === 'overage') {
        // N0: the fact is kept only from a line of the session accepted at init (non-empty id); the stop below is unchanged either way.
        if (typeof sessionId === 'string' && sessionId && value.session_id === sessionId) firstOverage ??= limit;
        const stop = () => fail('rate-limit', undefined, `${limit.status} ${limit.window} ${limit.resetsAtMs ?? '?'}`, { ...limit, kind: 'quota' });
        const deliver = options.onPaidUsage;
        const shown = wire?.active ? { ...limit, window: '?' } : limit;
        if (!deliver) return stop();
        return Promise.resolve().then(() => deliver(shown, signal)).then(() => { if (signal?.aborted || ended) return stop(); paidUsage ??= shown; }, stop);
      }
      return limit.kind === 'allowed' ? undefined : fail(limit.kind === 'unknown' ? 'rate-limit-status' : 'rate-limit', undefined,
        `${limit.status} ${limit.window} ${limit.resetsAtMs ?? '?'}`, limit);
    }
    if (value.type !== 'result') {
      if (wire && value.type === 'stream_event') {
        if (wire.active) return fail('planning-message');
        priorIdentityUnknown = true;
      }
      return notice(value);
    }
    terminal = true;
    if (!Array.isArray(value.permission_denials) || value.permission_denials.length) return fail('permission-denials', undefined, Array.isArray(value.permission_denials)
      ? facts(value.permission_denials.map(denial => offeredName(record(denial)?.tool_name))) : 'shape');
    if (typeof value.is_error !== 'boolean' || typeof value.subtype !== 'string') return fail('result');
    result = value;
    if (value.is_error || value.subtype !== 'success') return;
    usage = reportedCounters(value.usage, ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']);
    if (typeof value.result !== 'string' || !usage) return fail('usage');
    const models = record(value.modelUsage);
    if (!models || Object.keys(models).length !== 1 || !Object.hasOwn(models, model))
      return failModel('model-usage', Object.keys(models ?? {}).filter(reported => reported !== model));
    if ([...calls.values()].some(call => !call.streamed || !call.settled)) return fail('correlation-incomplete');
    if (wire?.active) {
      if (value.api_error_status != null) return fail('planning-api-error-status');
      if (!wire.delivered || !finalId || value.result !== finalText || value.stop_reason !== 'end_turn'
        || value.terminal_reason !== undefined && value.terminal_reason !== 'completed') return fail('planning-finish');
      wire.terminal(finalId, finalText);
    }
  };
  const propose: ToolSessionPort['propose'] = async (call: Call, correlation: NativeAgentCorrelation, signal: AbortSignal) => {
    function refuse(field: string, detail?: string): never { fail(field, undefined, detail); throw new ClaudeAgentError(failure!.reason, failure!.field); }
    if (failure || controller.signal.aborted || signal.aborted || !init || ended || terminal) refuse('proposal-order');
    if (wire && (!sessionId || typeof sessionId !== 'string') && call.name === 'propose_work') refuse('planning-session');
    const checked = nativeAgentCorrelationSchema.safeParse(correlation), input = objectJson(call.argumentsJson);
    if (!checked.success || checked.data.kind !== 'claude-tool-use' || call.id !== checked.data.deckentCallId || !checkCall(call.name, input)) refuse('proposal');
    const id = (checked.data as Extract<NativeAgentCorrelation, { kind: 'claude-tool-use' }>).toolUseId;
    const prior = calls.get(id), previousId = deckentIds.get(call.id);
    if (previousId !== undefined && previousId !== id || prior && (prior.name !== call.name || !isDeepStrictEqual(prior.input, input)
      || prior.deckentCallId !== undefined && prior.deckentCallId !== call.id)) refuse('correlation');
    if (prior?.promise) {
      const seen = await prior.promise;
      if (wire?.active) wire.replay(seen);
      return seen;
    }
    if (!charge(Buffer.byteLength(JSON.stringify([call, correlation])))) refuse('size');
    const current: Seen = prior ?? { name: call.name, input: input!, streamed: false };
    current.deckentCallId = call.id; calls.set(id, current); deckentIds.set(call.id, id);
    const proposed = Object.freeze({ ...call }), correlated = checked.data;
    // Defer the delegate one microtask so concurrent replay sees the installed promise, never a second effect.
    current.promise = Promise.resolve().then(() => {
      if (controller.signal.aborted || signal.aborted) refuse('proposal-order');
      return port.propose(proposed, correlated, AbortSignal.any([signal, controller.signal]));
    }).then(value => {
      const parsed = nativeAgentToolResultSchema.safeParse(value);
      if (!parsed.success || parsed.data.turnId !== session.turnId || parsed.data.generation !== session.generation || parsed.data.deckentCallId !== call.id
        || Buffer.byteLength(JSON.stringify(value)) > entry.bridge.frameMaxBytes) refuse('facade-result');
      current.settled = true;
      if (current.streamed) toolBetweenProse = true;
      return parsed.data;
    }).catch((error: unknown) => {
      if (failure) throw new ClaudeAgentError(failure.reason, failure.field);
      if (controller.signal.aborted || signal.aborted) throw new ClaudeAgentError('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', 'cancelled');
      // R5b: the facade's typed code only (an error-registry identifier), never its message.
      return refuse('facade-result', facts([`code=${fact((error as { code?: unknown } | null)?.code)}`]));
    });
    return current.promise;
  };
  return Object.freeze({ session, signal: controller.signal, line, propose, notices: () => wire?.active ? [] : [...notices], builtinPlugins: () => builtinPlugins, paidExtraUsage: () => paidUsage,
    observedFacts: () => Object.freeze({ builtinPluginCount, paidExtraUsage: firstOverage, terminal: terminal && !failure }),
    async cancel() { ended = true; controller.abort(); return port.cancel(); },
    async revoke() { ended = true; controller.abort(); return port.revoke(); },
    finish(exit: StreamExit): ClaudeAgentResult {
      if (final) return final;
      ended = true;
      if (failure) return final = failure;
      const guards = entry.headless.guards;
      const rejection = result && (result.is_error || result.subtype !== 'success') && 'creditsErrors' in guards
        ? nativeClaudeResultRefusal(typeof result.api_error_status === 'number' ? result.api_error_status : null,
          Array.isArray(result.errors) ? result.errors : [], guards) : null;
      // C2: a provider status read from the terminal result stays next to the cancellation; the outcome is still cancelled.
      if (exit.reason === 'cancelled' || controller.signal.aborted) { controller.abort(); return final = { kind: 'cancelled',
        subtype: result?.subtype === 'error_during_execution' ? 'error_during_execution' : 'incomplete', ...(rejection && { rejection }) }; }
      controller.abort();
      if (exit.reason !== 'exit' || exit.exitCode !== 0 || exit.stdoutTruncated || exit.stderrTruncated || !result)
        return final = { kind: 'failed', subtype: 'incomplete', ...(rejection && { rejection }) };
      if (result.is_error || result.subtype !== 'success')
        return final = { kind: 'failed', subtype: result.subtype === 'error_during_execution' ? 'error_during_execution' : 'provider-error', ...(rejection && { rejection }) };
      return final = { kind: 'completed', text: result.result as string, usage: usage!,
        stopReason: typeof result.stop_reason === 'string' ? result.stop_reason : null };
    },
  });
}
