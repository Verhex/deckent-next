import { z } from 'zod';
import { admittedToolchainSchema, toolchainCatalog, type AdmittedToolchain } from './contract.js';
import type { AffectedProfile } from './update.js';

/** What both derivations read from the installed configuration: its admission registry (an unreadable registry admits nothing). */
export type ToolchainAdmissionSource = Readonly<{ admission?: Readonly<{ registry?: unknown }> | null | undefined }>;

const pinSchema = z.object({ provider: z.string(), preflight: z.object({ cliVersion: z.string() }).passthrough().optional() }).passthrough();
const nativeProfileSchema = z.object({ id: z.string(), version: z.number(), parameters: z.object({ imageId: z.string().optional(),
  nativeSubscription: pinSchema.optional() }).passthrough() }).passthrough();
/** K3 coding templates (adapter `native-coding-template`) pin their CLI in the invocation and their image in the Docker part. */
const templateProfileSchema = z.object({ id: z.string(), version: z.number(), adapter: z.object({ id: z.literal('native-coding-template') }).passthrough(),
  parameters: z.object({ docker: z.object({ imageId: z.string().optional() }).passthrough(), invocation: z.object({ provider: z.string(), cliVersion: z.string() }).passthrough() }).passthrough() }).passthrough();
const registrySchema = z.object({ profiles: z.array(z.unknown()) }).passthrough();

/** The CLI pin of a prepared native profile or of a coding template, with its image id as written (null when none). */
function nativePins(config: ToolchainAdmissionSource) {
  const registry = registrySchema.safeParse(config.admission?.registry);
  if (!registry.success) return [];
  return registry.data.profiles.flatMap(candidate => {
    const template = templateProfileSchema.safeParse(candidate);
    if (template.success) {
      const { id, version, parameters: { docker, invocation } } = template.data;
      return invocation.provider in toolchainCatalog.providers ? [{ profile: { id, version }, provider: invocation.provider, cliVersion: invocation.cliVersion, imageId: docker.imageId }] : [];
    }
    const profile = nativeProfileSchema.safeParse(candidate); const subscription = profile.success ? profile.data.parameters.nativeSubscription : undefined;
    if (!subscription?.preflight || !(subscription.provider in toolchainCatalog.providers)) return [];
    return [{ profile: { id: profile.data!.id, version: profile.data!.version }, provider: subscription.provider, cliVersion: subscription.preflight.cliVersion, imageId: profile.data!.parameters.imageId }];
  });
}

/** Admitted toolchains are the preflight pins of prepared native profiles (and coding templates) in the installed admission registry. */
export function admittedToolchains(config: ToolchainAdmissionSource): AdmittedToolchain[] {
  return nativePins(config).map(pin => admittedToolchainSchema.parse({ profile: pin.profile, provider: pin.provider, cliVersion: pin.cliVersion }));
}

/** The same pins as update candidates, each with its profile's image id when that is an immutable digest (else null). */
export function affectedToolchainProfiles(config: ToolchainAdmissionSource): AffectedProfile[] {
  return nativePins(config).map(({ imageId, ...pin }) => ({ ...pin, imageId: imageId && /^sha256:[a-f0-9]{64}$/.test(imageId) ? imageId : null }));
}
