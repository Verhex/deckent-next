import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ErrorRegistry } from '#platform/index.js';
import { SIWC_WORKER_RELAY as R } from '#adapters/core/provider-siwc/index.js';
import { yamaPtraceScope } from './proc.js';
import type { SiwcTurnOutcome } from './client.js';

/**
 * U9-6/7 launch gate, before any lease, relay, container or effect: the registry activation (held until the operator's real-binary proof),
 * a Linux host whose Docker workers share its kernel (SO_PEERCRED host pids, /proc peer facts) and Yama ptrace scope ≥ 1 (a tool child
 * cannot read its ancestors' memory, where the relay capability lives), and the Codex CLI recorded in the Attempt's worker image.
 * Every miss is a typed refusal; there is no host, env-token, file-token or account-login fallback.
 */
export function assertSiwcWorkerLaunchable(input: Readonly<{ platform: NodeJS.Platform; imageCodexVersion: string | null; ptraceScope?: number | null }>): void {
  if (input.platform !== 'linux') throw ErrorRegistry.createError('SIWC_WORKER_ISOLATION_UNAVAILABLE', { params: { check: 'platform' } });
  const scope = input.ptraceScope === undefined ? yamaPtraceScope() : input.ptraceScope;
  if (scope === null || scope < 1) throw ErrorRegistry.createError('SIWC_WORKER_ISOLATION_UNAVAILABLE', { params: { check: 'ptrace-scope' } });
  if (!input.imageCodexVersion) throw ErrorRegistry.createError('SIWC_APP_SERVER_AUTH_UNAVAILABLE', { params: { reason: 'image-codex-missing' } });
  if (R.activation !== 'open') throw ErrorRegistry.createError('SIWC_APP_SERVER_AUTH_UNAVAILABLE', { params: { reason: 'activation-hold' } });
}
/** The visible worker state (U9 rev 6 §11.5; adapter view, not a Run state). */
export type SiwcWorkerStop = Readonly<{ phase: 'stopped' | 'cleanup-unproven'; reason: string; outcome: SiwcTurnOutcome | null }>;
/**
 * U9-7b stop order: revoke C (upstream sends and streams close, `turn/interrupt` is asked) → bounded drain → supervisor kill + inspect of
 * the immutable container → relay close (private socket directory removed). `stopped` needs an observed exit AND the removed directory;
 * anything else is `cleanup-unproven` (relaunch stays blocked; recovery owns it). Never a remote OAuth revocation.
 */
export async function stopSiwcWorker(input: Readonly<{ reason: string;
  relay: { revoke(reason: string): void; close(): Promise<void>; outcome: Promise<SiwcTurnOutcome>; descriptor: { socketPath: string } };
  cancel: () => Promise<{ result: { kind: string } }> }>): Promise<SiwcWorkerStop> {
  input.relay.revoke(input.reason);
  let outcome: SiwcTurnOutcome | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([input.relay.outcome.then(value => { outcome = value; }), new Promise<void>(resolve => { timer = setTimeout(resolve, R.limits.drainMs); })]);
  clearTimeout(timer);
  const observed = await input.cancel().catch(() => null);
  await input.relay.close().catch(() => undefined);
  const removed = await lstat(dirname(input.relay.descriptor.socketPath)).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  return Object.freeze({ phase: observed?.result.kind === 'exited' && removed ? 'stopped' : 'cleanup-unproven', reason: input.reason, outcome });
}
/**
 * U9 rev 6 §11.5: the typed result of a settled launch (null = the turn completed). Cleanup that could not be proven wins; a lost control
 * channel after an accepted native effect is effect-unknown (reconcile, never replay); a lost one before any effect means the pinned
 * app-server could not serve this transport; a capability/upstream-auth failure is a relay refusal.
 */
export function siwcWorkerResultError(outcome: SiwcTurnOutcome | null, stop: SiwcWorkerStop | null) {
  if (stop?.phase === 'cleanup-unproven') return ErrorRegistry.createError('SIWC_WORKER_CLEANUP_UNPROVEN');
  if (!outcome || outcome.status === 'lost') return outcome && outcome.approvals.accepted === 0 && outcome.reason === 'protocol'
    ? ErrorRegistry.createError('SIWC_APP_SERVER_AUTH_UNAVAILABLE', { params: { reason: 'app-server-unsupported' } }) : ErrorRegistry.createError('SIWC_APP_SERVER_EFFECT_UNKNOWN');
  if (outcome.status === 'failed' && outcome.reason === 'capability') return ErrorRegistry.createError('SIWC_RELAY_REFUSED', { params: { reason: 'capability' } });
  return null;
}
