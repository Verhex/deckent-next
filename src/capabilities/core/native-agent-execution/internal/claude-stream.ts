import { isDeepStrictEqual } from 'node:util';
import type { ModelInvocationDeltaSink } from '#domain/index.js';
import { nativeAgentInitReason } from './guards.js';
import { nativeAgentCorrelationSchema, nativeAgentToolResultSchema, toolSessionSchema, type NativeAgentCorrelation, type ToolSessionPort } from './session.js';
import type { NativeAgentReadinessReason } from './contract.js';
import type { parseNativeCliRegistry } from './command-registry.js';
import { emitDelta, reportedCounters } from './stream.js';
type StreamExit = Readonly<{ reason: string; exitCode: number | null; stdoutTruncated: boolean; stderrTruncated: boolean }>;
type Registry = ReturnType<typeof parseNativeCliRegistry>;
type Command = Registry['adapters'][string];
type Entry = { id: string; command: Command; headless: NonNullable<Command['headless']>; agent: NonNullable<Command['agent']>; bridge: NonNullable<Registry['agentBridge']> };
type Call = Parameters<ToolSessionPort['propose']>[0];
type ToolResult = Awaited<ReturnType<ToolSessionPort['propose']>>;
type Failure = Readonly<{ kind: 'refused'; reason: NativeAgentReadinessReason; field: string; detail?: string }>;
export type ClaudeAgentResult = Failure | Readonly<{ kind: 'cancelled' | 'failed'; subtype: 'error_during_execution' | 'incomplete' | 'provider-error' }>
  | Readonly<{ kind: 'completed'; text: string; usage: Readonly<Record<string, number>>; stopReason: string | null }>;
export type ClaudeAgentDriver = ToolSessionPort & Readonly<{ signal: AbortSignal; line(raw: string): 'stop' | void;
  finish(exit: StreamExit): ClaudeAgentResult; notices(): readonly string[] }>;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const objectJson = (value: string) => { try { return record(JSON.parse(value)); } catch { return null; } };
/** R5b: shape facts for a refusal's record. Identifier-shaped names and codes only (never arguments, text or CLI output), at most 64 characters. */
const fact = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,48}$/u.test(value) ? value : '?';
const facts = (parts: readonly string[]) => parts.join(' ').slice(0, 64);
/** Only fixed diagnostic keys leave this adapter; CLI output and token-bearing I/O errors never become error messages. */
export class ClaudeAgentError extends Error {
  constructor(readonly reason: NativeAgentReadinessReason, readonly field: string) { super(reason); this.name = 'ClaudeAgentError'; }
}
function invalid(field: string): never { throw new ClaudeAgentError('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', field); }

/** K4 wraps this ToolSessionPort, K1 remains its delegate. Feed stdout through line; pass signal to the existing isolated process runner.
 * Finish only after process exit. A facade call may precede its assistant tool_use (A0-4); both channels must agree before completion. */
export function createClaudeAgentDriver(options: Readonly<{ entry: Entry; port: ToolSessionPort; model: string; cliVersion: string; runDir: string;
  outputMaxBytes: number; onDelta?: ModelInvocationDeltaSink }>): ClaudeAgentDriver {
  const { entry, port, model, cliVersion, runDir } = options, session = toolSessionSchema.parse(port.session), controller = new AbortController();
  if (entry.agent.transport.kind !== 'claude-mcp' || !Number.isSafeInteger(options.outputMaxBytes) || options.outputMaxBytes <= 0) invalid('definition');
  type Seen = { name: string; input: Record<string, unknown>; streamed: boolean; deckentCallId?: string; promise?: Promise<ToolResult>; settled?: boolean };
  const calls = new Map<string, Seen>(), deckentIds = new Map<string, string>();
  // Owner 2026-11-05: an unrecognised event is recorded as a note (identifier only, bounded) and the turn goes on; a registry stop event stops it.
  const notices = new Set<string>(), stopEvents = new Set(entry.agent.transport.guards.stopEvents);
  const notice = (value: Record<string, unknown>): 'stop' | undefined => {
    // Case-folded so a spelling variant cannot pass a stop event; a non-identifier name ('?') stops too.
    const type = fact(value.type).toLowerCase(), name = `${type}${value.subtype === undefined ? '' : `/${fact(value.subtype).toLowerCase()}`}`;
    if (name.includes('?') || stopEvents.has(name) || stopEvents.has(type)) return fail('event', undefined, facts([name]));
    if (notices.size < 8) notices.add(name.slice(0, 64)); return undefined;
  };
  let init = false, ended = false, terminal = false, bytes = 0, failure: Failure | null = null, result: Record<string, unknown> | null = null, final: ClaudeAgentResult | undefined;
  let usage: Readonly<Record<string, number>> | null = null;
  const fail = (field: string, reason: NativeAgentReadinessReason = 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', detail?: string): 'stop' => {
    failure ??= { kind: 'refused', reason, field, ...(detail === undefined ? {} : { detail }) }; controller.abort(); return 'stop';
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
    if (prior && (prior.streamed || prior.name !== name || !isDeepStrictEqual(prior.input, input))) return fail('correlation');
    if (prior) prior.streamed = true; else calls.set(block.id, { name, input, streamed: true });
    return undefined;
  };
  const line = (raw: string): 'stop' | void => {
    if (failure) return 'stop';
    if (ended || terminal) return fail('after-result');
    if (Buffer.byteLength(raw) > entry.headless.limits.maxLineBytes || !charge(Buffer.byteLength(raw) + 1)) return fail('size');
    const value = objectJson(raw);
    if (!value || typeof value.type !== 'string') return fail('json');
    if (value.type === 'system' && value.subtype === 'init') {
      if (init) return fail('init');
      const reason = nativeAgentInitReason(entry.agent, entry.bridge, session, value);
      if (reason) return fail('init', reason);
      if (value.model !== model || value.claude_code_version !== cliVersion || value.cwd !== runDir
        || value.plugin_errors !== undefined && (!Array.isArray(value.plugin_errors) || value.plugin_errors.length !== 0)) return fail('init-binding');
      init = true; return;
    }
    // A0's inert invalidation may precede init; other system events follow the registry stop rules.
    if (value.type === 'system' && value.subtype === 'ui_invalidate') return;
    if (!init) return value.type === 'system' ? notice(value) : fail('before-init');
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
      if (!message || message.model !== model || !Array.isArray(message.content)) return fail('assistant');
      // Validate the whole message before emitting any text or accepting its tool records.
      for (const input of message.content) {
        const block = record(input);
        if (!block) return fail('block');
        if (block.type === 'tool_use') { if (addStreamCall(block)) return 'stop'; }
        else if (block.type === 'text') { if (typeof block.text !== 'string') return fail('text'); }
        else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') return fail('block');
      }
      for (const block of message.content as Record<string, unknown>[]) if (block.type === 'text') emitDelta(options.onDelta, block.text as string);
      return;
    }
    if (value.type === 'user') {
      const message = record(value.message);
      const foreign = !message || !Array.isArray(message.content) ? null : message.content.find(input => {
        const block = record(input); return !block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string' || !calls.has(block.tool_use_id);
      });
      if (foreign === null || foreign !== undefined) return fail('tool-result', undefined, foreign === null ? 'shape'
        : facts([`type=${fact(record(foreign)?.type)}`, `known=${typeof record(foreign)?.tool_use_id === 'string' && calls.has(record(foreign)!.tool_use_id as string) ? 1 : 0}`]));
      return;
    }
    if (value.type === 'tool_progress') return typeof value.tool_use_id === 'string' && calls.has(value.tool_use_id) ? undefined : fail('tool-progress');
    if (value.type === 'rate_limit_event') {
      const info = record(value.rate_limit_info);
      return info?.status === 'allowed' || info?.status === 'allowed_warning' ? undefined : fail('rate-limit');
    }
    if (value.type !== 'result') return notice(value);
    terminal = true;
    if (!Array.isArray(value.permission_denials) || value.permission_denials.length) return fail('permission-denials', undefined, Array.isArray(value.permission_denials)
      ? facts(value.permission_denials.map(denial => offeredName(record(denial)?.tool_name))) : 'shape');
    if (typeof value.is_error !== 'boolean' || typeof value.subtype !== 'string') return fail('result');
    result = value;
    if (value.is_error || value.subtype !== 'success') return;
    usage = reportedCounters(value.usage, ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']);
    if (typeof value.result !== 'string' || !usage) return fail('usage');
    const models = record(value.modelUsage);
    if (!models || Object.keys(models).length !== 1 || !Object.hasOwn(models, model)) return fail('model-usage');
    if ([...calls.values()].some(call => !call.streamed || !call.settled)) return fail('correlation-incomplete');
  };
  const propose: ToolSessionPort['propose'] = async (call: Call, correlation: NativeAgentCorrelation, signal: AbortSignal) => {
    function refuse(field: string, detail?: string): never { fail(field, undefined, detail); throw new ClaudeAgentError(failure!.reason, failure!.field); }
    if (failure || controller.signal.aborted || signal.aborted || !init || ended || terminal) refuse('proposal-order');
    const checked = nativeAgentCorrelationSchema.safeParse(correlation), input = objectJson(call.argumentsJson);
    if (!checked.success || checked.data.kind !== 'claude-tool-use' || call.id !== checked.data.deckentCallId || !checkCall(call.name, input)) refuse('proposal');
    const id = (checked.data as Extract<NativeAgentCorrelation, { kind: 'claude-tool-use' }>).toolUseId;
    const prior = calls.get(id), previousId = deckentIds.get(call.id);
    if (previousId !== undefined && previousId !== id || prior && (prior.name !== call.name || !isDeepStrictEqual(prior.input, input)
      || prior.deckentCallId !== undefined && prior.deckentCallId !== call.id)) refuse('correlation');
    if (prior?.promise) return prior.promise;
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
      current.settled = true; return parsed.data;
    }).catch((error: unknown) => {
      if (failure) throw new ClaudeAgentError(failure.reason, failure.field);
      if (controller.signal.aborted || signal.aborted) throw new ClaudeAgentError('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', 'cancelled');
      // R5b: the facade's typed code only (an error-registry identifier), never its message.
      return refuse('facade-result', facts([`code=${fact((error as { code?: unknown } | null)?.code)}`]));
    });
    return current.promise;
  };
  return Object.freeze({ session, signal: controller.signal, line, propose, notices: () => [...notices],
    async cancel() { ended = true; controller.abort(); return port.cancel(); },
    async revoke() { ended = true; controller.abort(); return port.revoke(); },
    finish(exit: StreamExit): ClaudeAgentResult {
      if (final) return final;
      ended = true;
      if (failure) return final = failure;
      if (exit.reason === 'cancelled' || controller.signal.aborted) { controller.abort(); return final = { kind: 'cancelled', subtype: result?.subtype === 'error_during_execution' ? 'error_during_execution' : 'incomplete' }; }
      controller.abort();
      if (exit.reason !== 'exit' || exit.exitCode !== 0 || exit.stdoutTruncated || exit.stderrTruncated || !result) return final = { kind: 'failed', subtype: 'incomplete' };
      if (result.is_error || result.subtype !== 'success') return final = { kind: 'failed', subtype: result.subtype === 'error_during_execution' ? 'error_during_execution' : 'provider-error' };
      return final = { kind: 'completed', text: result.result as string, usage: usage!,
        stopReason: typeof result.stop_reason === 'string' ? result.stop_reason : null };
    },
  });
}
