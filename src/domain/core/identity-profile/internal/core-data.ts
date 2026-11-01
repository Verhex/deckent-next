import { persistedInteger } from '#domain/core/primitives/index.js';
import { z } from 'zod';
import data from './registry.json' with { type: 'json' };
import { identityProfileDefinitionSchema } from './schema.js';
/** Core data is exposed as a parsed immutable snapshot, never a mutable JSON import. */
export const coreIdentityProfileData = z.strictObject({ schemaVersion: z.literal(1), version: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  profiles: z.array(identityProfileDefinitionSchema).readonly() }).readonly().parse(data);
