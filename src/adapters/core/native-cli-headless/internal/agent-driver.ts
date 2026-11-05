import { writeFile, rm, mkdtemp, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { headlessEgressReasons, type ModelInvocationDeltaSink, type ModelInvocationNativeResult } from '#domain/index.js';
import { modelInvocationProfileDigest, createModelInvocationResponseEvidence, type ModelInvocationNativePort } from '#engine/index.js';
import { nativeAgentExecutionSchema, toolSessionSchema, type NativeAgentExecution, type NativeAgentReadinessReason, type ToolSessionPort } from '#capabilities/index.js';
import { feedRecordStream, finishRecordStream, EMPTY_RECORD_STREAM, redactForRecord, type KnownSecretSnapshot } from '#platform/index.js';
import { createClaudeAgentDriver, prepareClaudeAgentRun } from './claude-agent.js';
import { codexAgentArgv, codexAgentTurn, type CodexAgentResultLookup } from './codex-agent.js';
import { createNativeCliHeadlessPort } from './port.js';
import { emptyRunDir } from './preflight.js';
import { runHeadlessIsolated, type HeadlessIsolation, type HeadlessSpawn } from './realm.js';
import { agentTarget, preflightNativeAgent, recordNativeAgentObservation } from './agent-observation.js';
import { NATIVE_CLI_HEADLESS_ADAPTER, refuse } from './contract.js';
import { buildHeadlessEnv, nativeAgentFlagSetDigest } from './env.js';
import { emitDelta, reject, type Prepared, type Refusal } from './turn.js';

type Bridge = NonNullable<HeadlessSpawn['mcp']> & Readonly<{ turnToken: string; url: string; tokenEnvName: string }>;
const knownPair = (a: KnownSecretSnapshot, b: KnownSecretSnapshot): KnownSecretSnapshot => Object.freeze({
  spans: (text: string) => [...a.spans(text), ...b.spans(text)], recordSpans: (text: string) => [...a.recordSpans(text), ...b.recordSpans(text)],
  pendingStart: (text: string) => Math.min(a.pendingStart(text), b.pendingStart(text)),
  apply: (text: string, rest: (text: string) => string) => {
    let matches = 0;
    const result = a.apply(text, part => { const nested = b.apply(part, rest); matches += nested.matches; return nested.text; });
    return { ...result, matches: result.matches + matches };
  },
});
const projectResponse = (value: unknown, known: KnownSecretSnapshot, field = ''): unknown => typeof value === 'string'
  ? ['content', 'text', 'reasoning_content'].includes(field) ? finishRecordStream({ held: value, withheld: false }, known) : redactForRecord(value, known)
  : Array.isArray(value) ? value.map(item => projectResponse(item, known)) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [redactForRecord(key, known), projectResponse(item, known, key)])) : value;
/** In-memory driver construction is pure. Admission probes and run files occur only inside the governed invocation. */
export function createNativeAgentDriver(input: Readonly<{ profile: Prepared['profile']; execution: NativeAgentExecution; session: ToolSessionPort;
  now: () => number; isolation: HeadlessIsolation }>) {
  const { profile, entry, definition } = agentTarget(input.profile), execution = nativeAgentExecutionSchema.parse(input.execution);
  toolSessionSchema.parse(input.session.session);
  if (execution.profileDigest !== modelInvocationProfileDigest(profile) || execution.flagSetDigest !== nativeAgentFlagSetDigest(entry)
    || execution.ownerUid !== definition.ownerUid) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'agent-seal' });
  const lifetime = new AbortController(), calls = new Map<string, NonNullable<ReturnType<CodexAgentResultLookup>>>();
  let projectToolResult = (value: Awaited<ReturnType<ToolSessionPort['propose']>>) => value;
  let codex: ReturnType<typeof codexAgentTurn> | undefined;
  let claude: ReturnType<typeof createClaudeAgentDriver> | undefined, refusal: NativeAgentReadinessReason | null = null, refusalCheck: string | null = null, used = false;
  const port: ToolSessionPort = { session: input.session.session,
    async propose(call, correlation, signal) {
      if (!used || lifetime.signal.aborted || refusal) refuse('HEADLESS_REQUEST_INVALID', { reason: 'agent-closed' });
      if (entry.agent.transport.kind === 'claude-mcp') {
        if (!claude) refuse('HEADLESS_REQUEST_INVALID', { reason: 'agent-order' });
        return claude.propose(call, correlation, signal);
      }
      if (!codex?.accepts(call)) {
        refusal = 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED'; lifetime.abort();
        refuse('HEADLESS_REQUEST_INVALID', { reason: 'agent-order' });
      }
      const result = await input.session.propose(call, correlation, AbortSignal.any([signal, lifetime.signal]));
      // Retain the exact facade result; JSONL item ids never stand in for Deckent call custody.
      calls.set(call.id, { call: Object.freeze({ ...call }), result: projectToolResult(result) }); return result;
    },
    async cancel() { lifetime.abort(); return input.session.cancel(); },
    async revoke() { lifetime.abort(); return input.session.revoke(); },
  };
  const checked = async (signal?: AbortSignal) => {
    const sealed = await preflightNativeAgent(profile, input.now, input.isolation, signal);
    if (!isDeepStrictEqual(sealed.execution, execution)) {
      refusal = 'NATIVE_AGENT_CAPABILITY_UNSEALED'; refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'agent-seal' });
    }
    return sealed.preflight;
  };
  return Object.freeze({ port, admit: async (signal?: AbortSignal) => { await checked(signal); }, refusal: () => refusal, refusalCheck: () => refusalCheck,
    async close() { lifetime.abort(); calls.clear(); },
    native(bridge: Bridge, secrets: { configured: KnownSecretSnapshot; turn: KnownSecretSnapshot }): ModelInvocationNativePort {
      const known = knownPair(secrets.configured, secrets.turn), textPort = createNativeCliHeadlessPort({ now: input.now, isolation: input.isolation });
      // K4 projects the serialized envelope before sending it. Correlate that same representation, without re-executing the call.
      projectToolResult = value => JSON.parse(redactForRecord(JSON.stringify(value), known)) as typeof value;
      const tokens = new WeakSet<object>();
      return Object.freeze({ billingAxis: 'subscription' as const, responseBytesUpperBound: textPort.responseBytesUpperBound!,
        estimatePrompt: textPort.estimatePrompt!,
        async prepare(...args: Parameters<ModelInvocationNativePort['prepare']>) {
          if (modelInvocationProfileDigest(args[0]) !== execution.profileDigest) refuse('HEADLESS_REQUEST_INVALID', { reason: 'profile' });
          const value = await textPort.prepare(...args); tokens.add(value as object); return value;
        },
        async send(value: unknown, signal?: AbortSignal, onDelta?: ModelInvocationDeltaSink): Promise<ModelInvocationNativeResult> {
          if (used || !value || typeof value !== 'object' || !tokens.has(value)) refuse('HEADLESS_REQUEST_INVALID', { reason: 'token' });
          used = true; tokens.delete(value);
          const prepared = value as Prepared, combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
          const preflight = await checked(combined), { headless } = entry;
          // Profiles sharing a login may wait for its lock. Each owns its files before entering that wait.
          const runDir = await realpath(await mkdtemp(join(definition.stateDir, 'agent-run-')));
          const env = buildHeadlessEnv(headless, runDir, definition.configDir);
          let stream = EMPTY_RECORD_STREAM, text = '';
          const delta: ModelInvocationDeltaSink = part => { if (part.kind !== 'text') return; text += part.text;
            const fed = feedRecordStream(stream, part.text, known); stream = fed.state; emitDelta(onDelta, fed.text); };
          claude = entry.agent.transport.kind === 'claude-mcp' ? createClaudeAgentDriver({ entry, port: input.session, model: prepared.model,
            cliVersion: preflight.version, runDir, outputMaxBytes: profile.limits.responseMaxBytes, onDelta: delta }) : undefined;
          const turn = codex = claude ? undefined : codexAgentTurn(prepared, preflight, port.session, id => calls.get(id), delta, known);
          let stopped: Refusal | null = null, dispose: (() => Promise<void>) | undefined;
          const rejectResult = (reason: Refusal, complete = true): ModelInvocationNativeResult => Object.freeze({ kind: 'rejected',
            evidence: createModelInvocationResponseEvidence(NATIVE_CLI_HEADLESS_ADAPTER, reason.reason, reason.status,
              Buffer.from(JSON.stringify(reason.body)), complete) });
          try {
            await emptyRunDir(runDir);
            const promptFile = join(runDir, headless.systemPromptFile);
            let args: readonly string[], configFile: string | undefined;
            if (claude) {
              const effort = entry.command.capabilities.reasoningEffort;
              // prepare has already validated the request; recover its selected effort from the exact registry expansion.
              const level = effort?.levels.find(level => isDeepStrictEqual(prepared.effortArgs,
                effort.args.map(arg => arg.replaceAll('{effort}', level))));
              const files = await prepareClaudeAgentRun(entry, port.session, { runDir, model: prepared.model, system: prepared.system,
                turnToken: bridge.turnToken, ...(prepared.effortArgs.length && level ? { effort: level } : {}) });
              args = files.args; configFile = files.configFile; dispose = () => files.dispose();
            } else {
              args = codexAgentArgv(entry, port.session, runDir, prepared.model, prepared.effortArgs, bridge.url);
              await writeFile(promptFile, prepared.system, { mode: 0o600, flag: 'wx' }); dispose = () => rm(promptFile, { force: true });
            }
            const evidence = await runHeadlessIsolated(entry, input.isolation, { executable: preflight.executable, args,
              env: claude ? env : Object.freeze({ ...env, [entry.bridge.tokenEnvName]: bridge.turnToken }),
              stateDir: definition.stateDir, runDir, configDir: definition.configDir, promptFile,
              ...(configFile ? { mcpConfigFile: configFile } : {}), mcp: bridge, now: input.now },
            { timeoutMs: profile.limits.timeoutMs, outputBytes: 2 * profile.limits.responseMaxBytes + headless.limits.responseFramingBytes,
              stderrBytes: headless.limits.stderrMaxBytes, maxLineBytes: headless.limits.maxLineBytes, interruptGraceMs: headless.limits.killGraceMs,
              stdinBase64: Buffer.from(prepared.user).toString('base64') },
            claude ? AbortSignal.any([combined, claude.signal]) : combined,
            raw => { if (claude) return claude.line(raw); stopped ??= turn!.line(raw); return stopped ? 'stop' : undefined; });
            const finished = claude?.finish(evidence);
            if (finished?.kind === 'refused') {
              refusal = finished.reason; await recordNativeAgentObservation(profile, preflight, execution, input.now, refusal);
              const field = `agent-surface:${finished.field}`.slice(0, 64); refusalCheck = finished.detail ? `${field} ${finished.detail}` : field;
              return rejectResult(reject('invalid-response', { refusal: 'guard', field, ...(finished.detail ? { subtype: finished.detail } : {}) }));
            }
            if (stopped || refusal) {
              refusal = 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED'; await recordNativeAgentObservation(profile, preflight, execution, input.now, refusal);
              return rejectResult(stopped ?? reject('invalid-response', { refusal: 'guard', field: 'proposal-order' }));
            }
            if (combined.aborted || evidence.reason === 'cancelled' || evidence.reason === 'timeout') throw new Error('HEADLESS_OUTCOME_UNKNOWN');
            if (evidence.limit || evidence.reason === 'output-limit' || evidence.reason === 'line-limit' || evidence.stdoutTruncated || evidence.stderrTruncated)
              return rejectResult(reject('response-limit', { refusal: 'response-limit' }));
            const ended = turn?.end({ exited: evidence.reason === 'exit', exitCode: evidence.exitCode }, evidence.egress);
            let response: Exclude<ModelInvocationNativeResult, { kind: 'rejected' }>;
            if (finished?.kind === 'completed') {
              const usage = finished.usage, inputTokens = usage['input_tokens']! + usage['cache_read_input_tokens']! + usage['cache_creation_input_tokens']!;
              const atLength = finished.stopReason !== null && 'lengthStopReasons' in headless.guards && headless.guards.lengthStopReasons.includes(finished.stopReason);
              response = { schemaVersion: 1, native: { object: 'chat.completion', model: prepared.model,
                choices: [{ index: 0, message: { role: 'assistant', content: text || finished.text }, finish_reason: atLength ? 'length' : 'stop' }],
                headless: { cliVersion: execution.cliVersion, flagSetDigest: execution.flagSetDigest, guard: 'passed', egress: { ...evidence.egress, ...headlessEgressReasons(evidence.egress) } } },
                usage: { prompt_tokens: inputTokens, completion_tokens: usage['output_tokens']!, total_tokens: inputTokens + usage['output_tokens']!,
                  cache_read: usage['cache_read_input_tokens']!, cache_write: usage['cache_creation_input_tokens']! } };
            } else if (ended && 'response' in ended) {
              // Only derived response fields leave the adapter; raw stdout/stderr are never persisted or displayed.
              response = { ...ended.response, native: { ...ended.response.native,
                choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] } };
            } else if (ended && 'refusal' in ended) return rejectResult(ended.refusal);
            else return rejectResult(reject('interrupted', { refusal: 'invalid-output', subtype: 'incomplete' }), false);
            response = projectResponse(response, known) as typeof response;
            if (Buffer.byteLength(JSON.stringify(response)) > profile.limits.responseMaxBytes) return rejectResult(reject('response-limit', { refusal: 'response-limit' }));
            // A completed, guarded turn is current surface evidence; a preflight alone never sets these facts.
            await recordNativeAgentObservation(profile, preflight, execution, input.now, true);
            emitDelta(onDelta, finishRecordStream(stream, known)); return response;
          } finally { try { await dispose?.(); } finally { await rm(runDir, { recursive: true, force: true }); } }
        },
      });
    },
  });
}
