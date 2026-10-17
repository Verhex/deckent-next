import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AUDIT_EVENT_SCHEMA_VERSION, DISPATCH_PREPARATION_PHASES, attemptIdentitySchema, counterSchema, identitySchema, sameAttemptIdentity,
  type AttemptIdentity, type AuditEvent, type RunSnapshot } from '#domain/index.js';
import { ErrorRegistry, type JsonRecordFile } from '#platform/index.js';

export type DispatchPreparationPhase = (typeof DISPATCH_PREPARATION_PHASES)[number];
const phaseSchema = z.enum(DISPATCH_PREPARATION_PHASES), instanceSchema = z.object({ id: z.string().uuid(), pid: counterSchema, startedAt: counterSchema }).strict();
/** v1 per-Attempt dispatch preparation record: one product-directory file written atomically before workspace acquisition (no ledger table,
 * no migration). Present without `park` = a preparation began in `instance` and was not settled; `park` names the progression park this
 * breaker committed at the bound and stays until a resume of that park is observed. `starts` and `lastAbort` are evidence only. */
export const dispatchPreparationRecordSchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema, instance: instanceSchema,
  starts: counterSchema, aborts: counterSchema, phase: phaseSchema, at: counterSchema,
  lastAbort: z.object({ phase: phaseSchema.nullable(), instanceId: z.string().uuid().nullable(), at: counterSchema }).strict().nullable(),
  park: z.object({ commandId: identitySchema, at: counterSchema }).strict().nullable() }).strict();
export type DispatchPreparationRecord = z.infer<typeof dispatchPreparationRecordSchema>;
export type DispatchPreparationInstance = z.infer<typeof instanceSchema>;
/** This process. In the runtime service one start is one instance: a record another instance never settled means that process died in it. */
export const DISPATCH_PREPARATION_INSTANCE: DispatchPreparationInstance = Object.freeze({ id: randomUUID(), pid: process.pid, startedAt: Date.now() });
export type DispatchPreparationPark = Readonly<{ schemaVersion: 1; scopeId: string; runId: string; commandId: string; expectedRevision: number; failureCode: 'DISPATCH_PREPARATION_ABORTED' }>;
export interface DispatchPreparationContext {
  readonly identity: AttemptIdentity;
  readonly principal: Readonly<{ issuer: string; subject: string }>;
  readonly policyRevision: string;
  /** `runRuntime.maxPreparationAborts`: abnormal ends counted before the Run is parked instead of dispatched. */
  readonly bound: number;
  readonly now: () => number;
  readonly instance?: DispatchPreparationInstance;
  /** Core audit. No audit, no count: a failure is thrown before the record changes, so the next start counts (and records) again. */
  readonly record: (event: AuditEvent) => Promise<unknown>;
  /** Whether the ledger holds the receipt of this park command (it committed). */
  readonly parked: (commandId: string) => Promise<boolean>;
  /** The existing progression park (`progression-failed`, failure code DISPATCH_PREPARATION_ABORTED, the operator resumes it explicitly). */
  readonly park: (command: DispatchPreparationPark) => Promise<unknown>;
}

/**
 * Crash-loop breaker (pilot1 2026-10-17, owner-approved before beta). A native abort during dispatch preparation leaves no ledger trace, so
 * a restarted service prepared the same reserved Attempt again and died again. This guard keeps one durable record per Attempt:
 * `begin` writes it before workspace acquisition, `enter` names each later phase, and `settle` removes it whenever the preparation ends in
 * this process (dispatch claimed and run, gate refusal recorded, prevented-before-launch, any typed refusal). Only a process death leaves it
 * unsettled. The next `begin` in another instance counts that as one abnormal end (audited with the last phase); at the bound it parks the
 * Run through the existing progression park and refuses with DISPATCH_PREPARATION_ABORTED instead of preparing again. A failed or
 * conflicting park changes nothing but the refusal: the record keeps its park command, so no later start dispatches until the park commits
 * and an explicit resume of it is observed (the Run is no longer parked `progression-failed`); the count then starts from zero.
 */
export class DispatchPreparationGuard {
  private readonly file: JsonRecordFile;
  private readonly instance: DispatchPreparationInstance;
  private current: DispatchPreparationRecord | null = null;
  constructor(records: (name: string) => JsonRecordFile, private readonly context: DispatchPreparationContext) {
    z.number().int().positive().safe().parse(context.bound);
    this.file = records(createHash('sha256').update(JSON.stringify(attemptIdentitySchema.parse(context.identity))).digest('hex'));
    this.instance = context.instance ?? DISPATCH_PREPARATION_INSTANCE;
  }
  /** An unreadable or foreign record is never trusted as a clean slate: it counts as one abnormal end of an unknown phase. */
  private async load(): Promise<{ prior: DispatchPreparationRecord | null; invalid: boolean }> {
    const read = await this.file.read();
    if (read.kind === 'absent') return { prior: null, invalid: false };
    if (read.kind === 'io') throw read.error;
    const parsed = read.kind === 'ready' ? dispatchPreparationRecordSchema.safeParse(read.value) : null;
    return parsed?.success && sameAttemptIdentity(parsed.data.identity, this.context.identity) ? { prior: parsed.data, invalid: false } : { prior: null, invalid: true };
  }
  private refusal(aborts: number, lastAbort: DispatchPreparationRecord['lastAbort']) {
    const { identity, bound } = this.context;
    return ErrorRegistry.createError('DISPATCH_PREPARATION_ABORTED', { params: { task: identity.taskId, attempt: identity.attemptId, phase: lastAbort?.phase ?? 'unknown', aborts, bound } });
  }
  /** Before workspace acquisition, after the caller found no dispatch claim for this Attempt and loaded its Run. */
  async begin(run: RunSnapshot): Promise<void> {
    const { identity, principal, bound, now } = this.context, { prior, invalid } = await this.load();
    let aborts = prior?.aborts ?? 0, lastAbort = prior?.lastAbort ?? null, park = prior?.park ?? null;
    if (park && await this.context.parked(park.commandId)) {
      // Leaving a progression park takes an explicit operator transition; while it holds (a direct execute), nothing starts.
      if (run.state.kind === 'parked' && run.state.reason === 'progression-failed') throw this.refusal(aborts, lastAbort);
      aborts = 0; lastAbort = null; park = null;
    } else if (invalid || (prior && !park && prior.instance.id !== this.instance.id)) {
      aborts++; lastAbort = { phase: prior?.phase ?? null, instanceId: prior?.instance.id ?? null, at: prior?.at ?? now() };
      await this.context.record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: identity.scopeId,
        principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: this.context.policyRevision, atMs: now(),
        subject: { kind: 'dispatch-preparation-aborted', runId: identity.runId, taskId: identity.taskId, attemptId: identity.attemptId, phase: lastAbort.phase, aborts, bound } });
    }
    const base = { schemaVersion: 1 as const, identity, instance: this.instance, starts: prior?.starts ?? 0, aborts, at: now(), lastAbort };
    if (aborts >= bound) {
      // The park command is durable before it is sent: a conflict, denial or crash retries the same command, never a dispatch.
      park ??= { commandId: randomUUID(), at: now() };
      await this.file.write(dispatchPreparationRecordSchema.parse({ ...base, phase: prior?.phase ?? 'prepare', park }));
      await this.context.park({ schemaVersion: 1, scopeId: identity.scopeId, runId: identity.runId, commandId: park.commandId, expectedRevision: run.revision, failureCode: 'DISPATCH_PREPARATION_ABORTED' });
      throw this.refusal(aborts, lastAbort);
    }
    const started = dispatchPreparationRecordSchema.parse({ ...base, starts: base.starts + 1, phase: 'prepare', park: null });
    await this.file.write(started); this.current = started;
  }
  /** Names the phase this preparation enters next; durable before the phase starts. */
  async enter(phase: DispatchPreparationPhase): Promise<void> {
    if (!this.current) return;
    const next = { ...this.current, phase, at: this.context.now() };
    await this.file.write(next); this.current = next;
  }
  /** The preparation ended in this process (any outcome but a refusal at the bound), or `claimed`: a dispatch claim already exists, so a
   * record a process death left after its claim is cleared, never counted. A failed removal is not thrown: it can only over-count later. */
  async settle(claimed = false): Promise<void> {
    if (!this.current && !claimed) return;
    this.current = null; await this.file.remove().catch(() => undefined);
  }
}
