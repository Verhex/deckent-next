import { expect, it, vi } from 'vitest';
import { createNativeCodingTemplate } from '#adapters/index.js';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRunProposals } from '#adapters/core/run-proposal-store/index.js';
import { migrateLedger } from '#adapters/core/sqlite-ledger/index.js';
import { RunIntentApplication } from '#engine/index.js';
// Own file: run-intent-preflight.test.ts replaces intent-facts wholesale, so the real fact is read here over mocked config, image and pool owners.
const state = vi.hoisted(() => ({ config: null as unknown, presence: [] as string[], phase: 'ready', found: 'missing', pool: true }));
vi.mock('#platform/index.js', async original => ({ ...await original<object>(), loadConfig: async () => state.config }));
vi.mock('#composition/core/toolchains/index.js', async original => ({ ...await original<object>(), inspectConfiguredWorkerImage: async () => ({ phase: state.phase, revision: 1 }) }));
vi.mock('#composition/core/runs/index.js', () => ({ inspectConfiguredPoolCapacity: async () => state.pool ? { schemaVersion: 1 } : null }));
vi.mock('#adapters/index.js', async original => ({ ...await original<object>(),
  workerImagePresence: async (input: { imageId: string }) => { state.presence.push(input.imageId); return state.found; } }));
const { configuredWorkerKinds } = await import('../../../src/composition/core/toolchains/internal/worker-kinds.js');
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
  const connected = createNativeCodingTemplate(undefined, invocation, binding), missing = createNativeCodingTemplate(limits, { ...invocation, provider: 'codex' });
  const mixed = config(connected);
  mixed.admission.registry.profiles.push(missing);
  mixed.admission.registry.kinds.push({ kind: 'missing-code', profile: { id: missing.id, version: missing.version } });
  state.config = mixed;
  expect(await configuredWorkerSetupFact('/unused', 's')).toMatchObject({ ready: true, params: { phase: 'ready', 'image-missing.1': 'missing-code' } });
  expect(await configuredWorkerKinds(mixed as never)).toEqual([{ kind: 'code', reason: null, rebind: false }, { kind: 'missing-code', reason: 'image-missing', rebind: true }]);
  state.pool = false;
  expect(await configuredWorkerSetupFact('/unused', 's')).toMatchObject({ ready: false });
  state.pool = true; state.presence = [];
  // Negative: the same kind bound to a plain Docker template still waits for its image.
  state.config = config(createNativeCodingTemplate(limits, { ...invocation, provider: 'codex' })); // owner 2026-11-08: no Claude Docker template
  expect(await configuredWorkerSetupFact('/unused', 's')).toMatchObject({ ready: false, reason: 'WORKER_SETUP_PENDING' });
  expect(state.presence).toEqual([image]);
  const unusable = config(missing);
  unusable.admission.registry.kinds.push({ kind: 'other-code', profile: { id: missing.id, version: missing.version } });
  state.config = unusable; state.presence = [];
  const waiting = (await configuredWorkerSetupFact('/unused', 's'))!;
  expect(waiting.params['image-missing.1']).toBe('other-code');
  expect(state.presence).toEqual([image]);
  expect(waiting).toMatchObject({ ready: false, params: { phase: 'awaiting-confirmation', 'image-missing.0': 'code' } });
  const { ErrorRegistry } = await import('#platform/index.js');
  expect(ErrorRegistry.createError(waiting.reason, { params: waiting.params, locale: 'en' }).message).toContain('Unusable task kinds (worker image missing): code, other-code.');
  expect(ErrorRegistry.createError(waiting.reason, { params: waiting.params, locale: 'tr' }).message).toContain('Kullanılamayan iş türleri (işçi imajı eksik): code, other-code.');
  const db = new DatabaseSync(':memory:'); migrateLedger(db, 'allow');
  try {
    const owner = new RunIntentApplication(new SqliteRunProposals(db), { verify: async () => ({ id: 'person', issuer: 'os', subject: 'p', assurance: 'os-user', scopeIds: ['s'] }) },
      { authorize: async () => {} }, { sample: () => ({ wallMs: 100, monotonicMs: 100 }) }, async () => configuredWorkerSetupFact('/unused', 's'), async () => {});
    const command = { schemaVersion: 1 as const, scopeId: 's', commandId: 'mixed-setup', intent: 'Prepare business readback' };
    expect((await owner.preflight(command))?.intent.status).toBe('parked');
    state.config = mixed;
    expect((await owner.transition({ command, commandId: 'ready', expectedRevision: 0, action: 'fact' })).intent.status).toBe('released');
    expect(db.prepare('SELECT count(*) AS n FROM runs').get()?.n).toBe(0);
  } finally { db.close(); }
  state.config = unusable;
  state.phase = 'acquiring';
  expect(await configuredWorkerSetupFact('/unused', 's')).toMatchObject({ ready: false, params: { phase: 'acquiring' } });
  state.found = 'present';
  expect(await configuredWorkerSetupFact('/unused', 's')).toMatchObject({ ready: true, params: { phase: 'ready' } });
  state.found = 'unknown';
  expect(await configuredWorkerSetupFact('/unused', 's')).toMatchObject({ ready: false, params: { 'image-unverified.0': 'code' } });
});
