import { RuntimeServiceProtocolError, parseRuntimeServiceResponse, type RuntimeServiceRequest, type RuntimeServiceResponse } from '#engine/core/runtime/index.js';
import { ServiceFrameError } from '#engine/core/runtime-transport/index.js';
type FramePart = { readonly requestId: string; readonly sequence: number; readonly deliver: () => void; readonly required?: boolean };
/** One ordered sequence and final response; presentation exceptions retain the operation's required-data semantics. */
export function createRuntimeFrameConsumer(request: RuntimeServiceRequest, part: (frame: unknown) => FramePart | null) {
  let sequence = 0, final: RuntimeServiceResponse | null = null;
  return { accept(value: unknown) {
          if (final) throw new ServiceFrameError('SERVICE_FRAME_EXTRA');
          const parsed = part(value);
          if (!parsed) { final = parseRuntimeServiceResponse(request.requestId, value); return; }
          if (parsed.requestId !== request.requestId || parsed.sequence !== sequence) {
            throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_CORRELATION');
          }
          sequence += 1;
          if (parsed.required) parsed.deliver();
          else try { parsed.deliver(); } catch { /* A presentation failure never changes the response. */ }
  }, finish() {
    if (!final) throw new ServiceFrameError('SERVICE_FRAME_TRUNCATED');
    return final;
  } };
}
