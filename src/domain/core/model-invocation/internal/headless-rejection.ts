import { z } from 'zod';
import { counterSchema } from '#domain/core/primitives/index.js';

/** f5: a refused host name as asked (DNS grammar, lower case), never a port, path or payload. One call's gateway summary: tunnels, refusals and refused
 * names with counts (`other`: no valid name or past the gateway's `refusedHostsMax`). */
export const HEADLESS_EGRESS_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
export const headlessEgressReasonSchema = z.enum(['allowlist', 'dns', 'non-public', 'client-hello', 'byte-budget', 'gateway-closed', 'upstream', 'unknown']);
export type HeadlessEgressReason = z.infer<typeof headlessEgressReasonSchema>;
const reasonCounts = z.record(z.string().refine(key => headlessEgressReasonSchema.safeParse(key).success), counterSchema);
export const headlessEgressSchema = z.object({ connected: counterSchema, refused: counterSchema, hosts: z.record(z.string().regex(HEADLESS_EGRESS_HOST), counterSchema),
  other: counterSchema, reasons: z.record(z.string().regex(HEADLESS_EGRESS_HOST), reasonCounts).optional(), otherReasons: reasonCounts.optional() }).strict().refine(value => Object.values(value.hosts).reduce((sum, count) => sum + count, value.other) === value.refused)
  .refine(value => value.reasons === undefined && value.otherReasons === undefined || value.reasons !== undefined && value.otherReasons !== undefined
    && Object.keys(value.reasons).length === Object.keys(value.hosts).length
    && Object.entries(value.hosts).every(([host, count]) => Object.values(value.reasons![host] ?? {}).reduce((sum, n) => sum + n!, 0) === count)
    && Object.values(value.otherReasons).reduce((sum, n) => sum + n!, 0) === value.other).readonly();
export type HeadlessEgress = z.infer<typeof headlessEgressSchema>;
/** Legacy host counts carry no attribution; they are never labelled as allowlist failures. */
export function headlessEgressReasons(value: HeadlessEgress): { reasons: Record<string, Record<string, number>>; otherReasons: Record<string, number> } {
  return { reasons: value.reasons ?? Object.fromEntries(Object.entries(value.hosts).map(([host, count]) => [host, { unknown: count }])),
    otherReasons: value.otherReasons ?? { unknown: value.other } };
}
/**
 * S3 headless step: the adapter-composed body of a rejected receipt (never CLI output, model text or stderr), so a consumer can name the cause:
 * `guard` (field), `model-mismatch`, `quota` (resetsAtMs), `credits-required`, `login-required`, `invalid-output` (subtype), `provider-error`
 * (status), `response-limit`; f5: `resource-limit` (field: cpu-time, processes or memory) and `egress`, the call's gateway summary.
 */
const baseRejectionSchema = z.object({ schemaVersion: z.literal(1),
  refusal: z.enum(['guard', 'model-mismatch', 'quota', 'credits-required', 'login-required', 'invalid-output', 'provider-error', 'response-limit', 'resource-limit']),
  field: z.string().max(64).optional(), subtype: z.string().max(64).optional(), resetsAtMs: counterSchema.nullable().optional(), status: counterSchema.nullable().optional(),
  egress: headlessEgressSchema.optional() }).strict().readonly();
/** v1/v2 stay byte-compatible; older readers reject v3 instead of inventing quota or a reset time. */
export const headlessRejectionBodySchema = z.discriminatedUnion('schemaVersion', [baseRejectionSchema.unwrap(),
  baseRejectionSchema.unwrap().extend({ schemaVersion: z.literal(2), refusal: z.literal('plan-unavailable') }).strict(),
  z.object({ schemaVersion: z.literal(3), refusal: z.enum(['usage-unavailable', 'service-unavailable']),
    code: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/u).optional(), status: counterSchema.max(599).min(400).nullable() }).strict()]).readonly();
export type HeadlessRejectionBody = z.infer<typeof headlessRejectionBodySchema>;
/** Legacy CLI readers keep their original evidence scope; composition explicitly supplies any additional subscription adapter ids. */
export const NATIVE_CLI_HEADLESS_ADAPTER_ID = 'native-cli-headless';
/** The headless body of a rejected receipt's evidence (base64 JSON), or null when the evidence is another adapter's or not this shape. */
export function readHeadlessRejection(evidence: Readonly<{ adapter: Readonly<{ id: string }>; body: Readonly<{ data: string }> }>, adapterIds: ReadonlySet<string> = new Set([NATIVE_CLI_HEADLESS_ADAPTER_ID])): HeadlessRejectionBody | null {
  if (!adapterIds.has(evidence.adapter.id)) return null;
  try { const parsed = headlessRejectionBodySchema.safeParse(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(evidence.body.data), char => char.charCodeAt(0))))); return parsed.success ? parsed.data : null; }
  catch { return null; }
}
/** f5: the gateway summary in a headless call's stored content (rejected body or responded `native.headless`); null otherwise or when purged. */
export function readHeadlessEgress(adapterId: string, content: Readonly<{ kind: string; data?: string; response?: unknown }> | null | undefined): HeadlessEgress | null {
  if (adapterId !== NATIVE_CLI_HEADLESS_ADAPTER_ID || !content) return null;
  if (content.kind === 'response-body') {
    const body = typeof content.data === 'string' ? readHeadlessRejection({ adapter: { id: adapterId }, body: { data: content.data } }) : null;
    return body && 'egress' in body ? body.egress ?? null : null;
  }
  return headlessEgressSchema.safeParse((content.response as { native?: { headless?: { egress?: unknown } } } | undefined)?.native?.headless?.egress).data ?? null;
}
