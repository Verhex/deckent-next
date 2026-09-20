import type { JSONRPCMessage, MessageExtraInfo, RequestId, Transport, TransportSendOptions } from '@modelcontextprotocol/server';

const limitError = (id: RequestId | null): JSONRPCMessage => ({ jsonrpc: '2.0', id,
  error: { code: -32603, message: 'MCP_RESPONSE_LIMIT' } } as JSONRPCMessage);
const bytes = (message: JSONRPCMessage): number => Buffer.byteLength(`${JSON.stringify(message)}\n`, 'utf8');
const isRequest = (message: JSONRPCMessage): message is JSONRPCMessage & { id: RequestId; method: string } =>
  'id' in message && 'method' in message;
const isResponse = (message: JSONRPCMessage): message is JSONRPCMessage & { id: RequestId } =>
  'id' in message && ('result' in message || 'error' in message);

class BoundedMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  private closed = false;
  private closeNotified = false;
  declare readonly hasPerRequestStream?: boolean;
  constructor(private readonly transport: Transport, private readonly responseMaxBytes: number) {
    if (transport.hasPerRequestStream !== undefined) Object.defineProperty(this, 'hasPerRequestStream', {
      enumerable: true, value: transport.hasPerRequestStream,
    });
  }
  get sessionId() { return this.transport.sessionId; }
  set sessionId(value: string | undefined) { this.transport.sessionId = value; }
  setProtocolVersion(version: string) { this.transport.setProtocolVersion?.(version); }
  setSupportedProtocolVersions(versions: string[]) { this.transport.setSupportedProtocolVersions?.(versions); }

  async start(): Promise<void> {
    this.transport.onmessage = (message, extra) => { void this.receive(message, extra).catch(() => undefined); };
    this.transport.onerror = error => this.onerror?.(error);
    this.transport.onclose = () => this.notifyClose();
    await this.transport.start();
  }
  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (this.closed) throw new Error('MCP_TRANSPORT_CLOSED');
    let size: number;
    try { size = bytes(message); } catch { return this.fail(new Error('MCP_RESPONSE_LIMIT')); }
    if (size <= this.responseMaxBytes) return this.transport.send(message, options);
    if (isResponse(message)) {
      const fallback = limitError(message.id);
      if (bytes(fallback) <= this.responseMaxBytes) return this.transport.send(fallback, options);
    }
    return this.fail(new Error('MCP_RESPONSE_LIMIT'));
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.transport.close(); } finally { this.notifyClose(); }
  }
  private async receive(message: JSONRPCMessage, extra?: MessageExtraInfo): Promise<void> {
    if (this.closed) return;
    if (isRequest(message) && bytes(limitError(message.id)) > this.responseMaxBytes) {
      await this.fail(new Error('MCP_RESPONSE_LIMIT'));
      return;
    }
    this.onmessage?.(message, extra);
  }
  private async fail(error: Error): Promise<never> {
    if (!this.closed) {
      this.onerror?.(error);
      await this.close();
    }
    throw error;
  }
  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.closed = true;
    this.onclose?.();
  }
}

export function createBoundedMcpTransport(transport: Transport, options: { readonly responseMaxBytes: number }): Transport {
  if (!transport || typeof transport.start !== 'function' || typeof transport.send !== 'function' || typeof transport.close !== 'function'
    || !Number.isSafeInteger(options.responseMaxBytes) || options.responseMaxBytes < 1
    || bytes(limitError(null)) > options.responseMaxBytes) throw new RangeError('MCP_RESPONSE_LIMIT_INVALID');
  return new BoundedMcpTransport(transport, options.responseMaxBytes);
}
