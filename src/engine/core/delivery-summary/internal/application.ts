import { z } from 'zod';
import { attemptIdentitySchema, identitySchema, readWorkerFinalReport, sameAttemptIdentity, type AttemptIdentity, type VerifiedPrincipal,
  type WorkerFinalReportResult } from '#domain/index.js';
import type { KnownSecretSnapshot } from '#platform/index.js';
import { parseRetainedOutputEnvelope, type DispatchIdentityAuthorization, type RunBoundDispatchStore } from '#engine/core/dispatch/index.js';
import { describeAttemptWorkerModels, WorkerObservationError, type WorkerEventArtifacts, type WorkerEventLogStore } from '#engine/core/worker-observation/index.js';
import { RunStoreError, type RunAuthorization, type RunStore } from '#engine/core/runs/index.js';
import { deliverySummaryOperationSchema, type DeliveryChangeFacts, type DeliverySummary } from './contract.js';
import { projectDeliverySummary } from './projector.js';

/** What the caller already knows about the card: operation, the target as its adapter registered it, and the system verification Run if any. */
export const deliverySummaryRequestSchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema, operation: deliverySummaryOperationSchema,
  target: z.object({ id: z.string().min(1).max(4096), protected: z.boolean().nullable() }).strict().nullable(),
  verificationRunId: identitySchema.nullable(), topPaths: z.number().int().nonnegative().safe().optional() }).strict().readonly();
export type DeliverySummaryRequest = z.infer<typeof deliverySummaryRequestSchema>;
/** The target adapter's change filler; null = no change evidence. A policy refusal it throws becomes `withheld`. */
export type DeliveryChangeSource = (identity: AttemptIdentity, principal: VerifiedPrincipal) => Promise<DeliveryChangeFacts | null>;
export interface DeliverySummaryPorts {
  readonly store: Pick<RunStore, 'loadRun'> & Pick<RunBoundDispatchStore, 'loadBoundDispatch'> & Pick<WorkerEventLogStore, 'loadWorkerEventLog'>;
  readonly artifacts: WorkerEventArtifacts;
  readonly runs: RunAuthorization; readonly attempts: DispatchIdentityAuthorization;
  readonly change?: DeliveryChangeSource; readonly known?: KnownSecretSnapshot;
}
const denied = (error: unknown) => !!error && typeof error === 'object' && 'code' in error
  && ['POLICY_DENIED', 'POLICY_APPROVAL_UNSUPPORTED', 'APPROVAL_DENIED'].includes(String(error.code));
async function readable(check: () => Promise<void>): Promise<boolean> {
  try { await check(); return true; } catch (error) { if (denied(error)) return false; throw error; }
}

/**
 * One owner of the DeliverySummary read (TESLIM-KARTI-OZET). Reads only what the principal may read: Run `inspect` (refused = no summary),
 * Attempt `read-output` (refused = claim, checks and model `withheld`), the verification Run's `inspect` (refused = `withheld`).
 * No write, transition, consent or audit; the result is a view, never authority.
 */
export class DeliverySummaryApplication {
  constructor(private readonly ports: DeliverySummaryPorts) {}
  /** Null when the Run or this exact Attempt binding does not exist (as `run inspect` answers a missing Run). */
  async describe(input: DeliverySummaryRequest, principal: VerifiedPrincipal): Promise<DeliverySummary | null> {
    const request = deliverySummaryRequestSchema.parse(input), identity = request.identity, { store } = this.ports;
    await this.ports.runs.authorize('inspect', { schemaVersion: 1, scopeId: identity.scopeId, runId: identity.runId }, principal);
    const run = await store.loadRun(identity.scopeId, identity.runId);
    if (!run) return null;
    if (run.identity.scopeId !== identity.scopeId || run.identity.runId !== identity.runId) throw new RunStoreError('RUN_STORE_CORRUPT');
    if (!run.bindings.some(row => sameAttemptIdentity(row.identity, identity))) return null;
    const output = await readable(() => this.ports.attempts.authorizeIdentity('read-output', identity, principal));
    const report = output ? await this.report(identity) : 'withheld' as const;
    let model: Awaited<ReturnType<typeof describeAttemptWorkerModels>> | 'withheld' = 'withheld';
    if (output) {
      try { model = await describeAttemptWorkerModels(run, identity, store, this.ports.artifacts); }
      catch (error) { if (!(error instanceof WorkerObservationError)) throw error; model = null; }
    }
    let verification: { runId: string; run: Awaited<ReturnType<typeof store.loadRun>> } | 'withheld' | null = null;
    if (request.verificationRunId !== null) {
      const query = { schemaVersion: 1 as const, scopeId: identity.scopeId, runId: request.verificationRunId };
      verification = await readable(() => this.ports.runs.authorize('inspect', query, principal))
        ? { runId: request.verificationRunId, run: await store.loadRun(identity.scopeId, request.verificationRunId) } : 'withheld';
    }
    let change: DeliveryChangeFacts | 'withheld' | null = null;
    if (this.ports.change) {
      try { change = await this.ports.change(identity, principal); } catch (error) { if (!denied(error)) throw error; change = 'withheld'; }
    }
    return projectDeliverySummary({ operation: request.operation, identity, run, target: request.target, report, model, verification, change,
      ...(request.topPaths !== undefined ? { topPaths: request.topPaths } : {}), ...(this.ports.known ? { known: this.ports.known } : {}) });
  }
  /** The worker's final report from the sealed dispatch output (same reader as the transcript); invalid or absent output is no claim. */
  private async report(identity: AttemptIdentity): Promise<WorkerFinalReportResult | null> {
    try {
      const dispatch = await this.ports.store.loadBoundDispatch(identity);
      if (!dispatch?.output) return null;
      return readWorkerFinalReport(parseRetainedOutputEnvelope(await this.ports.artifacts.read(identity.scopeId, dispatch.output), identity).stdout);
    } catch { return null; }
  }
}
