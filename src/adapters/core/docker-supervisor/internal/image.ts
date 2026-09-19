import { isAbsolute } from 'node:path';
import { identitySchema } from '#domain/index.js';
import { runNodeDockerCommand, type DockerCommandRunner } from './command.js';
import { dockerEndpointSchema } from './profile.js';

const imageDigest = /^sha256:[a-f0-9]{64}$/;
const boundedPositive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;

export type DockerImageProbeErrorCode = 'DOCKER_IMAGE_PROBE_INVALID' | 'DOCKER_IMAGE_PROBE_UNAVAILABLE' | 'DOCKER_IMAGE_PROBE_CHANGED';
export class DockerImageProbeError extends Error {
  constructor(readonly code: DockerImageProbeErrorCode) { super(code); this.name = 'DockerImageProbeError'; }
}
export interface DockerImageAvailabilityProbeInput {
  readonly executable: string;
  readonly timeoutMs: number;
  readonly outputBytes: number;
  readonly imageId: string;
}
export interface DockerImageAvailability {
  readonly endpoint: string;
  readonly daemonId: string;
  readonly imageId: string;
  readonly status: 'locally-available';
}

function validInput(input: unknown): input is DockerImageAvailabilityProbeInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Partial<DockerImageAvailabilityProbeInput>;
  return typeof value.executable === 'string' && isAbsolute(value.executable) && boundedPositive(value.timeoutMs)
    && boundedPositive(value.outputBytes) && typeof value.imageId === 'string' && imageDigest.test(value.imageId);
}
function daemonId(output: string): string {
  const value = output.trim();
  if (!identitySchema.safeParse(value).success) throw new DockerImageProbeError('DOCKER_IMAGE_PROBE_UNAVAILABLE');
  return value;
}

/** Read-only local availability evidence. It never pulls, creates, starts, or verifies image provenance. */
export async function probeDockerImageAvailability(input: unknown,
  runner: DockerCommandRunner = runNodeDockerCommand): Promise<DockerImageAvailability> {
  if (!validInput(input)) throw new DockerImageProbeError('DOCKER_IMAGE_PROBE_INVALID');
  const command = async (args: readonly string[]) => {
    try { return await runner({ executable: input.executable, args, timeoutMs: input.timeoutMs, outputBytes: input.outputBytes }); }
    catch { throw new DockerImageProbeError('DOCKER_IMAGE_PROBE_UNAVAILABLE'); }
  };
  let endpoint: string;
  try { endpoint = dockerEndpointSchema.parse(JSON.parse((await command(['context', 'inspect', '--format', '{{json .Endpoints.docker}}'])).stdout).Host); }
  catch (error) {
    if (error instanceof DockerImageProbeError) throw error;
    throw new DockerImageProbeError('DOCKER_IMAGE_PROBE_UNAVAILABLE');
  }
  const before = daemonId((await command(['--host', endpoint, 'info', '--format', '{{.ID}}'])).stdout);
  const inspected = (await command(['--host', endpoint, 'image', 'inspect', input.imageId, '--format', '{{.Id}}'])).stdout.trim();
  if (inspected !== input.imageId) throw new DockerImageProbeError('DOCKER_IMAGE_PROBE_UNAVAILABLE');
  const after = daemonId((await command(['--host', endpoint, 'info', '--format', '{{.ID}}'])).stdout);
  if (before !== after) throw new DockerImageProbeError('DOCKER_IMAGE_PROBE_CHANGED');
  return Object.freeze({ endpoint, daemonId: before, imageId: input.imageId, status: 'locally-available' });
}
