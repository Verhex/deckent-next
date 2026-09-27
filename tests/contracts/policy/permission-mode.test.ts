import { describe, expect, it } from 'vitest';
import { bindingsFileSchema, modeEligibleApproval, policyFileSchema, principalPermissionMode, resolvePolicyBindings } from '#domain/index.js';
import { decideAgentToolCall, type AgentToolCallCell } from '#engine/index.js';

// T-L4 slice 4a: the company marks a require-approval rule mode-eligible (policy v2); the person's mode lives in bindings v2; one
// pure function decides a tool call: strict policy → floor raise → mode lowering only on an eligible require-approval of a relaxable cell.
const me = { issuer: 'host', subject: '1000' };
const principal = { id: 'os:1000', ...me, assurance: 'os-user' as const, scopeIds: ['scope', 'other'] };
type Effect = 'allow' | 'deny' | 'require-approval';
const rule = (id: string, kind: string, ids: string[], effect: Effect, eligible?: boolean, actions = kind === 'operation' ? ['execute'] : ['invoke']) =>
  ({ id, effect, actions, scopes: ['scope'], principals: [me], resource: { kind, ids }, ...(eligible === undefined ? {} : { modeEligible: eligible }) });
const policyOf = (grants: unknown[], modes: unknown[] | null, roles: unknown[] = [], bindings: unknown[] = []) => resolvePolicyBindings(
  { schemaVersion: 2, revision: 'p', roles, separationOfDuties: [], restrictions: [], grants },
  modes === null ? { schemaVersion: 1, revision: 'b', bindings } : { schemaVersion: 2, revision: 'b', bindings, modes });
const person = (mode: string, scopes = ['scope'], id = 'me-mode', who = me) => ({ id, principal: who, scopes, mode });
const editGrants = (tool: Effect, op: Effect, eligible: { tool?: boolean; op?: boolean } = {}) =>
  [rule('edit-tool', 'agent-tool', ['edit_file'], tool, eligible.tool), rule('file-write', 'operation', ['workspace.file.write'], op, eligible.op)];
const decide = (policy: unknown, cell: AgentToolCallCell, tool = 'edit_file', operation: string | null = cell === 'read' ? null
  : cell.startsWith('shell') ? 'host.shell.run' : 'workspace.file.write') =>
  decideAgentToolCall(policy, { principal, scopeId: 'scope', tool: { name: tool }, operation: operation ? { id: operation } : null, cell });

describe('permission-mode policy data (T-L4 slice 4a)', () => {
  it('accepts modeEligible only on a v2 require-approval rule (grant or role permission)', () => {
    const v2 = (grants: unknown[], roles: unknown[] = []) => policyFileSchema.safeParse({ schemaVersion: 2, revision: 'p', roles, separationOfDuties: [], restrictions: [], grants }).success;
    expect(v2([rule('a', 'agent-tool', ['edit_file'], 'require-approval', true)])).toBe(true);
    expect(v2([rule('a', 'agent-tool', ['edit_file'], 'require-approval', false)])).toBe(true);
    expect(v2([rule('a', 'agent-tool', ['edit_file'], 'allow', true)])).toBe(false);
    expect(v2([rule('a', 'agent-tool', ['edit_file'], 'deny', true)])).toBe(false);
    expect(v2([], [{ id: 'dev', permissions: [{ id: 'edit', effect: 'require-approval', actions: ['invoke'], resource: { kind: 'agent-tool', ids: ['edit_file'] }, modeEligible: true }] }])).toBe(true);
    expect(v2([], [{ id: 'dev', permissions: [{ id: 'edit', effect: 'allow', actions: ['invoke'], resource: { kind: 'agent-tool', ids: ['edit_file'] }, modeEligible: true }] }])).toBe(false);
    // v1 is unchanged: the field does not exist there.
    expect(policyFileSchema.safeParse({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [rule('a', 'agent-tool', ['edit_file'], 'require-approval', true)] }).success).toBe(false);
    const restriction = { id: 'r', actions: ['invoke'], scopes: ['scope'], principals: [me], resource: { kind: 'agent-tool', ids: ['edit_file'] } };
    const withRestrictions = (restrictions: unknown[]) => policyFileSchema.safeParse({ schemaVersion: 2, revision: 'p', roles: [], separationOfDuties: [], grants: [], restrictions }).success;
    expect(withRestrictions([restriction])).toBe(true);
    expect(withRestrictions([{ ...restriction, modeEligible: true }])).toBe(false);
  });

  it('reads bindings v1 unchanged and v2 modes of one principal over explicit scopes', () => {
    expect(bindingsFileSchema.safeParse({ schemaVersion: 1, revision: 'b', bindings: [] }).success).toBe(true);
    expect(bindingsFileSchema.safeParse({ schemaVersion: 1, revision: 'b', bindings: [], modes: [person('auto-edit')] }).success).toBe(false);
    expect(bindingsFileSchema.safeParse({ schemaVersion: 2, revision: 'b', bindings: [], modes: [person('auto-edit')] }).success).toBe(true);
    for (const bad of [person('yolo'), person('auto-edit', 'all' as never), person('auto-edit', []), { ...person('auto-edit'), principal: [me] },
      { ...person('auto-edit'), principal: 'all' }, { ...person('auto-edit'), extra: true }]) {
      expect(bindingsFileSchema.safeParse({ schemaVersion: 2, revision: 'b', bindings: [], modes: [bad] }).success).toBe(false);
    }
    expect(bindingsFileSchema.safeParse({ schemaVersion: 2, revision: 'b', bindings: [], modes: [person('ask'), person('full-auto')] }).success).toBe(false);
    // No selection shorthand: a mode names explicit scopes (the field itself refuses 'all').
    const all = bindingsFileSchema.safeParse({ schemaVersion: 2, revision: 'b', bindings: [], modes: [person('auto-edit', 'all' as never)] });
    const paths = all.success ? [] : all.error.issues.flatMap(issue => 'unionErrors' in issue ? issue.unionErrors.flatMap(error => error.issues) : [issue])
      .map(issue => issue.path.join('.'));
    expect(paths).toContain('modes.0.scopes');
  });

  it('resolves exactly one mode entry for the person and scope; none, two or ask is null (fail closed)', () => {
    expect(principalPermissionMode(policyOf([], [person('auto-edit')]), me, 'scope')).toEqual({ mode: 'auto-edit', id: 'me-mode' });
    expect(principalPermissionMode(policyOf([], [person('auto-edit')]), me, 'other')).toBeNull();
    expect(principalPermissionMode(policyOf([], [person('auto-edit')]), { issuer: 'host', subject: '1001' }, 'scope')).toBeNull();
    expect(principalPermissionMode(policyOf([], [person('ask')]), me, 'scope')).toBeNull();
    expect(principalPermissionMode(policyOf([], [person('auto-edit'), person('full-auto', ['scope'], 'second')]), me, 'scope')).toBeNull();
    expect(principalPermissionMode(policyOf([], null), me, 'scope')).toBeNull();
    expect(principalPermissionMode({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [] }, me, 'scope')).toBeNull();
  });

  it('names every matching require-approval rule only when all are eligible; an allow rule never adds eligibility', () => {
    const request = { principal, scopeId: 'scope', action: 'invoke', resource: { kind: 'agent-tool', id: 'edit_file' } };
    expect(modeEligibleApproval(policyOf(editGrants('require-approval', 'allow', { tool: true }), null), request)).toEqual(['edit-tool']);
    expect(modeEligibleApproval(policyOf([...editGrants('require-approval', 'allow', { tool: true }), rule('second', 'agent-tool', ['edit_file'], 'require-approval')], null), request)).toBeNull();
    expect(modeEligibleApproval(policyOf([...editGrants('require-approval', 'allow'), rule('extra-allow', 'agent-tool', ['edit_file'], 'allow')], null), request)).toBeNull();
    expect(modeEligibleApproval(policyOf([...editGrants('require-approval', 'allow', { tool: true }), rule('no', 'agent-tool', ['edit_file'], 'deny')], null), request)).toBeNull();
  });
});

describe('the one permission decision of an agent tool call (T-L4 slice 4a)', () => {
  it('lowers an eligible require-approval on an ordinary edit in auto-edit and full-auto, never in ask', () => {
    for (const mode of ['auto-edit', 'full-auto']) {
      expect(decide(policyOf(editGrants('require-approval', 'allow', { tool: true }), [person(mode)]), 'edit')).toEqual({ decision: 'allow', revision: 'p+b',
        relaxation: { mode, cell: 'edit-non-floor', company: 'edit-tool', person: 'me-mode' } });
    }
    expect(decide(policyOf(editGrants('require-approval', 'require-approval', { tool: true, op: true }), [person('auto-edit')]), 'edit').relaxation)
      .toMatchObject({ company: 'edit-tool+file-write' });
    expect(decide(policyOf(editGrants('require-approval', 'allow', { tool: true }), [person('ask')]), 'edit')).toMatchObject({ decision: 'require-approval', relaxation: null });
    expect(decide(policyOf(editGrants('require-approval', 'allow', { tool: true }), null), 'edit')).toMatchObject({ decision: 'require-approval', relaxation: null });
  });

  it('never lowers deny, the floor, low, destructive, always-ask, other modify, a read tool or a read-only command (M1, M2, M5)', () => {
    const eligible = (cell: AgentToolCallCell) => cell === 'read' ? [rule('read', 'agent-tool', ['edit_file'], 'require-approval', true)]
      : cell.startsWith('shell') ? [rule('shell-tool', 'agent-tool', ['edit_file'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'require-approval', true)]
        : editGrants('require-approval', 'require-approval', { tool: true, op: true });
    for (const cell of ['read', 'edit-floor', 'shell-read-none', 'shell-read-low', 'shell-destructive', 'shell-always-ask', 'shell-other-modify'] as const) {
      for (const mode of ['ask', 'auto-edit', 'full-auto']) {
        expect({ cell, mode, ...decide(policyOf(eligible(cell), [person(mode)]), cell) }).toMatchObject({ cell, mode, decision: 'require-approval', relaxation: null });
      }
    }
    for (const mode of ['ask', 'auto-edit', 'full-auto']) {
      expect(decide(policyOf(editGrants('deny', 'require-approval', { op: true }), [person(mode)]), 'edit')).toMatchObject({ decision: 'deny', relaxation: null });
      expect(decide(policyOf(editGrants('require-approval', 'deny', { tool: true }), [person(mode)]), 'edit')).toMatchObject({ decision: 'deny', relaxation: null });
      // Allow everywhere: the floor raise still asks, and no eligible rule produced it, so no mode lowers it.
      expect(decide(policyOf(editGrants('allow', 'allow'), [person(mode)]), 'edit-floor')).toMatchObject({ decision: 'require-approval', relaxation: null });
      expect(decide(policyOf([rule('shell-tool', 'agent-tool', ['edit_file'], 'allow'), rule('shell-run', 'operation', ['host.shell.run'], 'allow')], [person(mode)]),
        'shell-narrow-mutating')).toMatchObject({ decision: 'require-approval', relaxation: null });
    }
  });

  it('lowers the narrow mutating shell cell in full-auto only', () => {
    const grants = [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'allow')];
    expect(decide(policyOf(grants, [person('full-auto')]), 'shell-narrow-mutating', 'run_shell')).toMatchObject({ decision: 'allow',
      relaxation: { mode: 'full-auto', cell: 'shell-modify', company: 'shell-tool' } });
    expect(decide(policyOf(grants, [person('auto-edit')]), 'shell-narrow-mutating', 'run_shell')).toMatchObject({ decision: 'require-approval', relaxation: null });
  });

  it('never lowers an operation the company did not mark, nor through a second allow or a second unmarked rule (M6, M7)', () => {
    const erp = [rule('edit-tool', 'agent-tool', ['edit_file'], 'require-approval', true), rule('erp', 'operation', ['erp.invoice.post'], 'require-approval')];
    expect(decide(policyOf(erp, [person('full-auto')]), 'edit', 'edit_file', 'erp.invoice.post')).toMatchObject({ decision: 'require-approval', relaxation: null });
    expect(decide(policyOf([...editGrants('require-approval', 'allow'), rule('edit-allow', 'agent-tool', ['edit_file'], 'allow')], [person('full-auto')]), 'edit'))
      .toMatchObject({ decision: 'require-approval', relaxation: null });
    expect(decide(policyOf([...editGrants('require-approval', 'allow', { tool: true }), rule('unmarked', 'agent-tool', ['edit_file'], 'require-approval')],
      [person('full-auto')]), 'edit')).toMatchObject({ decision: 'require-approval', relaxation: null });
    // Another person's mode never applies; an operation unknown to the policy is no grant (deny), not a lowering.
    expect(decide(policyOf(editGrants('require-approval', 'allow', { tool: true }), [person('full-auto', ['scope'], 'theirs', { issuer: 'host', subject: '1001' })]), 'edit'))
      .toMatchObject({ decision: 'require-approval', relaxation: null });
    expect(decide(policyOf([rule('edit-tool', 'agent-tool', ['edit_file'], 'require-approval', true)], [person('full-auto')]), 'edit')).toMatchObject({ decision: 'deny' });
  });

  it('lowers a role-derived eligible rule of the person (Enterprise layering path), and names the derived rule', () => {
    const roles = [{ id: 'dev', permissions: [{ id: 'edit', effect: 'require-approval', actions: ['invoke'], resource: { kind: 'agent-tool', ids: ['edit_file'] }, modeEligible: true }] }];
    const policy = policyOf([rule('file-write', 'operation', ['workspace.file.write'], 'allow')], [person('auto-edit')], roles,
      [{ id: 'devs', principals: [me], roles: ['dev'], scopes: ['scope'] }]);
    expect(decide(policy, 'edit')).toMatchObject({ decision: 'allow', relaxation: { company: 'devs/dev/edit', person: 'me-mode' } });
  });
});
