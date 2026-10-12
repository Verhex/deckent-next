import { costComparisonTrialSchema, sameAttemptIdentity, executionRegistrySchema, recommendCostProfile, type CostComparisonTrial, type CostRecommendationPolicy, type WorkCostReport } from '#domain/index.js';
/** The evidence port requires attributable held-out pairs. Current worker traces contain no full
 * follow-up/human-impact witness and cannot fabricate such pairs from accepted Task counts. */
export function recommendRunWorkCosts(report: WorkCostReport, registry: unknown, policy: CostRecommendationPolicy,
  trials: readonly CostComparisonTrial[] = []): WorkCostReport {
  const parsed = executionRegistrySchema.safeParse(registry);
  const allowed = parsed.success ? parsed.data.profiles.map(profile => `${profile.id}@${profile.version}`) : [];
  const checked = trials.length <= policy.maxEvidenceEntries ? trials.map(row => costComparisonTrialSchema.safeParse(row)) : [];
  const admittedTrials = checked.every(row => row.success && report.attempts.some(attempt => sameAttemptIdentity(attempt.identity, row.data.identity)))
    ? checked.flatMap(row => row.success ? [row.data] : []) : [];
  const classes = new Map<string, string>();
  for (const row of report.attempts) if (row.acceptance.workClass && !classes.has(row.acceptance.workClass)) classes.set(row.acceptance.workClass, `${row.profile.id}@${row.profile.version}`);
  let recommendationsTruncated = false;
  const recommendations = [...classes].flatMap(([workClass, baselineProfile]) => {
    const allCandidates = allowed.filter(key => key !== baselineProfile), candidates = allCandidates.slice(0, policy.maxCandidates);
    recommendationsTruncated ||= candidates.length < allCandidates.length;
    const confidence = 1 - (1 - policy.confidence) / Math.max(1, candidates.length), representable = confidence < 1;
    const comparisonPolicy = { ...policy, confidence: representable ? confidence : policy.confidence };
    return (candidates.length ? candidates : [baselineProfile]).map(candidateProfile => recommendCostProfile({ workClass, baselineProfile, candidateProfile,
      axis: policy.axis, allowedProfiles: allowed, trials: representable ? admittedTrials : [], policy: comparisonPolicy }));
  });
  return Object.freeze({ ...report, recommendations: Object.freeze(recommendations), recommendationsTruncated });
}
