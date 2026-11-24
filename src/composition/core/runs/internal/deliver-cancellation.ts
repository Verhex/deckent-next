import { randomUUID } from 'node:crypto';
import { SystemTrustedClock, ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { verifiedPrincipal, RunCancellationCoordinator, type RunCommand } from '#engine/index.js';
import { withRecordedRunCancellation } from './cancel.js';
import { createRecordedCancellationDelivery } from './cancellation-runtime.js';
/** Explicit delivery, separate from request-only SDK entry. Current Run and per-Attempt policy gate
 * every delivery; stopped containers stay retained until independent output durability/release.
 */
export function deliverConfiguredRunCancellation(projectRoot: string, input: RunCommand, options: ConfigLoadOptions = {}) {
  return withRecordedRunCancellation(projectRoot, input, options, async ({ context: { config, layout, principal }, receipt, runs, store }) => {
    // Each attempt delivers against the committed Run's immutable custody.
    const clock = new SystemTrustedClock();
    const delivery = createRecordedCancellationDelivery(store, config, layout, principal, verifiedPrincipal(principal));
    const coordinator = new RunCancellationCoordinator(runs, store, delivery, config.cancellation!, { now: () => clock.sample().wallMs, token: randomUUID });
    return Object.freeze({ schemaVersion: 1 as const, layout, delivery: await coordinator.deliver(receipt) });
  }, ({ config }) => {
    if (!config.cancellation) throw ErrorRegistry.createError('CANCELLATION_NOT_CONFIGURED', { params: { missing: 'cancellation' } });
  });
}
