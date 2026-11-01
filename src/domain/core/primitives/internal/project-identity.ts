import { persistedUuid } from './persisted-schema.js';
import { z } from 'zod';
/** A durable identity, never a hash or other derivation of the project's current path. */
export const projectIdSchema = persistedUuid().brand<'ProjectId'>();
export type ProjectId = z.infer<typeof projectIdSchema>;
export const projectIdentitySchema = z.strictObject({ schemaVersion: z.literal(1), projectId: projectIdSchema }).readonly();
export type ProjectIdentity = z.infer<typeof projectIdentitySchema>;
