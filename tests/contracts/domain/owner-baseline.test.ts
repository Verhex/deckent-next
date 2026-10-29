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
it('E-05: hub-read/hub-trust write only the person\'s exact scope cells (not MCP-filtered); an AI never holds a source change; publish/yank/revoke stay out', () => {
  const files = template(), candidates = ownerBaselineCells(mcpCapabilityRegistry.list(), []);
  const input = { person, explicit: false, scopeId: 's', families: ['hub-read', 'hub-trust'], candidates, peopleLimit: 10, digest };
  const planned = planOwnerBaseline(files.policy, files.bindings, input);
  expect(planned.status).toBe('plan');
  expect(planned.added.map(rule => [rule.resource.kind, rule.actions, rule.resource.ids, rule.scopes, rule.principals])).toEqual([
    ['hub', ['inspect', 'search', 'export'], ['s'], ['s'], [person]],
    ['hub', ['sources.add', 'sources.remove', 'refresh', 'install', 'update', 'uninstall'], ['s'], ['s'], [person]]]);
  expect(planOwnerBaseline(planned.policy, files.bindings, input)).toMatchObject({ status: 'current' });
  const after = resolvePolicyBindings(planned.policy, files.bindings), ask = (principal: Record<string, unknown>, action: string) =>
    evaluatePolicy(after, { principal: { id: 'p', scopeIds: ['s'], ...principal } as never, scopeId: 's', action, resource: { kind: 'hub', id: 's' } }).decision;
  expect(ask({ ...person, assurance: 'os-user' }, 'sources.add')).toBe('allow');
  expect(ask({ ...person, assurance: 'os-user' }, 'publish')).toBe('deny');
  // Even an explicit full hub grant to the MCP actor cannot pin or drop a source: the floor runs before policy.
  const mcp = mcpPrincipalRef(person), delegated = resolvePolicyBindings({ ...files.policy, grants: [{ id: 'mcp-hub', effect: 'allow', principals: [mcp], scopes: 'all', actions: 'all', resource: { kind: 'hub', ids: 'all' } }] }, files.bindings);
  for (const action of ['sources.add', 'sources.remove']) expect(evaluatePolicy(delegated, { principal: { id: 'ai', ...mcp, assurance: 'workload-verified', scopeIds: ['s'] }, scopeId: 's', action, resource: { kind: 'hub', id: 's' } }).decision).toBe('deny');
  expect(planOwnerBaseline(files.policy, files.bindings, { ...input, person: mcp })).toMatchObject({ status: 'unavailable' });
});
