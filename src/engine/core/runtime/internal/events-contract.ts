import { z } from 'zod';
import { identitySchema, type AttemptIdentity, type ModelReference } from '#domain/index.js';
const counter = z.number().int().nonnegative().safe();
const viewIdentity = z.string().min(1).max(256);
export const runtimeEventsTopicSchema = z.enum(['run', 'approval', 'worker', 'usage', 'inventory']);
export const runtimeEventsCursorSchema = z.object({ serviceEpoch: z.string().uuid(), viewId: viewIdentity, sequence: counter }).strict().readonly();
export const runtimeEventsQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  topics: z.array(runtimeEventsTopicSchema).min(1).max(runtimeEventsTopicSchema.options.length).refine(v => new Set(v).size === v.length),
  resume: runtimeEventsCursorSchema.nullable().default(null) }).strict().readonly();
/** Deliberately metadata only. Unknown fields, free text and arbitrary JSON patches are forbidden on the wire. */
export const runtimeEventsRecordSchema = z.object({ topic: runtimeEventsTopicSchema, entity: z.enum(['run', 'attempt', 'approval', 'worker', 'worker-log', 'account', 'invocation', 'plan-usage', 'model', 'catalog-channel', 'catalog-model']),
  id: identitySchema, revision: counter, status: z.enum(['running', 'parked', 'terminal', 'reserved', 'started', 'exited', 'cancelled', 'unknown', 'registered', 'launch-refused',
    'rejected', 'not-sent', 'handoff-refused', 'quota-exhausted', 'pending', 'decided', 'expired', 'available', 'unavailable', 'claimed', 'responded', 'active', 'inactive', 'completed', 'failed', 'incomplete']),
  providerId: identitySchema.optional(), modelId: identitySchema.optional(),
  runId: identitySchema.optional(), taskId: identitySchema.optional(), attemptId: identitySchema.optional(),
  observedAt: counter, evidence: z.enum(['ledger', 'worker-reported', 'unknown']),
  sourceLoss: z.boolean(), cancelRequested: z.boolean().optional(), expiresAt: counter.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(), usageBasis: z.enum(['account-checkpoint', 'provider-reported', 'measured-tariff', 'plan-usage', 'unknown']).optional(),
  settledMinorUnits: counter.optional(), reservedMinorUnits: counter.optional(), limitMinorUnits: counter.optional(),
  inputTokens: counter.optional(), outputTokens: counter.optional(), eventCount: counter.optional(),
}).strict().refine(record => ({ run: ['run', 'attempt'], approval: ['approval'], worker: ['worker', 'worker-log'], usage: ['account', 'invocation', 'plan-usage'], inventory: ['model', 'catalog-channel', 'catalog-model'] })[record.topic].includes(record.entity)).readonly();
const cursor = runtimeEventsCursorSchema;
export const runtimeEventsCloseReasonSchema = z.enum(['cancelled', 'service-shutdown', 'authorization-changed', 'slow-consumer', 'source-unavailable', 'too-large']);
export const runtimeEventsGapReasonSchema = z.enum(['overflow', 'retention', 'epoch-changed', 'source-loss', 'snapshot-raced']);
export const runtimeEventsItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), scopeId: identitySchema, topics: z.array(runtimeEventsTopicSchema), serviceEpoch: z.string().uuid(), viewId: viewIdentity, mode: z.literal('observation-order') }).strict(),
  z.object({ type: z.literal('snapshot.begin'), snapshotId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('snapshot.part'), snapshotId: z.string().uuid(), record: runtimeEventsRecordSchema }).strict(),
  z.object({ type: z.literal('snapshot.end'), snapshotId: z.string().uuid(), resume: cursor }).strict(),
  z.object({ type: z.literal('change'), operation: z.enum(['upsert', 'remove']), record: runtimeEventsRecordSchema, resume: cursor }).strict(),
  z.object({ type: z.literal('gap'), reason: runtimeEventsGapReasonSchema, resume: cursor, requiresSnapshot: z.literal(true), missing: z.null() }).strict(),
  z.object({ type: z.literal('heartbeat'), resume: cursor, observedAt: counter, freshness: z.enum(['current', 'unavailable']) }).strict(),
  z.object({ type: z.literal('close'), reason: runtimeEventsCloseReasonSchema, resume: cursor }).strict(),
]).readonly();
export type RuntimeEventsQuery = z.input<typeof runtimeEventsQuerySchema>;
export type RuntimeEventsSelection = z.output<typeof runtimeEventsQuerySchema>;
export type RuntimeEventsTopic = z.infer<typeof runtimeEventsTopicSchema>;
export type RuntimeEventsCursor = z.infer<typeof cursor>;
export type RuntimeEventsRecord = z.infer<typeof runtimeEventsRecordSchema>;
export type RuntimeEventsItem = z.infer<typeof runtimeEventsItemSchema>;
export type RuntimeEventsCloseReason = z.infer<typeof runtimeEventsCloseReasonSchema>;
/** Adapter-private selectors never enter a public DTO. Authorization precedes enrichment (including worker sidecars). */
export interface RuntimeObservationRow { readonly record: RuntimeEventsRecord; readonly identity?: AttemptIdentity; readonly budgetId?: string;
  readonly reference?: ModelReference; readonly catalogTarget?: { readonly channelId: string; readonly modelId: string | null }; readonly workspace?: string; readonly watermark: string }
export interface RuntimeObservationCapture { readonly rows: readonly RuntimeObservationRow[]; readonly sourceLoss: boolean }
export interface RuntimeObservationSource {
  capture(signal: AbortSignal): Promise<RuntimeObservationCapture>;
  wait(signal: AbortSignal): Promise<void>;
  close(): void;
}
export class RuntimeEventsError extends Error {
  constructor(readonly code: 'RUNTIME_EVENTS_INVALID' | 'RUNTIME_EVENTS_CURSOR' | 'RUNTIME_EVENTS_LIMIT' | 'RUNTIME_EVENTS_UNAVAILABLE' | 'RUNTIME_EVENTS_TOO_LARGE') { super(code); this.name = 'RuntimeEventsError'; }
}
export const runtimeEventsKey = (record: RuntimeEventsRecord): string => `${record.topic}\0${record.entity}\0${record.id}`;
