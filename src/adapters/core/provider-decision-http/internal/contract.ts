import { z } from 'zod';
import { createImmutableJsonObjectSchema, MODEL_INVOCATION_NATIVE_JSON_LIMITS } from '#domain/index.js';
import { decisionCaseSchema } from '#domain/index.js';
import { NativeJsonHttpError, parseNativeJsonHttpDefinition, parseNativeJsonHttpLimits, type NativeJsonHttpDefinition, type NativeJsonHttpLimits } from '#adapters/core/provider-http-json/index.js';
import protocol from '../assets/protocol.json' with { type: 'json' };

export const decisionHttpAdapter = Object.freeze({ id: protocol.id, version: protocol.version, protocol: Object.freeze(protocol.protocol) });
export const decisionHttpWireObjectSchema = createImmutableJsonObjectSchema(MODEL_INVOCATION_NATIVE_JSON_LIMITS);
export class DecisionHttpError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); this.name = 'DecisionHttpError'; }
}
export const decisionHttpTariffSchema = z.object({ kind: z.literal('operator-static'), version: z.literal(1), currency: z.string().regex(/^[A-Z]{3}$/),
  inputMinorUnitsPerMillionTokens: z.literal(0), outputMinorUnitsPerMillionTokens: z.literal(0) }).strict();
export type DecisionHttpDefinition = NativeJsonHttpDefinition & Readonly<{ tariff: z.infer<typeof decisionHttpTariffSchema> }>;
export type DecisionHttpLimits = NativeJsonHttpLimits;
const definitionSchema = z.object({ endpoint: z.string(), authentication: z.unknown(), tls: z.unknown().optional(), tariff: decisionHttpTariffSchema }).strict();
export const decisionHttpRequestSchema = z.object({ schemaVersion: z.literal(1), case: decisionCaseSchema }).strict();

export function parseDecisionHttpDefinition(input: unknown): DecisionHttpDefinition {
  const copied = decisionHttpWireObjectSchema.safeParse(input), parsed = copied.success && definitionSchema.safeParse(copied.data);
  if (!parsed || !parsed.success) throw new DecisionHttpError('DECISION_HTTP_DEFINITION_INVALID');
  try {
    const transport = parseNativeJsonHttpDefinition({ endpoint: parsed.data.endpoint, authentication: parsed.data.authentication,
      ...(parsed.data.tls === undefined ? {} : { tls: parsed.data.tls }) });
    if (transport.authentication.type === 'header') throw new DecisionHttpError('DECISION_HTTP_DEFINITION_INVALID');
    return Object.freeze({ ...transport, tariff: Object.freeze(parsed.data.tariff) });
  } catch { throw new DecisionHttpError('DECISION_HTTP_DEFINITION_INVALID'); }
}
export function parseDecisionHttpLimits(input: unknown): DecisionHttpLimits {
  try { return parseNativeJsonHttpLimits(input); } catch { throw new DecisionHttpError('DECISION_HTTP_REQUEST_INVALID'); }
}
export function parseDecisionHttpRequest(input: unknown) {
  const copied = decisionHttpWireObjectSchema.safeParse(input), parsed = copied.success && decisionHttpRequestSchema.safeParse(copied.data);
  if (!parsed || !parsed.success || parsed.data.case.options.length + Object.keys(protocol.abstentions).length > 255) throw new DecisionHttpError('DECISION_HTTP_REQUEST_INVALID');
  return parsed.data;
}
export function rethrowDecisionHttpTransport(error: unknown): never {
  if (!(error instanceof NativeJsonHttpError)) throw error;
  throw new DecisionHttpError(error.code.replace('NATIVE_JSON_HTTP_', 'DECISION_HTTP_'), error.status);
}
export { protocol as decisionHttpProtocolData };
