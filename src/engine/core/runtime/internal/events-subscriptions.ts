import type { RuntimeEventsApplication } from './events-application.js';
import type { RuntimeEventsItem } from './events-contract.js';
import type { RuntimeEventsSettings } from '#platform/index.js';
import { ErrorRegistry } from '#platform/index.js';
import type { RuntimeServiceLifecycle } from './service-lifecycle.js';
export interface RuntimeEventsDeliveryChannel {
  readonly signal: AbortSignal;
  disconnect(): void;
  send(item: RuntimeEventsItem, drainTimeoutMs: number): Promise<void>;
}
/** Tracks only observation delivery. Admission is short; queued socket data keeps its subscriber slot until drain ends. */
export function createRuntimeEventsDelivery(events: RuntimeEventsApplication, limits: RuntimeEventsSettings) {
  const eventStreams = new Map<RuntimeEventsDeliveryChannel, Promise<void>>();
  const subscriptionSlots = new Set<RuntimeEventsDeliveryChannel>();
  const stop = async () => {
    const deadline = setTimeout(() => { for (const channel of subscriptionSlots) channel.disconnect(); }, limits.closeGraceMs);
    try { await events.stop(); await Promise.allSettled(eventStreams.values()); } finally { clearTimeout(deadline); }
  };
  return { stop, async deliver(lifecycle: RuntimeServiceLifecycle, subscription: RuntimeEventsDeliveryChannel, input: unknown, peer: unknown) {
        const work = (async () => {
          const admitted = await lifecycle.admitBounded(() => {
            if (subscriptionSlots.size >= limits.maxSubscribers) throw ErrorRegistry.createError('RUNTIME_EVENTS_LIMIT');
            subscriptionSlots.add(subscription);
            return events.subscribe(input, subscription.signal, peer);
          });
          try { for await (const item of admitted.items) await subscription.send(item, limits.drainTimeoutMs); }
          finally { admitted.close(); }
        })();
        eventStreams.set(subscription, work);
        try { await work; } finally { eventStreams.delete(subscription); subscriptionSlots.delete(subscription); }
  } };
}
