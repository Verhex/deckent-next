import { randomUUID } from 'node:crypto';
import { executionRegistrySchema, type ExecutionProfileDefinition } from '#domain/index.js';
import { AuditApplication, MemoryJournalApplication, MemoryPolicyAuthorization, memoryContextTasks, type AuditStore, type MemoryContextTaskPart, type RunAdmissionContext,
  type WorkerAdmissionWarning } from '#engine/index.js';
import { memoryKeyedDigest, openSqliteMemoryJournalStore, selectWorkTarget } from '#adapters/index.js';
import { ErrorRegistry, getConfigKnownSecrets, SystemTrustedClock, type IntegrityAuthority } from '#platform/index.js';
import { memoryPurgeJournalOf } from '#composition/core/memory/index.js';
import type { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';

type ScopeContext = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
type Part = Readonly<{ id: string; version: number; text: string }>;
type Withheld = Extract<WorkerAdmissionWarning, { code: 'MEMORY_CONTEXT_WITHHELD' }>;
/** The admission's memory hook: `wrap` reads and seals around the admission resolve, `compile` adds a task's part to its prompt, `warnings` the visible caveats. */
export interface MemoryContextHook {
  wrap(inner: RunAdmissionContext): RunAdmissionContext;
  compile(taskId: string | undefined, build: (extra: readonly Part[]) => ExecutionProfileDefinition): ExecutionProfileDefinition;
  warnings(): readonly WorkerAdmissionWarning[];
}
/** `memoryAutomation.context.mode` off (customer default): nothing is read, opened or sealed. */
const OFF: MemoryContextHook = Object.freeze({ wrap: (inner: RunAdmissionContext) => inner, compile: (_taskId: string | undefined, build: (extra: readonly Part[]) => ExecutionProfileDefinition) => build([]),
  warnings: () => [] });

/**
 * S4B-5 (S4B-DESIGN rev 4 §7.1, §7.3; owner S-M6/S-M8/S-M9): verified memory into the worker prompt, frozen at Run admission. Before the
 * admission resolves its execution, one read as the admitting principal selects each work-input task's part (its WorkClass family and risk from
 * the installation registry, the Run's work target, the task's words); after every task compiled and before the Run is created, one
 * `memory-context` event per task with a part is sealed (keyed digests only). `shadow` seals what would be sent and sends nothing; `on` sends
 * the part when the prompt has room (otherwise it is left out with a warning, never another part and never the Run). A failed read or seal
 * holds the Run (`MEMORY_CONTEXT_HELD`); a policy refusal or an unreadable source is a visible warning. A replayed admission never reaches this.
 */
export function prepareMemoryContext(context: ScopeContext, sealing: { readonly audit: AuditStore; readonly integrity: IntegrityAuthority }): MemoryContextHook {
  const { config, layout } = context, mode = config.memoryAutomation.context.mode;
  if (mode !== 'shadow' && mode !== 'on') return OFF;
  const clock = new SystemTrustedClock(), hold = (reason: string, cause?: unknown) => ErrorRegistry.createError('MEMORY_CONTEXT_HELD', { params: { reason }, cause });
  let parts = new Map<string, MemoryContextTaskPart>(), fits = new Map<string, boolean>(), notes: Withheld[] = [];
  const workClasses = () => config.admission ? executionRegistrySchema.parse(config.admission.registry).workClasses : undefined;
  const select = async (admitted: Parameters<RunAdmissionContext['resolve']>[0], principal: Parameters<RunAdmissionContext['resolve']>[1]) => {
    const tasks = memoryContextTasks(admitted.graph, workClasses(), config.memoryAutomation.overlay);
    if (!tasks.length) return null;
    const policy = new MemoryPolicyAuthorization({ async load() { return context.document; } }), path = await context.path();
    const journal = new MemoryJournalApplication({ verifier: { verify: async () => principal }, authorize: (...args) => policy.authorize(...args), readFilter: (...args) => policy.readFilter(...args),
      openStore: async access => openSqliteMemoryJournalStore(path, config.storage.sqlite, sealing.integrity, access), keyedDigest: memoryKeyedDigest(sealing.integrity),
      purgeJournal: memoryPurgeJournalOf(layout, async () => sealing.integrity), automation: config.memoryAutomation.overlay, knownSecrets: getConfigKnownSecrets(config),
      now: () => clock.sample().wallMs, eventId: randomUUID });
    return journal.contextFor({ scopeId: admitted.scopeId, runId: admitted.runId, workTargetId: selectWorkTarget(config.execution)?.id ?? null, tasks });
  };
  const seal = (admitted: Parameters<RunAdmissionContext['resolve']>[0], principal: Parameters<RunAdmissionContext['resolve']>[1], policyRevision: string) => {
    const audit = new AuditApplication(sealing.audit, sealing.integrity);
    for (const task of parts.values()) {
      if (!task.part || !task.partDigest || !fits.has(task.taskId)) continue; // a task the compiler never built (no native prompt) carries nothing
      const delivered = mode === 'on' && fits.get(task.taskId) === true;
      if (mode === 'on' && !delivered) notes.push({ code: 'MEMORY_CONTEXT_WITHHELD', taskId: task.taskId, reason: 'budget', count: task.entries.length });
      try {
        audit.record({ schemaVersion: 1, eventId: randomUUID(), scopeId: admitted.scopeId, principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision,
          atMs: clock.sample().wallMs, subject: { kind: 'memory-context', runId: admitted.runId, taskId: task.taskId, mode, delivered,
            entries: task.entries.map(row => ({ ...row })), partDigest: task.partDigest, withheld: task.withheld } });
      } catch (error) { throw hold('seal', error); }
    }
  };
  return Object.freeze({
    wrap: (inner: RunAdmissionContext): RunAdmissionContext => ({ async resolve(admitted, principal) {
      parts = new Map(); fits = new Map(); notes = [];
      let selection;
      try { selection = await select(admitted, principal); } catch (error) { throw hold('unavailable', error); }
      if (!selection) return inner.resolve(admitted, principal);
      if (selection.status === 'held') throw hold(selection.code);
      if (selection.status === 'withheld') notes.push({ code: 'MEMORY_CONTEXT_WITHHELD', taskId: null, reason: selection.reason, count: 0 });
      else for (const task of selection.tasks) {
        parts.set(task.taskId, task);
        if (task.withheld) notes.push({ code: 'MEMORY_CONTEXT_WITHHELD', taskId: task.taskId, reason: 'sources', count: task.withheld });
      }
      const resolved = await inner.resolve(admitted, principal);
      if (selection.status === 'ok') seal(admitted, principal, selection.policyRevision);
      return resolved;
    } }),
    compile(taskId: string | undefined, build: (extra: readonly Part[]) => ExecutionProfileDefinition) {
      const part = taskId ? parts.get(taskId)?.part : null;
      if (!taskId || !part) return build([]);
      // The part is tried last: a prompt without room for it keeps every other part, and memory alone never refuses a Run.
      let profile: ExecutionProfileDefinition | null;
      try { profile = build([part]); } catch { profile = null; }
      fits.set(taskId, profile !== null);
      return mode === 'on' && profile ? profile : build([]);
    },
    warnings: () => [...notes],
  });
}
