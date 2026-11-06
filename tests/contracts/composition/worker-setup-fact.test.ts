import { expect, it, vi } from 'vitest';
import { createNativeCodingTemplate } from '#adapters/index.js';
// Own file: run-intent-preflight.test.ts replaces intent-facts wholesale, so the real fact is read here over mocked config, image and pool owners.
const state = vi.hoisted(() => ({ config: null as unknown, presence: [] as string[] }));
vi.mock('#platform/index.js', async original => ({ ...await original<object>(), loadConfig: async () => state.config }));
vi.mock('#composition/core/toolchains/index.js', () => ({ inspectConfiguredWorkerImage: async () => ({ phase: 'ready', revision: 1 }) }));
vi.mock('#composition/core/runs/index.js', () => ({ inspectConfiguredPoolCapacity: async () => ({ schemaVersion: 1 }) }));
vi.mock('#adapters/index.js', async original => ({ ...await original<object>(),
  workerImagePresence: async (input: { imageId: string }) => { state.presence.push(input.imageId); return 'missing'; } }));
const { configuredWorkerSetupFact } = await import('../../../src/composition/core/run-planner/internal/intent-facts.js');

it('R8b: a person who had a Docker image consent and rebinds the work kind to a subscription connection is not parked as worker setup pending', async () => {
  // The installed shape: `coding template --connection` writes a v2 coding template with its `worker` binding; the old Docker settings and image
  // consent stay, the old image is gone, and the template either carries that image id or (written without settings) none at all.
  const image = `sha256:${'a'.repeat(64)}`, docker = { executable: 'docker', imageId: image, memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2,
    tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 }, { executable, ...limits } = docker; void executable;
  const invocation = { provider: 'claude', cliVersion: '2.1.0', discovery: { schemaVersion: 1, mode: 'disabled' }, permissionMode: 'unattended' };
  const binding = { schemaVersion: 1 as const, connectionId: 'aabbccdd-1234-4123-8123-123456789abc', protocolFamily: 'claude-code-stream-json', profileDigest: 'b'.repeat(64),
    resourceKey: 'opaque-subscription-fixture', definition: { schemaVersion: 1 as const, executable: '/fixture/cli', configDir: '/fixture/login', stateDir: '/fixture/state',
      ownerUid: 1000, minCliVersion: '2.1.0', delegatedUse: null } };
  const config = (template: ReturnType<typeof createNativeCodingTemplate>) => ({ toolchains: { image: { consents: [{ providers: ['claude'] }] } },
    execution: { docker, git: { gitExecutable: 'git' } },
    admission: { poolId: 'p', registry: { schemaVersion: 1, revision: 'r', profiles: [template], kinds: [{ kind: 'code', profile: { id: template.id, version: template.version } }],
      evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] } } });
  for (const connected of [createNativeCodingTemplate(limits, invocation, binding), createNativeCodingTemplate(undefined, invocation, binding)]) {
    state.config = config(connected);
    expect(await configuredWorkerSetupFact('/unused', 's')).toMatchObject({ ready: true, params: { phase: 'ready' } });
  }
  expect(state.presence).toEqual([]);
  // Negative: the same kind bound to a plain Docker template still waits for its image.
  state.config = config(createNativeCodingTemplate(limits, invocation));
  expect(await configuredWorkerSetupFact('/unused', 's')).toMatchObject({ ready: false, reason: 'WORKER_SETUP_PENDING' });
  expect(state.presence).toEqual([image]);
});
