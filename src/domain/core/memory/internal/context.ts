import { isMemoryTombstone, type MemoryEntry } from './contract.js';
import { foldMemoryText, memoryIndexText } from './search.js';

/**
 * S4B-5 (S4B-DESIGN rev 4 §7.1, A8; owner S-M6/S-M8/S-M9): which verified entries may enter one task's worker prompt at Run admission. Pure and
 * deterministic over loaded domain JSON; the engine adds the stale and source-read checks (they need support rows) and renders the part.
 */
export interface MemoryContextTask {
  readonly taskId: string;
  /** The task's WorkClass family (root of the parent chain) and proposal risk; null family: no class known (only scope-wide entries serve it). */
  readonly family: string | null;
  readonly risk: 'low' | 'normal' | 'high';
  /** Folded, de-duplicated words of the task's work input (title, task, acceptance), at most the registry's `context.termsMax`. */
  readonly terms: readonly string[];
}
/** The task's ranking words: folded like the search index (one rule for every adapter), first occurrence order, at most `max`. */
export function memoryContextTerms(texts: readonly string[], max: number): readonly string[] {
  return Object.freeze([...new Set(texts.flatMap(text => foldMemoryText(text).split(' ').filter(Boolean)))].slice(0, max));
}
/**
 * Every condition required: the Run's scope, state `verified`, content not purged, not named by an open contest, the audience of the task (a
 * person's `audience: null` entry is scope-wide; a system entry needs the same WorkClass family and the Run's own work target), and a basis the
 * task's class may use — a person's review always, an independent evaluation only for a low-risk class (A8).
 */
export function memoryContextEligible(entry: MemoryEntry, task: MemoryContextTask, run: { readonly scopeId: string; readonly workTargetId: string | null },
  contested: ReadonlySet<string>): boolean {
  if (entry.scopeId !== run.scopeId || entry.state !== 'verified' || isMemoryTombstone(entry.content) || contested.has(entry.entryId)) return false;
  const audience = entry.audience ?? null;
  if (audience && (audience.workClassFamily !== task.family || audience.workTargetId !== run.workTargetId)) return false;
  const basis = entry.verification?.basis;
  return basis === 'human-review' || (basis === 'independent-evaluation' && task.risk === 'low');
}
/** Rank: more of the task's words in the entry's indexed text first; ties keep the input order (the store's most recently changed first). */
export function rankMemoryContext(entries: readonly MemoryEntry[], terms: readonly string[]): readonly MemoryEntry[] {
  const wanted = new Set(terms);
  const scored = entries.map((entry, index) => ({ entry, index, score: memoryIndexText(entry).split(' ').filter((word, at, all) => wanted.has(word) && all.indexOf(word) === at).length }));
  return Object.freeze(scored.sort((a, b) => b.score - a.score || a.index - b.index).map(row => row.entry));
}
