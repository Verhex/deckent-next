import { z } from 'zod';
import { admittedToolchainSchema, toolchainCatalog, type AdmittedToolchain } from './contract.js';
import type { AffectedProfile } from './update.js';

/** What both derivations read from the installed configuration: its admission registry (an unreadable registry admits nothing). */
export type ToolchainAdmissionSource = Readonly<{ admission?: Readonly<{ registry?: unknown }> | null | undefined }>;

const nativeProfileSchema = z.object({ id: z.string(), version: z.number(), parameters: z.object({ nativeSubscription: z.object({
  provider: z.string(), preflight: z.object({ cliVersion: z.string() }).passthrough().optional() }).passthrough().optional() }).passthrough() }).passthrough();
const registrySchema = z.object({ profiles: z.array(z.unknown()) }).passthrough();

/** Admitted toolchains are the preflight pins of prepared native profiles in the installed admission registry. */
export function admittedToolchains(config: ToolchainAdmissionSource): AdmittedToolchain[] {
  const registry = registrySchema.safeParse(config.admission?.registry);
  if (!registry.success) return [];
  return registry.data.profiles.flatMap(candidate => {
    const profile = nativeProfileSchema.safeParse(candidate);
    const subscription = profile.success ? profile.data.parameters.nativeSubscription : undefined;
    if (!subscription?.preflight || !(subscription.provider in toolchainCatalog.providers)) return [];
    return [admittedToolchainSchema.parse({ profile: { id: profile.data!.id, version: profile.data!.version }, provider: subscription.provider, cliVersion: subscription.preflight.cliVersion })];
  });
}

const imagedProfileSchema = z.object({ id: z.string(), version: z.number(), parameters: z.object({ imageId: z.string().optional(),
  nativeSubscription: z.object({ provider: z.string(), preflight: z.object({ cliVersion: z.string() }).passthrough().optional() }).passthrough().optional() }).passthrough() }).passthrough();

/** The same pins as update candidates, each with its profile's image id when that is an immutable digest (else null). */
export function affectedToolchainProfiles(config: ToolchainAdmissionSource): AffectedProfile[] {
  const registry = z.object({ profiles: z.array(z.unknown()) }).passthrough().safeParse(config.admission?.registry);
  if (!registry.success) return [];
  return registry.data.profiles.flatMap(candidate => {
    const profile = imagedProfileSchema.safeParse(candidate); const subscription = profile.success ? profile.data.parameters.nativeSubscription : undefined;
    if (!subscription?.preflight || !(subscription.provider in toolchainCatalog.providers)) return [];
    const imageId = profile.data!.parameters.imageId;
    return [{ profile: { id: profile.data!.id, version: profile.data!.version }, provider: subscription.provider, cliVersion: subscription.preflight.cliVersion, imageId: imageId && /^sha256:[a-f0-9]{64}$/.test(imageId) ? imageId : null }];
  });
}
