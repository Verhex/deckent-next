import { FIRST_RUN_V16_RULE_IDS } from '../support/first-run-v16.js';
import history from '../../fixtures/policy/first-run-history.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS as FIRST_RUN_V17_RULE_IDS, POLICY_CHANGE_MAX, bindingsFileSchema, delegationWithin, evaluatePolicy, firstRunPolicyTemplate, FIRST_RUN_POLICY_TEMPLATE_ID, FIRST_RUN_POLICY_TEMPLATE_VERSION,
  namedPersonPolicyAdditions, policyNamedPeople, mcpPrincipalRef, policyScopeGrants, matchFirstRunPolicyTemplate, firstRunTemplateAdditions, mcpToolGrantChange, modeEligibleApproval, planPolicyChange, policyFileSchema, firstRunTemplateRollback, resolvePolicyBindings, upgradeFirstRunPolicy } from '#domain/index.js';
import { decideAgentToolCall, type AgentToolCallCell } from '#engine/index.js';

// Historical fixtures before v16 exclude both later additive deltas.
const POST_V15_RULE_IDS: readonly string[] = [...FIRST_RUN_V16_RULE_IDS, ...FIRST_RUN_V17_RULE_IDS];

// SCR-B (owner 2026-09-28, checkpoint option B, proof/SCR-B-2026-09-28/review.md): the versioned default policy
// a fresh, terminal-only installation gets from `deckent init policy`.
const me = { issuer: 'os', subject: 'alperen' };
/** PRE-9 (b): a stored full-auto counts only with its grant, so the person first opens it (`init policy --modes full-auto`: the managed rule). */
const openFullAuto = (policy: unknown) => ({ ...(policy as object), grants: [...(policy as { grants: readonly unknown[] }).grants, { id: 'installer-permission-mode-full-auto', effect: 'allow',
  actions: ['set'], scopes: ['installation'], principals: [me], resource: { kind: 'permission-mode', ids: ['full-auto'] } }] });
const principal = { id: 'os:alperen', ...me, assurance: 'os-user' as const, scopeIds: ['installation'] };
const READ_TOOLS = ['read_file', 'list_dir', 'grep', 'glob'];
const SCRATCH_TOOLS = ['scratch_write', 'scratch_read', 'scratch_list'];
const EDIT_SHELL_TOOLS = ['edit_file', 'write_file', 'run_shell'];
const input = { scopeId: 'installation', principal: me, readToolNames: READ_TOOLS, scratchToolNames: SCRATCH_TOOLS,
  scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: EDIT_SHELL_TOOLS,
  writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run', proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer',
  firstCommitOperationId: 'coding.first-commit', executionEnvironmentIds: ['docker'] };
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
    expect(template.policy).toMatchObject({ schemaVersion: 2, revision: 'first-run-template-v17' });
    expect(template.bindings).toMatchObject({ schemaVersion: 1, revision: 'first-run-template-v17-bindings', bindings: [] });
  });
  it('grants read tools and the given scratch tool names silently, asks for edit/shell tools, and grants pool use without pool/service management', () => {
    const policy = resolvePolicyBindings(firstRunPolicyTemplate(input).policy, firstRunPolicyTemplate(input).bindings);
    for (const tool of READ_TOOLS) expect(decide(policy, tool, 'read', null)).toMatchObject({ decision: 'allow', relaxation: null });
    expect(decide(policy, 'scratch_write', 'edit', 'workspace.scratch.write')).toMatchObject({ decision: 'allow', relaxation: null });
    for (const tool of ['scratch_read', 'scratch_list']) expect(decide(policy, tool, 'read', null)).toMatchObject({ decision: 'allow', relaxation: null });
    // MODES-3: nobody has an entry yet, so everyone is standart — an ordinary in-project edit runs without a card (the edit rule is
    // mode-eligible), audited as a standart relaxation with no person entry; the write floor and the shell still ask.
    expect(decide(policy, 'edit_file', 'edit', 'workspace.file.write')).toMatchObject({ decision: 'allow', relaxation: { mode: 'standart', person: null } });
    expect(decide(policy, 'write_file', 'edit-floor', 'workspace.file.write')).toMatchObject({ decision: 'require-approval', relaxation: null });
    expect(decide(policy, 'run_shell', 'shell-narrow-mutating', 'host.shell.run')).toMatchObject({ decision: 'require-approval', relaxation: null });
    expect(evaluatePolicy(policy, { principal, scopeId: 'installation', action: 'hold', resource: { kind: 'pool', id: 'default' } }).reason).toBe('NO_GRANT');
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
    const policy = resolvePolicyBindings(openFullAuto(firstRunPolicyTemplate(input).policy),
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
    expect(FIRST_RUN_POLICY_TEMPLATE_VERSION).toBe(17);
    // v8 (BACKUP-COMMAND): installation-wide backup for the installing owner alone.
    expect(template.policy.grants.find(grant => grant.id === 'first-run-backup')).toEqual({ id: 'first-run-backup', effect: 'allow',
      actions: ['create', 'verify', 'restore'], scopes: 'all', principals: [me], resource: { kind: 'backup', ids: 'all' } });
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
    expect(matchFirstRunPolicyTemplate('first-run-template-v8')).toEqual({ id: 'first-run-template', version: 8 });
    expect(matchFirstRunPolicyTemplate('first-run-template-v9')).toEqual({ id: 'first-run-template', version: 9 });
    expect(matchFirstRunPolicyTemplate('first-run-template-v10')).toEqual({ id: 'first-run-template', version: 10 });
    expect(matchFirstRunPolicyTemplate('first-run-template-v11')).toEqual({ id: 'first-run-template', version: 11 });
    expect(matchFirstRunPolicyTemplate('first-run-template-v12')).toEqual({ id: 'first-run-template', version: 12 });
    expect(matchFirstRunPolicyTemplate('first-run-template-v13')).toEqual({ id: 'first-run-template', version: 13 });
    expect(matchFirstRunPolicyTemplate('first-run-template-v14')).toEqual({ id: 'first-run-template', version: 14 });
    expect(matchFirstRunPolicyTemplate('first-run-template-v15')).toEqual({ id: 'first-run-template', version: 15 });
    expect(matchFirstRunPolicyTemplate('first-run-template-v16')).toEqual({ id: 'first-run-template', version: 16 });
    expect(matchFirstRunPolicyTemplate('first-run-template-v17')).toEqual({ id: 'first-run-template', version: 17 });
    expect(matchFirstRunPolicyTemplate('first-run-template-v18')).toBeNull();
    expect(matchFirstRunPolicyTemplate('first-run-template-v0')).toBeNull();
    expect(matchFirstRunPolicyTemplate('')).toBeNull();
  });
});

// Owner 2026-10-07 MCP decisions (Jev 04f75210 authority kind + v5, 71eeb4ab effect, d3d1817d proposal tool).
describe('first-run v5: MCP server authority, trust grant and the proposal tool', () => {
  const template = () => firstRunPolicyTemplate(input);
  const withModes = (policy: unknown, mode?: 'full-auto') => resolvePolicyBindings(mode ? openFullAuto(policy) : policy, mode
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
    return { ...current, revision: 'first-run-template-v4', grants: current.grants.filter(grant => !grant.id.startsWith('first-run-mcp-observe-') && !POST_V15_RULE_IDS.includes(grant.id) && !['first-run-mcp-servers', 'first-run-mcp-call-operation', 'first-run-policy-administer', 'first-run-approvals', 'first-run-secret-switch', 'first-run-model-activation', 'first-run-model-invocation', 'first-run-provider-spending', 'first-run-backup', 'first-run-runs', 'first-run-pools', 'first-run-attempts', 'first-run-work-targets', 'first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt', 'first-run-scope-inspect', 'first-run-service-shutdown', 'first-run-execution-environment-install', 'first-run-installation-repair', 'first-run-model-deactivation', 'first-run-decision-inspect', 'first-run-monitor-scope-diagnostics', 'first-run-standing-grants-all', 'first-run-memory-inspect', 'first-run-memory-propose', 'first-run-memory-distiller', 'first-run-memory-distiller-runs', 'first-run-memory-distiller-output', 'first-run-agent-catalog', 'first-run-memory-review', 'first-run-memory-evaluator', 'first-run-memory-evaluator-runs', 'first-run-memory-evaluator-model', 'first-run-memory-purge', 'first-run-recovery-model', 'first-run-skill-signers', 'first-run-agent-catalog-import', 'first-run-catalog-aggregator', 'first-run-catalog-aggregator-runs', 'first-run-catalog-aggregator-memory'].includes(grant.id))
      .map(grant => grant.id === 'first-run-read-tools' ? { ...grant, resource: { ...grant.resource, ids: rest.readToolNames } } : grant) }; };
  it('exactly this installation\'s v4, v5, v6 or v7 template upgrades to exactly the current (v16) template; v16 is current', () => {
    expect(upgradeFirstRunPolicy(v4(), input)).toEqual({ status: 'upgrade', from: 4, policy: firstRunPolicyTemplate(input).policy });
    const current = firstRunPolicyTemplate(input).policy as { grants: { id: string }[] };
    // v8 = BACKUP-COMMAND (installation-wide backup); v7 = T4-B K3 (model activation + invocation) and SPEND-SETTLEMENT (provider spend accounts) in one template version.
    const v9 = { ...current, revision: 'first-run-template-v9', grants: current.grants.filter(grant => !POST_V15_RULE_IDS.includes(grant.id) && !['first-run-mcp-observe-pool', 'first-run-runs', 'first-run-pools', 'first-run-attempts', 'first-run-work-targets', 'first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt', 'first-run-scope-inspect', 'first-run-service-shutdown', 'first-run-execution-environment-install', 'first-run-installation-repair', 'first-run-model-deactivation', 'first-run-decision-inspect', 'first-run-monitor-scope-diagnostics', 'first-run-standing-grants-all', 'first-run-memory-inspect', 'first-run-mcp-observe-memory', 'first-run-memory-propose', 'first-run-memory-distiller', 'first-run-memory-distiller-runs', 'first-run-memory-distiller-output', 'first-run-agent-catalog', 'first-run-mcp-observe-agent-catalog', 'first-run-memory-review', 'first-run-memory-evaluator', 'first-run-memory-evaluator-runs', 'first-run-memory-evaluator-model', 'first-run-memory-purge', 'first-run-recovery-model', 'first-run-skill-signers', 'first-run-agent-catalog-import', 'first-run-catalog-aggregator', 'first-run-catalog-aggregator-runs', 'first-run-catalog-aggregator-memory'].includes(grant.id)) };
    expect(upgradeFirstRunPolicy(v9, input)).toEqual({ status: 'upgrade', from: 9, policy: firstRunPolicyTemplate(input).policy });
    // v15 = the current template without the v16 recovery cells (alpha.56 D1); v14 = v15 without the v15 delta (S4B-1 + S7 + S4B-3); v13 = v14 without the v14 memory delta (S4); v12 = v13 without the v13 delta (I-POL).
    const v16 = { ...current, revision: 'first-run-template-v16', grants: current.grants.filter(grant => !FIRST_RUN_V17_RULE_IDS.includes(grant.id)) };
    expect(upgradeFirstRunPolicy(v16, input)).toEqual({ status: 'upgrade', from: 16, policy: firstRunPolicyTemplate(input).policy });
    const v15 = { ...current, revision: 'first-run-template-v15', grants: current.grants.filter(grant => !POST_V15_RULE_IDS.includes(grant.id)) };
    expect(upgradeFirstRunPolicy(v15, input)).toEqual({ status: 'upgrade', from: 15, policy: firstRunPolicyTemplate(input).policy });
    const v14 = { ...v15, revision: 'first-run-template-v14', grants: v15.grants.filter(grant => !['first-run-memory-propose', 'first-run-memory-distiller', 'first-run-memory-distiller-runs', 'first-run-memory-distiller-output', 'first-run-agent-catalog', 'first-run-mcp-observe-agent-catalog', 'first-run-memory-review', 'first-run-memory-evaluator', 'first-run-memory-evaluator-runs', 'first-run-memory-evaluator-model', 'first-run-memory-purge', 'first-run-recovery-model', 'first-run-skill-signers', 'first-run-agent-catalog-import', 'first-run-catalog-aggregator', 'first-run-catalog-aggregator-runs', 'first-run-catalog-aggregator-memory'].includes(grant.id)) };
    expect(upgradeFirstRunPolicy(v14, input)).toEqual({ status: 'upgrade', from: 14, policy: firstRunPolicyTemplate(input).policy });
    const v13 = { ...v14, revision: 'first-run-template-v13', grants: v14.grants.filter(grant => !['first-run-memory-inspect', 'first-run-mcp-observe-memory'].includes(grant.id)) };
    expect(upgradeFirstRunPolicy(v13, input)).toEqual({ status: 'upgrade', from: 13, policy: firstRunPolicyTemplate(input).policy });
    const v12 = { ...v13, revision: 'first-run-template-v12', grants: v13.grants.filter(grant => !['first-run-execution-environment-install', 'first-run-installation-repair', 'first-run-model-deactivation', 'first-run-decision-inspect', 'first-run-monitor-scope-diagnostics', 'first-run-standing-grants-all', 'first-run-mcp-observe-pool'].includes(grant.id)) };
    expect(upgradeFirstRunPolicy(v12, input)).toEqual({ status: 'upgrade', from: 12, policy: firstRunPolicyTemplate(input).policy });
    const v8 = { ...v9, revision: 'first-run-template-v8', grants: v9.grants.filter(grant => !grant.id.startsWith('first-run-mcp-observe-')) };
    expect(upgradeFirstRunPolicy(v8, input)).toEqual({ status: 'upgrade', from: 8, policy: firstRunPolicyTemplate(input).policy });
    const v7 = { ...v8, revision: 'first-run-template-v7', grants: v8.grants.filter(grant => grant.id !== 'first-run-backup') };
    expect(upgradeFirstRunPolicy(v7, input)).toEqual({ status: 'upgrade', from: 7, policy: firstRunPolicyTemplate(input).policy });
    const v6 = { ...v7, revision: 'first-run-template-v6', grants: v7.grants.filter(grant => !['first-run-model-activation', 'first-run-model-invocation', 'first-run-provider-spending'].includes(grant.id)) };
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
    return { ...current, revision: 'first-run-template-v4', grants: current.grants.filter(grant => !grant.id.startsWith('first-run-mcp-observe-') && !POST_V15_RULE_IDS.includes(grant.id) && !['first-run-mcp-servers', 'first-run-mcp-call-operation', 'first-run-policy-administer', 'first-run-approvals', 'first-run-secret-switch', 'first-run-model-activation', 'first-run-model-invocation', 'first-run-provider-spending', 'first-run-backup', 'first-run-runs', 'first-run-pools', 'first-run-attempts', 'first-run-work-targets', 'first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt', 'first-run-scope-inspect', 'first-run-service-shutdown', 'first-run-execution-environment-install', 'first-run-installation-repair', 'first-run-model-deactivation', 'first-run-decision-inspect', 'first-run-monitor-scope-diagnostics', 'first-run-standing-grants-all', 'first-run-memory-inspect', 'first-run-memory-propose', 'first-run-memory-distiller', 'first-run-memory-distiller-runs', 'first-run-memory-distiller-output', 'first-run-agent-catalog', 'first-run-memory-review', 'first-run-memory-evaluator', 'first-run-memory-evaluator-runs', 'first-run-memory-evaluator-model', 'first-run-memory-purge', 'first-run-recovery-model', 'first-run-skill-signers', 'first-run-agent-catalog-import', 'first-run-catalog-aggregator', 'first-run-catalog-aggregator-runs', 'first-run-catalog-aggregator-memory'].includes(grant.id))
      .map(grant => grant.id === 'first-run-read-tools' ? { ...grant, resource: { ...grant.resource, ids: READ_TOOLS } } : grant) }; };
  const names = { person: me, proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer', firstCommitOperationId: 'coding.first-commit', executionEnvironmentIds: ['docker'] };
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
      ['first-run-provider-spending', 'provider-spend-account', 'all', ['installation']],
      // v8 (BACKUP-COMMAND): installation-wide backup.
      ['first-run-backup', 'backup', 'all', 'all'],
      ...['run', 'scope', 'approval', 'model-activation', 'model-invocation', 'provider-spend-account'].map(kind => [`first-run-mcp-observe-${kind}`, kind, 'all', ['installation']]),
      ...[['first-run-runs', 'run'], ['first-run-pools', 'pool'], ['first-run-attempts', 'attempt'], ['first-run-work-targets', 'work-target']].map(([id, kind]) => [id, kind, 'all', ['installation']]),
      ['first-run-quota-release', 'pool', 'all', 'all'], ['first-run-integration', 'attempt', 'all', ['installation']], ['first-run-work-target-adopt', 'work-target', 'all', ['installation']],
      // v12 (owner 2026-10-16 option A): the named person's scope inspection and this installation's service stop (default service id).
      ['first-run-scope-inspect', 'scope', ['installation'], ['installation']], ['first-run-service-shutdown', 'service', ['installation-runtime'], ['installation']],
      // v13 (I-POL, owner A48-D3 + MON-NAMES + CA-1 + C3): six rules for the named person, one read for the MCP actor.
      ['first-run-execution-environment-install', 'execution-environment', ['docker'], 'all'], ['first-run-installation-repair', 'installation', 'all', 'all'],
      ['first-run-model-deactivation', 'model-activation', 'all', 'all'], ['first-run-decision-inspect', 'decision', 'all', ['installation']],
      ['first-run-monitor-scope-diagnostics', 'monitor', 'all', 'all'], ['first-run-standing-grants-all', 'policy', 'all', ['installation']],
      ['first-run-mcp-observe-pool', 'pool', 'all', ['installation']]]);
    expect(plan.conflicts).toEqual([]);
    // v14 (S4) and v15 (S4B-1 + S7 + S4B-3 + S4B-4 + S6R-5) make 46 missing rules, above one policy change (POLICY_CHANGE_MAX 32): the first batch names
    // fourteen remaining (the v14 memory reads and the v15 delta), a second run adds them, a third is current.
    expect(plan.rules).toHaveLength(POLICY_CHANGE_MAX); expect(plan.remaining).toBe(27); // S8-5 signers + import, S8-3 aggregator (3), v16's seven action cells (no rule versions in this input)
    const applied = { ...edited, grants: [...edited.grants, ...plan.rules] }, rest = firstRunTemplateAdditions(applied, names);
    expect(rest.status === 'plan' ? [rest.rules.map(rule => rule.id), rest.remaining] : rest).toEqual([['first-run-memory-inspect', 'first-run-mcp-observe-memory', 'first-run-memory-propose', 'first-run-memory-distiller', 'first-run-memory-distiller-runs', 'first-run-memory-distiller-output', 'first-run-agent-catalog', 'first-run-mcp-observe-agent-catalog',
      'first-run-memory-review', 'first-run-memory-evaluator', 'first-run-memory-evaluator-runs', 'first-run-memory-evaluator-model', 'first-run-memory-purge', 'first-run-recovery-model', 'first-run-skill-signers', 'first-run-agent-catalog-import', 'first-run-catalog-aggregator', 'first-run-catalog-aggregator-runs', 'first-run-catalog-aggregator-memory',
      ...POST_V15_RULE_IDS.filter(id => id.startsWith('first-run-recovery-action-')), 'first-run-first-commit'], undefined]);
    expect(firstRunTemplateAdditions({ ...applied, grants: [...applied.grants, ...(rest.status === 'plan' ? rest.rules : [])] }, names)).toEqual({ status: 'current', conflicts: [] });
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
    if (plan.status === 'plan') for (const rule of plan.rules) expect(rule.principals).toEqual([{ issuer: rule.id.startsWith('first-run-mcp-observe-') ? 'os/mcp' : 'os', subject: 'colleague' }]);
  });
  it('a fresh v5 template is current (the proposal tool inside its read rule); a policy without the first-run read rule is not this template', () => {
    expect(firstRunTemplateAdditions(firstRunPolicyTemplate(input).policy, names)).toEqual({ status: 'current', conflicts: [] });
    expect(firstRunTemplateAdditions({ ...v4(), grants: v4().grants.filter(grant => grant.id !== 'first-run-read-tools') }, names)).toEqual({ status: 'unavailable', reason: 'not-first-run' });
    expect(firstRunTemplateAdditions({ nope: 1 }, names)).toEqual({ status: 'unavailable', reason: 'invalid' });
  });
});

describe('W3 MCP policy boundary', () => {
  const mcp = { ...principal, id: `${principal.id}/mcp`, ...mcpPrincipalRef(me) };
  const request = (actor = mcp) => ({ principal: actor, scopeId: 'installation', action: 'budget-revision', resource: { kind: 'provider-spend-account', id: 'budget' } });
  it('does not delegate owner or all-principal grants to MCP; named MCP grants work, restrictions still deny', () => {
    const built = firstRunPolicyTemplate(input), resolved = resolvePolicyBindings(built.policy, built.bindings);
    expect(evaluatePolicy(resolved, request()).decision).toBe('deny');
    expect(evaluatePolicy(resolved, request(principal)).decision).toBe('allow');
    const broad = { id: 'broad', effect: 'allow', principals: 'all', scopes: ['installation'], actions: ['budget-revision'], resource: { kind: 'provider-spend-account', ids: 'all' } };
    const legacy = { schemaVersion: 1, revision: 'legacy', grants: [broad], restrictions: [] };
    expect(evaluatePolicy(legacy, request()).decision).toBe('deny');
    expect(policyScopeGrants(legacy, mcp, ['installation'])).toEqual([]);
    expect(delegationWithin(legacy, mcp, [{ ...broad, principals: [mcpPrincipalRef(me)] }] as never).ok).toBe(false);
    expect(delegationWithin(legacy, principal, [{ ...broad, principals: [mcpPrincipalRef(me)] }] as never).ok).toBe(true);
    const explicit = { ...broad, id: 'explicit-mcp', principals: [mcpPrincipalRef(me)] };
    const granted = { ...legacy, grants: [explicit] };
    expect(evaluatePolicy(granted, request()).decision).toBe('allow');
    expect(evaluatePolicy({ ...granted, restrictions: [{ id: 'restriction', principals: 'all', scopes: ['installation'], actions: ['budget-revision'], resource: broad.resource }] }, request()).decision).toBe('deny');
  });
  it('adds v9 MCP observation and v10 named execution to custom v8 policies, preserving existing rules', () => {
    const current = firstRunPolicyTemplate(input).policy;
    const old = { ...current, revision: 'custom-v8', grants: current.grants.filter(rule => !rule.id.startsWith('first-run-mcp-observe-') && !['first-run-runs', 'first-run-pools', 'first-run-attempts', 'first-run-work-targets', 'first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt'].includes(rule.id)) };
    const names = { person: me, proposeMcpToolName: input.proposeMcpToolName, mcpCallOperationId: input.mcpCallOperationId, policyAdministerOperationId: input.policyAdministerOperationId };
    const plan = firstRunTemplateAdditions(old, names);
    expect(plan.status).toBe('plan'); if (plan.status !== 'plan') return;
    // v13 (I-POL) adds the seventh MCP observation rule, `pool/inspect`; v14 (S4) the eighth, `memory/inspect`; v15 (S7) the ninth, `agent-catalog/inspect`.
    expect(plan.rules).toHaveLength(16);
    const observation = plan.rules.filter(rule => rule.id.startsWith('first-run-mcp-observe-'));
    expect(observation).toHaveLength(9);
    for (const rule of observation) expect(rule).toMatchObject({ effect: 'allow', actions: ['inspect'], principals: [mcpPrincipalRef(me)] });
    for (const rule of plan.rules.filter(rule => !observation.includes(rule))) expect(rule.principals).toEqual([me]);
    const next = { ...old, grants: [...old.grants, ...plan.rules] };
    expect(next.grants.slice(0, old.grants.length)).toEqual(old.grants);
    expect(firstRunTemplateAdditions(next, names)).toEqual({ status: 'current', conflicts: [] });
  });
});

it('does not present the MCP actor as an installing person or upgrade its observation grants into owner authority', () => {
  const policy = firstRunPolicyTemplate(input).policy;
  expect(policyNamedPeople(policy, 'installation', 20)).toEqual([me]);
  expect(namedPersonPolicyAdditions(policy, { person: mcpPrincipalRef(me), scopeId: 'installation',
    proposeMcpToolName: input.proposeMcpToolName, mcpCallOperationId: input.mcpCallOperationId, policyAdministerOperationId: input.policyAdministerOperationId }))
    .toEqual({ status: 'unavailable', reason: 'person-not-named' });
});

const EXECUTION = [
  { id: 'first-run-runs', kind: 'run', actions: ['create', 'reserve', 'inspect', 'cancel'] },
  { id: 'first-run-pools', kind: 'pool', actions: ['use', 'inspect'] },
  { id: 'first-run-attempts', kind: 'attempt', actions: ['execute', 'evaluate', 'read-output', 'recover-output', 'cancel', 'reconcile', 'release'] },
  { id: 'first-run-work-targets', kind: 'work-target', actions: ['use'] },
];
describe('v10 named execution authority', () => {
  it.each(EXECUTION)('$kind: fresh and upgraded policies allow exactly the named person in scope', ({ id, kind, actions }) => {
    const built = firstRunPolicyTemplate(input);
    const older = { ...built.policy, revision: 'custom-v9', grants: built.policy.grants.filter(rule => !EXECUTION.some(wanted => wanted.id === rule.id)) };
    const names = { person: me, proposeMcpToolName: input.proposeMcpToolName, mcpCallOperationId: input.mcpCallOperationId, policyAdministerOperationId: input.policyAdministerOperationId };
    const plan = firstRunTemplateAdditions(older, names);
    expect(plan.status).toBe('plan'); if (plan.status !== 'plan') throw new Error('missing v10 plan');
    expect(plan.rules.map(rule => rule.id)).toEqual(EXECUTION.map(rule => rule.id));
    const upgraded = { ...older, grants: [...older.grants, ...plan.rules] };
    expect(firstRunTemplateAdditions(upgraded, names)).toEqual({ status: 'current', conflicts: [] });
    expect(built.policy.grants.find(rule => rule.id === id)).toEqual({ id, effect: 'allow', actions, scopes: ['installation'], principals: [me], resource: { kind, ids: 'all' } });
    for (const current of [built.policy, upgraded]) {
      const policy = resolvePolicyBindings(current, built.bindings);
      for (const action of actions) {
        const request = { principal, scopeId: 'installation', action, resource: { kind, id: 'any-resource' } };
        expect(evaluatePolicy(policy, request)).toMatchObject({ decision: 'allow', ruleId: id });
        expect(evaluatePolicy(policy, { ...request, principal: { ...principal, subject: 'other', id: 'other' } }).decision).toBe('deny');
        expect(evaluatePolicy(policy, { ...request, principal: { ...principal, scopeIds: ['installation', 'elsewhere'] }, scopeId: 'elsewhere' }).decision).toBe('deny');
        const mcp = { ...principal, id: 'mcp', ...mcpPrincipalRef(me) };
        // The MCP actor only observes: run inspect since v9, pool inspect since v13 (I-POL, A48-D3e).
        expect(evaluatePolicy(policy, { ...request, principal: mcp }).decision).toBe((kind === 'run' || kind === 'pool') && action === 'inspect' ? 'allow' : 'deny');
        const restricted = { ...policy, restrictions: [{ id: 'company-deny', actions: [action], principals: [me], scopes: ['installation'], resource: { kind, ids: 'all' } }] };
        expect(evaluatePolicy(restricted, request).decision).toBe('deny');
      }
    }
  });

  it('v10 does not grant pool management, integration/adoption, task or decision authority', () => {
    const built = firstRunPolicyTemplate(input), v10 = { ...built.policy, revision: 'first-run-template-v10',
      grants: built.policy.grants.filter(rule => !['first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt', 'first-run-decision-inspect'].includes(rule.id)) };
    const policy = resolvePolicyBindings(v10, built.bindings);
    for (const [kind, action] of [['pool', 'hold'], ['pool', 'resume'], ['pool', 'set-capacity'], ['attempt', 'prepare-integration'], ['attempt', 'apply-integration'],
      ['attempt', 'adopt'], ['task', 'execute'], ['decision', 'consult'], ['decision', 'record-outcome']]) {
      expect(evaluatePolicy(policy, { principal, scopeId: 'installation', action: action!, resource: { kind: kind!, id: 'any' } }).decision).toBe('deny');
    }
    // v13 (I-POL, A48-D3d) adds only decision reads in the installed scope (bare `deckent decide`); no task or other decision authority.
    expect(built.policy.grants.filter(rule => rule.resource.kind === 'task' || rule.resource.kind === 'decision')).toEqual([{ id: 'first-run-decision-inspect', effect: 'allow',
      actions: ['inspect'], scopes: ['installation'], principals: [me], resource: { kind: 'decision', ids: 'all' } }]);
  });

  it('keeps v10 conflicts, counts existing coverage, and never upgrades an MCP anchor to owner execution', () => {
    const built = firstRunPolicyTemplate(input), names = { person: me, proposeMcpToolName: input.proposeMcpToolName, mcpCallOperationId: input.mcpCallOperationId, policyAdministerOperationId: input.policyAdministerOperationId };
    expect(firstRunPolicyTemplate({ ...input, principal: mcpPrincipalRef(me) }).policy.grants.filter(rule => EXECUTION.some(want => want.id === rule.id))).toEqual([]);
    const old = { ...built.policy, grants: built.policy.grants.filter(rule => !EXECUTION.some(want => want.id === rule.id)) };
    const conflicting = { id: 'first-run-runs', effect: 'allow', actions: ['inspect'], principals: [me], scopes: ['installation'], resource: { kind: 'run', ids: ['one'] } };
    const covered = { id: 'custom-pool', effect: 'allow', actions: ['use', 'inspect'], principals: [me], scopes: ['installation'], resource: { kind: 'pool', ids: 'all' } };
    const plan = firstRunTemplateAdditions({ ...old, grants: [...old.grants, conflicting, covered] }, names);
    expect(plan).toMatchObject({ status: 'plan', conflicts: ['first-run-runs'] });
    if (plan.status !== 'plan') throw new Error('missing v10 plan');
    expect(plan.rules.map(rule => rule.id)).toEqual(['first-run-attempts', 'first-run-work-targets']);
    const anchoredMcp = { ...old, grants: old.grants.map(rule => rule.id === 'first-run-read-tools' ? { ...rule, principals: [mcpPrincipalRef(me)] } : rule) };
    expect(firstRunTemplateAdditions(anchoredMcp, { ...names, person: mcpPrincipalRef(me) })).toEqual({ status: 'unavailable', reason: 'not-this-person' });
  });
});

it('U4E G1: historical v4–v16 policies remain exact; v17 adds and rolls back only the named person first-commit grant', () => {
  // Frozen from c1e5f8fab's private historical generator, before the v17 edit; no current production formula builds the oracle.
  const source = { ...history.input, firstCommitOperationId: 'coding.first-commit' }, current = firstRunPolicyTemplate(source);
  const rules = new Map<string, unknown>();
  for (const row of history.versions) {
    for (const rule of row.changed) rules.set(rule.id, rule);
    const old = { ...history.policy, revision: `first-run-template-v${row.version}`, grants: [...rules.values()] };
    expect(upgradeFirstRunPolicy(old, source), `v${row.version}`).toEqual({ status: 'upgrade', from: row.version, policy: current.policy });
  }
  const added = current.policy.grants.filter(rule => !rules.has(rule.id));
  expect(added).toEqual([{ id: 'first-run-first-commit', effect: 'allow', actions: ['execute'], scopes: ['installation'],
    principals: [{ issuer: 'os', subject: '1000' }], resource: { kind: 'operation', ids: ['coding.first-commit'] } }]);
  const resolved = resolvePolicyBindings(current.policy, current.bindings);
  const ask = { principal: { ...history.input.principal, id: 'person', assurance: 'os-user' as const, scopeIds: ['installation', 'other'] },
    scopeId: 'installation', action: 'execute', resource: { kind: 'operation', id: 'coding.first-commit' } };
  expect(evaluatePolicy(resolved, ask).decision).toBe('allow');
  expect(evaluatePolicy(resolved, { ...ask, scopeId: 'other' }).decision).toBe('deny');
  expect(evaluatePolicy(resolved, { ...ask, action: 'compensate' }).decision).toBe('deny');
  expect(evaluatePolicy(resolved, { ...ask, principal: { ...ask.principal, ...mcpPrincipalRef(history.input.principal) } }).decision).toBe('deny');
  expect(firstRunPolicyTemplate({ ...source, principal: mcpPrincipalRef(history.input.principal) }).policy.grants.some(rule => rule.id === 'first-run-first-commit')).toBe(false);
  const broadened = { ...current.policy, grants: current.policy.grants.filter(rule => rule.id !== 'first-run-first-commit')
    .map(rule => rule.id === 'first-run-read-tools' ? { ...rule, scopes: ['installation', 'other'] } : rule) };
  const scopedUpgrade = firstRunTemplateAdditions(broadened, { ...source, person: history.input.principal });
  expect(scopedUpgrade.status === 'plan' ? scopedUpgrade.rules.filter(rule => rule.id === 'first-run-first-commit') : null).toEqual(added);
  const rollback = firstRunTemplateRollback(current.policy, history.input.principal, 'installation', undefined, source.firstCommitOperationId);
  expect(rollback.rules).toEqual(added); expect(rollback.conflicts).toEqual([]);
  const customized = { ...current.policy, grants: current.policy.grants.map(rule => rule.id === added[0]!.id ? { ...rule, actions: ['inspect'] } : rule) };
  expect(firstRunTemplateRollback(customized, history.input.principal, 'installation', undefined, source.firstCommitOperationId)).toMatchObject({ rules: [], conflicts: ['first-run-first-commit'] });
});
