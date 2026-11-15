export type ClaudeQuotaPolicy = Readonly<{ claudeRejectedStatuses: readonly string[]; claudeAllowedStatuses: readonly string[] }>;
export type ClaudeRateLimit = Readonly<{ kind: 'allowed' | 'overage' | 'quota' | 'credits-required' | 'unknown'; status: string; window: string; resetsAtMs: number | null }>;
/** Only bounded identifier values leave the CLI boundary; controls, whitespace and terminal escapes cannot reach records or rendering. */
const identifier = (value: unknown, max: number) => typeof value === 'string' && value.length ? value.slice(0, max).replace(/[^A-Za-z0-9_.:-]/gu, '_') : '?';
const TIMESTAMP_SCALE = 1000; // CLI Unix seconds become the receipt's milliseconds.
/** Shared classification; callers keep their own unknown-status and notice policies. */
export function classifyClaudeRateLimit(info: Readonly<Record<string, unknown>>, policy: ClaudeQuotaPolicy, creditsErrors: readonly string[], paidExtraUsage: 'continue' | 'stop-at-limit'): ClaudeRateLimit {
  const status = typeof info.status === 'string' ? info.status : null, seconds = info.resetsAt;
  const resetsAtMs = typeof seconds === 'number' && seconds >= 0 && Number.isSafeInteger(Math.round(seconds * TIMESTAMP_SCALE))
    && Number.isFinite(new Date(Math.round(seconds * TIMESTAMP_SCALE)).getTime()) ? Math.round(seconds * TIMESTAMP_SCALE) : null;
  const rejected = status !== null && policy.claudeRejectedStatuses.includes(status);
  const allowed = status !== null && policy.claudeAllowedStatuses.includes(status);
  const overage = info.isUsingOverage === true || info.overageInUse === true
    || rejected && typeof info.overageStatus === 'string' && policy.claudeAllowedStatuses.includes(info.overageStatus);
  const kind = typeof info.errorCode === 'string' && creditsErrors.includes(info.errorCode) ? 'credits-required'
    : !rejected && !allowed ? 'unknown'
      : overage ? paidExtraUsage === 'stop-at-limit' ? 'quota' : 'overage'
        : rejected ? 'quota'
          : 'allowed';
  return { kind, status: identifier(status, 16), window: identifier(info.rateLimitType, 24), resetsAtMs };
}

