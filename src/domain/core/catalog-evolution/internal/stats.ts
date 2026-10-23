import { FAILURE_CAUSES } from '#domain/core/run/index.js';

/** One whole in micro-units (rates, bounds and shares are integers in [0, STATS_MICRO]). */
export const STATS_MICRO = 1_000_000;
type FailureCause = typeof FAILURE_CAUSES[number];
/** S8-DESIGN §4 fold B: the only failures that count against an agent; every other cause (and `unattributed`) is its own bucket no rule reads. */
export const ATTRIBUTABLE_FAILURE_CAUSES = Object.freeze(['criteria-failed', 'worker-report-failed', 'human-rejected'] as const satisfies readonly FailureCause[]);
export const NON_ATTRIBUTABLE_FAILURE_CAUSES = Object.freeze(FAILURE_CAUSES.filter(cause => !(ATTRIBUTABLE_FAILURE_CAUSES as readonly string[]).includes(cause)));
export const attributableFailure = (cause: string | undefined) => cause !== undefined && (ATTRIBUTABLE_FAILURE_CAUSES as readonly string[]).includes(cause);

const isqrtCeil = (value: bigint) => {
  if (value < 2n) return value;
  let x = value, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + value / x) / 2n; }
  return x * x === value ? x : x + 1n;
};
/**
 * Wilson score interval on (successes, n) for z = zMicro / STATS_MICRO, in integer micro-units — no floating point, so every platform gives the same
 * bytes. With M = STATS_MICRO, a = zMicro: bounds = (2nsM² + a²n ∓ a·√R) / (2n(nM² + a²)), R = 4M²ns(n−s) + a²n². The square root is rounded up and the
 * lower bound floored, the upper ceiled (conservative both ways). n = 0 has no interval. It corrects for small samples only, never for task
 * difficulty or model differences ("ilişki, nedensellik değil").
 */
export function wilsonIntervalMicro(successes: number, n: number, zMicro: number): { readonly lowerMicro: number; readonly upperMicro: number } | null {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(n) || successes < 0 || successes > n || !Number.isSafeInteger(zMicro) || zMicro <= 0) throw new RangeError('WILSON_INPUT');
  if (n === 0) return null;
  const N = BigInt(n), S = BigInt(successes), M = BigInt(STATS_MICRO), A = BigInt(zMicro);
  const root = A * isqrtCeil(4n * M * M * N * S * (N - S) + A * A * N * N), center = 2n * N * S * M * M + A * A * N, denominator = 2n * N * (N * M * M + A * A);
  const lower = center - root <= 0n ? 0n : ((center - root) * M) / denominator, upper = ((center + root) * M + denominator - 1n) / denominator;
  return Object.freeze({ lowerMicro: Number(lower), upperMicro: Number(upper > M ? M : upper) });
}
/** Exact nearest-rank order statistic: the value at rank ⌈p·N⌉ of the ascending values (p in micro-units); empty input has none. */
export function nearestRankMicro(values: readonly number[], pMicro: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), rank = Math.floor((pMicro * sorted.length + STATS_MICRO - 1) / STATS_MICRO);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}
