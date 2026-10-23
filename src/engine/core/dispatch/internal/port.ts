import { artifactReceiptSchema, type ArtifactReceipt } from '#capabilities/index.js';
import { z } from 'zod';
import { identitySchema, counterSchema, processExitCauseShape, isValidExitCause, type AttemptIdentity, type VerifiedPrincipal } from '#domain/index.js';
import { workerIncarnationSchema, sandboxRequestSchema, supervisorProfileSchema, containerEvidenceSchema } from '#engine/core/supervisor/index.js';
const claimObject = z.object({ request: sandboxRequestSchema, owner: identitySchema }).strict();
export const dispatchClaimSchema = claimObject.readonly();
/** R3: why the supervisor stopped waiting (additive; older records omit it and read as null). `inactivity`: the host watchdog aborted a silent
 * worker; `cancel`: another abort of the execute signal; `deadline`: interrupted without an abort (the profile deadline or a supervisor CLI
 * failure). Only `inactivity` is ever retried. */
export const DISPATCH_INTERRUPT_CAUSES = ['deadline', 'inactivity', 'cancel'] as const;
export const dispatchTerminalSchema = z.object({ handle: identitySchema, ...processExitCauseShape, container: containerEvidenceSchema.optional(), interrupted: z.boolean().nullable(),
  interruptCause: z.enum(DISPATCH_INTERRUPT_CAUSES).nullable().optional() }).strict().refine(isValidExitCause, 'ATTEMPT_EXIT_CAUSE_INVALID')
  .refine(value => !value.interruptCause || value.interrupted === true, 'ATTEMPT_EXIT_CAUSE_INVALID').readonly();
const actorSchema = z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict().readonly();
export const dispatchAdmissionSchema = claimObject.extend({ profile: supervisorProfileSchema }).strict().readonly();
/** S6R-1: the created container's immutable id, durable before `start`; the later incarnation (`worker`) must be that container. Older records
 * omit it. */
const containerIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const dispatchRecordSchema = claimObject.extend({
  schemaVersion: z.literal(2), containerId: containerIdSchema.optional(), worker: workerIncarnationSchema.optional(), profile: supervisorProfileSchema,
  launch: z.enum(['pending', 'granted', 'prevented-before-launch']),
  grant: z.object({ generation: counterSchema.positive(), grantedAt: counterSchema, principal: actorSchema }).strict().readonly().optional(),
  prevention: z.object({ reason: z.literal('cancel-requested') }).strict().readonly().optional(),
  terminal: dispatchTerminalSchema.nullable(), output: artifactReceiptSchema.optional(), patch: artifactReceiptSchema.optional(), cancellation: actorSchema.optional(),
}).strict().superRefine((record, context) => {
  const invalid = () => context.addIssue({ code: z.ZodIssueCode.custom, path: ['launch'], message: 'DISPATCH_LAUNCH_EVIDENCE_CONFLICT' });
  if (record.patch && (!record.terminal || record.patch.scopeId !== record.request.identity.scopeId)) invalid();
  if (record.containerId !== undefined && record.worker !== undefined && record.worker.id !== record.containerId) invalid();
  if (record.launch === 'granted') {
    if (!record.grant || record.grant.generation !== record.request.identity.generation || record.prevention) invalid();
  } else {
    if (record.grant || record.terminal !== null || record.output !== undefined || record.worker !== undefined || record.containerId !== undefined) invalid();
    if (record.launch === 'prevented-before-launch' ? !record.cancellation || !record.prevention : !!record.prevention) invalid();
  }
}).readonly();
export type DispatchAdmission = z.infer<typeof dispatchAdmissionSchema>;
export interface SupervisorProfileValidator {
  /** Concrete adapter validation before persistence; rejects unknown adapter/version/parameters.
   * This is a trusted composition dependency, never supplied through public request data. */
  validate(profile: z.infer<typeof supervisorProfileSchema>): undefined;
}
export interface LaunchRequest { readonly claim: DispatchClaim; readonly principal: VerifiedPrincipal; readonly now: number }
export type LaunchDecision = Readonly<{ kind: 'granted' | 'prevented'; record: DispatchRecord }>;

export type DispatchClaim = z.infer<typeof dispatchClaimSchema>;
export type DispatchTerminal = z.infer<typeof dispatchTerminalSchema>;
export type DispatchRecord = z.infer<typeof dispatchRecordSchema>;
/** Internal execution custody. A claim retains custody only; the separate atomic launch grant permits launch. Replay never grants launch,
 * even to the same owner. An unresolved claim requires reconciliation, never expiry-based stealing.
 */
/** Trusted lookup after authorization; full identity must match the Run binding. */
export interface RunBoundDispatchStore { loadBoundDispatch(identity: AttemptIdentity): Promise<DispatchRecord | null> }
export interface DispatchStore {
  /** S6R-1: the created container id of a granted, unfenced dispatch (idempotent; another id is a conflict). */
  retainDispatchContainer?(claim: DispatchClaim, containerId: string): Promise<DispatchRecord>;
  retainDispatchWorker?(claim: DispatchClaim, worker: NonNullable<DispatchRecord['worker']>): Promise<DispatchRecord>;
  requestDispatchCancellation(request: DispatchClaim['request'], principal: VerifiedPrincipal): Promise<DispatchRecord>;
  retainDispatchOutput(claim: DispatchClaim, receipt: ArtifactReceipt): Promise<DispatchRecord>;
  readDispatch(request: DispatchClaim['request']): Promise<DispatchRecord | null>;
  claimDispatch(claim: DispatchAdmission): Promise<Readonly<{ acquired: boolean; record: DispatchRecord }>>;
  grantLaunch(input: LaunchRequest): Promise<LaunchDecision>;
  finishDispatch(claim: DispatchClaim, terminal: DispatchTerminal): Promise<DispatchRecord>;
}
export class DispatchError extends Error {
  constructor(readonly code: 'DISPATCH_FENCE_CONFLICT' | 'DISPATCH_FENCED' | 'DISPATCH_ARTIFACT_REQUIRED' | 'DISPATCH_CONFLICT' | 'DISPATCH_NOT_ADMITTED' | 'DISPATCH_CORRUPT' | 'DISPATCH_PROFILE_VALIDATION_REQUIRED') { super(code); this.name = 'DispatchError'; }
}
