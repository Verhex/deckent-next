import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { AuditError, NERVOUS_READ_ACTIONS, evaluatePolicy, getPolicyVocabulary, isAiPrincipal, isAuditorPrincipal, isNervousPrincipal, nervousPrincipalRef,
  type AuditEvent, type AuditRecord } from '#domain/index.js';
import { AuditApplication, runtimeServiceRequestSchema, type AuditStore } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';

// S6 Nervous (K-B, PROGRAM law-audit fold 4): the Nervous detector is a workload identity built in code (no client channel names it). It reads
// and proposes; it never writes state. Whatever a policy grants it, every non-read action is refused; its only audit write is its own
// `recovery-detection` record, and no other principal may write one (a proposal always comes from Nervous).
const owner = { issuer: 'host', subject: '1000' };
const ref = nervousPrincipalRef(owner);
const nervous = { id: `${ref.subject}@${ref.issuer}`, ...ref, assurance: 'workload-verified' as const, scopeIds: ['s'] };
const everything = { schemaVersion: 1, revision: 'p-all', restrictions: [],
  grants: getPolicyVocabulary().resources.map(resource => ({ id: `all-${resource.kind}`, effect: 'allow', actions: 'all', scopes: 'all', resource: { kind: resource.kind, ids: 'all' },
    principals: [{ issuer: nervous.issuer, subject: nervous.subject }] })) };

it('is a workload principal that is AI and Nervous, distinct from the owner, the MCP actor and the auditor', () => {
  expect(ref).toEqual({ issuer: 'host/nervous', subject: '1000' });
  expect(isNervousPrincipal(nervous)).toBe(true); expect(isAiPrincipal(nervous)).toBe(true); expect(isAuditorPrincipal(nervous)).toBe(false);
  // Transport identity dominates assurance: a forged os-user Nervous is still Nervous and still AI.
  expect(isAiPrincipal({ ...nervous, assurance: 'os-user' })).toBe(true);
  expect(isNervousPrincipal({ issuer: 'host' })).toBe(false); expect(isNervousPrincipal({ issuer: 'host/mcp' })).toBe(false);
});

it('refuses every non-read action of the whole vocabulary even when granted (it never writes state, opens an Attempt or resumes a Run)', () => {
  expect(NERVOUS_READ_ACTIONS).toEqual(['inspect', 'list']);
  let reads = 0, writes = 0;
  for (const { kind, actions } of getPolicyVocabulary().resources) for (const action of actions) {
    const decision = evaluatePolicy(everything, { principal: nervous, scopeId: 's', action, resource: { kind, id: kind === 'config' ? 'project:language' : 'x' } });
    if ((NERVOUS_READ_ACTIONS as readonly string[]).includes(action) && kind !== 'secret') { reads++; expect(decision).toMatchObject({ decision: 'allow' }); }
    else { writes++; expect({ kind, action, ...decision }).toMatchObject({ kind, action, decision: 'deny', reason: 'AI_NON_DELEGABLE' }); }
  }
  expect(reads).toBeGreaterThan(0); expect(writes).toBeGreaterThan(reads);
  for (const action of ['execute', 'reserve', 'resume', 'cancel', 'future-write']) {
    expect(evaluatePolicy(everything, { principal: nervous, scopeId: 's', action, resource: { kind: 'run', id: 'x' } })).toMatchObject({ decision: 'deny', reason: 'AI_NON_DELEGABLE' });
  }
});

it('cannot be selected from a client channel', () => {
  expect(runtimeServiceRequestSchema.safeParse({ schemaVersion: 1, requestId: 'r1', operation: 'describeService', input: {}, channel: 'nervous' }).success).toBe(false);
});

const store = (): AuditStore & { rows: AuditRecord[] } => {
  const rows: AuditRecord[] = [];
  return { rows, append(event, seal) { const record = seal(rows.length + 1); rows.push(record); return record; }, page: () => rows,
    increment: () => { throw new Error('unused'); }, counters: () => [] } as unknown as AuditStore & { rows: AuditRecord[] };
};
const detection = { kind: 'recovery-detection', caseId: 'c'.repeat(64), rule: { id: 'launcher-dead-orphan', version: 1, status: 'provisional' }, registryRevision: 'core-1',
  action: 'stop-orphan', disposition: 'shadow-only', target: { runId: 'r', taskId: 't', attemptId: 'a', generation: 1 },
  evidence: { activity: 'running', launcher: 'dead', launcherPhase: 'dispatch', absentObservations: 0, absentForMs: null, unavailableForMs: null, containerRecorded: true, workerRecorded: false, source: null }, evidenceDigest: 'd'.repeat(64) };
const event = (principal: { issuer: string; subject: string }, subject: unknown) => ({ schemaVersion: 1, eventId: 'e1', scopeId: 's', principal, policyRevision: 'p1', atMs: 1, subject }) as unknown as AuditEvent;

it('the audit writer takes a recovery-detection only from Nervous, and nothing else from Nervous', () => {
  const target = store(), audit = new AuditApplication(target, createHmacIntegrity('k', randomBytes(32)));
  expect(() => audit.record(event(owner, detection))).toThrow(new AuditError('AUDIT_INVALID'));
  expect(() => audit.record(event({ issuer: 'host/mcp', subject: '1000' }, detection))).toThrow(new AuditError('AUDIT_INVALID'));
  expect(() => audit.record(event(ref, { kind: 'run-lifecycle', action: 'hold', runId: 'r', commandId: 'c', taskId: null, revision: 1, evidence: null }))).toThrow(new AuditError('AUDIT_INVALID'));
  expect(target.rows).toEqual([]);
  expect(audit.record(event(ref, detection)).event.subject.kind).toBe('recovery-detection');
});
