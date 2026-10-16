import { runtimeServiceSubscriptionFrameSchema, parseRuntimeServiceResponse, RuntimeServiceProtocolError, type RuntimeServiceRequest, type RuntimeServiceResponse } from './service-protocol.js';
import { createRuntimeEventsConsumer } from './events-consumer.js';
/** Wire correlation and presentation state, shared independently of transport I/O. */
export function createRuntimeEventsFrameConsumer(request: RuntimeServiceRequest, limit: number) {
  const acceptItem = createRuntimeEventsConsumer(request.input);
  let sequence = 0, final: RuntimeServiceResponse | null = null, closeSeen = false;
  return { accept(raw: unknown) {
        if (final) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_CORRELATION');
        const parsed = runtimeServiceSubscriptionFrameSchema.safeParse(raw);
        if (!parsed.success) { final = parseRuntimeServiceResponse(request.requestId, raw); return null; }
        if (Buffer.byteLength(JSON.stringify(raw)) > limit || parsed.data.requestId !== request.requestId || parsed.data.sequence !== sequence++ || closeSeen) {
          throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_CORRELATION');
        }
        acceptItem(parsed.data.item); closeSeen = parsed.data.item.type === 'close';
        return parsed.data.item;
    }, finish() {
    if (!final || (final.ok && (!closeSeen || JSON.stringify(final.result) !== JSON.stringify({ closed: true })))) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_CORRELATION');
    return final;
    } };
}
