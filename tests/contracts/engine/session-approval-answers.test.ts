import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openSqliteApprovalStore, LocalOsSessionAuthority } from '#adapters/index.js';
import { ApprovalApplication, SessionApprovalAnswers, SessionStanding, approvalCommandSchema, approvalRenewalSchema, approvalCommandFingerprint,
  requestAgentToolApproval, requestTaskApproval, agentToolApprovalFacts, sessionApprovalResultSchema, acceptSessionStandingClearance, OperationApprovalBroker } from '#engine/index.js';
import type { ApprovalRecord } from '#domain/index.js';
import { createHmacIntegrity } from '#platform/index.js';

beforeEach(async context => {
  if (process.platform === 'linux') return;
  await expect(LocalOsSessionAuthority.create(['scope'], 60000, { sample: () => ({ wallMs: Date.now(), monotonicMs: 0 }) }))
    .rejects.toThrow('SESSION_REQUIRED');
  context.skip('SESSION_REQUIRED: local process session evidence requires Linux /proc; real refusal verified');
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(beforeCommit?: (record: ApprovalRecord) => void) {
  const root = await mkdtemp(join(tmpdir(), 's02-answer-'));
  const journal = openSqliteApprovalStore(join(root, 'ledger.db'), { busyTimeoutMs: 2000, journalMode: 'wal', durability: 'full' }, 'allow');
  const time = { wallMs: Date.now(), monotonicMs: 0 }, clock = { sample: () => ({ ...time }) };
  const sessions = await LocalOsSessionAuthority.create(['scope'], 60000, clock), { principal } = await sessions.verifySession(undefined);
  const integrity = createHmacIntegrity('key', randomBytes(32));
  const policy = { schemaVersion: 1, revision: 'policy', restrictions: [], grants: [
    { id: 'approval', effect: 'allow', principals: 'all', scopes: ['scope'], actions: 'all', resource: { kind: 'approval', ids: 'all' } }] };
  const controller = new AbortController(), answers = new SessionApprovalAnswers(controller.signal);
  const record = requestAgentToolApproval(journal.store, integrity, { scopeId: 'scope', requester: { id: principal.id, issuer: principal.issuer, subject: principal.subject }, policyRevision: 'policy', summary: 'edit',
    subject: { kind: 'agent-tool-call', turnId: 'turn', round: 1, index: 0, tool: 'edit_file', toolVersion: 1, resource: 'src/a.ts', argsDigest: 'a'.repeat(64) },
    createdAt: time.wallMs, expiresAt: time.wallMs + 30000, facts: agentToolApprovalFacts(policy, 'scope', 'edit-self-source') });
  const command = approvalCommandSchema.parse({ schemaVersion: 1, scopeId: 'scope', approvalId: record.request.approvalId, commandId: 'answer', expectedRevision: 0, decision: 'allow', reason: 'Reviewed', standing: 'session' });
  const app = new ApprovalApplication(journal.store, { verify: async () => principal }, sessions, { load: async () => policy }, integrity, clock, 'test', 20,
    beforeCommit, undefined, { producers: [{ level: 'turn-bound', rank: 1, attests: () => true }], peerPid: process.pid });
  const session = SessionStanding.sessionKey('scope', principal, 'conversation'), key = 'self-source-key';
  const register = (remember: Parameters<SessionApprovalAnswers['register']>[0]['remember']) => answers.register({ record, principal, peerPid: process.pid, session, key, clock,
    signal: controller.signal, started: { ...time }, remember })!;
  cleanups.push(async () => { controller.abort(); journal.close(); await rm(root, { recursive: true, force: true }); });
  return { path: join(root, 'ledger.db'), answers, principal, record, command, app, session, key, register, journal, controller, time, integrity, policy };
}
it('joins pending duplicates until the memory barrier; clear during audit prevents resurrection; replay cannot regrant after cleanup/restart', async () => {
  const f = await fixture(), audit = deferred(), entered = deferred();
  const remember = vi.fn(async (valid: () => boolean) => { entered.resolve(); await audit.promise; if (!valid()) return false; f.answers.memory.remember(f.session, f.key); return true; });
  const card = f.register(remember);
  const first = f.answers.answer(f.command, f.principal, process.pid, f.app); await entered.promise;
  const second = f.answers.answer(f.command, f.principal, process.pid, f.app);
  let complete = false; void second.then(() => { complete = true; }); await Promise.resolve(); expect(complete).toBe(false);
  f.answers.clear(f.session); audit.resolve();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toEqual(b); expect(a.standing).toEqual({ scope: 'session', status: 'not-saved', reason: 'revoked' });
  expect(a.record.decision?.decision).toBe('allow'); expect(remember).toHaveBeenCalledTimes(1); expect(f.answers.memory.has(f.session, f.key)).toBe(false);
  await card.wait(); card.close();
  for (const owner of [f.answers, new SessionApprovalAnswers()]) {
    expect((await owner.answer(f.command, f.principal, process.pid, f.app)).standing).toEqual({ scope: 'session', status: 'unconfirmed', reason: 'result-unavailable' });
    expect(owner.memory.has(f.session, f.key)).toBe(false);
  }
});
it('samples saved membership; retained replay observes clear without another callback and rejects changed intent or peer', async () => {
  const f = await fixture(); const remember = vi.fn(async () => { f.answers.memory.remember(f.session, f.key); return true; });
  f.register(remember);
  expect(sessionApprovalResultSchema.parse(await f.answers.answer(f.command, f.principal, process.pid, f.app)).standing.status).toBe('saved');
  await expect(f.answers.answer({ ...f.command, reason: 'Changed' }, f.principal, process.pid, f.app)).rejects.toThrow('APPROVAL_CONFLICT');
  await expect(f.answers.answer(f.command, f.principal, process.pid + 1, f.app)).rejects.toThrow('APPROVAL_DENIED');
  f.answers.clear(SessionStanding.sessionKey('scope', { ...f.principal, subject: 'another' }, 'conversation'));
  expect(f.answers.memory.has(f.session, f.key)).toBe(true);
  f.answers.clear(f.session);
  expect((await f.answers.answer(f.command, f.principal, process.pid, f.app)).standing).toEqual({ scope: 'session', status: 'not-saved', reason: 'revoked' });
  expect(remember).toHaveBeenCalledTimes(1);
});
it.each(['clear', 'cancel', 'wall', 'monotonic'] as const)('refuses a fresh %s-invalidated offer before any receipt or memory write', async mode => {
  const f = await fixture(), remember = vi.fn(async () => true); f.register(remember);
  if (mode === 'clear') f.answers.clear(f.session);
  if (mode === 'cancel') f.controller.abort();
  if (mode === 'wall') f.time.wallMs += 30000;
  if (mode === 'monotonic') f.time.monotonicMs += 30000;
  await expect(f.answers.answer(f.command, f.principal, process.pid, f.app)).rejects.toThrow('APPROVAL_INVALID');
  expect(f.journal.store.receipt('scope', 'answer')).toBeNull(); expect(remember).not.toHaveBeenCalled();
});
it('returns confirmed audit refusal with the sealed allow, and refuses unoffered/session task/always/deny/renewal inputs', async () => {
  const f = await fixture();
  await expect(f.answers.answer(f.command, f.principal, process.pid, f.app)).rejects.toThrow('APPROVAL_INVALID');
  f.register(async (_valid, refuse) => { refuse('audit-unavailable'); return false; });
  expect((await f.answers.answer(f.command, f.principal, process.pid, f.app)).standing).toEqual({ scope: 'session', status: 'not-saved', reason: 'audit-unavailable' });
  for (const extra of [{ standing: 'always' }, { decision: 'deny' }, { replayed: true }, { actor: 'owner' }, { pattern: '*' }, { standing: null }]) {
    expect(approvalCommandSchema.safeParse({ ...f.command, ...extra }).success).toBe(false);
  }
  expect(approvalRenewalSchema.safeParse(f.command).success).toBe(false);
  const task = requestTaskApproval(f.journal.store, f.integrity, { scopeId: 'scope', runId: 'run', taskId: 'task', requester: { id: f.principal.id, issuer: f.principal.issuer, subject: f.principal.subject },
    actionDigest: 'b'.repeat(64), policyRevision: 'policy', summary: 'task', createdAt: f.time.wallMs, expiresAt: f.time.wallMs + 1000 });
  await expect(f.app.decideWithSettlement({ ...f.command, commandId: 'session-task', approvalId: task.request.approvalId }, undefined, () => undefined)).rejects.toThrow('APPROVAL_INVALID');
  expect(f.journal.store.receipt('scope', 'session-task')).toBeNull(); expect(f.journal.store.load('scope', task.request.approvalId)?.status).toBe('pending');
  const broker = new OperationApprovalBroker(f.journal.store, f.integrity, { load: async () => f.policy }, { sample: () => ({ ...f.time }) }, { requestTtlMs: 30000, defaultAdmitWithinMs: 30000 });
  const operation = { id: 'fixture.write', version: 1 };
  const opened = await broker.admit({ schemaVersion: 1, operation, targetKind: 'record', effectClass: 'write', approval: 'policy', precondition: 'record-version', compensation: null, inputMaxBytes: 4096 }, 'require-approval',
    { schemaVersion: 1, commandId: 'operation', scopeId: 'scope', operation, target: { kind: 'record', id: 'one' }, idempotencyKey: 'operation', expectedVersion: 'v1', input: {} }, f.principal,
    { record: null, targetBinding: 'b'.repeat(64), inputDigest: 'c'.repeat(64) });
  if (!opened || !('pending' in opened)) throw new Error('Expected pending operation');
  await expect(f.app.decideWithSettlement({ ...f.command, commandId: 'session-operation', approvalId: opened.pending.approvalId }, undefined, () => undefined)).rejects.toThrow('APPROVAL_INVALID');
  expect(f.journal.store.receipt('scope', 'session-operation')).toBeNull(); expect(f.journal.store.load('scope', opened.pending.approvalId)?.status).toBe('pending');
});
it('keeps omitted-standing fingerprint bytes and conflicts once versus session receipts; strict clearance checks both identities', async () => {
  // Golden digest from a2393016's pre-session projection, independently encoded with sorted JSON keys and SHA-256.
  const legacy = approvalCommandSchema.parse({ schemaVersion: 1, commandId: 'legacy-once', scopeId: 'scope', approvalId: 'legacy-approval', expectedRevision: 0, decision: 'allow', reason: 'Reviewed' });
  expect(approvalCommandFingerprint('approval-command:1', legacy, { id: 'legacy-owner', issuer: 'local-os', subject: 'uid-1000' }))
    .toBe('4e94ed452f4a94259b8d2aaddbb7a96414f6e4258c0313c9bc6eaadea5b618c6');
  const f = await fixture(), { standing: _standing, ...once } = f.command as typeof f.command & { standing: 'session' };
  expect(_standing).toBe('session');
  const fingerprint = approvalCommandFingerprint('approval-command:1', once, f.principal);
  const record = await f.app.decide(once); expect(record.decision?.commandDigest).toBe(fingerprint);
  expect(JSON.stringify(await f.app.decide(once))).toBe(JSON.stringify(record));
  await expect(f.answers.answer(f.command, f.principal, process.pid, f.app)).rejects.toThrow('APPROVAL_CONFLICT');
  const input = { schemaVersion: 1 as const, scopeId: 'scope', sessionId: 'conversation' };
  expect(acceptSessionStandingClearance(input, { ...input, cleared: true })).toEqual({ ...input, cleared: true });
  for (const wrong of [{ scopeId: 'other' }, { sessionId: 'other' }, { principal: 'other' }, { cleared: false }]) {
    expect(() => acceptSessionStandingClearance(input, { ...input, cleared: true, ...wrong })).toThrow();
  }
});

it('a failed precommit attempt releases its join slot so a corrected live answer can retry', async () => {
  let fail = true;
  const f = await fixture(() => { if (fail) throw new Error('injected-commit-refusal'); });
  const remember = vi.fn(async () => { f.answers.memory.remember(f.session, f.key); return true; }); f.register(remember);
  await expect(f.answers.answer(f.command, f.principal, process.pid, f.app)).rejects.toThrow('injected-commit-refusal');
  expect(f.journal.store.receipt('scope', 'answer')).toBeNull(); expect(remember).not.toHaveBeenCalled();
  fail = false;
  expect((await f.answers.answer(f.command, f.principal, process.pid, f.app)).standing.status).toBe('saved');
  expect(remember).toHaveBeenCalledTimes(1);
});
it('a stopped service owner rejects an offer arriving after shutdown even with a still-live producer signal', async () => {
  const f = await fixture(), remember = vi.fn(async () => true);
  f.answers.stop();
  expect(f.controller.signal.aborted).toBe(false);
  expect(f.register(remember)).toBeNull();
  await expect(f.answers.answer(f.command, f.principal, process.pid, f.app)).rejects.toThrow('APPROVAL_INVALID');
  expect(f.journal.store.receipt('scope', 'answer')).toBeNull(); expect(remember).not.toHaveBeenCalled();
});
it('clear at the final synchronous precommit boundary wins; a second SQLite writer producing exact replay never invokes remember', async () => {
  let onCommit: (record: ApprovalRecord) => void = () => undefined;
  const f = await fixture(record => onCommit(record)), remember = vi.fn(async () => true); f.register(remember);
  onCommit = () => f.answers.clear(f.session);
  await expect(f.answers.answer(f.command, f.principal, process.pid, f.app)).rejects.toThrow('APPROVAL_INVALID');
  expect(f.journal.store.receipt('scope', 'answer')).toBeNull(); expect(remember).not.toHaveBeenCalled();
  let compete: (record: ApprovalRecord) => void = () => undefined;
  const g = await fixture(record => compete(record)), replayRemember = vi.fn(async () => true); g.register(replayRemember);
  const writer = openSqliteApprovalStore(g.path, { busyTimeoutMs: 2000, journalMode: 'wal', durability: 'full' });
  try {
    compete = record => { writer.store.transitionWithSettlement(g.record, record, { scopeId: 'scope', commandId: 'answer', fingerprint: record.decision!.commandDigest, record }); };
    expect((await g.answers.answer(g.command, g.principal, process.pid, g.app)).standing).toEqual({ scope: 'session', status: 'unconfirmed', reason: 'result-unavailable' });
    expect(replayRemember).not.toHaveBeenCalled(); expect(g.answers.memory.has(g.session, g.key)).toBe(false);
  } finally { writer.close(); }
});
