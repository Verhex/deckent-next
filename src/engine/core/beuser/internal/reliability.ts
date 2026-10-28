import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import { beuserVerdictSchema, type BeuserVerdict } from '#domain/core/beuser/index.js';
import { BeuserContractError, type BeuserLimits } from '#engine/core/beuser-contract/index.js';
import { beuserBounded, type BeuserExecutionBudget } from './controller.js';

const count = z.number().int().nonnegative().safe(), rate = z.number().min(0).max(1).finite();
export const beuserCalibrationSchema = z.object({ revision: identitySchema, blindSetDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  bad: count.positive(), hits: count, good: count.positive(), falseReds: count }).strict()
  .refine(row => row.hits <= row.bad && row.falseReds <= row.good).readonly();
export const beuserReliabilityPolicySchema = z.object({ revision: identitySchema, minHitRate: rate, maxFalseRedRate: rate }).strict().readonly();
export type BeuserCalibration = z.infer<typeof beuserCalibrationSchema>;
export interface BeuserReliabilitySample {
  readonly verdict: BeuserVerdict;
  readonly calibration: BeuserCalibration;
  readonly independent: boolean;
  readonly repetitions: readonly BeuserVerdict[];
  readonly cleanupProven: boolean;
  readonly unresolvedEffects: boolean;
  readonly choice: BeuserRerunChoice;
}
export interface BeuserRerunChoice {
  readonly modelKey: string; readonly personaDigest: string;
}
/** Deterministic authorization/safety failures survive every experience rerun and reduced-maker label. */
export function assessBeuserReliability(sample: BeuserReliabilitySample, limits: BeuserLimits, policyInput: unknown) {
  const policy = beuserReliabilityPolicySchema.parse(policyInput), calibration = beuserCalibrationSchema.parse(sample.calibration), v = beuserVerdictSchema.parse(sample.verdict);
  const calibrated = calibration.hits / calibration.bad >= policy.minHitRate && calibration.falseReds / calibration.good <= policy.maxFalseRedRate;
  const repetitions = sample.repetitions.map(value => beuserVerdictSchema.parse(value)).filter(value => value.validity === 'valid' && value.outcome !== 'unknown'
    && value.binding.candidateDigest === v.binding.candidateDigest && value.binding.rubricDigest === v.binding.rubricDigest
    && value.binding.personaDigest === v.binding.personaDigest && value.binding.journeyDigest === v.binding.journeyDigest
    && value.binding.identity.scopeId === v.binding.identity.scopeId && value.binding.identity.runId === v.binding.identity.runId);
  const tasks = new Set<string>(), realms = new Set<string>(), nonces = new Set<string>();
  for (const value of repetitions) {
    const b = value.binding;
    if (tasks.has(b.identity.taskId) || realms.has(b.realmId) || nonces.has(b.nonce)) continue;
    tasks.add(b.identity.taskId); realms.add(b.realmId); nonces.add(b.nonce);
  }
  const completedCriticalRepetitions = tasks.size;
  const reliable = calibrated && completedCriticalRepetitions >= limits.criticalRepetitions
    && sample.cleanupProven && !sample.unresolvedEffects && v.validity === 'valid';
  const outcome = v.outcome === 'RED' || v.authorization === 'fail' || v.safety === 'fail' ? 'RED'
    : !reliable || v.authorization === 'unknown' || v.safety === 'unknown' ? 'unknown' : v.outcome;
  return Object.freeze({ outcome, calibrated, independence: sample.independent && v.independence === 'independent' ? 'independent' as const : 'reduced' as const,
    acceptanceEvidence: reliable && outcome !== 'unknown', completedCriticalRepetitions, hitRate: calibration.hits / calibration.bad,
    falseRedRate: calibration.falseReds / calibration.good, calibrationRevision: calibration.revision, policyRevision: policy.revision });
}
/** Reruns are fresh Tasks, not loss Attempts. The caller shares its conservative invocation envelope across them. */
export async function runBeuserReliability(input: {
  readonly budget: BeuserExecutionBudget;
  readonly limits: BeuserLimits; readonly policy: unknown; readonly first: BeuserReliabilitySample;
  readonly alternatives: readonly BeuserRerunChoice[];
  readonly rerun: (choice: BeuserRerunChoice, previous: BeuserReliabilitySample, budget: BeuserExecutionBudget) => Promise<BeuserReliabilitySample>;
}) {
  if (JSON.stringify(input.budget.limits) !== JSON.stringify(input.limits)) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE');
  try {
    const policy = beuserReliabilityPolicySchema.parse(input.policy), blind = beuserCalibrationSchema.parse(input.first.calibration);
    const pinned = beuserVerdictSchema.parse(input.first.verdict).binding;
    if (input.first.choice.personaDigest !== pinned.personaDigest) throw new BeuserContractError('BEUSER_INPUT_INVALID');
    const samples = [input.first], seen = new Set([JSON.stringify(input.first.choice)]);
    const rerunEvidence: { choice: BeuserRerunChoice; reason: 'calibration' | 'independence' | 'calibration-and-independence'; state: 'completed' | 'unknown' }[] = [];
    let current = input.first, result = assessBeuserReliability(current, input.limits, policy);
    for (const choice of input.alternatives) {
      if (result.calibrated && result.independence === 'independent' || rerunEvidence.length >= input.limits.maxReruns
        || !current.cleanupProven || current.unresolvedEffects || current.verdict.validity !== 'valid') break;
      const key = JSON.stringify(choice);
      if (seen.has(key) || choice.modelKey === current.choice.modelKey && choice.personaDigest === current.choice.personaDigest) continue;
      seen.add(key);
      if (input.budget.signal.aborted) { result = { ...result, outcome: 'unknown', acceptanceEvidence: false }; break; }
      const attempt = { choice, reason: !result.calibrated && result.independence !== 'independent' ? 'calibration-and-independence' as const
        : !result.calibrated ? 'calibration' as const : 'independence' as const, state: 'unknown' as 'completed' | 'unknown' };
      rerunEvidence.push(attempt);
      let next: BeuserReliabilitySample;
      try { next = await beuserBounded(input.budget.signal, () => input.rerun(choice, current, input.budget)); }
      catch { result = { ...result, outcome: 'unknown', acceptanceEvidence: false }; break; }
      if (JSON.stringify(next.choice) !== key || next.calibration.blindSetDigest !== blind.blindSetDigest
        || next.calibration.revision !== blind.revision || next.verdict.binding.candidateDigest !== pinned.candidateDigest
        || JSON.stringify(next.verdict.binding.candidate) !== JSON.stringify(pinned.candidate) || next.verdict.binding.journeyDigest !== pinned.journeyDigest
        || next.verdict.binding.identity.scopeId !== pinned.identity.scopeId || next.verdict.binding.identity.runId !== pinned.identity.runId
        || next.verdict.binding.identity.layoutRevision !== pinned.identity.layoutRevision || next.verdict.binding.personaDigest !== choice.personaDigest
        || next.verdict.binding.rubricDigest !== pinned.rubricDigest
        || next.verdict.binding.identity.taskId === current.verdict.binding.identity.taskId
        || next.verdict.binding.realmId === current.verdict.binding.realmId || next.verdict.binding.nonce === current.verdict.binding.nonce) throw new BeuserContractError('BEUSER_INPUT_INVALID');
      attempt.state = 'completed'; samples.push(next); current = next; result = assessBeuserReliability(current, input.limits, policy);
    }
    const red = samples.some(sample => sample.verdict.outcome === 'RED' || sample.verdict.authorization === 'fail' || sample.verdict.safety === 'fail');
    if (input.budget.signal.aborted) result = { ...result, outcome: 'unknown', acceptanceEvidence: false };
    return Object.freeze({ ...result, outcome: red ? 'RED' as const : result.outcome, samples: Object.freeze(samples), reruns: rerunEvidence.length,
      rerunEvidence: Object.freeze(rerunEvidence.map(entry => Object.freeze(entry))) });
  } finally { input.budget.close(); }
}
