import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { MemoryJournalApplication, MemoryPolicyAuthorization, memoryInspectQuerySchema as inspect, memoryListQuerySchema as list, memoryProposeCommandSchema as propose,
  memoryRetireCommandSchema as retire, memorySearchQuerySchema as search, memoryVerifyCommandSchema as verify } from '#engine/index.js';
import { openSqliteMemoryJournalStore, openLocalIntegrityAuthority } from '#adapters/index.js';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
const schemas = { inspect, list, search, propose, verify, retire };
/** S4 memory journal v1 on the Core SQLite adapter. Reads never create a key, database or migration; no evaluation resolver is wired (fail closed). */
const bind = <A extends keyof typeof schemas>(action: A) => async (root: string, input: unknown, options: ConfigLoadOptions = {}): Promise<Awaited<ReturnType<MemoryJournalApplication[A]>>> => {
  try {
    const parsed = schemas[action].parse(input), mode = ['inspect', 'list', 'search'].includes(action) ? 'read' : 'write', clock = new SystemTrustedClock();
    const context = await loadConfiguredScopeContext(root, parsed.scopeId, { ...options, heal: false }, mode), { layout, config } = context;
    const source = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes);
    return await new MemoryJournalApplication({ verifier: { verify: async () => context.principal }, authorize: (...args) => new MemoryPolicyAuthorization(source).authorize(...args),
      openStore: async access => openSqliteMemoryJournalStore(await context.path(), config.storage.sqlite, await openLocalIntegrityAuthority(layout, config.approvals.keyFile, access === 'write'), access),
      now: () => clock.sample().wallMs, eventId: randomUUID })[action](parsed) as Awaited<ReturnType<MemoryJournalApplication[A]>>;
  } catch (error) { throw queryFailure(error); }
};
export const inspectConfiguredMemory = bind('inspect'), listConfiguredMemory = bind('list'), searchConfiguredMemory = bind('search');
export const proposeConfiguredMemory = bind('propose'), verifyConfiguredMemory = bind('verify'), retireConfiguredMemory = bind('retire');
