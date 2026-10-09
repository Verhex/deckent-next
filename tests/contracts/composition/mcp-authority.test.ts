import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { firstRunPolicyTemplate, mcpPrincipalRef } from '#domain/index.js';
import { clearConfigCache } from '#platform/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { scopeBudgetCreateCommand, scopeBudgetRevisionCommand } from '#surfaces/core/cli-models/index.js';
import { admitConfiguredModelActivation } from '#composition/core/model-activation/index.js';
import { mcpApplications } from '#composition/core/mcp/index.js';
import { me, runtime } from '../support/chat-turn-harness.js';

describe.skipIf(process.platform !== 'linux')('MCP authority through the actual configured applications and service', () => {
  it('refuses budget changes/unfreeze, activation and paid sends on v7/v8/v9; owner still revises; explicit scoped MCP grant works and is audited', async () => {
    const f = await runtime();
    const configPath = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
    delete config.provider_spending;
    config.provider_invocation_profiles.profiles[0].adapter.definition.tariff = { kind: 'operator-static', version: 2, currency: 'USD',
      inputMinorUnitsPerMillionTokens: 200, cachedInputMinorUnitsPerMillionTokens: 50, outputMinorUnitsPerMillionTokens: 1000 };
    await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
    const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: me[0]!, readToolNames: ['read_file'], scratchToolNames: ['scratch_write'],
      scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['write_file'], writeOperationId: 'workspace.file.write',
      shellOperationId: 'host.shell.run', proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' });
    await writeFile(join(f.data, 'policy.json'), JSON.stringify(template.policy), { mode: 0o600 });
    await writeFile(join(f.data, 'bindings.json'), JSON.stringify(template.bindings), { mode: 0o600 });
    await f.start(); const owner = f.client(true);
    await owner.manageProviderSpend(scopeBudgetCreateCommand('scope', 25, 'cli', 'owner-create'));
    const current = await owner.inspectProviderSpendAccount({ schemaVersion: 1, scopeId: 'scope', current: true });
    const revise = scopeBudgetRevisionCommand(current, 30, true, 'cli', 'mcp-revise');
    const reference = { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
    const activation = { schemaVersion: 1 as const, action: 'activate' as const, commandId: 'mcp-activate', scopeId: 'scope', reference,
      expectedRevision: 1, catalogRevision: 'catalog-1', expectedBinding: f.binding };
    const applications = mcpApplications({ ...f.client(true), admitModelActivation: (input: typeof activation) => admitConfiguredModelActivation(f.project, input, { env: f.env }) });
    const server = createMcpServer(applications, { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
    const client = new Client({ name: 'external-ai', version: '1' }); await client.connect(ct);
    try {
      for (const version of [7, 8, 9]) {
        const grants = template.policy.grants.filter(rule => version >= 9 || !rule.id.startsWith('first-run-mcp-observe-'));
        await writeFile(join(f.data, 'policy.json'), JSON.stringify({ ...template.policy, revision: `first-run-template-v${version}`, grants }));
        for (const [name, args] of [['manage_provider_spending', revise], ['admit_model_activation', activation], ['invoke_model', {
          schemaVersion: 1, commandId: 'mcp-paid', scopeId: 'scope', reference, catalogRevision: 'catalog-1', expectedBinding: f.binding,
          nativeRequest: { model: 'native-chat', messages: [{ role: 'user', content: 'paid call' }], max_tokens: 128 },
        }]] as const) {
          const result = await client.callTool({ name, arguments: args });
          expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('POLICY_DENIED');
        }
      }
      expect(f.state.requests).toHaveLength(0);
      expect(f.rows('SELECT command_id FROM provider_spend_management')).toEqual([{ command_id: 'owner-create' }]);
      await writeFile(join(f.data, 'policy.json'), JSON.stringify(template.policy));
      await owner.manageProviderSpend(scopeBudgetRevisionCommand(current, 35, true, 'cli', 'owner-revise'));
      const after = await owner.inspectProviderSpendAccount({ schemaVersion: 1, scopeId: 'scope', current: true });
      const mcp = mcpPrincipalRef(me[0]!);
      const grant = { id: 'explicit-mcp-budget', effect: 'allow', principals: [mcp], scopes: ['scope'], actions: ['budget-revision'],
        resource: { kind: 'provider-spend-account', ids: [after.checkpoint!.account.budget.budgetId] } };
      await writeFile(join(f.data, 'policy.json'), JSON.stringify({ ...template.policy, revision: 'mcp-granted', grants: [...template.policy.grants, grant] }));
      const permitted = await client.callTool({ name: 'manage_provider_spending', arguments: scopeBudgetRevisionCommand(after, 40, true, 'cli', 'mcp-granted') });
      expect(permitted.isError).not.toBe(true);
      expect(JSON.stringify(permitted)).toContain(mcp.issuer);
      expect(f.rows('SELECT command_id FROM provider_spend_management')).toHaveLength(3);
      // Revoking only the MCP grant restores refusal; terminal-owner rights remain.
      await writeFile(join(f.data, 'policy.json'), JSON.stringify(template.policy));
      const latest = await owner.inspectProviderSpendAccount({ schemaVersion: 1, scopeId: 'scope', current: true });
      expect((await client.callTool({ name: 'manage_provider_spending', arguments: scopeBudgetRevisionCommand(latest, 45, false, 'cli', 'revoked') })).isError).toBe(true);
    } finally { await client.close(); await server.close(); }
  }, 60_000);
});
