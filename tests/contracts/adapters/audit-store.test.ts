import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AuditError, type AuditEvent } from '#domain/index.js';
import { AuditApplication, verifyAuditRecord } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { openSqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { AUDIT_EVENT_LEDGER_VERSION, CURRENT_LEDGER_VERSION, openSqliteLedger, readScopeCompanies } from '#adapters/core/sqlite-ledger/index.js';
import { upgradeExistingProductLedger } from '#adapters/index.js';
import { DOWNGRADE_TO_PREVIOUS_LEDGER_SQL, PREVIOUS_LEDGER_VERSION } from '../../fixtures/ledger-previous.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('audit-key', randomBytes(32));
const rows = (path: string, sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
const version = (path: string) => rows(path, 'PRAGMA user_version')[0]?.user_version;
async function ledger(prefix = 'dn-audit-') {
  const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
  openSqliteLedger(path, options).close();
  return { path, backups };
}
/** A permission-mode relaxation as the agent turn will report it (design note §4): summary only, no raw command or file content. */
function event(scopeId: string, n: number, cell: 'edit-non-floor' | 'shell-modify' = 'edit-non-floor'): AuditEvent {
  return {
    schemaVersion: 1, eventId: `${scopeId}-evt-${n}`, scopeId, principal: { issuer: 'local-os', subject: 'alperen' }, policyRevision: 'p7', atMs: 1_700_000_000_000 + n,
    subject: { kind: 'permission-mode', mode: 'auto-edit', cell, tool: { name: cell === 'shell-modify' ? 'shell' : 'edit_file', version: 1 },
      call: { turnId: 'turn-1', round: 1, index: n, callId: `call-${n}` }, grants: { company: 'company-edit', person: 'alperen-auto-edit' },
      decision: { previous: 'require-approval', next: 'allow' },
      summary: cell === 'shell-modify' ? { kind: 'shell', head: 'git commit -m x', argsDigest: 'a'.repeat(64) } : { kind: 'edit', path: `src/file-${n}.ts` } },
  };
}

it('upgrades a real v40 ledger to v41 (audit events): 0600 backup at v40 first, every row kept, then the append-only audit table admits events', async () => {
  const { path, backups } = await ledger();
  expect(CURRENT_LEDGER_VERSION).toBe(41); expect(AUDIT_EVENT_LEDGER_VERSION).toBe(41); expect(PREVIOUS_LEDGER_VERSION).toBe(40);
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL);
  db.prepare('INSERT INTO approvals(scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot) VALUES(?,?,?,?,?,?,?,?)')
    .run('scope', 'op', 'operation', null, null, 'b'.repeat(64), 0, '{"op":1}');
  db.prepare("INSERT INTO agent_turns VALUES(?,?,?,?,'finished',?)").run('scope', 't1', 'p', 'd'.repeat(64), '{"turn":1}');
  const before = { approvals: db.prepare('SELECT * FROM approvals').all(), turns: db.prepare('SELECT * FROM agent_turns').all() };
  db.close();
  expect(version(path)).toBe(40);
  expect(rows(path, "SELECT name FROM sqlite_schema WHERE name IN('audit_events','audit_counters')")).toEqual([]);
  // A v40 build refuses to open an unmigrated ledger without migration and never migrates on a forbid open.
  expect(() => openSqliteLedger(path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  expect(version(path)).toBe(40);

  const upgrade = await upgradeExistingProductLedger(path, options, backups, new Date('2026-09-27T12:00:00.000Z'));
  const backupPath = join(backups, 'ledger-v40-2026-09-27T12-00-00-000Z.db');
  expect(upgrade).toEqual({ from: 40, to: 41, backupPath });
  expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
  expect(version(backupPath)).toBe(40);
  expect(rows(backupPath, 'SELECT * FROM approvals')).toEqual(before.approvals);
  expect(version(path)).toBe(41);
  expect(rows(path, 'SELECT * FROM approvals')).toEqual(before.approvals);
  expect(rows(path, 'SELECT * FROM agent_turns')).toEqual(before.turns);
  expect(rows(path, "SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='audit_events' ORDER BY name").map(row => row.name))
    .toEqual(['audit_events_no_delete', 'audit_events_no_update']);

  const store = await openSqliteAuditStore(path, options, 'forbid');
  try {
    const audit = new AuditApplication(store, integrity);
    const first = audit.record(event('scope', 1));
    expect(first.sequence).toBe(1);
    expect(verifyAuditRecord(first, integrity)).toEqual(first);
    // Same event id with the same content replays; another content is a conflict.
    expect(audit.record(event('scope', 1))).toEqual(first);
    expect(() => audit.record({ ...event('scope', 1), atMs: 5 })).toThrow(expect.objectContaining({ code: 'AUDIT_CONFLICT' }));
    // Append-only is a ledger guarantee: raw UPDATE and DELETE fail in the database itself.
    const raw = new DatabaseSync(path);
    try {
      expect(() => raw.prepare("UPDATE audit_events SET record='{}' WHERE scope_id='scope'").run()).toThrow(/AUDIT_APPEND_ONLY/);
      expect(() => raw.prepare("DELETE FROM audit_events WHERE scope_id='scope'").run()).toThrow(/AUDIT_APPEND_ONLY/);
      expect(raw.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual({ n: 1 });
    } finally { raw.close(); }
    expect(audit.list('scope', 0, 10)).toEqual([first]);
  } finally { store.close(); }
});

it('refuses a ledger newer than this build (an older build meets v41 the same way) on writer opens and the read-only registry lookup', async () => {
  const { path } = await ledger('dn-audit-newer-');
  const db = new DatabaseSync(path); db.exec(`PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1};`); db.close();
  for (const mode of ['allow', 'forbid'] as const) expect(() => openSqliteLedger(path, options, mode)).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  expect(() => readScopeCompanies(path, 100, ['s'])).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  await expect(openSqliteAuditStore(path, options, 'forbid')).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
  expect(version(path)).toBe(CURRENT_LEDGER_VERSION + 1);
});

it('detects tampering through the approval MAC line: an altered record, a forged row and a renumbered sequence are refused on read', async () => {
  const { path } = await ledger('dn-audit-tamper-');
  const store = await openSqliteAuditStore(path, options, 'forbid');
  try {
    const audit = new AuditApplication(store, integrity);
    const [one, two, three] = [audit.record(event('scope', 1)), audit.record(event('scope', 2)), audit.record(event('scope', 3))];
    expect(audit.list('scope', 0, 10)).toEqual([one, two, three]);
    const raw = new DatabaseSync(path);
    try {
      raw.exec('DROP TRIGGER audit_events_no_update; DROP TRIGGER audit_events_no_delete;');
      // Content altered under a valid seal → integrity failure (row columns still match).
      const altered = JSON.stringify({ ...two, event: { ...two.event, subject: { ...two.event.subject, summary: { kind: 'edit', path: 'src/other.ts' } } } });
      raw.prepare('UPDATE audit_events SET record=? WHERE scope_id=? AND sequence=2').run(altered, 'scope');
      expect(() => audit.list('scope', 0, 10)).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
      raw.prepare('UPDATE audit_events SET record=? WHERE scope_id=? AND sequence=2').run(JSON.stringify(two), 'scope');
      expect(audit.list('scope', 0, 10)).toEqual([one, two, three]);
      // A forged row with a MAC copied from a genuine record.
      const forged = { ...three, sequence: 4, event: { ...three.event, eventId: 'forged' } };
      raw.prepare('INSERT INTO audit_events(scope_id,sequence,event_id,kind,at_ms,key_id,mac,record) VALUES(?,?,?,?,?,?,?,?)')
        .run('scope', 4, 'forged', 'permission-mode', forged.event.atMs, forged.keyId, forged.mac, JSON.stringify(forged));
      expect(() => audit.list('scope', 3, 10)).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
      raw.prepare('DELETE FROM audit_events WHERE scope_id=? AND sequence=4').run('scope');
      // A deleted row leaves a gap the sealed sequence exposes.
      raw.prepare('DELETE FROM audit_events WHERE scope_id=? AND sequence=2').run('scope');
      expect(() => audit.list('scope', 0, 10)).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
      // Row columns disagreeing with the sealed record are refused even when the seal itself verifies.
      raw.prepare('INSERT INTO audit_events(scope_id,sequence,event_id,kind,at_ms,key_id,mac,record) VALUES(?,?,?,?,?,?,?,?)')
        .run('scope', 2, two.event.eventId, 'permission-mode', two.event.atMs + 1, two.keyId, two.mac, JSON.stringify(two));
      expect(() => audit.list('scope', 0, 10)).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
    } finally { raw.close(); }
    // Another key never verifies.
    expect(() => new AuditApplication(store, createHmacIntegrity('audit-key', randomBytes(32))).list('scope', 2, 1)).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
  } finally { store.close(); }
});

it('pages within one scope only and keeps summary counters per scope', async () => {
  const { path } = await ledger('dn-audit-scope-');
  const store = await openSqliteAuditStore(path, options, 'forbid');
  try {
    const audit = new AuditApplication(store, integrity);
    const a = [1, 2, 3].map(n => audit.record(event('alpha', n)));
    const b = [1, 2].map(n => audit.record(event('beta', n, 'shell-modify')));
    expect(a.map(r => r.sequence)).toEqual([1, 2, 3]); expect(b.map(r => r.sequence)).toEqual([1, 2]);
    expect(audit.list('alpha', 0, 2)).toEqual([a[0], a[1]]);
    expect(audit.list('alpha', 2, 2)).toEqual([a[2]]);
    expect(audit.list('beta', 0, 10)).toEqual(b);
    expect(audit.list('gamma', 0, 10)).toEqual([]);
    expect(() => audit.list('alpha', 0, 0)).toThrow(expect.objectContaining({ code: 'AUDIT_INVALID' }));
    expect(audit.count('alpha', 'silent-allow', 2, 100)).toEqual({ scopeId: 'alpha', counter: 'silent-allow', count: 2, updatedAtMs: 100 });
    expect(audit.count('alpha', 'silent-allow', 3, 90)).toEqual({ scopeId: 'alpha', counter: 'silent-allow', count: 5, updatedAtMs: 100 });
    audit.count('beta', 'silent-allow', 1, 7);
    expect(audit.counters('alpha')).toEqual([{ scopeId: 'alpha', counter: 'silent-allow', count: 5, updatedAtMs: 100 }]);
    expect(audit.counters('beta')).toEqual([{ scopeId: 'beta', counter: 'silent-allow', count: 1, updatedAtMs: 7 }]);
    expect(() => audit.count('alpha', 'silent-allow', 0, 1)).toThrow(expect.objectContaining({ code: 'AUDIT_INVALID' }));
    expect(audit.counters('gamma')).toEqual([]);
  } finally { store.close(); }
});

it('propagates a failed write as a typed error so the caller applies no effect ("no audit, no effect")', async () => {
  const { path } = await ledger('dn-audit-fail-');
  const store = await openSqliteAuditStore(path, options, 'forbid');
  const audit = new AuditApplication(store, integrity);
  // The producer pattern the agent turn will follow: record first, apply the effect only after the record returns.
  let applied = 0;
  const relax = (n: number) => { audit.record(event('scope', n)); applied++; };
  relax(1); expect(applied).toBe(1);
  expect(() => relax(0.5 as never)).toThrow(AuditError); expect(applied).toBe(1); // invalid input never reaches the ledger
  store.close();
  expect(() => relax(2)).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
  expect(applied).toBe(1);
  expect(rows(path, 'SELECT count(*) AS n FROM audit_events').at(0)).toEqual({ n: 1 });
});
