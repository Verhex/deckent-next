import type { ToolSessionPort } from './session.js';
import { DeckentError, headlessDiagnosticIdentifier } from '#platform/index.js';
import type { NativeAgentReadinessReason } from './contract.js';
import { ClaudeAgentError } from './claude-stream.js';
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
      catch (error) { refused ||= !signal.aborted && !callSignal.aborted && (error instanceof NativeCliWorkerError || error instanceof ClaudeAgentError); controller.abort(); throw error; }
    }, cancel: () => port.cancel(), revoke: () => port.revoke() } satisfies ToolSessionPort,
  };
}
export function nativeWorkerProcessResult(evidence: { reason: string; limit: string | null; stdoutTruncated: boolean; stderrTruncated: boolean; cleanupError?: DeckentError }, aborted: boolean,
  refused: boolean, finished?: { kind: 'completed'; text: string } | { kind: 'refused'; reason: NativeAgentReadinessReason } | { kind: 'failed' | 'cancelled' },
  result?: { response?: { native?: unknown } } | null, terminalFailure?: 'approval-expired' | null) {
  const base = { termination: 'confirmed' as const, text: '' };
  const unresolved = evidence.cleanupError && { termination: 'unverified' as const, text: '', status: 'failed' as const, cleanupError: evidence.cleanupError };
  if (terminalFailure === 'approval-expired')
    return { ...(unresolved ?? { ...base, status: 'failed' as const, text: 'APPROVAL_EXPIRED' }), failureCode: 'APPROVAL_EXPIRED' };
  if (finished?.kind === 'refused' || refused) {
    const refusal = finished?.kind === 'refused' ? finished.reason : 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED' as const;
    return unresolved ? { ...unresolved, refusal } : { ...base, status: 'failed' as const, refusal };
  }
  if (aborted || evidence.reason === 'cancelled' || evidence.reason === 'timeout')
    return { ...(unresolved ?? { ...base, status: 'cancelled' as const }),
      failureCode: evidence.reason === 'timeout' ? 'NATIVE_WORKER_DEADLINE_REACHED' : 'NATIVE_WORKER_STOP_UNCONFIRMED' };
  if (evidence.limit || evidence.stdoutTruncated || evidence.stderrTruncated) {
    const failureCode = evidence.limit ? headlessDiagnosticIdentifier('HEADLESS_LIMIT_REACHED', { limit: evidence.limit }) : 'NATIVE_WORKER_OUTPUT_LIMIT';
    return { ...(unresolved ?? { ...base, status: 'failed' as const }), ...(failureCode && { failureCode }) };
  }
  if (unresolved) {
    const outputBound = evidence.reason === 'output-limit' || evidence.reason === 'line-limit';
    return outputBound ? { ...unresolved, failureCode: 'NATIVE_WORKER_OUTPUT_LIMIT' } : unresolved;
  }
  if (finished?.kind === 'completed') return { ...base, status: 'completed' as const, text: finished.text };
  const native = result?.response?.native as { choices?: { message?: { content?: unknown } }[] } | undefined, content = native?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? { ...base, status: 'completed' as const, text: content } : { ...base, status: 'failed' as const };
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
