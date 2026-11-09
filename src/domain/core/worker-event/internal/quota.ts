import { persistedString } from '#domain/core/primitives/index.js';
import { z } from 'zod';
export const quotaExhaustedSchema = z.strictObject({ window: persistedString(z.string().max(32)).optional(), resetsAtMs: z.number().refine(Number.isInteger, { params: { legacyCode: 'invalid_type' } }).meta({ type: 'integer' }).nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
  source: z.enum(['claude-rate-limit', 'codex-text', 'exit-text']) }).readonly();
export type QuotaExhausted = z.infer<typeof quotaExhaustedSchema>;
/** Law 6: per signal source, whether its reset time is evidence enough to resume a wait (only a structured provider rate-limit event carries one). */
export const QUOTA_RESET_EVIDENCE: Readonly<Record<QuotaExhausted['source'], boolean>> = Object.freeze({ 'claude-rate-limit': true, 'codex-text': false, 'exit-text': false });
