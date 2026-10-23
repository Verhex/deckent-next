import { copyFile, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { FileMemoryPurgeJournal, memoryKeyedDigest, openSqliteMemoryJournalStore } from '#adapters/index.js';
import { MemoryJournalApplication, memoryEvaluationDigest, type MemoryJournalDependencies } from '#engine/index.js';
import { memoryDistillerPrincipal, memoryEvaluationRecordSchema, type AuditEvent } from '#domain/index.js';
import { createHmacIntegrity } from '#platform/index.js';

// S4B-4 (S4B-DESIGN rev 4 §6.6, A11, N27/N31/N32; owner S-M12 2026-10-23) on the Core SQLite adapter and the file purge journal (v65 tables from
// S4B-1, no migration): a person's purge tombstones every revision with a keyed digest, drops the search row, removes the evaluator calls'
// stored content and is re-applied after a backup restore before anything reads. Synthetic makers and models only.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const person = { id: 'p', issuer: 'local-os', subject: 'uid:1000', assurance: 'os-user' as const, scopeIds: ['s'] };
const mcp = { ...person, id: 'm', issuer: 'local-os/mcp' };
const distiller = memoryDistillerPrincipal({ issuer: 'local-os', subject: 'uid:1000' }, ['s']);
const secret = { kind: 'fact', title: 'Tedarikçi Ayşe Yılmaz telefonu', body: 'Ayşe Yılmaz 0555 000 00 00 numarasından aranır.', tags: ['crm'], lesson: null };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dn-memory-purge-')); roots.push(root);
  const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close();
  const integrity = createHmacIntegrity('k', randomBytes(32)), purged: string[] = [];
  const journal = new FileMemoryPurgeJournal(async () => join(root, 'memory-purges'), async () => integrity);
  let clock = 1_000;
  const deps = (principal: typeof person | typeof distiller, extra: Partial<MemoryJournalDependencies> = {}): MemoryJournalDependencies => ({
    verifier: { verify: async () => principal }, authorize: async () => ({ revision: 'p1', ruleId: 'r' }),
    openStore: async access => openSqliteMemoryJournalStore(path, options, integrity, access), keyedDigest: memoryKeyedDigest(integrity), purgeJournal: journal,
    purgeInvocationContent: async (_scope, invocationId) => { purged.push(invocationId); return 'purged'; }, readFilter: async () => () => true, now: () => clock++,
    eventId: () => `e${clock}`, ...extra });
  const app = (principal: typeof person | typeof distiller = person, extra: Partial<MemoryJournalDependencies> = {}) => new MemoryJournalApplication(deps(principal, extra));
  return { root, path, integrity, journal, purged, app, journalFile: join(root, 'memory-purges', 'purges.jsonl') };
}
const proposal = (commandId: string, content: object = secret) => ({ schemaVersion: 1, commandId, scopeId: 's', content, origin: { kind: 'human', ref: null } });
const raw = (path: string, sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };

describe('purge (A11): a person only, every revision tombstoned with a keyed digest', () => {
  it('N27: the person purges a verified entry — no revision keeps its text, the search row is gone, re-proposal is refused; the MCP actor is refused first', async () => {
    const f = await fixture(), app = f.app();
    const { entry } = await app.propose(proposal('m1'));
    const verified = (await app.verify({ schemaVersion: 1, commandId: 'v1', scopeId: 's', entryId: entry.entryId, expectedRevision: 1, basis: { kind: 'human-review', note: 'kontrol' } })).entry;
    await expect(f.app(mcp).purge({ schemaVersion: 1, commandId: 'x1', scopeId: 's', entryId: entry.entryId, expectedRevision: 2, reasonCode: 'personal-data' }))
      .rejects.toMatchObject({ code: 'MEMORY_PERSON_REQUIRED' });
    expect(await f.journal.list()).toEqual([]);
    await expect(app.purge({ schemaVersion: 1, commandId: 'x2', scopeId: 's', entryId: entry.entryId, expectedRevision: 1, reasonCode: 'personal-data' }))
      .rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT' });
    const result = await app.purge({ schemaVersion: 1, commandId: 'x3', scopeId: 's', entryId: entry.entryId, expectedRevision: 2, reasonCode: 'personal-data' });
    expect(result).toMatchObject({ replayed: false, entry: { revision: 2, state: 'verified', content: { purged: true, digestKind: 'keyed', purgeRecordId: 'x3', reasonCode: 'personal-data' } },
      record: { purgeId: 'x3', contentDigest: verified.contentDigest, invocationIds: [] }, invocations: { purged: 0, absent: 0 } });
    // The ledger keeps no text of the entry: every revision row, the current row and the purge record hold only ids and the keyed digest.
    const dump = JSON.stringify([raw(f.path, 'SELECT record FROM memory_entry_revisions'), raw(f.path, 'SELECT record FROM memory_entries'), raw(f.path, 'SELECT record FROM memory_purges'),
      raw(f.path, 'SELECT * FROM memory_search')]);
    for (const word of ['Ayşe', 'Yılmaz', '0555', 'Tedarikçi', 'crm']) expect(dump).not.toContain(word);
    expect(raw(f.path, 'SELECT count(*) AS n FROM memory_search')).toEqual([{ n: 0 }]);
    expect(await readFile(f.journalFile, 'utf8')).not.toContain('Ayşe');
    const inspected = await app.inspect({ schemaVersion: 1, scopeId: 's', entryId: entry.entryId });
    expect(inspected).toMatchObject({ status: 'ok', entry: { content: { purged: true } } });
    expect(inspected.status === 'ok' && inspected.history.every(revision => 'purged' in revision.content)).toBe(true);
    expect(await app.search({ schemaVersion: 1, scopeId: 's', query: 'Ayşe', limit: 5 })).toMatchObject({ status: 'ok', entries: [] });
    await expect(app.propose(proposal('m2'))).rejects.toMatchObject({ code: 'MEMORY_PURGED_CONTENT' });
    // A retried purge replays; a tombstoned entry is not purged again and cannot be verified.
    expect(await app.purge({ schemaVersion: 1, commandId: 'x3', scopeId: 's', entryId: entry.entryId, expectedRevision: 2, reasonCode: 'personal-data' })).toMatchObject({ replayed: true });
    await expect(app.purge({ schemaVersion: 1, commandId: 'x4', scopeId: 's', entryId: entry.entryId, expectedRevision: 2, reasonCode: 'other' })).rejects.toMatchObject({ code: 'MEMORY_TRANSITION_INVALID' });
    // The store accepts only the tombstone rewrite: any other UPDATE of a revision still aborts.
    const db = new DatabaseSync(f.path);
    try { expect(() => db.prepare('UPDATE memory_entry_revisions SET record=record||\'\'').run()).toThrow(/MEMORY_APPEND_ONLY/); } finally { db.close(); }
    const events = raw(f.path, "SELECT record FROM audit_events").map(row => String(row['record'])).filter(text => text.includes('memory-purge'));
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(verified.contentDigest); expect(events[0]).not.toContain('Ayşe');
  });
  it('N32: the evaluator calls of the entry lose their stored content through purge-content; the record lists them, keyed digests only', async () => {
    const f = await fixture(), app = f.app();
    const { entry } = await app.propose(proposal('m1'));
    const writer = openSqliteMemoryJournalStore(f.path, options, f.integrity, 'write');
    try {
      for (const [recordId, invocationId] of [['r1', 'inv-1'], ['r2', null], ['r3', 'inv-2']] as const) {
        const record = memoryEvaluationRecordSchema.parse({ schemaVersion: 1, recordId, scopeId: 's', entryId: entry.entryId, entryRevision: 1, subjectDigest: entry.contentDigest, mode: 'shadow',
          method: 'model-review', evaluator: { issuer: 'local-os/memory-evaluator', subject: 'uid:1000' }, evaluatorModel: { channelId: 'channel-b', modelId: 'model-b', maker: 'maker-b' },
          sourceModels: [{ channelId: 'channel-a', modelId: 'model-a', maker: 'maker-a' }], sourceAttempts: [{ runId: 'r', taskId: 't', attemptId: 'a' }], sourceEvaluationIds: ['ev'],
          template: { id: 'evaluate', version: 1 }, registryRevision: 'rev', inputDigest: 'c'.repeat(64), outputDigest: null, invocationId, spend: { state: 'none' }, verdict: 'unknown',
          reasonCodes: [], conflicts: [], failure: 'MEMORY_EVALUATION_CALL_FAILED', atMs: 5 });
        const event: AuditEvent = { schemaVersion: 1, eventId: `ev-${recordId}`, scopeId: 's', principal: record.evaluator, policyRevision: 'p', atMs: 5, subject: { kind: 'memory-evaluation', recordId,
          entryId: entry.entryId, revision: 1, mode: 'shadow', verdict: 'unknown', recordDigest: memoryEvaluationDigest(record), subjectDigest: entry.contentDigest } };
        await writer.putEvaluation!(record, memoryEvaluationDigest(record), event);
      }
    } finally { writer.close(); }
    const result = await app.purge({ schemaVersion: 1, commandId: 'x1', scopeId: 's', entryId: entry.entryId, expectedRevision: 1, reasonCode: 'poisoned' });
    expect([...result.record.invocationIds].sort()).toEqual(['inv-1', 'inv-2']);
    expect([...result.record.evaluationRecordIds].sort()).toEqual(['r1', 'r2', 'r3']);
    expect(f.purged.sort()).toEqual(['inv-1', 'inv-2']);
    expect(result.invocations).toEqual({ purged: 2, absent: 0 });
    // Without an invocation purger the purge fails closed before any journal entry or ledger effect.
    const other = await app.propose(proposal('m9', { ...secret, title: 'Başka', body: 'Başka bir kayıt.' }));
    const w2 = openSqliteMemoryJournalStore(f.path, options, f.integrity, 'write');
    try {
      const record = memoryEvaluationRecordSchema.parse({ ...(await w2.evaluationsFor!('s', entry.entryId, 1))[0]!.record, recordId: 'r9', entryId: other.entry.entryId, invocationId: 'inv-9' });
      await w2.putEvaluation!(record, memoryEvaluationDigest(record), { schemaVersion: 1, eventId: 'ev-r9', scopeId: 's', principal: record.evaluator, policyRevision: 'p', atMs: 6,
        subject: { kind: 'memory-evaluation', recordId: 'r9', entryId: other.entry.entryId, revision: 1, mode: 'shadow', verdict: 'unknown', recordDigest: memoryEvaluationDigest(record), subjectDigest: record.subjectDigest } });
    } finally { w2.close(); }
    const closed = f.app(person, { purgeInvocationContent: undefined });
    await expect(closed.purge({ schemaVersion: 1, commandId: 'x9', scopeId: 's', entryId: other.entry.entryId, expectedRevision: 1, reasonCode: 'other' })).rejects.toMatchObject({ code: 'MEMORY_UNAVAILABLE' });
    expect((await f.journal.list()).map(row => row.purgeId)).toEqual(['x1']);
  });
});

describe('restore safety (N31): the journal outlives a restored ledger and is re-applied before anything reads', () => {
  it('a ledger restored from before the purge holds reads and writes until the replay tombstones the entry again', async () => {
    const f = await fixture(), app = f.app(), { entry } = await app.propose(proposal('m1'));
    const db = new DatabaseSync(f.path); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close();
    await copyFile(f.path, `${f.path}.backup`);
    await app.purge({ schemaVersion: 1, commandId: 'x1', scopeId: 's', entryId: entry.entryId, expectedRevision: 1, reasonCode: 'personal-data' });
    // The backup comes back (the journal directory is not a backup resource, so it stays).
    for (const suffix of ['-wal', '-shm']) await rm(`${f.path}${suffix}`, { force: true });
    await copyFile(`${f.path}.backup`, f.path);
    expect(raw(f.path, 'SELECT count(*) AS n FROM memory_purges')).toEqual([{ n: 0 }]);
    expect(await app.list({ schemaVersion: 1, scopeId: 's', limit: 10 })).toEqual({ schemaVersion: 1, status: 'held', code: 'MEMORY_PURGE_REPLAY_HELD' });
    expect(await app.inspect({ schemaVersion: 1, scopeId: 's', entryId: entry.entryId })).toMatchObject({ status: 'held', code: 'MEMORY_PURGE_REPLAY_HELD' });
    await expect(app.propose(proposal('m2'))).rejects.toMatchObject({ code: 'MEMORY_PURGE_REPLAY_HELD' });
    expect(await app.replayPurges('s')).toMatchObject({ records: 1, applied: 1, invocationsPurged: 0 });
    expect(await app.list({ schemaVersion: 1, scopeId: 's', limit: 10 })).toMatchObject({ status: 'ok', entries: [{ entryId: entry.entryId, content: { purged: true } }] });
    expect(JSON.stringify(raw(f.path, 'SELECT record FROM memory_entry_revisions'))).not.toContain('Ayşe');
    await expect(app.propose(proposal('m2'))).rejects.toMatchObject({ code: 'MEMORY_PURGED_CONTENT' });
    expect(await app.replayPurges('s')).toMatchObject({ records: 1, applied: 0 });
    const events = raw(f.path, 'SELECT record FROM audit_events').map(row => String(row['record'])).filter(text => text.includes('memory-purge'));
    expect(events.some(text => text.includes('"replay":true'))).toBe(true);
  });
  it('an unreadable or altered journal line holds every read and the replay (never a silent un-purge); a torn final line is an append that never returned', async () => {
    const f = await fixture(), app = f.app(), { entry } = await app.propose(proposal('m1'));
    await app.purge({ schemaVersion: 1, commandId: 'x1', scopeId: 's', entryId: entry.entryId, expectedRevision: 1, reasonCode: 'other' });
    const text = await readFile(f.journalFile, 'utf8');
    await appendFile(f.journalFile, '{"record":');
    expect(await f.journal.list()).toHaveLength(1);
    expect(await app.list({ schemaVersion: 1, scopeId: 's', limit: 10 })).toMatchObject({ status: 'ok' });
    await writeFile(f.journalFile, text.replace('"other"', '"poisoned"'));
    await expect(f.journal.list()).rejects.toMatchObject({ code: 'MEMORY_PURGE_REPLAY_HELD' });
    expect(await app.list({ schemaVersion: 1, scopeId: 's', limit: 10 })).toMatchObject({ status: 'held', code: 'MEMORY_PURGE_REPLAY_HELD' });
    await expect(app.replayPurges('s')).rejects.toMatchObject({ code: 'MEMORY_PURGE_REPLAY_HELD' });
  });
});

describe('review card, source lists and contest resolution', () => {
  it('withheld system entries are only counted on the review and the source list; a person\'s candidate is shown with its evidence', async () => {
    const f = await fixture(), app = f.app(), writer = f.app(distiller);
    const human = (await app.propose(proposal('m1', { ...secret, title: 'İnsan kaydı', body: 'Elle yazıldı.' }))).entry;
    const system = await writer.proposeExtracted({ schemaVersion: 1, scopeId: 's', source: { runId: 'run1', taskId: 't1', attemptId: 'a1' }, ruleId: 'E3', ruleVersion: 1, claimIndex: 0,
      content: { kind: 'fact', title: 'Sistem kaydı', body: 'İadeler WH-02 deposuna.', tags: [], lesson: null }, audience: { workClassFamily: 'small', workTargetId: null },
      support: { producer: 'worker-claim', evaluationId: 'ev1', evaluationDigest: 'e'.repeat(64), reportDigest: null } });
    const shown = await app.review({ schemaVersion: 1, scopeId: 's', limit: 10 });
    expect(shown).toMatchObject({ status: 'ok', withheld: 0, complete: true });
    expect(shown.status === 'ok' && shown.items.find(item => item.entry.entryId === system.entry.entryId)?.support).toMatchObject([{ source: { runId: 'run1', attemptId: 'a1' } }]);
    const denied = f.app(person, { readFilter: async () => () => false });
    const review = await denied.review({ schemaVersion: 1, scopeId: 's', limit: 10 });
    expect(review).toMatchObject({ status: 'ok', withheld: 1 });
    expect(review.status === 'ok' && review.items.map(item => item.entry.entryId)).toEqual([human.entryId]);
    expect(JSON.stringify(review)).not.toContain('Sistem');
    expect(await denied.sourceEntries({ schemaVersion: 1, scopeId: 's', source: { runId: 'run1', attemptId: null }, limit: 10 })).toMatchObject({ status: 'ok', entries: [], withheld: 1 });
    expect(await app.sourceEntries({ schemaVersion: 1, scopeId: 's', source: { runId: 'run1', attemptId: 'a1' }, limit: 10 })).toMatchObject({ entries: [{ entryId: system.entry.entryId }], withheld: 0 });
    expect(await app.sourceEntries({ schemaVersion: 1, scopeId: 's', source: { runId: 'run1', attemptId: 'other' }, limit: 10 })).toMatchObject({ entries: [], withheld: 0 });
  });
  it('a person resolves a contest once (retire the contested entry); another decision is refused; the MCP actor is refused', async () => {
    const f = await fixture(), app = f.app();
    const old = (await app.propose(proposal('m1', { ...secret, title: 'Eski', body: 'Eski bilgi.' }))).entry;
    await app.verify({ schemaVersion: 1, commandId: 'v1', scopeId: 's', entryId: old.entryId, expectedRevision: 1, basis: { kind: 'human-review', note: 'ok' } });
    const fresh = (await app.propose(proposal('m2', { ...secret, title: 'Yeni', body: 'Yeni bilgi.' }))).entry;
    const writer = openSqliteMemoryJournalStore(f.path, options, f.integrity, 'write');
    try {
      await writer.openContest!({ schemaVersion: 1, contestId: 'c1', scopeId: 's', entryId: old.entryId, candidateEntryId: fresh.entryId, evaluationRecordId: 'r1', evaluationDigest: 'd'.repeat(64),
        openedBy: { issuer: 'local-os/memory-evaluator', subject: 'uid:1000' }, reasonCode: 'contradicts-verified', openedAtMs: 10 },
      { schemaVersion: 1, eventId: 'ev-c1', scopeId: 's', principal: { issuer: 'local-os/memory-evaluator', subject: 'uid:1000' }, policyRevision: 'p', atMs: 10,
        subject: { kind: 'memory-contest', contestId: 'c1', entryId: old.entryId, candidateEntryId: fresh.entryId, recordId: 'r1' } });
    } finally { writer.close(); }
    const review = await app.review({ schemaVersion: 1, scopeId: 's', limit: 10 });
    expect(review.status === 'ok' && review.contests.map(row => row.contestId)).toEqual(['c1']);
    expect(review.status === 'ok' && review.items.find(item => item.entry.entryId === old.entryId)?.contests).toHaveLength(1);
    await expect(f.app(mcp).resolveContest({ schemaVersion: 1, commandId: 'k0', scopeId: 's', contestId: 'c1', decision: 'dismiss' })).rejects.toMatchObject({ code: 'MEMORY_PERSON_REQUIRED' });
    const resolved = await app.resolveContest({ schemaVersion: 1, commandId: 'k1', scopeId: 's', contestId: 'c1', decision: 'retire-contested' });
    expect(resolved).toMatchObject({ replayed: false, resolution: { decision: 'retire-contested', retiredEntryId: old.entryId }, retired: { entryId: old.entryId, state: 'retired' } });
    expect(await app.resolveContest({ schemaVersion: 1, commandId: 'k2', scopeId: 's', contestId: 'c1', decision: 'retire-contested' })).toMatchObject({ replayed: true });
    await expect(app.resolveContest({ schemaVersion: 1, commandId: 'k3', scopeId: 's', contestId: 'c1', decision: 'dismiss' })).rejects.toMatchObject({ code: 'MEMORY_CONTEST_RESOLVED' });
    const after = await app.review({ schemaVersion: 1, scopeId: 's', limit: 10 });
    expect(after.status === 'ok' && after.contests).toEqual([]);
  });
});
