import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { LocalOsSessionAuthority, openSqliteApprovalStore } from '#adapters/index.js';
import { CURRENT_LEDGER_VERSION, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { approvalRequestSchema, approvalSubject } from '#domain/index.js';
import { ApprovalApplication, requestTaskApproval, sealApproval, verifyApproval } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { DOWNGRADE_TO_PREVIOUS_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('key', randomBytes(32));
const requester = { id: 'owner', issuer: 'host', subject: '1000' };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
async function ledger() { const root = await mkdtemp(join(tmpdir(), 'dn-approval-c12-')); roots.push(root); const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close(); return path; }
const toolCall = (index = 0, argsDigest = digest('args')) => sealApproval({ request: approvalRequestSchema.parse({ schemaVersion: 2, approvalId: `tool-${index}-${argsDigest.slice(0, 6)}`,
  scopeId: 'scope', subject: { kind: 'agent-tool-call', turnId: 'turn-1', round: 2, index, tool: 'edit_file', toolVersion: 1, resource: 'src/a.ts', argsDigest },
  requester, actionDigest: digest(`call:${index}:${argsDigest}`), policyRevision: 'p1', summary: 'edit_file · src/a.ts', createdAt: 1_000, expiresAt: 61_000 }),
revision: 0, status: 'pending', decision: null }, integrity);

it('keeps every existing task approval byte for byte across the v38 rebuild, still verifying its seal (C12)', async () => {
  const path = await ledger();
  const first = openSqliteApprovalStore(path, options);
  const task = requestTaskApproval(first.store, integrity, { scopeId: 'scope', runId: 'run', taskId: 'a', requester, actionDigest: digest('task-a'),
    policyRevision: 'p1', summary: 'a', createdAt: 1_000, expiresAt: 61_000 });
  first.close();
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL);
  const before = db.prepare('SELECT * FROM approvals').all(); db.close();
  const upgraded = openSqliteApprovalStore(path, options, 'allow');
  try {
    expect(upgraded.store.load('scope', task.request.approvalId)).toEqual(task);
    expect(verifyApproval(upgraded.store.load('scope', task.request.approvalId), integrity)).toEqual(task);
    expect(upgraded.store.find('scope', 'run', 'a', digest('task-a'))).toEqual(task);
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: CURRENT_LEDGER_VERSION });
      expect(check.prepare('SELECT scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot,current FROM approvals').all())
        .toEqual(before.map(row => ({ ...row, subject_kind: 'task' })));
    } finally { check.close(); }
  } finally { upgraded.close(); }
});

it('stores an agent tool-call approval by its exact action digest, lists it beside tasks, decides it, and never renews it', async () => {
  const path = await ledger(), journal = openSqliteApprovalStore(path, options);
  try {
    const first = journal.store.create(toolCall(0));
    expect(approvalSubject(first.request)).toMatchObject({ kind: 'agent-tool-call', tool: 'edit_file', resource: 'src/a.ts' });
    // The same exact call returns the same pending approval; another call (other index or arguments) is another approval.
    expect(journal.store.create(toolCall(0))).toEqual(first);
    const other = journal.store.create(toolCall(1));
    expect(other.request.approvalId).not.toBe(first.request.approvalId);
    expect(journal.store.findToolCall('scope', first.request.actionDigest)).toEqual(first);
    expect(journal.store.find('scope', 'run', 'a', first.request.actionDigest)).toBeNull();
    requestTaskApproval(journal.store, integrity, { scopeId: 'scope', runId: 'run', taskId: 'a', requester, actionDigest: digest('task-a'),
      policyRevision: 'p1', summary: 'a', createdAt: 1_000, expiresAt: 61_000 });
    expect(journal.store.list('scope', null, 10).map(record => approvalSubject(record.request).kind).sort()).toEqual(['agent-tool-call', 'agent-tool-call', 'task']);

    const clock = { sample: () => ({ wallMs: 2_000, monotonicMs: 2 }) };
    const sessions = await LocalOsSessionAuthority.create(['scope'], 60_000, clock); const { principal } = await sessions.verifySession(undefined);
    const policy = { schemaVersion: 1, revision: 'p1', restrictions: [], grants: [
      { id: 'decide', effect: 'allow', principals: 'all', scopes: ['scope'], actions: 'all', resource: { kind: 'approval', ids: 'all' } }] };
    const approvals = new ApprovalApplication(journal.store, { verify: async () => principal }, sessions, { load: async () => policy }, integrity, clock, 'terminal', 10);
    const decided = await approvals.decide({ schemaVersion: 1, scopeId: 'scope', approvalId: first.request.approvalId, commandId: 'allow-edit',
      expectedRevision: 0, decision: 'allow', reason: 'Reviewed diff' });
    expect(decided).toMatchObject({ status: 'decided', decision: { decision: 'allow' } });
    const denied = await approvals.decide({ schemaVersion: 1, scopeId: 'scope', approvalId: other.request.approvalId, commandId: 'deny-edit',
      expectedRevision: 0, decision: 'deny', reason: 'Not this one' });
    await expect(approvals.renew({ schemaVersion: 1, scopeId: 'scope', approvalId: denied.request.approvalId, commandId: 'renew-edit',
      expectedRevision: 1, reason: 'again' }, 60_000)).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
  } finally { journal.close(); }
});

it('refuses a malformed tool-call subject and cannot downgrade a ledger holding tool-call approvals', async () => {
  expect(approvalRequestSchema.safeParse({ ...toolCall(0).request, subject: { ...approvalSubject(toolCall(0).request), tool: 'Edit File' } }).success).toBe(false);
  expect(approvalRequestSchema.safeParse({ ...toolCall(0).request, subject: { kind: 'task', runId: 'r' } }).success).toBe(false);
  const path = await ledger(), journal = openSqliteApprovalStore(path, options);
  journal.store.create(toolCall(0)); journal.close();
  const db = new DatabaseSync(path);
  try { expect(() => db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL)).toThrow(/NOT NULL/); } finally { db.close(); }
});
