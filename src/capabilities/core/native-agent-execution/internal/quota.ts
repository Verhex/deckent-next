import type { HeadlessRejectionBody } from '#domain/index.js';
import { ErrorRegistry, clockText, messageText, getConfigFieldDefault, t, type Locale } from '#platform/index.js';

import { classifyClaudeRateLimit as classify, type ClaudeQuotaPolicy, type ClaudeRateLimit } from './quota-rule.js';
export type { ClaudeQuotaPolicy, ClaudeRateLimit } from './quota-rule.js';
/** Registry classification shared with the standalone worker's generated copy. */
export const classifyClaudeRateLimit = (info: Readonly<Record<string, unknown>>, policy: ClaudeQuotaPolicy, creditsErrors: readonly string[],
  paidExtraUsage: 'continue' | 'stop-at-limit' = getConfigFieldDefault('models').headless.paidExtraUsage) => classify(info, policy, creditsErrors, paidExtraUsage);

/** Map only to fields and refusal values accepted by the existing strict v1 reader. */
export function nativeQuotaRejection(limit: ClaudeRateLimit): Omit<Extract<HeadlessRejectionBody, { schemaVersion: 1 }>, 'schemaVersion'> {
  return limit.kind === 'unknown'
    ? { refusal: 'guard', field: 'agent-surface:rate-limit-status', subtype: `${limit.status} ${limit.window}`, resetsAtMs: limit.resetsAtMs }
    : { refusal: limit.kind === 'credits-required' ? 'credits-required' : 'quota', field: limit.window, subtype: limit.status, resetsAtMs: limit.resetsAtMs, status: null };
}

/** Existing rejection fields only: status in subtype, window in field, reset in resetsAtMs. No new durable vocabulary. */
export function nativeQuotaText(body: HeadlessRejectionBody, locale: Locale): string | null {
  if (body.schemaVersion !== 1 && body.schemaVersion !== 5) return null;
  if (body.refusal === 'credits-required') return t('error.HEADLESS_CREDITS_REQUIRED', {}, locale);
  if (body.refusal === 'guard' && body.field === 'agent-surface:rate-limit-status')
    return t('headless.chat.quotaUnknownStatus', { status: body.subtype ?? '?' }, locale);
  if (body.refusal !== 'quota') return null;
  // Historical result-only refusals and the untouched Codex signals carry no Claude status/window facts.
  return ErrorRegistry.get('TERMINAL_CHAT_REJECTED', locale, { refusal: 'quota',
    ...(body.subtype !== undefined && { window: body.field ?? '?', ...(body.resetsAtMs != null && { resetsAtMs: body.resetsAtMs }) }) })!.message;
}

/** Bounded facts in open native metadata, rendered through the same window/reset message family. */
export function nativePaidUsageText(limit: Pick<ClaudeRateLimit, 'window' | 'resetsAtMs'>, locale: Locale): string {
  return t('headless.chat.paidExtraUsage', { window: messageText(`headless.chat.quotaWindow.${limit.window}`, locale)
    ?? (limit.window === '?' ? t('headless.chat.quotaUnknown', {}, locale) : limit.window),
    reset: limit.resetsAtMs === null ? t('headless.chat.quotaUnknown', {}, locale) : clockText(limit.resetsAtMs) }, locale);
}
