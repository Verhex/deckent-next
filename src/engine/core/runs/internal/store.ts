import { z } from 'zod';
import { identitySchema, counterSchema, runIdentitySchema, taskGraphSchema, attemptIdentitySchema, type RunSnapshot } from '#domain/index.js';
const actor = z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict();
const capacity = z.object({ executionSlots: counterSchema, inFlightSlots: counterSchema }).strict();
export const executionPoolSchema = z.object({ schemaVersion: z.literal(1), poolId: identitySchema, capacity }).strict().readonly();
export type ExecutionPool = z.infer<typeof executionPoolSchema>;
export const runExecutionPolicySchema = z.object({ schemaVersion: z.literal(2), poolId: identitySchema, capacity, ordering: z.array(identitySchema) }).strict();
export const runCreateSchema = z.object({ commandId: identitySchema, actor, identity: runIdentitySchema, graph: taskGraphSchema, now: counterSchema,
  policy: runExecutionPolicySchema,
}).strict();
export const runReservationSchema = z.object({ commandId: identitySchema, actor, scopeId: identitySchema, runId: identitySchema,
  expectedRevision: counterSchema, now: counterSchema, identities: z.array(attemptIdentitySchema).min(1),
}).strict();
export const runProjectionSchema = runReservationSchema.omit({ now: true, identities: true }).extend({ attemptId: identitySchema });
export type RunProjection = z.infer<typeof runProjectionSchema>;
export type RunCreate = z.infer<typeof runCreateSchema>;
export type RunReservation = z.infer<typeof runReservationSchema>;
export interface RunReceipt { readonly commandId: string; readonly command: string; readonly snapshot: RunSnapshot }
/** Internal trusted application port. Actor is receipt attribution, not authentication.
 * Reservation enforces both persisted per-Run limits and the assigned shared pool in one ledger.
 */
export interface RunStore {
  createExecutionPool(input: ExecutionPool): Promise<ExecutionPool>;
  projectRunAttempt(input: RunProjection): Promise<RunReceipt>;
  loadRun(scopeId: string, runId: string): Promise<RunSnapshot | null>;
  createRun(input: RunCreate): Promise<RunReceipt>;
  reserveRunTasks(input: RunReservation): Promise<RunReceipt>;
}
export class RunStoreError extends Error {
  constructor(readonly code: 'RUN_STORE_CONFLICT' | 'RUN_COMMAND_CONFLICT' | 'RUN_STORE_CORRUPT' | 'RUN_CAPACITY_OR_ORDER' | 'RUN_POOL_REQUIRED' | 'RUN_POOL_CONFLICT' | 'RUN_POOL_FULL') { super(code); this.name = 'RunStoreError'; }
}
