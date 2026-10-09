import { z } from 'zod';
import { createImmutableJsonObjectSchema, identitySchema } from '#domain/core/primitives/index.js';
import { modelReferenceSchema } from '#domain/core/provider-catalog/index.js';
import { MODEL_INVOCATION_NATIVE_JSON_LIMITS } from '#domain/core/model-invocation/index.js';

/** Untrusted provider context, never authority. Adapters interpret the bounded payload only for the same scoped profile. */
export const agentMessageContinuationSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  reference: modelReferenceSchema, profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  native: createImmutableJsonObjectSchema(MODEL_INVOCATION_NATIVE_JSON_LIMITS) }).strict().readonly();
export type AgentMessageContinuation = z.infer<typeof agentMessageContinuationSchema>;
/** Provider terminal outcomes are distinct from cancellation by the caller. Usage is adjudicated separately. */
export type AgentProviderStop = 'content-filter' | 'context-window' | 'network-error' | 'resource-exhausted' | 'aborted';
