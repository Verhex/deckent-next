import { MEMORY_LIMITS, assertMemoryPerson, composeMemoryAutomation, encodeCommandProjection, isMemoryEvaluatorPrincipal, isMemoryTombstone, memoryContestResolutionSchema, memoryEntryStale, memoryRetentionMs,
  parseMemoryPurgeRecord, MemoryError, type AuditEvent, type MemoryContest, type MemoryEntry, type MemoryPurgeRecord, type VerifiedPrincipal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { MemoryJournalError, memoryContestResolveCommandSchema, memoryPurgeCommandSchema, memoryReviewQuerySchema, memorySourceQuerySchema, type MemoryContestResolveResult,
  type MemoryEvaluatorInvocation, type MemoryJournalDependencies, type MemoryJournalStore, type MemoryPurgeReplay, type MemoryPurgeResult, type MemoryReview, type MemoryReviewItem,
  type MemorySourceEntries } from './contract.js';

/**
 * S4B-4 (S4B-DESIGN rev 4 §6.5, §6.6, §7.4, A9, A11; owner S-M10/S-M12/S-M13 2026-10-23): the review card's read, contest resolution and the purge,
 * run by the journal application (the one transition owner). Purge order: the sealed journal entry first (durable intent outside the ledger),
 * then the ledger tombstone in one transaction, then the evaluator invocations' stored content. A crash anywhere after the first step is
 * completed by the idempotent replay, which also re-applies every purge a restored backup brought back.
 */
const held = () => new MemoryJournalError('MEMORY_PURGE_REPLAY_HELD');
type Visible = (store: MemoryJournalStore, principal: VerifiedPrincipal, scopeId: string, entries: readonly MemoryEntry[]) => Promise<{ entries: MemoryEntry[]; withheld: number }>;
type Admit = (action: 'inspect' | 'retire' | 'contest' | 'purge', scopeId: string) => Promise<{ principal: VerifiedPrincipal; authorization: { revision: string; ruleId?: string } }>;
type Retire = (command: { schemaVersion: 1; scopeId: string; commandId: string; entryId: string; expectedRevision: number; reason: string; supersededBy: null }) => Promise<{ entry: MemoryEntry }>;

/** Every journal record of the scope must be in the ledger before anything reads or writes it (a restore that lost a purge never un-purges). */
export async function assertNoPendingMemoryPurge(deps: MemoryJournalDependencies, store: MemoryJournalStore, scopeId: string): Promise<void> {
  if (!deps.purgeJournal) return;
  let records: readonly MemoryPurgeRecord[];
  try { records = (await deps.purgeJournal.list()).filter(record => record.scopeId === scopeId); } catch { throw held(); }
  if (!records.length) return;
  if (!store.purgeRecord) throw held();
  for (const record of records) if (!await store.purgeRecord(scopeId, record.purgeId)) throw held();
}
const purgeEvent = (deps: MemoryJournalDependencies, principal: VerifiedPrincipal, policyRevision: string, record: MemoryPurgeRecord, revisions: number, replay: boolean): AuditEvent => ({
  schemaVersion: 1, eventId: deps.eventId(), scopeId: record.scopeId, principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision, atMs: deps.now(),
  subject: { kind: 'memory-purge', purgeId: record.purgeId, entryId: record.entryId, contentDigest: record.contentDigest, revisions, invocations: record.invocationIds.length, replay } });
/**
 * The purge record's evaluator invocations, each bound to the entry before anything is deleted (lead review 2026-10-23): it must be one the
 * record lists, claimed by the command of one of the entry's sealed evaluation records (the evaluator's command id is its record id) and invoked
 * by the memory evaluator. Any other invocation refuses the whole purge (`MEMORY_PURGE_INVOCATION_REFUSED`); none is reachable through this path.
 */
async function boundInvocations(deps: MemoryJournalDependencies, record: MemoryPurgeRecord, ids: readonly string[] = record.invocationIds) {
  if (!ids.length) return [];
  if (!deps.evaluatorInvocations) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
  const out: { invocationId: string; held: MemoryEvaluatorInvocation }[] = [];
  for (const invocationId of ids) {
    if (!record.invocationIds.includes(invocationId)) throw new MemoryJournalError('MEMORY_PURGE_INVOCATION_REFUSED');
    const held = await deps.evaluatorInvocations.load(record.scopeId, invocationId);
    if (!held) continue;
    if (!record.evaluationRecordIds.includes(held.commandId) || !isMemoryEvaluatorPrincipal(held.invokedBy)) throw new MemoryJournalError('MEMORY_PURGE_INVOCATION_REFUSED');
    out.push({ invocationId, held });
  }
  return out;
}
/** The bound invocations' stored content, removed under the purge record's own `memory`/`purge` decision (idempotent per purge and invocation). */
export async function purgeMemoryInvocations(deps: MemoryJournalDependencies, record: MemoryPurgeRecord, actor: VerifiedPrincipal, ids: readonly string[] = record.invocationIds) {
  let purged = 0, absent = ids.length;
  for (const { invocationId, held } of await boundInvocations(deps, record, ids)) {
    if (held.contentDigest === null) continue;
    const commandId = sha256(encodeCommandProjection('memory-purge-invocation:1', { purgeId: record.purgeId, invocationId }));
    await deps.evaluatorInvocations!.purgeContent({ scopeId: record.scopeId, invocationId, commandId, reference: held.reference, expectedContentDigest: held.contentDigest, actor,
      decision: record.decision, atMs: deps.now() });
    purged++; absent--;
  }
  return { purged, absent };
}

/** §6.6: a person's purge of one entry. AI principals are refused (the floor refuses them first; the domain again here). */
export async function purgeMemoryEntry(deps: MemoryJournalDependencies, input: unknown, admit: Admit): Promise<MemoryPurgeResult> {
  const command = memoryPurgeCommandSchema.parse(input), { principal, authorization } = await admit('purge', command.scopeId);
  assertMemoryPerson(principal);
  if (!deps.purgeJournal) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
  let record: MemoryPurgeRecord, replayed: boolean;
  const store = await deps.openStore('write');
  try {
    if (!store.tombstone || !store.purgeRecord || !store.evaluationsFor) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
    await assertNoPendingMemoryPurge(deps, store, command.scopeId);
    const prior = await store.purgeRecord(command.scopeId, command.commandId);
    if (prior) {
      if (prior.entryId !== command.entryId || prior.reasonCode !== command.reasonCode) throw new MemoryJournalError('MEMORY_COMMAND_CONFLICT');
      record = prior; replayed = true;
    } else {
      const entry = await store.load(command.scopeId, command.entryId);
      if (!entry || entry.scopeId !== command.scopeId) throw new MemoryJournalError('MEMORY_NOT_FOUND');
      if (entry.revision !== command.expectedRevision) throw new MemoryJournalError('MEMORY_REVISION_CONFLICT');
      if (isMemoryTombstone(entry.content)) throw new MemoryError('MEMORY_TRANSITION_INVALID');
      const evaluations = await store.evaluationsFor(command.scopeId, command.entryId, MEMORY_LIMITS.purgeInvocationsMax);
      if (!authorization.ruleId) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
      record = parseMemoryPurgeRecord({ schemaVersion: 1, purgeId: command.commandId, scopeId: command.scopeId, entryId: command.entryId,
        // A v61 entry's plain digest is re-keyed here: no plain digest of the content stays in the journal.
        contentDigest: deps.keyedDigest('memory-content:2', entry.content), digestKind: 'keyed', reasonCode: command.reasonCode,
        by: { issuer: principal.issuer, subject: principal.subject }, decision: { revision: authorization.revision, ruleId: authorization.ruleId }, evaluationRecordIds: evaluations.map(row => row.record.recordId),
        invocationIds: [...new Set(evaluations.flatMap(row => row.record.invocationId ? [row.record.invocationId] : []))], atMs: deps.now() });
      // Every invocation is bound to this entry before the journal or the ledger changes (a refused one leaves nothing deleted).
      await boundInvocations(deps, record);
      await deps.purgeJournal.append(record);
      replayed = (await store.tombstone(record, purgeEvent(deps, principal, authorization.revision, record, entry.revision, false))).replayed;
    }
  } finally { store.close(); }
  const invocations = await purgeMemoryInvocations(deps, record, principal);
  const reader = await deps.openStore('read');
  try {
    const entry = await reader.load(record.scopeId, record.entryId);
    if (!entry || !isMemoryTombstone(entry.content)) throw new MemoryJournalError('MEMORY_CORRUPT');
    return { schemaVersion: 1, replayed, entry, record, invocations };
  } finally { reader.close(); }
}

/**
 * §6.6 restore safety: every journal record of the scope re-applied (tombstone or purge record only, then the invocation content), idempotently,
 * before the service admits work or a write reads. `pendingOnly` (a person's write): only the records the ledger lacks, with their invocations;
 * the service start replays all (it also completes a purge cut off after its tombstone). Any failure is `MEMORY_PURGE_REPLAY_HELD`.
 */
export async function replayMemoryPurges(deps: MemoryJournalDependencies, scopeId: string, principal: VerifiedPrincipal, policyRevision: string,
  pendingOnly: boolean): Promise<MemoryPurgeReplay> {
  if (!deps.purgeJournal) return { schemaVersion: 1, records: 0, applied: 0, invocationsPurged: 0 };
  try {
    const records = (await deps.purgeJournal.list()).filter(record => record.scopeId === scopeId);
    let applied = 0, invocationsPurged = 0;
    for (const record of records) {
      let pending = false;
      const store = await deps.openStore('write');
      try {
        if (!store.tombstone || !store.purgeRecord) throw held();
        if (!await store.purgeRecord(scopeId, record.purgeId)) {
          pending = true;
          const entry = await store.load(scopeId, record.entryId);
          if (!(await store.tombstone(record, purgeEvent(deps, principal, policyRevision, record, entry?.revision ?? 0, true))).replayed) applied++;
        }
      } finally { store.close(); }
      if (pending || !pendingOnly) invocationsPurged += (await purgeMemoryInvocations(deps, record, principal)).purged;
    }
    return { schemaVersion: 1, records: records.length, applied, invocationsPurged };
  } catch (error) { if (error instanceof MemoryJournalError && error.code === 'MEMORY_PURGE_REPLAY_HELD') throw error; throw Object.assign(held(), { cause: error }); }
}

/**
 * The review card's page (§6.5, §7.4): candidates, contested and stale entries of the scope (newest first, within the protocol scan bound),
 * each with its support rows, the evaluator's sealed records and its open contests. The same source filter as list: a withheld entry or a
 * contest naming one is only counted.
 */
export async function reviewMemory(deps: MemoryJournalDependencies, store: MemoryJournalStore, principal: VerifiedPrincipal, input: unknown, visible: Visible): Promise<MemoryReview> {
  const query = memoryReviewQuerySchema.parse(input), automation = composeMemoryAutomation(deps.automation), now = deps.now();
  if (!store.listSupport || !store.evaluationsFor || !store.listContests) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
  await assertNoPendingMemoryPurge(deps, store, query.scopeId);
  const contests = await store.listContests(query.scopeId, MEMORY_LIMITS.pageMax), contested = new Set(contests.flatMap(row => [row.entryId, row.candidateEntryId]));
  const scanned = await store.list(query.scopeId, ['candidate', 'verified'], MEMORY_LIMITS.scanMax + 1);
  const picked: { entry: MemoryEntry; support: Awaited<ReturnType<NonNullable<MemoryJournalStore['listSupport']>>>; stale: boolean; retentionMs: number | null; last: number | null }[] = [];
  for (const entry of scanned.slice(0, MEMORY_LIMITS.scanMax)) {
    if (entry.scopeId !== query.scopeId) throw new MemoryJournalError('MEMORY_CORRUPT');
    if (picked.length >= query.limit) break;
    const support = entry.audience ? await store.listSupport(query.scopeId, entry.entryId, automation.bounds.supportPerEntry) : [];
    const last = support.length ? Math.max(...support.map(row => row.atMs)) : null, retentionMs = memoryRetentionMs(automation, entry);
    const stale = memoryEntryStale(entry, last, retentionMs, now);
    if (entry.state === 'candidate' || stale || contested.has(entry.entryId)) picked.push({ entry, support, stale, retentionMs, last });
  }
  const shown = await visible(store, principal, query.scopeId, picked.map(row => row.entry)), ids = new Set(shown.entries.map(entry => entry.entryId));
  const items: MemoryReviewItem[] = [];
  for (const row of picked.filter(item => ids.has(item.entry.entryId))) items.push({ entry: row.entry, support: row.support, stale: row.stale, retentionMs: row.retentionMs,
    lastSupportAtMs: row.last, evaluations: (await store.evaluationsFor(query.scopeId, row.entry.entryId, MEMORY_LIMITS.historyMax)).map(item => item.record),
    contests: contests.filter(contest => contest.entryId === row.entry.entryId || contest.candidateEntryId === row.entry.entryId) });
  // A contest is shown only when the caller may see both of its entries (either may be outside the page: they are read and filtered too).
  const seen = new Map<string, boolean>(picked.map(row => [row.entry.entryId, ids.has(row.entry.entryId)] as const));
  for (const id of contested) if (!seen.has(id)) {
    const other = await store.load(query.scopeId, id);
    seen.set(id, other !== null && (await visible(store, principal, query.scopeId, [other])).withheld === 0);
  }
  const shownContests = contests.filter(contest => seen.get(contest.entryId) && seen.get(contest.candidateEntryId));
  return { schemaVersion: 1, status: 'ok', scopeId: query.scopeId, items, contests: shownContests, withheld: shown.withheld + contests.length - shownContests.length,
    complete: scanned.length <= MEMORY_LIMITS.scanMax };
}
/** §6.5 bulk response: the entries derived from one Run or Attempt (current rows), through the same source filter. */
export async function memorySourceEntries(deps: MemoryJournalDependencies, store: MemoryJournalStore, principal: VerifiedPrincipal, input: unknown, visible: Visible): Promise<MemorySourceEntries> {
  const query = memorySourceQuerySchema.parse(input);
  if (!store.sourceEntryIds) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
  await assertNoPendingMemoryPurge(deps, store, query.scopeId);
  const ids = await store.sourceEntryIds(query.scopeId, query.source, query.limit + 1), entries: MemoryEntry[] = [];
  for (const id of ids.slice(0, query.limit)) {
    const entry = await store.load(query.scopeId, id);
    if (!entry || entry.scopeId !== query.scopeId) throw new MemoryJournalError('MEMORY_CORRUPT');
    entries.push(entry);
  }
  return { schemaVersion: 1, status: 'ok', scopeId: query.scopeId, ...await visible(store, principal, query.scopeId, entries), complete: ids.length <= query.limit };
}

/**
 * A9/§6.5: a person resolves one open contest — retire the contested entry, retire the candidate, or dismiss. The retirement is the journal's own
 * transition under a command id derived from this one (a retried resolution replays it); the resolution is sealed once.
 */
export async function resolveMemoryContest(deps: MemoryJournalDependencies, input: unknown, admit: Admit, retire: Retire, visible: Visible): Promise<MemoryContestResolveResult> {
  const command = memoryContestResolveCommandSchema.parse(input), { principal, authorization } = await admit('contest', command.scopeId);
  assertMemoryPerson(principal);
  let contest: MemoryContest, target: MemoryEntry | null;
  const store = await deps.openStore('read');
  try {
    if (!store.loadContest || !store.resolveContest) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
    await assertNoPendingMemoryPurge(deps, store, command.scopeId);
    const loaded = await store.loadContest(command.scopeId, command.contestId);
    if (!loaded) throw new MemoryJournalError('MEMORY_NOT_FOUND');
    if (loaded.resolution) {
      if (loaded.resolution.decision !== command.decision) throw new MemoryJournalError('MEMORY_CONTEST_RESOLVED');
      return { schemaVersion: 1, replayed: true, resolution: loaded.resolution, retired: null };
    }
    contest = loaded.contest;
    const pair = await Promise.all([contest.entryId, contest.candidateEntryId].map(id => store.load(command.scopeId, id)));
    if (pair.some(entry => !entry) || (await visible(store, principal, command.scopeId, pair as MemoryEntry[])).withheld) throw new MemoryJournalError('MEMORY_ENTRY_WITHHELD');
    target = command.decision === 'retire-contested' ? pair[0]! : command.decision === 'retire-candidate' ? pair[1]! : null;
  } finally { store.close(); }
  let retired: MemoryEntry | null = null;
  if (target && target.state !== 'retired') {
    await admit('retire', command.scopeId);
    retired = (await retire({ schemaVersion: 1, scopeId: command.scopeId, commandId: sha256(encodeCommandProjection('memory-contest-resolve:1', { commandId: command.commandId, contestId: contest.contestId })),
      entryId: target.entryId, expectedRevision: target.revision, reason: `contest-resolution/${contest.contestId}`, supersededBy: null })).entry;
  }
  const resolution = memoryContestResolutionSchema.parse({ schemaVersion: 1, contestId: contest.contestId, scopeId: command.scopeId, decision: command.decision,
    by: { issuer: principal.issuer, subject: principal.subject }, retiredEntryId: target?.entryId ?? null, atMs: deps.now() });
  const writer = await deps.openStore('write');
  try {
    const result = await writer.resolveContest!(resolution, { schemaVersion: 1, eventId: deps.eventId(), scopeId: command.scopeId, principal: { issuer: principal.issuer, subject: principal.subject },
      policyRevision: authorization.revision, atMs: resolution.atMs, subject: { kind: 'memory-contest-resolution', contestId: contest.contestId, entryId: contest.entryId,
        decision: command.decision, retiredEntryId: resolution.retiredEntryId } });
    return { schemaVersion: 1, replayed: result.replayed, resolution, retired };
  } finally { writer.close(); }
}
