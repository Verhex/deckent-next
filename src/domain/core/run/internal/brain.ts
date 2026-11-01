import { persistedInteger, identitySchema, clientCommandIdSchema, createImmutableJsonObjectSchema } from '#domain/core/primitives/index.js';
import { z } from 'zod';
import { modelReferenceSchema } from '#domain/core/provider-catalog/index.js';
import { modelInvocationBillingAxisSchema } from '#domain/core/model-invocation/index.js';
import protocol from './brain-protocol.json' with { type: 'json' };
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Human/AI intent is a proposal request, never a Run-create authority. */
export const brainPlanCommandSchema = z.strictObject({ schemaVersion: z.literal(1), commandId: clientCommandIdSchema,
  scopeId: identitySchema, intent: z.string().trim().min(1).max(protocol.intentMaxCodeUnits).refine(value => !value.includes('\0')),
  reference: modelReferenceSchema.optional(),
}).readonly();
export type BrainPlanCommand = z.infer<typeof brainPlanCommandSchema>;
export const brainPlanCommandInputSchema = createImmutableJsonObjectSchema(protocol.commandLimits).pipe(brainPlanCommandSchema);
/** f3 (owner Q-H4): the refused planning call a later attempt descends from (its command id and recorded invocation id). */
export type BrainAttemptLink = Readonly<{ commandId: string; invocationId: string }>;
/** Planning progress a surface shows while one plan command runs: a quota wait (until when, the next attempt, after which refused call), then
 * planning again. Progress only: it carries no authority and changes nothing. */
export type BrainPlanProgress = Readonly<{ kind: 'quota-wait'; attempt: number; maxAttempts: number; resetsAtMs: number; untilMs: number; after: BrainAttemptLink }>
  | Readonly<{ kind: 'billing-switch'; reference: z.infer<typeof modelReferenceSchema> }>
  | Readonly<{ kind: 'planning'; attempt: number }>;
export type BrainPlanObserver = (progress: BrainPlanProgress) => void;
/**
 * f4 item 1 (no-MVP gap of Q-H4): the presence record of an active Brain quota wait, kept while the wait runs so a surface that did not start it
 * (the standalone monitor, MCP `inspect_monitor`) shows it before any Run exists. Ephemeral host state, not evidence: ids and times only, never the
 * intent or prompt text. Written when the wait starts and removed when it ends (reset reached, cancelled, failed); a record its writer left
 * behind (a crash) expires by the store's registry bound.
 */
export const brainQuotaWaitRecordSchema = z.strictObject({ schemaVersion: z.literal(1), scopeId: identitySchema, commandId: clientCommandIdSchema,
  attempt: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), maxAttempts: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), sinceMs: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  resetsAtMs: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), untilMs: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  after: z.strictObject({ commandId: z.string().min(1).max(256), invocationId: z.string().min(1).max(256) }).readonly() }).readonly();
export type BrainQuotaWaitRecord = z.infer<typeof brainQuotaWaitRecordSchema>;
/** The port the planning application keeps the record through (adapter: a host state file per wait). */
export interface BrainQuotaWaitStore {
  begin(record: BrainQuotaWaitRecord): Promise<void>;
  end(scopeId: string, commandId: string): Promise<void>;
}
/** Bounded, redacted contribution attribution; the invocation retains its own immutable receipt. */
const contributionShape = z.strictObject({
  template: z.strictObject({ id: identitySchema, version: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), digest }).readonly(),
  inputDigest: digest, contextDigest: digest, outputDigest: digest, requestDigest: digest,
  activationRevision: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), bindingDigest: digest,
  inputSummary: z.string().max(protocol.summaryMaxCodeUnits), outputSummary: z.string().max(protocol.summaryMaxCodeUnits),
  usage: z.strictObject({ inputTokens: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), outputTokens: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    totalTokens: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }).readonly().nullable(),
}).readonly();
export const brainContributionSchema = z.discriminatedUnion('schemaVersion', [
  z.strictObject({ schemaVersion: z.literal(1), ...contributionShape.unwrap().shape }),
  contributionShape.unwrap().extend({ schemaVersion: z.literal(2), billingAxis: modelInvocationBillingAxisSchema }).strict(),
]).readonly();
export type BrainContribution = z.infer<typeof brainContributionSchema>;
