import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyModelCatalog, createConfiguredRuntimeClient, createRun, inspectRun, reserveRunTasks, startConfiguredRuntimeService } from '../../../src/index.js';
import { compileNativeCodingDockerProfile } from '#adapters/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache } from '#platform/index.js';
import { seedCatalog, SEED_CHANNEL } from '../support/model-catalog.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const template = { id: 'coding', version: 1, adapter: { id: 'docker', version: 2 }, parameters: { argv: ['unused'], imageId: 'sha256:' + 'a'.repeat(64),
  memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 } };
const HAIKU = 'claude-haiku-4-5-20251001';
const invocation = (modelId: string, cli = '2.1.285', auxiliaryModelIds = [HAIKU], provider = 'claude') => ({ schemaVersion: 4, provider,
  cliVersion: provider === 'claude' ? `${cli} (Claude Code)` : `codex-cli ${cli}`, discovery: { schemaVersion: 1, mode: 'repository' },
  permissionMode: 'unattended', model: { channelId: SEED_CHANNEL, modelId, auxiliaryModelIds }, prompt: 'Edit note.txt.' });
type Profile = ReturnType<typeof compileNativeCodingDockerProfile>;
const compiled = (id: string, input: unknown): Profile => ({ ...compileNativeCodingDockerProfile(template, input), id });
/** A registry profile an operator could write by hand (bypassing `coding prepare`): only the model reference is changed. */
function handPinned(id: string, modelId: string): Profile {
  const profile = compiled(id, invocation('claude-sonnet-5-5'));
  const argv = profile.parameters.argv as string[]; const binding = profile.parameters.nativeSubscription as { model: { modelId: string } };
  return { ...profile, parameters: { ...profile.parameters, argv: argv.map(arg => arg === 'claude-sonnet-5-5' ? modelId : arg),
    nativeSubscription: { ...binding, model: { ...binding.model, modelId } } } };
}
const profiles: Profile[] = [
  compiled('sonnet', invocation('claude-sonnet-5-5')),
  compiled('sonnet-r3-cli', invocation('claude-sonnet-5-5', '2.1.278')),
  compiled('opus-stable-cli', invocation('claude-opus-5-5', '2.1.280', [])),
  compiled('opus-old-cli', invocation('claude-opus-5-5', '2.1.279', [])),
  compiled('fable', invocation('claude-fable-5-1', '2.1.285', [])),
  compiled('haiku', invocation(HAIKU, '2.1.285', [])),
  compiled('api-alias', invocation('claude-haiku-4-5', '2.1.285', [])),
  handPinned('cli-alias', 'sonnet'),
  compiled('unknown', invocation('claude-sonnet-9-9')),
  compiled('codex-on-claude', invocation('gpt-exact-1', '0.159.2', [], 'codex')),
  { ...compileNativeCodingDockerProfile(template, { ...invocation('x'), schemaVersion: 3, model: 'claude-sonnet-5-5' }), id: 'unpinned' },
];
const registry = { schemaVersion: 1 as const, revision: 'worker-currency', profiles,
  kinds: profiles.map(profile => ({ kind: profile.id, profile: { id: profile.id, version: 1 } })),
  evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] };
const graph = (kind: string) => ({ schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind, dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] });
const run = (runId: string, kind: string) => ({ schemaVersion: 1 as const, commandId: `create-${runId}`, scopeId: 's', runId, graph: graph(kind) });

async function fixture(catalogGrant = true) {
  const project = await mkdtemp(join(tmpdir(), 'dn-worker-model-')); roots.push(project); const data = join(project, 'd');
  await mkdir(join(project, '.deckent'), { recursive: true }); const options = { env: { HOME: join(project, 'h') } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1,
    ordering: 'input-order', registry }, cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
  cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 }, service: { inputMaxBytes: 65536, responseMaxBytes: 65536,
    maxConnections: 4, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 } }));
  const { store, path } = await openConfiguredAttemptStore(project, options);
  try { await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); } finally { store.close(); }
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'inspect', 'reserve'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    ...(catalogGrant ? [{ id: 'catalog', effect: 'allow', actions: ['activate', 'deactivate'], scopes: ['s'], principals, resource: { kind: 'model-activation', ids: 'all' } }] : []),
  ] }), { mode: 0o600 });
  let sequence = 0;
  const catalog = (command: Record<string, unknown>) => applyModelCatalog(project, { schemaVersion: 1, commandId: `catalog-${++sequence}`, scopeId: 's', ...command }, options);
  const activation = (modelId: string | null, action = 'activate', expectedRevision = 0) => catalog({ action, channelId: SEED_CHANNEL, modelId, expectedRevision });
  const runs = () => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('SELECT count(*) AS n FROM runs').get()!.n; } finally { db.close(); } };
  return { project, options, path, catalog, activation, runs };
}
async function seeded() {
  const f = await fixture(); await f.catalog({ action: 'register', catalog: await seedCatalog() });
  await f.activation(null);
  for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', HAIKU]) await f.activation(model);
  return f;
}

describe.skipIf(process.platform === 'win32')('new worker Run admission against the ledger model catalog (WORKER-CURRENCY-1)', () => {
  it('admits the exact, current, active model of an active channel with a CLI at its minimum, and records nothing on refusal', async () => {
    const f = await seeded();
    const created = await createRun(f.project, run('ok', 'sonnet'), f.options);
    expect(created.admission.run.tasks[0]!.phase).toBe('pending');
    expect((await createRun(f.project, run('stable', 'opus-stable-cli'), f.options)).admission.run.runId).toBe('stable');
    expect(f.runs()).toBe(2);
    const before = await readFile(f.path);
    for (const [kind, code] of [['cli-alias', 'WORKER_MODEL_ALIAS_REFUSED'], ['api-alias', 'WORKER_MODEL_ALIAS_REFUSED'], ['unknown', 'WORKER_MODEL_UNKNOWN'],
      ['unpinned', 'WORKER_MODEL_UNPINNED'], ['sonnet-r3-cli', 'WORKER_MODEL_CLI_TOO_OLD'], ['opus-old-cli', 'WORKER_MODEL_CLI_TOO_OLD'],
      ['codex-on-claude', 'WORKER_CHANNEL_MISMATCH']] as const) {
      await expect(createRun(f.project, run(`refused-${kind}`, kind), f.options)).rejects.toMatchObject({ code });
    }
    await expect(createRun(f.project, run('r3', 'sonnet-r3-cli'), f.options)).rejects.toMatchObject({ code: 'WORKER_MODEL_CLI_TOO_OLD',
      message: expect.stringContaining('2.1.284') });
    expect(f.runs()).toBe(2); expect(await readFile(f.path)).toEqual(before);
  });
  it('refuses inactive channels and models, legacy/deprecated and retired lifecycles (also for a declared helper model)', async () => {
    const f = await fixture(); const catalog = await seedCatalog(); await f.catalog({ action: 'register', catalog });
    await expect(createRun(f.project, run('no-channel', 'sonnet'), f.options)).rejects.toMatchObject({ code: 'WORKER_CHANNEL_NOT_ACTIVE' });
    await f.activation(null);
    await expect(createRun(f.project, run('no-model', 'sonnet'), f.options)).rejects.toMatchObject({ code: 'WORKER_MODEL_NOT_ACTIVE' });
    await f.activation('claude-sonnet-5-5');
    // The declared helper model must itself be active.
    await expect(createRun(f.project, run('no-helper', 'sonnet'), f.options)).rejects.toMatchObject({ code: 'WORKER_MODEL_NOT_ACTIVE' });
    await f.activation(HAIKU); await f.activation('claude-fable-5-1');
    expect((await createRun(f.project, run('ok', 'sonnet'), f.options)).admission.run.runId).toBe('ok');
    const edited = structuredClone(catalog); const models = edited.providers[0].models as { nativeId: string; lifecycle: Record<string, unknown> }[];
    const set = (id: string, lifecycle: Record<string, unknown>) => { const model = models.find(entry => entry.nativeId === id)!; model.lifecycle = { ...model.lifecycle, ...lifecycle }; };
    set('claude-fable-5-1', { state: 'deprecated', deprecatedOn: '2026-09-30' }); set(HAIKU, { state: 'retired', retiredOn: '2026-10-15' });
    await f.catalog({ action: 'register', catalog: { ...edited, revision: 'lifecycle-update' } });
    await expect(createRun(f.project, run('fable', 'fable'), f.options)).rejects.toMatchObject({ code: 'WORKER_MODEL_NOT_CURRENT' });
    await expect(createRun(f.project, run('haiku', 'haiku'), f.options)).rejects.toMatchObject({ code: 'WORKER_MODEL_RETIRED' });
    await expect(createRun(f.project, run('sonnet-helper-retired', 'sonnet'), f.options)).rejects.toMatchObject({ code: 'WORKER_MODEL_RETIRED' });
    // A retirement day that has passed retires an entry even while its recorded state still says active.
    const past = structuredClone(catalog); (past.providers[0].models as { nativeId: string; lifecycle: Record<string, unknown> }[])
      .find(entry => entry.nativeId === 'claude-sonnet-5-5')!.lifecycle.retiredOn = '2026-01-01';
    await f.catalog({ action: 'register', catalog: { ...past, revision: 'announced-retirement-passed' } });
    await expect(createRun(f.project, run('sonnet-past-day', 'sonnet'), f.options)).rejects.toMatchObject({ code: 'WORKER_MODEL_RETIRED' });
    const unnamed = structuredClone(catalog); (unnamed.providers[0].models as { nativeId: string; lifecycle: Record<string, unknown> }[])
      .find(entry => entry.nativeId === 'claude-sonnet-5-5')!.lifecycle.state = 'retired';
    await expect(f.catalog({ action: 'register', catalog: { ...unnamed, revision: 'retired-without-day' } })).rejects.toMatchObject({ code: 'MODEL_CATALOG_INVALID' });
  });
  it('leaves admitted Runs untouched: replay, inspect and reserve still work after the model is deactivated; only new Runs are refused', async () => {
    const f = await seeded();
    const created = await createRun(f.project, run('running', 'sonnet'), f.options);
    await f.activation('claude-sonnet-5-5', 'deactivate', 1);
    expect(await createRun(f.project, run('running', 'sonnet'), f.options)).toEqual(created);
    expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'running' }, f.options)).run).toEqual(created.admission.run);
    expect((await reserveRunTasks(f.project, { schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'running', expectedRevision: 0 }, f.options))
      .reservation.identities).toHaveLength(1);
    await expect(createRun(f.project, run('new', 'sonnet'), f.options)).rejects.toMatchObject({ code: 'WORKER_MODEL_NOT_ACTIVE' });
  });
  it('governs catalog writes with the existing model-activation authority and receipts', async () => {
    const f = await fixture(false);
    await expect(f.catalog({ action: 'register', catalog: await seedCatalog() })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const db = new DatabaseSync(f.path, { readOnly: true });
    try { expect(db.prepare('SELECT count(*) AS n FROM model_catalog_receipts').get()!.n).toBe(0); } finally { db.close(); }
    const g = await fixture(); const receipt = (await g.catalog({ action: 'register', catalog: await seedCatalog() })).receipt;
    expect(receipt.authorizations).toEqual([{ target: { channelId: SEED_CHANNEL, modelId: null }, action: 'activate', authorization: { revision: 'p', ruleId: 'catalog' } }]);
    expect(receipt.actor).toMatchObject({ issuer: hostname(), subject: String(userInfo().uid) });
    await expect(g.catalog({ action: 'register', catalog: { schemaVersion: 1, revision: 'v1', providers: [] } })).rejects.toMatchObject({ code: 'MODEL_CATALOG_INVALID' });
  });
  it('refuses through the runtime service with the typed code and admits the exact model through the same service', async () => {
    const f = await seeded(); const observer = { async onPage() {}, async onError() {} };
    const service = await startConfiguredRuntimeService(f.project, observer, f.options); const client = createConfiguredRuntimeClient(f.project, f.options);
    try {
      await expect(client.createRun(run('svc-alias', 'cli-alias'))).rejects.toMatchObject({ code: 'WORKER_MODEL_ALIAS_REFUSED' });
      await expect(client.createRun(run('svc-old', 'sonnet-r3-cli'))).rejects.toMatchObject({ code: 'WORKER_MODEL_CLI_TOO_OLD' });
      expect(f.runs()).toBe(0);
      expect((await client.createRun(run('svc-ok', 'sonnet'))).admission.run.runId).toBe('svc-ok');
      expect(f.runs()).toBe(1);
    } finally { await service.stop(); await service.done; }
  });
});
