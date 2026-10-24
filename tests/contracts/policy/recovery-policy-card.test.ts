import { expect, it } from 'vitest';
import { POLICY_RECOVERY_CHANGE_KIND, RECOVERY_ACTIONS, authorityDocuments, delegationWithin, evaluatePolicy, firstRunPolicyTemplate, getPolicyVocabulary, installationOwnerPermissions, mcpPrincipalRef, planPolicyChange, resolvePolicyBindings,
  type DelegationOptions, type Policy, type RecoveryRolloutView, type VerifiedPrincipal } from '#domain/index.js';
import { FIRST_RUN_TOOL_NAMES, NERVOUS_EXECUTABLE_ACTIONS, RecoveryPolicyCard, nervousRulePromoted, nervousStandingApproval, recoveryContinuationApproval } from '#engine/index.js';

// alpha.56 G2 + G3 (R-DESIGN §2, §5, §6; owner Q-A1/Q-A2/Q-A4): the person card over the owner's own recovery grants and rule promotions.
const human: VerifiedPrincipal = { id: 'owner', issuer: 'host', subject: 'person', assurance: 'os-user', scopeIds: ['scope'] };
const view = (input: { rule?: boolean; decisions?: boolean } = {}): RecoveryRolloutView => ({ registry: { revision: 'r', status: 'provisional' }, complete: true,
  rules: [{ id: 'container-gone', version: 1, shadowCases: 20, sinceFalsePositive: 20, falsePositives: 0, met: input.rule ?? true }],
  decisions: { decided: 10, agreements: 9, perMille: 900, waiting: 0, met: input.decisions ?? true } });
const me = { issuer: human.issuer, subject: human.subject };
/** The person's own explicit single-cell rule (template v16's form). */
const cell = (id: string, kind: 'action' | 'rule', target: string, extra: Record<string, unknown> = {}) => ({ id, effect: 'require-approval' as const, principals: [me], scopes: ['scope'],
  actions: [kind === 'action' ? 'apply' : 'promote'], resource: { kind: kind === 'action' ? 'recovery-action' : 'nervous-rule', ids: [target] }, ...extra });
function fixture(rollout = view(), grants: unknown[] = []) {
  let policy = resolvePolicyBindings({ schemaVersion: 2, revision: 'p', grants, restrictions: [], separationOfDuties: [],
    roles: [{ id: 'owner', permissions: installationOwnerPermissions(getPolicyVocabulary().resources.map(r => r.kind)) }] },
  { schemaVersion: 2, revision: 'b', modes: [], bindings: [{ id: 'owner', principals: [{ issuer: human.issuer, subject: human.subject }], roles: ['owner'], scopes: 'all' }] });
  const commands: { input: { changes: { kind: string; grant?: { id: string; resource: unknown; actions: unknown } }[] } }[] = [];
  const card = (interactive = true) => new RecoveryPolicyCard({ policy: { load: async () => policy },
    // The administration's bound as the gate runs it: a refused change is never recorded.
    administration: { submit: async (command: { input?: unknown }, _credential?: unknown, options?: DelegationOptions) => {
      const files = authorityDocuments(policy), verdict = delegationWithin(policy, human, planPolicyChange(files.policy, files.bindings, command.input).touched, options);
      if (!verdict.ok) throw Object.assign(new Error('POLICY_DELEGATION_EXCEEDS'), { code: 'POLICY_DELEGATION_EXCEEDS', detail: `${verdict.ruleId}:${verdict.reason}` });
      commands.push(command as never); return { status: 'settled' } as never; } },
    approve: async () => { throw Error('unexpected'); } }, { rollout: async () => rollout, executable: NERVOUS_EXECUTABLE_ACTIONS }, async () => interactive);
  const input = (kind: 'action' | 'rule', id: string, action: 'grant' | 'revoke' = 'grant') => ({ schemaVersion: 1 as const, scopeId: 'scope', kind, id, action, expectedRevision: policy.revision });
  return { card, input, commands, get policy() { return policy; }, set policy(value) { policy = value; } };
}

it('rows: every stop-list action and the continuation, then each measured rule at its version; actions without an executor are marked unavailable', async () => {
  const shown = await fixture().card().inspect({ schemaVersion: 1, scopeId: 'scope' }, human);
  expect(shown.rows.map(row => [row.kind, row.id, row.available, row.exits])).toEqual([...RECOVERY_ACTIONS.map(id => ['action', id, !['restart-component', 'alert-brain'].includes(id), null]),
    ['action', 'continue-new-attempt', true, true], ['rule', 'container-gone@1', true, true]]);
});

it('negative first: AI, non-interactive, no executor, unmet exits, unknown rows and a stale revision change nothing', async () => {
  // Own cells keep the rows off (a row a role already allows is current before these checks).
  const f = fixture(view({ rule: false, decisions: false }), [cell('c1', 'action', 'stop-orphan'), cell('c2', 'action', 'alert-brain'), cell('c3', 'action', 'continue-new-attempt'),
    cell('c4', 'rule', 'container-gone@1')]);
  for (const actor of [{ ...human, ...mcpPrincipalRef(human) }, { ...human, assurance: 'token-verified' as const }])
    await expect(f.card().change(f.input('action', 'stop-orphan'), actor)).rejects.toMatchObject({ code: 'AI_AUTHORITY_NON_DELEGABLE' });
  await expect(f.card(false).change(f.input('action', 'stop-orphan'), human)).rejects.toMatchObject({ code: 'APPROVAL_INTERACTIVE_REQUIRED' });
  await expect(f.card().change(f.input('action', 'alert-brain'), human)).rejects.toMatchObject({ code: 'RECOVERY_ACTION_NO_EXECUTOR' });
  await expect(f.card().change(f.input('action', 'continue-new-attempt'), human)).rejects.toMatchObject({ code: 'RECOVERY_ROLLOUT_CRITERIA_UNMET' });
  await expect(f.card().change(f.input('rule', 'container-gone@1'), human)).rejects.toMatchObject({ code: 'RECOVERY_ROLLOUT_CRITERIA_UNMET' });
  for (const id of ['container-gone@2', 'crash-loop@1']) await expect(f.card().change(f.input('rule', id), human)).rejects.toMatchObject({ code: 'RECOVERY_TARGET_INVALID' });
  await expect(f.card().change({ ...f.input('action', 'stop-orphan'), expectedRevision: 'old' }, human)).rejects.toMatchObject({ code: 'POLICY_DELEGATION_CONFLICT' });
  expect(f.commands).toEqual([]);
});

// Audit 8328ff4a9 + cbbe28b5f: without the person's own exact cell (an `ids: 'all'` or a shared rule), or when such a rule also meets the own cell,
// the card refuses typed and writes nothing; a row a role already allows is current.
it('no own exact cell: a broad or a multi-person require-approval cell, alone or beside the own cell, is refused with RECOVERY_CELL_NOT_OWN; a role-allowed row is current', async () => {
  const other = { issuer: 'host', subject: 'someone-else' }, wide = cell('wide', 'action', 'x', { resource: { kind: 'recovery-action', ids: 'all' } });
  const allowed = fixture();
  expect((await allowed.card().change(allowed.input('action', 'fence-attempt'), human)).status).toBe('current');
  expect(allowed.commands).toEqual([]);
  for (const grants of [[wide], [cell('shared', 'action', 'fence-attempt', { principals: [me, other] })], [cell('own-stop', 'action', 'fence-attempt'), wide]]) {
    const f = fixture(view(), grants);
    await expect(f.card().change(f.input('action', 'fence-attempt'), human), JSON.stringify(grants)).rejects.toMatchObject({ code: 'RECOVERY_CELL_NOT_OWN' });
    expect(f.commands).toEqual([]);
  }
});

it('grant and revoke through policy.administer: a stop action needs no exits, a promotion names the exact rule@version; revoking is never gated', async () => {
  const f = fixture(view(), [cell('own-rule', 'rule', 'container-gone@1'), cell('own-stop', 'action', 'fence-attempt')]);
  expect((await f.card().change(f.input('rule', 'container-gone@1'), human)).status).toBe('applied');
  expect(f.commands[0]!.input.changes).toEqual([{ kind: 'grant.replace', grant: { ...cell('own-rule', 'rule', 'container-gone@1'), effect: 'allow' } }]);
  const grant = f.commands[0]!.input.changes[0]!.grant!;
  f.policy = { ...f.policy, grants: f.policy.grants.map(item => item.id === grant.id ? grant : item) } as typeof f.policy;
  const after = await f.card().inspect({ schemaVersion: 1, scopeId: 'scope' }, human);
  expect(after.rows.find(row => row.id === 'container-gone@1')).toMatchObject({ managed: 'granted', effective: 'allowed' });
  expect((await f.card().change(f.input('rule', 'container-gone@1'), human)).status).toBe('current');
  // Exits later unmet: turning the row off still works.
  const unmet = fixture(view({ rule: false })); unmet.policy = f.policy;
  expect((await unmet.card().change(unmet.input('rule', 'container-gone@1', 'revoke'), human)).status).toBe('applied');
  expect(unmet.commands[0]!.input.changes).toEqual([{ kind: 'grant.replace', grant: cell('own-rule', 'rule', 'container-gone@1') }]);
  expect((await f.card().change(f.input('action', 'fence-attempt'), human)).status).toBe('applied');
  expect(f.commands[1]!.input.changes[0]).toMatchObject({ kind: 'grant.replace', grant: { id: 'own-stop', effect: 'allow', actions: ['apply'], resource: { kind: 'recovery-action', ids: ['fence-attempt'] } } });
});

// alpha.56 D1 (owner 2026-10-24 v16_require_approval_raise, Jev c1d1afe9): on a real first-run v16 policy the readers are off; the card raises the
// person's own require-approval cell to allow (the evaluator decides require-approval before allow, so an added allow beside it would stay off).
it('first-run v16: recovery is off after install; the card turns one row on through the I2 raise and off again; the bound refuses the same raise without the card', async () => {
  const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: { issuer: human.issuer, subject: human.subject }, ...FIRST_RUN_TOOL_NAMES });
  let policy: Policy = resolvePolicyBindings(template.policy, template.bindings);
  const seen: (DelegationOptions | undefined)[] = [];
  let writes = 0;
  // The administration's bound as the target runs it (person decider, the requester's assurance), applied to the documents on success.
  const administration = { submit: async (command: { input?: unknown }, _credential?: unknown, options?: DelegationOptions) => {
    seen.push(options);
    const files = authorityDocuments(policy), plan = planPolicyChange(files.policy, files.bindings, command.input);
    const verdict = delegationWithin(policy, human, plan.touched, options);
    if (!verdict.ok) throw Object.assign(new Error('POLICY_DELEGATION_EXCEEDS'), { code: 'POLICY_DELEGATION_EXCEEDS', detail: `${verdict.ruleId}:${verdict.reason}` });
    policy = resolvePolicyBindings({ ...plan.policy, revision: `a-${++writes}` }, files.bindings);
    return { status: 'settled' } as never;
  } };
  const card = new RecoveryPolicyCard({ policy: { load: async () => policy }, administration, approve: async () => { throw Error('unexpected'); } },
    { rollout: async () => view(), executable: NERVOUS_EXECUTABLE_ACTIONS }, async () => true);
  const on = () => ({ stop: nervousStandingApproval(policy, human, { scopeId: 'scope', action: 'fence-attempt' }, 1) !== null,
    next: recoveryContinuationApproval(policy, human, 'scope', 1) !== null, rule: nervousRulePromoted(policy, human, 'scope', 'container-gone', 1) });
  expect(on()).toEqual({ stop: false, next: false, rule: false });
  const shown = await card.inspect({ schemaVersion: 1, scopeId: 'scope' }, human);
  expect(shown.rows.filter(row => row.available).every(row => row.managed === 'none' && row.effective === 'denied')).toBe(true);
  const change = (kind: 'action' | 'rule', id: string, action: 'grant' | 'revoke' = 'grant') => card.change({ schemaVersion: 1, scopeId: 'scope', kind, id, action, expectedRevision: policy.revision }, human);
  for (const [kind, id] of [['action', 'fence-attempt'], ['action', 'continue-new-attempt'], ['rule', 'container-gone@1']] as const) expect((await change(kind, id)).status).toBe('applied');
  expect(on()).toEqual({ stop: true, next: true, rule: true });
  expect(seen.every(options => options?.changeKind === POLICY_RECOVERY_CHANGE_KIND)).toBe(true);
  expect((await card.inspect({ schemaVersion: 1, scopeId: 'scope' }, human)).rows.find(row => row.id === 'fence-attempt')).toMatchObject({ managed: 'granted', effective: 'allowed' });
  // Another row stays off: only the raised cell changed.
  expect(nervousStandingApproval(policy, human, { scopeId: 'scope', action: 'stop-orphan' }, 1)).toBeNull();
  expect((await change('action', 'fence-attempt', 'revoke')).status).toBe('applied');
  expect(on()).toMatchObject({ stop: false });
  expect(policy.grants.find(rule => rule.id === 'first-run-recovery-action-fence-attempt')).toMatchObject({ effect: 'require-approval' });
  // The same raise outside a policy-recovery change (any other policy.administer path) is refused by the bound.
  const files = authorityDocuments(policy), ask = policy.grants.find(rule => rule.id === 'first-run-recovery-action-fence-attempt')!;
  expect(delegationWithin(policy, human, planPolicyChange(files.policy, files.bindings, { schemaVersion: 1, changes: [{ kind: 'grant.replace', grant: { ...ask, effect: 'allow' } }] }).touched))
    .toMatchObject({ ok: false, reason: 'require-approval' });
});

it('why the card replaces the cell: an allow added beside the v16 require-approval rule leaves every reader off (require-approval is decided first)', () => {
  const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: { issuer: human.issuer, subject: human.subject }, ...FIRST_RUN_TOOL_NAMES });
  const added = { id: 'added-allow', effect: 'allow', actions: ['apply'], scopes: ['scope'], principals: [{ issuer: human.issuer, subject: human.subject }],
    resource: { kind: 'recovery-action', ids: ['fence-attempt'] } };
  const both = resolvePolicyBindings({ ...template.policy, grants: [...template.policy.grants, added] }, template.bindings);
  expect(evaluatePolicy(both, { principal: human, scopeId: 'scope', action: 'apply', resource: { kind: 'recovery-action', id: 'fence-attempt' } }))
    .toMatchObject({ decision: 'require-approval', ruleId: 'first-run-recovery-action-fence-attempt' });
  expect(nervousStandingApproval(both, human, { scopeId: 'scope', action: 'fence-attempt' }, 1)).toBeNull();
});
