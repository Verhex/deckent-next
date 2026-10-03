import { createHash } from 'node:crypto';
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
const run = (runId: string, kind: string, scopeId = 's') => ({ schemaVersion: 1 as const, commandId: `create-${runId}`, scopeId, runId, graph: graph(kind) });

/** `catalogScopes`: 'all' = installation catalog administrator (the default), a list = a scope-limited activator, null = no catalog grant. */
async function fixture(catalogScopes: 'all' | readonly string[] | null = 'all', extraProfiles: readonly Profile[] = []) {
  const project = await mkdtemp(join(tmpdir(), 'dn-worker-model-')); roots.push(project); const data = join(project, 'd');
  await mkdir(join(project, '.deckent'), { recursive: true }); const options = { env: { HOME: join(project, 'h') } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1,
    ordering: 'input-order', registry: { ...registry, profiles: [...registry.profiles, ...extraProfiles],
      kinds: [...registry.kinds, ...extraProfiles.map(profile => ({ kind: profile.id, profile: { id: profile.id, version: 1 } }))] } }, cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
  cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 }, service: { inputMaxBytes: 65536, responseMaxBytes: 65536,
    maxConnections: 4, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 } }));
  const { store, path } = await openConfiguredAttemptStore(project, options);
  try { await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); } finally { store.close(); }
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'inspect', 'reserve'], scopes: ['s', 'b'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s', 'b'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s', 'b'], principals, resource: { kind: 'scope', ids: ['s', 'b'] } },
    ...(catalogScopes ? [{ id: 'catalog', effect: 'allow', actions: ['activate', 'deactivate'], scopes: catalogScopes, principals, resource: { kind: 'model-activation', ids: 'all' } }] : []),
  ] }), { mode: 0o600 });
  let sequence = 0;
  const catalog = (command: Record<string, unknown>) => applyModelCatalog(project, { schemaVersion: 1, commandId: `catalog-${++sequence}`, scopeId: 's', ...command }, options);
  const activation = (modelId: string | null, action = 'activate', expectedRevision = 0, scopeId = 's') => catalog({ action, channelId: SEED_CHANNEL, modelId, expectedRevision, scopeId });
  const count = (table: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n; } finally { db.close(); } };
  const runs = () => count('runs');
  const rows = (table: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all(); } finally { db.close(); } };
  return { project, options, path, catalog, activation, runs, count, rows, policy: join(data, 'policy.json'), principals };
}
async function seeded(extraProfiles: readonly Profile[] = []) {
  const f = await fixture('all', extraProfiles); await f.catalog({ action: 'register', catalog: await seedCatalog() });
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
    const { pool, ...inspected } = (await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'running' }, f.options)).run;
    expect(inspected).toEqual(created.admission.run);
    expect(pool).toEqual({ poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 },
      effectiveCapacity: { executionSlots: 1, inFlightSlots: 1 }, occupancy: { execution: 0, inFlight: 0 }, drift: [], waiting: [] });
    expect((await reserveRunTasks(f.project, { schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'running', expectedRevision: 0 }, f.options))
      .reservation.identities).toHaveLength(1);
    await expect(createRun(f.project, run('new', 'sonnet'), f.options)).rejects.toMatchObject({ code: 'WORKER_MODEL_NOT_ACTIVE' });
  });
  it('governs catalog writes with the existing model-activation authority and receipts', async () => {
    const f = await fixture(null);
    await expect(f.catalog({ action: 'register', catalog: await seedCatalog() })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const db = new DatabaseSync(f.path, { readOnly: true });
    try { expect(db.prepare('SELECT count(*) AS n FROM model_catalog_receipts').get()!.n).toBe(0); } finally { db.close(); }
    const g = await fixture(); const receipt = (await g.catalog({ action: 'register', catalog: await seedCatalog() })).receipt;
    expect(receipt.authorizations).toEqual([{ target: { channelId: SEED_CHANNEL, modelId: null }, action: 'activate', level: 'installation', authorization: { revision: 'p', ruleId: 'catalog' } }]);
    expect(receipt.actor).toMatchObject({ issuer: hostname(), subject: String(userInfo().uid) });
    await expect(g.catalog({ action: 'register', catalog: { schemaVersion: 1, revision: 'v1', providers: [] } })).rejects.toMatchObject({ code: 'MODEL_CATALOG_INVALID' });
  });
  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] refuses through the runtime service with the typed code and admits the exact model through the same service', async () => {
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

/** Astra 2197 fixes (WC-R1, WC-R2): shared catalog facts need installation authority; the executed argv is bound to the pin. */
describe.skipIf(process.platform === 'win32')('WORKER-CURRENCY-1 review fixes (Astra 2197)', () => {
  it('WC-R1: a principal allowed only in scope s cannot change installation-wide facts that decide scope b; activation rows stay scope-owned', async () => {
    const admin = await seeded();
    await admin.activation(null, 'activate', 0, 'b'); await admin.activation('claude-sonnet-5-5', 'activate', 0, 'b'); await admin.activation(HAIKU, 'activate', 0, 'b');
    // Hand the same ledger to a scope-limited activator: only scope s may be administered.
    const policy = JSON.parse(await readFile(admin.policy, 'utf8'));
    policy.grants = policy.grants.map((grant: { id: string }) => grant.id === 'catalog' ? { ...grant, scopes: ['s'] } : grant); policy.revision = 'scoped';
    await writeFile(admin.policy, JSON.stringify(policy), { mode: 0o600 }); clearConfigCache();
    const tables = ['model_catalog_channels', 'model_catalog_models', 'model_catalog_activations', 'model_catalog_receipts'];
    const before = Object.fromEntries(tables.map(table => [table, admin.rows(table)]));
    const retired = await seedCatalog(); (retired.providers[0].models as { nativeId: string; lifecycle: Record<string, unknown> }[])
      .find(entry => entry.nativeId === 'claude-sonnet-5-5')!.lifecycle = { state: 'retired', deprecatedOn: null, retireNotBefore: null, retiredOn: '2026-09-30', source: null };
    await expect(admin.catalog({ action: 'register', catalog: { ...retired, revision: 'scoped-retire' } })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(Object.fromEntries(tables.map(table => [table, admin.rows(table)]))).toEqual(before);
    // Scope b still admits sonnet: its decision did not move.
    expect((await createRun(admin.project, run('b-ok', 'sonnet', 'b'), admin.options)).admission.run.runId).toBe('b-ok');
    // Scope authority still governs its own activation rows only.
    await admin.activation('claude-sonnet-5-5', 'deactivate', 1, 's');
    await expect(admin.activation('claude-sonnet-5-5', 'deactivate', 1, 'b')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // An installation-authorized principal makes the same fact change with exactly one receipt at level installation.
    policy.grants = policy.grants.map((grant: { id: string }) => grant.id === 'catalog' ? { ...grant, scopes: 'all' } : grant); policy.revision = 'installation';
    await writeFile(admin.policy, JSON.stringify(policy), { mode: 0o600 }); clearConfigCache();
    const receipts = admin.count('model_catalog_receipts');
    const applied = await admin.catalog({ action: 'register', catalog: { ...retired, revision: 'installation-retire' } });
    expect(applied.receipt.authorizations).toEqual([{ target: { channelId: SEED_CHANNEL, modelId: null }, action: 'activate', level: 'installation',
      authorization: { revision: 'installation', ruleId: 'catalog' } }]);
    expect(admin.count('model_catalog_receipts')).toBe(receipts + 1);
    await expect(createRun(admin.project, run('b-retired', 'sonnet', 'b'), admin.options)).rejects.toMatchObject({ code: 'WORKER_MODEL_RETIRED' });
    // A deny in any one scope blocks an installation fact change even for an 'all' grant (delegation bound, no scope is skipped).
    policy.restrictions = [{ id: 'freeze-b', actions: ['activate'], scopes: ['b'], principals: admin.principals, resource: { kind: 'model-activation', ids: 'all' } }];
    policy.revision = 'freeze'; await writeFile(admin.policy, JSON.stringify(policy), { mode: 0o600 }); clearConfigCache();
    await expect(admin.catalog({ action: 'register', catalog: { ...retired, revision: 'frozen' } })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  const base = () => compiled('bound', invocation('claude-sonnet-5-5'));
  const edit = (id: string, change: (argv: string[], binding: { model: { modelId: string }; provider: string }) => void, rehash = false): Profile => {
    const profile = base(); const argv = [...profile.parameters.argv as string[]];
    const binding = structuredClone(profile.parameters.nativeSubscription) as { model: { modelId: string }; provider: string; promptDelivery?: { argvSha256: string } };
    change(argv, binding);
    if (rehash && binding.promptDelivery) binding.promptDelivery.argvSha256 = createHash('sha256').update(JSON.stringify(argv)).digest('hex');
    return { ...profile, id, parameters: { ...profile.parameters, argv, nativeSubscription: binding } };
  };
  const at = (argv: string[], value: string) => argv.indexOf(value);
  const composedBase = () => compiled('bound-composed', { ...invocation('claude-sonnet-5-5'), prompt: undefined, composition: { schemaVersion: 1,
    persona: { id: 'p', version: 1, text: 'Check.' }, skills: [], context: [], task: 'Edit note.txt.', scope: 'note.txt', acceptance: 'Exact.' } });
  const composedEdit = (id: string, rehash: boolean): Profile => {
    const profile = composedBase(); const argv = [...profile.parameters.argv as string[]]; argv[at(argv, '--model') + 1] = 'claude-opus-5-5';
    const binding = structuredClone(profile.parameters.nativeSubscription) as { promptDelivery: { argvSha256: string } };
    if (rehash) binding.promptDelivery.argvSha256 = createHash('sha256').update(JSON.stringify(argv)).digest('hex');
    return { ...profile, id, parameters: { ...profile.parameters, argv, nativeSubscription: binding } };
  };
  const tampered: Profile[] = [
    edit('argv-alias', argv => { argv[at(argv, '--model') + 1] = 'sonnet'; }),
    edit('argv-other-model', argv => { argv[at(argv, '--model') + 1] = 'claude-opus-5-5'; }),
    edit('metadata-other-model', (_argv, binding) => { binding.model.modelId = 'claude-opus-5-5'; }),
    edit('duplicate-model-flag', argv => { argv.splice(at(argv, '--model'), 0, '--model', 'claude-opus-5-5'); }),
    edit('inline-model-flag', argv => { argv.splice(1, 0, '--model=claude-opus-5-5'); }),
    edit('model-flag-moved', argv => { const i = at(argv, '--model'); const pair = argv.splice(i, 2); argv.splice(1, 0, ...pair); }),
    edit('fallback-flag', argv => { argv.splice(at(argv, '--model'), 0, '--fallback-model', 'claude-opus-5-5'); }),
    edit('executable-mismatch', argv => { argv[0] = 'codex'; }),
    edit('provider-mismatch', (_argv, binding) => { binding.provider = 'cursor'; }),
    composedEdit('composed-argv-model', false), composedEdit('composed-argv-model-rehashed', true),
  ];
  it('WC-R2: SDK createRun refuses every argv/pin divergence with one typed code before any write; compiler output passes', async () => {
    const f = await seeded([...tampered, composedBase(), base()]);
    const before = await readFile(f.path);
    for (const profile of tampered) {
      await expect(createRun(f.project, run(`t-${profile.id}`, profile.id), f.options), profile.id).rejects.toMatchObject({ code: 'WORKER_MODEL_BINDING_MISMATCH' });
    }
    expect(f.runs()).toBe(0); expect(f.count('run_receipts')).toBe(0); expect(await readFile(f.path)).toEqual(before);
    expect((await createRun(f.project, run('plain', 'bound'), f.options)).admission.run.runId).toBe('plain');
    expect((await createRun(f.project, run('composed', 'bound-composed'), f.options)).admission.run.runId).toBe('composed');
  });
  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] WC-R2: the runtime service refuses with the same typed code before any write', async () => {
    const f = await seeded(tampered); const observer = { async onPage() {}, async onError() {} };
    const service = await startConfiguredRuntimeService(f.project, observer, f.options); const client = createConfiguredRuntimeClient(f.project, f.options);
    try {
      for (const id of ['argv-alias', 'duplicate-model-flag', 'executable-mismatch', 'composed-argv-model-rehashed']) {
        await expect(client.createRun(run(`svc-${id}`, id)), id).rejects.toMatchObject({ code: 'WORKER_MODEL_BINDING_MISMATCH' });
      }
      expect(f.runs()).toBe(0); expect(f.count('run_receipts')).toBe(0);
    } finally { await service.stop(); await service.done; }
  });
});

