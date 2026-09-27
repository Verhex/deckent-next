import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalOsSessionAuthority, openSqliteApprovalStore } from '#adapters/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { effectRecordSchema, type EffectCommand, type EffectRecord, type OperationDescriptor } from '#domain/index.js';
import { ApprovalApplication, OperationApprovalBroker, awaitOperationApproval, operationApprovalActionDigest, type EffectApprovalContext } from '#engine/index.js';
import { MAX_WALL_SKEW_MS, createHmacIntegrity } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('key', randomBytes(32));
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const descriptor: OperationDescriptor = { schemaVersion: 1, operation: { id: 'post-order', version: 1 }, targetKind: 'records', effectClass: 'write', approval: 'policy',
  precondition: 'record-version', compensation: null, inputMaxBytes: 4096 };
const command = (commandId = 'cmd-1', extra: Partial<EffectCommand> = {}): EffectCommand => ({ schemaVersion: 1, commandId, scopeId: 'scope', operation: descriptor.operation,
  target: { kind: 'records', id: 'PO-1' }, idempotencyKey: `key-${commandId}`, input: { amount: 10 }, expectedVersion: '"v1"', ...extra });
const context = (record: EffectRecord | null = null, extra: Partial<EffectApprovalContext> = {}): EffectApprovalContext => ({ record, targetBinding: digest('binding'), inputDigest: digest('input'), ...extra });
const policy = { schemaVersion: 1, revision: 'p1', restrictions: [], grants: [
  { id: 'decide', effect: 'allow', principals: 'all', scopes: ['scope'], actions: 'all', resource: { kind: 'approval', ids: 'all' } }] };

async function fixture(admitWithinMs = 30_000) {
  const root = await mkdtemp(join(tmpdir(), 'dn-op-approval-')); roots.push(root); const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close();
  const journal = openSqliteApprovalStore(path, options);
  const time = { wallMs: 1_000 };
  const clock = { sample: () => ({ wallMs: time.wallMs, monotonicMs: time.wallMs }) };
  const sessions = await LocalOsSessionAuthority.create(['scope'], 600_000, clock); const { principal } = await sessions.verifySession(undefined);
  const decisions = new ApprovalApplication(journal.store, { verify: async () => principal }, sessions, { load: async () => policy }, integrity, clock, 'terminal', 10);
  const broker = new OperationApprovalBroker(journal.store, integrity, { load: async () => policy }, clock, { requestTtlMs: 60_000, defaultAdmitWithinMs: admitWithinMs });
  const decide = (approvalId: string, decision: 'allow' | 'deny', commandId = `decide-${approvalId}`) => decisions.decide({ schemaVersion: 1, scopeId: 'scope', approvalId, commandId,
    expectedRevision: 0, decision, reason: 'Reviewed' });
  const record = (approval: { approvalId: string; actionDigest: string } | null, state: EffectRecord['state'] = 'claimed', cmd = command()): EffectRecord => effectRecordSchema.parse({
    intent: { schemaVersion: 1, command: cmd, descriptor, actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject }, idempotencyKeyHash: digest('k'),
      inputDigest: digest('input'), wireKey: digest('w'), targetBinding: digest('binding'), ...(approval ? { approval } : {}) },
    sequence: 1, state, evidence: state === 'settled' ? { kind: 'idempotency-record', version: '"v2"', observedAt: 1 } : null, refusal: state === 'refused' ? 'EFFECT_REJECTED' : null });
  return { journal, time, principal, broker, decide, record, close: () => journal.close() };
}

it('opens one pending request per exact command, admits the same command once its stored allow is verified within the window, and pins the consumed record afterwards', async () => {
  const f = await fixture();
  try {
    const first = await f.broker.admit(descriptor, 'require-approval', command(), f.principal, context());
    if (!first || !('pending' in first)) throw new Error('expected pending');
    expect(first.pending).toMatchObject({ revision: 0, expiresAt: 61_000, summary: expect.stringContaining('post-order@1 · records/PO-1') });
    // Idempotent: the same command asks again and meets the same request; another input, command, binding or expected version is another request.
    expect(await f.broker.admit(descriptor, 'require-approval', command(), f.principal, context())).toEqual(first);
    const others = await Promise.all([
      f.broker.admit(descriptor, 'require-approval', command(), f.principal, context(null, { inputDigest: digest('other') })),
      f.broker.admit(descriptor, 'require-approval', command('cmd-2'), f.principal, context()),
      f.broker.admit(descriptor, 'require-approval', command(), f.principal, context(null, { targetBinding: digest('moved') })),
      f.broker.admit(descriptor, 'require-approval', command('cmd-1', { expectedVersion: '"v9"' }), f.principal, context()),
    ]);
    const ids = new Set(others.map(other => (other && 'pending' in other ? other.pending.approvalId : 'admitted')));
    expect(ids.size).toBe(4); expect(ids.has(first.pending.approvalId)).toBe(false); expect(ids.has('admitted')).toBe(false);
    expect(f.journal.store.list('scope', null, 10)).toHaveLength(5);

    f.time.wallMs = 2_000;
    await f.decide(first.pending.approvalId, 'allow');
    f.time.wallMs = 2_000 + 30_000;
    const admitted = await f.broker.admit(descriptor, 'require-approval', command(), f.principal, context());
    expect(admitted).toEqual({ approval: { approvalId: first.pending.approvalId, actionDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    if (!admitted || !('approval' in admitted)) throw new Error('expected admission');
    expect(admitted.approval.actionDigest).toBe(operationApprovalActionDigest('scope', { kind: 'operation', operation: descriptor.operation, target: { kind: 'records', id: 'PO-1' },
      commandId: 'cmd-1', inputDigest: digest('input'), targetBinding: digest('binding'), expectedVersion: '"v1"', compensates: null },
    { id: f.principal.id, issuer: f.principal.issuer, subject: f.principal.subject }));
    // Consumed: the claimed intent pins the approval; later passes verify that record, whatever the clock says now.
    f.time.wallMs = 500_000;
    expect(await f.broker.admit(descriptor, 'require-approval', command(), f.principal, context(f.record(admitted.approval)))).toEqual(admitted);
    expect(await f.broker.admit(descriptor, 'require-approval', command(), f.principal, context(f.record(admitted.approval, 'unknown')))).toEqual(admitted);
    // A reference to another digest, or an approval of another command, never admits.
    await expect(f.broker.admit(descriptor, 'require-approval', command(), f.principal, context(f.record({ ...admitted.approval, actionDigest: digest('forged') }))))
      .rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
    await expect(f.broker.admit(descriptor, 'require-approval', command('cmd-2'), f.principal, context(f.record(admitted.approval, 'claimed', command('cmd-2')))))
      .rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
    await expect(f.broker.admit(descriptor, 'require-approval', command(), f.principal, context(f.record({ ...admitted.approval, approvalId: 'missing' }))))
      .rejects.toMatchObject({ code: 'APPROVAL_MISSING' });
    // Without the pinned reference the same command is a fresh check: the allow is outside its window now.
    await expect(f.broker.admit(descriptor, 'require-approval', command(), f.principal, context())).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
  } finally { f.close(); }
});

it('never reads or opens an approval for a terminal record or an allowed command, and refuses deny, expiry, an unused allow and a decision from the future', async () => {
  const f = await fixture();
  try {
    const find = vi.spyOn(f.journal.store, 'findOperation'), create = vi.spyOn(f.journal.store, 'create');
    expect(await f.broker.admit(descriptor, 'allow', command(), f.principal, context())).toBeUndefined();
    expect(await f.broker.admit(descriptor, 'require-approval', command(), f.principal, context(f.record(null, 'settled')))).toBeUndefined();
    expect(await f.broker.admit(descriptor, 'require-approval', command(), f.principal, context(f.record(null, 'refused')))).toBeUndefined();
    expect(find).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    // `approval: 'required'` in the catalog asks even when policy allows.
    const required = await f.broker.admit({ ...descriptor, approval: 'required', admitWithinMs: 1_000 }, 'allow', command(), f.principal, context());
    if (!required || !('pending' in required)) throw new Error('expected pending');
    f.time.wallMs = 2_000; await f.decide(required.pending.approvalId, 'allow');
    f.time.wallMs = 3_001;
    await expect(f.broker.admit({ ...descriptor, approval: 'required', admitWithinMs: 1_000 }, 'allow', command(), f.principal, context())).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    f.time.wallMs = 3_000;
    expect(await f.broker.admit({ ...descriptor, approval: 'required', admitWithinMs: 1_000 }, 'allow', command(), f.principal, context())).toMatchObject({ approval: { approvalId: required.pending.approvalId } });
    // Deny is a typed refusal for that command.
    const denied = await f.broker.admit(descriptor, 'require-approval', command('cmd-deny'), f.principal, context());
    if (!denied || !('pending' in denied)) throw new Error('expected pending');
    await f.decide(denied.pending.approvalId, 'deny');
    await expect(f.broker.admit(descriptor, 'require-approval', command('cmd-deny'), f.principal, context())).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    // An undecided request past its expiry is closed as expired (lazy, sealed) and refused.
    const stale = await f.broker.admit(descriptor, 'require-approval', command('cmd-stale'), f.principal, context());
    if (!stale || !('pending' in stale)) throw new Error('expected pending');
    f.time.wallMs = stale.pending.expiresAt;
    await expect(f.broker.admit(descriptor, 'require-approval', command('cmd-stale'), f.principal, context())).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    expect(f.journal.store.load('scope', stale.pending.approvalId)).toMatchObject({ status: 'expired', revision: 1 });
    await expect(f.broker.admit(descriptor, 'require-approval', command('cmd-stale'), f.principal, context())).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    // A decision recorded further ahead than the bounded skew is not trusted to extend the window.
    f.time.wallMs = 1_000;
    const ahead = await f.broker.admit(descriptor, 'require-approval', command('cmd-ahead'), f.principal, context());
    if (!ahead || !('pending' in ahead)) throw new Error('expected pending');
    f.time.wallMs = 20_000; await f.decide(ahead.pending.approvalId, 'allow');
    f.time.wallMs = 20_000 - MAX_WALL_SKEW_MS - 1;
    await expect(f.broker.admit(descriptor, 'require-approval', command('cmd-ahead'), f.principal, context())).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
    f.time.wallMs = 20_000 - MAX_WALL_SKEW_MS;
    expect(await f.broker.admit(descriptor, 'require-approval', command('cmd-ahead'), f.principal, context())).toMatchObject({ approval: { approvalId: ahead.pending.approvalId } });
  } finally { f.close(); }
});

it('waits for a decision without closing the request: timeout and cancel leave it pending, a decision or expiry ends the wait', async () => {
  const f = await fixture();
  try {
    const opened = await f.broker.admit(descriptor, 'require-approval', command(), f.principal, context());
    if (!opened || !('pending' in opened)) throw new Error('expected pending');
    const key = { scopeId: 'scope', approvalId: opened.pending.approvalId }, now = () => f.time.wallMs;
    // The fixture clock only moves when the test moves it: a timer steps it past the deadline while the wait polls.
    const step = (ms: number, after = 10) => setTimeout(() => { f.time.wallMs += ms; }, after);
    step(100);
    expect(await awaitOperationApproval(f.journal.store, integrity, key, now, f.time.wallMs + 50, undefined, 5)).toBe('timeout');
    const controller = new AbortController(); setTimeout(() => controller.abort(), 10);
    expect(await awaitOperationApproval(f.journal.store, integrity, key, now, f.time.wallMs + 50_000, controller.signal, 5)).toBe('cancelled');
    expect(f.journal.store.load('scope', key.approvalId)?.status).toBe('pending');
    const wait = awaitOperationApproval(f.journal.store, integrity, key, now, f.time.wallMs + 50_000, undefined, 5);
    setTimeout(() => { void f.decide(key.approvalId, 'allow'); }, 20);
    expect(await wait).toBe('allow');
    expect(await awaitOperationApproval(f.journal.store, integrity, { scopeId: 'scope', approvalId: 'absent' }, now, f.time.wallMs + 50, undefined, 5)).toBe('expired');
    const late = await f.broker.admit(descriptor, 'require-approval', command('cmd-late'), f.principal, context());
    if (!late || !('pending' in late)) throw new Error('expected pending');
    step(late.pending.expiresAt - f.time.wallMs);
    expect(await awaitOperationApproval(f.journal.store, integrity, { scopeId: 'scope', approvalId: late.pending.approvalId }, now, late.pending.expiresAt + 50_000, undefined, 5)).toBe('expired');
    // The waiter never closed anything: the request expires through the broker's own lazy close, not the wait.
    expect(f.journal.store.load('scope', late.pending.approvalId)?.status).toBe('pending');
  } finally { f.close(); }
});
