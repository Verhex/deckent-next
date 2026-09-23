import { z } from 'zod';
import { counterSchema, identitySchema, verifiedPrincipalSchema } from '#domain/index.js';

const reasonSchema = z.string().max(1024).refine(value => value.trim().length > 0, 'SHUTDOWN_REASON_BLANK');
const peerEvidenceSchema = z.object({
  method: z.literal('os-peer'),
  pid: z.number().int().positive().safe(),
  uid: counterSchema,
  gid: counterSchema,
}).strict().readonly();

const serviceIdentityShape = {
  scopeId: identitySchema,
  serviceId: identitySchema,
} as const;
const serviceInstanceShape = { ...serviceIdentityShape, instanceId: identitySchema } as const;

export const serviceIdentitySchema = z.object(serviceIdentityShape).strict().readonly();

export const serviceInstanceSchema = z.object(serviceInstanceShape).strict().readonly();

export const shutdownCommandSchema = z.object({
  schemaVersion: z.literal(1),
  commandId: identitySchema,
  serviceId: identitySchema,
  instanceId: identitySchema,
  reason: reasonSchema,
}).strict().readonly();

export const serviceActorSchema = z.object({
  principal: verifiedPrincipalSchema,
  evidence: peerEvidenceSchema,
}).strict().superRefine((actor, context) => {
  // Structural consistency only; the transport verifier must still supply the actual kernel evidence.
  if (actor.principal.assurance !== 'os-user' || actor.principal.subject !== String(actor.evidence.uid)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'SHUTDOWN_PEER_IDENTITY_MISMATCH' });
  }
}).readonly();

export const shutdownAdmissionSchema = z.object({
  schemaVersion: z.literal(1),
  scopeId: identitySchema,
  command: shutdownCommandSchema,
  actor: serviceActorSchema,
  authorization: z.object({ revision: identitySchema, ruleId: identitySchema }).strict().readonly(),
  admittedAtMs: counterSchema,
}).strict().readonly();

export const shutdownOutcomeSchema = z.object({
  schemaVersion: z.literal(1),
  scopeId: identitySchema,
  serviceId: identitySchema,
  instanceId: identitySchema,
  commandId: identitySchema,
  state: z.enum(['clean', 'incomplete']),
  remainingRequests: counterSchema,
  recoveryPending: z.boolean(),
  observedAtMs: counterSchema,
}).strict().superRefine((outcome, context) => {
  if (outcome.state === 'clean' && (outcome.remainingRequests !== 0 || outcome.recoveryPending)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'SHUTDOWN_CLEAN_INVARIANT' });
  }
}).readonly();

// Unconfigured installations expose no invented service/scope identity or implied shutdown grant.
/** Source build the service runs from (absent when started from source or from a build before this field). */
export const serviceBuildSchema = z.object({ sourceTreeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{40,64}$/).nullable() }).strict().readonly();
export const runtimeServiceDescriptorSchema = z.discriminatedUnion('shutdownAvailable', [
  z.object({ schemaVersion: z.literal(1), instanceId: identitySchema,
    shutdownAvailable: z.literal(false), identity: z.null(), build: serviceBuildSchema.optional() }).strict(),
  z.object({ schemaVersion: z.literal(1), instanceId: identitySchema,
    shutdownAvailable: z.literal(true), identity: serviceIdentitySchema, build: serviceBuildSchema.optional() }).strict(),
]).readonly();

export type ServiceIdentity = z.infer<typeof serviceIdentitySchema>;
export type ServiceInstance = z.infer<typeof serviceInstanceSchema>;
export type ShutdownCommand = z.infer<typeof shutdownCommandSchema>;
export type ServiceActor = z.infer<typeof serviceActorSchema>;
export type ShutdownAdmission = z.infer<typeof shutdownAdmissionSchema>;
export type ShutdownOutcome = z.infer<typeof shutdownOutcomeSchema>;
export type RuntimeServiceDescriptor = z.infer<typeof runtimeServiceDescriptorSchema>;
export type StableShutdownActor = Readonly<Pick<ServiceActor['principal'], 'issuer' | 'subject' | 'assurance'>>;

export function stableShutdownActor(actor: ServiceActor): StableShutdownActor {
  const principal = serviceActorSchema.parse(actor).principal;
  return Object.freeze({ issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance });
}

/** Fresh peer evidence, authorization and time never rewrite or invalidate the original admission audit. */
export function sameShutdownAdmission(existing: unknown, incoming: unknown): boolean {
  const left = shutdownAdmissionSchema.parse(existing), right = shutdownAdmissionSchema.parse(incoming);
  const leftActor = stableShutdownActor(left.actor), rightActor = stableShutdownActor(right.actor);
  return left.scopeId === right.scopeId
    && left.command.schemaVersion === right.command.schemaVersion
    && left.command.commandId === right.command.commandId
    && left.command.serviceId === right.command.serviceId
    && left.command.instanceId === right.command.instanceId
    && left.command.reason === right.command.reason
    && leftActor.issuer === rightActor.issuer
    && leftActor.subject === rightActor.subject
    && leftActor.assurance === rightActor.assurance;
}
