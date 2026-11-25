import type { ToolSessionPort } from './session.js';
import { DeckentError, headlessDiagnosticIdentifier } from '#platform/index.js';
import type { HeadlessRejectionBody } from '#domain/index.js';
import type { NativeAgentReadinessReason } from './contract.js';
import { ClaudeAgentError } from './claude-stream.js';
import { nativeQuotaRejection, nativeModelRefusal, type ClaudeRateLimit } from './quota.js';
import { NativeCliWorkerError } from './worker-profile.js';

type Call = Parameters<ToolSessionPort['propose']>[0];
type Result = Awaited<ReturnType<ToolSessionPort['propose']>>;
/** Preflight owns only bounded probes. Its settled cancellation precedes any model process or private run files. */
export async function nativeWorkerPreflight<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return null;
  try { const checked = await run(); return signal.aborted ? null : checked; }
  catch (error) {
    if (signal.aborted && (error === signal.reason || error instanceof Error && error.name === 'AbortError'
      || error instanceof DeckentError && error.code === 'HEADLESS_PREFLIGHT_FAILED' && error.params?.['check'] === 'cancelled')) return null;
    throw error;
  }
}
export function nativeWorkerToolGate(port: ToolSessionPort, signal: AbortSignal) {
  const calls = new Map<string, { call: Call; result: Result }>(), controller = new AbortController();
  let refused = false;
  let guard: { propose: ToolSessionPort['propose'] } | undefined;
  return {
    bind(value: { propose: ToolSessionPort['propose'] }) { guard = value; },
    lookup: (id: string) => calls.get(id),
    get signal(): AbortSignal { return controller.signal; },
    refused: () => refused,
    terminalFailure: () => port.terminalFailure?.() ?? null,
    stop() { controller.abort(); },
    clear() { calls.clear(); },
    tools: { session: port.session, async propose(call, correlation, callSignal) {
      if (!guard || signal.aborted || controller.signal.aborted || callSignal.aborted) throw new NativeCliWorkerError('NATIVE_CLI_WORKER_UNAVAILABLE');
      try { const result = await guard.propose(call, correlation, callSignal); calls.set(call.id, { call, result }); if (port.terminalFailure?.()) controller.abort(); return result; }
      catch (error) { refused ||= !signal.aborted && !callSignal.aborted
        && (error instanceof NativeCliWorkerError || error instanceof ClaudeAgentError && error.field !== 'cancelled'); controller.abort(); throw error; }
    }, cancel: () => port.cancel(), revoke: () => port.revoke() } satisfies ToolSessionPort,
  };
}
const workerResultCode = (reason: string) => headlessDiagnosticIdentifier('HEADLESS_WORKER_RESULT', { reason });
const codexEventChecks = new Set(['thread', 'turn', 'item', 'notice', 'item-order', 'item-replay', 'pending-tools', 'pending-items', 'event', 'after-turn']);
const claudeEventChecks = new Set(['init', 'event', 'before-init', 'after-result', 'subagent', 'correlation', 'correlation-incomplete',
  'tool-use', 'tool-result', 'tool-progress', 'proposal', 'proposal-order', 'facade-result']);
function structuredFailureCode(body: HeadlessRejectionBody | ReturnType<typeof nativeModelRefusal>): string | undefined {
  switch (body.refusal) {
    case 'guard': return workerResultCode(body.field === 'agent-surface:rate-limit-status' ? 'quota-status-unrecognized' : 'guard');
    case 'login-required': return 'NATIVE_AGENT_LOGIN_REQUIRED';
    case 'credits-required': return 'HEADLESS_CREDITS_REQUIRED';
    case 'usage-unavailable': return 'SIWC_USAGE_UNAVAILABLE';
    case 'service-unavailable': return 'SIWC_SERVICE_UNAVAILABLE';
    case 'plan-unavailable': return 'HEADLESS_PLAN_UNAVAILABLE';
    case 'response-limit': return 'NATIVE_WORKER_OUTPUT_LIMIT';
    default: return workerResultCode(body.refusal);
  }
}
export function nativeWorkerProcessResult(evidence: { reason: string; limit: string | null; exitCode?: number | null; signal?: string | null;
  stdoutTruncated: boolean; stderrTruncated: boolean; cleanupError?: DeckentError }, aborted: boolean, refused: boolean,
  finished?: { kind: 'completed'; text: string } | { kind: 'refused'; reason: NativeAgentReadinessReason; field?: string; limit?: ClaudeRateLimit; rejection?: ReturnType<typeof nativeModelRefusal> }
    | { kind: 'failed' | 'cancelled'; rejection?: ReturnType<typeof nativeModelRefusal> },
  result?: { lineStopped?: boolean } & ({ response?: { native?: unknown }; refusal?: never } | { refusal: { body: HeadlessRejectionBody }; response?: never }) | null,
  terminalFailure?: 'approval-expired' | null) {
  const base = { termination: 'confirmed' as const, text: '' };
  const unresolved = evidence.cleanupError && { termination: 'unverified' as const, text: '', status: 'failed' as const, cleanupError: evidence.cleanupError };
  if (terminalFailure === 'approval-expired')
    return { ...(unresolved ?? { ...base, status: 'failed' as const, text: 'APPROVAL_EXPIRED' }), failureCode: 'APPROVAL_EXPIRED' };
  const claudeRejection = finished?.kind === 'refused' && finished.limit ? nativeQuotaRejection(finished.limit)
    : finished?.kind !== 'completed' ? finished?.rejection : undefined;
  const body = claudeRejection ?? result?.refusal?.body;
  if (body && (result?.lineStopped || finished?.kind === 'refused')) {
    if (body.refusal === 'guard' && body.field && result?.lineStopped && (codexEventChecks.has(body.field) || body.field.startsWith('mcp-')))
      return { ...(unresolved ?? { ...base, status: 'failed' as const }), refusal: 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED' as const };
    return { ...(unresolved ?? { ...base, status: 'failed' as const }), stopped: true as const,
      failureCode: structuredFailureCode(body) ?? 'NATIVE_WORKER_TERMINATION_UNKNOWN' };
  }
  if (finished?.kind === 'refused' || refused) {
    const refusal = finished?.kind === 'refused' ? finished.reason : 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED' as const;
    if (refusal === 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED' && finished?.kind === 'refused' && finished.field && !claudeEventChecks.has(finished.field))
      // C6: the parser's own byte bound (`size`) is the established output bound, not an unexpected tool or a general guard.
      return { ...(unresolved ?? { ...base, status: 'failed' as const }), stopped: true as const,
        failureCode: finished.field === 'size' ? 'NATIVE_WORKER_OUTPUT_LIMIT' : workerResultCode('guard') ?? 'NATIVE_WORKER_TERMINATION_UNKNOWN' };
    return unresolved ? { ...unresolved, refusal } : { ...base, status: 'failed' as const, refusal };
  }
  const processFailure = evidence.reason === 'exit' && typeof evidence.exitCode === 'number' && evidence.exitCode > 0
    ? headlessDiagnosticIdentifier('HEADLESS_WORKER_RESULT', { reason: 'exit', exitCode: evidence.exitCode })
    : evidence.reason === 'signal' && evidence.signal ? workerResultCode('signal')
    : evidence.reason === 'start-failed' ? 'NATIVE_WORKER_NOT_STARTED' : undefined;
  const failureCode = (body && structuredFailureCode(body)) ?? processFailure;
  if (aborted || evidence.reason === 'cancelled' || evidence.reason === 'timeout')
    return { ...(unresolved ?? { ...base, status: 'cancelled' as const }),
      // C2: the deadline decides the outcome class; a provider status the Claude result already reported keeps the reason.
      failureCode: evidence.reason === 'timeout' ? (claudeRejection && structuredFailureCode(claudeRejection)) ?? 'NATIVE_WORKER_DEADLINE_REACHED'
        : failureCode ?? 'NATIVE_WORKER_STOP_UNCONFIRMED' };
  if (evidence.limit || evidence.stdoutTruncated || evidence.stderrTruncated) {
    const failureCode = evidence.limit ? headlessDiagnosticIdentifier('HEADLESS_LIMIT_REACHED', { limit: evidence.limit }) : 'NATIVE_WORKER_OUTPUT_LIMIT';
    return { ...(unresolved ?? { ...base, status: 'failed' as const }), ...(failureCode && { failureCode }) };
  }
  const failed = unresolved ?? { ...base, status: 'failed' as const };
  const code = evidence.reason === 'output-limit' || evidence.reason === 'line-limit' ? 'NATIVE_WORKER_OUTPUT_LIMIT' : failureCode;
  if (unresolved) return { ...unresolved, ...(code && { failureCode: code }) };
  if (finished?.kind === 'completed') return { ...base, status: 'completed' as const, text: finished.text };
  const native = result?.response?.native as { choices?: { message?: { content?: unknown } }[] } | undefined, content = native?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? { ...base, status: 'completed' as const, text: content } : { ...failed, ...(code && { failureCode: code }) };
}

/** A K1 session is published once; cancellation before publication rejects its caller rather than leaving it waiting. */
export function nativeWorkerToolLifetime() {
  let ready!: (session: ToolSessionPort) => void, failed!: (error: unknown) => void, finish!: () => void;
  const opened = new Promise<ToolSessionPort>((resolve, reject) => { ready = resolve; failed = reject; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  return { opened, finished, ready, failed, async close<T>(close: () => Promise<T>, turn: Promise<unknown>) {
    await close(); finish(); await turn;
    return close();
  } };
}
