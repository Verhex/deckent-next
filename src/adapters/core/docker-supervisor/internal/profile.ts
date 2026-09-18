import { hostname, platform, arch, userInfo } from 'node:os';
import { z } from 'zod';
import { supervisorProfileSchema, SupervisorError, type SupervisorProfile } from '#engine/index.js';
import { identitySchema } from '#domain/index.js';
import { dockerSupervisorOptionsSchema, type DockerSupervisorOptions } from './options.js';
const originSchema = z.object({ hostname: identitySchema, platform: identitySchema, architecture: identitySchema,
  uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(), daemonId: identitySchema,
}).strict().readonly();
const parametersSchema = z.object({ options: dockerSupervisorOptionsSchema, origin: originSchema }).strict().readonly();
export function dockerHostIdentity() {
  const user = userInfo(); return { hostname: hostname(), platform: platform(), architecture: arch(), uid: user.uid, gid: user.gid };
}
export function captureDockerProfile(options: DockerSupervisorOptions, daemonId: string): SupervisorProfile {
  const parameters = parametersSchema.parse({ options, origin: { ...dockerHostIdentity(), daemonId } });
  return supervisorProfileSchema.parse({ schemaVersion: 1, adapterId: 'docker', adapterVersion: 1, parameters });
}
export function readDockerProfile(input: unknown) {
  const profile = supervisorProfileSchema.safeParse(input);
  if (!profile.success || profile.data.adapterId !== 'docker' || profile.data.adapterVersion !== 1) throw new SupervisorError('SUPERVISOR_PROFILE_INVALID');
  const parameters = parametersSchema.safeParse(profile.data.parameters);
  if (!parameters.success) throw new SupervisorError('SUPERVISOR_PROFILE_INVALID');
  const current = dockerHostIdentity(); const { origin } = parameters.data;
  if (current.hostname !== origin.hostname || current.platform !== origin.platform || current.architecture !== origin.architecture
    || current.uid !== origin.uid || current.gid !== origin.gid) throw new SupervisorError('SUPERVISOR_PROFILE_ORIGIN_MISMATCH');
  return parameters.data;
}

/** Pure adapter shape/origin validation for trusted persistence composition. */
export async function validateDockerSupervisorProfile(input: SupervisorProfile): Promise<void> { readDockerProfile(input); }
