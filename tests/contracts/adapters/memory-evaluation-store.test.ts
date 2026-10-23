import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteMemoryJournalStore } from '#adapters/index.js';
import { memoryEvaluationDigest } from '#engine/index.js';
import { memoryEvaluationRecordSchema, type AuditEvent, type MemoryContest } from '#domain/index.js';
import { createHmacIntegrity } from '#platform/index.js';

// S4B-3 on the Core SQLite adapter (v65 tables from S4B-1; no migration here): evaluation records and contests are sealed with the integrity key,
// written with their audit event in one commit, append-only (a contest resolves once in S4B-4), and a tampered row is corruption, never a record.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const digest = 'a'.repeat(64), evaluator = { issuer: 'host/memory-evaluator', subject: '1000' };
const record = (recordId: string, atMs: number, verdict: 'pass' | 'fail' = 'pass') => memoryEvaluationRecordSchema.parse({ schemaVersion: 1, recordId, scopeId: 's', entryId: 'e1',
  entryRevision: 1, subjectDigest: digest, mode: 'shadow', method: 'model-review', evaluator, evaluatorModel: { channelId: 'channel-b', modelId: 'model-b', maker: 'maker-b' },
  sourceModels: [{ channelId: 'channel-a', modelId: 'model-a', maker: 'maker-a' }], sourceAttempts: [{ runId: 'r1', taskId: 't1', attemptId: 'a1' }], sourceEvaluationIds: ['ev1'],
  template: { id: 'evaluate', version: 1 }, registryRevision: 'memory-automation-core-1', inputDigest: digest, outputDigest: digest, invocationId: null, spend: { state: 'settled', minorUnits: 3, currency: 'USD' },
  verdict, reasonCodes: ['supported'], conflicts: [], failure: null, atMs });
const event = (id: string, subject: AuditEvent['subject']): AuditEvent => ({ schemaVersion: 1, eventId: id, scopeId: 's', principal: evaluator, policyRevision: 'p', atMs: 1, subject });
const evaluationEvent = (value: ReturnType<typeof record>) => event(`e-${value.recordId}`, { kind: 'memory-evaluation', recordId: value.recordId, entryId: 'e1', revision: 1, mode: 'shadow',
  verdict: value.verdict, recordDigest: memoryEvaluationDigest(value), subjectDigest: digest });
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'dn-memory-evaluation-')); roots.push(root);
  const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close();
  const integrity = createHmacIntegrity('k', randomBytes(32));
  return { path, open: (access: 'read' | 'write' = 'write') => openSqliteMemoryJournalStore(path, options, integrity, access) };
}

it('seals a record with its audit event, replays the same digest, refuses another, lists today\'s newest first and detects tampering', async () => {
  const f = await store(), writer = f.open(), one = record('r1', 10), two = record('r2', 20, 'fail');
  try {
    expect(await writer.putEvaluation!(one, memoryEvaluationDigest(one), evaluationEvent(one))).toEqual({ replayed: false });
    expect(await writer.putEvaluation!(one, memoryEvaluationDigest(one), evaluationEvent(one))).toEqual({ replayed: true });
    await expect(writer.putEvaluation!(one, 'b'.repeat(64), evaluationEvent(one))).rejects.toMatchObject({ code: 'MEMORY_COMMAND_CONFLICT' });
    await writer.putEvaluation!(two, memoryEvaluationDigest(two), evaluationEvent(two));
  } finally { writer.close(); }
  const reader = f.open('read');
  try {
    expect(await reader.loadEvaluation!('s', 'r1')).toEqual({ record: one, digest: memoryEvaluationDigest(one) });
    expect(await reader.loadEvaluation!('other', 'r1')).toBeNull();
    expect((await reader.recentEvaluations!('s', 5)).map(row => row.recordId)).toEqual(['r2', 'r1']);
    expect(await reader.recentEvaluations!('s', 1)).toHaveLength(1);
  } finally { reader.close(); }
  const db = new DatabaseSync(f.path);
  try {
    expect(db.prepare("SELECT count(*) AS n FROM audit_events WHERE kind='memory-evaluation'").get()?.['n']).toBe(2);
    expect(() => db.prepare("UPDATE memory_evaluations SET seq=9 WHERE record_id='r1'").run()).toThrow(/MEMORY_APPEND_ONLY/u);
    db.exec('DROP TRIGGER memory_evaluations_no_update');
    const sealed = JSON.parse(String(db.prepare("SELECT record FROM memory_evaluations WHERE record_id='r1'").get()?.['record'])) as { value: { record: { verdict: string } } };
    sealed.value.record.verdict = 'fail';
    db.prepare("UPDATE memory_evaluations SET record=? WHERE record_id='r1'").run(JSON.stringify(sealed));
  } finally { db.close(); }
  const tampered = f.open('read');
  try { await expect(tampered.loadEvaluation!('s', 'r1')).rejects.toMatchObject({ code: 'MEMORY_CORRUPT' }); } finally { tampered.close(); }
});

it('opens a contest once with its audit event and counts the day\'s contests', async () => {
  const f = await store(), writer = f.open();
  const contest = (contestId: string, openedAtMs: number): MemoryContest => ({ schemaVersion: 1, contestId, scopeId: 's', entryId: 'v1', candidateEntryId: 'e1', evaluationRecordId: 'r1',
    evaluationDigest: digest, openedBy: evaluator, reasonCode: 'contradicts-verified', openedAtMs });
  const opened = (value: MemoryContest) => event(`c-${value.contestId}`, { kind: 'memory-contest', contestId: value.contestId, entryId: 'v1', candidateEntryId: 'e1', recordId: 'r1' });
  try {
    expect(await writer.openContest!(contest('c1', 100), opened(contest('c1', 100)))).toEqual({ replayed: false });
    expect(await writer.openContest!(contest('c1', 100), opened(contest('c1', 100)))).toEqual({ replayed: true });
    await expect(writer.openContest!({ ...contest('c1', 100), entryId: 'v2' }, opened(contest('c1', 100)))).rejects.toMatchObject({ code: 'MEMORY_COMMAND_CONFLICT' });
    await writer.openContest!(contest('c2', 50), opened(contest('c2', 50)));
    expect(await writer.contestCount!('s', 60)).toBe(1); expect(await writer.contestCount!('s', 0)).toBe(2); expect(await writer.contestCount!('other', 0)).toBe(0);
  } finally { writer.close(); }
  const db = new DatabaseSync(f.path);
  try {
    expect(db.prepare("SELECT resolution FROM memory_contests WHERE contest_id='c1'").get()?.['resolution']).toBeNull();
    expect(() => db.prepare("DELETE FROM memory_contests WHERE contest_id='c1'").run()).toThrow(/MEMORY_APPEND_ONLY/u);
  } finally { db.close(); }
});
