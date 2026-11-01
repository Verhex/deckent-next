import { z } from 'zod';
import { identitySchema, counterSchema, immutableJsonObjectSchema } from '#domain/index.js';
/** Adapter-owned, versioned resolved data. No implementation import, permission or secret grant.
 * Concrete adapters validate every parameter; public ingress must not accept a caller-authored profile.
 */
export const supervisorProfileSchema = z.strictObject({ schemaVersion: z.literal(1), adapterId: identitySchema,
  adapterVersion: counterSchema.positive(), parameters: immutableJsonObjectSchema,
}).readonly();
export type SupervisorProfile = z.infer<typeof supervisorProfileSchema>;

export interface SupervisorProfileSource { captureProfile(): Promise<SupervisorProfile> }
