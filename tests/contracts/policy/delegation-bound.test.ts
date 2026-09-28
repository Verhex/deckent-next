import { describe, expect, it } from 'vitest';
import { delegationWithin, getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID, kindCovers, planPolicyChange, resolvePolicyBindings,
  type PolicyChange } from '#domain/index.js';

// POLICY-ADMIN P1: a principal grants, delegates or revokes only what its own effective authority holds (kind, actions, ids, scopes),
// evaluated in the evaluator's order; the owner root is data (a role), never a code branch.
const owner = { issuer: 'host', subject: '1000' }, member = { issuer: 'host', subject: '2000' }, other = { issuer: 'host', subject: '3000' };
const grant = (id: string, principal: typeof owner, extra: Record<string, unknown> = {}) => ({ id, effect: 'allow', actions: ['invoke'], scopes: ['s1'],
  principals: [principal], resource: { kind: 'agent-tool', ids: ['read_file'] }, ...extra });
const kinds = getPolicyVocabulary().resources.map(resource => resource.kind);
const policyFile = (grants: unknown[], roles: unknown[] = [], restrictions: unknown[] = []) => ({ schemaVersion: 2, revision: 'p1', roles: [
  { id: INSTALLATION_OWNER_ROLE_ID, permissions: installationOwnerPermissions(kinds) }, ...roles], grants, restrictions, separationOfDuties: [] });
const bindingsFile = (extra: unknown[] = []) => ({ schemaVersion: 2, revision: 'b1', modes: [],
  bindings: [{ id: 'root', principals: [owner], roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' }, ...extra] });
const files = (grants: unknown[] = [], roles: unknown[] = [], restrictions: unknown[] = [], bindings: unknown[] = []) =>
  ({ policy: policyFile(grants, roles, restrictions), bindings: bindingsFile(bindings) });
const change = (...changes: unknown[]) => ({ schemaVersion: 1, changes }) as PolicyChange;
/** The verdict for `actor` over the snapshot the change is planned on. */
function verdict(input: ReturnType<typeof files>, actor: typeof owner, value: PolicyChange) {
  const plan = planPolicyChange(input.policy, input.bindings, value);
  return delegationWithin(resolvePolicyBindings(input.policy, input.bindings), actor, plan.touched);
}

describe('delegation bound (POLICY-ADMIN P1)', () => {
  it('lets the owner root (installation-owner role, every vocabulary kind) grant and bind any vocabulary cell, through the evaluator data only', () => {
    const f = files();
    expect(verdict(f, owner, change({ kind: 'grant.add', grant: grant('m-read', member, { resource: { kind: 'agent-tool', ids: 'all' }, actions: 'all', scopes: 'all' }) })))
      .toEqual({ ok: true });
    for (const kind of kinds) {
      expect(verdict(f, owner, change({ kind: 'grant.add', grant: grant(`g-${kind}`, member, { resource: { kind, ids: 'all' }, actions: 'all' }) })), kind).toEqual({ ok: true });
    }
    expect(verdict(f, owner, change({ kind: 'binding.add', binding: { id: 'm-owner', principals: [member], roles: [INSTALLATION_OWNER_ROLE_ID], scopes: ['s1'] } })))
      .toEqual({ ok: true });
    // Tür eşleşmesi bugün eşitliktir (U2 biçimi): kök rolün adlandırmadığı bir uzantı türü kapsanmaz — U1 ('all' türü) kararı bunu değiştirir.
    expect(kindCovers('agent-tool', 'agent-tool')).toBe(true);
    expect(kindCovers('agent-tool', 'erp.order')).toBe(false);
    expect(verdict(f, owner, change({ kind: 'grant.add', grant: grant('ext', member, { resource: { kind: 'erp.order', ids: 'all' } }) })))
      .toMatchObject({ ok: false, ruleId: 'ext', reason: 'no-grant' });
    // A non-owner holds nothing here: every grant exceeds.
    expect(verdict(f, member, change({ kind: 'grant.add', grant: grant('self', member) }))).toMatchObject({ ok: false, ruleId: 'self', reason: 'no-grant' });
  });

  it('bounds every dimension by the grantor\'s own allow: kind, actions, ids, scopes; \'all\' only from \'all\'', () => {
    const f = files([grant('mine', member, { resource: { kind: 'agent-tool', ids: ['read_file', 'grep'] } })]);
    expect(verdict(f, member, change({ kind: 'grant.add', grant: grant('share', other) }))).toEqual({ ok: true });
    expect(verdict(f, member, change({ kind: 'grant.add', grant: grant('share', member) }))).toEqual({ ok: true });
    const exceeds = (value: Record<string, unknown>) => verdict(f, member, change({ kind: 'grant.add', grant: grant('wide', other, value) }));
    expect(exceeds({ resource: { kind: 'agent-tool', ids: ['edit_file'] } })).toMatchObject({ ok: false, ruleId: 'wide', reason: 'no-grant' });
    expect(exceeds({ resource: { kind: 'agent-tool', ids: 'all' } })).toMatchObject({ ok: false, reason: 'no-grant' });
    expect(exceeds({ scopes: ['s2'] })).toMatchObject({ ok: false, reason: 'no-grant' });
    expect(exceeds({ scopes: 'all' })).toMatchObject({ ok: false, reason: 'no-grant' });
    expect(exceeds({ actions: 'all' })).toMatchObject({ ok: false, reason: 'no-grant' });
    expect(exceeds({ resource: { kind: 'operation', ids: ['read_file'] } })).toMatchObject({ ok: false, reason: 'no-grant' });
    // A rule for other principals is not the grantor's authority.
    const theirs = files([grant('theirs', other)]);
    expect(verdict(theirs, member, change({ kind: 'grant.add', grant: grant('take', member) }))).toMatchObject({ ok: false, reason: 'no-grant' });
  });

  it('keeps require-approval at most require-approval, gives modeEligible only from an eligible rule, and never passes the grantor\'s own deny', () => {
    const asked = files([grant('asked', member, { effect: 'require-approval' })]);
    expect(verdict(asked, member, change({ kind: 'grant.add', grant: grant('x', other) }))).toMatchObject({ ok: false, ruleId: 'x', reason: 'require-approval' });
    expect(verdict(asked, member, change({ kind: 'grant.add', grant: grant('x', other, { effect: 'require-approval' }) }))).toEqual({ ok: true });
    expect(verdict(asked, member, change({ kind: 'grant.add', grant: grant('x', other, { effect: 'require-approval', modeEligible: true }) })))
      .toMatchObject({ ok: false, reason: 'mode-eligible' });
    const eligible = files([grant('asked', member, { effect: 'require-approval', modeEligible: true })]);
    expect(verdict(eligible, member, change({ kind: 'grant.add', grant: grant('x', other, { effect: 'require-approval', modeEligible: true }) }))).toEqual({ ok: true });
    // Deny wins over the grantor's allow, from an explicit deny grant or a company restriction, even partially overlapping.
    const denied = files([grant('mine', member, { resource: { kind: 'agent-tool', ids: 'all' } }), grant('no', member, { effect: 'deny' })]);
    expect(verdict(denied, member, change({ kind: 'grant.add', grant: grant('x', other, { resource: { kind: 'agent-tool', ids: ['read_file', 'grep'] } }) })))
      .toMatchObject({ ok: false, reason: 'deny' });
    const restricted = files([grant('mine', member)], [], [{ id: 'lock', actions: 'all', scopes: ['s1'], principals: 'all', resource: { kind: 'agent-tool', ids: 'all' } }]);
    expect(verdict(restricted, member, change({ kind: 'grant.add', grant: grant('x', other) }))).toMatchObject({ ok: false, reason: 'deny' });
    // The owner root is bound by a deny too: no bypass.
    const lockedOwner = files([], [], [{ id: 'lock', actions: 'all', scopes: ['s1'], principals: [owner], resource: { kind: 'agent-tool', ids: ['run_shell'] } }]);
    expect(verdict(lockedOwner, owner, change({ kind: 'grant.add', grant: grant('x', member, { resource: { kind: 'agent-tool', ids: ['run_shell'] } }) })))
      .toMatchObject({ ok: false, reason: 'deny' });
  });

  it('bounds removals and replacements the same way: a principal revokes only what it could grant, and cannot lift its own deny', () => {
    const f = files([grant('mine', member), grant('given', other), grant('wide', other, { resource: { kind: 'agent-tool', ids: ['edit_file'] } }),
      grant('no', member, { effect: 'deny', resource: { kind: 'agent-tool', ids: ['edit_file'] } })]);
    expect(verdict(f, member, change({ kind: 'grant.remove', id: 'given' }))).toEqual({ ok: true });
    expect(verdict(f, member, change({ kind: 'grant.remove', id: 'wide' }))).toMatchObject({ ok: false, ruleId: 'wide', reason: 'deny' });
    expect(verdict(f, member, change({ kind: 'grant.remove', id: 'no' }))).toMatchObject({ ok: false, ruleId: 'no', reason: 'deny' });
    expect(verdict(f, member, change({ kind: 'grant.replace', grant: grant('given', other, { scopes: ['s2'] }) }))).toMatchObject({ ok: false, ruleId: 'given', reason: 'no-grant' });
    expect(verdict(f, owner, change({ kind: 'grant.remove', id: 'wide' }))).toEqual({ ok: true });
  });

  it('bounds a role binding by every permission of the role at the binding\'s scopes (K5: binding oneself to a wider role exceeds)', () => {
    const roles = [{ id: 'reader', permissions: [{ id: 'read', effect: 'allow', actions: ['invoke'], resource: { kind: 'agent-tool', ids: ['read_file'] } }] },
      { id: 'editor', permissions: [{ id: 'read', effect: 'allow', actions: ['invoke'], resource: { kind: 'agent-tool', ids: ['read_file'] } },
        { id: 'edit', effect: 'allow', actions: ['invoke'], resource: { kind: 'agent-tool', ids: ['edit_file'] } }] }];
    const f = files([grant('mine', member)], roles);
    expect(verdict(f, member, change({ kind: 'binding.add', binding: { id: 'b-other', principals: [other], roles: ['reader'], scopes: ['s1'] } }))).toEqual({ ok: true });
    expect(verdict(f, member, change({ kind: 'binding.add', binding: { id: 'b-other', principals: [other], roles: ['reader'], scopes: 'all' } })))
      .toMatchObject({ ok: false, reason: 'no-grant' });
    expect(verdict(f, member, change({ kind: 'binding.add', binding: { id: 'b-self', principals: [member], roles: ['editor'], scopes: ['s1'] } })))
      .toMatchObject({ ok: false, ruleId: 'b-self/editor/edit', reason: 'no-grant' });
    // Revoking another person's binding needs the same authority; the owner may.
    const bound = files([grant('mine', member)], roles, [], [{ id: 'b-edit', principals: [other], roles: ['editor'], scopes: ['s1'] }]);
    expect(verdict(bound, member, change({ kind: 'binding.remove', id: 'b-edit' }))).toMatchObject({ ok: false, reason: 'no-grant' });
    expect(verdict(bound, owner, change({ kind: 'binding.remove', id: 'b-edit' }))).toEqual({ ok: true });
  });

  it('plans typed, bounded changes: the next documents, the write order, and typed refusals for invalid or oversized changes', () => {
    const f = files([grant('mine', member)]);
    const added = planPolicyChange(f.policy, f.bindings, change({ kind: 'grant.add', grant: grant('share', other) }));
    expect(added.order).toBe('policy-first'); expect(added.bindings).toBeNull();
    expect(added.policy?.grants.map(rule => rule.id)).toEqual(['mine', 'share']);
    const removed = planPolicyChange(f.policy, f.bindings, change({ kind: 'grant.remove', id: 'mine' },
      { kind: 'binding.add', binding: { id: 'b2', principals: [other], roles: [INSTALLATION_OWNER_ROLE_ID], scopes: ['s1'] } }));
    expect(removed.order).toBe('bindings-first'); expect(removed.policy?.grants).toEqual([]); expect(removed.bindings?.bindings.map(value => value.id)).toEqual(['root', 'b2']);
    const invalid = (value: PolicyChange) => expect(() => planPolicyChange(f.policy, f.bindings, value)).toThrow(expect.objectContaining({ code: 'POLICY_CHANGE_INVALID' }));
    invalid(change({ kind: 'grant.add', grant: grant('mine', other) })); // duplicate id
    invalid(change({ kind: 'grant.remove', id: 'absent' }));
    invalid(change({ kind: 'binding.add', binding: { id: 'b3', principals: [other], roles: ['no-such-role'], scopes: ['s1'] } }));
    invalid({ schemaVersion: 1, changes: [] } as unknown as PolicyChange);
    invalid({ schemaVersion: 1, changes: Array.from({ length: 33 }, (_, index) => ({ kind: 'grant.remove', id: `g${index}` })) } as unknown as PolicyChange);
    invalid({ schemaVersion: 1, changes: [{ kind: 'mode.set', scopeId: 's1', mode: 'full-auto' }] } as unknown as PolicyChange); // not an input kind
    expect(() => planPolicyChange({ schemaVersion: 1, revision: 'v1', grants: [], restrictions: [] }, null, change({ kind: 'grant.remove', id: 'x' })))
      .toThrow(expect.objectContaining({ code: 'POLICY_ADMINISTER_UNSUPPORTED' }));
    const ids = Array.from({ length: 70 }, (_, index) => `t${index}`);
    const huge = planPolicyChange(f.policy, f.bindings, change({ kind: 'grant.add', grant: grant('huge', other, { actions: ids, scopes: ids, resource: { kind: 'agent-tool', ids } }) }));
    expect(() => delegationWithin(resolvePolicyBindings(f.policy, f.bindings), owner, huge.touched)).toThrow(expect.objectContaining({ code: 'POLICY_CHANGE_TOO_LARGE' }));
  });
});
