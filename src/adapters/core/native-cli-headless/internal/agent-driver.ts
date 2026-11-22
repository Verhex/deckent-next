import { randomBytes } from 'node:crypto';
import { rm, mkdtemp, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { headlessEgressReasons, type ModelInvocationDeltaSink, type ModelInvocationNativeResult } from '#domain/index.js';
import { modelInvocationProfileDigest, createModelInvocationResponseEvidence, type ModelInvocationNativePort } from '#engine/index.js';
import { CODEX_TOOL_ITEM_RESERVATION, type SameTurnPlanningCall, type SameTurnPlanningPort, type SameTurnPlanningPin, type SameTurnToolSessionPort, type NativeAgentToolResult, nativeQuotaRejection, nativeAgentExecutionSchema, toolSessionSchema, type ClaudeRateLimit, type NativeAgentExecution, type NativeAgentReadinessReason, type ToolSessionPort } from '#capabilities/index.js';
import { ErrorRegistry, feedRecordStream, finishRecordStream, EMPTY_RECORD_STREAM, redactForRecord, combineKnownSecrets, type KnownSecretSnapshot } from '#platform/index.js';
import { createClaudeAgentDriver } from './claude-agent.js';
import { codexAgentTurn, type CodexAgentResultLookup } from './codex-agent.js';
import { nativeAgentLaunch } from './launch.js';
import { createNativeCliHeadlessPort } from './port.js';
import { emptyRunDir } from './preflight.js';
import { runHeadlessIsolated, type HeadlessIsolation, type HeadlessSpawn } from './realm.js';
import { agentTarget, preflightNativeAgent, recordNativeAgentObservation } from './agent-observation.js';
import { NATIVE_CLI_HEADLESS_ADAPTER, refuse } from './contract.js';
import { nativeAgentFlagSetDigest } from './env.js';
import { emitDelta, reject, type Prepared, type Refusal } from './turn.js';
import { nativeQuotaPolicy } from '#adapters/core/native-connection/index.js';

type Bridge = NonNullable<HeadlessSpawn['mcp']> & Readonly<{ turnToken: string; url: string; tokenEnvName: string; project?: (text: string) => string }>;
const projectResponse = (value: unknown, known: KnownSecretSnapshot, field = ''): unknown => typeof value === 'string'
  ? ['content', 'text', 'reasoning_content'].includes(field) ? finishRecordStream({ held: value, withheld: false }, known) : redactForRecord(value, known)
  : Array.isArray(value) ? value.map(item => projectResponse(item, known)) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [redactForRecord(key, known), projectResponse(item, known, key)])) : value;
function planningWire(planning: SameTurnPlanningPort, pin: SameTurnPlanningPin, known: KnownSecretSnapshot) {
  let sessionId = '', call: SameTurnPlanningCall | undefined, draft: string | undefined;
  return {
    get active() { return planning.active; }, get delivered() { return call !== undefined; },
    session(id: string) { planning.bindNativeSession(pin, id); sessionId = id; },
    replay(observed: NativeAgentToolResult) {
      planning.privateResult(observed.deckentCallId, observed.outcome.text);
    },
    delivery(observed: NativeAgentToolResult) {
      planning.preparationDelivered(pin, observed);
      call = planning.privateResult(observed.deckentCallId, observed.outcome.text)?.call;
    },
    terminal(messageId: string, text: string) {
      const lf = text.indexOf('\n');
      if (!call || lf < 0) throw ErrorRegistry.createError('BRAIN_SAME_TURN_REFUSED', { params: { reason: 'stale-terminal' } });
      draft = planning.terminalEnvelope(pin, { ...call, sessionId, messageId, parentId: null, line: text.slice(0, lf), draft: text.slice(lf + 1) });
    },
    response() {
      if (draft === undefined) throw ErrorRegistry.createError('BRAIN_SAME_TURN_REFUSED', { params: { reason: 'stale-terminal' } });
      planning.nativeClosed(pin, { state: 'normal', closed: true, drained: true });
      return planning.responseBody(pin, finishRecordStream({ held: draft, withheld: false }, known));
    },
  };
}
/** In-memory driver construction is pure. Admission probes and run files occur only inside the governed invocation. */
export function createNativeAgentDriver(input: Readonly<{ profile: Prepared['profile']; execution: NativeAgentExecution; session: SameTurnToolSessionPort;
  now: () => number; isolation: HeadlessIsolation; onPaidUsage?: (limit: ClaudeRateLimit, signal?: AbortSignal) => Promise<void>; paidExtraUsage?: 'continue' | 'stop-at-limit' }>) {
  const planning = input.session.planning;
  const { profile, entry, definition } = agentTarget(input.profile), execution = nativeAgentExecutionSchema.parse(input.execution);
  toolSessionSchema.parse(input.session.session);
  if (execution.profileDigest !== modelInvocationProfileDigest(profile) || execution.flagSetDigest !== nativeAgentFlagSetDigest(entry)
    || execution.ownerUid !== definition.ownerUid) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'agent-seal' });
  const lifetime = new AbortController(), calls = new Map<string, NonNullable<ReturnType<CodexAgentResultLookup>>>();
  let projectToolResult = (value: Awaited<ReturnType<ToolSessionPort['propose']>>) => value;
  let codex: ReturnType<typeof codexAgentTurn> | undefined;
  let claude: ReturnType<typeof createClaudeAgentDriver> | undefined, refusal: NativeAgentReadinessReason | null = null, refusalCheck: string | null = null, used = false;
  const deliveries = new WeakMap<Awaited<ReturnType<ToolSessionPort['propose']>>, () => string | undefined>();
  const port: ToolSessionPort = { session: input.session.session,
    checkResultDelivery: call => input.session.checkResultDelivery?.(call) ?? true,
    selected(host, text, live) { deliveries.set(host, () => live() ? text : undefined); },
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
      const frozen = Object.freeze({ ...call });
      calls.set(call.id, { call: frozen, active: () => !signal.aborted && !lifetime.signal.aborted, result: projectToolResult(result), recordedError: () => input.session.recordedError?.(frozen, result),
        selectedText: () => deliveries.get(result)?.() }); return result;
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
  return Object.freeze({ port, admit: async (signal?: AbortSignal) => { await checked(signal); }, refusal: () => refusal, refusalCheck: () => refusalCheck, notices: () => planning?.active ? [] : claude?.notices() ?? [],
    async close() { lifetime.abort(); calls.clear(); },
    native(bridge: Bridge, secrets: { configured: KnownSecretSnapshot; turn: KnownSecretSnapshot }): ModelInvocationNativePort {
      const known = combineKnownSecrets(secrets.configured, secrets.turn), textPort = createNativeCliHeadlessPort({ now: input.now, isolation: input.isolation, ...(input.paidExtraUsage ? { paidExtraUsage: input.paidExtraUsage } : {}) });
      // K4 projects the serialized envelope before sending it. Correlate that same representation, without re-executing the call.
      const safe = bridge.project ?? ((text: string) => redactForRecord(text, known));
      const project = (value: NativeAgentToolResult) => JSON.parse(redactForRecord(JSON.stringify(value), known)) as NativeAgentToolResult;
      const projectDelivery = (value: NativeAgentToolResult) => {
        const text = safe(JSON.stringify(value));
        // The bridge also projects the SSE frame, where the embedded result has another JSON escape layer.
        const payload = JSON.stringify({ content: [{ type: 'text', text }], isError: value.outcome.status === 'error' });
        if (safe(payload) !== payload) throw ErrorRegistry.createError('BRAIN_SAME_TURN_REFUSED', { params: { reason: 'preparation-unsettled' } });
        return JSON.parse(text) as NativeAgentToolResult;
      };
      const tokens = new WeakSet<object>();
      let pin: SameTurnPlanningPin | null = null;
      return Object.freeze({ billingAxis: 'subscription' as const, responseBytesUpperBound: textPort.responseBytesUpperBound!,
        estimatePrompt: textPort.estimatePrompt!,
        claimed() {
          if (planning?.pin) { pin = planning.pin; planning.bindDeliveryProjection(pin, projectDelivery, known); }
        },
        async prepare(...args: Parameters<ModelInvocationNativePort['prepare']>) {
          if (modelInvocationProfileDigest(args[0]) !== execution.profileDigest) refuse('HEADLESS_REQUEST_INVALID', { reason: 'profile' });
          const value = await textPort.prepare(...args); tokens.add(value as object); return value;
        },
        async send(value: unknown, signal?: AbortSignal, onDelta?: ModelInvocationDeltaSink): Promise<ModelInvocationNativeResult> {
          if (used || !value || typeof value !== 'object' || !tokens.has(value)) refuse('HEADLESS_REQUEST_INVALID', { reason: 'token' });
          used = true; tokens.delete(value); projectToolResult = project;
          const prepared = value as Prepared, combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
          const preflight = await checked(combined), { headless } = entry;
          // Profiles sharing a login may wait for its lock. Each owns its files before entering that wait.
          const runDir = await realpath(await mkdtemp(join(definition.stateDir, 'agent-run-')));
          const wire = planning && pin ? planningWire(planning, pin, known) : undefined;
          let stream = EMPTY_RECORD_STREAM, text = '', returned = false;
          const delta: ModelInvocationDeltaSink = part => { if (planning?.active || part.kind !== 'text') return; text += part.text;
            const fed = feedRecordStream(stream, part.text, known); stream = fed.state; emitDelta(onDelta, fed.text); };
          claude = entry.agent.transport.kind === 'claude-mcp' ? createClaudeAgentDriver({ entry, port: input.session, model: prepared.model,
            cliVersion: preflight.version, runDir, outputMaxBytes: profile.limits.responseMaxBytes, ...(wire ? { planning: wire } : {}), quotaPolicy: nativeQuotaPolicy(), ...(input.onPaidUsage ? { onPaidUsage: input.onPaidUsage } : {}), ...(prepared.paidExtraUsage ? { paidExtraUsage: prepared.paidExtraUsage } : {}), onDelta: delta }) : undefined;
          const turn = codex = claude ? undefined : codexAgentTurn(prepared, preflight, port.session, id => calls.get(id), delta, known, combined, wire);
          let stopped: Refusal | null = null, dispose: (() => Promise<void>) | undefined;
          const rejectResult = (reason: Refusal, complete = true): ModelInvocationNativeResult => Object.freeze({ kind: 'rejected',
            evidence: createModelInvocationResponseEvidence(NATIVE_CLI_HEADLESS_ADAPTER, reason.reason, reason.status,
              Buffer.from(JSON.stringify(reason.body)), complete) });
          try {
            await emptyRunDir(runDir);
            const launch = await nativeAgentLaunch(entry, { session: port.session, runDir, configDir: definition.configDir, model: prepared.model, system: prepared.system,
              user: prepared.user, effortArgs: prepared.effortArgs, turnToken: bridge.turnToken, bridgeUrl: bridge.url, timeoutMs: profile.limits.timeoutMs,
              outputMaxBytes: profile.limits.responseMaxBytes }); dispose = launch.dispose;
            const evidence = await runHeadlessIsolated(entry, input.isolation, { ...launch.spawn, executable: preflight.executable, stateDir: definition.stateDir,
              mcp: bridge, now: input.now }, launch.bounds, claude ? AbortSignal.any([combined, claude.signal]) : combined,
            (raw, lineSignal) => { if (claude) return claude.line(raw, lineSignal); stopped ??= turn!.line(raw); return stopped ? 'stop' : undefined; });
            const finished = claude?.finish(evidence);
            // Proposal admission can stop the realm before the line callback sees another event.
            const stoppedTurn = (stopped as Refusal | null) ?? turn?.refusal();
            if (planning?.active) {
              const truncated = evidence.limit || evidence.stdoutTruncated || evidence.stderrTruncated || evidence.reason === 'output-limit' || evidence.reason === 'line-limit';
              const cancelled = combined.aborted || evidence.reason === 'cancelled';
              if (!wire || !evidence.started || evidence.reason !== 'exit' || evidence.exitCode !== 0 || evidence.signal !== null
                || truncated || cancelled || stoppedTurn || refusal || claude && finished?.kind !== 'completed') {
                const rejection = stoppedTurn?.body;
                const field = finished?.kind === 'refused' ? finished.field
                  : rejection && ('field' in rejection && rejection.field || 'subtype' in rejection && rejection.subtype);
                if (field) {
                  refusal = finished?.kind === 'refused' ? finished.reason : 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED';
                  refusalCheck = field === CODEX_TOOL_ITEM_RESERVATION ? field : `agent-surface:${field}`.slice(0, 64);
                }
                const reason = cancelled ? 'cancelled' : truncated ? 'output-truncated'
                  : evidence.reason === 'exit' && evidence.exitCode !== 0 || finished?.kind === 'failed' ? 'native-failed' : 'completion-unknown';
                if (pin) planning.abandon(pin, reason);
                throw ErrorRegistry.createError('BRAIN_SAME_TURN_REFUSED', { params: { reason } });
              }
            }
            if (finished?.kind === 'refused') {
              const limit = finished.limit;
              if (limit) return rejectResult(reject(limit.kind === 'unknown' ? 'invalid-response' : 'http-status', nativeQuotaRejection(limit)));
              // Owner 2026-11-05: a refused turn stops only itself; no negative observation pauses later turns.
              refusal = finished.reason;
              const field = `agent-surface:${finished.field}`.slice(0, 64); refusalCheck = finished.detail ? `${field} ${finished.detail}` : field;
              return rejectResult(reject('invalid-response', { refusal: 'guard', field, ...(finished.detail ? { subtype: finished.detail } : {}) }));
            }
            if (stoppedTurn || refusal) {
              if (!stoppedTurn || stoppedTurn.body.refusal === 'guard') {
                refusal ??= 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED';
                refusalCheck = stoppedTurn && 'field' in stoppedTurn.body ? stoppedTurn.body.field ?? 'guard' : 'proposal-order';
              }
              return rejectResult(stoppedTurn ?? reject('invalid-response', { refusal: 'guard', field: 'proposal-order' }));
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
                choices: [{ index: 0, message: { role: 'assistant', content: wire?.active ? wire.response() : text || finished.text }, finish_reason: atLength ? 'length' : 'stop' }],
                headless: { cliVersion: execution.cliVersion, flagSetDigest: execution.flagSetDigest, guard: 'passed', builtinPlugins: claude!.builtinPlugins(), ...(claude!.paidExtraUsage() ? { paidExtraUsage: claude!.paidExtraUsage() } : {}), egress: { ...evidence.egress, ...headlessEgressReasons(evidence.egress) } } },
                usage: { prompt_tokens: inputTokens, completion_tokens: usage['output_tokens']!, total_tokens: inputTokens + usage['output_tokens']!,
                  cache_read: usage['cache_read_input_tokens']!, cache_write: usage['cache_creation_input_tokens']! } };
            } else if (ended && 'response' in ended) {
              // Only derived response fields leave the adapter; raw stdout/stderr are never persisted or displayed.
              response = wire?.active ? ended.response : { ...ended.response, native: { ...ended.response.native,
                choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] } };
            } else if (ended && 'refusal' in ended) return rejectResult(ended.refusal);
            else return rejectResult(reject('interrupted', { refusal: 'invalid-output', subtype: 'incomplete' }), false);
            response = projectResponse(response, known) as typeof response;
            if (Buffer.byteLength(JSON.stringify(response)) > profile.limits.responseMaxBytes) return rejectResult(reject('response-limit', { refusal: 'response-limit' }));
            // A completed, guarded turn is current surface evidence; a preflight alone never sets these facts.
            await recordNativeAgentObservation(profile, preflight, execution, input.now, true);
            if (planning?.active && combined.aborted) throw ErrorRegistry.createError('BRAIN_SAME_TURN_REFUSED', { params: { reason: 'cancelled' } });
            if (!planning?.active) emitDelta(onDelta, finishRecordStream(stream, known));
            returned = true; return response;
          } finally {
            if (!returned && planning?.active && pin) planning.abandon(pin, combined.aborted ? 'cancelled' : 'completion-unknown');
            try { await dispose?.(); } finally { await rm(runDir, { recursive: true, force: true }); }
          }
        },
      });
    },
  });
}

/** Host port for the planner constructor. The engine requests entropy only after pin and settings validation. */
createNativeAgentDriver.planningEntropy = Object.freeze({ randomBytes });
