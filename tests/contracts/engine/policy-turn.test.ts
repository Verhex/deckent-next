import { expect, it } from 'vitest';
import { auditEventSchema, AUDIT_POLICY_TURN_LIMITS } from '#domain/index.js';
import { PolicyTurnRecord } from '#engine/index.js';

// S5 D1 (owner Q5 2026-10-17): every refused (deny / require-approval) agent tool call decision and every silent allow of one turn is
// sealed in ONE `policy-turn` record per turn: tool identity, call position, cell and argument digest only. Bounded lists with full
// counts; refusals past the bound raise the turn's `ceiling` flag (a deny flood can never grow the ledger beyond one bounded row).
const digest = (n: number) => n.toString(16).padStart(64, '0');
const tool = { name: 'edit_file', version: 1 };
const base = { scopeId: 'scope', turnId: 'turn-1', principal: { issuer: 'host', subject: '1000' } };

it('writes nothing for a turn that decided nothing', () => {
  expect(new PolicyTurnRecord(base).event(10)).toBeNull();
});

it('seals refusals and silent allows with their positions, cells, stages and digests in one schema-valid event', () => {
  const turn = new PolicyTurnRecord(base);
  turn.refused({ tool, call: { round: 1, index: 0, callId: 'c0' }, cell: null, decision: 'deny', stage: 'policy', argsDigest: digest(1), revision: 'p1' });
  turn.refused({ tool, call: { round: 1, index: 1, callId: 'c1' }, cell: 'edit-floor', decision: 'require-approval', stage: 'cell', argsDigest: digest(2), revision: 'p1' });
  turn.allowed({ tool, call: { round: 2, index: 0, callId: 'c2' }, cell: 'edit', argsDigest: digest(3), revision: 'p2' });
  turn.refused({ tool, call: { round: 2, index: 1, callId: 'c3' }, cell: 'edit', decision: 'deny', stage: 'effect', argsDigest: digest(4), revision: 'p3' });
  const event = turn.event(1234)!;
  expect(auditEventSchema.parse(event)).toEqual(event);
  expect(event).toMatchObject({ scopeId: 'scope', principal: base.principal, policyRevision: 'p3', atMs: 1234 });
  expect(event.subject).toEqual({ kind: 'policy-turn', turnId: 'turn-1', ceiling: false,
    refused: { count: 3, calls: [
      { tool, call: { round: 1, index: 0, callId: 'c0' }, cell: null, decision: 'deny', stage: 'policy', argsDigest: digest(1), revision: 'p1' },
      { tool, call: { round: 1, index: 1, callId: 'c1' }, cell: 'edit-floor', decision: 'require-approval', stage: 'cell', argsDigest: digest(2), revision: 'p1' },
      { tool, call: { round: 2, index: 1, callId: 'c3' }, cell: 'edit', decision: 'deny', stage: 'effect', argsDigest: digest(4), revision: 'p3' }] },
    allowed: { count: 1, calls: [{ tool, call: { round: 2, index: 0, callId: 'c2' }, cell: 'edit', argsDigest: digest(3), revision: 'p2' }] } });
  // Content-addressed identity: the same turn content is the same event (a replayed flush appends nothing new).
  expect(new PolicyTurnRecord(base).event(1)).toBeNull();
  expect(event.eventId).toMatch(/^policy-turn:[a-f0-9]{64}$/u);
  const again = new PolicyTurnRecord(base);
  again.refused({ tool, call: { round: 1, index: 0, callId: 'c0' }, cell: null, decision: 'deny', stage: 'policy', argsDigest: digest(1), revision: 'p1' });
  expect(again.event(1)!.eventId).not.toBe(event.eventId);
});

it('keeps the full counts but at most the limit entries; a refusal flood past the limit raises the ceiling flag, an allow flood does not', () => {
  const { refusedMax, allowedMax } = AUDIT_POLICY_TURN_LIMITS;
  const turn = new PolicyTurnRecord(base);
  for (let n = 0; n < refusedMax + 5; n++) turn.refused({ tool, call: { round: 1, index: n, callId: `r${n}` }, cell: 'edit', decision: 'deny', stage: 'cell', argsDigest: digest(n), revision: 'p' });
  for (let n = 0; n < allowedMax + 7; n++) turn.allowed({ tool, call: { round: 2, index: n, callId: `a${n}` }, cell: 'edit', argsDigest: digest(n), revision: 'p' });
  const event = turn.event(1)!;
  expect(auditEventSchema.parse(event)).toEqual(event);
  const subject = event.subject as Extract<typeof event.subject, { kind: 'policy-turn' }>;
  expect(subject.refused.count).toBe(refusedMax + 5); expect(subject.refused.calls).toHaveLength(refusedMax);
  expect(subject.allowed.count).toBe(allowedMax + 7); expect(subject.allowed.calls).toHaveLength(allowedMax);
  expect(subject.ceiling).toBe(true);
  const allowsOnly = new PolicyTurnRecord(base);
  for (let n = 0; n < allowedMax + 1; n++) allowsOnly.allowed({ tool, call: { round: 1, index: n, callId: `a${n}` }, cell: 'edit', argsDigest: digest(n), revision: 'p' });
  expect((allowsOnly.event(1)!.subject as typeof subject).ceiling).toBe(false);
  // The schema itself refuses an unbounded list.
  expect(auditEventSchema.safeParse({ ...event, subject: { ...subject, allowed: { count: allowedMax + 1, calls: [...subject.allowed.calls, subject.allowed.calls[0]] } } }).success).toBe(false);
});
