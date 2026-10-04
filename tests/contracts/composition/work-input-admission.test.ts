import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyModelCatalog, createConfiguredRuntimeClient, createRun, inspectRun, reserveRunTasks, startConfiguredRuntimeService } from '../../../src/index.js';
import { inspectMonitor } from '#composition/index.js';
import { runCommand } from '../../../src/surfaces/core/cli/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { admittedToolchains } from '../../../src/engine/core/toolchain-currency/index.js';
import { assertNativeWorkerBinding, compileNativeCodingDockerProfile, FileArtifactStore, nativeCodingTemplateBase, openSqliteAttemptStore } from '#adapters/index.js';
import { encodeExecutionProfileDefinition, readWorkerModelPin, validateTaskGraph, TASK_GRAPH_SCHEMA_VERSION, type AttemptIdentity } from '#domain/index.js';
import { clearConfigCache, prepareProductDirectory } from '#platform/index.js';
import { seedCatalog, SEED_CHANNEL } from '../support/model-catalog.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

/** K3 = A (owner 2026-09-30): task graph v3 typed work input + reusable coding template compiled once at Run admission. */
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const HAIKU = 'claude-haiku-4-5-20251001';
const docker = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
  deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const parts = { persona: { id: 'implementer', version: 1, text: 'You implement exactly one card.' }, context: [{ id: 'repo-tooling', version: 2, text: 'Use npm scripts.' }] };
const claudeInvocation = { provider: 'claude', cliVersion: '2.1.285 (Claude Code)', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended',
  maxTurns: 40, composition: parts };
const codexInvocation = { provider: 'codex', cliVersion: 'codex-cli 0.159.2', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended' };
const template = (id: string, invocation: object) => ({ id, version: 1, adapter: { id: 'native-coding-template', version: 1 }, parameters: { schemaVersion: 1, docker, invocation } });
const TASK = 'Append the line "done" to note.txt.', ACCEPTANCE = 'note.txt ends with the line "done".', PATHS = ['note.txt', 'src/notes/**'];
const workInput = (modelId = 'claude-sonnet-5-5', extra: object = {}, auxiliaryModelIds = [HAIKU]) => ({ schemaVersion: 1, task: TASK, scope: { paths: PATHS },
  acceptance: ACCEPTANCE, model: { channelId: SEED_CHANNEL, modelId, auxiliaryModelIds }, ...extra });
/** What an operator prepared by hand before K3 (one registry profile per card, task text inside): `coding prepare` output. */
const handPrepared = (id: string, maxTurns = 40, policy = false) => ({ ...compileNativeCodingDockerProfile(
  { id: 'coding', version: 1, adapter: { id: 'docker', version: 2 }, parameters: { argv: ['unused'], ...docker } },
  { schemaVersion: 4, ...claudeInvocation, maxTurns, model: { channelId: SEED_CHANNEL, modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [HAIKU] },
    composition: { schemaVersion: 1, ...parts, task: TASK, scope: 'note.txt\nsrc/notes/**', acceptance: ACCEPTANCE } }, policy ? { schemaVersion: 1, level: 'xhigh', source: 'policy-default', status: 'selected', workClass: 'feature', policyRevision: 'worker-effort-2026-10-03', target: 'xhigh' } : undefined), id });
const profiles = [template('coding', claudeInvocation), template('codex-coding', codexInvocation), handPrepared('hand')];
const registry = { schemaVersion: 1 as const, revision: 'k3', profiles, kinds: [{ kind: 'coding', profile: { id: 'coding', version: 1 } },
  { kind: 'codex-coding', profile: { id: 'codex-coding', version: 1 } }, { kind: 'hand', profile: { id: 'hand', version: 1 } }],
evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] };
const criteria = [{ id: 'exit', version: 1, description: 'Accept zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }];
const graph = (kind: string, input?: object, schemaVersion = 3) => ({ schemaVersion, revision: 1,
  tasks: [{ id: 't', kind, dependencies: [], acceptanceCriteria: ['exit'], ...(input ? { workInput: input } : {}) }], criterionDefinitions: criteria });
const run = (runId: string, kind: string, input?: object, schemaVersion = 3) => ({ schemaVersion: 1 as const, commandId: `create-${runId}`, scopeId: 's', runId,
  graph: graph(kind, input, schemaVersion) });

async function seeded(localRegistry: object = registry, suppliedCatalog?: object) {
  const project = await mkdtemp(join(tmpdir(), 'dn-work-input-')); roots.push(project); const data = join(project, 'd');
  await mkdir(join(project, '.deckent'), { recursive: true }); const options = { env: { HOME: join(project, 'h') } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1,
    ordering: 'input-order', registry: localRegistry }, cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
  cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 }, service: { inputMaxBytes: 65536, responseMaxBytes: 65536,
    maxConnections: 4, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 } }));
  const { store, path } = await openConfiguredAttemptStore(project, options);
  try { await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); } finally { store.close(); }
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'inspect', 'reserve'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'catalog', effect: 'allow', actions: ['activate', 'deactivate'], scopes: 'all', principals, resource: { kind: 'model-activation', ids: 'all' } },
  ] }), { mode: 0o600 });
  let sequence = 0;
  const catalog = (command: Record<string, unknown>) => applyModelCatalog(project, { schemaVersion: 1, commandId: `catalog-${++sequence}`, scopeId: 's', ...command }, options);
  const activation = (modelId: string | null, action = 'activate', expectedRevision = 0, channelId = SEED_CHANNEL) => catalog({ action, channelId, modelId, expectedRevision });
  await catalog({ action: 'register', catalog: suppliedCatalog ?? await seedCatalog() });
  // Opus stays inactive on purpose: a work input naming it is refused as not active.
  await activation(null); await activation('claude-sonnet-5-5'); await activation(HAIKU);
  const read = <T>(sql: string, ...args: string[]) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all(...args) as T[]; } finally { db.close(); } };
  const runs = () => read<{ n: number }>('SELECT count(*) AS n FROM runs')[0]!.n;
  const snapshotProfile = (runId: string) => (JSON.parse(read<{ snapshot: string }>('SELECT snapshot FROM runs WHERE run_id = ?', runId)[0]!.snapshot) as
    { execution: { schemaVersion: number; tasks: { profile: { id: string; parameters: Record<string, unknown> } }[] } }).execution;
  const snapshotAttempt = (attemptId: string) => JSON.parse(read<{ snapshot: string }>('SELECT snapshot FROM attempts WHERE attempt_id = ?', attemptId)[0]!.snapshot);
  return { project, options, path, activation, runs, snapshotProfile, snapshotAttempt };
}

/** Real terminal dispatch fixture: no worker/provider is launched and monitor output access stays denied. */
async function terminal(f: Awaited<ReturnType<typeof seeded>>, runId: string, identity: AttemptIdentity) {
  const opened = await openConfiguredAttemptStore(f.project, f.options); opened.store.close();
  const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(opened.layout, 'artifacts'), maxBytes: 65536 });
  const store = await openSqliteAttemptStore(f.path, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
  const claim = { owner: 'fixture-worker', request: { protocolVersion: 1 as const, identity, workspace: '/terminal-effort-fixture', argv: ['fixture'] } };
  try {
    await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
    await store.retainDispatchOutput(claim, await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: 'complete', stdout: 'done', stderr: '' }))));
    await store.finishDispatch(claim, { handle: identity.attemptId, exitCode: 0, interrupted: false });
  } finally { store.close(); }
  return async () => {
    const writer = await openSqliteAttemptStore(f.path, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
    try {
      const dispatch = (await writer.readDispatch(claim.request))!, current = (await writer.loadRun('s', runId))!;
      const pin = readWorkerModelPin(current.execution.tasks[0]!.profile.parameters)!;
      const model = { provider: pin.provider, evidenceCapability: pin.evidenceCapability, requested: pin.pin, init: null, usage: null,
        verdict: 'unverified' as const, unexpected: [], evidence: 'absent' as const };
      await writer.commitTaskEvaluation({ commandId: `evaluate-${runId}`, actor: { id: 'fixture', issuer: 'test', subject: 'service' }, expectedRevision: current.revision,
        dispatch, evaluation: { schemaVersion: 1, evaluationId: `evaluate-${runId}`, identity, graphRevision: 1, attemptRevision: (await writer.load('s', identity.attemptId))!.revision,
          criteria: [{ criterionId: 'exit', verdict: 'unknown', evidenceIds: [] }], model } });
      return model;
    } finally { writer.close(); }
  };
}

describe('task graph v3 work input (domain)', () => {
  it('accepts v2 unchanged and v3 with or without a work input; a v2 graph never carries one; inputs are bounded and exact', () => {
    expect(TASK_GRAPH_SCHEMA_VERSION).toBe(4);
    expect(validateTaskGraph(graph('hand', undefined, 2)).schemaVersion).toBe(2);
    expect(validateTaskGraph(graph('coding', workInput())).tasks[0]!.workInput!.model.modelId).toBe('claude-sonnet-5-5');
    const invalid = (input: unknown, schemaVersion = 3) => expect(() => validateTaskGraph(graph('coding', input as object, schemaVersion))).toThrow(expect.objectContaining({ code: 'TASK_GRAPH_INVALID' }));
    invalid(workInput(), 2);
    invalid({ ...workInput(), scope: { paths: ['../escape'] } }); invalid({ ...workInput(), scope: { paths: ['/abs'] } });
    invalid({ ...workInput(), scope: { paths: ['a', 'a'] } }); invalid({ ...workInput(), scope: { paths: [] } });
    invalid({ ...workInput(), task: 'x'.repeat(16_385) }); invalid(workInput('-flag')); invalid(workInput('claude-sonnet-5-5', { effort: 'extreme' }));
    invalid({ ...workInput(), prompt: 'extra' });
  });
});

describe.skipIf(process.platform === 'win32')('K3 work input admission through the real composition', () => {
  it('compiles task inputs with class effort while preserving prepared prompt and work bounds', async () => {
    const f = await seeded();
    await createRun(f.project, run('v3', 'coding', workInput()), f.options);
    await createRun(f.project, run('v2', 'hand', undefined, 2), f.options); // the pre-K3 path, unchanged
    const compiled = f.snapshotProfile('v3'), prepared = f.snapshotProfile('v2');
    expect(compiled.schemaVersion).toBe(1); // Run execution snapshot unchanged
    const v3 = compiled.tasks[0]!.profile, v2 = prepared.tasks[0]!.profile;
    expect(v3.id).toBe('coding'); // provenance: the template's registry identity
    expect(v2.parameters.deadlineMs).toBe(v3.parameters.deadlineMs);
    expect((v2.parameters.nativeSubscription as { promptDelivery: { task: string } }).promptDelivery.task).toBe((v3.parameters.nativeSubscription as { promptDelivery: { task: string } }).promptDelivery.task);
    expect(encodeExecutionProfileDefinition(v3)).toBe(encodeExecutionProfileDefinition(handPrepared('coding', 40, true)));
    expect(() => assertNativeWorkerBinding(v3 as never)).not.toThrow(); // WC-R2
    const argv = v3.parameters['argv'] as string[];
    expect(argv.slice(-4)).toEqual(['--model', 'claude-sonnet-5-5', '--', '__DECKENT_TASK_PROMPT__']);
    expect(argv).toContain('--max-turns');
    expect((v3.parameters['nativeSubscription'] as { model: unknown }).model).toEqual({ channelId: SEED_CHANNEL, modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [HAIKU] });
    // The work input's turn limit overrides the template's; the template itself holds no task text.
    await createRun(f.project, run('turns', 'coding', workInput('claude-sonnet-5-5', { maxTurns: 7 })), f.options);
    expect(encodeExecutionProfileDefinition(f.snapshotProfile('turns').tasks[0]!.profile)).toBe(encodeExecutionProfileDefinition(handPrepared('coding', 7, true)));
    await createRun(f.project, run('turns-eq', 'coding', workInput('claude-sonnet-5-5', { maxTurns: 40 })), f.options);
    expect(encodeExecutionProfileDefinition(f.snapshotProfile('turns-eq').tasks[0]!.profile)).toBe(encodeExecutionProfileDefinition(handPrepared('coding', 40, true)));
    expect(JSON.stringify(registry.profiles[0])).not.toContain(TASK);
  });

  it('refuses alias, unknown, inactive, unsupported effort, turn limit and unpaired inputs with typed codes before any write', async () => {
    const f = await seeded();
    const before = await readFile(f.path);
    for (const [label, input, kind, code] of [
      ['cli-alias', workInput('sonnet'), 'coding', 'WORKER_MODEL_ALIAS_REFUSED'],
      ['catalog-alias', workInput('claude-haiku-4-5', {}, []), 'coding', 'WORKER_MODEL_ALIAS_REFUSED'],
      ['helper-alias', workInput('claude-sonnet-5-5', {}, ['haiku']), 'coding', 'WORKER_MODEL_ALIAS_REFUSED'],
      ['unknown', workInput('claude-sonnet-9-9'), 'coding', 'WORKER_MODEL_UNKNOWN'],
      ['inactive', workInput('claude-opus-5-5', {}, []), 'coding', 'WORKER_MODEL_NOT_ACTIVE'],
      ['effort', workInput(HAIKU, { effort: 'high' }, []), 'coding', 'WORKER_EFFORT_UNSUPPORTED'],
      ['codex-turns', workInput('gpt-exact-1', { maxTurns: 5 }, []), 'codex-coding', 'WORK_INPUT_TURN_LIMIT_UNSUPPORTED'],
      ['turns-exceed', workInput('claude-sonnet-5-5', { maxTurns: 41 }), 'coding', 'WORK_INPUT_TURN_LIMIT_EXCEEDS_TEMPLATE'],
      ['on-prepared', workInput(), 'hand', 'WORK_INPUT_TEMPLATE_REQUIRED'],
    ] as const) {
      await expect(createRun(f.project, run(label, kind, input), f.options), label).rejects.toMatchObject({ code });
    }
    await expect(createRun(f.project, run('no-input', 'coding', undefined, 2), f.options)).rejects.toMatchObject({ code: 'WORK_INPUT_REQUIRED' });
    await expect(createRun(f.project, run('no-input-v3', 'coding'), f.options)).rejects.toMatchObject({ code: 'WORK_INPUT_REQUIRED' });
    expect(f.runs()).toBe(0); expect(await readFile(f.path)).toEqual(before);
    // WORKER-EFFORT: a declared effort reaches the frozen command, before any worker starts.
    const created = await createRun(f.project, run('effort-ok', 'coding', workInput('claude-sonnet-5-5', { effort: 'high' })), f.options);
    expect(created.admission.run.runId).toBe('effort-ok');
    expect(f.snapshotProfile('effort-ok').tasks[0]!.profile.parameters.argv).toContain('--effort');
    expect(f.snapshotProfile('effort-ok').tasks[0]!.profile.parameters.nativeSubscription).toMatchObject({ reasoningEffort: { level: 'high', source: 'explicit', status: 'selected' } });
  });

  it.each(['codex', 'cursor'] as const)('admits %s through the real catalog with exact argv and refuses undeclared effort before writes', async provider => {
    const channelId = `${provider}-fixture`, modelId = provider === 'cursor' ? 'grok-4.7-high' : 'gpt-exact-1';
    const catalog = await seedCatalog();
    catalog.providers.push({ id: channelId, version: 1, channel: { ...catalog.providers[0].channel, cli: provider, client: provider, protocolFamily: 'fixture', aliases: [], aliasesRefused: [] }, models: [{
      ...catalog.providers[0].models.find((row: { nativeId: string }) => row.nativeId === 'claude-sonnet-5-5'),
      id: modelId, nativeId: modelId, channelModelId: modelId, canonicalModelId: modelId, version: 1, protocols: [{ family: 'fixture', version: 'v1', capabilities: [] }],
      lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null }, minCliVersion: null, aliases: [],
      efforts: ['high'], reasoning: { supportedEfforts: ['high'], defaultEffort: 'high' }, minClientVersion: null, ...(provider === 'cursor' ? { effortBinding: { mode: 'fixed-model', level: 'high' } } : {}),
    }] });
    const invocation = { ...codexInvocation, provider };
    const local = { ...registry, profiles: [...registry.profiles, template('native', invocation)], kinds: [...registry.kinds, { kind: 'feature', profile: { id: 'native', version: 1 } }] };
    const f = await seeded(local, catalog); await f.activation(null, 'activate', 0, channelId); await f.activation(modelId, 'activate', 0, channelId);
    const input = { ...workInput(modelId, {}, []), model: { channelId, modelId, auxiliaryModelIds: [] } };
    const created = await createRun(f.project, run('native', 'feature', input), f.options);
    expect(created.admission.run.tasks[0]!.reasoningEffort).toMatchObject({ level: 'high', source: 'policy-default', target: 'xhigh' });
    const argv = f.snapshotProfile('native').tasks[0]!.profile.parameters.argv as string[];
    expect(argv.slice(-4, -2)).toEqual(['--model', modelId]);
    if (provider === 'codex') expect(argv).toContain('model_reasoning_effort=high'); else expect(argv).not.toContain('--effort');
    const before = await readFile(f.path);
    await expect(createRun(f.project, run('refused', 'feature', { ...input, effort: 'max' }), f.options)).rejects.toMatchObject({ code: 'WORKER_EFFORT_UNSUPPORTED' });
    expect(await readFile(f.path)).toEqual(before); expect(f.runs()).toBe(1);
  });

  it('shows unsupported without a requested knob, supports explicit over default and keeps replay after policy changes identical', async () => {
    const f = await seeded();
    const unsupported = await createRun(f.project, run('unsupported', 'coding', workInput(HAIKU, {}, [])), f.options);
    expect(unsupported.admission.run.tasks[0]!.reasoningEffort).toMatchObject({ level: null, source: 'cli-default', status: 'unsupported' });
    const created = await createRun(f.project, run('explicit', 'coding', workInput('claude-sonnet-5-5', { effort: 'medium', workClass: 'architecture' })), f.options);
    expect(created.admission.run.tasks[0]!.reasoningEffort).toMatchObject({ level: 'medium', source: 'explicit' });
    const configPath = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
    config.admission.registry.workClasses = { schemaVersion: 1, revision: 'changed', classes: [{ id: 'different', defaultEffort: 'low' }], bindings: [{ kind: 'coding', classId: 'different' }] };
    await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
    expect(await createRun(f.project, run('explicit', 'coding', workInput('claude-sonnet-5-5', { effort: 'medium', workClass: 'architecture' })), f.options)).toEqual(created);
    const inspected = await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'explicit' }, f.options);
    expect(inspected.models[0]!.reasoningEffort).toMatchObject({ level: 'medium', source: 'explicit' });
    for (const lang of ['en', 'tr']) {
      let output = '';
      await runCommand(['run', 'inspect', '--scope', 's', '--id', 'explicit', '--lang', lang],
        { inspectRun, root: f.project, env: f.options.env, stdout: { write(chunk: string) { output += chunk; return true; } } } as never);
      expect(output).toContain(lang === 'en' ? 'Reasoning effort: medium (explicit' : 'Muhakeme eforu: medium (açık istek');
    }
  });

  it('applies class defaults to prepared native profiles too; explicit and unsupported defaults remain visible', async () => {
    const workClasses = { schemaVersion: 1, revision: 'custom', classes: [{ id: 'custom', defaultEffort: 'max' }], bindings: [{ kind: 'hand', classId: 'custom' }] };
    const f = await seeded({ ...registry, workClasses });
    const created = await createRun(f.project, run('prepared-default', 'hand', undefined, 2), f.options);
    expect(created.admission.run.tasks[0]!.reasoningEffort).toMatchObject({ level: 'max', source: 'policy-default', policyRevision: 'custom' });
    expect(f.snapshotProfile('prepared-default').tasks[0]!.profile.parameters.argv).toContain('--effort');
  });

  it('replays idempotently from the frozen snapshot after the model is deactivated; a changed work input under the same command conflicts', async () => {
    const f = await seeded();
    const created = await createRun(f.project, run('r', 'coding', workInput()), f.options);
    const frozen = f.snapshotProfile('r');
    await f.activation('claude-sonnet-5-5', 'deactivate', 1);
    expect(await createRun(f.project, run('r', 'coding', workInput()), f.options)).toEqual(created);
    expect(f.snapshotProfile('r')).toEqual(frozen);
    // POOL-CAPACITY: inspect adds the read-only pool observation; the admitted Run itself replays unchanged.
    const { pool, ...inspected } = (await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run;
    expect(inspected).toEqual(created.admission.run);
    expect(inspected.tasks[0]!.reasoningEffort).toMatchObject({ level: 'xhigh', source: 'policy-default' });
    expect(pool).toMatchObject({ poolId: 'p', drift: [], waiting: [] });
    const reserved = (await reserveRunTasks(f.project, { schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r', expectedRevision: 0 }, f.options)).reservation.identities;
    expect(reserved).toHaveLength(1);
    expect(f.snapshotAttempt(reserved[0]!.attemptId)).toMatchObject({ reasoningEffort: { level: 'xhigh', source: 'policy-default' } });
    await expect(createRun(f.project, run('r', 'coding', { ...workInput(), task: 'Something else.' }), f.options)).rejects.toMatchObject({ code: 'RUN_COMMAND_CONFLICT' });
    await expect(createRun(f.project, run('new', 'coding', workInput()), f.options)).rejects.toMatchObject({ code: 'WORKER_MODEL_NOT_ACTIVE' });
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] admits and refuses through the runtime service and the CLI `run create --graph` with the same contract', async () => {
    const f = await seeded(); const observer = { async onPage() {}, async onError() {} };
    const service = await startConfiguredRuntimeService(f.project, observer, f.options); const client = createConfiguredRuntimeClient(f.project, f.options);
    try {
      await expect(client.createRun(run('svc-alias', 'coding', workInput('opus')))).rejects.toMatchObject({ code: 'WORKER_MODEL_ALIAS_REFUSED' });
      await expect(client.createRun(run('svc-unpaired', 'coding', undefined, 2))).rejects.toMatchObject({ code: 'WORK_INPUT_REQUIRED' });
      expect(f.runs()).toBe(0);
      expect((await client.createRun(run('svc-ok', 'coding', workInput()))).admission.run.runId).toBe('svc-ok');
      expect(f.runs()).toBe(1);
    } finally { await service.stop(); await service.done; }
    expect(encodeExecutionProfileDefinition(f.snapshotProfile('svc-ok').tasks[0]!.profile)).toBe(encodeExecutionProfileDefinition(handPrepared('coding', 40, true)));
    const graphPath = join(f.project, 'card.json'); await writeFile(graphPath, JSON.stringify(graph('coding', workInput())));
    let out = '';
    await runCommand(['run', 'create', '--scope', 's', '--id', 'cli', '--command-id', 'create-cli', '--graph', graphPath, '--json'],
      { createRun, root: f.project, env: f.options.env, stdout: { write: (chunk: string) => { out += chunk; return true; } } } as never);
    expect(JSON.parse(out).admission.run.runId).toBe('cli');
    expect(f.snapshotProfile('cli')).toEqual(f.snapshotProfile('svc-ok'));
  });

  it('keeps templates visible to installation image checks and toolchain currency; a template never validates as an executable profile', () => {
    expect(nativeCodingTemplateBase(template('coding', claudeInvocation) as never).parameters['imageId']).toBe(docker.imageId);
    expect(() => nativeCodingTemplateBase({ ...template('coding', claudeInvocation), parameters: { schemaVersion: 1, docker: { ...docker, argv: ['x'] }, invocation: claudeInvocation } } as never))
      .toThrow(expect.objectContaining({ code: 'NATIVE_CODING_TEMPLATE_INVALID' }));
    expect(() => nativeCodingTemplateBase(template('coding', { ...claudeInvocation, prompt: 'task text' }) as never)).toThrow(expect.objectContaining({ code: 'NATIVE_CODING_TEMPLATE_INVALID' }));
    expect(admittedToolchains({ admission: { registry } }).map(pin => [pin.profile.id, pin.provider])).toEqual([['coding', 'claude'], ['codex-coding', 'codex'], ['hand', 'claude']]);
  });
});

describe.skipIf(process.platform === 'win32')('fixed-Ultra opt-in producer to surface', () => {
  it.each((['unmapped', 'design', 'explicit', 'registry'] as const).flatMap(choice => ['pending', 'evaluated'].map(stage => ({ choice, stage }))))('fixed Ultra $choice terminal $stage preserves exact model argv and one Run/Attempt/EN/TR selection', async ({ choice, stage }) => {
    const channelId = 'cursor-ultra-fixture', modelId = 'exact-ultra-fixture', kind = choice === 'design' ? 'design' : 'unmapped';
    const catalog = await seedCatalog(), provider = catalog.providers[0];
    catalog.providers.push({ ...provider, id: channelId, channel: { ...provider.channel, cli: 'cursor', client: 'cursor', protocolFamily: 'fixture', aliases: [], aliasesRefused: [] },
      models: [{ ...provider.models[0], id: modelId, nativeId: modelId, channelModelId: modelId, canonicalModelId: modelId, aliases: [],
        efforts: ['ultra'], reasoning: { supportedEfforts: ['ultra'], defaultEffort: 'ultra' }, effortBinding: { mode: 'fixed-model', level: 'ultra' },
        minCliVersion: null, minClientVersion: null, lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null },
        protocols: [{ family: 'fixture', version: 'v1', capabilities: [] }] }] });
    const local = { ...registry, profiles: [...profiles, template('cursor-ultra', { ...codexInvocation, provider: 'cursor' })],
      kinds: [...registry.kinds, { kind, profile: { id: 'cursor-ultra', version: 1 } }], ...(choice === 'registry' ? {
        workClasses: { schemaVersion: 1, revision: 'deliberate-ultra', classes: [{ id: 'deep', defaultEffort: 'ultra' }], bindings: [{ kind, classId: 'deep' }] },
      } : {}) };
    const f = await seeded(local, catalog);
    await f.activation(null, 'activate', 0, channelId); await f.activation(modelId, 'activate', 0, channelId);
    const input = { ...workInput(modelId, choice === 'explicit' ? { effort: 'ultra' } : {}, []), model: { channelId, modelId, auxiliaryModelIds: [] } };
    const request = run(`fixed-${choice}`, kind, input), created = await createRun(f.project, request, f.options);
    const boundary = choice === 'unmapped' || choice === 'design';
    const selected = boundary ? { schemaVersion: 1, level: null, source: 'cli-default', status: 'ultra-opt-in-required', ...(choice === 'design' ? {
      workClass: 'design', policyRevision: 'worker-effort-2026-10-03', target: 'max' } : {}) }
      : choice === 'explicit' ? { schemaVersion: 1, level: 'ultra', source: 'explicit', status: 'selected' }
        : { schemaVersion: 1, level: 'ultra', source: 'policy-default', status: 'selected', workClass: 'deep', policyRevision: 'deliberate-ultra', target: 'ultra' };
    const frozen = f.snapshotProfile(request.runId).tasks[0]!.profile;
    expect(frozen.parameters.argv).toEqual(['cursor-agent', '--print', '--output-format', 'stream-json', '--force', '--trust', '--model', modelId, '--', '__DECKENT_TASK_PROMPT__']);
    expect(frozen.parameters.nativeSubscription).toMatchObject({ reasoningEffort: selected, model: input.model });
    expect(created.admission.run.tasks[0]!.reasoningEffort).toEqual(selected);
    expect(() => assertNativeWorkerBinding(frozen as never)).not.toThrow();
    const reserved = (await reserveRunTasks(f.project, { schemaVersion: 1, commandId: `reserve-${choice}`, scopeId: 's', runId: request.runId, expectedRevision: 0 }, f.options)).reservation.identities;
    expect(reserved).toHaveLength(1);
    expect(f.snapshotAttempt(reserved[0]!.attemptId).reasoningEffort).toEqual(selected);
    const evaluate = await terminal(f, request.runId, reserved[0]!);
    const evaluated = stage === 'evaluated' ? await evaluate() : null;
    const snapshot = await inspectMonitor(f.project, f.options), worker = snapshot.installs[0]!.workers.find(value => value.identity?.attemptId === reserved[0]!.attemptId)!;
    expect(worker).toMatchObject({ terminal: { exitCode: 0 }, diagnostics: ['info:ledger-only'], model: { reasoningEffort: selected } });
    if (evaluated) {
      const { reasoningEffort, ...model } = worker.model!;
      expect(reasoningEffort).toEqual(selected); expect(model).toEqual({ ...evaluated, evidence: 'none' });
      expect(evaluated).not.toHaveProperty('reasoningEffort');
    } else expect(worker.model).toMatchObject({ verdict: 'pending', init: null, usage: null, evidence: 'none' });
    const inspected = await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: request.runId }, f.options);
    expect(inspected.run.tasks[0]!.reasoningEffort).toEqual(selected);
    expect(inspected.run.tasks[0]!.taskBrief).toMatchObject({ task: TASK, acceptance: ACCEPTANCE,
      scopePaths: PATHS, model: input.model, effort: choice === 'explicit' ? 'ultra' : null });
    expect(inspected.run.tasks[0]!.resultBrief).toMatchObject({ claimLabel: 'CLAIM', report: null, openIssues: null });
    expect(inspected.models[0]!.reasoningEffort).toEqual(selected);
    const surface = await loadMonitorSurface();
    for (const lang of ['en', 'tr'] as const) {
      let output = '';
      await runCommand(['run', 'inspect', '--scope', 's', '--id', request.runId, '--lang', lang],
        { inspectRun, root: f.project, env: f.options.env, stdout: { write(chunk: string) { output += chunk; return true; } } } as never);
      const view = surface.buildMonitorView(snapshot, lang, true);
      const detail = view.tabs.workers.filter(block => block.kind === 'table').flatMap(block => block.rows)
        .flatMap(row => row.detail().flat().map(cell => cell.text)).join(' ');
      const expected = boundary ? (lang === 'en' ? 'Ultra requires explicit effort or an Ultra registry target' : 'Ultra için açık efor isteği veya Ultra registry hedefi gerekir')
        : lang === 'en' ? `Reasoning effort: ultra (${choice === 'explicit' ? 'explicit' : 'policy default'}` : `Muhakeme eforu: ultra (${choice === 'explicit' ? 'açık istek' : 'politika varsayılanı'}`;
      expect(output).toContain(expected); expect(detail).toContain(expected);
      expect(output).toContain(lang === 'en' ? `Task text: ${TASK}` : `İş metni: ${TASK}`);
      expect(output).toContain(lang === 'en' ? 'Requested reasoning effort (application not proven):' : 'İstenen reasoning effort (uygulandığı kanıtlanmadı):');
    }
  });

});

// Frozen display metadata survives terminal custody and evaluation; output policy never supplies replacement model evidence.
describe.skipIf(process.platform === 'win32')('terminal monitor reasoning effort', () => {
  it.each(['default', 'explicit', 'unsupported'] as const)('%s survives the real pending/evaluated EN/TR human detail', async choice => {
    const f = await seeded(), runId = `terminal-${choice}`;
    const input = workInput(choice === 'unsupported' ? HAIKU : 'claude-sonnet-5-5', choice === 'explicit' ? { effort: 'medium' } : {}, []);
    const created = await createRun(f.project, run(runId, 'coding', input), f.options), selected = created.admission.run.tasks[0]!.reasoningEffort;
    expect(selected).toMatchObject(choice === 'unsupported' ? { level: null, source: 'cli-default', status: 'unsupported' }
      : { level: choice === 'explicit' ? 'medium' : 'xhigh', source: choice === 'explicit' ? 'explicit' : 'policy-default', status: 'selected' });
    const reserved = await reserveRunTasks(f.project, { schemaVersion: 1, commandId: `reserve-${runId}`, scopeId: 's', runId, expectedRevision: 0 }, f.options);
    const identity = reserved.reservation.identities[0]!, evaluate = await terminal(f, runId, identity), surface = await loadMonitorSurface();
    for (const stage of ['pending', 'evaluated']) {
      const evaluated = stage === 'evaluated' ? await evaluate() : null;
      const snapshot = await inspectMonitor(f.project, f.options), worker = snapshot.installs[0]!.workers.find(value => value.identity?.attemptId === identity.attemptId)!;
      expect(worker.model!.reasoningEffort).toEqual(selected);
      expect(worker.human!.taskBrief!.effort).toBe(choice === 'explicit' ? 'medium' : null);
      expect(worker.human!.transcript.state).toBe('denied'); expect(worker.model!.usage).toBeNull();
      if (evaluated) { const { reasoningEffort, ...model } = worker.model!; void reasoningEffort; expect(model).toEqual({ ...evaluated, evidence: 'none' }); }
      else expect(worker.model!.verdict).toBe('pending');
      for (const lang of ['en', 'tr'] as const) {
        const detail = surface.buildMonitorView(snapshot, lang, true).tabs.workers.filter(block => block.kind === 'table').flatMap(block => block.rows)
          .flatMap(row => row.detail().flat().map(cell => cell.text)).join(' ');
        const level = selected!.level ?? (lang === 'en' ? 'unsupported' : 'desteklenmiyor');
        expect(detail).toContain(`${lang === 'en' ? 'Reasoning effort:' : 'Muhakeme eforu:'} ${level}`);
        expect(detail).toContain(lang === 'en' ? (choice === 'explicit' ? 'explicit' : choice === 'default' ? 'policy default' : 'CLI default')
          : choice === 'explicit' ? 'açık istek' : choice === 'default' ? 'politika varsayılanı' : 'CLI varsayılanı');
      }
    }
  });

  it('a legacy frozen native pin without effort stays absent before/after evaluation and in EN/TR human detail', async () => {
    const f = await seeded(); await createRun(f.project, run('seed-definition', 'hand', undefined, 2), f.options);
    const opened = await openConfiguredAttemptStore(f.project, f.options); opened.store.close();
    const identity = { scopeId: 's', runId: 'legacy', taskId: 't', attemptId: 'legacy-t', layoutRevision: opened.layout.revision, generation: 1 };
    const execution = f.snapshotProfile('seed-definition');
    // Historical native pins predate this optional metadata; retain the valid no-effort command and omit only that field.
    const prepared = handPrepared('hand'), subscription = prepared.parameters['nativeSubscription'] as Record<string, unknown>;
    const { reasoningEffort, ...legacySubscription } = subscription; void reasoningEffort;
    const profile = { ...prepared, parameters: { ...prepared.parameters, nativeSubscription: legacySubscription } };
    expect(readWorkerModelPin(profile.parameters)).not.toHaveProperty('reasoningEffort');
    const store = await openSqliteAttemptStore(f.path, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
    try {
      await store.createRun({ commandId: 'create-legacy', actor: { id: 'fixture', issuer: 'test', subject: 'service' }, identity: { scopeId: 's', runId: 'legacy', layoutRevision: opened.layout.revision },
        graph: graph('hand', undefined, 2), execution: { ...execution, tasks: [{ taskId: 't', profile }] }, now: 0,
        policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } });
      await store.reserveRunTasks({ commandId: 'reserve-legacy', actor: { id: 'fixture', issuer: 'test', subject: 'service' }, scopeId: 's', runId: 'legacy', expectedRevision: 0, now: 1, identities: [identity] });
    } finally { store.close(); }
    const evaluate = await terminal(f, 'legacy', identity), surface = await loadMonitorSurface();
    for (const stage of ['pending', 'evaluated']) {
      if (stage === 'evaluated') await evaluate();
      const snapshot = await inspectMonitor(f.project, f.options), worker = snapshot.installs[0]!.workers.find(value => value.identity?.attemptId === identity.attemptId)!;
      expect(worker.model).not.toHaveProperty('reasoningEffort');
      expect(worker.model!.requested.modelId).toBe('claude-sonnet-5-5');
      for (const lang of ['en', 'tr'] as const) {
        const detail = surface.buildMonitorView(snapshot, lang, true).tabs.workers.filter(block => block.kind === 'table').flatMap(block => block.rows)
          .flatMap(row => row.detail().flat().map(cell => cell.text)).join(' ');
        expect(detail).not.toContain(lang === 'en' ? 'Reasoning effort:' : 'Muhakeme eforu:');
      }
    }
  });
});
