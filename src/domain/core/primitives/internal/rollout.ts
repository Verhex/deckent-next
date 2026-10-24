/** One measured rollout value: `count` of `sample` (and of `of` when the whole of a known set is required). */
export type RolloutMeasure = Readonly<{ count: number; sample: number; of: number | null }>;
/** A rollout exit criterion's bounds (registry data); ratios are integers per mille, so no floating comparison decides a gate. */
export type RolloutBounds = Readonly<{ minSample?: number | undefined; minPerMille?: number | undefined; maxPerMille?: number | undefined; maxCount?: number | undefined }>;
const PER_MILLE = 1000;
/** Pure: whether `value` meets `criterion` (shared by the memory and recovery rollouts; an unread value is unmet, never assumed). */
export function rolloutCriterionMet(criterion: RolloutBounds, value: RolloutMeasure | null | undefined): boolean {
  if (!value || value.sample < (criterion.minSample ?? 0) || (value.of !== null && value.sample < value.of)) return false;
  if (criterion.maxCount !== undefined && value.count > criterion.maxCount) return false;
  if (criterion.minPerMille !== undefined && value.count * PER_MILLE < criterion.minPerMille * value.sample) return false;
  return criterion.maxPerMille === undefined || value.count * PER_MILLE <= criterion.maxPerMille * value.sample;
}
