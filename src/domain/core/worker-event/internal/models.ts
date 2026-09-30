import { z } from 'zod';
import { workerProviderSchema, type WorkerEventSummary } from './contract.js';

/**
 * Which models a worker was asked to use and which it reported using (WORKER-CURRENCY-2, owner 2026-09-30). One typed row for every
 * surface (workers list/watch, run inspect, transcript) and for the Task evaluation record: requested (the Run's frozen exact-model pin)
 * → init (session.started model) → usage (Claude `result.modelUsage` keys) → verdict. The verdict is the host's sealed comparison of
 * worker-REPORTED usage with the pin; it is not provider attestation. Before the log is sealed the verdict is `pending`.
 */
const modelText = z.string().min(1).max(256);
export const workerModelPinSchema = z.object({ channelId: modelText, modelId: modelText,
  auxiliaryModelIds: z.array(modelText).max(16).readonly() }).strict().readonly();
export type WorkerModelPin = z.infer<typeof workerModelPinSchema>;
export type WorkerProvider = z.infer<typeof workerProviderSchema>;
const pinnedSubscriptionSchema = z.object({ provider: workerProviderSchema, model: workerModelPinSchema }).passthrough();
const parametersSchema = z.object({ nativeSubscription: pinnedSubscriptionSchema }).passthrough();

/** The exact-model pin a native worker profile carries (nativeSubscription v2 `model`), or null: not a pinned worker profile. */
export function readWorkerModelPin(profileParameters: unknown): Readonly<{ provider: WorkerProvider; pin: WorkerModelPin }> | null {
  const parsed = parametersSchema.safeParse(profileParameters);
  return parsed.success ? Object.freeze({ provider: parsed.data.nativeSubscription.provider, pin: parsed.data.nativeSubscription.model }) : null;
}

/** `sealed`: the host-sealed event log; `invalid`: a sealed log that is not a valid event stream; `live`: the running worker's projected
 * events; `none`: no events; `denied`: not readable by the caller. */
export type WorkerModelEvidence = 'sealed' | 'invalid' | 'live' | 'none' | 'denied';
export type WorkerModelVerdict = 'verified' | 'substituted' | 'unverified' | 'pending';
export interface WorkerModelView {
  readonly provider: WorkerProvider; readonly requested: WorkerModelPin; readonly init: string | null; readonly usage: readonly string[] | null;
  readonly verdict: WorkerModelVerdict; readonly unexpected: readonly string[]; readonly evidence: WorkerModelEvidence;
}
/** Pure projection. A sealed log without a host verdict (no session end, provider without usage) or an invalid one is `unverified`;
 * unsealed evidence is `pending`. */
export function viewWorkerModels(input: Readonly<{ provider: WorkerProvider; pin: WorkerModelPin; summary: WorkerEventSummary | null;
  evidence: WorkerModelEvidence }>): WorkerModelView {
  const sealed = input.evidence === 'sealed', verification = sealed ? input.summary?.modelVerification ?? null : null;
  const visible = input.evidence === 'denied' || input.evidence === 'invalid' ? null : input.summary;
  return Object.freeze({ provider: input.provider, requested: input.pin, init: visible?.model ?? null, usage: visible?.models ?? null,
    verdict: sealed ? verification?.status ?? 'unverified' : input.evidence === 'invalid' ? 'unverified' : 'pending',
    unexpected: verification?.unexpected ?? Object.freeze([]), evidence: input.evidence });
}
