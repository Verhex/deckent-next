import type { ToolSessionPort } from './session.js';
import type { NativeAgentReadinessReason } from './contract.js';
import { ClaudeAgentError } from './claude-stream.js';
import { NativeCliWorkerError } from './worker-profile.js';

type Call = Parameters<ToolSessionPort['propose']>[0];
type Result = Awaited<ReturnType<ToolSessionPort['propose']>>;
/** Preflight owns only bounded probes. Its settled cancellation precedes any model process or private run files. */
export async function nativeWorkerPreflight<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return null;
  try { const checked = await run(); return signal.aborted ? null : checked; }
  catch (error) { if (signal.aborted) return null; throw error; }
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
export function nativeWorkerProcessResult(evidence: { reason: string; limit: string | null; stdoutTruncated: boolean; stderrTruncated: boolean }, aborted: boolean,
  refused: boolean, finished?: { kind: 'completed'; text: string } | { kind: 'refused'; reason: NativeAgentReadinessReason } | { kind: 'failed' | 'cancelled' },
  result?: { response?: { native?: unknown } } | null, terminalFailure?: 'approval-expired' | null) {
  const base = { termination: 'confirmed' as const, text: '' };
  if (terminalFailure === 'approval-expired') return { ...base, status: 'failed' as const, text: 'APPROVAL_EXPIRED' };
  if (finished?.kind === 'refused' || refused) return { ...base, status: 'failed' as const,
    refusal: finished?.kind === 'refused' ? finished.reason : 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED' as const };
  if (aborted || evidence.reason === 'cancelled' || evidence.reason === 'timeout') return { ...base, status: 'cancelled' as const };
  if (evidence.limit || evidence.stdoutTruncated || evidence.stderrTruncated) return { ...base, status: 'failed' as const };
  if (finished?.kind === 'completed') return { ...base, status: 'completed' as const, text: finished.text };
  const native = result?.response?.native as { choices?: { message?: { content?: unknown } }[] } | undefined, content = native?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? { ...base, status: 'completed' as const, text: content } : { ...base, status: 'failed' as const };
}

/** A K1 session is published once; cancellation before publication rejects its caller rather than leaving it waiting. */
export function nativeWorkerToolLifetime() {
  let ready!: (session: ToolSessionPort) => void, failed!: (error: unknown) => void, finish!: () => void;
  const opened = new Promise<ToolSessionPort>((resolve, reject) => { ready = resolve; failed = reject; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  return { opened, finished, ready, failed, async close<K extends 'cancelled' | 'revoked'>(session: ToolSessionPort, turn: Promise<unknown>, kind: K) {
    await session.cancel(); finish(); await turn;
    return { ...await session.cancel(), kind };
  } };
}
