import { MEMORY_LIMITS, MemoryError, type MemoryEntry } from './contract.js';

/**
 * One folding rule for every search adapter (DB-neutral): NFKD, combining marks removed, lower case, Turkish dotless ı → i. Words are runs of
 * letters and digits; everything else (quotes, operators, column filters) is a separator, so no adapter ever receives query syntax from a user.
 */
export function foldMemoryText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/ı/g, 'i').split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
}
/** The bounded, de-duplicated words of a query (at most `queryTermsMax`); an empty or oversized query is refused. */
export function memorySearchTerms(query: string): readonly string[] {
  if (new TextEncoder().encode(query).length > MEMORY_LIMITS.queryMaxBytes) throw new MemoryError('MEMORY_QUERY_INVALID');
  const terms = [...new Set(foldMemoryText(query).split(' ').filter(Boolean))].slice(0, MEMORY_LIMITS.queryTermsMax);
  if (!terms.length) throw new MemoryError('MEMORY_QUERY_INVALID');
  return Object.freeze(terms);
}
/** The folded text an index stores for an entry: title, body, tags and lesson fields. */
export function memoryIndexText(entry: MemoryEntry): string {
  const lesson = entry.content.lesson;
  return foldMemoryText([entry.content.title, entry.content.body, ...entry.content.tags,
    ...(lesson ? [lesson.source, lesson.cause, lesson.correction, lesson.evidence] : [])].join(' '));
}
/** Scan fallback for a store without full-text search: every term must be a whole folded word of the entry. */
export function memoryEntryMatches(entry: MemoryEntry, terms: readonly string[]): boolean {
  const words = new Set(memoryIndexText(entry).split(' '));
  return terms.every(term => words.has(term));
}
