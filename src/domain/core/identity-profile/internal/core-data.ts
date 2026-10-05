import { z } from 'zod';
import data from './registry.json' with { type: 'json' };
import { identityProfileDefinitionSchema } from './schema.js';
/** Core data is exposed as a parsed immutable snapshot, never a mutable JSON import. */
export const coreIdentityProfileData = z.object({ schemaVersion: z.literal(1), version: z.number().int().positive().safe(),
  profiles: z.array(identityProfileDefinitionSchema).readonly() }).strict().readonly().parse(data);
