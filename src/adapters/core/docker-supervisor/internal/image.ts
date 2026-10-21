import { isAbsolute } from 'node:path';
import { identitySchema } from '#domain/index.js';
import { DockerCommandFailure, runNodeDockerCommand, type DockerCommandOutput, type DockerCommandRunner } from './command.js';
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

const digest = (value: unknown) => typeof value === 'string' && imageDigest.test(value);
function validInput(input: unknown, rest: (value: Record<string, unknown>) => boolean = value => digest(value['imageId'])): input is DockerImageAvailabilityProbeInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Partial<DockerImageAvailabilityProbeInput> & Record<string, unknown>;
  return typeof value.executable === 'string' && isAbsolute(value.executable) && boundedPositive(value.timeoutMs) && boundedPositive(value.outputBytes) && rest(value);
}
function daemonId(output: string): string {
  const value = output.trim();
  if (!identitySchema.safeParse(value).success) throw new DockerImageProbeError('DOCKER_IMAGE_PROBE_UNAVAILABLE');
  return value;
}
type DockerArgs = (args: readonly string[], signal?: AbortSignal) => Promise<DockerCommandOutput>;
/** Endpoint pin and daemon-id reads shared by the single and the list probe; every failure is UNAVAILABLE (no raw Docker text leaves). */
function pinned(run: DockerArgs) {
  const command: DockerArgs = async (args, signal) => { try { return await run(args, signal); } catch { throw new DockerImageProbeError('DOCKER_IMAGE_PROBE_UNAVAILABLE'); } };
  const endpoint = command(['context', 'inspect', '--format', '{{json .Endpoints.docker}}']).then(output => dockerEndpointSchema.parse(JSON.parse(output.stdout).Host))
    .catch((error: unknown) => { throw error instanceof DockerImageProbeError ? error : new DockerImageProbeError('DOCKER_IMAGE_PROBE_UNAVAILABLE'); });
  return { command, endpoint, daemon: async (host: string) => daemonId((await command(['--host', host, 'info', '--format', '{{.ID}}'])).stdout) };
}

/** Read-only local availability evidence. It never pulls, creates, starts, or verifies image provenance. */
export async function probeDockerImageAvailability(input: unknown,
  runner: DockerCommandRunner = runNodeDockerCommand): Promise<DockerImageAvailability> {
  if (!validInput(input)) throw new DockerImageProbeError('DOCKER_IMAGE_PROBE_INVALID');
  const { command, endpoint: pin, daemon } = pinned(args => runner({ executable: input.executable, args, timeoutMs: input.timeoutMs, outputBytes: input.outputBytes }));
  const endpoint = await pin, before = await daemon(endpoint);
  const inspected = (await command(['--host', endpoint, 'image', 'inspect', input.imageId, '--format', '{{.Id}}'])).stdout.trim();
  if (inspected !== input.imageId) throw new DockerImageProbeError('DOCKER_IMAGE_PROBE_UNAVAILABLE');
  if (before !== await daemon(endpoint)) throw new DockerImageProbeError('DOCKER_IMAGE_PROBE_CHANGED');
  return Object.freeze({ endpoint, daemonId: before, imageId: input.imageId, status: 'locally-available' });
}
/** `partial`: the time limit cut the inspects short; an id the daemon does not have is left out without it. */
export type DockerImageSet = Readonly<{ imageIds: readonly string[]; partial: boolean }>;
export interface DockerImageSetProbeInput extends Omit<DockerImageAvailabilityProbeInput, 'imageId'> {
  readonly imageIds: readonly string[]; readonly chunkSize: number; readonly processes: number;
  /** The least time kept for the daemon-id check after the inspects, also when the first read was near-instant (CONFIG-PARTIAL-CLI finding). */
  readonly minAfterCheckMs?: number;
}
/**
 * The same checks for a list (J3-IMAGES): one endpoint pin, one daemon id before and after, exact-id `image inspect` in at most `processes`
 * concurrent chunks of at most `chunkSize` ids. Inspects stop twice the measured daemon-id read (at least `minAfterCheckMs`) before
 * `timeoutMs`, so the after-check fits;
 * ids not proven by then are left out (`partial`). A different daemon afterwards refuses the whole list (CHANGED). Returns proven ids in input order.
 */
export async function probeDockerImageSetAvailability(input: unknown, runner: DockerCommandRunner = runNodeDockerCommand, signal?: AbortSignal): Promise<DockerImageSet> {
  if (!validInput(input, value => Array.isArray(value['imageIds']) && value['imageIds'].every(digest) && boundedPositive(value['chunkSize']) && boundedPositive(value['processes'])
    && (value['minAfterCheckMs'] === undefined || boundedPositive(value['minAfterCheckMs']))))
    throw new DockerImageProbeError('DOCKER_IMAGE_PROBE_INVALID');
  const probe = input as unknown as DockerImageSetProbeInput, until = performance.now() + probe.timeoutMs, bound = AbortSignal.any([AbortSignal.timeout(probe.timeoutMs), ...(signal ? [signal] : [])]);
  const run: DockerArgs = (args, on = bound) => runner({ executable: probe.executable, args, timeoutMs: probe.timeoutMs, outputBytes: probe.outputBytes }, on);
  const { endpoint: pin, daemon } = pinned(run), endpoint = await pin, started = performance.now(), before = await daemon(endpoint), now = performance.now();
  const reserve = Math.max(2 * (now - started), probe.minAfterCheckMs ?? 0);
  const cutoff = AbortSignal.any([bound, AbortSignal.timeout(Math.max(0, Math.floor(until - now - reserve)))]);
  const ids = [...new Set(probe.imageIds)], size = Math.max(1, Math.min(probe.chunkSize, Math.ceil(ids.length / probe.processes)));
  const chunks = Array.from({ length: Math.ceil(ids.length / size) }, (_, index) => ids.slice(index * size, (index + 1) * size)), proven = new Set<string>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(probe.processes, chunks.length) }, async () => {
    for (let chunk = chunks[next++]; chunk && !cutoff.aborted; chunk = chunks[next++]) {
      // The CLI prints every id it found and exits 1 when one is missing: a finished process's lines count, each only as an exact requested id.
      const stdout = await run(['--host', endpoint, 'image', 'inspect', ...chunk, '--format', '{{.Id}}'], cutoff).then(output => output.stdout,
        (error: unknown) => error instanceof DockerCommandFailure && !error.killed && error.code !== null ? error.stdout : '');
      for (const line of stdout.split('\n')) if (chunk.includes(line.trim())) proven.add(line.trim());
    }
  }));
  const partial = cutoff.aborted && ids.some(id => !proven.has(id)); // read before the after-check, which may outlast the inspect cut-off
  if (before !== await daemon(endpoint)) throw new DockerImageProbeError('DOCKER_IMAGE_PROBE_CHANGED');
  return Object.freeze({ imageIds: Object.freeze(ids.filter(id => proven.has(id))), partial });
}
