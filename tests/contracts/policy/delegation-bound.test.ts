import { describe, expect, it } from 'vitest';
import { delegationWithin, getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID, kindCovers, planPolicyChange, POLICY_RECOVERY_CHANGE_KIND, resolvePolicyBindings,
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

  it('alpha.56 D1 raise: only inside a policy-recovery change, only a person, only their own require-approval recovery cell; everything else keeps the bound', () => {
    const person = { ...member, assurance: 'os-user' };
    const cell = (id: string, kind = 'recovery-action', action = 'apply', ids = ['fence-attempt']) => ({ id, effect: 'require-approval', actions: [action], scopes: ['s1'],
      principals: [member], resource: { kind, ids } });
    const ra = cell('ra'), rule = cell('ra-rule', 'nervous-rule', 'promote', ['container-gone@1']), secret = cell('ra-secret', 'secret', 'set', ['token']);
    const raise = (value: typeof ra, extra: Record<string, unknown> = {}) => change({ kind: 'grant.replace', grant: { ...value, effect: 'allow', ...extra } });
    const run = (input: ReturnType<typeof files>, actor: { issuer: string; subject: string; assurance?: string }, value: PolicyChange, recovery = true) =>
      delegationWithin(resolvePolicyBindings(input.policy, input.bindings), actor, planPolicyChange(input.policy, input.bindings, value).touched,
        recovery ? { changeKind: POLICY_RECOVERY_CHANGE_KIND } : {});
    const f = files([ra, rule, secret]);
    expect(run(f, person, raise(ra))).toEqual({ ok: true });
    expect(run(f, person, raise(rule))).toEqual({ ok: true });
    // Lowering it back needs no raise (the person then holds allow).
    const raised = files([{ ...ra, effect: 'allow' }]);
    expect(run(raised, person, change({ kind: 'grant.replace', grant: ra }), false)).toEqual({ ok: true });
    // Negatives, one per risk: another policy.administer path (standing, delegation, MCP capability, template upgrade) declares no kind.
    expect(run(f, person, raise(ra), false)).toMatchObject({ ok: false, reason: 'require-approval' });
    // An AI or an actor without a person's assurance never raises.
    for (const actor of [{ ...person, assurance: 'workload-verified' }, member]) expect(run(f, actor, raise(ra))).toMatchObject({ ok: false, reason: 'require-approval' });
    // Only the two recovery kinds: a person-only `secret` cell is not raisable.
    expect(run(f, person, raise(secret))).toMatchObject({ ok: false, reason: 'require-approval' });
    // The raised rule must name exactly the actor (not another person, not the actor plus another one, not `all`).
    for (const principals of [[other], [member, other], 'all']) expect(run(f, person, raise(ra, { principals })), JSON.stringify(principals)).toMatchObject({ ok: false });
    // A deny or restriction meeting the cell still refuses.
    const restricted = files([ra], [], [{ id: 'lock', actions: 'all', scopes: 'all', principals: [member], resource: { kind: 'recovery-action', ids: 'all' } }]);
    expect(run(restricted, person, raise(ra))).toMatchObject({ ok: false, reason: 'deny' });
    // A person who does not hold the cell (an organisation narrowed who may turn recovery on) cannot give it to themselves.
    expect(run(files([]), person, change({ kind: 'grant.add', grant: { ...ra, effect: 'allow' } }))).toMatchObject({ ok: false, reason: 'no-grant' });
    // Only a cell naming the actor counts: a require-approval rule for `all` principals, or naming another person, never lets anyone raise.
    const own = { ...ra, id: 'mine', effect: 'allow' };
    for (const principals of ['all', [other]]) expect(run(files([{ ...ra, principals }]), person, change({ kind: 'grant.add', grant: own })), JSON.stringify(principals))
      .toMatchObject({ ok: false });
    // Audit 8328ff4a9: only a same-id replace of the actor's own explicit single-cell rule raises. A grant.add beside the actor's own cell, or beside a
    // cell an enterprise assigns through a role bound to exactly this person, would be a dormant allow (require-approval is decided first): refused.
    const role = { id: 'recovery-operator', permissions: [{ id: 'ra', effect: 'require-approval', actions: ['apply'], resource: { kind: 'recovery-action', ids: ['fence-attempt'] } }] };
    const ops = [{ id: 'ops', principals: [member], roles: ['recovery-operator'], scopes: ['s1'] }];
    expect(run(f, person, change({ kind: 'grant.add', grant: own }))).toMatchObject({ ok: false, reason: 'require-approval' });
    expect(run(files([], [role], [], ops), person, change({ kind: 'grant.add', grant: own }))).toMatchObject({ ok: false, reason: 'require-approval' });
    // An explicit cell for `ids: 'all'` or naming the actor and another person is not the actor's own single cell: replacing it never raises.
    for (const value of [{ ...ra, resource: { kind: 'recovery-action', ids: 'all' } }, { ...ra, principals: [member, other] }])
      expect(run(files([value]), person, raise(value as typeof ra)), JSON.stringify(value)).toMatchObject({ ok: false, reason: 'require-approval' });
    // The own exact cell while a role-derived require-approval also meets it: the replace would leave the cell at require-approval (dormant), refused.
    expect(run(files([ra], [role], [], ops), person, raise(ra))).toMatchObject({ ok: false, reason: 'require-approval' });
  });
});
