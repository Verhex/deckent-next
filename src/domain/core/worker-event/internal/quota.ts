import { z } from 'zod';
export const quotaExhaustedSchema = z.object({ window: z.string().max(32).optional(), resetsAtMs: z.number().int().nonnegative().safe().nullable(),
  source: z.enum(['claude-rate-limit', 'codex-text', 'exit-text']) }).strict().readonly();
export type QuotaExhausted = z.infer<typeof quotaExhaustedSchema>;
