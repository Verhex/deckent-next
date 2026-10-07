import { describe, expect, it } from 'vitest';
import { bindingsFileSchema, delegationWithin, evaluatePolicy, firstRunPolicyTemplate, FIRST_RUN_POLICY_TEMPLATE_ID, FIRST_RUN_POLICY_TEMPLATE_VERSION,
  matchFirstRunPolicyTemplate, mcpToolGrantChange, modeEligibleApproval, planPolicyChange, policyFileSchema, resolvePolicyBindings, upgradeFirstRunPolicy } from '#domain/index.js';
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
  writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run', proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call' };
const decide = (policy: unknown, tool: string, cell: AgentToolCallCell, operation: string | null, extra: { mcpServer?: string; fullAccess?: boolean } = {}) =>
  decideAgentToolCall(policy, { principal, scopeId: 'installation', tool: { name: tool }, operation: operation ? { id: operation } : null, cell, ...extra });

describe('firstRunPolicyTemplate (domain, pure)', () => {
  it('is deterministic in (scopeId, principal): two calls with the same input produce byte-identical documents', () => {
    expect(firstRunPolicyTemplate(input)).toEqual(firstRunPolicyTemplate(input));
  });
  it('produces a valid v2 policy and v1 bindings document, versioned in the revision', () => {
    const template = firstRunPolicyTemplate(input);
    expect(template.id).toBe(FIRST_RUN_POLICY_TEMPLATE_ID); expect(template.version).toBe(FIRST_RUN_POLICY_TEMPLATE_VERSION);
    expect(policyFileSchema.safeParse(template.policy).success).toBe(true);
    expect(bindingsFileSchema.safeParse(template.bindings).success).toBe(true);
    expect(template.policy).toMatchObject({ schemaVersion: 2, revision: 'first-run-template-v5' });
    expect(template.bindings).toMatchObject({ schemaVersion: 1, revision: 'first-run-template-v5-bindings', bindings: [] });
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
    expect(FIRST_RUN_POLICY_TEMPLATE_VERSION).toBe(5);
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
    expect(matchFirstRunPolicyTemplate('first-run-template-v4')).toEqual({ id: 'first-run-template', version: 4 });
    expect(matchFirstRunPolicyTemplate('first-run-template-v5')).toEqual({ id: 'first-run-template', version: 5 });
  });
  it('does not recognize a custom, hand-edited, or differently-versioned revision', () => {
    expect(matchFirstRunPolicyTemplate('custom-revision')).toBeNull();
    expect(matchFirstRunPolicyTemplate('first-run-template-v1+edit-shell')).toBeNull();
    expect(matchFirstRunPolicyTemplate('first-run-template-v6')).toBeNull();
    expect(matchFirstRunPolicyTemplate('first-run-template-v0')).toBeNull();
    expect(matchFirstRunPolicyTemplate('')).toBeNull();
  });
});

// Owner 2026-10-07 MCP decisions (Jev 04f75210 authority kind + v5, 71eeb4ab effect, d3d1817d proposal tool).
describe('first-run v5: MCP server authority, trust grant and the proposal tool', () => {
  const template = () => firstRunPolicyTemplate(input);
  const withModes = (policy: unknown, mode?: 'full-auto') => resolvePolicyBindings(policy, mode
    ? { schemaVersion: 2, revision: 'b', bindings: [], modes: [{ id: 'me-mode', principal: me, scopes: ['installation'], mode }] } : template().bindings);
  const trusted = (server: string) => {
    const change = mcpToolGrantChange({ digest: 'd'.repeat(24), principal: me, scopes: ['installation'], server, replaces: [] });
    return { ...template().policy, grants: [...(template().policy as { grants: readonly unknown[] }).grants, change.changes[0]!.grant] };
  };
  const call = (policy: unknown, server = 'docs', extra: { fullAccess?: boolean } = {}) => decide(policy, `mcp__${server}__search`, 'mcp-call', 'mcp.tool.call', { mcpServer: server, ...extra });
  it('the owner holds mcp-server for every server in every scope (delegable: the trust grant passes I2) and the call operation; propose_mcp_server is a read tool', () => {
    const grants = template().policy.grants;
    expect(grants.find(grant => grant.id === 'first-run-mcp-servers')).toEqual({ id: 'first-run-mcp-servers', effect: 'allow', actions: ['invoke'], scopes: 'all',
      principals: [me], resource: { kind: 'mcp-server', ids: 'all' } });
    expect(grants.find(grant => grant.id === 'first-run-mcp-call-operation')).toMatchObject({ effect: 'allow', resource: { kind: 'operation', ids: ['mcp.tool.call'] } });
    const policy = withModes(template().policy);
    expect(decide(policy, 'propose_mcp_server', 'read', null)).toMatchObject({ decision: 'allow', relaxation: null });
    const change = mcpToolGrantChange({ digest: 'd'.repeat(24), principal: me, scopes: 'all', server: 'docs', replaces: [] });
    expect(delegationWithin(policy, me, planPolicyChange(template().policy, template().bindings, change).touched)).toEqual({ ok: true });
  });
  it('another person holds nothing: their trust grant is outside I2 (negative)', () => {
    const policy = withModes(template().policy), other = { issuer: 'os', subject: 'colleague' };
    const change = mcpToolGrantChange({ digest: 'e'.repeat(24), principal: other, scopes: ['installation'], server: 'docs', replaces: [] });
    expect(delegationWithin(policy, other, planPolicyChange(template().policy, template().bindings, change).touched)).toMatchObject({ ok: false, reason: 'no-grant' });
  });
  it('after trust: standart asks, full-auto lowers (audited relaxation), full access runs; before trust the owner\'s allow is raised and full-auto still asks', () => {
    expect(call(withModes(trusted('docs')))).toMatchObject({ decision: 'require-approval', relaxation: null });
    expect(call(withModes(trusted('docs'), 'full-auto'))).toMatchObject({ decision: 'allow', relaxation: { mode: 'full-auto', cell: 'mcp-call' } });
    expect(call(withModes(template().policy), 'docs')).toMatchObject({ decision: 'require-approval', relaxation: null });
    expect(call(withModes(template().policy, 'full-auto'))).toMatchObject({ decision: 'require-approval', relaxation: null });
    // The mcp-floor cell (alwaysAsk pin, destructive hint) is never lowered by a mode.
    expect(decide(withModes(trusted('docs'), 'full-auto'), 'mcp__docs__drop', 'mcp-floor', 'mcp.tool.call', { mcpServer: 'docs' })).toMatchObject({ decision: 'require-approval' });
  });
  it('a company deny of the server, or of one tool\'s wire name, still denies; an agent-tool allow of a wire name no longer authorizes an MCP call', () => {
    const base = trusted('docs') as { restrictions: readonly unknown[]; grants: readonly unknown[] };
    const denyServer = { ...base, restrictions: [{ id: 'no-docs', actions: ['invoke'], scopes: ['installation'], principals: [me], resource: { kind: 'mcp-server', ids: ['docs'] } }] };
    expect(call(withModes(denyServer, 'full-auto')).decision).toBe('deny');
    const denyTool = { ...base, restrictions: [{ id: 'no-search', actions: ['invoke'], scopes: ['installation'], principals: [me], resource: { kind: 'agent-tool', ids: ['mcp__docs__search'] } }] };
    expect(call(withModes(denyTool, 'full-auto')).decision).toBe('deny');
    const policy = { ...template().policy, grants: [...(template().policy as { grants: readonly unknown[] }).grants].filter(grant => (grant as { id: string }).id !== 'first-run-mcp-servers')
      .concat([{ id: 'wire', effect: 'allow', actions: ['invoke'], scopes: ['installation'], principals: [me], resource: { kind: 'agent-tool', ids: ['mcp__docs__search'] } }]) };
    expect(call(withModes(policy)).decision).toBe('deny');
  });
});

describe('first-run v4 → v5 migration (pure)', () => {
  const v4 = () => { const { proposeMcpToolName: _p, mcpCallOperationId: _o, ...rest } = input; void _p; void _o;
    const current = firstRunPolicyTemplate(input).policy as { grants: { id: string; resource: { ids: unknown } }[] };
    return { ...current, revision: 'first-run-template-v4', grants: current.grants.filter(grant => grant.id !== 'first-run-mcp-servers' && grant.id !== 'first-run-mcp-call-operation')
      .map(grant => grant.id === 'first-run-read-tools' ? { ...grant, resource: { ...grant.resource, ids: rest.readToolNames } } : grant) }; };
  it('exactly this installation\'s v4 template upgrades to exactly the v5 template; v5 is current', () => {
    expect(upgradeFirstRunPolicy(v4(), input)).toEqual({ status: 'upgrade', from: 4, policy: firstRunPolicyTemplate(input).policy });
    expect(upgradeFirstRunPolicy(JSON.parse(JSON.stringify(firstRunPolicyTemplate(input).policy)), input)).toEqual({ status: 'current' });
  });
  it('anything else is not rewritten: another person\'s v4, an administered or hand-edited v4, another scope, an unreadable document (negative)', () => {
    expect(upgradeFirstRunPolicy(v4(), { ...input, principal: { issuer: 'os', subject: 'colleague' } })).toEqual({ status: 'unavailable', reason: 'not-v4-template' });
    expect(upgradeFirstRunPolicy({ ...v4(), revision: 'a-0123456789' }, input)).toEqual({ status: 'unavailable', reason: 'not-v4-template' });
    expect(upgradeFirstRunPolicy({ ...v4(), grants: [...v4().grants, { id: 'extra', effect: 'allow', actions: ['invoke'], scopes: ['installation'], principals: [me],
      resource: { kind: 'agent-tool', ids: ['fetch_url'] } }] }, input)).toEqual({ status: 'unavailable', reason: 'not-v4-template' });
    expect(upgradeFirstRunPolicy(v4(), { ...input, scopeId: 'other' })).toEqual({ status: 'unavailable', reason: 'not-v4-template' });
    expect(upgradeFirstRunPolicy({ nope: true }, input)).toEqual({ status: 'unavailable', reason: 'invalid' });
  });
});
