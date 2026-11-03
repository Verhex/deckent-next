import { lstat, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { nativeAgentInitReason, nativeAgentCorrelationSchema, nativeAgentToolResultSchema, toolSessionSchema,
  type NativeAgentReadinessReason, type NativeAgentCorrelation, type ToolSession, type ToolSessionPort } from '#capabilities/index.js';
import { nativeEffortArgs, type nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import type { ProcessEvidence } from '#adapters/core/process-runner/index.js';
import { emitDelta, reportedCounters } from './turn.js';
import type { ModelInvocationDeltaSink } from '#domain/index.js';

type Entry = NonNullable<ReturnType<typeof nativeCliAgent>>;
type Call = Parameters<ToolSessionPort['propose']>[0];
type ToolResult = Awaited<ReturnType<ToolSessionPort['propose']>>;
type Failure = Readonly<{ kind: 'refused'; reason: NativeAgentReadinessReason; field: string }>;
export type ClaudeAgentResult = Failure | Readonly<{ kind: 'cancelled' | 'failed'; subtype: 'error_during_execution' | 'incomplete' | 'provider-error' }>
  | Readonly<{ kind: 'completed'; text: string; usage: Readonly<Record<string, number>>; stopReason: string | null }>;
export type ClaudeAgentDriver = ToolSessionPort & Readonly<{ signal: AbortSignal; line(raw: string): 'stop' | void;
  finish(exit: Pick<ProcessEvidence, 'reason' | 'exitCode' | 'stdoutTruncated' | 'stderrTruncated'>): ClaudeAgentResult }>;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const objectJson = (value: string) => { try { return record(JSON.parse(value)); } catch { return null; } };
/** Only fixed diagnostic keys leave this adapter; CLI output and token-bearing I/O errors never become error messages. */
export class ClaudeAgentError extends Error {
  constructor(readonly reason: NativeAgentReadinessReason, readonly field: string) { super(reason); this.name = 'ClaudeAgentError'; }
}
function invalid(field: string): never { throw new ClaudeAgentError('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', field); }

/** The caller owns the existing private run dir and removes these files after the isolated process exits. No subscription state is read. */
export async function prepareClaudeAgentRun(entry: Entry, sessionInput: ToolSession, input: Readonly<{ runDir: string; model: string; system: string;
  turnToken: string; effort?: string }>) {
  const session = toolSessionSchema.parse(sessionInput), { agent, bridge, headless, command } = entry, { runDir, model, system, turnToken } = input;
  if (agent.transport.kind !== 'claude-mcp') invalid('transport');
  if (!isAbsolute(runDir) || await realpath(runDir).catch(() => null) !== resolve(runDir)) invalid('run-dir');
  const info = await lstat(runDir).catch(() => null);
  if (!info?.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) invalid('run-dir');
  if (!model || model.startsWith('-') || model.includes('\0') || command.modelAliases.includes(model) || !turnToken || /[\r\n\0]/u.test(turnToken)) invalid('request');
  if (Buffer.byteLength(system) > headless.limits.stdinMaxBytes) invalid('size');
  const transport = agent.transport, configFile = join(runDir, transport.mcpConfig.fileName), promptFile = join(runDir, headless.systemPromptFile);
  const slots: Record<string, string> = { '{mcpConfigFile}': configFile, '{toolList}': session.tools.map(tool => bridge.toolPrefix + tool.name).join(',') };
  // The template carries an admission-policy slot; the current product has no total-turn budget. Do not invent one from the text profile's 1.
  const args = agent.args.filter((arg, i) => arg !== '{maxTurns}' && agent.args[i + 1] !== '{maxTurns}').map(arg => slots[arg] ?? arg);
  const promptArgs = headless.systemPromptArgs?.map(arg => arg.replaceAll('{file}', promptFile)) ?? [headless.systemPromptFlag, promptFile];
  const capability = command.capabilities.reasoningEffort;
  if (input.effort !== undefined && !capability?.levels.includes(input.effort as never)) invalid('effort');
  const effortArgs = input.effort === undefined ? [] : nativeEffortArgs(capability, { schemaVersion: 1, level: input.effort as never, source: 'explicit', status: 'selected' });
  args.push(command.modelFlag, model, ...effortArgs, ...promptArgs);
  if (args.some(arg => /\{(?:mcpConfigFile|toolList|maxTurns)\}/u.test(arg) || arg.includes('\0')
    || agent.forbiddenFlags.some(flag => arg === flag || arg.startsWith(flag + '='))) || args.some(arg => arg.includes(turnToken))) invalid('argv');
  const template = transport.mcpConfig.server, header = bridge.tokenValueTemplate.replace('{turnToken}', turnToken);
  if (Object.keys(template.headers).length !== 1 || !Object.hasOwn(template.headers, bridge.tokenHeaderName)) invalid('headers');
  const config = { mcpServers: { [bridge.serverName]: { type: template.type, url: `http://${bridge.sentinelHost}${bridge.path}`,
    headers: { [bridge.tokenHeaderName]: header }, timeout: session.approvalTtlMs } } };
  if (Buffer.byteLength(JSON.stringify(config)) > bridge.bodyMaxBytes) invalid('size');
  const owned: string[] = [];
  try {
    for (const [path, content] of [[configFile, JSON.stringify(config)], [promptFile, system]] as const) {
      const file = await open(path, 'wx', 0o600); owned.push(path);
      try { await file.writeFile(content); } finally { await file.close(); }
    }
  } catch { await Promise.all(owned.map(path => rm(path, { force: true }))); invalid('run-files'); }
  return Object.freeze({ args: Object.freeze(args), configFile, promptFile,
    async dispose() { await Promise.all(owned.splice(0).map(path => rm(path, { force: true }))); } });
}

/** K4 wraps this ToolSessionPort, K1 remains its delegate. Feed stdout through line; pass signal to the existing isolated process runner.
 * Finish only after process exit. A facade call may precede its assistant tool_use (A0-4); both channels must agree before completion. */
export function createClaudeAgentDriver(options: Readonly<{ entry: Entry; port: ToolSessionPort; model: string; cliVersion: string; runDir: string;
  outputMaxBytes: number; onDelta?: ModelInvocationDeltaSink }>): ClaudeAgentDriver {
  const { entry, port, model, cliVersion, runDir } = options, session = toolSessionSchema.parse(port.session), controller = new AbortController();
  if (entry.agent.transport.kind !== 'claude-mcp' || !Number.isSafeInteger(options.outputMaxBytes) || options.outputMaxBytes <= 0) invalid('definition');
  type Seen = { name: string; input: Record<string, unknown>; streamed: boolean; deckentCallId?: string; promise?: Promise<ToolResult>; settled?: boolean };
  const calls = new Map<string, Seen>(), deckentIds = new Map<string, string>();
  let init = false, ended = false, terminal = false, bytes = 0, failure: Failure | null = null, result: Record<string, unknown> | null = null, final: ClaudeAgentResult | undefined;
  const fail = (field: string, reason: NativeAgentReadinessReason = 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED'): 'stop' => {
    failure ??= { kind: 'refused', reason, field }; controller.abort(); return 'stop';
  };
  const charge = (size: number) => { bytes += size; return Number.isSafeInteger(bytes) && bytes <= options.outputMaxBytes; };
  const checkCall = (name: unknown, input: unknown): input is Record<string, unknown> => typeof name === 'string'
    && session.tools.some(tool => tool.name === name) && record(input) !== null;
  const addStreamCall = (block: Record<string, unknown>) => {
    if (typeof block.id !== 'string' || !block.id || block.id.length > 256 || block.id.includes('\0') || typeof block.name !== 'string'
      || !block.name.startsWith(entry.bridge.toolPrefix)) return fail('tool-use');
    const name = block.name.slice(entry.bridge.toolPrefix.length), input = block.input;
    if (!checkCall(name, input)) return fail('tool-use');
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
    // Only A0's inert UI invalidation may precede init. Unknown notices, retries and permission denials stop the run.
    if (value.type === 'system' && value.subtype === 'ui_invalidate') return;
    if (!init) return fail('before-init');
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
      if (!message || !Array.isArray(message.content) || message.content.some(input => {
        const block = record(input); return !block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string' || !calls.has(block.tool_use_id);
      })) return fail('tool-result');
      return;
    }
    if (value.type === 'tool_progress') return typeof value.tool_use_id === 'string' && calls.has(value.tool_use_id) ? undefined : fail('tool-progress');
    if (value.type === 'rate_limit_event') {
      const info = record(value.rate_limit_info);
      return info?.status === 'allowed' || info?.status === 'allowed_warning' ? undefined : fail('rate-limit');
    }
    if (value.type !== 'result') return fail('event');
    terminal = true;
    if (!Array.isArray(value.permission_denials) || value.permission_denials.length) return fail('permission-denials');
    if (typeof value.is_error !== 'boolean' || typeof value.subtype !== 'string') return fail('result');
    result = value;
    if (value.is_error || value.subtype !== 'success') return;
    if (typeof value.result !== 'string' || !reportedCounters(value.usage, ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'])) return fail('usage');
    const models = record(value.modelUsage);
    if (!models || Object.keys(models).length !== 1 || !Object.hasOwn(models, model)) return fail('model-usage');
    if ([...calls.values()].some(call => !call.streamed || !call.settled)) return fail('correlation-incomplete');
  };
  const propose: ToolSessionPort['propose'] = async (call: Call, correlation: NativeAgentCorrelation, signal: AbortSignal) => {
    function refuse(field: string): never { fail(field); throw new ClaudeAgentError(failure!.reason, failure!.field); }
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
    }).catch(() => {
      if (failure) throw new ClaudeAgentError(failure.reason, failure.field);
      if (controller.signal.aborted || signal.aborted) throw new ClaudeAgentError('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', 'cancelled');
      return refuse('facade-result');
    });
    return current.promise;
  };
  return Object.freeze({ session, signal: controller.signal, line, propose,
    async cancel() { ended = true; controller.abort(); return port.cancel(); },
    async revoke() { ended = true; controller.abort(); return port.revoke(); },
    finish(exit: Pick<ProcessEvidence, 'reason' | 'exitCode' | 'stdoutTruncated' | 'stderrTruncated'>): ClaudeAgentResult {
      if (final) return final;
      ended = true;
      if (failure) return final = failure;
      if (exit.reason === 'cancelled' || controller.signal.aborted) { controller.abort(); return final = { kind: 'cancelled', subtype: result?.subtype === 'error_during_execution' ? 'error_during_execution' : 'incomplete' }; }
      controller.abort();
      if (exit.reason !== 'exit' || exit.exitCode !== 0 || exit.stdoutTruncated || exit.stderrTruncated || !result) return final = { kind: 'failed', subtype: 'incomplete' };
      if (result.is_error || result.subtype !== 'success') return final = { kind: 'failed', subtype: result.subtype === 'error_during_execution' ? 'error_during_execution' : 'provider-error' };
      return final = { kind: 'completed', text: result.result as string, usage: reportedCounters(result.usage, ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'])!,
        stopReason: typeof result.stop_reason === 'string' ? result.stop_reason : null };
    },
  });
}
