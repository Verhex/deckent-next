import { InMemoryTransport, CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/index.js';
import type { ModelInvocationResult } from '#engine/index.js';
const reference = { providerId: 'p', providerVersion: 1, modelId: 'm', modelVersion: 1 };
const command = { schemaVersion: 1, commandId: 'c', scopeId: 's', reference, catalogRevision: 'catalog',
  expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: 'a'.repeat(64) }, nativeRequest: { prompt: 'test' } };
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
it.each(['2025-11-25', '2026-07-28'])('bounds escaped duplicate model output and exact request ID for SDK codec %s', async version => {
  const maximum = 4096, id = 'request-"\\🎯\ud800'; let suppliedLimit = 0, inner: unknown;
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
    async invokeModel(_command, delivery) {
      expect(delivery).toBeDefined(); suppliedLimit = delivery!.maxResultBytes;
      const atom = '"\\\n🎯\ud800';
      const copies = Math.floor((suppliedLimit - size({ payload: '' })) / (size(atom) - 2));
      inner = { payload: atom.repeat(copies) };
      expect(size(inner)).toBeLessThanOrEqual(suppliedLimit);
      return inner as ModelInvocationResult;
    },
  }, { maxConcurrentCalls: 1, responseMaxBytes: maximum }, 'en');
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const responses: JSONRPCMessage[] = []; client.onmessage = message => { responses.push(message); };
  await server.connect(transport); await client.start();
  const send = async (message: JSONRPCMessage) => {
    await client.send(message);
    await expect.poll(() => responses.length).toBeGreaterThan(0);
    return responses.shift()!;
  };
  try {
    if (version === '2025-11-25') await send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
      protocolVersion: version, capabilities: {}, clientInfo: { name: 'budget-test', version: '1' } } });
    const response = await send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'invoke_model', arguments: command,
      ...(version === '2026-07-28' ? { _meta: { [PROTOCOL_VERSION_META_KEY]: version, [CLIENT_CAPABILITIES_META_KEY]: {} } } : {}) } });
    expect(response).toMatchObject({ id, result: { content: [{ type: 'text', text: JSON.stringify(inner) }], structuredContent: inner } });
    expect(suppliedLimit).toBeGreaterThan(0); expect(size(response) + 1).toBeLessThanOrEqual(maximum);
    expect('result' in response && response.result['isError']).not.toBe(true);
  } finally { await client.close(); await server.close(); }
});
