import { expect, it } from 'vitest';
import { firstRunPolicyTemplate, type AuditEvent } from '#domain/index.js';
import { setInstallerOwnerBaseline, type PolicyTemplateDocumentWriter } from '#engine/index.js';

it('confirmed installer baseline publishes only its previewed plan after audit; foreign owner, changed plan and failed audit write nothing', async () => {
  const person = { issuer: 'host', subject: 'alice' }, files = firstRunPolicyTemplate({ scopeId: 's', principal: person, readToolNames: ['read_file'], scratchToolNames: ['scratch_write'],
    scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['write_file'], writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run',
    proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' });
  let policy: unknown = files.policy, published = 0; const audits: AuditEvent[] = [];
  const writer: PolicyTemplateDocumentWriter = { async updateAuthority(plan) {
    const result = await plan({ policy, bindings: files.bindings });
    if (result.write) { expect(audits).toHaveLength(published); await result.write.beforePublish?.(); expect(audits).toHaveLength(published + 1); policy = result.write.policy; published++; }
    return result.result;
  } };
  const input = { scopeId: 's', principal: person, families: ['decision-steps'], candidates: [{ family: 'decision-steps' as const, kind: 'run-decision', actions: ['resume'], ids: 'all' as const, scope: 'selected' as const }],
    apply: false, owner: true, peopleLimit: 10, now: () => 1000, openAudit: async () => ({ record: (event: AuditEvent) => { audits.push(event); }, close: () => {} }) };
  expect(await setInstallerOwnerBaseline(writer, { ...input, owner: false })).toMatchObject({ status: 'unavailable', reason: 'not-owner' });
  const preview = await setInstallerOwnerBaseline(writer, input);
  expect(preview.status).toBe('preview'); expect(published).toBe(0);
  expect(await setInstallerOwnerBaseline(writer, { ...input, apply: true, expect: preview.expect!, candidates: [{ ...input.candidates[0]!, actions: ['close'] }] })).toMatchObject({ status: 'conflict' });
  const applied = await setInstallerOwnerBaseline(writer, { ...input, apply: true, expect: preview.expect! });
  expect(applied.status).toBe('applied'); expect(published).toBe(1); expect(audits[0]?.subject.kind).toBe('authority-change');
  const remove = await setInstallerOwnerBaseline(writer, { ...input, families: [] });
  const before = JSON.stringify(policy);
  await expect(setInstallerOwnerBaseline(writer, { ...input, families: [], apply: true, expect: remove.expect!, openAudit: async () => ({ record: () => { throw Error('audit unavailable'); }, close: () => {} }) })).rejects.toThrow('audit unavailable');
  expect(JSON.stringify(policy)).toBe(before); expect(published).toBe(1);
});
