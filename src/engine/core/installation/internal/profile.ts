import { createHash } from 'node:crypto';
import { z } from 'zod';
import { counterSchema, identitySchema, immutableJsonObjectSchema, policySchema } from '#domain/index.js';
import { executionPoolSchema } from '#engine/core/runs/index.js';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const profileIdentitySchema = z.object({ id: identitySchema, version: counterSchema.positive() }).strict().readonly();
const installationProfilePayloadObjectSchema = z.object({
  schemaVersion: z.literal(1),
  profile: profileIdentitySchema,
  scopeId: identitySchema,
  configuration: immutableJsonObjectSchema,
  policy: policySchema,
  pool: executionPoolSchema,
  shutdown: z.object({ enabled: z.boolean() }).strict().readonly(),
}).strict();
export const installationProfilePayloadSchema = installationProfilePayloadObjectSchema.readonly();

export const installationProfileSchema = installationProfilePayloadObjectSchema.extend({
  profile: z.object({ id: identitySchema, version: counterSchema.positive(), digest: digestSchema }).strict().readonly(),
}).strict().readonly();

export type InstallationProfilePayload = z.infer<typeof installationProfilePayloadSchema>;
export type InstallationProfile = z.infer<typeof installationProfileSchema>;

export function encodeInstallationProfilePayload(input: unknown): string {
  const sanitized = immutableJsonObjectSchema.safeParse(input);
  if (!sanitized.success) throw sanitized.error;
  return JSON.stringify(immutableJsonObjectSchema.parse(installationProfilePayloadSchema.parse(sanitized.data)));
}

export function hashInstallationProfilePayload(input: unknown): string {
  return createHash('sha256').update(`deckent.installation-profile.v1\n${encodeInstallationProfilePayload(input)}`, 'utf8').digest('hex');
}

export function profilePayload(profile: InstallationProfile): InstallationProfilePayload {
  return installationProfilePayloadSchema.parse({ ...profile, profile: { id: profile.profile.id, version: profile.profile.version } });
}
