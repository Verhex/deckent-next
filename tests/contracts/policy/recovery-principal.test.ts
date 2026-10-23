import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { AuditError, RECOVERY_ALLOWED_PAIRS, evaluatePolicy, getPolicyVocabulary, isAiPrincipal, isNervousPrincipal, isRecoveryPrincipal, recoveryPrincipal, recoveryPrincipalRef,
  type AuditEvent, type AuditRecord } from '#domain/index.js';
import { AuditApplication, recoveryContinuationApproval, runtimeServiceRequestSchema, type AuditStore } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';

// S6R-4 (S6R-DESIGN §9; lead on s6r3 Q4): the recovery principal is a system workload identity only the composition root issues. Its floor is an exact
// allow-list (reconcile an Attempt, read a Run): whatever a policy grants it, nothing else passes — it never administers policy, resumes a held
// Run, decides an approval or holds a standing grant. Its only audit write is the continuation event, which no other principal may write. The
// owner's standing approval of a continuation is a person's grant, never an AI's.
const owner = { issuer: 'host', subject: '1000' };
const ref = recoveryPrincipalRef(owner), recovery = recoveryPrincipal(owner, ['s']);
const everything = { schemaVersion: 1, revision: 'p-all', restrictions: [],
  grants: getPolicyVocabulary().resources.map(resource => ({ id: `all-${resource.kind}`, effect: 'allow', actions: 'all', scopes: 'all', resource: { kind: resource.kind, ids: 'all' },
    principals: [{ issuer: ref.issuer, subject: ref.subject }] })) };

it('is an AI workload principal distinct from the owner, MCP and Nervous; a forged os-user recovery principal is still it', () => {
  expect(ref).toEqual({ issuer: 'host/recovery', subject: '1000' });
  expect(recovery).toMatchObject({ assurance: 'workload-verified', scopeIds: ['s'] });
  expect(isRecoveryPrincipal(recovery)).toBe(true); expect(isAiPrincipal(recovery)).toBe(true); expect(isAiPrincipal({ ...recovery, assurance: 'os-user' })).toBe(true);
  expect(isNervousPrincipal(recovery)).toBe(false); expect(isRecoveryPrincipal({ issuer: 'host/nervous' })).toBe(false); expect(isRecoveryPrincipal({ issuer: 'host' })).toBe(false);
});

it('refuses every pair outside its exact allow-list even when granted everything', () => {
  expect(RECOVERY_ALLOWED_PAIRS).toEqual([['attempt', 'reconcile'], ['run', 'inspect']]);
  let allowed = 0;
  for (const { kind, actions } of getPolicyVocabulary().resources) for (const action of actions) {
    const decision = evaluatePolicy(everything, { principal: recovery, scopeId: 's', action, resource: { kind, id: kind === 'config' ? 'project:language' : 'x' } });
    if (RECOVERY_ALLOWED_PAIRS.some(([k, a]) => k === kind && a === action)) { allowed++; expect(decision).toMatchObject({ decision: 'allow' }); }
    else expect({ kind, action, ...decision }).toMatchObject({ kind, action, decision: 'deny' });
  }
  expect(allowed).toBe(2);
  for (const [kind, id, action] of [['recovery-action', 'continue-new-attempt', 'apply'], ['run-hold', 'nervous', 'resume'], ['run', 'x', 'resume'], ['operation', 'policy.administer', 'execute']])
    expect(evaluatePolicy(everything, { principal: recovery, scopeId: 's', action: action!, resource: { kind: kind!, id: id! } })).toMatchObject({ decision: 'deny', reason: 'AI_NON_DELEGABLE' });
});

it('the owner\'s continuation grant is a person\'s: granted to an AI principal or another action it is no approval', () => {
  const grant = (principals: unknown, ids: unknown = ['continue-new-attempt']) => ({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'recovery-standing', effect: 'allow', actions: ['apply'], scopes: ['s'], principals, resource: { kind: 'recovery-action', ids } }] });
  const person = { id: 'owner', ...owner, assurance: 'os-user' as const, scopeIds: ['s'] };
  expect(recoveryContinuationApproval(grant([owner]), person, 's', 7)).toMatchObject({ decisionRef: 'recovery-standing', approvedBy: { ...owner, assurance: 'os-user' }, scopeIds: ['s'] });
  expect(recoveryContinuationApproval(grant([owner], ['stop-orphan']), person, 's', 7)).toBeNull();
  expect(recoveryContinuationApproval(grant([ref]), recovery, 's', 7)).toBeNull();
  expect(recoveryContinuationApproval(grant([owner]), person, 'other', 7)).toBeNull();
  expect(recoveryContinuationApproval({ broken: true }, person, 's', 7)).toBeNull();
});

it('cannot be selected from a client channel', () => {
  expect(runtimeServiceRequestSchema.safeParse({ schemaVersion: 1, requestId: 'r1', operation: 'describeService', input: {}, channel: 'recovery' }).success).toBe(false);
});

const store = (): AuditStore & { rows: AuditRecord[] } => {
  const rows: AuditRecord[] = [];
  return { rows, append(event, seal) { const record = seal(rows.length + 1); rows.push(record); return record; }, page: () => rows,
    increment: () => { throw new Error('unused'); }, counters: () => [] } as unknown as AuditStore & { rows: AuditRecord[] };
};
const event = (principal: { issuer: string; subject: string }, action: string) => ({ schemaVersion: 1, eventId: 'e1', scopeId: 's', principal, policyRevision: 'p1', atMs: 1,
  subject: { kind: 'run-lifecycle', action, runId: 'r', commandId: 'c', taskId: 't', revision: 2, evidence: null, deciderClass: 'system', decisionRuleId: 'recovery-standing' } }) as unknown as AuditEvent;

it('the audit writer takes a continuation event only from the recovery principal, and nothing else from it', () => {
  const target = store(), audit = new AuditApplication(target, createHmacIntegrity('k', randomBytes(32)));
  expect(() => audit.record(event(owner, 'continue-lost-task'))).toThrow(new AuditError('AUDIT_INVALID'));
  expect(() => audit.record(event({ issuer: 'host/nervous', subject: '1000' }, 'continue-lost-task'))).toThrow(new AuditError('AUDIT_INVALID'));
  expect(() => audit.record(event(ref, 'hold'))).toThrow(new AuditError('AUDIT_INVALID'));
  expect(target.rows).toEqual([]);
  expect(audit.record(event(ref, 'continue-lost-task')).event.subject).toMatchObject({ kind: 'run-lifecycle', action: 'continue-lost-task' });
});
