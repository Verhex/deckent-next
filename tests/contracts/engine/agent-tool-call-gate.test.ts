import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LocalOsSessionAuthority, openSqliteApprovalStore } from '#adapters/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { effectRecordSchema, type ApprovalSubject, type EffectCommand, type EffectRecord, type OperationDescriptor } from '#domain/index.js';
import { ApprovalApplication, EffectApplication, agentToolApprovalFacts, OperationPolicyAuthorization, agentToolCallActionDigest, agentToolCallApprovalGate, awaitAgentToolApproval, requestAgentToolApproval,
  type AgentToolCallAdmission, type EffectApprovalContext } from '#engine/index.js';
import { MAX_WALL_SKEW_MS, createHmacIntegrity, type IntegrityAuthority } from '#platform/index.js';

// C12 G3: the in-turn effect gate of agent edits/shell admits only from the durable agent-tool-call record of exactly the executed call.
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('key', randomBytes(32));
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const descriptor: OperationDescriptor = { schemaVersion: 1, operation: { id: 'workspace.file.write', version: 1 }, targetKind: 'workspace-file', effectClass: 'write',
  approval: 'policy', precondition: 'none', compensation: null, inputMaxBytes: 4096 };
type ToolCallSubject = Extract<ApprovalSubject, { kind: 'agent-tool-call' }>;
const subjectAt = (index = 0, args = 'a'): ToolCallSubject => ({ kind: 'agent-tool-call', turnId: 'turn', round: 1, index, tool: 'edit_file', toolVersion: 1,
  resource: 'src/a.ts', argsDigest: digest(args) });
const command = (commandId = 'cmd-1', extra: Partial<EffectCommand> = {}): EffectCommand => ({ schemaVersion: 1, commandId, scopeId: 'scope', operation: descriptor.operation,
  target: { kind: 'workspace-file', id: 'src/a.ts' }, idempotencyKey: commandId, input: { content: 'x' }, expectedVersion: null, ...extra });
const context = (record: EffectRecord | null = null): EffectApprovalContext => ({ record, targetBinding: digest('binding'), inputDigest: digest('input') });
const policy = { schemaVersion: 1, revision: 'p1', restrictions: [], grants: [
  { id: 'decide', effect: 'allow', principals: 'all', scopes: ['scope'], actions: 'all', resource: { kind: 'approval', ids: 'all' } }] };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dn-tool-gate-')); roots.push(root); const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close();
  const journal = openSqliteApprovalStore(path, options);
  const time = { wallMs: 1_000, monotonicMs: 1_000 };
  const clock = { sample: () => ({ ...time }) };
  const sessions = await LocalOsSessionAuthority.create(['scope'], 600_000, clock); const { principal } = await sessions.verifySession(undefined);
  const decisions = new ApprovalApplication(journal.store, { verify: async () => principal }, sessions, { load: async () => policy }, integrity, clock, 'terminal', 10);
  const requester = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
  /** Opens the stored request of one call as the turn does, at the current time. */
  const request = (subject: ToolCallSubject, ttlMs = 60_000) => {
    const started = clock.sample();
    // An ordinary edit cell (B1: peer-session suffices, so the gate is exercised without a turn capability).
    const record = requestAgentToolApproval(journal.store, integrity, { scopeId: 'scope', requester, subject, policyRevision: 'p1', summary: 'Edit', facts: agentToolApprovalFacts(policy, 'scope', 'edit'),
      createdAt: started.wallMs, expiresAt: started.wallMs + ttlMs });
    return { record, pointer: { approvalId: record.request.approvalId, actionDigest: record.request.actionDigest, started } };
  };
  const decide = (approvalId: string, decision: 'allow' | 'deny') => decisions.decide({ schemaVersion: 1, scopeId: 'scope', approvalId, commandId: `decide-${approvalId}`,
    expectedRevision: 0, decision, reason: 'Reviewed' });
  let opened = 0;
  const gate = (call: Partial<AgentToolCallAdmission> = {}, consumed = new Map<string, string>(), key: IntegrityAuthority = integrity) =>
    agentToolCallApprovalGate(async () => { opened++; return { store: journal.store, integrity: key }; }, clock,
      { scopeId: 'scope', subject: subjectAt(), approval: null, ...call }, consumed);
  const record = (approval: { approvalId: string; actionDigest: string } | null, state: EffectRecord['state'] = 'claimed', cmd = command()): EffectRecord => effectRecordSchema.parse({
    intent: { schemaVersion: 1, command: cmd, descriptor, actor: requester, idempotencyKeyHash: digest('k'), inputDigest: digest('input'), wireKey: digest('w'),
      targetBinding: digest('binding'), ...(approval ? { approval } : {}) },
    sequence: 1, state, evidence: state === 'settled' ? { kind: 'idempotency-record', version: 'v2', observedAt: 1 } : null, refusal: state === 'refused' ? 'EFFECT_REJECTED' : null });
  return { journal, time, clock, sessions, principal, requester, request, decide, gate, record, opened: () => opened, close: () => journal.close() };
}

it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] admits an edit or shell effect only from a sealed allow of exactly this call; pending, deny, expired, missing or unverifiable records are typed refusals', async () => {
  const f = await fixture();
  try {
    // Nobody was asked and the effect allows: no approval is read at all. An effect that asks without an allowed call is refused.
    expect(await f.gate().admit(descriptor, 'allow', command(), f.principal, context())).toBeUndefined();
    expect(f.opened()).toBe(0);
    await expect(f.gate().admit(descriptor, 'require-approval', command(), f.principal, context())).rejects.toMatchObject({ code: 'EFFECT_APPROVAL_REQUIRED' });
    await expect(f.gate().admit({ ...descriptor, approval: 'required' }, 'allow', command(), f.principal, context())).rejects.toMatchObject({ code: 'EFFECT_APPROVAL_REQUIRED' });
    expect(f.opened()).toBe(0);

    // The turn was told allow, but the stored request is undecided: refused even when the effect itself would allow (owner-asked call).
    const asked = f.request(subjectAt());
    await expect(f.gate({ approval: asked.pointer }).admit(descriptor, 'allow', command(), f.principal, context())).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await expect(f.gate({ approval: { ...asked.pointer, approvalId: 'absent' } }).admit(descriptor, 'allow', command(), f.principal, context()))
      .rejects.toMatchObject({ code: 'APPROVAL_MISSING' });
    f.time.wallMs = 2_000; f.time.monotonicMs = 2_000;
    await f.decide(asked.pointer.approvalId, 'allow');
    expect(await f.gate({ approval: asked.pointer }).admit(descriptor, 'allow', command(), f.principal, context()))
      .toEqual({ approval: { approvalId: asked.pointer.approvalId, actionDigest: agentToolCallActionDigest('scope', subjectAt()) } });
    expect(await f.gate({ approval: asked.pointer }).admit(descriptor, 'require-approval', command(), f.principal, context())).toMatchObject({ approval: { approvalId: asked.pointer.approvalId } });
    // A record sealed under another key is not this installation's approval.
    await expect(f.gate({ approval: asked.pointer }, new Map(), createHmacIntegrity('key', randomBytes(32))).admit(descriptor, 'allow', command(), f.principal, context()))
      .rejects.toMatchObject({ code: 'APPROVAL_INTEGRITY' });

    const denied = f.request(subjectAt(1));
    await f.decide(denied.pointer.approvalId, 'deny');
    await expect(f.gate({ subject: subjectAt(1), approval: denied.pointer }).admit(descriptor, 'allow', command('cmd-deny'), f.principal, context()))
      .rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    const lapsed = f.request(subjectAt(2), 1_000);
    f.time.wallMs = 3_000; f.time.monotonicMs = 3_000;
    expect(await awaitAgentToolApproval(f.journal.store, integrity, lapsed.record, f.clock, new AbortController().signal, 250, lapsed.pointer.started)).toBe('expired');
    await expect(f.decide(lapsed.pointer.approvalId, 'allow')).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    await expect(f.gate({ subject: subjectAt(2), approval: lapsed.pointer }).admit(descriptor, 'allow', command('cmd-lapsed'), f.principal, context()))
      .rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
  } finally { f.close(); }
});

it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] binds the allow to the executed call: other arguments, another call position, a forged digest, another requester or scope never admit', async () => {
  const f = await fixture();
  try {
    const allowed = f.request(subjectAt());
    await f.decide(allowed.pointer.approvalId, 'allow');
    const refuse = (call: Partial<AgentToolCallAdmission>, cmd = command(), principal = f.principal) =>
      expect(f.gate({ approval: allowed.pointer, ...call }).admit(descriptor, 'allow', cmd, principal, context())).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
    // The subject is rebuilt from the call being executed: an allow of other arguments or another position is not this call's.
    await refuse({ subject: subjectAt(0, 'other arguments') });
    await refuse({ subject: subjectAt(1) });
    await refuse({ subject: { ...subjectAt(), resource: 'src/b.ts' } });
    await refuse({ subject: { ...subjectAt(), turnId: 'another-turn' } });
    await refuse({ approval: { ...allowed.pointer, actionDigest: digest('forged') } });
    await refuse({}, command('cmd-1', { scopeId: 'other' }));
    await refuse({}, command(), { ...f.principal, subject: 'someone-else' });
    expect(await f.gate({ approval: allowed.pointer }).admit(descriptor, 'allow', command(), f.principal, context())).toMatchObject({ approval: { approvalId: allowed.pointer.approvalId } });
  } finally { f.close(); }
});

it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] measures the allow at the claim: wall expiry, the producer monotonic budget and a decision from the future refuse it', async () => {
  const f = await fixture();
  try {
    const allowed = f.request(subjectAt());
    await f.decide(allowed.pointer.approvalId, 'allow');
    const admit = () => f.gate({ approval: allowed.pointer }).admit(descriptor, 'allow', command(), f.principal, context());
    f.time.wallMs = 60_999; f.time.monotonicMs = 60_999;
    await expect(admit()).resolves.toMatchObject({ approval: { approvalId: allowed.pointer.approvalId } });
    f.time.wallMs = 61_000;
    await expect(admit()).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    // The wall clock stepped back, but the producer's monotonic TTL is spent.
    f.time.wallMs = 30_000; f.time.monotonicMs = 61_000;
    await expect(admit()).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    // A decision stamped further ahead than the bounded skew is not trusted.
    const ahead = f.request(subjectAt(1)); f.time.monotonicMs = 30_000;
    f.time.wallMs = 40_000; await f.decide(ahead.pointer.approvalId, 'allow');
    f.time.wallMs = 40_000 - MAX_WALL_SKEW_MS - 1;
    await expect(f.gate({ subject: subjectAt(1), approval: ahead.pointer }).admit(descriptor, 'allow', command('cmd-ahead'), f.principal, context()))
      .rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
  } finally { f.close(); }
});

it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] uses an allow once: it admits one command (again at its later passes), pins it in the intent, and never admits a second command', async () => {
  const f = await fixture();
  try {
    const allowed = f.request(subjectAt());
    await f.decide(allowed.pointer.approvalId, 'allow');
    const consumed = new Map<string, string>(), gate = f.gate({ approval: allowed.pointer }, consumed);
    const admitted = await gate.admit(descriptor, 'allow', command(), f.principal, context());
    expect(await gate.admit(descriptor, 'allow', command(), f.principal, context())).toEqual(admitted);
    await expect(gate.admit(descriptor, 'allow', command('cmd-2'), f.principal, context())).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
    await expect(f.gate({ approval: allowed.pointer }, consumed).admit(descriptor, 'allow', command('cmd-2'), f.principal, context())).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
    if (!admitted || !('approval' in admitted)) throw new Error('expected admission');
    // Pinned: later passes verify the consumed record, whatever the clock says now; a pin naming another digest or call is refused.
    f.time.wallMs = 500_000; f.time.monotonicMs = 500_000;
    expect(await f.gate({}, consumed).admit(descriptor, 'allow', command(), f.principal, context(f.record(admitted.approval)))).toEqual(admitted);
    expect(await f.gate({ approval: allowed.pointer }, consumed).admit(descriptor, 'allow', command(), f.principal, context(f.record(admitted.approval, 'unknown')))).toEqual(admitted);
    await expect(f.gate({}, consumed).admit(descriptor, 'allow', command(), f.principal, context(f.record({ ...admitted.approval, actionDigest: digest('forged') }))))
      .rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
    await expect(f.gate({ subject: subjectAt(3) }, consumed).admit(descriptor, 'allow', command(), f.principal, context(f.record(admitted.approval))))
      .rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
    // Terminal records replay without reading any approval.
    const before = f.opened();
    expect(await f.gate({ approval: allowed.pointer }).admit(descriptor, 'require-approval', command(), f.principal, context(f.record(admitted.approval, 'settled')))).toBeUndefined();
    expect(await f.gate({ approval: allowed.pointer }).admit(descriptor, 'require-approval', command(), f.principal, context(f.record(null, 'refused')))).toBeUndefined();
    expect(f.opened()).toBe(before);
  } finally { f.close(); }
});

it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] runs the approved effect once through the C11 application: an allow that lapses while the target is observed claims nothing; a replay applies nothing again', async () => {
  const f = await fixture();
  const gated = { ...policy, grants: [{ id: 'effect', effect: 'allow', principals: 'all', scopes: ['scope'], actions: 'all', resource: { kind: 'operation', ids: 'all' } }, ...policy.grants] };
  let saved: EffectRecord | null = null, applied = 0, claims = 0, observeAt: number | null = null;
  const target = { kind: 'workspace-file', identity: () => 'workspace',
    observe: async () => { if (observeAt !== null) { f.time.wallMs = observeAt; f.time.monotonicMs = observeAt; } return { version: 'v1' }; },
    apply: async () => { applied++; return { version: 'v2' }; },
    lookup: async () => ({ status: 'absent' as const }) };
  const store = {
    loadEffect: async () => saved,
    claimEffect: async (intent: EffectRecord['intent']) => { claims++; saved = effectRecordSchema.parse({ intent, sequence: 1, state: 'claimed', evidence: null, refusal: null }); return saved; },
    saveEffect: async (_previous: EffectRecord, next: EffectRecord) => { saved = next; return next; },
  };
  const versioned = { ...descriptor, precondition: 'record-version' as const };
  const app = (call: Partial<AgentToolCallAdmission>) => new EffectApplication({ resolve: async () => versioned }, { resolve: () => target }, store, f.gate(call),
    f.sessions, new OperationPolicyAuthorization({ load: async () => gated }), f.clock);
  try {
    const lapsing = f.request(subjectAt(1), 10_000);
    await f.decide(lapsing.pointer.approvalId, 'allow');
    observeAt = 11_000;
    await expect(app({ subject: subjectAt(1), approval: lapsing.pointer }).execute(command('cmd-lapse', { expectedVersion: 'v1' }))).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    expect(claims).toBe(0); expect(applied).toBe(0);

    observeAt = null;
    const allowed = f.request(subjectAt());
    await f.decide(allowed.pointer.approvalId, 'allow');
    expect(await app({ approval: allowed.pointer }).execute(command('cmd-1', { expectedVersion: 'v1' }))).toMatchObject({ status: 'settled', version: 'v2' });
    expect(claims).toBe(1); expect(applied).toBe(1);
    expect(saved?.intent.approval).toEqual({ approvalId: allowed.pointer.approvalId, actionDigest: agentToolCallActionDigest('scope', subjectAt()) });
    // A replay of the same command (a new turn pass, no pointer) returns the settled outcome: no approval is needed, nothing is applied again.
    f.time.wallMs = 500_000; f.time.monotonicMs = 500_000;
    expect(await app({}).execute(command('cmd-1', { expectedVersion: 'v1' }))).toMatchObject({ status: 'settled' });
    expect(claims).toBe(1); expect(applied).toBe(1);
  } finally { f.close(); }
});
