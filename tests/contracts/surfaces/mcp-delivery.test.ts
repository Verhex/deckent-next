import { InMemoryTransport, CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { appendFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import type { ModelInvocationResult } from '#engine/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { pendingBrainFixture } from '../support/brain-proposal.js';
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

it('keeps the package review refusal reason in a 512-byte create_run answer in EN and TR', async () => {
  const general = 'NATIVE_WORKER_DEPENDENCIES_REFUSED', specific = 'NATIVE_WORKER_PACKAGE_REVIEW_OVER_LIMIT';
  const pending = pendingBrainFixture(), proposal = { ...pending.proposal.proposal };
  const rejected = { ...pending, proposal: { ...pending.proposal, status: 'rejected', reason: specific, approval: null }, reasonParams: { preview: 'over-limit' } };
  const { scopeId, commandId, runId, graph } = proposal;
  const query = { schemaVersion: 1, scopeId, commandId, runId };
  for (const locale of ['en', 'tr'] as const) {
    for (const maximum of [512, 4096]) {
      let overLimit = true;
      const server = createMcpServer({ async createRun() { throw ErrorRegistry.createError(general, overLimit ? { params: { preview: 'over-limit' } } : {}); },
        async proposeRun() { return rejected; }, async planRun() { return rejected; }, async inspectRunProposal() { return rejected; } },
      { maxConcurrentCalls: 1, responseMaxBytes: maximum }, locale);
      const [client, transport] = InMemoryTransport.createLinkedPair();
      const responses: JSONRPCMessage[] = []; client.onmessage = message => { responses.push(message); };
      await server.connect(transport); await client.start();
      const call = async (name: string, args: Record<string, unknown>) => {
        await client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args,
          _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} } } });
        await expect.poll(() => responses.length).toBe(1);
        const response = responses.shift()!;
        if (process.env.DECKENT_L1_FRAME_PROOF) appendFileSync(process.env.DECKENT_L1_FRAME_PROOF,
          `${locale} ${maximum} ${name}${overLimit ? '' : ' generic'} ${size(response) + 1} bytes ${JSON.stringify(response)}\n`);
        expect(size(response) + 1).toBeLessThanOrEqual(maximum);
        expect(response).toHaveProperty('result');
        return 'result' in response ? response.result : {};
      };
      try {
        const create = await call('create_run', { ...query, graph });
        const message = ErrorRegistry.createError(specific, { locale }).message;
        const coded = (code: string, text?: string) => ({ isError: true,
          content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, code, ...(text ? { message: text } : {}) }) }] });
        expect.soft(create).toMatchObject(maximum === 512 ? coded(specific) : coded(general, message));
        for (const [name, args] of [['plan_run', { schemaVersion: 1, scopeId, commandId, intent: 'Review packages' }],
          ['propose_run', proposal], ['inspect_run_proposal', query]] as const) {
          const result = await call(name, args);
          expect(result).toMatchObject(maximum === 512 ? coded(specific) : { structuredContent: rejected });
          if (maximum > 512) expect(result['content']).toContainEqual({ type: 'text', text: message });
        }
        overLimit = false;
        expect(await call('create_run', { ...query, graph })).toMatchObject(coded(general, ErrorRegistry.createError(general, { locale }).message));
      } finally { await client.close(); await server.close(); }
    }
  }
}, 15_000);
