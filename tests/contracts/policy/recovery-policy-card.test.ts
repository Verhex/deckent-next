import { expect, it } from 'vitest';
import { RECOVERY_ACTIONS, getPolicyVocabulary, installationOwnerPermissions, mcpPrincipalRef, resolvePolicyBindings, type RecoveryRolloutView, type VerifiedPrincipal } from '#domain/index.js';
import { NERVOUS_EXECUTABLE_ACTIONS, RecoveryPolicyCard } from '#engine/index.js';

// alpha.56 G2 + G3 (R-DESIGN §2, §5, §6; owner Q-A1/Q-A2/Q-A4): the person card over the owner's own recovery grants and rule promotions.
const human: VerifiedPrincipal = { id: 'owner', issuer: 'host', subject: 'person', assurance: 'os-user', scopeIds: ['scope'] };
const view = (input: { rule?: boolean; decisions?: boolean } = {}): RecoveryRolloutView => ({ registry: { revision: 'r', status: 'provisional' }, complete: true,
  rules: [{ id: 'container-gone', version: 1, shadowCases: 20, sinceFalsePositive: 20, falsePositives: 0, met: input.rule ?? true }],
  decisions: { decided: 10, agreements: 9, perMille: 900, waiting: 0, met: input.decisions ?? true } });
function fixture(rollout = view()) {
  let policy = resolvePolicyBindings({ schemaVersion: 2, revision: 'p', grants: [], restrictions: [], separationOfDuties: [],
    roles: [{ id: 'owner', permissions: installationOwnerPermissions(getPolicyVocabulary().resources.map(r => r.kind)) }] },
  { schemaVersion: 2, revision: 'b', modes: [], bindings: [{ id: 'owner', principals: [{ issuer: human.issuer, subject: human.subject }], roles: ['owner'], scopes: 'all' }] });
  const commands: { input: { changes: { kind: string; grant?: { id: string; resource: unknown; actions: unknown } }[] } }[] = [];
  const card = (interactive = true) => new RecoveryPolicyCard({ policy: { load: async () => policy },
    administration: { submit: async (command: unknown) => { commands.push(command as never); return { status: 'settled' } as never; } },
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
  const f = fixture(view({ rule: false, decisions: false }));
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

it('grant and revoke through policy.administer: a stop action needs no exits, a promotion names the exact rule@version; revoking is never gated', async () => {
  const f = fixture();
  expect((await f.card().change(f.input('rule', 'container-gone@1'), human)).status).toBe('applied');
  expect(f.commands[0]!.input.changes[0]).toMatchObject({ kind: 'grant.add', grant: { actions: ['promote'], resource: { kind: 'nervous-rule', ids: ['container-gone@1'] } } });
  const grant = f.commands[0]!.input.changes[0]!.grant!;
  f.policy = { ...f.policy, grants: [...f.policy.grants, grant] } as typeof f.policy;
  const after = await f.card().inspect({ schemaVersion: 1, scopeId: 'scope' }, human);
  expect(after.rows.find(row => row.id === 'container-gone@1')).toMatchObject({ managed: 'granted', effective: 'allowed' });
  expect((await f.card().change(f.input('rule', 'container-gone@1'), human)).status).toBe('current');
  // Exits later unmet: turning the row off still works.
  const unmet = fixture(view({ rule: false })); unmet.policy = f.policy;
  expect((await unmet.card().change(unmet.input('rule', 'container-gone@1', 'revoke'), human)).status).toBe('applied');
  expect(unmet.commands[0]!.input.changes[0]).toEqual({ kind: 'grant.remove', id: grant.id });
  expect((await f.card().change(f.input('action', 'fence-attempt'), human)).status).toBe('applied');
  expect(f.commands[1]!.input.changes[0]).toMatchObject({ grant: { actions: ['apply'], resource: { kind: 'recovery-action', ids: ['fence-attempt'] } } });
});
