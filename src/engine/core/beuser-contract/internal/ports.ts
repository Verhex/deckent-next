import { z } from 'zod';
import { SUPPORTED_LANGUAGES } from '#platform/index.js';
import { beuserWalkerSummarySchema, beuserBindingSchema, type BeuserBinding, type BeuserWalkerSummary, type BeuserTranscriptEntry, type BeuserVerdict } from '#domain/index.js';
import { sameAttemptIdentity } from '#domain/index.js';
import { verifiedPrincipalSchema, isBeuserEvaluatorPrincipal, type VerifiedPrincipal } from '#domain/index.js';
import { aiAuthorityFloor } from '#domain/index.js';
import type { AuditEvent } from '#domain/index.js';
import type { TaskEvaluationApplication, TaskEvaluationCommand } from '#engine/core/task-evaluation/index.js';
import type { RoleModelRefusal } from '#domain/index.js';
import type { ModelInvocationResult } from '#engine/core/model-invocation/index.js';
import { BeuserContractError, type BeuserLimits } from './limits.js';
import type { BeuserArrangeStep } from './arrange.js';

/** Supported locales come from the product registry; the pure domain shape carries a locale identity. */
export function pinBeuserWalkerSummary(input: unknown): BeuserWalkerSummary {
  const summary = beuserWalkerSummarySchema.parse(input);
  if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(summary.language)) throw new BeuserContractError('BEUSER_INPUT_INVALID');
  return summary;
}
/** Issued by admission, never deserialized from a client request. Every port must recheck this exact binding. */
export interface BeuserContext { readonly binding: BeuserBinding; readonly principal: VerifiedPrincipal; readonly limits: BeuserLimits; readonly signal: AbortSignal }
/** Wire ingress may select only an already admitted binding and action; no principal, path or verdict. */
export const beuserSurfaceCommandSchema = z.object({ schemaVersion: z.literal(1), binding: beuserBindingSchema,
  action: z.discriminatedUnion('kind', [z.object({ kind: z.literal('look') }).strict(),
    z.object({ kind: z.literal('type'), text: z.string() }).strict(), z.object({ kind: z.literal('press'), key: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('wait'), ms: z.number().int().positive().safe() }).strict()]),
}).strict().readonly();
export type BeuserSurfaceCommand = z.infer<typeof beuserSurfaceCommandSchema>;
/** Key names a walker may press (a single printable character presses itself); screen hint spellings name the same keys. Terminal vocabulary,
 * not policy: the surface maps each name to its bytes and the walker receives this list. */
export const BEUSER_KEYS = Object.freeze(['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft', 'Home', 'End',
  'PageUp', 'PageDown', 'Delete', 'Ctrl+C', 'Ctrl+D', 'Ctrl+O'] as const);
export type BeuserKeyName = typeof BEUSER_KEYS[number];
export const BEUSER_KEY_ALIASES: ReadonlyMap<string, BeuserKeyName> = new Map([['Esc', 'Escape'], ['PgUp', 'PageUp'], ['PgDn', 'PageDown'], ['Return', 'Enter'],
  ['↑', 'ArrowUp'], ['↓', 'ArrowDown'], ['→', 'ArrowRight'], ['←', 'ArrowLeft'], ['Up', 'ArrowUp'], ['Down', 'ArrowDown'], ['Right', 'ArrowRight'], ['Left', 'ArrowLeft']]);
/** A kind-level policy grant alone never establishes own-Run/Attempt/transcript/realm custody. */
export function assertBeuserAccess(admitted: BeuserContext, requested: unknown, actor: unknown, resource: { readonly kind: string; readonly id: string }, action: string): void {
  admitted.signal.throwIfAborted();
  const binding = beuserBindingSchema.safeParse(requested), principal = verifiedPrincipalSchema.safeParse(actor);
  const own = admitted.binding, expected = admitted.principal;
  if (!binding.success || !principal.success || !isBeuserEvaluatorPrincipal(principal.data) || principal.data.assurance !== 'workload-verified'
    || principal.data.id !== expected.id || principal.data.issuer !== expected.issuer || principal.data.subject !== expected.subject
    || !principal.data.scopeIds.includes(own.identity.scopeId) || !sameAttemptIdentity(binding.data.identity, own.identity)
    || JSON.stringify(binding.data) !== JSON.stringify(beuserBindingSchema.parse(own)) || aiAuthorityFloor(principal.data, resource, action)
    || resource.kind === 'run' && resource.id !== own.identity.runId
    || resource.kind === 'attempt' && resource.id !== own.identity.attemptId
    || resource.kind === 'beuser-transcript' && resource.id !== own.transcriptId
    || resource.kind === 'beuser-sandbox' && resource.id !== own.realmId) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
}
export const beuserFilesystemProofSchema = z.object({ schemaVersion: z.literal(1),
  source: z.enum(['kernel-proven', 'daemon-attested', 'unknown']),
}).strict().readonly();
export type BeuserFilesystemProof = z.infer<typeof beuserFilesystemProofSchema>;
export interface BeuserRealmObservation {
  readonly binding: BeuserBinding;
  readonly state: 'created' | 'admitted' | 'destroyed' | 'quarantined' | 'unknown';
  readonly filesystemProof?: BeuserFilesystemProof | undefined;
  readonly evidenceRefs: readonly string[];
}
export interface RealmPort {
  create(context: BeuserContext): Promise<BeuserRealmObservation>;
  admit(context: BeuserContext, observation: BeuserRealmObservation): Promise<BeuserRealmObservation>;
  observe(context: BeuserContext): Promise<BeuserRealmObservation>;
  destroy(context: BeuserContext): Promise<BeuserRealmObservation>;
  quarantine(context: BeuserContext, reason: string): Promise<BeuserRealmObservation>;
}
export interface BeuserScreen { readonly binding: BeuserBinding; readonly sequence: number; readonly text: string; readonly digest: string }
export interface SurfacePort {
  look(context: BeuserContext): Promise<BeuserScreen>;
  type(context: BeuserContext, text: string): Promise<BeuserScreen>;
  press(context: BeuserContext, key: string): Promise<BeuserScreen>;
  wait(context: BeuserContext, ms: number): Promise<BeuserScreen>;
  /** Trusted harness twin only; never a walker tool, shell string or client-authored executable/path. */
  argv(context: BeuserContext, command: { readonly commandId: string; readonly args: readonly string[] }): Promise<BeuserScreen>;
}
export type BeuserModelRole = 'beuser-walker' | 'beuser-evaluator';
export type BeuserModelResult = Readonly<{ state: 'invoked'; receipt: BeuserModelReceipt }>
  | Readonly<{ state: 'unavailable'; code: 'BEUSER_MODEL_UNAVAILABLE'; reason: RoleModelRefusal | 'maker-unknown' | 'independence' }>;
export interface BeuserModelReceipt { readonly invocation: ModelInvocationResult; readonly role: BeuserModelRole; readonly maker: string | null }
/** The walker's own last actions, oldest first, whether its last action left the screen unchanged (walk17 S2), and (walk18) the persona's
 * model decisions left including this one and wait patience left. */
export type BeuserWalkerHistory = Readonly<{ recentActions: readonly unknown[]; screenUnchanged: boolean; remainingSteps: number; remainingWaitMs: number }>;
/** Typed feedback for a correction: an unparseable answer, or an action the surface refused before any input was sent. */
export type BeuserCorrection = 'BEUSER_MODEL_OUTPUT_INVALID' | 'BEUSER_ACTION_INVALID';
/** Input construction keeps the rubric out of the walker call; provider/model selection is the existing role/active/budget path. */
export interface ModelPort {
  walker(context: BeuserContext, summary: BeuserWalkerSummary, screen: BeuserScreen, history: BeuserWalkerHistory, outputError?: BeuserCorrection): Promise<BeuserModelResult>;
  evaluate(context: BeuserContext, transcriptDigest: string, outputError?: BeuserCorrection): Promise<BeuserModelResult>;
  cancel(context: BeuserContext, invocationId: string): Promise<void>;
}
/** Trusted start-state arrangement of the admitted target, before the persona's first look. The target is the context binding,
 * not a realm: the product CLI exec adapter is the first implementation; results are parsed and gated by the engine. */
export interface BeuserArrangePort {
  run(context: BeuserContext, step: Exclude<BeuserArrangeStep, { kind: 'check' }>): Promise<unknown>;
  observe(context: BeuserContext, readback: BeuserArrangeStep['readback']): Promise<unknown>;
}
export interface EvidencePort {
  append(context: BeuserContext, entry: BeuserTranscriptEntry): Promise<void>;
  finalize(context: BeuserContext): Promise<{ readonly binding: BeuserBinding; readonly transcriptDigest: string; readonly evidenceRefs: readonly string[] }>;
  readback(context: BeuserContext): Promise<{ readonly binding: BeuserBinding; readonly verdict: BeuserVerdict | null }>;
}
/** The existing application authenticates and verifies retained output; no verdict submission port. */
export interface EvaluationPort {
  evaluate(context: BeuserContext, command: TaskEvaluationCommand): ReturnType<TaskEvaluationApplication['execute']>;
}
export interface BeuserTargetRefusal {
  readonly code: 'BEUSER_TARGET_NOT_SANDBOX'; readonly binding: BeuserBinding;
}
export interface BeuserObservationPort {
  audit(event: AuditEvent & { readonly subject: Extract<AuditEvent['subject'], { kind: 'beuser-target-refusal' }> }): Promise<void>;
  nervous(refusal: BeuserTargetRefusal): Promise<void>;
}
