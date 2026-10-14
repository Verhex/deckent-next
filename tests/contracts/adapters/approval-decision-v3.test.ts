import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteApprovalStore } from '#adapters/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { approvalDecisionClass, approvalDecisionAssurance, approvalRecordSchema, approvalRequestSchema } from '#domain/index.js';
import { agentToolApprovalNote, sealApproval, verifyApproval } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';

// APPROVER-NOTE decision versions (lead decision 2026-10-07): a decision carrying the decider's own words is sealed as v3; every other decision
// stays v2, so a build before T2 keeps reading it. The reader takes v1, v2 and v3; the seal verifies on both written versions.
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('key', randomBytes(32));
const requester = { id: 'owner', issuer: 'host', subject: '1000' };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const pending = (index: number) => sealApproval({ request: approvalRequestSchema.parse({ schemaVersion: 3, approvalId: `tool-${index}`, scopeId: 'scope',
  subject: { kind: 'agent-tool-call', turnId: 'turn-1', round: 1, index, tool: 'edit_file', toolVersion: 1, resource: 'src/a.ts', argsDigest: digest(`args-${index}`) },
  requester, actionDigest: digest(`call-${index}`), policyRevision: 'p1', summary: 'edit_file · src/a.ts', createdAt: 1_000, expiresAt: 61_000,
  facts: { risk: { source: 'cell', cell: 'edit' }, reversibility: null, onExpiry: 'nothing-runs', requiredAssurance: 'peer-session' } }), revision: 0, status: 'pending', decision: null }, integrity);
const base = { commandId: 'cmd', decision: 'deny' as const, actor: requester, sessionId: 'session', channel: 'local-terminal-card', decidedAt: 2_000,
  requestDigest: digest('request'), commandDigest: digest('command'), idempotencyKeyHash: digest('cmd'), assurance: 'peer-session' };
const decide = (index: number, decision: Record<string, unknown>) => sealApproval({ request: pending(index).request, revision: 1, status: 'decided', decision } as never, integrity);

describe('approval decision v2 / v3 (APPROVER-NOTE)', () => {
  it('seals and verifies a v2 decision (default reason) and a v3 decision (the decider\'s own words); assurance reads the same on both', () => {
    const v2 = decide(1, { schemaVersion: 2, ...base, reason: 'Denied in the terminal' });
    const v3 = decide(2, { schemaVersion: 3, ...base, reason: 'use b.ts', approverNote: true });
    for (const record of [v2, v3]) {
      expect(verifyApproval(JSON.parse(JSON.stringify(record)), integrity)).toEqual(record);
      expect(approvalDecisionAssurance(record.decision!)).toBe('peer-session');
    }
    expect([v2.decision!.schemaVersion, v3.decision!.schemaVersion]).toEqual([2, 3]);
    // A tampered note does not verify (the MAC covers the whole decision).
    expect(() => verifyApproval({ ...v3, decision: { ...v3.decision, reason: 'run it anyway' } }, integrity)).toThrow('APPROVAL_INTEGRITY');
  });

  it('keeps the versions apart: v3 needs the note mark, v2 never carries it', () => {
    expect(() => decide(3, { schemaVersion: 3, ...base, reason: 'x' })).toThrow('APPROVAL_INVALID');
    expect(() => decide(4, { schemaVersion: 2, ...base, reason: 'x', approverNote: true })).toThrow('APPROVAL_INVALID');
    expect(() => decide(5, { schemaVersion: 3, ...base, reason: 'x', approverNote: false })).toThrow('APPROVAL_INVALID');
    // A pre-B1 decision (no version, no assurance) still reads.
    const legacy: Record<string, unknown> = { ...base }; delete legacy['assurance'];
    expect(approvalRecordSchema.safeParse({ ...decide(6, { schemaVersion: 2, ...base, reason: 'r' }), decision: { ...legacy, reason: 'r' } }).success).toBe(true);
  });

  it('through the real store: only a v3 decision yields the approver note; v2 yields none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dn-approval-v3-')); roots.push(root);
    const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close();
    const journal = openSqliteApprovalStore(path, options);
    try {
      const notes: (string | null)[] = [];
      for (const [index, decision] of [[7, { schemaVersion: 3, ...base, reason: 'use b.ts', approverNote: true }], [8, { schemaVersion: 2, ...base, reason: 'Denied in the terminal' }]] as const) {
        const created = journal.store.create(pending(index));
        journal.store.transition(created, decide(index, decision));
        notes.push(agentToolApprovalNote(journal.store, integrity, created));
      }
      expect(notes).toEqual(['use b.ts', null]);
    } finally { journal.close(); }
  });
});

it('D0 dual reader preserves real stored legacy/v2/v3 MAC bytes and reads classified v4 without re-sealing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-approval-d0-')); roots.push(root);
  const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close();
  const journal = openSqliteApprovalStore(path, options);
  try {
    const legacy: Record<string, unknown> = { ...base }; delete legacy['assurance'];
    const versions = [
      { ...legacy, reason: 'old record' }, { schemaVersion: 2, ...base, reason: 'v2' },
      { schemaVersion: 3, ...base, reason: 'v3 own words', approverNote: true },
      { schemaVersion: 4, ...base, reason: 'terminal', deciderClass: 'human-tty' },
      { schemaVersion: 4, ...base, assurance: 'ai-policy', reason: 'policy', deciderClass: 'ai-policy', approverNote: true },
      { schemaVersion: 4, ...base, reason: 'system', deciderClass: 'system' },
    ];
    const stored: string[] = [];
    for (const [index, decision] of versions.entries()) {
      const created = journal.store.create(pending(100 + index)), record = decide(100 + index, decision);
      journal.store.transition(created, record); stored.push(JSON.stringify(record));
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const before = db.prepare('SELECT snapshot FROM approvals ORDER BY approval_id').all();
      const classes = journal.store.list('scope', null, 20).map(record => approvalDecisionClass(verifyApproval(record, integrity).decision!));
      expect(classes).toEqual(['unknown', 'unknown', 'unknown', 'human-tty', 'ai-policy', 'system']);
      expect(db.prepare('SELECT snapshot FROM approvals ORDER BY approval_id').all()).toEqual(before);
      expect(before.map(row => row.snapshot)).toEqual(stored);
      const record = journal.store.load('scope', 'tool-103')!;
      expect(() => verifyApproval({ ...record, decision: { ...record.decision, deciderClass: 'ai-policy' } }, integrity)).toThrow('APPROVAL_INTEGRITY');
    } finally { db.close(); }
  } finally { journal.close(); }
});
