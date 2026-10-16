import { runtimeEventsQuerySchema, type RuntimeEventsItem } from './events-contract.js';
import { RuntimeServiceProtocolError } from './service-protocol.js';
/** Validates presentation order and query binding before handing any subscription item to an SDK consumer. */
export function createRuntimeEventsConsumer(input: unknown) {
  const query = runtimeEventsQuerySchema.parse(input); let ready = false, closed = false, live = false;
  let epoch = '', view = '', snapshot: string | null = null, sequence = 0;
  const fail = (): never => { throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_CORRELATION'); };
  return (item: RuntimeEventsItem): void => {
    if (closed) fail();
    if (item.type === 'ready') {
      if (ready || item.scopeId !== query.scopeId || [...item.topics].sort().join('\0') !== [...query.topics].sort().join('\0')) fail();
      ready = true; epoch = item.serviceEpoch; view = item.viewId;
      if (query.resume?.serviceEpoch === epoch && query.resume.viewId === view) { live = true; sequence = query.resume.sequence; }
      return;
    }
    if (!ready && item.type === 'close') { closed = true; return; }
    if (!ready) fail();
    if ('resume' in item) {
      if (item.resume.serviceEpoch !== epoch || item.resume.viewId !== view || (item.type !== 'close' && item.resume.sequence < sequence)) fail();
    }
    if ('record' in item && !query.topics.includes(item.record.topic)) fail();
    if (item.type === 'snapshot.begin') { if (snapshot) fail(); snapshot = item.snapshotId; live = false; }
    if (item.type === 'snapshot.part' && (snapshot === null || item.snapshotId !== snapshot)) fail();
    if (item.type === 'snapshot.end') {
      if (!snapshot || item.snapshotId !== snapshot) fail(); snapshot = null; live = true; sequence = item.resume.sequence;
    }
    if (item.type === 'change') { if (!live || snapshot || item.resume.sequence !== sequence + 1) fail(); sequence = item.resume.sequence; }
    if (item.type === 'gap') { snapshot = null; live = false; sequence = item.resume.sequence; }
    if (item.type === 'heartbeat' && (!live || snapshot)) fail();
    if (item.type === 'close') closed = true;
  };
}
