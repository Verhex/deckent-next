import { hostname, platform, arch, userInfo } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { supervisorProfileSchema, SupervisorError, type SupervisorProfile } from '#engine/index.js';
import { identitySchema, workerIsolationSchema, type WorkerIsolation } from '#domain/index.js';
import { dockerSupervisorOptionsSchema, type DockerSupervisorOptions } from './options.js';
const originSchema = z.object({ hostname: identitySchema, platform: identitySchema, architecture: identitySchema,
  uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(), daemonId: identitySchema,
}).strict().readonly();
export const dockerEndpointSchema = z.string().refine(value => value.startsWith('unix:///') && value.length > 8 && !value.includes(String.fromCharCode(0)));
const legacyParametersSchema = z.object({ endpoint: dockerEndpointSchema, options: dockerSupervisorOptionsSchema, origin: originSchema }).strict().readonly();
/** v3 (alpha.56 D2): the same, plus the worker's isolation block; `execute` starts a container only once its realised network mode matches it. */
const parametersSchema = legacyParametersSchema.unwrap().extend({ isolation: workerIsolationSchema }).strict().readonly();
/** The one network mode this adapter creates workers with (no route at all). */
export const DOCKER_WORKER_NETWORK = 'none';
/** The isolation a worker of these options gets: no network, and only the provider gateway when a connection socket is mounted. */
function dockerWorkerIsolation(options: DockerSupervisorOptions): WorkerIsolation {
  if (options.connection && !options.connection.provider) throw new SupervisorError('SUPERVISOR_OPTIONS_INVALID');
  return { schemaVersion: 1, network: DOCKER_WORKER_NETWORK, egress: options.connection?.provider ? { kind: 'provider-gateway', provider: options.connection.provider } : { kind: 'none' } };
}
export function dockerHostIdentity() {
  const user = userInfo(); return { hostname: hostname(), platform: platform(), architecture: arch(), uid: user.uid, gid: user.gid };
}
export function captureDockerProfile(options: DockerSupervisorOptions, daemonId: string, endpoint: string): SupervisorProfile {
  const parameters = parametersSchema.parse({ endpoint, options, origin: { ...dockerHostIdentity(), daemonId }, isolation: dockerWorkerIsolation(options) });
  return supervisorProfileSchema.parse({ schemaVersion: 1, adapterId: 'docker', adapterVersion: 3, parameters });
}
/** v3 parameters (with isolation) or v2 (recorded before alpha.56, without), of this host; anything else is invalid. A v3 isolation block must be exactly
 * the one its own options derive (egress tied to `connection`): a record is a declaration, so one that claims less than its options give is invalid. */
export function readDockerProfile(input: unknown): z.infer<typeof legacyParametersSchema> & { isolation?: WorkerIsolation } {
  const profile = supervisorProfileSchema.safeParse(input);
  if (!profile.success || profile.data.adapterId !== 'docker' || ![2, 3].includes(profile.data.adapterVersion)) throw new SupervisorError('SUPERVISOR_PROFILE_INVALID');
  const parameters = (profile.data.adapterVersion === 3 ? parametersSchema : legacyParametersSchema).safeParse(profile.data.parameters);
  if (!parameters.success) throw new SupervisorError('SUPERVISOR_PROFILE_INVALID');
  if (profile.data.adapterVersion === 3) {
    let derived: WorkerIsolation;
    try { derived = dockerWorkerIsolation(parameters.data.options); } catch { throw new SupervisorError('SUPERVISOR_PROFILE_INVALID'); }
    if (!isDeepStrictEqual(derived, (parameters.data as { isolation?: unknown }).isolation)) throw new SupervisorError('SUPERVISOR_PROFILE_INVALID');
  }
  const current = dockerHostIdentity(); const { origin } = parameters.data;
  if (current.hostname !== origin.hostname || current.platform !== origin.platform || current.architecture !== origin.architecture
    || current.uid !== origin.uid || current.gid !== origin.gid) throw new SupervisorError('SUPERVISOR_PROFILE_ORIGIN_MISMATCH');
  return parameters.data;
}
/** alpha.56 D2: the isolation block a recorded dispatch profile carries (null: a v2 record, another adapter or host, or an unreadable profile). */
export function recordedWorkerIsolation(input: unknown): WorkerIsolation | null {
  try { return readDockerProfile(input).isolation ?? null; } catch { return null; }
}
/** Pure adapter shape/origin validation for trusted persistence composition. */
export function validateDockerSupervisorProfile(input: SupervisorProfile): undefined { readDockerProfile(input); return undefined; }
/** EXEC-RELEASE: the recorded profile ran with a worker connection (native subscription), so its event log must be sealed before release. */
export function dockerProfileObservesWorker(input: SupervisorProfile): boolean { return readDockerProfile(input).options.connection !== undefined; }
