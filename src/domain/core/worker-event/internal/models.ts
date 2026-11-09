import { persistedString } from '#domain/core/primitives/index.js';
import { z } from 'zod';
import { workerEffortSchema, type WorkerEffort, modelUsageEvidenceSchema, readLegacyModelUsageEvidence, type ModelUsageEvidence,
  workerModelPinEvidenceShape } from '#domain/core/provider-catalog/index.js';
import { workerProviderSchema, type WorkerEventSummary, type WorkerModelVerificationStatus } from './contract.js';

/**
 * Which models a worker was asked to use and which it reported using (WORKER-CURRENCY-2, owner 2026-09-30). One typed row for every
 * surface (workers list/watch, run inspect, transcript) and for the Task evaluation record: requested (the Run's frozen exact-model pin)
 * → init (session.started model) → usage (Claude `result.modelUsage` keys) → verdict. The verdict is the host's sealed comparison of
 * worker-REPORTED usage with the pin; it is not provider attestation. Before the log is sealed the verdict is `pending`.
 */
const modelText = persistedString(z.string().min(1).max(256));
/** The frozen pin may carry the catalog's session-start evidence (`workerModelPinEvidenceShape`, owner K1/K2 2026-10-22). */
export const workerModelPinSchema = z.strictObject({ channelId: modelText, modelId: modelText,
  auxiliaryModelIds: z.array(modelText).max(16).readonly(), ...workerModelPinEvidenceShape }).readonly();
export type WorkerModelPin = z.infer<typeof workerModelPinSchema>;
export type WorkerProvider = z.infer<typeof workerProviderSchema>;
const pinnedSubscriptionSchema = z.looseObject({ provider: workerProviderSchema, model: workerModelPinSchema, modelUsageEvidence: modelUsageEvidenceSchema.optional(), reasoningEffort: workerEffortSchema.optional() });
const parametersSchema = z.looseObject({ nativeSubscription: pinnedSubscriptionSchema });
/** KG7 F3: the worker execution adapter ids (data, never a route) and the one native CLI worker wrapper shape; capabilities narrows `base` and `binding`. */
export const NATIVE_CLI_WORKER_ADAPTER_ID = 'native-cli-worker', NATIVE_CODING_TEMPLATE_ADAPTER_ID = 'native-coding-template', nativeCliWorkerWrapperSchema = z.strictObject({ schemaVersion: z.literal(1), base: z.looseObject({ parameters: z.unknown() }), binding: z.record(z.string(), z.unknown()) });
/** Versioned task-data wrappers retain the base as the sole model-pin source. This grants no execution route. */
export function workerTaskParameters(input: unknown): unknown {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'base')) return input;
  return nativeCliWorkerWrapperSchema.safeParse(input).data?.base.parameters;
}

/** The exact-model pin a native worker profile carries (nativeSubscription v2 `model`), or null: not a pinned worker profile. */
export function readWorkerModelPin(profileParameters: unknown): Readonly<{ provider: WorkerProvider; pin: WorkerModelPin; evidenceCapability: ModelUsageEvidence; reasoningEffort?: WorkerEffort }> | null {
  const parsed = parametersSchema.safeParse(workerTaskParameters(profileParameters));
  return parsed.success ? Object.freeze({ provider: parsed.data.nativeSubscription.provider, pin: parsed.data.nativeSubscription.model,
    ...(parsed.data.nativeSubscription.reasoningEffort ? { reasoningEffort: parsed.data.nativeSubscription.reasoningEffort } : {}),
    evidenceCapability: parsed.data.nativeSubscription.modelUsageEvidence ?? readLegacyModelUsageEvidence(parsed.data.nativeSubscription.provider) }) : null;
}

/** `sealed`: the host-sealed event log; `invalid`: a sealed log that is not a valid event stream; `live`: the running worker's projected
 * events; `none`: no events; `denied`: not readable by the caller. */
export type WorkerModelEvidence = 'sealed' | 'invalid' | 'live' | 'none' | 'denied';
export type WorkerModelVerdict = WorkerModelVerificationStatus | 'pending';
export interface WorkerModelView {
  readonly reasoningEffort?: WorkerEffort;
  readonly provider: WorkerProvider; readonly evidenceCapability: ModelUsageEvidence; readonly requested: WorkerModelPin; readonly init: string | null; readonly usage: readonly string[] | null;
  readonly verdict: WorkerModelVerdict; readonly unexpected: readonly string[]; readonly evidence: WorkerModelEvidence;
}
/** Pure projection. A sealed log without a host verdict (no session end, provider without usage) or an invalid one is `unverified`;
 * unsealed evidence is `pending`. */
export function viewWorkerModels(input: Readonly<{ provider: WorkerProvider; pin: WorkerModelPin; evidenceCapability: ModelUsageEvidence; summary: WorkerEventSummary | null;
  evidence: WorkerModelEvidence; reasoningEffort?: WorkerEffort }>): WorkerModelView {
  const sealed = input.evidence === 'sealed', verification = sealed ? input.summary?.modelVerification ?? null : null;
  const visible = input.evidence === 'denied' || input.evidence === 'invalid' ? null : input.summary;
  return Object.freeze({ ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}), provider: input.provider, evidenceCapability: input.evidenceCapability, requested: input.pin, init: visible?.model ?? null, usage: visible?.models ?? null,
    verdict: sealed ? verification?.status ?? 'unverified' : input.evidence === 'invalid' ? 'unverified' : 'pending',
    unexpected: verification?.unexpected ?? Object.freeze([]), evidence: input.evidence });
}
