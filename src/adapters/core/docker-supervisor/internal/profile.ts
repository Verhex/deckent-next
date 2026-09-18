import { hostname, platform, arch, userInfo } from 'node:os';
import { z } from 'zod';
import { supervisorProfileSchema, SupervisorError, type SupervisorProfile } from '#engine/index.js';
import { identitySchema } from '#domain/index.js';
import { dockerSupervisorOptionsSchema, type DockerSupervisorOptions } from './options.js';
const originSchema = z.object({ hostname: identitySchema, platform: identitySchema, architecture: identitySchema,
  uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(), daemonId: identitySchema,
}).strict().readonly();
export const dockerEndpointSchema = z.string().refine(value => value.startsWith('unix:///') && value.length > 8 && !value.includes(String.fromCharCode(0)));
const parametersSchema = z.object({ endpoint: dockerEndpointSchema, options: dockerSupervisorOptionsSchema, origin: originSchema }).strict().readonly();
export function dockerHostIdentity() {
  const user = userInfo(); return { hostname: hostname(), platform: platform(), architecture: arch(), uid: user.uid, gid: user.gid };
}
export function captureDockerProfile(options: DockerSupervisorOptions, daemonId: string, endpoint: string): SupervisorProfile {
  const parameters = parametersSchema.parse({ endpoint, options, origin: { ...dockerHostIdentity(), daemonId } });
  return supervisorProfileSchema.parse({ schemaVersion: 1, adapterId: 'docker', adapterVersion: 2, parameters });
}
export function readDockerProfile(input: unknown) {
  const profile = supervisorProfileSchema.safeParse(input);
  if (!profile.success || profile.data.adapterId !== 'docker' || profile.data.adapterVersion !== 2) throw new SupervisorError('SUPERVISOR_PROFILE_INVALID');
  const parameters = parametersSchema.safeParse(profile.data.parameters);
  if (!parameters.success) throw new SupervisorError('SUPERVISOR_PROFILE_INVALID');
  const current = dockerHostIdentity(); const { origin } = parameters.data;
  if (current.hostname !== origin.hostname || current.platform !== origin.platform || current.architecture !== origin.architecture
    || current.uid !== origin.uid || current.gid !== origin.gid) throw new SupervisorError('SUPERVISOR_PROFILE_ORIGIN_MISMATCH');
  return parameters.data;
}

/** Pure adapter shape/origin validation for trusted persistence composition. */
export function validateDockerSupervisorProfile(input: SupervisorProfile): undefined { readDockerProfile(input); return undefined; }
