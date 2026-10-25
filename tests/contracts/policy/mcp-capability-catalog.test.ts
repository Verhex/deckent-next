import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createMcpServer, MCP_UNGROUPED_WRITE_TOOLS, MCP_WITHHELD_TOOLS, type McpApplications } from '#surfaces/core/mcp/index.js';
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

/** The advertised inventory of the real server with every application handler supplied (a handler for any name, plus one write catalog
 * operation), so a tool added to the server is covered without editing this test. */
async function advertisedTools() {
  const operation = { schemaVersion: 1 as const, operation: { id: 'post-order', version: 1 }, targetKind: 'records', effectClass: 'write' as const,
    approval: 'policy' as const, precondition: 'none' as const, compensation: null, inputMaxBytes: 4096 };
  const applications = new Proxy({}, { get: (_target, name) => name === 'operationCatalog' ? [operation] : name === 'then' ? undefined : async () => ({}) }) as McpApplications;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'catalog', version: '1' });
  await createMcpServer(applications, { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en').connect(serverTransport); await client.connect(clientTransport);
  try { return (await client.listTools()).tools; } finally { await client.close(); }
}

describe('MCP capability catalog and governed preview contract', () => {
  // g4-mcp-grup hide_until_slice (owner 2026-10-18): what an AI sees equals what a group can grant or an explicit, reasoned list names.
  it('every advertised write tool is in a capability group or the explicit ungrouped list; withheld tools are not advertised', async () => {
    const tools = await advertisedTools(), names = tools.map(tool => tool.name);
    const grouped = new Set(mcpCapabilityRegistry.list().flatMap(group => group.cells.flatMap(cell => Object.keys(cell.tools))));
    const writes = tools.filter(tool => tool.annotations?.readOnlyHint !== true).map(tool => tool.name);
    expect(writes.filter(name => !grouped.has(name) && !Object.hasOwn(MCP_UNGROUPED_WRITE_TOOLS, name))).toEqual([]);
    // No stale or contradictory row: each listed tool is advertised, written and in no group.
    for (const name of Object.keys(MCP_UNGROUPED_WRITE_TOOLS)) { expect(writes, name).toContain(name); expect(grouped.has(name), name).toBe(false); }
    for (const name of Object.keys(MCP_WITHHELD_TOOLS)) { expect(names, name).not.toContain(name); expect(grouped.has(name), name).toBe(false); }
    expect(Object.keys(MCP_WITHHELD_TOOLS)).toEqual(['release_quota']);
    // control_run advertises only the ordinary operator control; close (a human step) is not in its schema.
    const control = tools.find(tool => tool.name === 'control_run')!;
    expect(JSON.stringify(control.inputSchema)).not.toContain('close'); expect(control.description).toContain('operator-held');
  });
  it('covers each refused tool with explicit action/resource/scope requirements and has no approval decision cell', () => {
    const cells = mcpCapabilityRegistry.list().flatMap(group => group.cells);
    for (const tool of refused) expect(cells.filter(cell => Object.hasOwn(cell.tools, tool)), tool).not.toHaveLength(0);
    expect(cells.some(cell => cell.resource.kind === 'approval' && cell.actions.includes('decide'))).toBe(false);
    expect(mcpCapabilityRegistry.get('dogfood-worker').availability).toBe('opt-in');
    expect(mcpCapabilityRegistry.get('dogfood-worker').cells.every(cell => ['run', 'attempt', 'pool', 'work-target'].includes(cell.resource.kind))).toBe(true);
  });
  it.each(['work', 'dogfood-worker'])('%s requires Run inspection as well as Attempt authority for evaluation', groupId => {
    const requirements = mcpCapabilityRegistry.get(groupId).cells.filter(cell => Object.hasOwn(cell.tools, 'evaluate_task'));
    expect(requirements.find(cell => cell.resource.kind === 'run')).toMatchObject({
      scope: 'selected', tools: { evaluate_task: ['inspect'] }, actions: expect.arrayContaining(['inspect']),
    });
    expect(requirements.find(cell => cell.resource.kind === 'attempt')?.tools['evaluate_task']).toEqual(['evaluate', 'read-output', 'recover-output']);
    expect(requirements.some(cell => cell.actions.includes('decide'))).toBe(false);
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
  it('opt-in availability hides an unheld group, accepts legacy catalog data, and keeps held rules visible for revocation', async () => {
    let document = policy();
    const deps = { policy: { async load() { return document; } }, administration: { submit: async () => { throw Error('unexpected'); } }, approve: async () => { throw Error('unexpected'); } };
    const app = new McpCapabilities(deps), group = mcpCapabilityRegistry.get('dogfood-worker');
    expect((await app.inspect('scope', actor)).groups.some(row => row.group.id === group.id)).toBe(false);
    expect((await new McpCapabilities(deps, mcpCapabilityRegistry, null, [group.id]).inspect('scope', actor)).groups.some(row => row.group.id === group.id)).toBe(true);
    const { availability, ...legacy } = group; expect(availability).toBe('opt-in');
    const registry = new McpCapabilityRegistry([{ ...legacy, schemaVersion: 1, proposed: true }]);
    expect(registry.get(group.id)).toMatchObject({ schemaVersion: 2, availability: 'opt-in', version: 1 });
    const preview = await app.run({ scopeId: 'scope', groupId: group.id, action: 'grant', mode: 'preview' }, actor, '');
    const files = authorityDocuments(document);
    document = resolvePolicyBindings({ ...files.policy, grants: [...files.policy.grants, preview.rules[0]!] }, files.bindings);
    expect((await app.inspect('scope', actor)).groups.find(row => row.group.id === group.id)?.managed).toBe('partial');
    expect((await app.run({ scopeId: 'scope', groupId: group.id, action: 'revoke', mode: 'preview' }, actor, '')).rules).toEqual([preview.rules[0]]);
    expect((await app.inspect('other', { ...actor, scopeIds: ['other'] })).groups.some(row => row.group.id === group.id)).toBe(false);
    const configured = new McpCapabilities(deps, mcpCapabilityRegistry, 'previous-target');
    const target = (await configured.run({ scopeId: 'scope', groupId: group.id, action: 'grant', mode: 'preview' }, actor, '')).rules.find(rule => rule.resource.kind === 'work-target')!;
    document = resolvePolicyBindings({ ...files.policy, grants: [...files.policy.grants, target] }, files.bindings);
    expect((await app.inspect('scope', actor)).groups.some(row => row.group.id === group.id)).toBe(true);
    expect((await app.run({ scopeId: 'scope', groupId: group.id, action: 'revoke', mode: 'preview' }, actor, '')).rules).toEqual([target]);
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
