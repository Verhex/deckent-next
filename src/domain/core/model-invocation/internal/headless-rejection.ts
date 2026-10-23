import { z } from 'zod';
import { counterSchema } from '#domain/core/primitives/index.js';

/**
 * S3 headless step: the adapter-composed body of a rejected receipt (never CLI output, model text or stderr), so a consumer can name the cause:
 * `guard` (field), `model-mismatch`, `quota` (resetsAtMs), `credits-required`, `login-required`, `invalid-output` (subtype), `provider-error`
 * (status), `response-limit`.
 */
export const headlessRejectionBodySchema = z.object({ schemaVersion: z.literal(1),
  refusal: z.enum(['guard', 'model-mismatch', 'quota', 'credits-required', 'login-required', 'invalid-output', 'provider-error', 'response-limit']),
  field: z.string().max(64).optional(), subtype: z.string().max(64).optional(), resetsAtMs: counterSchema.nullable().optional(), status: counterSchema.nullable().optional(),
}).strict().readonly();
export type HeadlessRejectionBody = z.infer<typeof headlessRejectionBodySchema>;
/** The headless body of a rejected receipt's evidence (base64 JSON), or null when the evidence is another adapter's or not this shape. */
export function readHeadlessRejection(evidence: Readonly<{ adapter: Readonly<{ id: string }>; body: Readonly<{ data: string }> }>, adapterId: string): HeadlessRejectionBody | null {
  if (evidence.adapter.id !== adapterId) return null;
  try { const parsed = headlessRejectionBodySchema.safeParse(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(evidence.body.data), char => char.charCodeAt(0))))); return parsed.success ? parsed.data : null; }
  catch { return null; }
}
