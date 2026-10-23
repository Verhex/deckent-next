import { describe, expect, it } from 'vitest';
import { assertMemoryPerson, composeMemoryAutomation, memoryContestResolutionSchema, memoryDistillerPrincipal, memoryEntrySchema, memoryEntryStale, memoryEvaluatorPrincipal,
  memoryIndexText, memoryRetentionMs, memoryTombstoneSchema, parseMemoryPurgeRecord, proposeMemoryEntry, retireMemoryEntry, tombstoneMemoryRevision, verifyMemoryEntry } from '#domain/index.js';

// S4B-4 domain (S4B-DESIGN rev 4 §6.5, §6.6, A11; owner S-M12/S-M13): the tombstone keeps no content field, every revision keeps its state and
// number, only a person purges, a purged entry has no text to index or verify, and staleness narrows only when a retention is known.
const person = { issuer: 'local-os', subject: 'uid:1000', assurance: 'os-user' };
const keyed = 'f'.repeat(64);
const entry = proposeMemoryEntry({ scopeId: 's', entryId: 'e1', commandId: 'e1', content: { kind: 'fact', title: 'Telefon', body: 'Ayşe 0555', tags: ['crm'], lesson: null },
  contentDigest: 'a'.repeat(64), author: person, origin: { kind: 'human', ref: null }, atMs: 10 });
const record = parseMemoryPurgeRecord({ schemaVersion: 1, purgeId: 'p1', scopeId: 's', entryId: 'e1', contentDigest: keyed, digestKind: 'keyed', reasonCode: 'personal-data',
  by: { issuer: person.issuer, subject: person.subject }, evaluationRecordIds: [], invocationIds: [], atMs: 20 });

describe('tombstone', () => {
  it('keeps no title, body, tag or lesson field; any extra field is refused; only the keyed kind exists', () => {
    const tombstone = { purged: true, contentDigest: keyed, digestKind: 'keyed', purgeRecordId: 'p1', reasonCode: 'personal-data' };
    expect(memoryTombstoneSchema.parse(tombstone)).toEqual(tombstone);
    for (const extra of [{ title: 'Telefon' }, { body: 'x' }, { tags: [] }, { lesson: null }]) expect(memoryTombstoneSchema.safeParse({ ...tombstone, ...extra }).success).toBe(false);
    expect(memoryTombstoneSchema.safeParse({ ...tombstone, digestKind: 'plain' }).success).toBe(false);
    expect(memoryTombstoneSchema.safeParse({ ...tombstone, purged: false }).success).toBe(false);
  });
  it('a revision keeps its number and state; its content digest becomes the keyed one; nothing of the text remains; it cannot be verified or indexed', () => {
    const verified = verifyMemoryEntry(entry, { actor: person, atMs: 11, basis: { kind: 'human-review', note: 'ok' } });
    for (const revision of [entry, verified]) {
      const stone = tombstoneMemoryRevision(revision, record);
      expect(stone).toMatchObject({ revision: revision.revision, state: revision.state, contentDigest: keyed, content: { purged: true, purgeRecordId: 'p1' } });
      expect(JSON.stringify(stone)).not.toMatch(/Ayşe|0555|crm|Telefon/);
      expect(memoryIndexText(stone)).toBe('');
    }
    expect(() => verifyMemoryEntry(tombstoneMemoryRevision(entry, record), { actor: person, atMs: 12, basis: { kind: 'human-review', note: 'ok' } }))
      .toThrow(expect.objectContaining({ code: 'MEMORY_TRANSITION_INVALID' }));
    expect(retireMemoryEntry(tombstoneMemoryRevision(entry, record), { actor: person, atMs: 12, reason: 'gone', supersededBy: null }).content).toMatchObject({ purged: true });
    // A tombstone whose digest disagrees with the entry's is not an entry; another entry's record never tombstones this one.
    expect(memoryEntrySchema.safeParse({ ...tombstoneMemoryRevision(entry, record), contentDigest: 'a'.repeat(64) }).success).toBe(false);
    expect(() => tombstoneMemoryRevision(entry, { ...record, entryId: 'other' })).toThrow(expect.objectContaining({ code: 'MEMORY_ENTRY_INVALID' }));
  });
});

describe('a person only (A11)', () => {
  it('the MCP actor, the distiller, the evaluator and any non-os-user principal are refused; a person passes', () => {
    const owner = { issuer: 'local-os', subject: 'uid:1000' };
    for (const actor of [{ ...person, issuer: 'local-os/mcp' }, memoryDistillerPrincipal(owner, ['s']), memoryEvaluatorPrincipal(owner, ['s']), { ...person, assurance: 'workload-verified' }])
      expect(() => assertMemoryPerson(actor), actor.issuer).toThrow(expect.objectContaining({ code: 'MEMORY_PERSON_REQUIRED' }));
    expect(() => assertMemoryPerson(person)).not.toThrow();
  });
  it('a contest resolution names the retired entry exactly when it retires one', () => {
    const base = { schemaVersion: 1, contestId: 'c', scopeId: 's', by: { issuer: 'local-os', subject: 'uid:1000' }, atMs: 1 };
    expect(memoryContestResolutionSchema.safeParse({ ...base, decision: 'dismiss', retiredEntryId: null }).success).toBe(true);
    expect(memoryContestResolutionSchema.safeParse({ ...base, decision: 'dismiss', retiredEntryId: 'e1' }).success).toBe(false);
    expect(memoryContestResolutionSchema.safeParse({ ...base, decision: 'retire-contested', retiredEntryId: null }).success).toBe(false);
    expect(memoryContestResolutionSchema.safeParse({ ...base, decision: 'retire-candidate', retiredEntryId: 'e2' }).success).toBe(true);
  });
});

describe('staleness (S-M13): narrowing only, from the WorkClass family row', () => {
  it('a system entry is stale past its family row\'s retention; no row or a person\'s entry is never stale; a retired entry is not listed', () => {
    const automation = composeMemoryAutomation(), row = automation.workClasses[0]!;
    const system = memoryEntrySchema.parse({ ...entry, schemaVersion: 2, audience: { workClassFamily: row.workClassId, workTargetId: null } });
    const max = memoryRetentionMs(automation, system);
    expect(max).toBe(row.retentionProfile.entryMaxAgeMs);
    expect(memoryEntryStale(system, 10, max, 10 + max!)).toBe(false);
    expect(memoryEntryStale(system, 10, max, 11 + max!)).toBe(true);
    expect(memoryEntryStale(system, 5_000, max, 11 + max!)).toBe(false);
    expect(memoryRetentionMs(automation, { ...system, audience: { workClassFamily: 'no-such-family', workTargetId: null } })).toBeNull();
    expect(memoryRetentionMs(automation, entry)).toBeNull();
    expect(memoryEntryStale(entry, null, null, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(memoryEntryStale(retireMemoryEntry(system, { actor: person, atMs: 12, reason: 'x', supersededBy: null }), 10, max, 11 + max!)).toBe(false);
  });
});
