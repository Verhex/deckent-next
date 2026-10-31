import { headlessEgressReasons } from '#domain/index.js';
import { realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { modelInvocationProfileSchema, parseModelBindingDefinition, type ModelInvocationDeltaSink, type ModelInvocationNativeResult,
  type HeadlessEgress, type ModelInvocationProfile } from '#domain/index.js';
import { createModelInvocationResponseEvidence, modelInvocationNativeResponseUpperBound, type ModelInvocationNativePort } from '#engine/index.js';
import { nativeCliHeadless, nativeEffortArgs } from '#adapters/core/native-cli-registry/index.js';
import { nativeQuotaPolicy, parseClaudeStreamLine, type ClaudeStreamLine } from '#adapters/core/native-connection/index.js';
import { NATIVE_CLI_HEADLESS_ADAPTER, nativeCliHeadlessDefinitionSchema, refuse } from './contract.js';
import { codexTurn } from './codex.js';
import { headlessArgv, type HeadlessEntry } from './env.js';
import { emptyRunDir, headlessPreflight, type HeadlessPreflight } from './preflight.js';
import { runHeadlessIsolated, type HeadlessIsolation } from './realm.js';
import { emitDelta, reject, type HeadlessTurn, type HeadlessTurnFactory, type Prepared, type Refusal } from './turn.js';

/** One call's line guard and result by event-stream data (registry `eventStream`); a family without one has no headless step. */
const TURNS: Readonly<Record<string, HeadlessTurnFactory>> = { 'claude-code-stream-json': claudeTurn, 'codex-exec-json': codexTurn };
type Quota = Record<string, { utilizationPermille: number; resetsAtMs: number | null }>;
type ClaudeGuards = Extract<HeadlessEntry['headless']['guards'], { apiKeySources: unknown }>;
const list = (value: unknown) => Array.isArray(value) ? value : null;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const SCALE = 1000; // Stream reset timestamps are Unix seconds; receipts carry milliseconds.
// Plan-usage keeps integer counters only, so the window utilization (0..1) is recorded in thousandths.
const PERMILLE = 1000;
const ms = (seconds: unknown) => typeof seconds === 'number' && seconds >= 0 && Number.isSafeInteger(Math.round(seconds * SCALE)) ? Math.round(seconds * SCALE) : null;

/** Init guard: the exact CLI version, the pinned model, no tool, MCP server or skill, only allowlisted builtin plugins, the registry permission
 * mode, a claude.ai-login key source and the connection's own run dir as cwd. The first failing field is returned (the process is stopped). */
function initGuard(line: Extract<ClaudeStreamLine, { kind: 'init' }>, prepared: Prepared, guards: ClaudeGuards, preflight: HeadlessPreflight, runDir: string): Refusal | null {
  const plugins = list(line.plugins);
  if (line.model !== prepared.model) return reject('model-mismatch', { refusal: 'model-mismatch', field: 'init.model' });
  const failed = line.cliVersion !== preflight.version ? 'cliVersion' : line.apiKeySource === null || !guards.apiKeySources.includes(line.apiKeySource) ? 'apiKeySource'
    : line.permissionMode !== guards.permissionMode ? 'permissionMode' : list(line.tools)?.length !== 0 ? 'tools' : list(line.mcpServers)?.length !== 0 ? 'mcpServers'
      : list(line.skills)?.length !== 0 ? 'skills' : !plugins || plugins.some(plugin => !guards.plugins.some(allowed => allowed.name === plugin?.name && allowed.path === plugin?.path)) ? 'plugins'
        : line.pluginErrors !== undefined && list(line.pluginErrors)?.length !== 0 ? 'pluginErrors' : line.cwd !== runDir ? 'cwd' : null;
  return failed ? reject('invalid-response', { refusal: 'guard', field: failed }) : null;
}
/** Result guard and mapping: provider signals first (quota, credits, login), then turn/permission bounds and exact model usage. */
function resultRefusal(line: Extract<ClaudeStreamLine, { kind: 'result' }>, prepared: Prepared, guards: ClaudeGuards): Refusal | null {
  const status = line.apiErrorStatus;
  if (line.isError || line.subtype !== 'success') {
    if (line.errors.some(error => guards.creditsErrors.includes(error))) return reject('http-status', { refusal: 'credits-required', status }, status);
    if (status !== null && guards.quotaStatuses.includes(status)) return reject('http-status', { refusal: 'quota', status, resetsAtMs: null }, status);
    if ((status !== null && guards.loginStatuses.includes(status)) || line.errors.some(error => guards.loginErrors.includes(error))) return reject('http-status', { refusal: 'login-required', status }, status);
    if (status !== null && status >= 100 && status <= 599) return reject('http-status', { refusal: 'provider-error', status }, status);
    return reject('invalid-response', { refusal: 'invalid-output', subtype: line.subtype.slice(0, 64) });
  }
  if (count(line.data.num_turns) > prepared.entry.headless.maxTurns) return reject('invalid-response', { refusal: 'guard', field: 'num_turns' });
  if (list(line.data.permission_denials)?.length !== 0) return reject('invalid-response', { refusal: 'guard', field: 'permission_denials' });
  const models = Object.keys(line.modelUsage ?? {});
  return models.length === 1 && models[0] === prepared.model ? null : reject('model-mismatch', { refusal: 'model-mismatch', field: 'modelUsage' });
}
/** The governed result in the chat-completion shape the Brain reads; counters keep the reported model id and quota windows, never a cost. */
function assemble(line: Extract<ClaudeStreamLine, { kind: 'result' }>, prepared: Prepared, guards: ClaudeGuards, preflight: HeadlessPreflight, quota: Quota, egress: HeadlessEgress) {
  const usage = line.usage, input = count(usage.input_tokens), output = count(usage.output_tokens), cacheRead = count(usage.cache_read_input_tokens), cacheWrite = count(usage.cache_creation_input_tokens);
  const reported = line.modelUsage?.[prepared.model] ?? {};
  return Object.freeze({ schemaVersion: 1 as const, native: { object: 'chat.completion', model: prepared.model, choices: [{ index: 0, message: { role: 'assistant', content: line.result ?? '' },
    finish_reason: line.stopReason !== null && guards.lengthStopReasons.includes(line.stopReason) ? 'length' : 'stop' }],
  headless: { cliVersion: preflight.version, flagSetDigest: preflight.flagSetDigest, guard: 'passed', stopReason: line.stopReason, egress: { ...egress, ...headlessEgressReasons(egress) } } },
  usage: { prompt_tokens: input + cacheRead + cacheWrite, completion_tokens: output, total_tokens: input + cacheRead + cacheWrite + output, cache_read: cacheRead, cache_write: cacheWrite,
    modelUsage: { [prepared.model]: { inputTokens: count(reported.inputTokens), outputTokens: count(reported.outputTokens), cacheReadInputTokens: count(reported.cacheReadInputTokens),
      cacheCreationInputTokens: count(reported.cacheCreationInputTokens) } }, quota } });
}
/** The Claude Code stream-json turn: init guard, no retry, model checks on every message, quota windows, then the result's own guard. */
function claudeTurn(prepared: Prepared, preflight: HeadlessPreflight, runDir: string, onDelta?: ModelInvocationDeltaSink): HeadlessTurn {
  const { guards } = prepared.entry.headless;
  if (!('apiKeySources' in guards)) refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' });
  const quotaPolicy = nativeQuotaPolicy(), quota: Quota = {};
  let init = false, result: Extract<ClaudeStreamLine, { kind: 'result' }> | null = null;
  return {
    line(raw) {
      const line = parseClaudeStreamLine(raw);
      if (line.kind === 'init') { const refusal = init ? reject('invalid-response', { refusal: 'guard', field: 'init' }) : initGuard(line, prepared, guards, preflight, runDir); init = true; return refusal; }
      if (line.kind === 'system' && line.subtype === 'api_retry') return reject('invalid-response', { refusal: 'guard', field: 'api_retry' });
      if ((line.kind === 'assistant' || line.kind === 'result') && !init) return reject('invalid-response', { refusal: 'guard', field: 'init' });
      if (line.kind === 'assistant') {
        if (typeof line.message.model === 'string' && line.message.model !== prepared.model) return reject('model-mismatch', { refusal: 'model-mismatch', field: 'assistant.model' });
        for (const block of line.blocks) if (block.type === 'text' && typeof block.text === 'string' && block.text) emitDelta(onDelta, block.text);
      } else if (line.kind === 'rate-limit') {
        for (const [window, value] of line.windows) if (typeof value.utilization === 'number') quota[window] = { utilizationPermille: Math.round(Math.min(1, Math.max(0, value.utilization)) * PERMILLE), resetsAtMs: ms(value.resetsAt) };
        const resetsAtMs = ms(line.resetsAt);
        if (line.errorCode !== null && guards.creditsErrors.includes(line.errorCode)) return reject('http-status', { refusal: 'credits-required', status: null });
        if (line.status !== null && quotaPolicy.claudeRejectedStatuses.includes(line.status)) return reject('http-status', { refusal: 'quota', resetsAtMs, status: guards.quotaStatuses[0] ?? null }, guards.quotaStatuses[0] ?? null);
      } else if (line.kind === 'result') { if (result) return reject('invalid-response', { refusal: 'guard', field: 'result' }); result = line; }
      return null;
    },
    end(exit, egress) {
      const finished = result as Extract<ClaudeStreamLine, { kind: 'result' }> | null;
      // A provider refusal inside the run ends with an error result and a non-zero exit; it is still a complete, typed rejection.
      const mapped = finished && exit.exited ? resultRefusal(finished, prepared, guards) : null;
      if (mapped) return { refusal: mapped };
      return finished && exit.exited && exit.exitCode === 0 ? { response: assemble(finished, prepared, guards, preflight, quota, egress) } : null;
    },
  };
}
/**
 * The headless native port (S3-2). `prepare` is pure; `preflight` (the registry's pre-claim acquisition step) spawns no model call; `send`
 * runs one bounded turn: built env, 0600 system prompt file, user message on stdin, line guards that stop the process group, typed rejected
 * evidence for every refusal (body = adapter JSON, never CLI output). Timeout, cancel, crash and a missing result are thrown: `unknown`.
 */
export type NativeCliHeadlessPort = ModelInvocationNativePort & { preflight(profile: ModelInvocationProfile, signal?: AbortSignal): Promise<void> };
export function createNativeCliHeadlessPort(options: { readonly now: () => number; readonly isolation: HeadlessIsolation }): NativeCliHeadlessPort {
  const tokens = new WeakSet<object>();
  const target = (profileInput: unknown) => {
    const parsed = modelInvocationProfileSchema.safeParse(profileInput);
    if (!parsed.success || parsed.data.adapter.id !== NATIVE_CLI_HEADLESS_ADAPTER.id || parsed.data.adapter.version !== NATIVE_CLI_HEADLESS_ADAPTER.version
      || parsed.data.schemaVersion !== 2 || parsed.data.billingAxis !== 'subscription') refuse('HEADLESS_REQUEST_INVALID', { reason: 'profile' });
    const definition = nativeCliHeadlessDefinitionSchema.safeParse(parsed.data.adapter.definition), entry = nativeCliHeadless(parsed.data.protocol.family);
    if (!definition.success || !entry || !Object.hasOwn(TURNS, entry.command.capabilities.eventStream)) refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' });
    return { profile: parsed.data, definition: definition.data, entry };
  };
  return Object.freeze({
    billingAxis: 'subscription' as const,
    responseBytesUpperBound(prepared: unknown) { if (!prepared || typeof prepared !== 'object' || !tokens.has(prepared)) refuse('HEADLESS_REQUEST_INVALID', { reason: 'token' });
      return modelInvocationNativeResponseUpperBound((prepared as Prepared).profile.limits.responseMaxBytes); },
    estimatePrompt(value: unknown) { if (!value || typeof value !== 'object' || !tokens.has(value)) refuse('HEADLESS_REQUEST_INVALID', { reason: 'token' }); const p = value as Prepared; return Buffer.byteLength(p.system, 'utf8') + Buffer.byteLength(p.user, 'utf8') + p.entry.headless.promptFramingAllowance.tokens; }, // system + user bytes + allowance
    async preflight(profile: ModelInvocationProfile, signal?: AbortSignal) { const { definition, entry } = target(profile); await headlessPreflight(entry, definition, options.now, options.isolation, signal); },
    async prepare(profileInput: unknown, bindingInput: unknown, requestInput: unknown): Promise<unknown> {
      const { profile, definition, entry } = target(profileInput);
      let model: string;
      try { model = parseModelBindingDefinition(bindingInput).model.nativeId; } catch { refuse('HEADLESS_REQUEST_INVALID', { reason: 'binding' }); }
      const request = requestInput && typeof requestInput === 'object' && !Array.isArray(requestInput) ? requestInput as Record<string, unknown> : {};
      const messages = list(request.messages) as Record<string, unknown>[] | null, effort = request.reasoning_effort, allowed = new Set(['model', 'messages', 'max_completion_tokens', 'stream', 'n', 'reasoning_effort']);
      // One system + one user message; tools, streaming options and template switches are not this step's contract. The output cap cannot be passed to the CLI.
      if (Object.keys(request).some(key => !allowed.has(key)) || request.model !== model || request.stream === true || (request.n !== undefined && request.n !== 1) || messages?.length !== 2
        || messages[0]?.role !== 'system' || messages[1]?.role !== 'user' || typeof messages[0].content !== 'string' || typeof messages[1].content !== 'string'
        || Object.keys(messages[0]).length !== 2 || Object.keys(messages[1]).length !== 2) refuse('HEADLESS_REQUEST_INVALID', { reason: 'request' });
      const system = messages[0].content as string, user = messages[1].content as string;
      if (Buffer.byteLength(system) + Buffer.byteLength(user) > profile.limits.requestMaxBytes || Buffer.byteLength(user) > entry.headless.limits.stdinMaxBytes) refuse('HEADLESS_REQUEST_INVALID', { reason: 'size' });
      const capability = entry.command.capabilities.reasoningEffort;
      if (effort !== undefined && (typeof effort !== 'string' || !capability?.levels.includes(effort as never))) refuse('HEADLESS_REQUEST_INVALID', { reason: 'effort' });
      const effortArgs = effort === undefined ? [] : nativeEffortArgs(capability, { schemaVersion: 1, level: effort as never, source: 'explicit', status: 'selected' });
      headlessArgv(entry, join(definition.stateDir, 'run'), model, effortArgs);
      const prepared: Prepared = Object.freeze({ profile, definition, entry, model, system, user, effortArgs }); tokens.add(prepared); return prepared;
    },
    async send(input: unknown, signal?: AbortSignal, onDelta?: ModelInvocationDeltaSink): Promise<ModelInvocationNativeResult> {
      if (!input || typeof input !== 'object' || !tokens.has(input)) refuse('HEADLESS_REQUEST_INVALID', { reason: 'token' });
      const prepared = input as Prepared; tokens.delete(prepared);
      const { headless } = prepared.entry, preflight = await headlessPreflight(prepared.entry, prepared.definition, options.now, options.isolation, signal);
      const runDir = await realpath(preflight.runDir), promptFile = join(preflight.runDir, headless.systemPromptFile);
      const turn = TURNS[prepared.entry.command.capabilities.eventStream]!(prepared, preflight, runDir, onDelta);
      let refusal: Refusal | null = null;
      const onLine = (raw: string): 'stop' | void => { refusal ??= turn.line(raw); return refusal ? 'stop' : undefined; };
      let evidence;
      try {
        await emptyRunDir(preflight.runDir);
        await writeFile(promptFile, prepared.system, { mode: 0o600, flag: 'wx' });
        // S3-5: the call runs in the realm like every preflight spawn; the prompt file is the only host file it sees in its private run dir.
        evidence = await runHeadlessIsolated(prepared.entry, options.isolation, { executable: prepared.definition.executable,
          args: headlessArgv(prepared.entry, preflight.runDir, prepared.model, prepared.effortArgs), env: preflight.env, stateDir: prepared.definition.stateDir,
          runDir: preflight.runDir, configDir: prepared.definition.configDir, promptFile, now: options.now },
        { timeoutMs: prepared.profile.limits.timeoutMs, outputBytes: 2 * prepared.profile.limits.responseMaxBytes + headless.limits.responseFramingBytes,
          stderrBytes: headless.limits.stderrMaxBytes, maxLineBytes: headless.limits.maxLineBytes, interruptGraceMs: headless.limits.killGraceMs,
          stdinBase64: Buffer.from(prepared.user, 'utf8').toString('base64') }, signal, onLine);
      } finally { await rm(promptFile, { force: true }); }
      // f5: every settled call names what the realm's gateway did (counts and refused host names only).
      const { egress } = evidence, settle = (value: Refusal) => Object.freeze({ kind: 'rejected' as const, evidence: createModelInvocationResponseEvidence(NATIVE_CLI_HEADLESS_ADAPTER,
        value.reason, value.status, Buffer.from(JSON.stringify({ ...value.body, egress }), 'utf8'), true) });
      const stopped = refusal as Refusal | null;
      if (stopped) return settle(stopped);
      // f5: a realm bound (CPU time, tasks, data size) ended the turn: typed, never an unknown outcome or a retry.
      if (evidence.limit) return settle(reject('response-limit', { refusal: 'resource-limit', field: evidence.limit }));
      if (evidence.reason === 'output-limit' || evidence.reason === 'line-limit') return settle(reject('response-limit', { refusal: 'response-limit' }));
      const ended = turn.end({ exited: evidence.reason === 'exit', exitCode: evidence.exitCode }, egress);
      if (ended && 'refusal' in ended) return settle(ended.refusal);
      if (!ended) throw new Error('HEADLESS_OUTCOME_UNKNOWN');
      const response = ended.response;
      return Buffer.byteLength(JSON.stringify(response)) > prepared.profile.limits.responseMaxBytes ? settle(reject('response-limit', { refusal: 'response-limit' })) : response;
    },
  });
}
