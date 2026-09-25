import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identitySchema, counterSchema, immutableJsonObjectSchema } from '#domain/index.js';
import { ModelInvocationStoreError } from '#engine/core/model-invocation/index.js';

const allocationSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, allocationId: identitySchema,
  maxCalls: counterSchema.positive().nullable(), maxInFlight: counterSchema.positive(), lifetimeCalls: counterSchema, inFlight: counterSchema }).strict().readonly();
export type ModelAllocation = z.infer<typeof allocationSchema>;
export interface ModelAllocationCheckpoint {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly allocation: ModelAllocation;
  readonly digest: string;
}
const checkpointSchema = immutableJsonObjectSchema.pipe(z.object({ schemaVersion: z.literal(1), revision: counterSchema.positive(),
  allocation: allocationSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict());
export function parseModelAllocation(input: unknown): ModelAllocation {
  const copied = immutableJsonObjectSchema.safeParse(input), parsed = copied.success && allocationSchema.safeParse(copied.data);
  if (!parsed || !parsed.success) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  const value = parsed.data;
  if (value.inFlight > value.lifetimeCalls || (value.maxCalls !== null && value.lifetimeCalls > value.maxCalls) || value.inFlight > value.maxInFlight) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  }
  return value;
}
/** Revision fences read snapshots; the digest is a corruption checksum, not an authentication credential. */
export function createModelAllocationCheckpoint(input: unknown, revision: number): ModelAllocationCheckpoint {
  const allocation = parseModelAllocation(input);
  if (!counterSchema.positive().safeParse(revision).success) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  const digest = createHash('sha256').update(`deckent.model-allocation-checkpoint.v1\n${JSON.stringify({ revision, allocation })}`).digest('hex');
  return Object.freeze({ schemaVersion: 1, revision, allocation, digest });
}
export function parseModelAllocationCheckpoint(input: unknown): ModelAllocationCheckpoint {
  const parsed = checkpointSchema.safeParse(input);
  if (!parsed.success) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  const expected = createModelAllocationCheckpoint(parsed.data.allocation, parsed.data.revision);
  if (expected.digest !== parsed.data.digest) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  return expected;
}
