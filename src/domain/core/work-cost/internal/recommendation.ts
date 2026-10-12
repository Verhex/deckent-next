import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { attemptIdentitySchema } from '#domain/core/attempt/index.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const axis = z.enum(['cpu-seconds', 'wall-ms', 'api-usd-nanos', 'subscription-ms']);
export const costRecommendationPolicySchema = z.object({ axis, maxCandidates: z.number().int().positive().safe(), minPairs: z.number().int().positive().safe(), confidence: z.number().positive().lt(1),
  maxLossRisk: z.number().positive().lt(1), maxEvidenceEntries: z.number().int().positive().safe() }).strict().readonly();
export type CostRecommendationPolicy = z.infer<typeof costRecommendationPolicySchema>;
export const costComparisonTrialSchema = z.object({ evidenceId: digest, pairId: digest, workClass: identitySchema, profileKey: identitySchema,
  identity: attemptIdentitySchema,
  workloadDigest: digest, criterionDigest: digest, environmentDigest: digest, splitDigest: digest, policyRevision: identitySchema,
  axis, cost: z.number().nonnegative().finite().nullable(),
  accepted: z.boolean().nullable(), score: z.number().min(0).max(1).nullable(), safetyViolation: z.boolean().nullable(),
  modelVerified: z.boolean(), heldOut: z.boolean(), followupComplete: z.boolean(),
  criteria: z.array(z.object({ id: identitySchema, verdict: z.enum(['pass', 'fail', 'unknown']) }).strict().readonly()).min(1).max(256)
    .refine(rows => new Set(rows.map(row => row.id)).size === rows.length).readonly(),
  interventions: z.number().int().nonnegative().safe().nullable(), rework: z.number().int().nonnegative().safe().nullable(), rollbacks: z.number().int().nonnegative().safe().nullable(),
}).strict().refine(row => row.axis !== 'api-usd-nanos' || row.cost === null || Number.isSafeInteger(row.cost)).readonly();
export type CostComparisonTrial = z.infer<typeof costComparisonTrialSchema>;
export const costRecommendationSchema = z.object({ schemaVersion: z.literal(1), authority: z.literal('proposal-only'), workClass: identitySchema,
  baselineProfile: identitySchema, candidateProfile: identitySchema, axis,
  state: z.enum(['proposal', 'insufficient-evidence', 'quality-loss', 'no-savings']),
  reason: z.enum(['paired-savings', 'unregistered-profile', 'evidence-conflict', 'unmatched-evidence', 'quality-unknown', 'sample-size', 'risk-bound', 'quality-regression', 'cost-unknown', 'no-cost-gain']),
  evidencePairs: z.number().int().nonnegative().safe(), lossRiskUpper: z.number().min(0).max(1).nullable(), confidence: z.number().positive().lt(1),
  baselineMean: z.number().nonnegative().finite().nullable(), candidateMean: z.number().nonnegative().finite().nullable(), savingFraction: z.number().finite().nullable(),
}).strict().readonly();
export type CostRecommendation = z.infer<typeof costRecommendationSchema>;
/** Pure paired held-out comparison. The one-sided zero-loss binomial bound assumes independent
 * representative pairs; it does not guarantee future quality. Unknown never becomes success. */
export function recommendCostProfile(input: { workClass: string; baselineProfile: string; candidateProfile: string; axis: CostComparisonTrial['axis'];
  allowedProfiles: readonly string[]; trials: readonly CostComparisonTrial[]; policy: CostRecommendationPolicy }): CostRecommendation {
  const policy = costRecommendationPolicySchema.parse(input.policy);
  let evidencePairs = 0, lossRiskUpper: number | null = null, baselineMean: number | null = null, candidateMean: number | null = null;
  const result = (state: CostRecommendation['state'], reason: CostRecommendation['reason']): CostRecommendation => costRecommendationSchema.parse({
    schemaVersion: 1, authority: 'proposal-only', workClass: input.workClass, baselineProfile: input.baselineProfile, candidateProfile: input.candidateProfile, axis: input.axis,
    state, reason, evidencePairs, lossRiskUpper, confidence: policy.confidence, baselineMean, candidateMean,
    savingFraction: baselineMean !== null && baselineMean > 0 && candidateMean !== null ? (baselineMean - candidateMean) / baselineMean : null });
  if (input.baselineProfile === input.candidateProfile || ![input.baselineProfile, input.candidateProfile].every(key => input.allowedProfiles.includes(key))) return result('insufficient-evidence', 'unregistered-profile');
  if (input.axis !== policy.axis) return result('insufficient-evidence', 'cost-unknown');
  if (input.trials.length > policy.maxEvidenceEntries) return result('insufficient-evidence', 'unmatched-evidence');
  const unique = new Map<string, CostComparisonTrial>();
  const attempts = new Map<string, string>();
  for (const raw of input.trials) {
    const row = costComparisonTrialSchema.parse(raw);
    if (row.workClass !== input.workClass || row.axis !== input.axis || ![input.baselineProfile, input.candidateProfile].includes(row.profileKey)) continue;
    const id = row.identity, key = JSON.stringify([id.scopeId, id.runId, id.taskId, id.attemptId, id.generation, id.layoutRevision, row.axis]);
    const previousEvidence = attempts.get(key);
    if (previousEvidence && previousEvidence !== row.evidenceId) return result('insufficient-evidence', 'evidence-conflict'); attempts.set(key, row.evidenceId);
    const existing = unique.get(row.evidenceId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(row)) return result('insufficient-evidence', 'evidence-conflict'); unique.set(row.evidenceId, row);
  }
  const pairs = new Map<string, Map<string, CostComparisonTrial>>();
  for (const row of unique.values()) { const pair = pairs.get(row.pairId) ?? new Map<string, CostComparisonTrial>();
    if (pair.has(row.profileKey)) return result('insufficient-evidence', 'evidence-conflict'); pair.set(row.profileKey, row); pairs.set(row.pairId, pair); }
  let incomplete = false, unknown = false, missingCost = false, loss = false;
  const baselines: number[] = [], candidates: number[] = [];
  for (const pair of pairs.values()) {
    const base = pair.get(input.baselineProfile), candidate = pair.get(input.candidateProfile);
    if (!base || !candidate || base.identity.scopeId !== candidate.identity.scopeId || base.workloadDigest !== candidate.workloadDigest || base.criterionDigest !== candidate.criterionDigest
      || base.environmentDigest !== candidate.environmentDigest || base.splitDigest !== candidate.splitDigest || base.policyRevision !== candidate.policyRevision) { incomplete = true; continue; }
    evidencePairs++;
    const candidateCriteria = new Map(candidate.criteria.map(row => [row.id, row.verdict]));
    if (base.criteria.some(row => row.verdict === 'pass' && candidateCriteria.get(row.id) === 'fail')) loss = true;
    if (base.criteria.length !== candidate.criteria.length || base.criteria.some(row => !candidateCriteria.has(row.id))
      || [...base.criteria, ...candidate.criteria].some(row => row.verdict !== 'pass')) unknown = true;
    if (candidate.safetyViolation === true || (base.accepted === true && candidate.accepted === false) || (base.score !== null && candidate.score !== null && candidate.score < base.score)
      || (base.interventions !== null && candidate.interventions !== null && candidate.interventions > base.interventions)
      || (base.rework !== null && candidate.rework !== null && candidate.rework > base.rework) || (base.rollbacks !== null && candidate.rollbacks !== null && candidate.rollbacks > base.rollbacks)) loss = true;
    if ([base, candidate].some(row => row.accepted !== true || row.score === null || row.safetyViolation !== false || !row.modelVerified || !row.heldOut || !row.followupComplete
      || row.interventions === null || row.rework === null || row.rollbacks === null)) unknown = true;
    if (base.cost === null || candidate.cost === null) missingCost = true; else { baselines.push(base.cost); candidates.push(candidate.cost); }
  }
  if (loss) return result('quality-loss', 'quality-regression');
  if (incomplete || !evidencePairs) return result('insufficient-evidence', 'unmatched-evidence');
  if (unknown) return result('insufficient-evidence', 'quality-unknown');
  if (missingCost) return result('insufficient-evidence', 'cost-unknown');
  if (evidencePairs < policy.minPairs) return result('insufficient-evidence', 'sample-size');
  lossRiskUpper = 1 - Math.pow(1 - policy.confidence, 1 / evidencePairs);
  if (lossRiskUpper > policy.maxLossRisk) return result('insufficient-evidence', 'risk-bound');
  baselineMean = baselines.reduce((sum, value) => sum + value, 0) / evidencePairs; candidateMean = candidates.reduce((sum, value) => sum + value, 0) / evidencePairs;
  if (!Number.isFinite(baselineMean) || !Number.isFinite(candidateMean)) { baselineMean = null; candidateMean = null; return result('insufficient-evidence', 'cost-unknown'); }
  return candidateMean < baselineMean ? result('proposal', 'paired-savings') : result('no-savings', 'no-cost-gain');
}
