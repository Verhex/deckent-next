import { z } from 'zod';

/** Durable installation metadata; neither a host/path fingerprint nor an authorization grant. */
export const installationIdSchema = z.string().uuid().brand<'InstallationId'>();
export type InstallationId = z.infer<typeof installationIdSchema>;
export const installationIdentitySchema = z.object({ schemaVersion: z.literal(1), installationId: installationIdSchema }).strict().readonly();
export type InstallationIdentity = z.infer<typeof installationIdentitySchema>;
