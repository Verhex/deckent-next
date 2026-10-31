import type { Transport } from '@modelcontextprotocol/client';
import { INPUT_VALIDATION_LIMITS, inputWithinValidationLimit } from '#platform/index.js';

/** A rejected message may follow an effect: close without forwarding it or replaying the request. */
export class McpInputLimitError extends Error {
  readonly code = 'MCP_INPUT_LIMIT';
  constructor() { super('MCP_INPUT_LIMIT'); this.name = 'McpInputLimitError'; }
}
/** Runs after the SDK's JSON-RPC envelope parse, before discovery, era codecs and result/schema validators.
 * The setter keeps the gate when negotiation hands the transport over to Protocol. Raw bytes are also bounded by each transport. */
export function boundedMcpTransport<T extends Transport>(transport: T, maxBytes: number, refused: (error: McpInputLimitError) => void): T {
  let receive: Transport['onmessage'], rejected = false;
  Object.defineProperty(transport, 'onmessage', { get: () => receive, set: (handler: typeof receive) => {
    receive = (message, extra) => {
      if (rejected) return;
      if (!inputWithinValidationLimit(message, INPUT_VALIDATION_LIMITS.mcp) || Buffer.byteLength(JSON.stringify(message)) > maxBytes) {
        rejected = true; const error = new McpInputLimitError(); refused(error);
        transport.onerror?.(error); void transport.close().catch(() => undefined); return;
      }
      handler?.(message, extra);
    };
  } });
  return transport;
}
