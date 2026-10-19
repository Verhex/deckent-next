import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createMcpServer, type McpApplications } from '#surfaces/core/mcp/index.js';

/**
 * ZOD4-PREP step 1 (owner 2026-09-29, zod4-migration-plan.md §1.3): the `tools/list` inputSchema every Deckent MCP tool publishes
 * today — `zodToJsonSchema(schema, { $refStrategy: 'none' })` from zod-to-json-schema 3.25.0 over zod 3.25.76, JSON Schema draft-07.
 * No tool publishes an outputSchema today (pinned below). The migration (plan step 5) DELIBERATELY moves to
 * `z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' })` (https://zod.dev/json-schema, read 2026-09-29; MCP 2026-07-28
 * recommends 2020-12): the committed fixture below is the reviewed diff of that change — refresh it only with
 * `vitest run <this file> -u` in the migration commit and review every tool's delta (dialect URI, exclusiveMinimum form, `required`
 * for `z.unknown()` keys, `additionalProperties`, union/`anyOf` shape). Descriptions are localized strings and stay out of the fixture.
 * Stub handlers: every optional application is supplied so the real server advertises all tools; only tools/list runs.
 */
const ref = (id: string) => ({ id, version: 1 });
const descriptor = (id: string, compensation: string | null = null) => Object.freeze({ schemaVersion: 1 as const, operation: ref(id), targetKind: 'records',
  effectClass: 'write' as const, approval: 'policy' as const, precondition: 'none' as const, compensation: compensation ? ref(compensation) : null, inputMaxBytes: 4096 });
const noop = async () => ({});
const applications = {
  renewApproval: noop, listApprovals: noop, inspectApproval: noop,
  inspectModelActivation: noop, admitModelActivation: noop, inspectModelInvocation: noop, invokeModel: noop,
  purgeModelInvocationContent: noop, cancelModelInvocation: noop, inspectProviderSpendAccount: noop,
  auditProviderSpendAccount: noop, inspectDeclaredModels: noop, inspectModelBinding: noop, inspectToolchainCurrency: noop,
  updateToolchains: noop, proposeRun: noop, createRun: noop, reserveRunTasks: noop, executeTask: noop, evaluateTask: noop,
  reconcileAttempt: noop, deliverRunCancellation: noop, requestRunCancellation: noop, inspectRun: noop, inspectInventory: noop,
  describeService: noop, shutdownService: noop, inferencePlan: noop, inferenceBudget: noop,
  executeOperation: noop, compensateOperation: noop, inspectOperation: noop, operationCatalog: [descriptor('post-order', 'cancel-order'), descriptor('cancel-order')],
} as unknown as McpApplications;
async function listTools() {
  const server = createMcpServer(applications, { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-wire-schema-test', version: '1' });
  await client.connect(clientTransport);
  try { return (await client.listTools()).tools; } finally { await client.close(); await server.close(); }
}

describe('MCP tool wire schema (zod 4 / JSON Schema dialect guard)', () => {
  it('every tool inputSchema equals the committed draft-07 golden (one line per tool, advertised order)', async () => {
    const tools = await listTools();
    const lines = tools.map(tool => JSON.stringify({ name: tool.name, inputSchema: tool.inputSchema }));
    await expect(`[\n${lines.join(',\n')}\n]\n`).toMatchFileSnapshot('../../fixtures/mcp-wire/tool-input-schemas.json');
  });

  it('dialect and root shape are explicit: draft-07 URI, object root, no outputSchema', async () => {
    const tools = await listTools();
    expect(tools).toHaveLength(33);
    for (const tool of tools) {
      expect(tool.inputSchema['$schema'], tool.name).toBe('http://json-schema.org/draft-07/schema#');
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.outputSchema, tool.name).toBeUndefined();
    }
  });

  // Forms a z.toJSONSchema(draft-2020-12, io: input) conversion rewrites (observed zod-to-json-schema 3.25.0 vs zod 4.6.5,
  // proof/ZOD4-PREP-2026-09-29/logs/jsonschema-v3-vs-v4.jsonl): `.nonnegative().safe()` advertises minimum -2^53+1 today (4.6.5: 0),
  // and a `z.unknown()` key is optional today (4.6.5 lists it in `required`, matching v4 ≥ 4.4 parse-time behaviour).
  it('today\'s draft-07 forms that a 2020-12 conversion rewrites are pinned explicitly', async () => {
    const tools = new Map((await listTools()).map(tool => [tool.name, tool.inputSchema as { properties: Record<string, unknown>; required?: string[]; additionalProperties?: unknown }]));
    expect(tools.get('inspect_run')!.additionalProperties).toBe(false);
    expect(tools.get('inspect_inventory')!.properties['limit']).toEqual({ type: 'integer', exclusiveMinimum: 0, maximum: 2_147_483_646 });
    expect(tools.get('renew_approval')!.properties['expectedRevision']).toEqual({ type: 'integer', minimum: -9_007_199_254_740_991, maximum: 9_007_199_254_740_991 });
    const execute = tools.get('execute_operation')!;
    expect(execute.properties['input']).toEqual({});
    expect(execute.required).toEqual(['schemaVersion', 'commandId', 'scopeId', 'operation', 'target', 'idempotencyKey', 'expectedVersion']);
  });

  it('wire parse agrees with the advertised schema: execute_operation without `input` is admitted, an unknown key is MCP_INPUT_INVALID', async () => {
    const received: unknown[] = [];
    const server = createMcpServer({ ...applications, executeOperation: async (command: unknown) => { received.push(command); return {}; } } as McpApplications,
      { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'mcp-wire-schema-call', version: '1' });
    await client.connect(clientTransport);
    try {
      const command = { schemaVersion: 1, commandId: 'c', scopeId: 's', operation: ref('post-order'), target: { kind: 'records', id: 'r' }, idempotencyKey: 'k', expectedVersion: null };
      expect((await client.callTool({ name: 'execute_operation', arguments: command })).isError).toBeFalsy();
      expect(received).toEqual([command]);
      expect(Object.hasOwn(received[0] as object, 'input')).toBe(false);
      expect(JSON.stringify(await client.callTool({ name: 'execute_operation', arguments: { ...command, extra: 1 } }))).toContain('MCP_INPUT_INVALID');
      expect(received).toHaveLength(1);
    } finally { await client.close(); await server.close(); }
  });

  // D2b (lead 2026-10-18): MCP is an AI actor and never carries a Run delivery intent. Every optional application is supplied (a proxy), so
  // every tool the server can advertise is checked, not only the golden's set.
  it('no MCP tool advertises a delivery intent (`delivery` or `deliveryIntent`) anywhere in its inputSchema', async () => {
    const every = new Proxy({} as Record<string, unknown>, { get: (_, key) => key === 'operationCatalog' ? applications.operationCatalog : noop }) as unknown as McpApplications;
    const server = createMcpServer(every, { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'mcp-wire-schema-all', version: '1' });
    await client.connect(clientTransport);
    try {
      const tools = (await client.listTools()).tools, keys = (value: unknown): string[] => value && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)]) : [];
      expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['propose_run', 'plan_run', 'list_delivery_queue', 'inspect_delivery_queue', 'create_run']));
      for (const tool of tools) for (const key of ['delivery', 'deliveryIntent']) expect(keys(tool.inputSchema), tool.name).not.toContain(key);
    } finally { await client.close(); await server.close(); }
  });

  it('an MCP propose_run carrying `delivery` is MCP_INPUT_INVALID and reaches no application (nothing recorded); without it the same proposal does', async () => {
    const received: unknown[] = [];
    const server = createMcpServer({ ...applications, proposeRun: async (command: unknown) => { received.push(command); return {}; } } as McpApplications,
      { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'mcp-propose-delivery', version: '1' });
    await client.connect(clientTransport);
    try {
      const proposal = { schemaVersion: 1, commandId: 'propose', proposalId: 'plan', scopeId: 's', runId: 'r', proposer: { id: 'mcp', issuer: 'mcp', subject: 'mcp' },
        source: { kind: 'human' }, budgetCeiling: { currency: 'USD', limitMinorUnits: 1 }, requiredPermissions: [],
        graph: { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'k', dependencies: [], acceptanceCriteria: ['c'] }],
          criterionDefinitions: [{ id: 'c', version: 1, description: 'd', evaluator: { id: 'e', version: 1 }, parameters: {} }] } };
      const refused = await client.callTool({ name: 'propose_run', arguments: { ...proposal, delivery: { target: { kind: 'git-ref', id: 'refs/heads/main' }, mode: 'enqueue-accepted' } } });
      expect(refused.isError).toBe(true); expect(JSON.stringify(refused)).toContain('MCP_INPUT_INVALID');
      expect(received).toEqual([]);
      expect((await client.callTool({ name: 'propose_run', arguments: proposal })).isError).toBeFalsy();
      expect(received).toEqual([proposal]);
    } finally { await client.close(); await server.close(); }
  });
});
