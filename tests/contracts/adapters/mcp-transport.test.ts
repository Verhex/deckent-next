import { describe, expect, it } from 'vitest';
import type { JSONRPCMessage, MessageExtraInfo, Transport, TransportSendOptions } from '@modelcontextprotocol/server';
import { createBoundedMcpTransport } from '#adapters/core/mcp-transport/index.js';

const encodedBytes = (value: unknown) => Buffer.byteLength(`${JSON.stringify(value)}\n`, 'utf8');
const minimal = { jsonrpc: '2.0' as const, id: null, error: { code: -32603, message: 'MCP_RESPONSE_LIMIT' } };
class FakeTransport implements Transport {
  onclose?: () => void; onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  sessionId?: string; readonly hasPerRequestStream = true;
  starts = 0; closes = 0; sends: Array<{ message: JSONRPCMessage; options?: TransportSendOptions }> = [];
  versions: string[] = []; supported: string[][] = [];
  async start() { this.starts++; }
  async send(message: JSONRPCMessage, options?: TransportSendOptions) { this.sends.push(options ? { message, options } : { message }); }
  async close() { this.closes++; this.onclose?.(); }
  setProtocolVersion(version: string) { this.versions.push(version); }
  setSupportedProtocolVersions(versions: string[]) { this.supported.push(versions); }
  receive(message: JSONRPCMessage, extra?: MessageExtraInfo) { this.onmessage?.(message, extra); }
}

describe('bounded MCP transport', () => {
  it('enforces the exact newline-delimited UTF-8 boundary including escaping and Unicode', async () => {
    const message = { jsonrpc: '2.0' as const, id: 1, result: { text: `quote:" snowman:☃${'x'.repeat(100)}` } };
    const exact = encodedBytes(message), base = new FakeTransport(), bounded = createBoundedMcpTransport(base, { responseMaxBytes: exact });
    await bounded.start(); await bounded.send(message);
    expect(base.sends).toEqual([{ message }]);
    const overflowBase = new FakeTransport(), overflow = createBoundedMcpTransport(overflowBase, { responseMaxBytes: exact - 1 });
    await overflow.start(); await overflow.send(message);
    expect(overflowBase.sends).toEqual([{ message: { jsonrpc: '2.0', id: 1,
      error: { code: -32603, message: 'MCP_RESPONSE_LIMIT' } } }]);
  });

  it('replaces oversized responses once and preserves numeric and string ids plus send context', async () => {
    for (const id of [42, 'request-"☃'] as const) {
      const base = new FakeTransport(), cap = Math.max(encodedBytes(minimal),
        encodedBytes({ jsonrpc: '2.0', id, error: { code: -32603, message: 'MCP_RESPONSE_LIMIT' } }));
      const bounded = createBoundedMcpTransport(base, { responseMaxBytes: cap }), options = { relatedRequestId: id };
      await bounded.start(); await bounded.send({ jsonrpc: '2.0', id, result: { payload: 'x'.repeat(1000) } }, options);
      expect(base.sends).toEqual([{ message: { jsonrpc: '2.0', id, error: { code: -32603, message: 'MCP_RESPONSE_LIMIT' } }, options }]);
    }
  });

  it('closes before forwarding a request whose correlated minimum error cannot fit', async () => {
    const base = new FakeTransport(), bounded = createBoundedMcpTransport(base, { responseMaxBytes: encodedBytes(minimal) });
    let handled = 0, errors = 0, closes = 0; bounded.onmessage = () => { handled++; }; bounded.onerror = () => { errors++; }; bounded.onclose = () => { closes++; };
    await bounded.start(); base.receive({ jsonrpc: '2.0', id: 'x'.repeat(1000), method: 'tools/call', params: {} });
    await new Promise(resolve => setImmediate(resolve));
    expect({ handled, errors, closes, underlyingCloses: base.closes, sends: base.sends.length })
      .toEqual({ handled: 0, errors: 1, closes: 1, underlyingCloses: 1, sends: 0 });
  });

  it('closes oversized notifications and unserializable messages without truncation or duplicate sends', async () => {
    for (const message of [
      { jsonrpc: '2.0', method: 'notifications/message', params: { payload: 'x'.repeat(1000) } },
      (() => { const value: Record<string, unknown> = { jsonrpc: '2.0', id: 1, result: {} }; value.result = value; return value; })(),
    ]) {
      const base = new FakeTransport(), bounded = createBoundedMcpTransport(base, { responseMaxBytes: encodedBytes(minimal) });
      let closes = 0; bounded.onclose = () => { closes++; }; await bounded.start();
      await expect(bounded.send(message as JSONRPCMessage)).rejects.toThrow('MCP_RESPONSE_LIMIT');
      await bounded.close();
      expect({ sends: base.sends.length, closes, underlyingCloses: base.closes }).toEqual({ sends: 0, closes: 1, underlyingCloses: 1 });
    }
  });

  it('preserves lifecycle, incoming context, session and protocol forwarding', async () => {
    const base = new FakeTransport(); base.sessionId = 'session';
    const bounded = createBoundedMcpTransport(base, { responseMaxBytes: 1024 });
    const extra = { authInfo: { token: 'token', clientId: 'client', scopes: [] } } as unknown as MessageExtraInfo;
    let observed: unknown; bounded.onmessage = (message, context) => { observed = { message, context }; };
    await bounded.start(); bounded.setProtocolVersion?.('v1'); bounded.setSupportedProtocolVersions?.(['v1']);
    base.receive({ jsonrpc: '2.0', method: 'notifications/initialized' }, extra);
    expect(observed).toEqual({ message: { jsonrpc: '2.0', method: 'notifications/initialized' }, context: extra });
    expect({ starts: base.starts, sessionId: bounded.sessionId, perRequest: bounded.hasPerRequestStream,
      versions: base.versions, supported: base.supported }).toEqual({ starts: 1, sessionId: 'session', perRequest: true,
      versions: ['v1'], supported: [['v1']] });
  });

  it('rejects invalid limits and limits too small for the fixed null-id error', () => {
    for (const responseMaxBytes of [0, 1.5, Number.MAX_SAFE_INTEGER + 1, encodedBytes(minimal) - 1]) {
      expect(() => createBoundedMcpTransport(new FakeTransport(), { responseMaxBytes })).toThrow('MCP_RESPONSE_LIMIT_INVALID');
    }
  });
});
