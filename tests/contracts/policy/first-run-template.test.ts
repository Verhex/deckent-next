import { describe, expect, it } from 'vitest';
import { bindingsFileSchema, evaluatePolicy, firstRunPolicyTemplate, FIRST_RUN_POLICY_TEMPLATE_ID, FIRST_RUN_POLICY_TEMPLATE_VERSION,
  matchFirstRunPolicyTemplate, modeEligibleApproval, policyFileSchema, resolvePolicyBindings } from '#domain/index.js';
import { decideAgentToolCall, type AgentToolCallCell } from '#engine/index.js';

// SCR-B (owner 2026-09-28, checkpoint option B, proof/SCR-B-2026-09-28/review.md): the versioned default policy
// a fresh, terminal-only installation gets from `deckent init policy`.
const me = { issuer: 'os', subject: 'alperen' };
const principal = { id: 'os:alperen', ...me, assurance: 'os-user' as const, scopeIds: ['installation'] };
const READ_TOOLS = ['read_file', 'list_dir', 'grep', 'glob'];
const SCRATCH_TOOLS = ['scratch_write', 'scratch_read', 'scratch_list'];
const EDIT_SHELL_TOOLS = ['edit_file', 'write_file', 'run_shell'];
const input = { scopeId: 'installation', principal: me, readToolNames: READ_TOOLS, scratchToolNames: SCRATCH_TOOLS,
  scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: EDIT_SHELL_TOOLS,
  writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run' };
const decide = (policy: unknown, tool: string, cell: AgentToolCallCell, operation: string | null) =>
  decideAgentToolCall(policy, { principal, scopeId: 'installation', tool: { name: tool }, operation: operation ? { id: operation } : null, cell });

describe('firstRunPolicyTemplate (domain, pure)', () => {
  it('is deterministic in (scopeId, principal): two calls with the same input produce byte-identical documents', () => {
    expect(firstRunPolicyTemplate(input)).toEqual(firstRunPolicyTemplate(input));
  });
  it('produces a valid v2 policy and v1 bindings document, versioned in the revision', () => {
    const template = firstRunPolicyTemplate(input);
    expect(template.id).toBe(FIRST_RUN_POLICY_TEMPLATE_ID); expect(template.version).toBe(FIRST_RUN_POLICY_TEMPLATE_VERSION);
    expect(policyFileSchema.safeParse(template.policy).success).toBe(true);
    expect(bindingsFileSchema.safeParse(template.bindings).success).toBe(true);
    expect(template.policy).toMatchObject({ schemaVersion: 2, revision: 'first-run-template-v4' });
    expect(template.bindings).toMatchObject({ schemaVersion: 1, revision: 'first-run-template-v4-bindings', bindings: [] });
  });
  it('grants read tools and the given scratch tool names silently, asks for edit/shell tools, and grants no pool/service authority', () => {
    const policy = resolvePolicyBindings(firstRunPolicyTemplate(input).policy, firstRunPolicyTemplate(input).bindings);
    for (const tool of READ_TOOLS) expect(decide(policy, tool, 'read', null)).toMatchObject({ decision: 'allow', relaxation: null });
    expect(decide(policy, 'scratch_write', 'edit', 'workspace.scratch.write')).toMatchObject({ decision: 'allow', relaxation: null });
    for (const tool of ['scratch_read', 'scratch_list']) expect(decide(policy, tool, 'read', null)).toMatchObject({ decision: 'allow', relaxation: null });
    // MODES-3: nobody has an entry yet, so everyone is standart — an ordinary in-project edit runs without a card (the edit rule is
    // mode-eligible), audited as a standart relaxation with no person entry; the write floor and the shell still ask.
    expect(decide(policy, 'edit_file', 'edit', 'workspace.file.write')).toMatchObject({ decision: 'allow', relaxation: { mode: 'standart', person: null } });
    expect(decide(policy, 'write_file', 'edit-floor', 'workspace.file.write')).toMatchObject({ decision: 'require-approval', relaxation: null });
    expect(decide(policy, 'run_shell', 'shell-narrow-mutating', 'host.shell.run')).toMatchObject({ decision: 'require-approval', relaxation: null });
    expect(evaluatePolicy(policy, { principal, scopeId: 'installation', action: 'use', resource: { kind: 'pool', id: 'default' } }).reason).toBe('NO_GRANT');
    expect(evaluatePolicy(policy, { principal, scopeId: 'installation', action: 'shutdown', resource: { kind: 'service', id: 'svc' } }).reason).toBe('NO_GRANT');
  });
  it('SCR-A cross-lane note: without the scratch-write operation grant, scratch_write is never silently allowed (the agent-tool/invoke allow alone is not enough)', () => {
    // Checking against an operation id the template never granted (a stand-in for "the grant is missing"): the
    // agent-tool side alone is allow, but the operation side is NO_GRANT, so the combined decision is never allow.
    const policy = resolvePolicyBindings(firstRunPolicyTemplate(input).policy, firstRunPolicyTemplate(input).bindings);
    expect(decide(policy, 'scratch_write', 'edit', 'some-other-operation').decision).not.toBe('allow');
    // The literal case SCR-A described: the scratch-write operation grant itself removed from the template.
    const withoutScratchOperation = { ...firstRunPolicyTemplate(input).policy,
      grants: firstRunPolicyTemplate(input).policy.grants.filter(grant => grant.id !== 'first-run-scratch-write-operation') };
    const narrowed = resolvePolicyBindings(withoutScratchOperation, firstRunPolicyTemplate(input).bindings);
    expect(decide(narrowed, 'scratch_write', 'edit', 'workspace.scratch.write').decision).not.toBe('allow');
  });
  it('marks the edit/shell rule modeEligible: a later full-auto mode relaxes exactly it, never read or scratch', () => {
    const policy = resolvePolicyBindings(firstRunPolicyTemplate(input).policy,
      { schemaVersion: 2, revision: 'b', bindings: [], modes: [{ id: 'me-mode', principal: me, scopes: ['installation'], mode: 'full-auto' }] });
    expect(decide(policy, 'edit_file', 'edit', 'workspace.file.write')).toMatchObject({ decision: 'allow', relaxation: { mode: 'full-auto', cell: 'edit-non-floor' } });
    expect(decide(policy, 'run_shell', 'shell-narrow-mutating', 'host.shell.run')).toMatchObject({ decision: 'allow', relaxation: { mode: 'full-auto', cell: 'shell-modify' } });
    expect(decide(policy, 'read_file', 'read', null).relaxation).toBeNull();
    expect(decide(policy, 'scratch_write', 'edit', 'workspace.scratch.write').relaxation).toBeNull();
    expect(modeEligibleApproval(policy, { principal, scopeId: 'installation', action: 'invoke', resource: { kind: 'agent-tool', id: 'edit_file' } }))
      .toEqual(['first-run-edit-shell-tools']);
    expect(modeEligibleApproval(policy, { principal, scopeId: 'installation', action: 'invoke', resource: { kind: 'agent-tool', id: 'read_file' } })).toBeNull();
  });
  it('v2 (SECRET-WRITE, owner 2026-09-29 option A): the installing owner may set and delete every secret of their installation in its scope, nobody else', () => {
    const template = firstRunPolicyTemplate(input), policy = resolvePolicyBindings(template.policy, template.bindings);
    expect(FIRST_RUN_POLICY_TEMPLATE_VERSION).toBe(4);
    expect(template.policy.grants.find(grant => grant.id === 'first-run-secret-store')).toEqual({ id: 'first-run-secret-store', effect: 'allow',
      actions: ['set', 'delete'], scopes: ['installation'], principals: [me], resource: { kind: 'secret', ids: 'all' } });
    const ask = (who: typeof principal, action: string, scopeId = 'installation') => evaluatePolicy(policy, { principal: who, scopeId, action, resource: { kind: 'secret', id: 'PROVIDER_TOKEN' } });
    expect(ask(principal, 'set')).toMatchObject({ decision: 'allow', ruleId: 'first-run-secret-store' });
    expect(ask(principal, 'delete')).toMatchObject({ decision: 'allow', ruleId: 'first-run-secret-store' });
    expect(ask(principal, 'read').decision).toBe('deny');
    expect(ask({ ...principal, id: 'os:other', subject: 'other' }, 'set').reason).toBe('NO_GRANT');
    expect(ask({ ...principal, scopeIds: ['installation', 'other-scope'] }, 'set', 'other-scope').reason).toBe('NO_GRANT');
  });
  it('a company policy may still narrow it (deny/require-approval always outrank the template\'s own allow)', () => {
    const template = firstRunPolicyTemplate(input);
    const narrowed = { ...template.policy, restrictions: [{ id: 'company-deny-scratch', actions: ['invoke'], scopes: ['installation'],
      principals: [me], resource: { kind: 'agent-tool', ids: ['scratch_write'] } }] };
    const policy = resolvePolicyBindings(narrowed, template.bindings);
    expect(decide(policy, 'scratch_write', 'edit', 'workspace.scratch.write').decision).toBe('deny');
    expect(decide(policy, 'scratch_read', 'read', null).decision).toBe('allow');
  });
});

describe('matchFirstRunPolicyTemplate (doctor recognition, never authority)', () => {
  it('recognizes exactly the template\'s own revision and version', () => {
    expect(matchFirstRunPolicyTemplate('first-run-template-v2')).toEqual({ id: 'first-run-template', version: 2 });
    // v3 (B1) is recognized; a v2 installation keeps its name (it lacks the visible hard-floor approvalAssurance rule; Core enforces it anyway).
    expect(matchFirstRunPolicyTemplate('first-run-template-v3')).toEqual({ id: 'first-run-template', version: 3 });
    // An installation made from v1 is still named (recognition only): it lacks the v2 secret grant.
    expect(matchFirstRunPolicyTemplate('first-run-template-v1')).toEqual({ id: 'first-run-template', version: 1 });
  });
  it('does not recognize a custom, hand-edited, or differently-versioned revision', () => {
    expect(matchFirstRunPolicyTemplate('custom-revision')).toBeNull();
    expect(matchFirstRunPolicyTemplate('first-run-template-v1+edit-shell')).toBeNull();
    expect(matchFirstRunPolicyTemplate('first-run-template-v5')).toBeNull();
    expect(matchFirstRunPolicyTemplate('first-run-template-v0')).toBeNull();
    expect(matchFirstRunPolicyTemplate('')).toBeNull();
  });
});
