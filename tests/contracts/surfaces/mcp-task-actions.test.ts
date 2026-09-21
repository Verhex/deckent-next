import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/index.js';

const connected: { client: Client; close(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(connected.splice(0).map(value => value.close())); });
const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', generation: 1, layoutRevision: 'layout' };
const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'custom', dependencies: [], acceptanceCriteria: ['evidence'] }],
  criterionDefinitions: [{ id: 'evidence', version: 1, description: 'Verify evidence', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
async function fixture(include = true) {
  const calls: unknown[] = [];
  const applications = { async inspectRun() { return null; }, async inspectInventory() { return { entries: [] }; },
    ...(include ? {
      async createRun(input: unknown) { calls.push({ create: input }); return { run: { runId: 'r' } }; },
      async reserveRunTasks(input: unknown) { calls.push({ reserve: input }); return { identities: [identity] }; },
      async executeTask(input: unknown) { calls.push({ execute: input }); return { execution: { status: 'terminal' } }; },
      async evaluateTask(input: unknown) { calls.push({ evaluate: input }); return { evaluation: { phase: 'accepted' } }; },
    } : {}),
  };
  const server = createMcpServer(applications, { maxConcurrentCalls: 2, responseMaxBytes: 4096 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'task-actions-test', version: '1' }); await client.connect(clientTransport);
  connected.push({ client, async close() { await client.close(); await server.close(); } });
  return { client, calls };
}

it('advertises task actions only when injected with strict schemas and conservative annotations', async () => {
  const absent = await fixture(false); const absentNames = (await absent.client.listTools()).tools.map(tool => tool.name);
  expect(absentNames).not.toContain('execute_task'); expect(absentNames).not.toContain('evaluate_task');
  expect(absentNames).not.toContain('create_run'); expect(absentNames).not.toContain('reserve_run_tasks');
  const f = await fixture(); const tools = (await f.client.listTools()).tools;
  const create = tools.find(tool => tool.name === 'create_run')!; const reserve = tools.find(tool => tool.name === 'reserve_run_tasks')!;
  const execute = tools.find(tool => tool.name === 'execute_task')!; const evaluate = tools.find(tool => tool.name === 'evaluate_task')!;
  expect(create.inputSchema.required).toEqual(expect.arrayContaining(['schemaVersion', 'commandId', 'scopeId', 'runId', 'graph']));
  expect(reserve.inputSchema.required).toEqual(expect.arrayContaining(['schemaVersion', 'commandId', 'scopeId', 'runId', 'expectedRevision']));
  expect(execute.inputSchema.required).toEqual(expect.arrayContaining(['runId', 'taskId', 'attemptId', 'scopeId', 'generation', 'layoutRevision']));
  expect(evaluate.inputSchema.required).toEqual(expect.arrayContaining(['schemaVersion', 'commandId', 'identity', 'expectedRevision']));
  expect(execute.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
  expect(evaluate.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  expect(create.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  expect(reserve.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  expect(execute.description).toContain('pinned task profile'); expect(evaluate.description).toContain('never supply a verdict');
});

it('forwards only parsed identities and evaluation commands and rejects argv or verdict injection', async () => {
  const f = await fixture();
  const create = { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r', graph };
  const created = await f.client.callTool({ name: 'create_run', arguments: create });
  expect(created.isError).not.toBe(true); expect(created.structuredContent).toEqual({ run: { runId: 'r' } });
  const reserve = { schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r', expectedRevision: 0 };
  const reserved = await f.client.callTool({ name: 'reserve_run_tasks', arguments: reserve });
  expect(reserved.isError).not.toBe(true); expect(reserved.structuredContent).toEqual({ identities: [identity] });
  const executed = await f.client.callTool({ name: 'execute_task', arguments: identity });
  expect(executed.isError).not.toBe(true); expect(executed.structuredContent).toEqual({ execution: { status: 'terminal' } });
  const command = { schemaVersion: 1, commandId: 'evaluation', identity, expectedRevision: 2 };
  const evaluated = await f.client.callTool({ name: 'evaluate_task', arguments: command });
  expect(evaluated.isError).not.toBe(true); expect(evaluated.structuredContent).toEqual({ evaluation: { phase: 'accepted' } });
  expect(f.calls).toEqual([{ create }, { reserve }, { execute: identity }, { evaluate: command }]);
  expect(JSON.stringify(await f.client.callTool({ name: 'create_run', arguments: { ...create, layoutRevision: 'caller' } }))).toContain('MCP_INPUT_INVALID');
  expect(JSON.stringify(await f.client.callTool({ name: 'reserve_run_tasks', arguments: { ...reserve, taskIds: ['t'], attemptId: 'caller' } }))).toContain('MCP_INPUT_INVALID');
  expect(JSON.stringify(await f.client.callTool({ name: 'execute_task', arguments: { ...identity, argv: ['caller-command'] } }))).toContain('MCP_INPUT_INVALID');
  expect(JSON.stringify(await f.client.callTool({ name: 'evaluate_task', arguments: { ...command, verdict: 'pass' } }))).toContain('MCP_INPUT_INVALID');
  expect(f.calls).toHaveLength(4);
});

it('advertises and forwards the versioned admission branch without accepting a caller-selected verdict', async () => {
  const f = await fixture();
  const branch = { schemaVersion: 1, input: { id: 'fact', revision: '1', value: true }, whenTrue: 'a', whenFalse: 'b', join: 'join' };
  const command = { schemaVersion: 1, commandId: 'conditional', scopeId: 's', runId: 'r', graph, branch };
  expect((await f.client.callTool({ name: 'create_run', arguments: command })).isError).not.toBe(true);
  expect(f.calls).toEqual([{ create: command }]);
  expect(JSON.stringify(await f.client.callTool({ name: 'create_run', arguments: { ...command, branch: { ...branch, selectedTaskId: 'a' } } }))).toContain('MCP_INPUT_INVALID');
  expect(f.calls).toHaveLength(1);
});
