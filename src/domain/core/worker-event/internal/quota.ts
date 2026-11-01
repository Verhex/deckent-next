import { persistedInteger } from '#platform/core/validate/index.js';
import { z } from 'zod';
export const quotaExhaustedSchema = z.strictObject({ window: z.string().max(32).optional(), resetsAtMs: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
  source: z.enum(['claude-rate-limit', 'codex-text', 'exit-text']) }).readonly();
export type QuotaExhausted = z.infer<typeof quotaExhaustedSchema>;
