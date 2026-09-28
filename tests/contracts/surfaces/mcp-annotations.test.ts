import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { createMcpServer, type McpApplications } from '#surfaces/core/mcp/index.js';

/** D03-mcp-idempotent (D-3): each tool's idempotentHint must follow real replay/effect evidence
 * (engine/adapters commandId-keyed receipts, or an identity-keyed dispatch guard). destructiveHint and
 * idempotentHint are independent MCP annotations: a destructive tool can still be idempotent when a
 * durable commandId (or identity) replay returns the prior result without a second effect — four
 * destructive tools here (`request_run_cancellation`, `execute_task`, `admit_model_activation`,
 * `invoke_model`) have exactly that evidence, cited file:line at their definitions in server.ts and in
 * proof/D03-MCP-IDEMPOTENT-2026-09-27/review.md. This table is the exact per-tool contract: every row's
 * full annotation set is asserted below, so a tool whose hint diverges from its row, or a tool missing
 * from (or extra to) this table, fails the test. */
type Annotations = Readonly<{ readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }>;
const EXPECTED: Readonly<Record<string, Annotations>> = Object.freeze({
  inspect_run: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inspect_inventory: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  policy_vocabulary: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  renew_approval: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_approvals: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inspect_approval: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  decide_approval: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_declared_models: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inspect_model_binding: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inspect_toolchain_currency: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  update_toolchains: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  create_run: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  reserve_run_tasks: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  request_run_cancellation: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  deliver_run_cancellation: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  reconcile_attempt: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  execute_task: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  evaluate_task: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  runtime_service_descriptor: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  shutdown_runtime_service: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inspect_model_activation: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  admit_model_activation: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  inspect_model_invocation: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inspect_provider_spending: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  audit_provider_spending: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  invoke_model: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  purge_model_invocation_content: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  cancel_model_invocation: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inference_plan: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inference_budget: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // C12 G4: derived from the fixture catalog below (write operations with a write compensation), not fixed per tool.
  execute_operation: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  compensate_operation: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  inspect_operation: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
const ref = (id: string) => ({ id, version: 1 });
const descriptor = (id: string, effectClass: 'read' | 'write' | 'irreversible', compensation: string | null = null) => Object.freeze({ schemaVersion: 1 as const,
  operation: ref(id), targetKind: 'records', effectClass, approval: effectClass === 'irreversible' ? 'required' as const : 'policy' as const,
  precondition: 'none' as const, compensation: compensation ? ref(compensation) : null, inputMaxBytes: 4096 });
const writeCatalog = [descriptor('post-order', 'write', 'cancel-order'), descriptor('cancel-order', 'write')];
const noop = async () => ({});
// Every optional application handler is supplied so the real server advertises all 30 tools; only
// tools/list is exercised here, so stub bodies never execute a real effect.
const applications: McpApplications = {
  renewApproval: noop, listApprovals: noop, inspectApproval: noop, decideApproval: noop,
  inspectModelActivation: noop, admitModelActivation: noop, inspectModelInvocation: noop, invokeModel: noop,
  purgeModelInvocationContent: noop, cancelModelInvocation: noop, inspectProviderSpendAccount: noop,
  auditProviderSpendAccount: noop, inspectDeclaredModels: noop, inspectModelBinding: noop, inspectToolchainCurrency: noop,
  updateToolchains: noop, createRun: noop, reserveRunTasks: noop, executeTask: noop, evaluateTask: noop,
  reconcileAttempt: noop, deliverRunCancellation: noop, requestRunCancellation: noop,
  async inspectRun() { return {}; }, async inspectInventory() { return {}; },
  describeService: noop, shutdownService: noop, inferencePlan: noop, inferenceBudget: noop,
  executeOperation: noop, compensateOperation: noop, inspectOperation: noop, operationCatalog: writeCatalog,
} as unknown as McpApplications;
async function listAnnotatedTools(overrides: Partial<McpApplications> = {}) {
  const server = createMcpServer({ ...applications, ...overrides }, { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-annotations-test', version: '1' });
  await client.connect(clientTransport);
  try { return (await client.listTools()).tools; }
  finally { await client.close(); await server.close(); }
}
it('advertises exactly the 33 contracted tools, no more and no fewer', async () => {
  const tools = await listAnnotatedTools();
  expect(new Set(tools.map(tool => tool.name))).toEqual(new Set(Object.keys(EXPECTED)));
});
it.each(Object.entries(EXPECTED))('reports the evidenced annotations for %s', async (name, expected) => {
  const tools = await listAnnotatedTools();
  const tool = tools.find(value => value.name === name);
  expect(tool?.annotations).toEqual(expected);
});

const hints = async (operationCatalog: McpApplications['operationCatalog']) => Object.fromEntries((await listAnnotatedTools({ operationCatalog }))
  .filter(tool => tool.name.endsWith('_operation')).map(tool => [tool.name, tool.annotations]));
it('derives the operation tool hints from the catalog descriptors: read-only, destructive and open-world follow the effect classes (C12 G4)', async () => {
  // Compensation is bounded by the whole reachable catalog (Astra 2139 R2): the compensating operation resolves from the current
  // catalog while the pairing comes from the original's pinned historical descriptor, so any reachable operation may be a compensation
  // even when no current descriptor names it. Only read operations: neither tool can change a target, both reach one.
  expect(await hints([descriptor('read-order', 'read')])).toEqual({
    execute_operation: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    compensate_operation: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inspect_operation: EXPECTED.inspect_operation });
  // One irreversible operation among reads makes both destructive, although no current descriptor names a compensation.
  expect(await hints([descriptor('read-order', 'read'), descriptor('approve-payment', 'irreversible')])).toMatchObject({
    execute_operation: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    compensate_operation: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } });
  // A read compensation of a write: the write itself may be a historically pinned compensation, so compensating is not read-only.
  expect(await hints([descriptor('post-order', 'write', 'recheck-order'), descriptor('recheck-order', 'read')])).toMatchObject({
    execute_operation: { readOnlyHint: false, destructiveHint: true }, compensate_operation: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } });
  // No reachable operation: the tools can change nothing and reach nothing.
  expect(await hints([])).toEqual({
    execute_operation: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    compensate_operation: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inspect_operation: EXPECTED.inspect_operation });
  // Without the operation handlers the tools are not advertised (mutators only when composition supplies them).
  const bare = await listAnnotatedTools({ executeOperation: undefined, compensateOperation: undefined, inspectOperation: undefined });
  expect(bare.some(tool => tool.name.endsWith('_operation'))).toBe(false);
});
