import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteApprovalStore, upgradeExistingProductLedger } from '#adapters/index.js';
import { CONFIG_CHANGE_APPROVAL_LEDGER_VERSION, CURRENT_LEDGER_VERSION, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { approvalSubject, type ApprovalRecord } from '#domain/index.js';
import { approvalRequestDigest, approvalResultForProtocol, approvalSubjectsHiddenFromProtocol, CONFIG_CHANGE_SUBJECT_PROTOCOL_VERSION, ConfigChangeApprovalBroker, configChangeApprovalActionDigest,
  requestTaskApproval, RUNTIME_SERVICE_SCHEMA_VERSION, sealApproval, verifyApproval, type ConfigChangeSubject } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { DOWNGRADE_TO_PREVIOUS_LEDGER_SQL, PREVIOUS_LEDGER_VERSION } from '../../fixtures/ledger-previous.js';

// T3 L2 CONFIG-APPROVAL: the `config-change` approval subject — ledger v48, the broker's pending/allow/deny/expiry/window, protocol hiding.
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('key', randomBytes(32));
const requester = { id: 'owner', issuer: 'host', subject: '1000' };
const decider = { id: 'admin', issuer: 'host', subject: '1001' };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
async function ledger() { const root = await mkdtemp(join(tmpdir(), 'dn-config-approval-')); roots.push(root); const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close(); return path; }
const subject = (over: Partial<ConfigChangeSubject> = {}): ConfigChangeSubject => ({ kind: 'config-change', commandId: 'cmd-1', action: 'set', layer: 'project', keyPath: 'terminal.theme',
  before: '"auto"', after: '"dark"', expectDigest: digest('layer-0'), valueDigest: digest('"dark"'), ruleId: 'company-config-approval', ...over });
class Clock { constructor(public now = 10_000) {} sample() { return { wallMs: this.now, monoMs: this.now }; } }
const request = (s = subject()) => ({ scopeId: 'scope', requester, subject: s, policy: null, policyRevision: 'p1', summary: 'ayar değişecek: terminal.theme auto → dark (proje)' });
/** A sealed decision as the one decision path writes it (the decision application itself is covered by the approval suites). */
function decide(store: ReturnType<typeof openSqliteApprovalStore>['store'], record: ApprovalRecord, decision: 'allow' | 'deny', decidedAt: number, requestDigest = approvalRequestDigest(record.request)) {
  const next = sealApproval({ request: record.request, revision: 1, status: 'decided', decision: { schemaVersion: 2, commandId: `decide-${record.request.approvalId}`, decision,
    actor: decider, sessionId: 'session', channel: 'local-terminal-card', reason: decision === 'allow' ? 'Allowed in the terminal' : 'Denied in the terminal', decidedAt,
    requestDigest, commandDigest: digest('c'), idempotencyKeyHash: digest('k'), assurance: 'peer-session' } }, integrity);
  return store.transition(record, next);
}

describe('ledger v48: config-change approvals', () => {
  it('upgrades the previous ledger (v47) row for row; v47 refuses a config-change row, v48 stores and finds one by its digest only under its own kind', async () => {
    const path = await ledger(), backups = join(path, '..', 'backups'); await mkdir(backups, { mode: 0o700 });
    expect(CONFIG_CHANGE_APPROVAL_LEDGER_VERSION).toBe(CURRENT_LEDGER_VERSION); expect(PREVIOUS_LEDGER_VERSION).toBe(CURRENT_LEDGER_VERSION - 1);
    const seeded = openSqliteApprovalStore(path, options);
    const task = requestTaskApproval(seeded.store, integrity, { scopeId: 'scope', runId: 'run', taskId: 'a', requester, actionDigest: digest('task-a'), policyRevision: 'p1', summary: 'a', createdAt: 1_000, expiresAt: 61_000 });
    seeded.close();
    const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL);
    expect(() => db.prepare('INSERT INTO approvals(scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot) VALUES(?,?,?,?,?,?,?,?)')
      .run('scope', 'cfg', 'config-change', null, null, digest('cfg'), 0, '{}')).toThrow(/CHECK/);
    const before = db.prepare('SELECT * FROM approvals ORDER BY approval_id').all(); db.close();
    const upgrade = await upgradeExistingProductLedger(path, options, backups, new Date('2026-10-07T00:00:00.000Z'));
    expect(upgrade).toMatchObject({ from: PREVIOUS_LEDGER_VERSION, to: CURRENT_LEDGER_VERSION });
    const store = openSqliteApprovalStore(path, options);
    try {
      const check = new DatabaseSync(path, { readOnly: true });
      try { expect(check.prepare('SELECT * FROM approvals ORDER BY approval_id').all()).toEqual(before); } finally { check.close(); }
      expect(verifyApproval(store.store.load('scope', task.request.approvalId), integrity)).toEqual(task);
      const broker = new ConfigChangeApprovalBroker(store.store, integrity, new Clock(), { requestTtlMs: 60_000, admitWithinMs: 60_000 });
      const opened = broker.admit(request());
      expect(opened).toMatchObject({ pending: { revision: 0, expiresAt: 70_000 } });
      const actionDigest = configChangeApprovalActionDigest('scope', subject(), requester);
      const found = store.store.findConfigChange('scope', actionDigest)!;
      expect(approvalSubject(found.request)).toEqual(subject());
      expect(found.request).toMatchObject({ schemaVersion: 3, facts: { risk: { source: 'effect-class', effectClass: 'write', authority: false }, reversibility: null,
        onExpiry: 'nothing-runs', requiredAssurance: 'peer-session' } });
      expect(store.store.findOperation('scope', actionDigest)).toBeNull(); expect(store.store.findToolCall('scope', actionDigest)).toBeNull();
      // The same change asked again is the same request (create is idempotent on the digest): one card, not two.
      expect(broker.admit(request())).toEqual(opened);
      expect(store.store.list('scope', null, 10)).toHaveLength(2);
    } finally { store.close(); }
  });
});

describe('ConfigChangeApprovalBroker', () => {
  async function fixture() {
    const opened = openSqliteApprovalStore(await ledger(), options), clock = new Clock();
    const broker = new ConfigChangeApprovalBroker(opened.store, integrity, clock, { requestTtlMs: 60_000, admitWithinMs: 30_000 });
    return { ...opened, clock, broker, record: () => opened.store.findConfigChange('scope', configChangeApprovalActionDigest('scope', subject(), requester))! };
  }
  it('admits an allowed change only within its admission window; a decision not bound to this request is an integrity refusal', async () => {
    const f = await fixture();
    try {
      expect(f.broker.admit(request())).toHaveProperty('pending');
      const allowed = decide(f.store, f.record(), 'allow', 12_000);
      expect(f.broker.admit(request())).toEqual({ approved: { approvalId: allowed.request.approvalId, actionDigest: allowed.request.actionDigest } });
      f.clock.now = 12_000 + 30_001;
      expect(() => f.broker.admit(request())).toThrow('APPROVAL_EXPIRED');
      const other = subject({ commandId: 'cmd-bound' }); f.broker.admit(request(other));
      decide(f.store, f.store.findConfigChange('scope', configChangeApprovalActionDigest('scope', other, requester))!, 'allow', 43_000, digest('another request'));
      expect(() => f.broker.admit(request(other))).toThrow('APPROVAL_INTEGRITY');
    } finally { f.close(); }
  });
  it('refuses a denied, an expired and a stale-window approval; another value, layer, digest or command is another request', async () => {
    const f = await fixture();
    try {
      f.broker.admit(request());
      decide(f.store, f.record(), 'deny', 11_000);
      expect(() => f.broker.admit(request())).toThrow('APPROVAL_DENIED');
      for (const other of [{ valueDigest: digest('"light"'), after: '"light"' }, { layer: 'global' as const }, { expectDigest: digest('layer-1') }, { commandId: 'cmd-2' }]) {
        expect(f.broker.admit(request(subject(other)))).toHaveProperty('pending');
      }
      const late = subject({ commandId: 'cmd-late' }); f.broker.admit(request(late)); f.clock.now = 70_000;
      expect(() => f.broker.admit(request(late))).toThrow('APPROVAL_EXPIRED');
      expect(f.store.findConfigChange('scope', configChangeApprovalActionDigest('scope', late, requester))!.status).toBe('expired');
    } finally { f.close(); }
  });
  it('refuses an inconsistent subject (unset with a value, set without one) before anything is stored', async () => {
    const f = await fixture();
    try {
      expect(() => f.broker.admit(request(subject({ action: 'unset' })))).toThrow('APPROVAL_INVALID');
      expect(() => f.broker.admit(request(subject({ after: null, valueDigest: null })))).toThrow('APPROVAL_INVALID');
      expect(f.store.list('scope', null, 10)).toEqual([]);
    } finally { f.close(); }
  });
});

describe('protocol: released clients never receive a config-change record', () => {
  it('hides config-change below v22 (alpha.10 speaks v21) and operations below v15; v22 sees every kind', () => {
    expect(CONFIG_CHANGE_SUBJECT_PROTOCOL_VERSION).toBe(22); expect(RUNTIME_SERVICE_SCHEMA_VERSION).toBeLessThanOrEqual(CONFIG_CHANGE_SUBJECT_PROTOCOL_VERSION);
    expect(approvalSubjectsHiddenFromProtocol(21)).toEqual(['config-change']);
    expect(approvalSubjectsHiddenFromProtocol(14)).toEqual(['operation', 'config-change']);
    expect(approvalSubjectsHiddenFromProtocol(22)).toEqual([]);
    const record = { request: { schemaVersion: 3, subject: subject() } } as unknown as ApprovalRecord;
    expect(() => approvalResultForProtocol(21, 'inspect', record)).toThrow('APPROVAL_MISSING');
    expect(approvalResultForProtocol(22, 'inspect', record)).toBe(record);
    expect(approvalResultForProtocol(21, 'list', [record])).toEqual([record]);
  });
});
