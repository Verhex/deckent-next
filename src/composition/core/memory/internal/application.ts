import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { MemoryJournalApplication, MemoryPolicyAuthorization, memoryInspectQuerySchema as inspect, memoryListQuerySchema as list, memoryProposeCommandSchema as propose,
  memoryRetireCommandSchema as retire, memorySearchQuerySchema as search, memoryVerifyCommandSchema as verify, assertAuthorityWitness, MemoryJournalError, type AuthorityWitness } from '#engine/index.js';
import { openSqliteMemoryJournalStore, memoryKeyedDigest, openLocalIntegrityAuthority, attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer } from '#adapters/index.js';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
const schemas = { inspect, list, search, propose, verify, retire };
/** S4 memory journal v1 on the Core SQLite adapter. Reads never create a key, database or migration; no evaluation resolver is wired (fail closed).
 * S4B-1: keyed digests under the integrity key; list/search/inspect apply the source filter (§7.4) through the same policy document.
 * Verify and retire are a person's terminal act (lead 2026-10-23): the MCP actor, or a caller without the terminal witness, is refused before any read. */
const bind = <A extends keyof typeof schemas>(action: A) => async (root: string, input: unknown, options: ConfigLoadOptions = {},
  witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }): Promise<Awaited<ReturnType<MemoryJournalApplication[A]>>> => {
  try {
    if (action === 'verify' || action === 'retire') await assertAuthorityWitness(`memory.${action}`, localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), witness);
    const parsed = schemas[action].parse(input), mode = ['inspect', 'list', 'search'].includes(action) ? 'read' : 'write', clock = new SystemTrustedClock();
    const context = await loadConfiguredScopeContext(root, parsed.scopeId, { ...options, heal: false }, mode), { layout, config } = context;
    const source = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes), policy = new MemoryPolicyAuthorization(source);
    // A write opens (or creates) the key first; a read opens it inside the store, so a missing key is a typed hold, never an empty answer.
    const integrity = mode === 'write' ? await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true) : null;
    return await new MemoryJournalApplication({ verifier: { verify: async () => context.principal }, authorize: (...args) => policy.authorize(...args), readFilter: (...args) => policy.readFilter(...args),
      openStore: async access => openSqliteMemoryJournalStore(await context.path(), config.storage.sqlite, integrity ?? await openLocalIntegrityAuthority(layout, config.approvals.keyFile, false), access),
      keyedDigest: integrity ? memoryKeyedDigest(integrity) : () => { throw new MemoryJournalError('MEMORY_UNAVAILABLE'); },
      automation: config.memoryAutomation.overlay, now: () => clock.sample().wallMs, eventId: randomUUID })[action](parsed) as Awaited<ReturnType<MemoryJournalApplication[A]>>;
  } catch (error) { throw queryFailure(error); }
};
export const inspectConfiguredMemory = bind('inspect'), listConfiguredMemory = bind('list'), searchConfiguredMemory = bind('search');
export const proposeConfiguredMemory = bind('propose'), verifyConfiguredMemory = bind('verify'), retireConfiguredMemory = bind('retire');
