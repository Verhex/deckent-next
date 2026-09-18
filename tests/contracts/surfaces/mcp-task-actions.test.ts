import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/index.js';

const connected: { client: Client; close(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(connected.splice(0).map(value => value.close())); });
const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', generation: 1, layoutRevision: 'layout' };
async function fixture(include = true) {
  const calls: unknown[] = [];
  const applications = { async inspectRun() { return null; }, async inspectInventory() { return { entries: [] }; },
    ...(include ? {
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
  const f = await fixture(); const tools = (await f.client.listTools()).tools;
  const execute = tools.find(tool => tool.name === 'execute_task')!; const evaluate = tools.find(tool => tool.name === 'evaluate_task')!;
  expect(execute.inputSchema.required).toEqual(expect.arrayContaining(['runId', 'taskId', 'attemptId', 'scopeId', 'generation', 'layoutRevision']));
  expect(evaluate.inputSchema.required).toEqual(expect.arrayContaining(['schemaVersion', 'commandId', 'identity', 'expectedRevision']));
  expect(execute.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
  expect(evaluate.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  expect(execute.description).toContain('pinned task profile'); expect(evaluate.description).toContain('never supply a verdict');
});

it('forwards only parsed identities and evaluation commands and rejects argv or verdict injection', async () => {
  const f = await fixture();
  const executed = await f.client.callTool({ name: 'execute_task', arguments: identity });
  expect(executed.isError).not.toBe(true); expect(executed.structuredContent).toEqual({ execution: { status: 'terminal' } });
  const command = { schemaVersion: 1, commandId: 'evaluation', identity, expectedRevision: 2 };
  const evaluated = await f.client.callTool({ name: 'evaluate_task', arguments: command });
  expect(evaluated.isError).not.toBe(true); expect(evaluated.structuredContent).toEqual({ evaluation: { phase: 'accepted' } });
  expect(f.calls).toEqual([{ execute: identity }, { evaluate: command }]);
  expect(JSON.stringify(await f.client.callTool({ name: 'execute_task', arguments: { ...identity, argv: ['caller-command'] } }))).toContain('MCP_INPUT_INVALID');
  expect(JSON.stringify(await f.client.callTool({ name: 'evaluate_task', arguments: { ...command, verdict: 'pass' } }))).toContain('MCP_INPUT_INVALID');
  expect(f.calls).toHaveLength(2);
});
