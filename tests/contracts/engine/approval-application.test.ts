import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHmacIntegrity } from '../../../src/platform/core/integrity/index.js';
import { openSqliteApprovalStore } from '../../../src/adapters/core/approval-store/index.js';
import { LocalOsSessionAuthority } from '../../../src/adapters/core/local-principal/index.js';
import { ApprovalApplication, requestTaskApproval, verifyApproval, type ApprovalAssuranceOptions } from '../../../src/engine/core/approval/index.js';
import { approvalRecordSchema, type ApprovalRecord } from '#domain/index.js';
import { SQLITE_STORAGE_OPTIONS } from '../../../src/platform/core/config-fields/index.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-approval-')); const path = join(root, 'ledger.db');
  const journal = openSqliteApprovalStore(path, SQLITE_STORAGE_OPTIONS.parse({ busyTimeoutMs: 2000, journalMode: 'wal', durability: 'full' }), 'allow');
  const clock = { wallMs: 1000, monotonicMs: 100 };
  const time = { sample: () => ({ ...clock }) };
  const session = await LocalOsSessionAuthority.create(['scope'], 10000, time);
  const evidence = await session.verifySession(undefined);
  const verifier = { verify: async () => evidence.principal };
  const policy = { schemaVersion: 1, revision: 'policy', restrictions: [], grants: [
    { id: 'approval', effect: 'allow', principals: 'all', scopes: ['scope'], actions: 'all', resource: { kind: 'approval', ids: 'all' } },
  ] };
  const integrity = createHmacIntegrity('key', randomBytes(32));
  const make = (channel: string, options: { beforeCommit?: (record: ApprovalRecord) => void; assurance?: ApprovalAssuranceOptions } = {}) =>
    new ApprovalApplication(journal.store, verifier, session, { load: async () => policy }, integrity, time, channel, 20, options.beforeCommit, undefined, options.assurance);
  const actor = evidence.session.principalRef;
  const record = requestTaskApproval(journal.store, integrity, { scopeId: 'scope', runId: 'run', taskId: 'task', requester: actor,
    actionDigest: 'a'.repeat(64), policyRevision: 'policy', summary: 'Execute task', createdAt: 1000, expiresAt: 1100 });
  const command = { schemaVersion: 1, scopeId: 'scope', approvalId: record.request.approvalId, commandId: 'decision', expectedRevision: 0, decision: 'allow', reason: 'Approved task' };
  return { journal, path, make, record, command, clock, session, integrity, policy,
    close: async () => { journal.close(); await rm(root, { recursive: true, force: true }); } };
}
describe('S02 trusted producer settlement and unchanged durable record', () => {
  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] producer settlement distinguishes one fresh decision from concurrent and historical replays without changing stored or legacy bytes', async () => {
    const f = await fixture(), settle = vi.fn();
    const assurance = { producers: [{ level: 'turn-bound', rank: 1, attests: () => true, settle }] };
    try {
      const results = await Promise.all(['cli', 'mcp', 'sdk'].map(channel => f.make(channel, { assurance }).decideWithSettlement(f.command)));
      expect(results.map(result => result.commit).sort()).toEqual(['fresh', 'replay', 'replay']);
      expect(settle).toHaveBeenCalledTimes(1);
      const record = results[0]!.record, bytes = JSON.stringify(record);
      for (const result of results) expect(JSON.stringify(result.record)).toBe(bytes);
      expect(JSON.stringify(await f.make('legacy').decide(f.command))).toBe(bytes);
      expect(await f.make('producer').decideWithSettlement(f.command)).toEqual({ record, commit: 'replay' });
      expect(() => approvalRecordSchema.parse(record)).not.toThrow();
      expect(record).not.toHaveProperty('commit');
      const db = new DatabaseSync(f.path);
      try {
        expect(db.prepare('SELECT snapshot FROM approvals WHERE approval_id=?').get(record.request.approvalId)?.snapshot).toBe(bytes);
        expect(db.prepare('SELECT snapshot FROM approval_receipts WHERE command_id=?').get(f.command.commandId)?.snapshot).toBe(bytes);
        expect(db.prepare('SELECT snapshot FROM approval_outbox WHERE revision=1').get()?.snapshot).toBe(bytes);
        expect(db.prepare('SELECT COUNT(*) AS n FROM approval_receipts').get()?.n).toBe(1);
        expect(db.prepare('SELECT COUNT(*) AS n FROM approval_outbox').get()?.n).toBe(2);
      } finally { db.close(); }
    } finally { await f.close(); }
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] a second connection winning after the receipt miss returns transaction-local replay and does not spend the losing B1 attestation', async () => {
    const f = await fixture(), settle = vi.fn();
    const competing = openSqliteApprovalStore(f.path, SQLITE_STORAGE_OPTIONS.parse({ busyTimeoutMs: 2000, journalMode: 'wal', durability: 'full' }));
    try {
      const app = f.make('loser', { assurance: { producers: [{ level: 'turn-bound', rank: 1, attests: () => true, settle }] }, beforeCommit: next => {
        // This synchronous injection is a real second SQLite writer after application preflight, before its atomic transition.
        expect(competing.store.transitionWithSettlement(f.record, next, { scopeId: f.command.scopeId, commandId: f.command.commandId,
          fingerprint: next.decision!.commandDigest, record: next }).commit).toBe('fresh');
      } });
      const result = await app.decideWithSettlement(f.command);
      expect(result.commit).toBe('replay');
      expect(result.record).toEqual(competing.store.receipt('scope', f.command.commandId)?.record);
      expect(settle).not.toHaveBeenCalled();
      expect(await app.decideWithSettlement(f.command)).toEqual(result);
      await expect(app.decideWithSettlement({ ...f.command, reason: 'Changed intent' })).rejects.toThrow('APPROVAL_CONFLICT');
    } finally { competing.close(); await f.close(); }
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] failed transitions never spend an attestation or create a receipt', async () => {
    const f = await fixture(), settle = vi.fn();
    try {
      const app = f.make('cli', { assurance: { producers: [{ level: 'turn-bound', rank: 1, attests: () => true, settle }] },
        beforeCommit: () => { throw new Error('injected-before-commit'); } });
      await expect(app.decideWithSettlement(f.command)).rejects.toThrow('injected-before-commit');
      expect(settle).not.toHaveBeenCalled();
      expect(f.journal.store.receipt('scope', f.command.commandId)).toBeNull();
      expect(f.journal.store.load('scope', f.record.request.approvalId)).toEqual(f.record);
    } finally { await f.close(); }
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] caller-authored settlement metadata is refused before decision commit', async () => {
    const f = await fixture();
    try {
      for (const claim of [{ commit: 'fresh' }, { replayed: false }, { record: f.record }, { principal: f.record.request.requester }]) {
        await expect(f.make('cli').decideWithSettlement({ ...f.command, ...claim })).rejects.toThrow('APPROVAL_INVALID');
        expect(f.journal.store.load('scope', f.record.request.approvalId)).toEqual(f.record);
        expect(f.journal.store.receipt('scope', f.command.commandId)).toBeNull();
      }
    } finally { await f.close(); }
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] a receipt insertion failure rolls back record and outbox without spending B1 evidence', async () => {
    const f = await fixture(), settle = vi.fn(), db = new DatabaseSync(f.path);
    try {
      db.exec("CREATE TRIGGER refuse_receipt BEFORE INSERT ON approval_receipts BEGIN SELECT RAISE(ABORT, 'injected-receipt-failure'); END");
      const app = f.make('cli', { assurance: { producers: [{ level: 'turn-bound', rank: 1, attests: () => true, settle }] } });
      await expect(app.decideWithSettlement(f.command)).rejects.toThrow('injected-receipt-failure');
      expect(settle).not.toHaveBeenCalled();
      expect(f.journal.store.load('scope', f.record.request.approvalId)).toEqual(f.record);
      expect(f.journal.store.receipt('scope', f.command.commandId)).toBeNull();
      expect(db.prepare('SELECT COUNT(*) AS n FROM approval_outbox').get()?.n).toBe(1);
      db.exec('DROP TRIGGER refuse_receipt');
      expect((await app.decideWithSettlement(f.command)).commit).toBe('fresh');
      expect(settle).toHaveBeenCalledTimes(1);
    } finally { db.close(); await f.close(); }
  });
});

describe('durable verified approval application', () => {

  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] racing surfaces with one command return one signed decision and one receipt/outbox transition', async () => {
    const f = await fixture();
    try {
      const [cli, mcp] = await Promise.all([f.make('cli').decide(f.command), f.make('mcp').decide(f.command)]);
      expect(cli).toEqual(mcp); expect(cli.status).toBe('decided');
      expect(verifyApproval(cli, f.integrity).decision?.decision).toBe('allow');
      const replay = await f.make('sdk').decide(f.command); expect(replay).toEqual(cli);
      await expect(f.make('sdk').decide({ ...f.command, decision: 'deny' })).rejects.toThrow('APPROVAL_CONFLICT');
      const db = new DatabaseSync(f.path); try {
        expect(db.prepare('SELECT COUNT(*) AS n FROM approval_receipts').get()?.n).toBe(1);
        expect(db.prepare('SELECT COUNT(*) AS n FROM approval_outbox').get()?.n).toBe(2);
      } finally { db.close(); }
      const reopened = openSqliteApprovalStore(f.path, SQLITE_STORAGE_OPTIONS.parse({ busyTimeoutMs: 2000, journalMode: 'wal', durability: 'full' }));
      try { expect(reopened.store.load('scope', cli.request.approvalId)).toEqual(cli); } finally { reopened.close(); }
    } finally { await f.close(); }
  });
  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] records a decision no earlier than the request when the host wall clock has stepped back (measured on WSL2)', async () => {
    const f = await fixture();
    try {
      // The request was created at 1020 by a process whose clock was ahead; this process decides at its own 1000.
      const ahead = requestTaskApproval(f.journal.store, f.integrity, { scopeId: 'scope', runId: 'run', taskId: 'task',
        requester: f.record.request.requester, actionDigest: 'b'.repeat(64), policyRevision: 'policy', summary: 'Execute task', createdAt: 1020, expiresAt: 1100 });
      const decided = await f.make('cli').decide({ ...f.command, approvalId: ahead.request.approvalId, commandId: 'ahead' });
      expect(decided).toMatchObject({ status: 'decided', decision: { decidedAt: 1020 } });
      expect(verifyApproval(decided, f.integrity).status).toBe('decided');
    } finally { await f.close(); }
  });
  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] a conflicting decision has one winner and leaves no second receipt', async () => {
    const f = await fixture();
    try {
      const results = await Promise.allSettled([f.make('cli').decide(f.command), f.make('mcp').decide({ ...f.command, commandId: 'other', decision: 'deny' })]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    } finally { await f.close(); }
  });
  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] expiry before and during reauthentication never grants approval', async () => {
    for (const during of [false, true]) {
      const f = await fixture();
      try {
        if (during) {
          const verify = f.session.verifySession.bind(f.session);
          f.session.verifySession = async credential => { const result = await verify(credential); f.clock.wallMs = 1100; return result; };
        } else f.clock.wallMs = 1100;
        await expect(f.make('cli').decide(f.command)).rejects.toThrow('APPROVAL_EXPIRED');
        expect(f.journal.store.load('scope', f.record.request.approvalId)?.status).toBe('expired');
        expect(f.journal.store.receipt('scope', 'decision')).toBeNull();
      } finally { await f.close(); }
    }
  });
  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] explicit renewal preserves the expired request, starts a new pending request and replays exactly', async () => {
    const f = await fixture();
    try {
      f.clock.wallMs = 1100;
      await expect(f.make('cli').decide(f.command)).rejects.toThrow('APPROVAL_EXPIRED');
      const { schemaVersion, scopeId, approvalId, commandId, expectedRevision, reason } = f.command;
      const base = { schemaVersion, scopeId, approvalId, commandId, expectedRevision, reason };
      const command = { ...base, commandId: 'renew-request', expectedRevision: 1 };
      const next = await f.make('cli').renew(command, 100);
      expect(next.status).toBe('pending'); expect(next.request.approvalId).not.toBe(base.approvalId);
      expect(f.journal.store.load('scope', base.approvalId)?.status).toBe('expired');
      expect(f.journal.store.find('scope', 'run', 'task', 'a'.repeat(64))).toEqual(next);
      expect(await f.make('mcp').renew(command, 100)).toEqual(next);
      await expect(f.make('mcp').renew({ ...command, commandId: 'second-renew' }, 100)).rejects.toThrow('APPROVAL_CONFLICT');
      await f.make('cli').decide({ ...f.command, approvalId: next.request.approvalId, commandId: 'allow-renewed' });
    } finally { await f.close(); }
  });
  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] denies static credentials, revoked sessions, foreign scope, changed bytes and caller channel fields', async () => {
    const f = await fixture();
    try {
      // B1: a client may declare a channel (a record, never authority) but never an assurance; an unregistered channel is refused where the
      // composition passes its registry (approval-assurance.test.ts).
      await expect(f.make('cli').decide({ ...f.command, assurance: 'turn-bound' })).rejects.toThrow('APPROVAL_INVALID');
      await expect(f.make('cli').decide(f.command, 'static-bearer')).rejects.toThrow('SESSION_REQUIRED');
      await expect(f.make('cli').inspect({ schemaVersion: 1, scopeId: 'foreign', approvalId: f.record.request.approvalId })).rejects.toThrow('AUTHENTICATION_SCOPE_DENIED');
      const { session } = await f.session.verifySession(undefined); await f.session.revoke(session.sessionId);
      await expect(f.make('cli').decide(f.command)).rejects.toThrow('SESSION_REQUIRED');
      const db = new DatabaseSync(f.path); try {
        db.prepare('UPDATE approvals SET snapshot=?').run(JSON.stringify({ ...f.record, request: { ...f.record.request, summary: 'tampered' } }));
      } finally { db.close(); }
      await expect(f.make('cli').inspect({ schemaVersion: 1, scopeId: 'scope', approvalId: f.record.request.approvalId })).rejects.toThrow('APPROVAL_INTEGRITY');
    } finally { await f.close(); }
  });
});
