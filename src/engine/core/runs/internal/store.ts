import { CodedError } from '#platform/index.js';
import { clientCommandIdSchema, runProposalBindingSchema, authorityAdmissionSchema, branchDecisionSchema, runExecutionSnapshotSchema, identitySchema, counterSchema, runIdentitySchema, taskGraphSchema, attemptIdentitySchema, type RunSnapshot } from '#domain/index.js';
import type { RunCapacityBinding } from './capacity-resource.js';
import { z } from 'zod';
import type { ReservationDiagnostic } from '#engine/core/scheduling/index.js';
import type { RunWorkspaceCustody } from '#engine/core/workspaces/index.js';
const actor = z.strictObject({ id: identitySchema, issuer: identitySchema, subject: identitySchema });
const capacity = z.strictObject({ executionSlots: counterSchema, inFlightSlots: counterSchema });
export const executionPoolSchema = z.strictObject({ schemaVersion: z.literal(1), poolId: identitySchema, capacity }).readonly();
export type ExecutionPool = z.infer<typeof executionPoolSchema>;
export const runExecutionPolicySchema = z.strictObject({ schemaVersion: z.literal(2), poolId: identitySchema, capacity, ordering: z.array(identitySchema) });
export const runCreateSchema = z.strictObject({ commandId: clientCommandIdSchema, actor, identity: runIdentitySchema, graph: taskGraphSchema, now: counterSchema,
  policy: runExecutionPolicySchema, execution: runExecutionSnapshotSchema, branch: branchDecisionSchema.optional(), authority: authorityAdmissionSchema.optional(), proposal: runProposalBindingSchema.optional(),
});
export const runReservationSchema = z.strictObject({ commandId: clientCommandIdSchema, actor, scopeId: identitySchema, runId: identitySchema,
  expectedRevision: counterSchema, now: counterSchema, identities: z.array(attemptIdentitySchema).min(1),
});
export const runProjectionSchema = runReservationSchema.omit({ now: true, identities: true }).extend({ attemptId: identitySchema });
export const runCancellationSchema = runReservationSchema.omit({ now: true, identities: true });
export type RunCancellation = z.infer<typeof runCancellationSchema>;
export type RunProjection = z.infer<typeof runProjectionSchema>;
export type RunCreate = z.infer<typeof runCreateSchema>;
export type RunReservation = z.infer<typeof runReservationSchema>;
export interface RunReceipt { readonly commandId: string; readonly command: string; readonly snapshot: RunSnapshot }
/** Internal trusted application port. Actor is receipt attribution, not authentication.
 * Reservation enforces both persisted per-Run limits and the assigned shared pool in one ledger.
 */
export interface RunStore {
  loadRunReceipt(scopeId: string, commandId: string): Promise<RunReceipt | null>;
  cancelRun(input: RunCancellation): Promise<RunReceipt>;
  createExecutionPool(input: ExecutionPool): Promise<ExecutionPool>;
  projectRunAttempt(input: RunProjection): Promise<RunReceipt>;
  loadRun(scopeId: string, runId: string): Promise<RunSnapshot | null>;
  /** `workspace`, when given, is the Run's immutable workspace custody, written in the admission transaction and never part of the
   * receipt command (record shapes unchanged). A replay whose custody differs is RUN_COMMAND_CONFLICT. */
  createRun(input: RunCreate, workspace?: RunWorkspaceCustody, assertAuthority?: () => void, resources?: readonly RunCapacityBinding[]): Promise<RunReceipt>;
  /** Atomically admits a nonempty ordered prefix fitting both limits. Command retains candidates;
   * snapshot contains only admitted attempts. Replay never expands the original admission. */
  reserveRunTasks(input: RunReservation): Promise<RunReceipt>;
}
export class RunStoreError extends CodedError {
  constructor(override readonly code: 'RUN_NOT_FOUND' | 'RUN_STORE_CONFLICT' | 'RUN_COMMAND_CONFLICT' | 'RUN_STORE_CORRUPT' | 'RUN_CAPACITY_OR_ORDER' | 'RUN_POOL_REQUIRED' | 'RUN_POOL_CONFLICT' | 'RUN_POOL_FULL' | 'RUN_POOL_HELD' | 'RUN_POOL_CAPACITY_OCCUPIED',
    readonly diagnostic?: ReservationDiagnostic) { super(code); this.name = 'RunStoreError'; }
}
