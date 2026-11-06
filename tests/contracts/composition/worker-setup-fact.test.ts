import { expect, it, vi } from 'vitest';
import { executionProfileDefinitionSchema } from '#domain/index.js';
import { nativeCliWorkerProfile } from '#capabilities/index.js';
// Own file: run-intent-preflight.test.ts replaces intent-facts wholesale, so the real fact is read here over mocked config, image and pool owners.
const state = vi.hoisted(() => ({ config: null as unknown, presence: [] as string[] }));
vi.mock('#platform/index.js', async original => ({ ...await original<object>(), loadConfig: async () => state.config }));
vi.mock('#composition/core/toolchains/index.js', () => ({ inspectConfiguredWorkerImage: async () => ({ phase: 'ready', revision: 1 }) }));
vi.mock('#composition/core/runs/index.js', () => ({ inspectConfiguredPoolCapacity: async () => ({ schemaVersion: 1 }) }));
vi.mock('#adapters/index.js', async original => ({ ...await original<object>(),
  workerImagePresence: async (input: { imageId: string }) => { state.presence.push(input.imageId); return 'missing'; } }));
const { configuredWorkerSetupFact } = await import('../../../src/composition/core/run-planner/internal/intent-facts.js');

it('R8b: a person who had a Docker image consent and rebinds the work kind to a subscription connection is not parked as worker setup pending', async () => {
  const image = `sha256:${'a'.repeat(64)}`;
  const docker = executionProfileDefinitionSchema.parse({ id: 'claude-docker', version: 1, adapter: { id: 'docker', version: 2 },
    parameters: { imageId: image, nativeSubscription: { schemaVersion: 2, provider: 'claude', preflight: { cliVersion: '2.1.0' } } } });
  const connected = nativeCliWorkerProfile(executionProfileDefinitionSchema.parse({ ...docker, id: 'claude-connection', parameters: { nativeSubscription: { schemaVersion: 2, provider: 'claude' } } }),
    { schemaVersion: 1, connectionId: 'aabbccdd-1234-4123-8123-123456789abc', protocolFamily: 'claude-code-stream-json', profileDigest: 'b'.repeat(64), resourceKey: 'opaque-subscription-fixture',
      definition: { schemaVersion: 1, executable: '/fixture/cli', configDir: '/fixture/login', stateDir: '/fixture/state', ownerUid: 1000, minCliVersion: '2.1.0', delegatedUse: null } });
  const config = (kind: typeof docker) => ({ toolchains: { image: { consents: [{ providers: ['claude'] }] } },
    execution: { docker: { executable: 'docker', imageId: image, controlTimeoutMs: 1000, outputBytes: 1024 }, git: { gitExecutable: 'git' } },
    admission: { poolId: 'p', registry: { schemaVersion: 1, revision: 'r', profiles: [docker, connected], kinds: [{ kind: 'code', profile: { id: kind.id, version: kind.version } }],
      evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] } } });
  state.config = config(connected);
  expect(await configuredWorkerSetupFact('/unused', 's')).toMatchObject({ ready: true, params: { phase: 'ready' } });
  expect(state.presence).toEqual([]);
  // Negative: the same kind still bound to its Docker image waits for that image.
  state.config = config(docker);
  expect(await configuredWorkerSetupFact('/unused', 's')).toMatchObject({ ready: false, reason: 'WORKER_SETUP_PENDING' });
  expect(state.presence).toEqual([image]);
});
