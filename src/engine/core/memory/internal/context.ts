import { composeMemoryAutomation, isMemoryTombstone, memoryContextEligible, memoryContextTerms, memoryEntryStale, memoryRetentionMs, memoryTemplate, memoryWorkClassOf,
  rankMemoryContext, resolveTaskWorkClass, MEMORY_LIMITS, type MemoryContextTask, type MemoryEntry, type TaskGraph, type VerifiedPrincipal, type WorkClassRegistry } from '#domain/index.js';
import { redactForRecord } from '#platform/index.js';
import { projectModelIngressField } from '#engine/core/agent-turn/index.js';
import { MemoryJournalError, type MemoryHeld, type MemoryJournalDependencies, type MemoryJournalStore } from './contract.js';

/** The versioned header of the part (`memory-templates`); its `id@version` is the part version, so the frozen profile names the wording it used. */
export const MEMORY_CONTEXT_HEADER = Object.freeze({ id: 'context-header', version: 1 } as const);
/** One admission's question (trusted composition builds it from the admitted graph; never a wire field). */
export interface MemoryContextRequest { readonly scopeId: string; readonly runId: string; readonly workTargetId: string | null; readonly tasks: readonly MemoryContextTask[] }
export interface MemoryContextEntryRef { readonly entryId: string; readonly revision: number; readonly contentDigest: string; readonly basis: 'human-review' | 'independent-evaluation' }
/** One task's frozen memory: the prompt part (null: nothing selected), its keyed digest, the entries it names (keyed content digests) and how many
 * otherwise eligible entries the admitting principal may not read (a count only). */
export interface MemoryContextTaskPart { readonly taskId: string; readonly part: { readonly id: string; readonly version: number; readonly text: string } | null;
  readonly partDigest: string | null; readonly entries: readonly MemoryContextEntryRef[]; readonly withheld: number }
/** `withheld`: no part for any task — the admitting principal may not inspect the scope's memory (`policy`), or more contests are open than one
 * bounded read shows (`contests`, fail closed: a contested entry must never be sent). A failed read is a hold, never an empty memory. */
export type MemoryContextSelection = { readonly schemaVersion: 1; readonly status: 'ok'; readonly policyRevision: string; readonly tasks: readonly MemoryContextTaskPart[] }
  | { readonly schemaVersion: 1; readonly status: 'withheld'; readonly reason: 'policy' | 'contests' } | MemoryHeld;
type Visible = (store: MemoryJournalStore, principal: VerifiedPrincipal, scopeId: string, entries: readonly MemoryEntry[]) => Promise<{ readonly withheld: number }>;
const bytes = (value: string) => Buffer.byteLength(value);

/**
 * The admission's tasks as memory selection keys them: every task with a work input (only those get a worker prompt), its WorkClass (the task's,
 * else its work input's, else the kind binding) reduced to family and risk through the installation registry, and its ranking words (bounded by
 * the registry's `context.termsMax`). An unregistered class keys nothing system-derived (admission refuses it itself); no class: risk `normal`.
 */
export function memoryContextTasks(graph: Pick<TaskGraph, 'tasks'>, workClasses: WorkClassRegistry | undefined, automation: unknown): readonly MemoryContextTask[] {
  const termsMax = composeMemoryAutomation(automation).context.termsMax;
  return Object.freeze(graph.tasks.flatMap(task => {
    const input = task.workInput;
    if (!input) return [];
    let classId: string | null;
    try { classId = resolveTaskWorkClass(task.kind, task.workClass ?? input.workClass, workClasses).workClass?.id ?? null; } catch { classId = null; }
    const view = memoryWorkClassOf(workClasses, classId);
    return [{ taskId: task.id, family: view?.family ?? null, risk: view?.risk ?? 'normal', terms: memoryContextTerms([input.title ?? '', input.task, input.acceptance], termsMax) }];
  }));
}
/** One entry line as the worker reads it: id@revision, basis, title — body; secrets redacted and hidden characters projected; null: quarantined. */
function renderLine(entry: MemoryEntry, known: MemoryJournalDependencies['knownSecrets']): string | null {
  if (isMemoryTombstone(entry.content)) return null;
  const projected = projectModelIngressField(redactForRecord(`${entry.entryId}@${entry.revision} [${entry.verification!.basis}] ${entry.content.title} — ${entry.content.body}`, known));
  return projected.disposition === 'quarantine' ? null : projected.modelText.replace(/\s*\n\s*/gu, ' ');
}

/**
 * S4B-5 (§7.1, §7.3): the verified entries one Run admission freezes into each task's worker prompt. One bounded read of the scope (the open
 * contests and the `candidatePool` most recently changed verified entries), then per task: the pure eligibility rule, rank by the task's words,
 * and in rank order — at most `maxEntries × maxSourcesChecked` entries examined — not stale, and readable by the admitting principal through the
 * same source filter as list/search (§7.4). Entries are added while the part stays within `maxBytes`; one that does not fit is left out. The
 * Run is new, so no support row of this Run exists yet (an entry from this Run never serves it).
 */
export async function selectMemoryContext(deps: MemoryJournalDependencies, store: MemoryJournalStore, principal: VerifiedPrincipal, policyRevision: string,
  request: MemoryContextRequest, visible: Visible): Promise<MemoryContextSelection> {
  const automation = composeMemoryAutomation(deps.automation), bounds = automation.context, now = deps.now();
  if (!store.listSupport || !store.listContests) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
  const contests = await store.listContests(request.scopeId, MEMORY_LIMITS.scanMax);
  if (contests.length >= MEMORY_LIMITS.scanMax) return { schemaVersion: 1, status: 'withheld', reason: 'contests' };
  const contested = new Set(contests.flatMap(row => [row.entryId, row.candidateEntryId]));
  const pool = (await store.list(request.scopeId, ['verified'], bounds.candidatePool)).slice(0, bounds.candidatePool);
  if (pool.some(entry => entry.scopeId !== request.scopeId)) throw new MemoryJournalError('MEMORY_CORRUPT');
  const usable = new Map<string, 'ok' | 'stale' | 'withheld'>();
  const check = async (entry: MemoryEntry) => {
    const known = usable.get(entry.entryId);
    if (known) return known;
    const support = entry.audience ? await store.listSupport!(request.scopeId, entry.entryId, automation.bounds.supportPerEntry) : [];
    const last = support.length ? Math.max(...support.map(row => row.atMs)) : null;
    const state = memoryEntryStale(entry, last, memoryRetentionMs(automation, entry), now) ? 'stale' as const
      : (await visible(store, principal, request.scopeId, [entry])).withheld ? 'withheld' as const : 'ok' as const;
    usable.set(entry.entryId, state);
    return state;
  };
  const header = memoryTemplate(MEMORY_CONTEXT_HEADER.id, MEMORY_CONTEXT_HEADER.version).replace('{scope}', request.scopeId), tasks: MemoryContextTaskPart[] = [];
  for (const task of request.tasks) {
    const ranked = rankMemoryContext(pool.filter(entry => memoryContextEligible(entry, task, request, contested)), task.terms);
    const lines: string[] = [], entries: MemoryContextEntryRef[] = [];
    let size = bytes(header), withheld = 0, examined = 0;
    for (const entry of ranked) {
      if (entries.length >= bounds.maxEntries || examined >= bounds.maxEntries * bounds.maxSourcesChecked) break;
      examined += 1;
      const state = await check(entry);
      if (state === 'withheld') withheld += 1;
      const line = state === 'ok' ? renderLine(entry, deps.knownSecrets) : null;
      if (line === null || size + bytes(`\n${line}`) > bounds.maxBytes || isMemoryTombstone(entry.content)) continue;
      size += bytes(`\n${line}`); lines.push(line);
      entries.push({ entryId: entry.entryId, revision: entry.revision, contentDigest: deps.keyedDigest('memory-content:2', entry.content), basis: entry.verification!.basis });
    }
    if (!entries.length) { tasks.push({ taskId: task.taskId, part: null, partDigest: null, entries, withheld }); continue; }
    const text = [header, ...lines].join('\n'), partDigest = deps.keyedDigest('memory-context:1', { scopeId: request.scopeId, text });
    tasks.push({ taskId: task.taskId, part: { id: `memory-${partDigest.slice(0, 16)}`, version: MEMORY_CONTEXT_HEADER.version, text }, partDigest, entries, withheld });
  }
  return { schemaVersion: 1, status: 'ok', policyRevision, tasks };
}
