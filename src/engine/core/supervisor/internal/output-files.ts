import { z } from 'zod';
/** Native collection port. Transport adapters must supply bytes separately from control messages. */
export const outputFileNameSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const outputFileFailureSchema = z.enum(['missing', 'unsafe', 'too-large', 'changed', 'read-failed']);
export const collectedOutputFileSchema = z.discriminatedUnion('status', [
  z.strictObject({ name: outputFileNameSchema, status: z.literal('collected'), bytes: z.instanceof(Uint8Array) }),
  z.strictObject({ name: outputFileNameSchema, status: z.literal('unavailable'), reason: outputFileFailureSchema }),
]).readonly();
export type CollectedOutputFile = z.infer<typeof collectedOutputFileSchema>;
