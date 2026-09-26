import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { createMcpServer, type McpApplications } from '#surfaces/index.js';

/** D03-mcp-idempotent (D-3): each tool's idempotentHint must follow real replay/effect evidence
 * (engine/adapters commandId-keyed receipts, or an identity-keyed dispatch guard), never a blanket
 * true. This table is the exact per-tool contract; file:line evidence for each row lives in
 * proof/D03-MCP-IDEMPOTENT-2026-09-27/review.md. A tool present in the real server but missing here,
 * or vice versa, must fail this test (name-set assertion below). */
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
  request_run_cancellation: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  deliver_run_cancellation: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  reconcile_attempt: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  execute_task: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  evaluate_task: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  runtime_service_descriptor: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  shutdown_runtime_service: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inspect_model_activation: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  admit_model_activation: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inspect_model_invocation: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inspect_provider_spending: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  audit_provider_spending: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  invoke_model: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  purge_model_invocation_content: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  cancel_model_invocation: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inference_plan: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inference_budget: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
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
} as unknown as McpApplications;
async function listAnnotatedTools() {
  const server = createMcpServer(applications, { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-annotations-test', version: '1' });
  await client.connect(clientTransport);
  try { return (await client.listTools()).tools; }
  finally { await client.close(); await server.close(); }
}
it('advertises exactly the 30 contracted tools, no more and no fewer', async () => {
  const tools = await listAnnotatedTools();
  expect(new Set(tools.map(tool => tool.name))).toEqual(new Set(Object.keys(EXPECTED)));
});
it.each(Object.entries(EXPECTED))('reports the evidenced annotations for %s', async (name, expected) => {
  const tools = await listAnnotatedTools();
  const tool = tools.find(value => value.name === name);
  expect(tool?.annotations).toEqual(expected);
});
it('never advertises idempotentHint true for a destructive (irreversible-effect) tool', async () => {
  const tools = await listAnnotatedTools();
  const offenders = tools.filter(tool => tool.annotations?.destructiveHint === true && tool.annotations?.idempotentHint === true).map(tool => tool.name);
  expect(offenders).toEqual([]);
});
