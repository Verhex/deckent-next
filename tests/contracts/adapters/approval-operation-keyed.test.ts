import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { LocalOsSessionAuthority, openSqliteApprovalStore, upgradeExistingProductLedger } from '#adapters/index.js';
import { CURRENT_LEDGER_VERSION, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { approvalRequestSchema, approvalSubject } from '#domain/index.js';
import { ApprovalApplication, awaitAgentToolApproval, expireOrphanedToolCallApprovals, requestTaskApproval, sealApproval, verifyApproval, type ApprovalStore } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { DOWNGRADE_TO_V39_LEDGER_SQL, DOWNGRADE_TO_V37_LEDGER_SQL, PREVIOUS_LEDGER_VERSION } from '../../fixtures/ledger-previous.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('key', randomBytes(32));
const requester = { id: 'owner', issuer: 'host', subject: '1000' };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
async function ledger() { const root = await mkdtemp(join(tmpdir(), 'dn-approval-c12-')); roots.push(root); const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close(); return path; }
// Request v3 (B1) as the turn produces it: an ordinary edit cell, so a peer-session decision suffices.
const toolCall = (index = 0, argsDigest = digest('args')) => sealApproval({ request: approvalRequestSchema.parse({ schemaVersion: 3, approvalId: `tool-${index}-${argsDigest.slice(0, 6)}`,
  scopeId: 'scope', subject: { kind: 'agent-tool-call', turnId: 'turn-1', round: 2, index, tool: 'edit_file', toolVersion: 1, resource: 'src/a.ts', argsDigest },
  requester, actionDigest: digest(`call:${index}:${argsDigest}`), policyRevision: 'p1', summary: 'edit_file · src/a.ts', createdAt: 1_000, expiresAt: 61_000,
  facts: { risk: { source: 'cell', cell: 'edit' }, reversibility: null, onExpiry: 'nothing-runs', requiredAssurance: 'peer-session' } }),
revision: 0, status: 'pending', decision: null }, integrity);
const operation = (commandId = 'cmd-1', inputDigest = digest('input')) => sealApproval({ request: approvalRequestSchema.parse({ schemaVersion: 2, approvalId: `op-${commandId}-${inputDigest.slice(0, 6)}`,
  scopeId: 'scope', subject: { kind: 'operation', operation: { id: 'post-order', version: 1 }, target: { kind: 'records', id: 'PO-1' }, commandId, inputDigest,
    targetBinding: digest('binding'), expectedVersion: '"v1"', compensates: null },
  requester, actionDigest: digest(`operation:${commandId}:${inputDigest}`), policyRevision: 'p1', summary: 'post-order@1 · records/PO-1', createdAt: 1_000, expiresAt: 61_000 }),
revision: 0, status: 'pending', decision: null }, integrity);

it('upgrades a real v39 ledger through v40 (C12 G1) to the current version: backup at v39 first, task and tool-call approvals byte for byte with verifying seals, then operation approvals are admitted', async () => {
  const path = await ledger(), backups = join(path, '..', 'backups'); await mkdir(backups, { mode: 0o700 });
  expect(CURRENT_LEDGER_VERSION).toBe(50); expect(PREVIOUS_LEDGER_VERSION).toBe(49);
  const seeded = openSqliteApprovalStore(path, options);
  const task = requestTaskApproval(seeded.store, integrity, { scopeId: 'scope', runId: 'run', taskId: 'a', requester, actionDigest: digest('task-a'),
    policyRevision: 'p1', summary: 'a', createdAt: 1_000, expiresAt: 61_000 });
  const call = seeded.store.create(toolCall(0));
  seeded.close();
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_V39_LEDGER_SQL);
  // v39 cannot hold an operation approval; the v40 rebuild is what admits it.
  expect(() => db.prepare('INSERT INTO approvals(scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot) VALUES(?,?,?,?,?,?,?,?)')
    .run('scope', 'op', 'operation', null, null, digest('op'), 0, '{}')).toThrow(/CHECK/);
  const before = db.prepare('SELECT * FROM approvals ORDER BY approval_id').all(); db.close();
  const upgrade = await upgradeExistingProductLedger(path, options, backups, new Date('2026-09-27T00:00:00.000Z'));
  expect(upgrade).toEqual({ from: 39, to: CURRENT_LEDGER_VERSION, backupPath: join(backups, 'ledger-v39-2026-09-27T00-00-00-000Z.db') });
  if (process.platform !== 'win32') expect((await stat(upgrade!.backupPath)).mode & 0o777).toBe(0o600);
  else expect((await stat(upgrade!.backupPath)).isFile()).toBe(true); // Windows modes do not prove a 0600 ACL.
  const backup = new DatabaseSync(upgrade!.backupPath, { readOnly: true });
  try { expect(backup.prepare('PRAGMA user_version').get()).toEqual({ user_version: 39 }); expect(backup.prepare('SELECT * FROM approvals ORDER BY approval_id').all()).toEqual(before); }
  finally { backup.close(); }
  const upgraded = openSqliteApprovalStore(path, options);
  try {
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: CURRENT_LEDGER_VERSION });
      expect(check.prepare('SELECT * FROM approvals ORDER BY approval_id').all()).toEqual(before);
      expect(check.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='approvals' ORDER BY name").all().map(row => row.name))
        .toEqual(['approvals_current_action', 'approvals_current_config_change', 'approvals_current_operation', 'approvals_current_tool_call', 'sqlite_autoindex_approvals_1']);
    } finally { check.close(); }
    expect(verifyApproval(upgraded.store.load('scope', task.request.approvalId), integrity)).toEqual(task);
    expect(verifyApproval(upgraded.store.findToolCall('scope', call.request.actionDigest), integrity)).toEqual(call);
    const first = upgraded.store.create(operation());
    expect(approvalSubject(first.request)).toMatchObject({ kind: 'operation', commandId: 'cmd-1' });
    expect(upgraded.store.findOperation('scope', first.request.actionDigest)).toEqual(first);
    expect(upgraded.store.findToolCall('scope', first.request.actionDigest)).toBeNull();
    // A subject kind outside the contract is refused by the ledger itself.
    const raw = new DatabaseSync(path);
    try {
      expect(() => raw.prepare('INSERT INTO approvals(scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot) VALUES(?,?,?,?,?,?,?,?)')
        .run('scope', 'x', 'process', null, null, digest('x'), 0, '{}')).toThrow(/CHECK/);
      // A ledger holding an operation approval cannot go back to v39: the rebuild fails on the narrower CHECK (one transaction, so the
      // audit-table drop of the intermediate v40 step rolls back with it).
      raw.exec('BEGIN');
      expect(() => raw.exec(DOWNGRADE_TO_V39_LEDGER_SQL)).toThrow(/CHECK/);
      raw.exec('ROLLBACK');
      expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: CURRENT_LEDGER_VERSION });
    } finally { raw.close(); }
  } finally { upgraded.close(); }
});

it('[requires Linux live OS session /proc identity] stores an operation approval by its exact action digest: idempotent open, one current row per digest, never renewed, untouched by the tool-call sweep (C12 G1)', async context => {
  if (process.platform !== 'linux') context.skip('SESSION_REQUIRED: live OS session identity requires Linux /proc');
  const path = await ledger(), journal = openSqliteApprovalStore(path, options);
  try {
    const first = journal.store.create(operation());
    expect(journal.store.create(operation())).toEqual(first);
    const otherInput = journal.store.create(operation('cmd-1', digest('other-input'))), otherCommand = journal.store.create(operation('cmd-2'));
    expect(new Set([first, otherInput, otherCommand].map(record => record.request.approvalId)).size).toBe(3);
    // The partial unique index keeps one current row per (scope, digest) for operations.
    const raw = new DatabaseSync(path);
    try {
      expect(() => raw.prepare('INSERT INTO approvals(scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot) VALUES(?,?,?,?,?,?,?,?)')
        .run('scope', 'dup', 'operation', null, null, first.request.actionDigest, 0, JSON.stringify(first))).toThrow(/UNIQUE/);
    } finally { raw.close(); }
    const clock = { sample: () => ({ wallMs: 2_000, monotonicMs: 2 }) };
    const sessions = await LocalOsSessionAuthority.create(['scope'], 60_000, clock); const { principal } = await sessions.verifySession(undefined);
    const policy = { schemaVersion: 1, revision: 'p1', restrictions: [], grants: [
      { id: 'decide', effect: 'allow', principals: 'all', scopes: ['scope'], actions: 'all', resource: { kind: 'approval', ids: 'all' } }] };
    const approvals = new ApprovalApplication(journal.store, { verify: async () => principal }, sessions, { load: async () => policy }, integrity, clock, 'terminal', 10);
    const denied = await approvals.decide({ schemaVersion: 1, scopeId: 'scope', approvalId: otherCommand.request.approvalId, commandId: 'deny-op',
      expectedRevision: 0, decision: 'deny', reason: 'Not this one' });
    await expect(approvals.renew({ schemaVersion: 1, scopeId: 'scope', approvalId: denied.request.approvalId, commandId: 'renew-op',
      expectedRevision: 1, reason: 'again' }, 60_000)).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    // Service start closes orphaned tool-call approvals only: an operation approval belongs to its command, not to a turn.
    const call = journal.store.create(toolCall(0));
    expect(journal.store.pendingToolCalls(null, 10)).toEqual([{ scopeId: 'scope', approvalId: call.request.approvalId }]);
    expect(expireOrphanedToolCallApprovals(journal.store, integrity, 10)).toEqual({ expired: 1, failed: 0 });
    expect(journal.store.load('scope', first.request.approvalId)?.status).toBe('pending');
    expect(journal.store.load('scope', otherInput.request.approvalId)?.status).toBe('pending');
    expect(journal.store.load('scope', call.request.approvalId)?.status).toBe('expired');
  } finally { journal.close(); }
});

it('keeps every existing task approval byte for byte across the v38 rebuild, still verifying its seal (C12)', async () => {
  const path = await ledger();
  const first = openSqliteApprovalStore(path, options);
  const task = requestTaskApproval(first.store, integrity, { scopeId: 'scope', runId: 'run', taskId: 'a', requester, actionDigest: digest('task-a'),
    policyRevision: 'p1', summary: 'a', createdAt: 1_000, expiresAt: 61_000 });
  first.close();
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_V37_LEDGER_SQL);
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

it('[requires Linux live OS session /proc identity] stores an agent tool-call approval by its exact action digest, lists it beside tasks, decides it, and never renews it', async context => {
  if (process.platform !== 'linux') context.skip('SESSION_REQUIRED: live OS session identity requires Linux /proc');
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
  try { expect(() => db.exec(DOWNGRADE_TO_V37_LEDGER_SQL)).toThrow(/NOT NULL/); } finally { db.close(); }
});

/** The real store with `transition` failing: always (a lasting I/O error), or once, optionally after a racing writer's own transition. */
function faulty(store: ApprovalStore, mode: 'always' | 'once', race?: (record: import('#domain/index.js').ApprovalRecord) => void) {
  let failures = 0;
  return new Proxy(store, { get(target, property) {
    if (property === 'transition') return (...args: Parameters<ApprovalStore['transition']>) => {
      if (mode === 'always' || failures++ === 0) { race?.(args[0]); throw new Error('SQLITE_IOERR: disk I/O error'); }
      return target.transition(...args);
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
const decided = (record: import('#domain/index.js').ApprovalRecord, decision: 'allow' | 'deny') => sealApproval({ request: record.request, revision: 1, status: 'decided',
  decision: { commandId: 'race', decision, actor: requester, sessionId: 'session', channel: 'terminal', reason: 'raced', decidedAt: 2_000,
    requestDigest: digest('request'), commandDigest: digest('command'), idempotencyKeyHash: digest('race') } }, integrity);
const aborted = () => { const controller = new AbortController(); controller.abort(); return controller.signal; };

// Astra 2092 R2 (inverted repro): a close that did not happen is never reported as done; the record stays truthfully pending.
for (const path of ['cancel', 'expiry'] as const) {
  it(`reports APPROVAL_UNSETTLED when the ${path} close keeps failing, and the stored request stays pending`, async () => {
    const journal = openSqliteApprovalStore(await ledger(), options);
    try {
      const record = journal.store.create(toolCall(0));
      const wait = path === 'cancel' ? awaitAgentToolApproval(faulty(journal.store, 'always'), integrity, record, { sample: () => ({ wallMs: 2_000, monotonicMs: 0 }) }, aborted())
        : awaitAgentToolApproval(faulty(journal.store, 'always'), integrity, record, { sample: () => ({ wallMs: 61_000, monotonicMs: 0 }) }, new AbortController().signal);
      await expect(wait).rejects.toMatchObject({ code: 'APPROVAL_UNSETTLED' });
      expect(journal.store.load('scope', record.request.approvalId)?.status).toBe('pending');
    } finally { journal.close(); }
  });
}

it('closes on a later attempt after a transient failure, and a racing writer\'s settled record is authoritative', async () => {
  const journal = openSqliteApprovalStore(await ledger(), options);
  try {
    // Transient failure: the second attempt closes the request as expired.
    const first = journal.store.create(toolCall(0));
    expect(await awaitAgentToolApproval(faulty(journal.store, 'once'), integrity, first, { sample: () => ({ wallMs: 61_000, monotonicMs: 0 }) }, new AbortController().signal)).toBe('expired');
    expect(journal.store.load('scope', first.request.approvalId)?.status).toBe('expired');
    // I40-c A: at expiry, a racing allow remains durable history but cannot authorize consumption.
    const second = journal.store.create(toolCall(1));
    const allowFirst = faulty(journal.store, 'once', record => journal.store.transition(record, decided(record, 'allow')));
    expect(await awaitAgentToolApproval(allowFirst, integrity, second, { sample: () => ({ wallMs: 61_000, monotonicMs: 0 }) }, new AbortController().signal)).toBe('expired');
    expect(journal.store.load('scope', second.request.approvalId)).toMatchObject({ status: 'decided', decision: { decision: 'allow' } });
    // A cancelled turn runs nothing even when a decision raced its close; the stored decision is left as recorded.
    const third = journal.store.create(toolCall(2));
    const allowRace = faulty(journal.store, 'once', record => journal.store.transition(record, decided(record, 'allow')));
    expect(await awaitAgentToolApproval(allowRace, integrity, third, { sample: () => ({ wallMs: 2_000, monotonicMs: 0 }) }, aborted())).toBe('cancelled');
    expect(journal.store.load('scope', third.request.approvalId)).toMatchObject({ status: 'decided', decision: { decision: 'allow' } });
  } finally { journal.close(); }
});

it('expires every pending tool-call approval at service start, page by page and across scopes, leaving task and settled approvals alone', async () => {
  const journal = openSqliteApprovalStore(await ledger(), options);
  try {
    const pending = [journal.store.create(toolCall(0)), journal.store.create(toolCall(1)), journal.store.create(toolCall(2))];
    const other = journal.store.create(sealApproval({ request: { ...toolCall(3).request, scopeId: 'scope-b', approvalId: 'tool-b' }, revision: 0, status: 'pending', decision: null }, integrity));
    journal.store.transition(pending[2]!, decided(pending[2]!, 'deny'));
    const task = requestTaskApproval(journal.store, integrity, { scopeId: 'scope', runId: 'run', taskId: 'a', requester, actionDigest: digest('task-a'),
      policyRevision: 'p1', summary: 'a', createdAt: 1_000, expiresAt: 61_000 });
    expect(journal.store.pendingToolCalls(null, 10)).toEqual([{ scopeId: 'scope', approvalId: pending[0]!.request.approvalId },
      { scopeId: 'scope', approvalId: pending[1]!.request.approvalId }, { scopeId: 'scope-b', approvalId: 'tool-b' }]);
    expect(expireOrphanedToolCallApprovals(journal.store, integrity, 1)).toEqual({ expired: 3, failed: 0 });
    for (const record of [pending[0]!, pending[1]!, other]) expect(journal.store.load(record.request.scopeId, record.request.approvalId)?.status).toBe('expired');
    expect(journal.store.load('scope', pending[2]!.request.approvalId)).toMatchObject({ status: 'decided', decision: { decision: 'deny' } });
    expect(journal.store.load('scope', task.request.approvalId)).toEqual(task);
    expect(journal.store.pendingToolCalls(null, 10)).toEqual([]);
    // A record whose seal does not verify is counted, never closed or guessed.
    const forged = journal.store.create(toolCall(4));
    expect(expireOrphanedToolCallApprovals(journal.store, createHmacIntegrity('other', randomBytes(32)), 10)).toEqual({ expired: 0, failed: 1 });
    expect(journal.store.load('scope', forged.request.approvalId)?.status).toBe('pending');
  } finally { journal.close(); }
});

it('upgrade backup has private POSIX 0600 permissions', async context => {
  if (process.platform === 'win32') context.skip('POSIX_MODE_UNAVAILABLE: Windows chmod modes do not prove a private ACL');
  const root = await mkdtemp(join(tmpdir(), 'deckent-approval-backup-mode-')); roots.push(root);
  const path = join(root, 'ledger.db'); const db = openSqliteLedger(path, options);
  db.exec(DOWNGRADE_TO_V39_LEDGER_SQL); db.close();
  const backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
  const upgrade = await upgradeExistingProductLedger(path, options, backups, new Date());
  expect((await stat(upgrade!.backupPath)).mode & 0o777).toBe(0o600);
});
