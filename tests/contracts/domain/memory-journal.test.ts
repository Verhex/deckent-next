import { describe, expect, it } from 'vitest';
import { proposeMemoryEntry, verifyMemoryEntry, retireMemoryEntry, memorySearchTerms, memoryEntryMatches, memoryIndexText, foldMemoryText,
  memoryEntrySchema, MEMORY_LIMITS, type MemoryEntry } from '#domain/index.js';

// S4 memory journal v1 (K-D + M5 design note §3): an entry is candidate → verified → retired; content never changes and nothing is deleted.
// Verified needs a human review or an independent evaluation record that is bound to the entry's content and not by its author.
const human = { issuer: 'local-os', subject: 'uid:1000', assurance: 'os-user' } as const;
const otherHuman = { issuer: 'local-os', subject: 'uid:1001', assurance: 'os-user' } as const;
const mcp = { issuer: 'local-os/mcp', subject: 'uid:1000', assurance: 'os-user' } as const;
const workload = { issuer: 'deckent-worker', subject: 'attempt-a1', assurance: 'workload-verified' } as const;
const digest = 'a'.repeat(64);
const content = { kind: 'lesson' as const, title: 'Fatura eşleştirme İstanbul deposunda', body: 'Siparişsiz irsaliye onaya düşer.', tags: ['erp', 'fatura'],
  lesson: { source: 'run r1', cause: 'eksik sipariş', correction: 'onaya yönlendir', evidence: 'task t1 kabul' } };
const propose = (author: { issuer: string; subject: string; assurance: string } = human): MemoryEntry => proposeMemoryEntry({ scopeId: 's', entryId: 'm1', commandId: 'c1',
  content, contentDigest: digest, author, origin: { kind: 'human', ref: null }, atMs: 10 });

describe('memory entry lifecycle', () => {
  it('a proposal is a revision-1 candidate with provenance and no verification', () => {
    const entry = propose();
    expect(entry).toMatchObject({ schemaVersion: 2, audience: null, scopeId: 's', entryId: 'm1', revision: 1, state: 'candidate', contentDigest: digest, verification: null, retirement: null,
      provenance: { author: { issuer: 'local-os', subject: 'uid:1000', ai: false }, origin: { kind: 'human', ref: null }, proposedAtMs: 10, commandId: 'c1' } });
    expect(memoryEntrySchema.parse(entry)).toEqual(entry);
    expect(propose(mcp).provenance.author.ai).toBe(true);
  });
  it('a lesson needs source, cause, correction and evidence; a fact carries none', () => {
    expect(() => proposeMemoryEntry({ scopeId: 's', entryId: 'm1', commandId: 'c1', content: { ...content, lesson: null }, contentDigest: digest, author: human,
      origin: { kind: 'human', ref: null }, atMs: 1 })).toThrow(expect.objectContaining({ code: 'MEMORY_ENTRY_INVALID' }));
    expect(() => proposeMemoryEntry({ scopeId: 's', entryId: 'm1', commandId: 'c1', content: { ...content, kind: 'fact' }, contentDigest: digest, author: human,
      origin: { kind: 'human', ref: null }, atMs: 1 })).toThrow(expect.objectContaining({ code: 'MEMORY_ENTRY_INVALID' }));
  });
  it('refuses content above the registry limits', () => {
    expect(() => proposeMemoryEntry({ scopeId: 's', entryId: 'm1', commandId: 'c1', content: { ...content, body: 'x'.repeat(MEMORY_LIMITS.bodyMaxBytes + 1) },
      contentDigest: digest, author: human, origin: { kind: 'human', ref: null }, atMs: 1 })).toThrow(expect.objectContaining({ code: 'MEMORY_ENTRY_INVALID' }));
  });
  it('a human review verifies; the AI never verifies by review (MCP actor, workload)', () => {
    const verified = verifyMemoryEntry(propose(mcp), { actor: human, atMs: 20, basis: { kind: 'human-review', note: 'checked against run r1' } });
    expect(verified).toMatchObject({ revision: 2, state: 'verified', verification: { basis: 'human-review', reviewer: { issuer: 'local-os', subject: 'uid:1000' }, verifiedAtMs: 20 } });
    for (const actor of [mcp, workload]) expect(() => verifyMemoryEntry(propose(), { actor, atMs: 20, basis: { kind: 'human-review', note: 'self' } }))
      .toThrow(expect.objectContaining({ code: 'MEMORY_VERIFIER_NOT_HUMAN' }));
  });
  it('an independent evaluation verifies only when it passed, is bound to this content and is not by the author (S4B-3: an AI actor only as the evaluator)', () => {
    const record = { kind: 'task-evaluation', id: 'r1/t1/a1', digest: 'b'.repeat(64) }, sourceModels = [{ channelId: 'c1', modelId: 'm1', maker: 'maker-a' }];
    const evaluation = { record, evaluator: { issuer: 'deckent-evaluator', subject: 'process-exit' }, verdict: 'pass' as const, subjectDigest: digest, mode: 'live' as const,
      evaluatorModel: { channelId: 'c2', modelId: 'm2', maker: 'maker-b' }, sourceModels };
    const ok = verifyMemoryEntry(propose(mcp), { actor: human, atMs: 30, basis: { kind: 'independent-evaluation', record }, evaluation, sourceModels });
    expect(ok.verification).toEqual({ basis: 'independent-evaluation', evaluator: evaluation.evaluator, record, verifiedAtMs: 30 });
    const refuse = (patch: object, code: string, actor: typeof human | typeof mcp = human) => expect(() => verifyMemoryEntry(propose(mcp), { actor, atMs: 30,
      basis: { kind: 'independent-evaluation', record }, evaluation: { ...evaluation, ...patch } as never, sourceModels })).toThrow(expect.objectContaining({ code }));
    refuse({ verdict: 'unknown' }, 'MEMORY_EVALUATION_NOT_PASSED');
    refuse({ subjectDigest: 'c'.repeat(64) }, 'MEMORY_EVALUATION_OTHER_CONTENT');
    refuse({ evaluator: { issuer: mcp.issuer, subject: mcp.subject } }, 'MEMORY_SELF_VERIFICATION');
    refuse({ record: { ...record, id: 'other' } }, 'MEMORY_EVALUATION_OTHER_CONTENT');
    refuse({}, 'MEMORY_EVALUATOR_REQUIRED', mcp);
    expect(() => verifyMemoryEntry(propose(), { actor: human, atMs: 30, basis: { kind: 'independent-evaluation', record } }))
      .toThrow(expect.objectContaining({ code: 'MEMORY_EVALUATION_UNAVAILABLE' }));
  });
  it('only a candidate can be verified; retirement keeps the entry and its history (no delete transition)', () => {
    const verified = verifyMemoryEntry(propose(), { actor: human, atMs: 20, basis: { kind: 'human-review', note: 'ok' } });
    expect(() => verifyMemoryEntry(verified, { actor: human, atMs: 21, basis: { kind: 'human-review', note: 'again' } })).toThrow(expect.objectContaining({ code: 'MEMORY_TRANSITION_INVALID' }));
    const retired = retireMemoryEntry(verified, { actor: otherHuman, atMs: 40, reason: 'superseded by m2', supersededBy: 'm2' });
    expect(retired).toMatchObject({ revision: 3, state: 'retired', content, verification: verified.verification,
      retirement: { by: { issuer: 'local-os', subject: 'uid:1001', ai: false }, reason: 'superseded by m2', supersededBy: 'm2', retiredAtMs: 40 } });
    expect(() => retireMemoryEntry(retired, { actor: human, atMs: 41, reason: 'twice', supersededBy: null })).toThrow(expect.objectContaining({ code: 'MEMORY_TRANSITION_INVALID' }));
    expect(() => retireMemoryEntry(verified, { actor: human, atMs: 41, reason: 'self', supersededBy: 'm1' })).toThrow(expect.objectContaining({ code: 'MEMORY_ENTRY_INVALID' }));
  });
  it('the AI may withdraw a candidate but never retire verified knowledge', () => {
    expect(retireMemoryEntry(propose(mcp), { actor: mcp, atMs: 5, reason: 'wrong', supersededBy: null }).state).toBe('retired');
    const verified = verifyMemoryEntry(propose(), { actor: human, atMs: 20, basis: { kind: 'human-review', note: 'ok' } });
    expect(() => retireMemoryEntry(verified, { actor: mcp, atMs: 41, reason: 'mine now', supersededBy: null })).toThrow(expect.objectContaining({ code: 'MEMORY_VERIFIER_NOT_HUMAN' }));
  });
});

describe('memory search terms (DB-neutral; every adapter receives the same folded words)', () => {
  it('folds case and diacritics, Turkish dotted and dotless i included', () => {
    expect(foldMemoryText('İSTANBUL Işık eşleştirme ĞÜŞÖÇ')).toBe('istanbul isik eslestirme gusoc');
    expect(memorySearchTerms('  Fatura   "eşleştirme" OR scope_id:x * NEAR(a) ')).toEqual(['fatura', 'eslestirme', 'or', 'scope', 'id', 'x', 'near', 'a']);
  });
  it('refuses an empty query and bounds the number of terms and bytes', () => {
    expect(() => memorySearchTerms(' -- * " ')).toThrow(expect.objectContaining({ code: 'MEMORY_QUERY_INVALID' }));
    expect(memorySearchTerms(Array.from({ length: 40 }, (_, i) => `w${i}`).join(' '))).toHaveLength(MEMORY_LIMITS.queryTermsMax);
    expect(() => memorySearchTerms('x'.repeat(MEMORY_LIMITS.queryMaxBytes + 1))).toThrow(expect.objectContaining({ code: 'MEMORY_QUERY_INVALID' }));
  });
  it('the scan fallback matches folded word prefixes over title, body, tags and lesson fields (all terms required; BeUser E-10)', () => {
    const entry = propose();
    expect(memoryIndexText(entry)).toContain('istanbul');
    expect(memoryEntryMatches(entry, memorySearchTerms('istanbul fatura'))).toBe(true);
    expect(memoryEntryMatches(entry, memorySearchTerms('onaya irsaliye eksik'))).toBe(true);
    expect(memoryEntryMatches(entry, memorySearchTerms('istanbul ankara'))).toBe(false);
    expect(memoryEntryMatches(entry, memorySearchTerms('ista'))).toBe(true);
    expect(memoryEntryMatches(entry, memorySearchTerms('stanbul'))).toBe(false);
  });
});
