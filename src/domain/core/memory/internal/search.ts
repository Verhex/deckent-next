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
  // S4B-4: a purged entry has no text to index (only its tombstone is left), so no search reaches it.
  if ('purged' in entry.content) return '';
  const lesson = entry.content.lesson;
  return foldMemoryText([entry.content.title, entry.content.body, ...entry.content.tags,
    ...(lesson ? [lesson.source, lesson.cause, lesson.correction, lesson.evidence] : [])].join(' '));
}
/** Scan fallback for a store without full-text search: every term must start a folded word of the entry. */
export function memoryEntryMatches(entry: MemoryEntry, terms: readonly string[]): boolean {
  // BeUser E-10: a term matches a word it starts (Turkish suffixes: "ton" finds "tonu"), the same rule as the index's prefix query.
  const words = memoryIndexText(entry).split(' ').filter(Boolean);
  return terms.every(term => words.some(word => word.startsWith(term)));
}
