import { composeMemoryAutomation, isMemoryTombstone, memoryContextEligible, memoryContextTerms, memoryEntryStale, memoryPlanningEligible, memoryPlanningFamilies, memoryRetentionMs, memoryTemplate, memoryWorkClassOf,
  rankMemoryContext, resolveTaskWorkClass, MEMORY_LIMITS, type MemoryAutomation, type MemoryContextTask, type MemoryContent, type MemoryEntry, type MemoryPlanningFamily, type TaskGraph,
  type VerifiedPrincipal, type WorkClassRegistry } from '#domain/index.js';
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

/** One bounded read of the scope for a context selection (worker part or planning block): the open contests and the newest verified entries,
 * then, per examined entry, whether it is fresh and readable by the principal (memoised: the same entry is checked once per read). */
interface ContextRead { readonly bounds: MemoryAutomation['context']; readonly contested: ReadonlySet<string>; readonly pool: readonly MemoryEntry[];
  check(entry: MemoryEntry): Promise<'ok' | 'stale' | 'withheld'> }
async function readContext(deps: MemoryJournalDependencies, store: MemoryJournalStore, principal: VerifiedPrincipal, scopeId: string, visible: Visible): Promise<ContextRead | null> {
  const automation = composeMemoryAutomation(deps.automation), bounds = automation.context, now = deps.now();
  if (!store.listSupport || !store.listContests) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
  const contests = await store.listContests(scopeId, MEMORY_LIMITS.scanMax);
  if (contests.length >= MEMORY_LIMITS.scanMax) return null;
  const contested = new Set(contests.flatMap(row => [row.entryId, row.candidateEntryId]));
  const pool = (await store.list(scopeId, ['verified'], bounds.candidatePool)).slice(0, bounds.candidatePool);
  if (pool.some(entry => entry.scopeId !== scopeId)) throw new MemoryJournalError('MEMORY_CORRUPT');
  const usable = new Map<string, 'ok' | 'stale' | 'withheld'>();
  return { bounds, contested, pool, async check(entry) {
    const known = usable.get(entry.entryId);
    if (known) return known;
    const support = entry.audience ? await store.listSupport!(scopeId, entry.entryId, automation.bounds.supportPerEntry) : [];
    const last = support.length ? Math.max(...support.map(row => row.atMs)) : null;
    const state = memoryEntryStale(entry, last, memoryRetentionMs(automation, entry), now) ? 'stale' as const
      : (await visible(store, principal, scopeId, [entry])).withheld ? 'withheld' as const : 'ok' as const;
    usable.set(entry.entryId, state);
    return state;
  } };
}
/**
 * In rank order, at most `maxEntries × maxSourcesChecked` entries examined: fresh and readable entries are rendered and added while the rendering
 * stays within `budget` bytes (one that does not fit is left out, a smaller next one may fit); a quarantined rendering is left out. `omitted`
 * counts the eligible entries the bounds left out (not fitting, over `maxEntries`, or never examined); stale and quarantined ones are not counted.
 */
async function pickEntries<T>(read: ContextRead, ranked: readonly MemoryEntry[], budget: number, render: (entry: MemoryEntry) => { readonly value: T; readonly bytes: number } | null) {
  const picked: { readonly entry: MemoryEntry; readonly value: T }[] = [], { bounds } = read;
  let size = 0, withheld = 0, examined = 0, omitted = 0;
  for (const entry of ranked) {
    if (picked.length >= bounds.maxEntries || examined >= bounds.maxEntries * bounds.maxSourcesChecked) { omitted += 1; continue; }
    examined += 1;
    const state = await read.check(entry);
    if (state === 'withheld') withheld += 1;
    const rendered = state === 'ok' && !isMemoryTombstone(entry.content) ? render(entry) : null;
    if (rendered === null) continue;
    if (size + rendered.bytes > budget) { omitted += 1; continue; }
    size += rendered.bytes; picked.push({ entry, value: rendered.value });
  }
  return { picked, withheld, omitted };
}
const refOf = (deps: MemoryJournalDependencies, entry: MemoryEntry): MemoryContextEntryRef => ({ entryId: entry.entryId, revision: entry.revision,
  contentDigest: deps.keyedDigest('memory-content:2', entry.content), basis: entry.verification!.basis });

/**
 * S4B-5 (§7.1, §7.3): the verified entries one Run admission freezes into each task's worker prompt. One bounded read of the scope (the open
 * contests and the `candidatePool` most recently changed verified entries), then per task: the pure eligibility rule, rank by the task's words,
 * and in rank order — at most `maxEntries × maxSourcesChecked` entries examined — not stale, and readable by the admitting principal through the
 * same source filter as list/search (§7.4). Entries are added while the part stays within `maxBytes`; one that does not fit is left out. The
 * Run is new, so no support row of this Run exists yet (an entry from this Run never serves it).
 */
export async function selectMemoryContext(deps: MemoryJournalDependencies, store: MemoryJournalStore, principal: VerifiedPrincipal, policyRevision: string,
  request: MemoryContextRequest, visible: Visible): Promise<MemoryContextSelection> {
  const read = await readContext(deps, store, principal, request.scopeId, visible);
  if (!read) return { schemaVersion: 1, status: 'withheld', reason: 'contests' };
  const header = memoryTemplate(MEMORY_CONTEXT_HEADER.id, MEMORY_CONTEXT_HEADER.version).replace('{scope}', request.scopeId), tasks: MemoryContextTaskPart[] = [];
  for (const task of request.tasks) {
    const ranked = rankMemoryContext(read.pool.filter(entry => memoryContextEligible(entry, task, request, read.contested)), task.terms);
    const { picked, withheld } = await pickEntries(read, ranked, read.bounds.maxBytes - bytes(header), entry => {
      const line = renderLine(entry, deps.knownSecrets);
      return line === null ? null : { value: line, bytes: bytes(`\n${line}`) };
    });
    const entries = picked.map(row => refOf(deps, row.entry));
    if (!entries.length) { tasks.push({ taskId: task.taskId, part: null, partDigest: null, entries, withheld }); continue; }
    const text = [header, ...picked.map(row => row.value)].join('\n'), partDigest = deps.keyedDigest('memory-context:1', { scopeId: request.scopeId, text });
    tasks.push({ taskId: task.taskId, part: { id: `memory-${partDigest.slice(0, 16)}`, version: MEMORY_CONTEXT_HEADER.version, text }, partDigest, entries, withheld });
  }
  return { schemaVersion: 1, status: 'ok', policyRevision, tasks };
}

/** S4B-6 (§7.2): one planning request's question (trusted composition builds it; never a wire field). `runId` is the Brain's Run id. */
export interface MemoryPlanningRequest { readonly scopeId: string; readonly runId: string; readonly workTargetId: string | null;
  readonly families: readonly MemoryPlanningFamily[]; readonly terms: readonly string[] }
/**
 * The planning request as memory selection keys it (trusted composition passes what it loaded): every family of the installation's WorkClass
 * registry at its highest class risk, and the ranking words of the redacted intent (bounded by the registry's `context.termsMax`).
 */
export function memoryPlanningRequest(input: Readonly<{ scopeId: string; runId: string; workTargetId: string | null; intent: string; workClasses: WorkClassRegistry | undefined;
  automation: unknown; knownSecrets?: MemoryJournalDependencies['knownSecrets'] }>): MemoryPlanningRequest {
  const termsMax = composeMemoryAutomation(input.automation).context.termsMax;
  return Object.freeze({ scopeId: input.scopeId, runId: input.runId, workTargetId: input.workTargetId, families: memoryPlanningFamilies(input.workClasses),
    terms: memoryContextTerms([redactForRecord(input.intent, input.knownSecrets)], termsMax) });
}
/** One entry as the Brain reads it (data): title and body redacted and projected like the worker line. */
export interface MemoryPlanningRow { readonly entryId: string; readonly revision: number; readonly kind: MemoryContent['kind']; readonly title: string; readonly body: string }
/** `withheld` here counts eligible entries from work the requesting person may not read; `omitted` those the registry bounds left out. */
export type MemoryPlanningSelection = { readonly schemaVersion: 1; readonly status: 'ok'; readonly policyRevision: string; readonly entries: readonly MemoryPlanningRow[];
  readonly refs: readonly MemoryContextEntryRef[]; readonly withheld: number; readonly omitted: number }
  | { readonly schemaVersion: 1; readonly status: 'withheld'; readonly reason: 'policy' | 'contests' } | MemoryHeld;
function planningRow(entry: MemoryEntry, known: MemoryJournalDependencies['knownSecrets']): MemoryPlanningRow | null {
  if (isMemoryTombstone(entry.content)) return null;
  const field = (text: string) => { const projected = projectModelIngressField(redactForRecord(text, known)); return projected.disposition === 'quarantine' ? null : projected.modelText; };
  const title = field(entry.content.title), body = field(entry.content.body);
  return title === null || body === null ? null : { entryId: entry.entryId, revision: entry.revision, kind: entry.content.kind, title, body };
}
/**
 * S4B-6 (§7.2, §7.3; owner S-M7 "same rules as the worker"): the verified entries one planning request offers the Brain, through the same read,
 * checks and bounds as the worker part (`maxEntries`, `maxBytes` over the JSON rows), keyed by every family the Brain may plan with at that
 * family's risk (A8 by source family) and ranked by the intent's words. A planning request has no Run yet, so no support row of it exists.
 */
export async function selectMemoryPlanningContext(deps: MemoryJournalDependencies, store: MemoryJournalStore, principal: VerifiedPrincipal, policyRevision: string,
  request: MemoryPlanningRequest, visible: Visible): Promise<MemoryPlanningSelection> {
  const read = await readContext(deps, store, principal, request.scopeId, visible);
  if (!read) return { schemaVersion: 1, status: 'withheld', reason: 'contests' };
  const ranked = rankMemoryContext(read.pool.filter(entry => memoryPlanningEligible(entry, request.families, request, read.contested)), request.terms);
  const { picked, withheld, omitted } = await pickEntries(read, ranked, read.bounds.maxBytes, entry => {
    const row = planningRow(entry, deps.knownSecrets);
    return row === null ? null : { value: row, bytes: bytes(JSON.stringify(row)) + 1 };
  });
  return { schemaVersion: 1, status: 'ok', policyRevision, entries: picked.map(row => row.value), refs: picked.map(row => refOf(deps, row.entry)), withheld, omitted };
}
