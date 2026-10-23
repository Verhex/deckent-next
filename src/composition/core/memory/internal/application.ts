import { MemoryJournalApplication, memoryInspectQuerySchema as inspect, memoryListQuerySchema as list, memoryProposeCommandSchema as propose,
  memoryRetireCommandSchema as retire, memorySearchQuerySchema as search, memoryVerifyCommandSchema as verify, memoryReviewQuerySchema as review, memorySourceQuerySchema as sourceEntries,
  memoryPurgeCommandSchema as purge, memoryContestResolveCommandSchema as resolveContest, assertAuthorityWitness, type AuthorityWitness } from '#engine/index.js';
import { attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { memoryJournalFor } from './journal.js';
const schemas = { inspect, list, search, review, sourceEntries, propose, verify, retire, purge, resolveContest };
const READS: readonly string[] = ['inspect', 'list', 'search', 'review', 'sourceEntries'];
/** A person's terminal act (lead 2026-10-23; S4B-4 A11): the MCP actor, or a caller without the terminal witness, is refused before any read. */
const WITNESSED: readonly string[] = ['verify', 'retire', 'purge', 'resolveContest'];
/** S4 memory journal v1 on the Core SQLite adapter. Reads never create a key, database or migration; no evaluation resolver is wired (fail closed).
 * S4B-1: keyed digests under the integrity key; list/search/inspect apply the source filter (§7.4) through the same policy document. S4B-4: the
 * review card, source lists, purge and contest resolution; a person's write first re-applies the purges the journal holds and the ledger lacks. */
const bind = <A extends keyof typeof schemas>(action: A) => async (root: string, input: unknown, options: ConfigLoadOptions = {},
  witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }): Promise<Awaited<ReturnType<MemoryJournalApplication[A]>>> => {
  try {
    if (WITNESSED.includes(action)) await assertAuthorityWitness(`memory.${action}`, localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), witness);
    const parsed = schemas[action].parse(input), mode = READS.includes(action) ? 'read' : 'write';
    const context = await loadConfiguredScopeContext(root, parsed.scopeId, { ...options, heal: false }, mode), journal = await memoryJournalFor(context, mode);
    if (mode === 'write') await journal.replayPurges(parsed.scopeId, undefined, { pendingOnly: true });
    return await (journal[action] as (value: unknown) => Promise<unknown>).call(journal, parsed) as Awaited<ReturnType<MemoryJournalApplication[A]>>;
  } catch (error) { throw queryFailure(error); }
};
export const inspectConfiguredMemory = bind('inspect'), listConfiguredMemory = bind('list'), searchConfiguredMemory = bind('search');
export const proposeConfiguredMemory = bind('propose'), verifyConfiguredMemory = bind('verify'), retireConfiguredMemory = bind('retire');
export const reviewConfiguredMemory = bind('review'), listConfiguredMemorySource = bind('sourceEntries'), purgeConfiguredMemory = bind('purge'),
  resolveConfiguredMemoryContest = bind('resolveContest');
