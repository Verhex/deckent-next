import { expect, it } from 'vitest';
import { MEMORY_SCHEMA_VERSION, memoryEntrySchema, memoryLessonClaimSchema, proposeMemoryEntry } from '#domain/index.js';

// S4B-1 (S4B-DESIGN §4.3): entry schema v2 adds `audience` (WorkClass family + work target) set by the distiller; a person's entry has none
// (scope-wide). v1 rows written by alpha.55 S4 stay readable unchanged. §4.4: the worker `lessons` claim shape S4B-2 puts into the report.
const content = { kind: 'fact', title: 'Kural', body: 'Gövde', tags: [], lesson: null };
const v1 = { schemaVersion: 1, scopeId: 's', entryId: 'm1', revision: 1, state: 'candidate', content, contentDigest: 'a'.repeat(64),
  provenance: { author: { issuer: 'host', subject: '1', ai: false }, origin: { kind: 'human', ref: null }, proposedAtMs: 1, commandId: 'm1' },
  verification: null, retirement: null, updatedAtMs: 1 };

it('reads a v1 row unchanged and refuses an audience on it; v2 needs the audience key (null = scope-wide)', () => {
  expect(MEMORY_SCHEMA_VERSION).toBe(2);
  expect(memoryEntrySchema.parse(v1)).toEqual(v1);
  expect(memoryEntrySchema.safeParse({ ...v1, audience: null }).success).toBe(false);
  expect(memoryEntrySchema.safeParse({ ...v1, schemaVersion: 2 }).success).toBe(false);
  expect(memoryEntrySchema.parse({ ...v1, schemaVersion: 2, audience: null }).audience).toBeNull();
  expect(memoryEntrySchema.parse({ ...v1, schemaVersion: 2, audience: { workClassFamily: 'small', workTargetId: null } }).audience).toEqual({ workClassFamily: 'small', workTargetId: null });
  expect(memoryEntrySchema.safeParse({ ...v1, schemaVersion: 2, audience: { workClassFamily: 'small' } }).success).toBe(false);
});

it('a new proposal is v2 with the given audience (default none)', () => {
  const author = { issuer: 'host/memory-distiller', subject: '1', assurance: 'workload-verified' };
  const entry = proposeMemoryEntry({ scopeId: 's', entryId: 'e', commandId: 'c', content, contentDigest: 'b'.repeat(64), author, origin: { kind: 'run', ref: 'run/r/task/t/attempt/a' }, atMs: 2,
    audience: { workClassFamily: 'small', workTargetId: 'erp' } });
  expect(entry).toMatchObject({ schemaVersion: 2, audience: { workClassFamily: 'small', workTargetId: 'erp' }, provenance: { author: { ai: true } } });
  expect(proposeMemoryEntry({ scopeId: 's', entryId: 'e', commandId: 'c', content, contentDigest: 'b'.repeat(64), author: { issuer: 'host', subject: '1', assurance: 'os-user' },
    origin: { kind: 'human', ref: null }, atMs: 2 }).audience).toBeNull();
});

it('N24 (shape half): a lesson claim needs cause and correction; extra fields are refused, nothing is coerced', () => {
  expect(memoryLessonClaimSchema.safeParse({ kind: 'fact', title: 'T', body: 'B' }).success).toBe(true);
  expect(memoryLessonClaimSchema.safeParse({ kind: 'lesson', title: 'T', body: 'B', cause: 'c', correction: 'd' }).success).toBe(true);
  expect(memoryLessonClaimSchema.safeParse({ kind: 'lesson', title: 'T', body: 'B', cause: 'c' }).success).toBe(false);
  expect(memoryLessonClaimSchema.safeParse({ kind: 'fact', title: 'T', body: 'B', grant: 'full-access' }).success).toBe(false);
  expect(memoryLessonClaimSchema.safeParse({ kind: 'fact', title: ' T', body: 'B' }).success).toBe(false);
});
