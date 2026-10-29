import { DeckentError, ErrorRegistry } from '#platform/index.js';
import type { RuntimeServiceDescriptor } from './shutdown-contract.js';
export interface RuntimeServiceReadiness {
  readonly mode: 'connected' | 'started';
  readonly instanceId: string;
  readonly pid: number | null;
  readonly logPath: string | null;
  readonly shutdownAvailable: boolean;
  readonly build: NonNullable<RuntimeServiceDescriptor['build']> | null;
  /** Restart-apply configuration fingerprint the service started with, and its idle stop period (null: never); undefined from an older service. */
  readonly configDigest: string | undefined;
  readonly idleStopMs: number | null;
}
export const runtimeServiceReadiness = (mode: 'connected' | 'started', descriptor: RuntimeServiceDescriptor, pid: number | null, logPath: string | null): RuntimeServiceReadiness =>
  Object.freeze({ mode, instanceId: descriptor.instanceId, pid, logPath, shutdownAvailable: descriptor.shutdownAvailable, build: descriptor.build ?? null,
    configDigest: descriptor.configDigest, idleStopMs: descriptor.idleStopMs ?? null });
/** One monotonic deadline bounds every describe, including an accepting-but-silent peer (wall clock can step back). */
export function runtimeMonotonicDeadline(timeoutMs: number) {
  const until = performance.now() + timeoutMs;
  return { remaining: () => Math.max(0, until - performance.now()), expired: () => performance.now() >= until };
}
export type LifecycleDeadline = ReturnType<typeof runtimeMonotonicDeadline>;
export const runtimeDeadlineSignal = (deadline: LifecycleDeadline) => AbortSignal.timeout(Math.max(1, Math.ceil(deadline.remaining())));

interface RuntimeWaitPorts { readonly wait: (ms: number) => Promise<unknown>; readonly pollMs: number }
export async function awaitRuntimeServiceStart(deadline: LifecycleDeadline, pid: number, logPath: string,
  ports: RuntimeWaitPorts & { readonly describe: () => Promise<{ readonly descriptor: RuntimeServiceDescriptor | null; readonly code: string | null }> }): Promise<RuntimeServiceReadiness> {
  while (!deadline.expired()) {
    await ports.wait(Math.min(ports.pollMs, deadline.remaining()));
    if (deadline.expired()) break;
    const next = await ports.describe().catch(error => {
      // While our process starts, the endpoint may briefly accept before it answers; only the deadline ends the wait.
      if (error instanceof DeckentError && (error.code === 'LOCAL_RUNTIME_TRANSPORT' || error.code === 'RUNTIME_SERVICE_TRANSPORT')) return { descriptor: null, code: error.code };
      throw error;
    });
    // A concurrent terminal may have won the start race: its service is used, but it is not reported as our launch.
    if (next.descriptor) return next.descriptor.processId === pid ? runtimeServiceReadiness('started', next.descriptor, pid, logPath)
      : runtimeServiceReadiness('connected', next.descriptor, null, logPath);
  }
  throw ErrorRegistry.createError('RUNTIME_AUTOSTART_FAILED', { params: { log: logPath } });
}
export async function awaitRuntimeServiceRestart(deadline: LifecycleDeadline,
  ports: RuntimeWaitPorts & { readonly describe: () => Promise<unknown>; readonly start: () => Promise<RuntimeServiceReadiness>; readonly startable?: RuntimeStartable }): Promise<RuntimeServiceReadiness> {
  while (!deadline.expired()) {
    try { await ports.describe(); }
    catch (error) {
      if (error instanceof DeckentError && error.code === 'LOCAL_RUNTIME_UNAVAILABLE' || await ports.startable?.(error)) return ports.start();
      // The stopping service may close connections while it drains; keep waiting for absence until the deadline.
      if (!(error instanceof DeckentError && (error.code === 'LOCAL_RUNTIME_TRANSPORT' || error.code === 'RUNTIME_SERVICE_TRANSPORT'))) throw error;
    }
    await ports.wait(Math.min(ports.pollMs, deadline.remaining()));
  }
  throw ErrorRegistry.createError('RUNTIME_AUTOSTART_FAILED', { params: { log: '-' } });
}

/** Only positive evidence of absence starts a service: no endpoint (or its never-created state directory) or a refused
 * connection (nothing listens). A peer that accepts but fails or stays silent may be a live incompatible or unhealthy
 * service, so it is reported, never replaced; ownership/unsafe failures are never auto-repaired by a reader (Astra 2054 R2).
 * Single exception (RESTART-HUNT, LAW-AUDIT-2 K1–K5, Jev ed1f54d8): `startable` names this installation's own empty socket directory whose
 * only fault is the mode; the terminal autostart and `runtime restart` launch the ordinary service start for it once (the start re-creates it,
 * fix A). The describe itself still refuses it; the predicate is read-only and never yields an endpoint; any other unsafe state throws.
 * When the predicate does not confirm an UNSAFE refusal, one fresh describe is judged by the same rule (RESTART-HUNT race, alpha.58). */
export type RuntimeStartable = (error: unknown) => Promise<boolean>;
const ABSENT = new Set(['LOCAL_RUNTIME_UNAVAILABLE']);
export async function describeRuntimeServiceWithin(describe: (signal: AbortSignal) => Promise<RuntimeServiceDescriptor>, deadline: LifecycleDeadline,
  startable?: RuntimeStartable) {
  const judged = async () => {
    try { return { descriptor: await describe(runtimeDeadlineSignal(deadline)), code: null }; }
    catch (error) {
      const code = error instanceof DeckentError ? error.code : null;
      if (code !== null && (ABSENT.has(code) || await startable?.(error))) return { descriptor: null, code };
      throw error;
    }
  };
  return judged().catch(error => {
    // The predicate's later look disagreeing with this refusal means the state changed (the launched start heals once): judge one fresh read, never the stale refusal.
    if (startable && error instanceof DeckentError && error.code === 'LOCAL_RUNTIME_ENDPOINT_UNSAFE') return judged();
    throw error;
  });
}
