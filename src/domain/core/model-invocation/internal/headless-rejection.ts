import { z } from 'zod';
import { counterSchema } from '#domain/core/primitives/index.js';

/**
 * S3 headless step: the adapter-composed body of a rejected receipt (never CLI output, model text or stderr), so a consumer can name the cause:
 * `guard` (field), `model-mismatch`, `quota` (resetsAtMs), `credits-required`, `login-required`, `invalid-output` (subtype), `provider-error`
 * (status), `response-limit`.
 */
/** A host name as the isolated CLI asked the gateway for it (DNS grammar, lower case): never a path, port, payload or credential. */
export const HEADLESS_EGRESS_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
/**
 * f5: what the realm's network gateway did during one call: tunnels opened, refusals, and the refused host names with their counts (`other`:
 * refusals without a valid host name, or past the adapter's host bound). Counts and names only, never a payload.
 */
export const headlessEgressSchema = z.object({ connected: counterSchema, refused: counterSchema,
  // Distinct names are bounded by the gateway's registry bound (`refusedHostsMax`); the rest is `other`.
  hosts: z.record(z.string().regex(HEADLESS_EGRESS_HOST), counterSchema), other: counterSchema,
}).strict().refine(value => Object.values(value.hosts).reduce((sum, count) => sum + count, value.other) === value.refused).readonly();
export type HeadlessEgress = z.infer<typeof headlessEgressSchema>;
/** f5: `resource-limit` = a realm process bound stopped the CLI (`field`: cpu-time, processes or memory). `egress`: the call's gateway summary. */
export const headlessRejectionBodySchema = z.object({ schemaVersion: z.literal(1),
  refusal: z.enum(['guard', 'model-mismatch', 'quota', 'credits-required', 'login-required', 'invalid-output', 'provider-error', 'response-limit', 'resource-limit']),
  field: z.string().max(64).optional(), subtype: z.string().max(64).optional(), resetsAtMs: counterSchema.nullable().optional(), status: counterSchema.nullable().optional(),
  egress: headlessEgressSchema.optional(),
}).strict().readonly();
export type HeadlessRejectionBody = z.infer<typeof headlessRejectionBodySchema>;
/** The headless step's adapter id (its evidence is the only one whose body is read as this shape). */
export const NATIVE_CLI_HEADLESS_ADAPTER_ID = 'native-cli-headless';
/** The headless body of a rejected receipt's evidence (base64 JSON), or null when the evidence is another adapter's or not this shape. */
export function readHeadlessRejection(evidence: Readonly<{ adapter: Readonly<{ id: string }>; body: Readonly<{ data: string }> }>): HeadlessRejectionBody | null {
  if (evidence.adapter.id !== NATIVE_CLI_HEADLESS_ADAPTER_ID) return null;
  try { const parsed = headlessRejectionBodySchema.safeParse(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(evidence.body.data), char => char.charCodeAt(0))))); return parsed.success ? parsed.data : null; }
  catch { return null; }
}
/** f5: the gateway summary of a headless invocation's stored content (the rejected body, or the responded native response's `headless` block); null
 * for another adapter, purged content or a record without one. */
export function readHeadlessEgress(adapterId: string, content: Readonly<{ kind: string; data?: string; response?: unknown }> | null | undefined): HeadlessEgress | null {
  if (adapterId !== NATIVE_CLI_HEADLESS_ADAPTER_ID || !content) return null;
  if (content.kind === 'response-body' && typeof content.data === 'string') return readHeadlessRejection({ adapter: { id: adapterId }, body: { data: content.data } })?.egress ?? null;
  const headless = (content.response as { native?: { headless?: { egress?: unknown } } } | undefined)?.native?.headless;
  const parsed = headlessEgressSchema.safeParse(headless?.egress);
  return parsed.success ? parsed.data : null;
}
