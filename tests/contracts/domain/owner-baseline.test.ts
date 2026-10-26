import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { aiAuthorityFloor, firstRunPolicyTemplate, mcpPrincipalRef, planOwnerBaseline, resolvePolicyBindings, evaluatePolicy, type OwnerBaselineCell } from '#domain/index.js';
import { ownerBaselineCells, mcpCapabilityRegistry } from '#engine/index.js';

const person = { issuer: 'host', subject: 'alice' };
const template = () => firstRunPolicyTemplate({ scopeId: 's', principal: person, readToolNames: ['read_file'], scratchToolNames: ['scratch_write'],
  scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['write_file'], writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run',
  proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
it('plans only missing person cells, excludes AI floors, preserves custom rules, batches operations and never grants MCP authority administration', () => {
  const files = template();
  const candidates = ownerBaselineCells(mcpCapabilityRegistry.list(), [
    { operation: { id: 'erp.order.post', version: 1 }, surface: 'tool', schemaVersion: 1, approval: 'policy', targetKind: 'order', effectClass: 'write', precondition: 'none', compensation: null, inputMaxBytes: 4096 },
    { operation: { id: 'policy.administer', version: 1 }, surface: 'authority', schemaVersion: 1, approval: 'required', targetKind: 'authority', effectClass: 'write', precondition: 'none', compensation: null, inputMaxBytes: 4096 },
  ] as never);
  const input = { person, explicit: false, scopeId: 's', families: ['mcp-delegable', 'decision-steps'], candidates, peopleLimit: 10, digest };
  const planned = planOwnerBaseline(files.policy, files.bindings, input);
  expect(planned.status).toBe('plan'); expect(planned.added.length).toBeGreaterThan(0);
  expect(planned.added.some(rule => rule.resource.kind === 'run-decision')).toBe(true);
  expect(planned.added.find(rule => rule.resource.kind === 'operation')?.resource.ids).toEqual(['erp.order.post']);
  for (const cell of planned.cells) for (const action of cell.actions) expect(aiAuthorityFloor({ ...mcpPrincipalRef(person), assurance: 'workload-verified' }, { kind: cell.kind, id: 'fixture' }, action)).toBe(false);
  expect(planned.added.some(rule => ['agent-tool', 'agent-tool-call', 'mcp-server'].includes(rule.resource.kind))).toBe(false);
  expect(planOwnerBaseline(planned.policy, files.bindings, input)).toMatchObject({ status: 'current', added: [] });
  const custom = { id: 'custom', effect: 'allow', principals: [person], scopes: ['s'], actions: ['inspect'], resource: { kind: 'run', ids: 'all' } };
  const policy = { ...(planned.policy as object), grants: [...(planned.policy as { grants: unknown[] }).grants, custom] };
  const removed = planOwnerBaseline(policy, files.bindings, { ...input, families: [] });
  expect((removed.policy as { grants: unknown[] }).grants).toEqual([...files.policy.grants, custom]);
  expect(planOwnerBaseline(files.policy, files.bindings, { ...input, person: mcpPrincipalRef(person) })).toMatchObject({ status: 'unavailable' });
  // Full delegated grants still cannot open authority ids: the id-sensitive evaluator floor runs before policy.
  const delegated = resolvePolicyBindings({ ...files.policy, grants: [{ id: 'full', effect: 'allow', principals: [mcpPrincipalRef(person)], scopes: 'all', actions: 'all', resource: { kind: 'operation', ids: 'all' } }] }, files.bindings);
  expect(evaluatePolicy(delegated, { principal: { id: 'ai', ...mcpPrincipalRef(person), assurance: 'workload-verified', scopeIds: ['s'] }, scopeId: 's', action: 'compensate', resource: { kind: 'operation', id: 'policy.administer' } })).toMatchObject({ decision: 'deny', reason: 'AI_NON_DELEGABLE' });
  const many: OwnerBaselineCell[] = Array.from({ length: 40 }, (_, index) => ({ family: 'mcp-delegable', kind: 'operation', actions: ['execute'], ids: [`erp.${index}`], scope: 'selected' }));
  expect(planOwnerBaseline(files.policy, files.bindings, { ...input, families: ['mcp-delegable'], candidates: many })).toMatchObject({ remaining: 8, added: expect.any(Array) });
});
