import { z } from 'zod';

/** A durable identity, never a hash or other derivation of the project's current path. */
export const projectIdSchema = z.string().uuid().brand<'ProjectId'>();
export type ProjectId = z.infer<typeof projectIdSchema>;
export const projectIdentitySchema = z.object({ schemaVersion: z.literal(1), projectId: projectIdSchema }).strict().readonly();
export type ProjectIdentity = z.infer<typeof projectIdentitySchema>;
