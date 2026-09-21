import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';

export const commandEnvelopeSchema = z.object({
  schemaVersion: z.literal(1), commandId: identitySchema, scopeId: identitySchema,
  principalRef: z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict().readonly(),
  sessionRef: identitySchema.optional(), expectedRevision: counterSchema.optional(),
  idempotencyKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().readonly();
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
/** Exact versioned source projection; callers select the fields, readers cannot extend its MAC scope.
 * Object order is canonical; text stays byte-exact so different filesystem names are never conflated.
 */
export function encodeCommandProjection(tag: string, value: unknown): string {
  identitySchema.parse(tag);
  const encode = (input: unknown, depth: number): string => {
    if (depth > 32) throw new Error('COMMAND_ENCODING_INVALID');
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return JSON.stringify(input);
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(v => encode(v, depth + 1)).join(',')}]`;
    if (input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) {
      return `{${Object.keys(input).sort().filter(k => (input as Record<string, unknown>)[k] !== undefined)
        .map(k => `${JSON.stringify(k)}:${encode((input as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
    }
    throw new Error('COMMAND_ENCODING_INVALID');
  };
  return JSON.stringify(tag) + ':' + encode(value, 0);
}
