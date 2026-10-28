import type { AuditApplication } from '#engine/core/audit/index.js';
import type { NervousApplication, NervousContext } from '#engine/core/nervous/index.js';
import type { BeuserContext } from '#engine/core/beuser-contract/index.js';
import { beuserRefusalEvent } from './events.js';

/** The existing sealed writer is the only producer. An uncertain append never permits a subsequent effect. */
export async function recordBeuserRefusal(context: BeuserContext, ports: {
  readonly audit: Pick<AuditApplication, 'record' | 'load'>;
  readonly nervous: Pick<NervousApplication, 'observeFeed' | 'feedCursor'>;
  readonly nervousContext: NervousContext; readonly policyRevision: string; readonly now: () => number;
}): Promise<void> {
  const event = beuserRefusalEvent(context, ports.policyRevision, ports.now());
  const previous = await ports.audit.load(event.scopeId, event.eventId);
  const record = previous ?? await ports.audit.record(event);
  if (record.event.subject.kind !== 'beuser-target-refusal'
    || JSON.stringify(record.event.principal) !== JSON.stringify(event.principal) || record.event.scopeId !== event.scopeId || record.event.eventId !== event.eventId
    || JSON.stringify(record.event.subject) !== JSON.stringify(event.subject)) throw new Error('BEUSER_TARGET_NOT_SANDBOX');
  // A refusal feed is observation only, even if the installation has live recovery enabled.
  if (record.sequence > ports.nervous.feedCursor(event.scopeId, 'beuser-target-refusal')) await ports.nervous.observeFeed(event.scopeId, 'beuser-target-refusal',
    [{ sequence: record.sequence, event: record.event }], { ...ports.nervousContext, promoted: () => false });
}
