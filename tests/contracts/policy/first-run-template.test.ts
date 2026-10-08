import { describe, expect, it } from 'vitest';
import { bindingsFileSchema, delegationWithin, evaluatePolicy, firstRunPolicyTemplate, FIRST_RUN_POLICY_TEMPLATE_ID, FIRST_RUN_POLICY_TEMPLATE_VERSION,
  matchFirstRunPolicyTemplate, firstRunTemplateAdditions, mcpToolGrantChange, modeEligibleApproval, planPolicyChange, policyFileSchema, resolvePolicyBindings, upgradeFirstRunPolicy } from '#domain/index.js';
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
  writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run', proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' };
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
    expect(template.policy).toMatchObject({ schemaVersion: 2, revision: 'first-run-template-v7' });
    expect(template.bindings).toMatchObject({ schemaVersion: 1, revision: 'first-run-template-v7-bindings', bindings: [] });
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
    expect(FIRST_RUN_POLICY_TEMPLATE_VERSION).toBe(7);
    expect(template.policy.grants.find(grant => grant.id === 'first-run-secret-store')).toEqual({ id: 'first-run-secret-store', effect: 'allow',
      actions: ['set', 'delete'], scopes: ['installation'], principals: [me], resource: { kind: 'secret', ids: 'all' } });
    const ask = (who: typeof principal, action: string, scopeId = 'installation') => evaluatePolicy(policy, { principal: who, scopeId, action, resource: { kind: 'secret', id: 'PROVIDER_TOKEN' } });
    expect(ask(principal, 'set')).toMatchObject({ decision: 'allow', ruleId: 'first-run-secret-store' });
    expect(ask(principal, 'delete')).toMatchObject({ decision: 'allow', ruleId: 'first-run-secret-store' });
    expect(ask(principal, 'read').decision).toBe('deny');
    // v6 (SECRET-STORE-SWITCH, owner 2026-10-08): the owner may switch the installation's store (its own rule, every name); nobody else.
    expect(template.policy.grants.find(grant => grant.id === 'first-run-secret-switch')).toEqual({ id: 'first-run-secret-switch', effect: 'allow',
      actions: ['switch'], scopes: ['installation'], principals: [me], resource: { kind: 'secret', ids: 'all' } });
    const store = (who: typeof principal) => evaluatePolicy(policy, { principal: who, scopeId: 'installation', action: 'switch', resource: { kind: 'secret', id: 'secret-store' } });
    expect(store(principal)).toMatchObject({ decision: 'allow', ruleId: 'first-run-secret-switch' });
    expect(store({ ...principal, id: 'os:other', subject: 'other' }).reason).toBe('NO_GRANT');
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
    expect(matchFirstRunPolicyTemplate('first-run-template-v7')).toEqual({ id: 'first-run-template', version: 7 });
  });
  it('does not recognize a custom, hand-edited, or differently-versioned revision', () => {
    expect(matchFirstRunPolicyTemplate('custom-revision')).toBeNull();
    expect(matchFirstRunPolicyTemplate('first-run-template-v1+edit-shell')).toBeNull();
    expect(matchFirstRunPolicyTemplate('first-run-template-v7')).toEqual({ id: 'first-run-template', version: 7 });
    expect(matchFirstRunPolicyTemplate('first-run-template-v8')).toBeNull();
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
    // K1 option A (owner 2026-10-07): the governed chain and its cards in the installed scope.
    expect(grants.find(grant => grant.id === 'first-run-policy-administer')).toMatchObject({ effect: 'allow', scopes: ['installation'], resource: { kind: 'operation', ids: ['policy.administer'] } });
    expect(grants.find(grant => grant.id === 'first-run-approvals')).toMatchObject({ effect: 'allow', actions: ['inspect', 'decide'], scopes: ['installation'], resource: { kind: 'approval', ids: 'all' } });
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
    return { ...current, revision: 'first-run-template-v4', grants: current.grants.filter(grant => !['first-run-mcp-servers', 'first-run-mcp-call-operation', 'first-run-policy-administer', 'first-run-approvals', 'first-run-secret-switch', 'first-run-model-activation', 'first-run-model-invocation', 'first-run-provider-spending'].includes(grant.id))
      .map(grant => grant.id === 'first-run-read-tools' ? { ...grant, resource: { ...grant.resource, ids: rest.readToolNames } } : grant) }; };
  it('exactly this installation\'s v4, v5 or v6 template upgrades to exactly the current (v7) template; v7 is current', () => {
    expect(upgradeFirstRunPolicy(v4(), input)).toEqual({ status: 'upgrade', from: 4, policy: firstRunPolicyTemplate(input).policy });
    const current = firstRunPolicyTemplate(input).policy as { grants: { id: string }[] };
    // v7 = T4-B K3 (model activation + invocation) and SPEND-SETTLEMENT (provider spend accounts) in one template version.
    const v6 = { ...current, revision: 'first-run-template-v6', grants: current.grants.filter(grant => !['first-run-model-activation', 'first-run-model-invocation', 'first-run-provider-spending'].includes(grant.id)) };
    expect(upgradeFirstRunPolicy(v6, input)).toEqual({ status: 'upgrade', from: 6, policy: firstRunPolicyTemplate(input).policy });
    const v5 = { ...v6, revision: 'first-run-template-v5', grants: v6.grants.filter(grant => grant.id !== 'first-run-secret-switch') };
    expect(upgradeFirstRunPolicy(v5, input)).toEqual({ status: 'upgrade', from: 5, policy: firstRunPolicyTemplate(input).policy });
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

describe('first-run v4 → v5 governed additions (deckent policy upgrade --template v5, pure plan)', () => {
  const v4 = () => { const current = firstRunPolicyTemplate(input).policy as unknown as { grants: { id: string; resource: { ids: unknown } }[] };
    return { ...current, revision: 'first-run-template-v4', grants: current.grants.filter(grant => !['first-run-mcp-servers', 'first-run-mcp-call-operation', 'first-run-policy-administer', 'first-run-approvals', 'first-run-secret-switch', 'first-run-model-activation', 'first-run-model-invocation', 'first-run-provider-spending'].includes(grant.id))
      .map(grant => grant.id === 'first-run-read-tools' ? { ...grant, resource: { ...grant.resource, ids: READ_TOOLS } } : grant) }; };
  const names = { person: me, proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' };
  it('adds exactly the three missing rules and never replaces or removes one: hand-added rules and an edited read rule stay', () => {
    const extra = { id: 'hand-added', effect: 'allow', actions: ['invoke'], scopes: ['installation'], principals: [me], resource: { kind: 'agent-tool', ids: ['fetch_url'] } };
    const edited = v4(); edited.grants = [...edited.grants.map(grant => grant.id === 'first-run-read-tools' ? { ...grant, resource: { ...grant.resource, ids: ['read_file'] } } : grant), extra as never];
    const plan = firstRunTemplateAdditions(edited, names);
    expect(plan.status).toBe('plan');
    if (plan.status !== 'plan') return;
    expect(plan.change.changes.every(change => change.kind === 'grant.add')).toBe(true);
    expect(plan.rules.map(rule => [rule.id, rule.resource.kind, rule.resource.ids, rule.scopes])).toEqual([
      ['first-run-mcp-servers', 'mcp-server', 'all', 'all'], ['first-run-mcp-call-operation', 'operation', ['mcp.tool.call'], ['installation']],
      ['first-run-mcp-propose-tool', 'agent-tool', ['propose_mcp_server'], ['installation']], ['first-run-policy-administer', 'operation', ['policy.administer'], ['installation']],
      ['first-run-approvals', 'approval', 'all', ['installation']], ['first-run-secret-switch', 'secret', 'all', ['installation']],
      // v7 (K3 + SPEND-SETTLEMENT): model activation over every scope, model calls and spend accounts in the installed scope.
      ['first-run-model-activation', 'model-activation', 'all', 'all'], ['first-run-model-invocation', 'model-invocation', 'all', ['installation']],
      ['first-run-provider-spending', 'provider-spend-account', 'all', ['installation']]]);
    expect(plan.conflicts).toEqual([]);
    // Applied (the plan's documents), a second run has nothing to add.
    const applied = { ...edited, grants: [...edited.grants, ...plan.rules] };
    expect(firstRunTemplateAdditions(applied, names)).toEqual({ status: 'current', conflicts: [] });
  });
  it('a hand-added rule under a v5 id with other content is kept and named as a conflict; another person\'s first-run policy is not theirs to upgrade', () => {
    const odd = { id: 'first-run-approvals', effect: 'allow', actions: ['inspect'], scopes: ['installation'], principals: [me], resource: { kind: 'approval', ids: 'all' } };
    const plan = firstRunTemplateAdditions({ ...v4(), grants: [...v4().grants, odd] }, names);
    expect(plan).toMatchObject({ status: 'plan', conflicts: ['first-run-approvals'] });
    if (plan.status === 'plan') expect(plan.rules.map(rule => rule.id)).not.toContain('first-run-approvals');
    expect(firstRunTemplateAdditions(v4(), { ...names, person: { issuer: 'os', subject: 'colleague' } })).toEqual({ status: 'unavailable', reason: 'not-this-person' });
  });
  it('security (lead 2026-10-07): a read rule for `all` principals names no owner (unavailable for everyone); every added rule names only the caller', () => {
    const open = { ...v4(), grants: v4().grants.map(grant => grant.id === 'first-run-read-tools' ? { ...grant, principals: 'all' } : grant) };
    expect(firstRunTemplateAdditions(open, names)).toEqual({ status: 'unavailable', reason: 'not-this-person' });
    expect(firstRunTemplateAdditions(open, { ...names, person: { issuer: 'os', subject: 'anyone' } })).toEqual({ status: 'unavailable', reason: 'not-this-person' });
    // A read rule naming two people: the plan for one of them grants that one alone, never the other (nor `all`).
    const shared = { ...v4(), grants: v4().grants.map(grant => grant.id === 'first-run-read-tools' ? { ...grant, principals: [me, { issuer: 'os', subject: 'colleague' }] } : grant) };
    const plan = firstRunTemplateAdditions(shared, { ...names, person: { issuer: 'os', subject: 'colleague' } });
    expect(plan.status).toBe('plan');
    if (plan.status === 'plan') for (const rule of plan.rules) expect(rule.principals).toEqual([{ issuer: 'os', subject: 'colleague' }]);
  });
  it('a fresh v5 template is current (the proposal tool inside its read rule); a policy without the first-run read rule is not this template', () => {
    expect(firstRunTemplateAdditions(firstRunPolicyTemplate(input).policy, names)).toEqual({ status: 'current', conflicts: [] });
    expect(firstRunTemplateAdditions({ ...v4(), grants: v4().grants.filter(grant => grant.id !== 'first-run-read-tools') }, names)).toEqual({ status: 'unavailable', reason: 'not-first-run' });
    expect(firstRunTemplateAdditions({ nope: 1 }, names)).toEqual({ status: 'unavailable', reason: 'invalid' });
  });
});
