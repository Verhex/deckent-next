import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withMcpPrincipal } from '#adapters/index.js';
import { firstRunPolicyTemplate } from '#domain/index.js';
import { inspectConfiguredDecisionDelegations, changeConfiguredDecisionDelegation } from '#composition/core/approvals/index.js';
import { me, runtime } from '../support/mcp-capability-harness.js';
it('SDK listing reads only; a non-TTY grant is refused before confirmation, identity/approval creation or policy write', async () => {
  const f = await runtime();
  const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: me[0]!, readToolNames: ['read_file'], scratchToolNames: ['scratch_write'],
    scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['write_file'], writeOperationId: 'workspace.file.write',
    shellOperationId: 'host.shell.run', proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' });
  const path = join(f.data, 'policy.json');
  await writeFile(path, JSON.stringify(template.policy), { mode: 0o600 });
  await writeFile(join(f.data, 'bindings.json'), JSON.stringify(template.bindings), { mode: 0o600 });
  const before = await readFile(path, 'utf8'), approvals = f.rows('SELECT * FROM approvals');
  const view = await inspectConfiguredDecisionDelegations(f.project, { schemaVersion: 1, scopeId: 'scope' }, { env: f.env });
  const aiView = await withMcpPrincipal(() => inspectConfiguredDecisionDelegations(f.project, { schemaVersion: 1, scopeId: 'scope' }, { env: f.env }));
  expect(aiView.principal).toEqual(view.principal);
  expect(view.steps).toHaveLength(6); expect(view.steps.every(s => s.managed === 'none' && s.effective === 'denied')).toBe(true);
  let confirmed = false;
  await expect(changeConfiguredDecisionDelegation(f.project, { schemaVersion: 1, scopeId: 'scope', step: 'run-resume', action: 'grant', expectedRevision: view.revision },
    async () => { confirmed = true; return true; }, { env: f.env })).rejects.toMatchObject({ code: 'APPROVAL_INTERACTIVE_REQUIRED' });
  expect(confirmed).toBe(false); expect(await readFile(path, 'utf8')).toBe(before); expect(f.rows('SELECT * FROM approvals')).toEqual(approvals);
});
