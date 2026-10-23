import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AUDIT_EVENT_SCHEMA_VERSION, DISPATCH_PREPARATION_PHASES, attemptIdentitySchema, counterSchema, identitySchema, sameAttemptIdentity,
  type AttemptIdentity, type AuditEvent, type RunSnapshot } from '#domain/index.js';
import { ErrorRegistry, type JsonRecordFile } from '#platform/index.js';
import { DispatchError } from './port.js';

export type DispatchPreparationPhase = (typeof DISPATCH_PREPARATION_PHASES)[number];
const phaseSchema = z.enum(DISPATCH_PREPARATION_PHASES), instanceSchema = z.object({ id: z.string().uuid(), pid: counterSchema, startedAt: counterSchema }).strict();
/** v1 per-Attempt dispatch preparation record: one product-directory file written atomically before workspace acquisition (no ledger table,
 * no migration). Present without `park` = a preparation began in `instance` and was not settled. `park` holds this Attempt at the bound until
 * a resume is observed: `own` names the progression park command this guard sent, `joined` the Run revision at which another Attempt's
 * breaker park was found holding the Run. `starts` and `lastAbort` are evidence only. */
export const dispatchPreparationRecordSchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema, instance: instanceSchema,
  starts: counterSchema, aborts: counterSchema, phase: phaseSchema, at: counterSchema,
  lastAbort: z.object({ phase: phaseSchema.nullable(), instanceId: z.string().uuid().nullable(), at: counterSchema }).strict().nullable(),
  park: z.discriminatedUnion('kind', [z.object({ kind: z.literal('own'), commandId: identitySchema, at: counterSchema }).strict(),
    z.object({ kind: z.literal('joined'), revision: counterSchema, at: counterSchema }).strict()]).nullable() }).strict();
export type DispatchPreparationRecord = z.infer<typeof dispatchPreparationRecordSchema>;
/** S6R-1 (design §2 F6) v1 launcher evidence: what a claimed settle found before clearing the preparation record — the launcher instance and
 * phase a process left while its worker ran (`record`), or an unreadable/foreign record (`unreadable`). Written once per Attempt in its own
 * product-directory record (no ledger); evidence only: it never decides liveness, fencing or release (the S6R-2 detector does). */
export const dispatchLauncherEvidenceSchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  launcher: z.discriminatedUnion('kind', [z.object({ kind: z.literal('record'), instance: instanceSchema, phase: phaseSchema, at: counterSchema,
    starts: counterSchema, aborts: counterSchema }).strict(), z.object({ kind: z.literal('unreadable') }).strict()]),
  capturedBy: instanceSchema, capturedAt: counterSchema }).strict();
export type DispatchLauncherEvidence = z.infer<typeof dispatchLauncherEvidenceSchema>;
const recordName = (identity: AttemptIdentity) => createHash('sha256').update(JSON.stringify(attemptIdentitySchema.parse(identity))).digest('hex');
/** The captured launcher evidence of one Attempt, or null when none was captured. An unparsable or foreign record is refused, never empty. */
export async function readDispatchLauncherEvidence(records: (name: string) => JsonRecordFile, identity: AttemptIdentity): Promise<DispatchLauncherEvidence | null> {
  const read = await records(recordName(identity)).read();
  if (read.kind === 'absent') return null;
  if (read.kind === 'io') throw read.error;
  const parsed = read.kind === 'ready' ? dispatchLauncherEvidenceSchema.safeParse(read.value) : null;
  if (!parsed?.success || !sameAttemptIdentity(parsed.data.identity, identity)) throw new DispatchError('DISPATCH_CORRUPT');
  return parsed.data;
}
/** S6R-2: the preparation record a launcher left for one Attempt (read-only; null when none), or `unreadable` for an unparsable or foreign record. */
export async function readDispatchPreparationRecord(records: (name: string) => JsonRecordFile, identity: AttemptIdentity): Promise<DispatchPreparationRecord | 'unreadable' | null> {
  const read = await records(recordName(identity)).read();
  if (read.kind === 'absent') return null;
  if (read.kind === 'io') throw read.error;
  const parsed = read.kind === 'ready' ? dispatchPreparationRecordSchema.safeParse(read.value) : null;
  return parsed?.success && sameAttemptIdentity(parsed.data.identity, identity) ? parsed.data : 'unreadable';
}
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
  /** S6R-1: where a claimed settle keeps the launcher evidence before clearing the preparation record (same naming as the records port). */
  readonly launchers: (name: string) => JsonRecordFile;
  /** Core audit. No audit, no count: a failure is thrown before the record changes, so the next start counts (and records) again. */
  readonly record: (event: AuditEvent) => Promise<unknown>;
  /** Whether the ledger holds the receipt of this park command (it committed). */
  readonly parked: (commandId: string) => Promise<boolean>;
  /** The Run as it is now (after a park that did not commit: did another Attempt's breaker park it first?). */
  readonly loadRun: () => Promise<RunSnapshot | null>;
  /** The existing progression park (`progression-failed`, failure code DISPATCH_PREPARATION_ABORTED, the operator resumes it explicitly). */
  readonly park: (command: DispatchPreparationPark) => Promise<unknown>;
}

/**
 * Crash-loop breaker (pilot1 2026-10-17, owner-approved before beta). A native abort during dispatch preparation leaves no ledger trace, so
 * a restarted service prepared the same reserved Attempt again and died again. This guard keeps one durable record per Attempt:
 * `begin` writes it before workspace acquisition, `enter` names each later phase, and `settle` removes it whenever the preparation ends in
 * this process (dispatch claimed and run, gate refusal recorded, prevented-before-launch, any typed refusal). Only a process death leaves it
 * unsettled. The next `begin` in another instance counts that as one abnormal end (audited with the last phase); at the bound it parks the
 * Run through the existing progression park and refuses with DISPATCH_PREPARATION_ABORTED instead of preparing again. Several Attempts of one
 * Run may trip together: the first park holds the Run and the others join it (one park, one resume releases all). Any other failed park
 * changes nothing but the refusal: the record keeps its park command, so no later start dispatches until the park commits. Once the Run is
 * no longer in this breaker park (an explicit operator resume), the count starts from zero.
 */
export class DispatchPreparationGuard {
  private readonly file: JsonRecordFile;
  private readonly launcher: JsonRecordFile;
  private readonly instance: DispatchPreparationInstance;
  private current: DispatchPreparationRecord | null = null;
  constructor(records: (name: string) => JsonRecordFile, private readonly context: DispatchPreparationContext) {
    z.number().int().positive().safe().parse(context.bound);
    this.file = records(recordName(context.identity)); this.launcher = context.launchers(recordName(context.identity));
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
  /** Leaving a progression park takes an explicit operator transition; while this one holds, nothing starts. */
  private static holds(run: RunSnapshot) {
    return run.state.kind === 'parked' && run.state.reason === 'progression-failed' && run.state.failureCode === 'DISPATCH_PREPARATION_ABORTED';
  }
  private refusal(aborts: number, lastAbort: DispatchPreparationRecord['lastAbort']) {
    const { identity, bound } = this.context;
    return ErrorRegistry.createError('DISPATCH_PREPARATION_ABORTED', { params: { task: identity.taskId, attempt: identity.attemptId, phase: lastAbort?.phase ?? 'unknown', aborts, bound } });
  }
  /** Before workspace acquisition, after the caller found no dispatch claim for this Attempt and loaded its Run. */
  async begin(run: RunSnapshot): Promise<void> {
    const { identity, principal, bound, now } = this.context, { prior, invalid } = await this.load();
    let aborts = prior?.aborts ?? 0, lastAbort = prior?.lastAbort ?? null, park = prior?.park ?? null;
    if (park && (park.kind === 'joined' || await this.context.parked(park.commandId))) {
      if (DispatchPreparationGuard.holds(run)) throw this.refusal(aborts, lastAbort);
      aborts = 0; lastAbort = null; park = null;
    } else if (invalid || (prior && !park && prior.instance.id !== this.instance.id)) {
      aborts++; lastAbort = { phase: prior?.phase ?? null, instanceId: prior?.instance.id ?? null, at: prior?.at ?? now() };
      await this.context.record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: identity.scopeId,
        principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: this.context.policyRevision, atMs: now(),
        subject: { kind: 'dispatch-preparation-aborted', runId: identity.runId, taskId: identity.taskId, attemptId: identity.attemptId, phase: lastAbort.phase, aborts, bound } });
    }
    const base = { schemaVersion: 1 as const, identity, instance: this.instance, starts: prior?.starts ?? 0, aborts, at: now(), lastAbort };
    if (aborts >= bound) {
      const hold = (marker: NonNullable<DispatchPreparationRecord['park']>) => this.file.write(dispatchPreparationRecordSchema.parse({ ...base, phase: prior?.phase ?? 'prepare', park: marker }));
      if (DispatchPreparationGuard.holds(run)) { await hold({ kind: 'joined', revision: run.revision, at: now() }); throw this.refusal(aborts, lastAbort); }
      // The park command is durable before it is sent: a conflict, denial or crash retries the same command, never a dispatch.
      const own = park?.kind === 'own' ? park : { kind: 'own' as const, commandId: randomUUID(), at: now() };
      await hold(own);
      try {
        await this.context.park({ schemaVersion: 1, scopeId: identity.scopeId, runId: identity.runId, commandId: own.commandId, expectedRevision: run.revision, failureCode: 'DISPATCH_PREPARATION_ABORTED' });
      } catch (error) {
        const current = await this.context.loadRun().catch(() => null);
        if (!current || !DispatchPreparationGuard.holds(current)) throw error;
        await hold({ kind: 'joined', revision: current.revision, at: now() });
      }
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
    // S6R-1: a claimed settle of a record this guard did not write keeps it as launcher evidence first; if that write fails nothing is cleared.
    if (claimed && !this.current) await this.captureLauncher();
    this.current = null; await this.file.remove().catch(() => undefined);
  }
  private async captureLauncher(): Promise<void> {
    const { prior, invalid } = await this.load();
    if (!prior && !invalid) return;
    const kept = await this.launcher.read();
    if (kept.kind === 'io') throw kept.error;
    if (kept.kind !== 'absent') return; // The first capture stays as written; it is never replaced.
    const { identity, now } = this.context;
    await this.launcher.write(dispatchLauncherEvidenceSchema.parse({ schemaVersion: 1, identity, capturedBy: this.instance, capturedAt: now(),
      launcher: prior ? { kind: 'record', instance: prior.instance, phase: prior.phase, at: prior.at, starts: prior.starts, aborts: prior.aborts } : { kind: 'unreadable' } }));
  }
}
