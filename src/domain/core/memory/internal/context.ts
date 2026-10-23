import { isMemoryTombstone, type MemoryEntry } from './contract.js';
import { foldMemoryText, memoryIndexText } from './search.js';
import { memoryWorkClassIn, memoryWorkClassIndex } from './automation.js';
import type { WorkClassRegistry } from '#domain/core/run/index.js';

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
/** S4B-6 (§7.2): one WorkClass family the Brain may plan with and the highest proposal risk of any class in it (root and descendants). */
export interface MemoryPlanningFamily { readonly family: string; readonly risk: 'low' | 'normal' | 'high' }
const RISK_ORDER = Object.freeze({ low: 0, normal: 1, high: 2 } as const);
/**
 * The families of the installation's WorkClass registry (the classes `brainWorkClassView` offers), each with its highest class risk. A memory
 * entry keys only its source family (the root of its source class), so the A8 limit for planning is applied by the family: an auto-verified
 * entry serves planning only when every class of its family is low risk (with the flat Core registry this is the class's own risk).
 */
export function memoryPlanningFamilies(configured: WorkClassRegistry | undefined): readonly MemoryPlanningFamily[] {
  const byId = memoryWorkClassIndex(configured), families = new Map<string, MemoryPlanningFamily['risk']>();
  for (const classId of byId.keys()) {
    const view = memoryWorkClassIn(byId, classId);
    if (!view) continue;
    const known = families.get(view.family);
    if (known === undefined || RISK_ORDER[view.risk] > RISK_ORDER[known]) families.set(view.family, view.risk);
  }
  return Object.freeze([...families].map(([family, risk]) => Object.freeze({ family, risk })));
}
/**
 * The planning rule over the worker rule (`memoryContextEligible`, one source of truth): a person's scope-wide entry (`audience: null`) as for a
 * class-less task (a person's review only); a system entry only for an offered family, at that family's risk, and the Run's work target.
 */
export function memoryPlanningEligible(entry: MemoryEntry, families: readonly MemoryPlanningFamily[], run: { readonly scopeId: string; readonly workTargetId: string | null },
  contested: ReadonlySet<string>): boolean {
  const family = entry.audience ? families.find(row => row.family === entry.audience!.workClassFamily) : undefined;
  if (entry.audience && !family) return false;
  return memoryContextEligible(entry, { taskId: '', family: family?.family ?? null, risk: family?.risk ?? 'normal', terms: [] }, run, contested);
}
