import { randomUUID } from 'node:crypto';
import type { WorkClassRegistry } from '#domain/index.js';
import { AuditApplication, memoryPlanningRequest, type MemoryPlanningRow, type MemoryPlanningSelection, type PlanningMemoryNote } from '#engine/index.js';
import { memoryKeyedDigest, openLocalIntegrityAuthority, openSqliteAuditStore, selectWorkTarget } from '#adapters/index.js';
import { ErrorRegistry, getConfigKnownSecrets, SystemTrustedClock } from '#platform/index.js';
import type { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { memoryJournalFor } from './journal.js';

type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
/** The memory block the planning context carries (structurally the Brain context v3 `memory`). */
export interface PlanningMemoryBlock { readonly entries: readonly MemoryPlanningRow[]; readonly omitted: number }
/** What actually went into the prompt after the planning byte bound (`truncated`: entries that bound removed). */
export interface PlanningMemorySent { readonly entries: readonly MemoryPlanningRow[]; readonly omitted: number; readonly truncated: number }
/** One planning request's memory: `block` for the prompt (null: none), `seal` before the first prompt leaves the machine, `note` for the card. */
export interface PlanningMemory {
  readonly block: PlanningMemoryBlock | null;
  seal(sent: PlanningMemorySent | null, contextDigest: string): Promise<void>;
  note(): PlanningMemoryNote | undefined;
}
const OFF: PlanningMemory = Object.freeze({ block: null, seal: async () => undefined, note: () => undefined });
const hold = (reason: string, cause?: unknown) => ErrorRegistry.createError('BRAIN_MEMORY_CONTEXT_HELD', { params: { reason }, cause });

/**
 * S4B-6 (S4B-DESIGN rev 4 §7.2, §7.3; owner S-M7/S-M8): verified memory into the Brain's planning context under the worker's rules. Read once as
 * the requesting person through the same engine selection (scope, state, contests, staleness, source filter, registry bounds), keyed by every
 * WorkClass family of the installation registry at that family's risk and ranked by the intent's words. `memoryAutomation.context.mode` off
 * (customer default): nothing is read, opened or sealed. `shadow`: the selection is sealed and nothing is sent. `on`: the entries join the
 * context as data. A failed read or seal refuses the planning request typed (`BRAIN_MEMORY_CONTEXT_HELD`) before any model call; a policy refusal
 * or unreadable sources plan without memory, visibly. A template written for an earlier context version takes no memory (visible, no read).
 *
 * Orphan rule (s4b5 open item 2, decided here): the `brain-memory-context` event is sealed before the first provider effect, so a plan refused
 * afterwards keeps it — the memory may already have left the machine. It is marked by its binding, not by a second write that a crash could
 * skip: its `contextDigest` equals the stored proposal's contribution `contextDigest` only when the plan was recorded.
 */
export async function prepareConfiguredPlanningMemory(context: Context, request: Readonly<{ scopeId: string; runId: string; commandId: string; intent: string; takesMemory: boolean;
  workClasses: WorkClassRegistry | undefined }>): Promise<PlanningMemory> {
  const { config, layout } = context, mode = config.memoryAutomation.context.mode;
  if (mode !== 'shadow' && mode !== 'on') return OFF;
  if (!request.takesMemory) return { block: null, seal: async () => undefined, note: () => ({ mode, selected: 0, omitted: 0, withheld: 0, reason: 'template' }) };
  let selection: MemoryPlanningSelection, integrity: Awaited<ReturnType<typeof openLocalIntegrityAuthority>>;
  const scope = request.scopeId;
  try {
    integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
    selection = await (await memoryJournalFor(context, 'read', integrity)).planningContextFor(memoryPlanningRequest({ scopeId: scope, runId: request.runId,
      workTargetId: selectWorkTarget(config.execution)?.id ?? null, intent: request.intent, workClasses: request.workClasses, automation: config.memoryAutomation.overlay,
      knownSecrets: getConfigKnownSecrets(config) }));
  } catch (error) { throw hold('unavailable', error); }
  if (selection.status === 'held') throw hold(selection.code);
  if (selection.status === 'withheld') return { block: null, seal: async () => undefined, note: () => ({ mode, selected: 0, omitted: 0, withheld: 0, reason: selection.reason }) };
  const chosen = selection, block = mode === 'on' && (chosen.entries.length || chosen.omitted) ? { entries: chosen.entries, omitted: chosen.omitted } : null;
  let note: PlanningMemoryNote = { mode, selected: 0, omitted: chosen.omitted, withheld: chosen.withheld, reason: null };
  return Object.freeze({ block, note: () => note,
    async seal(sent: PlanningMemorySent | null, contextDigest: string) {
      // `on`: what the prompt carries after the planning byte bound; `shadow`: the whole selection (it is never sent).
      const kept = mode === 'on' ? new Set((sent?.entries ?? []).map(row => row.entryId)) : new Set(chosen.entries.map(row => row.entryId));
      const refs = chosen.refs.filter(row => kept.has(row.entryId)), rows = chosen.entries.filter(row => kept.has(row.entryId));
      const omitted = chosen.omitted + (mode === 'on' ? sent?.truncated ?? 0 : 0);
      note = { mode, selected: refs.length, omitted, withheld: chosen.withheld, reason: null };
      if (!refs.length) return;
      let audit;
      try {
        audit = await openSqliteAuditStore(await context.path(), config.storage.sqlite, 'forbid');
      } catch (error) { throw hold('seal', error); }
      try {
        new AuditApplication(audit, integrity).record({ schemaVersion: 1, eventId: randomUUID(), scopeId: scope, principal: { issuer: context.principal.issuer, subject: context.principal.subject },
          policyRevision: chosen.policyRevision, atMs: new SystemTrustedClock().sample().wallMs, subject: { kind: 'brain-memory-context', runId: request.runId, commandId: request.commandId,
            mode, delivered: mode === 'on', entries: refs.map(row => ({ ...row })), memoryDigest: memoryKeyedDigest(integrity)('memory-planning-context:1', { scopeId: scope, entries: rows }),
            contextDigest, omitted, withheld: chosen.withheld } });
      } catch (error) { throw hold('seal', error); } finally { audit.close(); }
    } });
}
