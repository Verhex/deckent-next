import { hashInstallationProfilePayload } from '#engine/core/installation/index.js';

const image = (suffix: string) => `sha256:${suffix.repeat(64).slice(0, 64)}`;
const docker = (imageId: string) => ({ imageId, memoryBytes: 1024, pids: 16, cpus: 1, logMaxSizeKiB: 16,
  logMaxFiles: 1, tmpBytes: 1024, deadlineMs: 1000, controlTimeoutMs: 1000, outputBytes: 1024, argv: ['echo', 'ok'] });

/** Supplied profile fixture only; it carries no installed secret, image availability, or package-trust claim. */
export function installationProfile(input: { root?: string; shutdown?: boolean; images?: readonly string[] } = {}) {
  const images = input.images ?? [image('a')];
  const profiles = images.map((imageId, index) => ({ id: `docker-${index + 1}`, version: 1,
    adapter: { id: 'docker', version: 2 }, parameters: docker(imageId) }));
  const registry = { schemaVersion: 1 as const, revision: 'registry-1', profiles,
    kinds: profiles.map((profile, index) => ({ kind: `kind-${index + 1}`, profile: { id: profile.id, version: profile.version } })),
    evaluators: [{ id: 'custom-exit', version: 7, implementation: { id: 'process-exit', version: 1 } }] };
  const { argv: omitted, ...settings } = docker(images[0]!); void omitted;
  const configuration = { execution: { docker: { executable: 'docker', ...settings }, git: { gitExecutable: 'git', timeoutMs: 1000, outputBytes: 4096 } }, ...(input.root ? { layout: { root: input.root } } : {}), admission: { registry, poolId: 'pool-1',
    executionSlots: 1, inFlightSlots: 1, ordering: 'input-order' as const }, service: { identity: { scopeId: 'scope-1', serviceId: 'service-1' } } };
  const principal = { issuer: 'fixture-issuer', subject: 'fixture-subject' };
  const grants = [{ id: 'pool', effect: 'allow' as 'allow' | 'deny' | 'require-approval', actions: ['use'], scopes: ['scope-1'], principals: [principal], resource: { kind: 'pool', ids: ['pool-1'] as string[] | 'all' } },
    ...(input.shutdown ? [{ id: 'shutdown', effect: 'allow' as 'allow' | 'deny' | 'require-approval', actions: ['shutdown'], scopes: ['scope-1'], principals: [principal], resource: { kind: 'service', ids: ['service-1'] } }] : [])];
  const payload = { schemaVersion: 1 as const, profile: { id: 'fixture', version: 1 }, scopeId: 'scope-1', configuration,
    policy: { schemaVersion: 1 as const, revision: 'policy-1', grants, restrictions: [] }, pool: { schemaVersion: 1 as const, poolId: 'pool-1', capacity: { executionSlots: 1, inFlightSlots: 1 } }, shutdown: { enabled: !!input.shutdown } };
  return { ...payload, profile: { ...payload.profile, digest: hashInstallationProfilePayload(payload) } };
}
