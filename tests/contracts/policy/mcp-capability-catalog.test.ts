import { describe, expect, it } from 'vitest';
import { authorityDocuments, firstRunPolicyTemplate, installationOwnerPermissions, getPolicyVocabulary, resolvePolicyBindings, type VerifiedPrincipal } from '#domain/index.js';
import { McpCapabilities, McpCapabilityRegistry, mcpCapabilityRegistry } from '#engine/index.js';

const actor: VerifiedPrincipal = { id: 'owner', issuer: 'host', subject: 'user', assurance: 'os-user', scopeIds: ['scope'] };
function policy() {
  const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: actor, readToolNames: ['read_file'], scratchToolNames: ['scratch_write'],
    scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['write_file'], writeOperationId: 'workspace.file.write',
    shellOperationId: 'host.shell.run', proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' });
  return resolvePolicyBindings({ ...template.policy, roles: [{ id: 'owner', permissions: installationOwnerPermissions(getPolicyVocabulary().resources.map(resource => resource.kind)) }] },
    { ...template.bindings, bindings: [{ id: 'owner', principals: [{ issuer: actor.issuer, subject: actor.subject }], roles: ['owner'], scopes: 'all' }] });
}
const refused = ['inspect_decision', 'renew_approval', 'create_run', 'reserve_run_tasks', 'request_run_cancellation', 'deliver_run_cancellation', 'reconcile_attempt', 'execute_task',
  'evaluate_task', 'shutdown_runtime_service', 'admit_model_activation', 'apply_model_catalog', 'connect_model', 'apply_pool_capacity', 'inspect_pool_capacity', 'inspect_pool_hold',
  'apply_pool_hold', 'manage_provider_spending', 'audit_provider_spending', 'invoke_model', 'purge_model_invocation_content', 'cancel_model_invocation', 'execute_operation', 'compensate_operation', 'inspect_operation'];

describe('MCP capability catalog and governed preview contract', () => {
  it('covers each refused tool with explicit action/resource/scope requirements and has no approval decision cell', () => {
    const cells = mcpCapabilityRegistry.list().flatMap(group => group.cells);
    for (const tool of refused) expect(cells.filter(cell => Object.hasOwn(cell.tools, tool)), tool).not.toHaveLength(0);
    expect(cells.some(cell => cell.resource.kind === 'approval' && cell.actions.includes('decide'))).toBe(false);
    expect(mcpCapabilityRegistry.get('dogfood-worker').proposed).toBe(true);
    expect(mcpCapabilityRegistry.get('dogfood-worker').cells.every(cell => ['run', 'attempt', 'pool', 'work-target'].includes(cell.resource.kind))).toBe(true);
  });
  it('Enterprise adds a namespaced immutable group through the registry; duplicate, Core override and late registration refuse', () => {
    const registry = new McpCapabilityRegistry(mcpCapabilityRegistry.list()), core = mcpCapabilityRegistry.get('service');
    const extension = { ...core, id: 'enterprise.erp', cells: core.cells.map(cell => ({ ...cell, actions: [...cell.actions] })) };
    registry.register(extension); extension.cells[0]!.actions.push('unsafe');
    expect(registry.get('enterprise.erp').cells[0]!.actions).toEqual(['shutdown']);
    expect(() => registry.register(extension)).toThrow('REGISTRY_MANIFEST_INVALID');
    expect(() => registry.register(core)).toThrow('REGISTRY_NAMESPACE_RESERVED');
    expect(() => registry.register({ ...core, id: 'enterprise.erp' })).toThrow('REGISTRY_ADAPTER_DUPLICATE');
    registry.seal(); expect(() => registry.register({ ...core, id: 'enterprise.other' })).toThrow('REGISTRY_SEALED');
  });
  it('digest changes with scope, action, catalog version and policy revision; apply submits the exact preview through one operation', async () => {
    let document = policy(), submits = 0, input: unknown;
    const deps = { policy: { async load() { return document; } }, administration: { async submit(command: unknown) { submits++; input = command;
      return { status: 'settled' as const } as never; } }, approve: async () => { throw new Error('unexpected'); } };
    const app = new McpCapabilities(deps), request = { scopeId: 'scope', groupId: 'spend', action: 'grant' as const, mode: 'preview' as const };
    const first = await app.run(request, actor, ''); expect(submits).toBe(0);
    expect((await app.run({ ...request, scopeId: 'other' }, { ...actor, scopeIds: ['scope', 'other'] }, '')).digest).not.toBe(first.digest);
    expect((await app.run({ ...request, action: 'revoke' }, actor, '')).digest).not.toBe(first.digest);
    const registry = new McpCapabilityRegistry([{ ...mcpCapabilityRegistry.get('spend'), version: 2 }]);
    expect((await new McpCapabilities(deps, registry).run(request, actor, '')).digest).not.toBe(first.digest);
    expect(await app.run({ ...request, mode: 'apply', expect: 'wrong' }, actor, '')).toMatchObject({ status: 'conflict' }); expect(submits).toBe(0);
    const applied = await app.run({ ...request, mode: 'apply', expect: first.digest }, actor, 'selected');
    expect(applied.digest).toBe(first.digest); expect(submits).toBe(1);
    expect(input).toMatchObject({ operation: { id: 'policy.administer', version: 1 }, expectedVersion: first.revision, input: first.change });
    const files = authorityDocuments(policy());
    document = resolvePolicyBindings({ ...files.policy, revision: 'changed' }, files.bindings);
    expect((await app.run(request, actor, '')).digest).not.toBe(first.digest);
  });
  it('company deny precedence and global cells remain visible, while the MCP actor cannot administer the catalog', async () => {
    const current = policy(); if (current.schemaVersion !== 2) throw Error('fixture');
    const document = { ...current, restrictions: [{ id: 'deny-spending', principals: 'all' as const, scopes: ['scope'], actions: ['budget-revision'], resource: { kind: 'provider-spend-account', ids: 'all' as const } }] };
    const app = new McpCapabilities({ policy: { async load() { return document; } }, administration: { submit: async () => { throw Error('unexpected'); } }, approve: async () => { throw Error('unexpected'); } });
    expect(await app.run({ scopeId: 'scope', groupId: 'spend', action: 'grant', mode: 'preview' }, actor, '')).toMatchObject({ missing: ['delegation'] });
    const pools = await app.run({ scopeId: 'scope', groupId: 'pools', action: 'grant', mode: 'preview' }, actor, '');
    expect(pools.rules.find(rule => rule.actions !== 'all' && rule.actions.includes('hold'))?.scopes).toBe('all');
    await expect(app.inspect('scope', { ...actor, issuer: 'host/mcp' })).rejects.toThrow('MCP_CAPABILITY_OWNER_REQUIRED');
  });
});
