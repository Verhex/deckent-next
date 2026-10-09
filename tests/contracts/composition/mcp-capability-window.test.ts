import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { appendFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { encodeCommandProjection, firstRunPolicyTemplate, FIRST_RUN_UPGRADE_RULE_IDS, getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID, type McpCapabilityPreview } from '#domain/index.js';
import { createHash } from 'node:crypto';
import { changeConfiguredMcpCapabilities, inspectConfiguredMcpCapabilities, listConfiguredMcpCapabilityScopes } from '#composition/core/approvals/index.js';
import { mcpApplications } from '#composition/core/mcp/index.js';
import { inspectConfiguredProviderSpendAccount, manageConfiguredProviderSpend } from '#composition/core/provider-spend/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { scopeBudgetCreateCommand, scopeBudgetRevisionCommand } from '#surfaces/core/cli-models/index.js';
import { me, runtime } from '../support/mcp-capability-harness.js';
import { terminalApplication, terminalProgram } from '../support/approval-terminal.js';

async function trace(phase: string) {
  if (process.env['DECKENT_MCP_GRANT_TRACE']) await appendFile(process.env['DECKENT_MCP_GRANT_TRACE'], `${new Date().toISOString()} ${phase}\n`);
}

async function fixture(shape: 'template' | 'hand-built' | 'live-shape' | 'n1-shape' = 'template', owner = true) {
  await trace(`fixture ${shape}: before runtime`);
  const f = await runtime(), template = firstRunPolicyTemplate({ scopeId: 'scope', principal: me[0]!, readToolNames: ['read_file'], scratchToolNames: ['scratch_write'],
    scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['write_file'], writeOperationId: 'workspace.file.write',
    shellOperationId: 'host.shell.run', proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' });
  await trace(`fixture ${shape}: runtime created`);
  const configPath = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
  delete config.provider_spending; await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
  const custom = { id: 'custom-kept', effect: 'allow', principals: me, scopes: ['scope'], actions: ['inspect'], resource: { kind: 'run', ids: ['custom-run'] } };
  const roles = owner ? [{ id: INSTALLATION_OWNER_ROLE_ID, permissions: installationOwnerPermissions(getPolicyVocabulary().resources.map(resource => resource.kind)) }] : [];
  let body = { ...template.policy, revision: shape === 'template' ? template.policy.revision : `hand-${shape}`,
    roles, grants: [...template.policy.grants, ...(shape === 'template' ? [] : [custom])] };
  let bindings = { ...template.bindings, bindings: owner ? [{ id: 'owner', principals: me, roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' }] : [] };
  if (shape === 'live-shape' || shape === 'n1-shape') {
    const retained = JSON.parse(await readFile(resolve('tests/fixtures/mcp-capability-policies.json'), 'utf8'))[shape === 'live-shape' ? 'live' : 'n1'];
    body = { ...retained.policy, grants: retained.policy.grants.map((grant: { principals: unknown }) => ({ ...grant, principals: grant.principals === 'all' ? 'all' : me })) };
    bindings = { ...retained.bindings, modes: retained.bindings.modes?.map((mode: object) => ({ ...mode, principal: me[0] })) };
  }
  await writeFile(join(f.data, 'policy.json'), JSON.stringify(body), { mode: 0o600 });
  await writeFile(join(f.data, 'bindings.json'), JSON.stringify(bindings), { mode: 0o600 });
  const read = async () => JSON.parse(await readFile(join(f.data, 'policy.json'), 'utf8')) as typeof body;
  const request = (groupId: string, action: 'grant' | 'revoke', mode: 'preview' | 'apply', expect?: string) =>
    ({ scopeId: 'scope', groupId, action, mode, ...(expect ? { expect } : {}) });
  const preview = (group = 'spend', action: 'grant' | 'revoke' = 'grant') => changeConfiguredMcpCapabilities(f.project, request(group, action, 'preview'), { env: f.env });
  const apply = (view: McpCapabilityPreview) => terminalApplication<McpCapabilityPreview>(f, 'mcp-capability', 'scope', request(view.groupId, view.action, 'apply', view.digest));
  const audits = () => f.rows('SELECT record FROM audit_events ORDER BY sequence').map(row => JSON.parse(String(row['record'])))
    .filter(row => row.event.subject.kind === 'authority-change');
  return { f, body, read, request, preview, apply, audits };
}

describe.skipIf(process.platform !== 'linux')('selection-only MCP capability administration (real policy, MCP and TTY)', () => {
  it('grant → MCP budget revision works; revoke → refused again; exact digest/rules, audit, archive and owner rights survive', async () => {
    const { f, body, read, preview, apply, audits } = await fixture();
    // Same configured producers as the service; real MCP transport and actor channel, without the sandbox-denied Unix listener.
    const owner = { manageProviderSpend: (command: Parameters<typeof manageConfiguredProviderSpend>[1]) => manageConfiguredProviderSpend(f.project, command, { env: f.env }),
      inspectProviderSpendAccount: (query: Parameters<typeof inspectConfiguredProviderSpendAccount>[1]) => inspectConfiguredProviderSpendAccount(f.project, query, { env: f.env }) };
    await owner.manageProviderSpend(scopeBudgetCreateCommand('scope', 25, 'cli', 'create'));
    await trace('budget created');
    const current = await owner.inspectProviderSpendAccount({ schemaVersion: 1, scopeId: 'scope', current: true });
    const server = createMcpServer(mcpApplications({ ...f.client(), ...owner }), { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
    const client = new Client({ name: 'worker', version: '1' }); await client.connect(ct); await trace('MCP connected');
    const revise = () => client.callTool({ name: 'manage_provider_spending', arguments: scopeBudgetRevisionCommand(current, 30, true, 'cli', 'mcp-revise') });
    try {
      expect((await revise()).isError).toBe(true);
      await trace('default refused');
      const plan = await preview(); expect(plan.status).toBe('preview'); expect(plan.missing).toEqual([]);
      expect((await read()).grants).toEqual(body.grants);
      const applied = await apply(plan); expect(applied).toMatchObject({ status: 'applied', digest: plan.digest, change: plan.change, rules: plan.rules });
      await trace('TTY grant applied');
      expect((await read()).grants).toEqual([...body.grants, ...plan.rules]);
      expect((await revise()).isError).not.toBe(true);
      expect(audits()).toHaveLength(1);
      expect(audits()[0].event.subject.counts).toMatchObject({ grantsAdded: plan.rules.length, grantsRemoved: 0 });
      expect(audits()[0].event.subject.inputDigest).toBe(createHash('sha256').update(encodeCommandProjection('effect-input', plan.change)).digest('hex'));
      expect((await readdir(join(f.data, 'audit/authority-revisions'))).length).toBeGreaterThan(0);
      const undo = await preview('spend', 'revoke');
      expect(await apply(undo)).toMatchObject({ status: 'applied', digest: undo.digest });
      expect((await read()).grants).toEqual(body.grants);
      const latest = await owner.inspectProviderSpendAccount({ schemaVersion: 1, scopeId: 'scope', current: true });
      const denied = await client.callTool({ name: 'manage_provider_spending', arguments: scopeBudgetRevisionCommand(latest, 35, false, 'cli', 'after-revoke') });
      expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).toContain('POLICY_DENIED');
      await owner.manageProviderSpend(scopeBudgetRevisionCommand(latest, 35, false, 'cli', 'owner-still-allowed'));
      expect(audits()).toHaveLength(2);
      expect((await inspectConfiguredMcpCapabilities(f.project, 'scope', { env: f.env })).groups.find(row => row.group.id === 'spend'))
        .toMatchObject({ managed: 'none', effective: 'denied' });
    } finally { await client.close(); await server.close(); }
  }, 60_000);

  for (const shape of ['hand-built', 'live-shape', 'n1-shape'] as const) it(`${shape}: grant is add-only, revoke preserves custom grants, roles and bindings`, async () => {
    const { f, body, read, preview, apply } = await fixture(shape);
    const group = shape === 'live-shape' ? 'spend' : shape === 'n1-shape' ? 'dogfood-worker' : 'work';
    const bound = await readFile(join(f.data, 'bindings.json'), 'utf8'), plan = await preview(group);
    if (shape === 'n1-shape') expect(plan.rules.find(rule => rule.resource.kind === 'pool')?.resource.ids).toEqual(['dogfood', 'dogfood-16', 'dogfood-8']);
    expect(await apply(plan)).toMatchObject({ status: 'applied' });
    expect((await read()).grants).toEqual([...body.grants, ...plan.rules]);
    expect((await read()).roles).toEqual(body.roles); expect(await readFile(join(f.data, 'bindings.json'), 'utf8')).toBe(bound);
    expect(await apply(await preview(group, 'revoke'))).toMatchObject({ status: 'applied' });
    expect((await read()).grants).toEqual(body.grants);
  }, 40_000);

  it('non-TTY, piped stdin and redirected stdout cannot apply or revoke, and no authority audit is emitted', async () => {
    const { f, read, preview, apply, request, audits } = await fixture();
    const plan = await preview(); const before = await read();
    await expect(changeConfiguredMcpCapabilities(f.project, request('spend', 'grant', 'apply', plan.digest), { env: f.env }))
      .rejects.toMatchObject({ code: 'APPROVAL_INTERACTIVE_REQUIRED' });
    for (const mode of ['piped-input', 'redirected-output']) {
      const value = await terminalProgram([process.execPath, resolve('tests/fixtures/approval-terminal-application.mjs'), f.project,
        JSON.stringify({ operation: 'mcp-capability', input: request('spend', 'grant', 'apply', plan.digest) })], f.env, undefined, mode);
      expect(value.output).toContain('APPROVAL_INTERACTIVE_REQUIRED');
    }
    expect(await read()).toEqual(before); expect(audits()).toHaveLength(0);
    await apply(plan); const undo = await preview('spend', 'revoke');
    await expect(changeConfiguredMcpCapabilities(f.project, request('spend', 'revoke', 'apply', undo.digest), { env: f.env }))
      .rejects.toMatchObject({ code: 'APPROVAL_INTERACTIVE_REQUIRED' });
    expect(audits()).toHaveLength(1);
  }, 60_000);

  it('unknown selections, missing digest, policy drift and same-id conflicts fail closed', async () => {
    const { f, body, read, preview, apply, request, audits } = await fixture();
    await expect(changeConfiguredMcpCapabilities(f.project, request('unknown', 'grant', 'preview'), { env: f.env })).rejects.toMatchObject({ code: 'CLI_USAGE' });
    await expect(changeConfiguredMcpCapabilities(f.project, { ...request('work', 'grant', 'preview'), scopeId: 'unknown' }, { env: f.env })).rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
    await expect(changeConfiguredMcpCapabilities(f.project, request('work', 'grant', 'apply'), { env: f.env })).rejects.toMatchObject({ code: 'CLI_USAGE' });
    expect(await listConfiguredMcpCapabilityScopes(f.project, { env: f.env })).toEqual(['scope']);
    const plan = await preview('work');
    await writeFile(join(f.data, 'policy.json'), JSON.stringify({ ...body, revision: 'new-revision' }));
    expect(await apply(plan)).toMatchObject({ status: 'conflict' });
    const occupied = { ...plan.rules[0]!, resource: { kind: 'run', ids: ['someone-elses-rule'] } };
    await writeFile(join(f.data, 'policy.json'), JSON.stringify({ ...body, revision: 'occupied', grants: [...body.grants, occupied] }));
    expect(await preview('work')).toMatchObject({ status: 'conflict' });
    expect(await preview('work', 'revoke')).toMatchObject({ status: 'conflict' });
    expect((await read()).grants).toEqual([...body.grants, occupied]); expect(audits()).toHaveLength(0);
  }, 40_000);

  it('delegation remains bounded; a scoped person cannot grant installation-wide pool control', async () => {
    const { read, preview } = await fixture('template', false);
    const before = await read();
    expect(await preview('pools')).toMatchObject({ status: 'preview', missing: ['delegation'] });
    expect(await read()).toEqual(before);
  });

  it('the existing governed template rollback preserves named MCP capability rules and those rules remain revocable', async () => {
    const { f, body, read, preview, apply, audits } = await fixture();
    const plan = await preview(); await apply(plan);
    expect(await terminalApplication(f, 'policy-upgrade', 'scope', { mode: 'rollback', reason: 'W5 rollback regression' })).toMatchObject({ status: 'rolled-back' });
    const ids = new Set<string>(Object.values(FIRST_RUN_UPGRADE_RULE_IDS));
    expect((await read()).grants).toEqual([...body.grants.filter(grant => !ids.has(grant.id)), ...plan.rules]);
    expect(audits()).toHaveLength(2);
    expect(await apply(await preview('spend', 'revoke'))).toMatchObject({ status: 'applied' });
    expect((await read()).grants).toEqual(body.grants.filter(grant => !ids.has(grant.id)));
  }, 40_000);
});
