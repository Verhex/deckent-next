import type { HeadlessRejectionBody } from '#domain/index.js';
import { clockText, messageText, getConfigFieldDefault, t, type Locale } from '#platform/index.js';

export type ClaudeQuotaPolicy = Readonly<{ claudeRejectedStatuses: readonly string[]; claudeAllowedStatuses: readonly string[] }>;
export type ClaudeRateLimit = Readonly<{ kind: 'allowed' | 'overage' | 'quota' | 'credits-required' | 'unknown'; status: string; window: string; resetsAtMs: number | null }>;
/** Only bounded identifier values leave the CLI boundary; controls, whitespace and terminal escapes cannot reach records or rendering. */
const identifier = (value: unknown, max: number) => typeof value === 'string' && value.length ? value.slice(0, max).replace(/[^A-Za-z0-9_.:-]/gu, '_') : '?';
const TIMESTAMP_SCALE = 1000; // CLI Unix seconds become the receipt's milliseconds.
/** Shared by the two host paths. Unknown stays a separate classification so each keeps its own stopping policy. */
export function classifyClaudeRateLimit(info: Readonly<Record<string, unknown>>, policy: ClaudeQuotaPolicy, creditsErrors: readonly string[], paidExtraUsage: 'continue' | 'stop-at-limit' = getConfigFieldDefault('models').headless.paidExtraUsage): ClaudeRateLimit {
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
        : rejected && (!info.overageStatus || policy.claudeRejectedStatuses.includes(String(info.overageStatus))) ? 'quota'
          : 'allowed';
  return { kind, status: identifier(status, 16), window: identifier(info.rateLimitType, 24), resetsAtMs };
}

/** Map only to fields and refusal values accepted by the existing strict v1 reader. */
export function nativeQuotaRejection(limit: ClaudeRateLimit): Omit<Extract<HeadlessRejectionBody, { schemaVersion: 1 }>, 'schemaVersion'> {
  return limit.kind === 'unknown'
    ? { refusal: 'guard', field: 'agent-surface:rate-limit-status', subtype: `${limit.status} ${limit.window}`, resetsAtMs: limit.resetsAtMs }
    : { refusal: limit.kind === 'credits-required' ? 'credits-required' : 'quota', field: limit.window, subtype: limit.status, resetsAtMs: limit.resetsAtMs, status: null };
}

/** Existing v1 fields only: status in subtype, window in field, reset in resetsAtMs. No new durable vocabulary. */
export function nativeQuotaText(body: HeadlessRejectionBody, locale: Locale): string | null {
  if (body.schemaVersion !== 1) return null;
  if (body.refusal === 'credits-required') return t('error.HEADLESS_CREDITS_REQUIRED', {}, locale);
  if (body.refusal === 'guard' && body.field === 'agent-surface:rate-limit-status')
    return t('headless.chat.quotaUnknownStatus', { status: body.subtype ?? '?' }, locale);
  if (body.refusal !== 'quota') return null;
  // Historical result-only refusals and the untouched Codex signals carry no Claude status/window facts.
  if (body.subtype === undefined) return t('headless.chat.quotaFallback', {}, locale);
  const window = body.field ?? '?';
  return t('headless.chat.quota', { window: messageText(`headless.chat.quotaWindow.${window}`, locale)
    ?? (window === '?' ? t('headless.chat.quotaUnknown', {}, locale) : window),
    reset: typeof body.resetsAtMs === 'number' ? clockText(body.resetsAtMs) : t('headless.chat.quotaUnknown', {}, locale) }, locale);
}

/** Bounded facts in open native metadata, rendered through the same window/reset message family. */
export function nativePaidUsageText(limit: Pick<ClaudeRateLimit, 'window' | 'resetsAtMs'>, locale: Locale): string {
  return t('headless.chat.paidExtraUsage', { window: messageText(`headless.chat.quotaWindow.${limit.window}`, locale)
    ?? (limit.window === '?' ? t('headless.chat.quotaUnknown', {}, locale) : limit.window),
    reset: limit.resetsAtMs === null ? t('headless.chat.quotaUnknown', {}, locale) : clockText(limit.resetsAtMs) }, locale);
}
