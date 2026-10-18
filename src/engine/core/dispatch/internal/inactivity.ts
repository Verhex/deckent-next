import type { TaskStallPolicy } from '#domain/index.js';
export type InactivityVerdict = 'active' | 'warn' | 'stop';
type Policy = Pick<TaskStallPolicy, 'warnAfterMs' | 'stopAfterMs'>;
/**
 * R3 (owner D4a), pure: silence counts from host-observed facts only: the dispatch start, the host receipt time of the last worker event and
 * the last host-side model traffic through the gateway. Heartbeat freshness is deliberately not an input (the host writes it while the
 * container merely exists). Missing evidence can only stop a worker, never accept one.
 */
export function inactivityVerdict(input: Readonly<{ dispatchedAt: number; lastEventReceivedAt: number | null; lastModelTrafficAt: number | null; now: number; policy: Policy }>): InactivityVerdict {
  const silentFor = input.now - Math.max(input.dispatchedAt, input.lastEventReceivedAt ?? 0, input.lastModelTrafficAt ?? 0);
  return silentFor >= input.policy.stopAfterMs ? 'stop' : silentFor >= input.policy.warnAfterMs ? 'warn' : 'active';
}
/** The gateway's monotonic host-side counters: event batches it received (accepted, dropped or refused) and tunnelled model bytes. */
export type GatewayActivityCounters = Readonly<{ events: number; eventsDropped: number; eventsUnreported: number; bytes: number }>;
/** Samples the counters on the caller's existing tick; any change is activity at that sampling time. */
export function inactivityWatch(policy: Policy, dispatchedAt: number) {
  let events = 0, bytes = 0, lastEventReceivedAt: number | null = null, lastModelTrafficAt: number | null = null;
  return (now: number, counters: GatewayActivityCounters): InactivityVerdict => {
    const received = counters.events + counters.eventsDropped + counters.eventsUnreported;
    if (received !== events) { events = received; lastEventReceivedAt = now; }
    if (counters.bytes !== bytes) { bytes = counters.bytes; lastModelTrafficAt = now; }
    return inactivityVerdict({ dispatchedAt, lastEventReceivedAt, lastModelTrafficAt, now, policy });
  };
}
