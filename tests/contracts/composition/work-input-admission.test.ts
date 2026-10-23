import { expectEmptyCostObservation } from '../support/run-cost-observation.js';
import { runRefusalEvidence, expectOnlyUnappliedRunDecisions } from '../support/run-refusal-evidence.js';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { applyModelCatalog, createConfiguredRuntimeClient, createRun, inspectRun, reserveRunTasks, startConfiguredRuntimeService } from '../../../src/index.js';
import { inspectMonitor } from '#composition/index.js';
import { runCommand } from '../../../src/surfaces/core/cli/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { changeConfiguredWorkerInstructionTrust, classifyConfiguredRunSpending, inspectConfiguredWorkerInstructions } from '../../../src/composition/core/runs/index.js';
import { admittedToolchains } from '../../../src/engine/core/toolchain-currency/index.js';
import { assertNativeWorkerBinding, compileNativeCodingDockerProfile, FileArtifactStore, gitRefFileSource, nativeCodingTemplateBase, openHostProjectInstructionReader, openSqliteAttemptStore } from '#adapters/index.js';
import { encodeExecutionProfileDefinition, readWorkerModelPin, validateTaskGraph, TASK_GRAPH_SCHEMA_VERSION, type AttemptIdentity } from '#domain/index.js';
import { clearConfigCache, prepareProductDirectory } from '#platform/index.js';
import { seedCatalog, SEED_CHANNEL } from '../support/model-catalog.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

/** K3 = A (owner 2026-09-30): task graph v3 typed work input + reusable coding template compiled once at Run admission. */
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const HAIKU = 'claude-haiku-5-5'; // haiku-4-5 retired 2026-10-15 in the seed: fixtures use a current model (CLI >= 2.1.293)
const docker = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
  deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const parts = { persona: { id: 'implementer', version: 1, text: 'You implement exactly one card.' }, context: [{ id: 'repo-tooling', version: 2, text: 'Use npm scripts.' }] };
const claudeInvocation = { provider: 'claude', cliVersion: '2.1.293 (Claude Code)', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended',
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

async function seeded(localRegistry: object = registry, suppliedCatalog?: object, extraConfig: object = {}, home?: string) {
  const project = await mkdtemp(join(tmpdir(), 'dn-work-input-')); roots.push(project); const data = join(project, 'd');
  await mkdir(join(project, '.deckent'), { recursive: true }); const options = { env: { HOME: home ?? join(project, 'h') } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1,
    ordering: 'input-order', registry: localRegistry }, cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
  cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 }, service: { inputMaxBytes: 65536, responseMaxBytes: 65536,
    maxConnections: 4, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 }, ...extraConfig }));
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
  // The fixture's HAIKU plays the "no reasoning-effort knob" model (the retired haiku-4-5 had none): the seed copy lists no efforts for it.
  const effortless = async () => { const seed = await seedCatalog(); for (const model of seed.providers[0].models) if (model.nativeId === HAIKU) { model.efforts = []; model.reasoning.supportedEfforts = []; } return seed; };
  await catalog({ action: 'register', catalog: suppliedCatalog ?? await effortless() });
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
      // Durable metrics carry the primary identity; the canonical native pin retains its auxiliary models.
      const db = new DatabaseSync(f.path, { readOnly: true });
      try {
        const row = db.prepare('SELECT record FROM acceptance_metrics WHERE scope_id=? AND producer_command_id=?').get('s', `evaluate-${runId}`);
        expect(JSON.parse(String(row?.record)).metric.model).toEqual({ channelId: pin.pin.channelId, modelId: pin.pin.modelId });
        expect(readWorkerModelPin((await writer.loadRun('s', runId))!.execution.tasks[0]!.profile.parameters)!.pin).toEqual(pin.pin);
      } finally { db.close(); }
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

  it('refuses alias, unknown, inactive, unsupported effort, turn limit and unpaired inputs with typed codes before any Run effect', async () => {
    const f = await seeded();
    const before = runRefusalEvidence(f.path);
    const refused = [
      ['cli-alias', workInput('sonnet'), 'coding', 'WORKER_MODEL_ALIAS_REFUSED'],
      ['catalog-alias', workInput('claude-haiku-4-5', {}, []), 'coding', 'WORKER_MODEL_ALIAS_REFUSED'],
      ['helper-alias', workInput('claude-sonnet-5-5', {}, ['haiku']), 'coding', 'WORKER_MODEL_ALIAS_REFUSED'],
      ['unknown', workInput('claude-sonnet-9-9'), 'coding', 'WORKER_MODEL_UNKNOWN'],
      ['inactive', workInput('claude-opus-5-5', {}, []), 'coding', 'WORKER_MODEL_NOT_ACTIVE'],
      ['effort', workInput(HAIKU, { effort: 'high' }, []), 'coding', 'WORKER_EFFORT_UNSUPPORTED'],
      ['explicit-unknown-class', workInput('claude-sonnet-5-5', { effort: 'high', workClass: 'unknown' }), 'coding', 'WORK_CLASS_NOT_REGISTERED'],
      ['codex-turns', workInput('gpt-exact-1', { maxTurns: 5 }, []), 'codex-coding', 'WORK_INPUT_TURN_LIMIT_UNSUPPORTED'],
      ['turns-exceed', workInput('claude-sonnet-5-5', { maxTurns: 41 }), 'coding', 'WORK_INPUT_TURN_LIMIT_EXCEEDS_TEMPLATE'],
      ['on-prepared', workInput(), 'hand', 'WORK_INPUT_TEMPLATE_REQUIRED'],
    ] as const;
    for (const [label, input, kind, code] of refused) {
      await expect(createRun(f.project, run(label, kind, input), f.options), label).rejects.toMatchObject({ code });
    }
    await expect(createRun(f.project, run('no-input', 'coding', undefined, 2), f.options)).rejects.toMatchObject({ code: 'WORK_INPUT_REQUIRED' });
    await expect(createRun(f.project, run('no-input-v3', 'coding'), f.options)).rejects.toMatchObject({ code: 'WORK_INPUT_REQUIRED' });
    expect(f.runs()).toBe(0); expectOnlyUnappliedRunDecisions(f.path, before,
      [...refused.map(([label, input, kind]) => run(label, kind, input)), run('no-input', 'coding', undefined, 2), run('no-input-v3', 'coding')]);
    // WORKER-EFFORT: a declared effort reaches the frozen command, before any worker starts.
    const created = await createRun(f.project, run('effort-ok', 'coding', workInput('claude-sonnet-5-5', { effort: 'high' })), f.options);
    expect(created.admission.run.runId).toBe('effort-ok');
    expect(f.snapshotProfile('effort-ok').tasks[0]!.profile.parameters.argv).toContain('--effort');
    expect(f.snapshotProfile('effort-ok').tasks[0]!.profile.parameters.nativeSubscription).toMatchObject({ reasoningEffort: { level: 'high', source: 'explicit', status: 'selected' } });
  });

  it('a proposal\'s spending classification refuses an unsupported turn limit typed, as creation does (live /do 2026-10-16 QUERY_UNEXPECTED_FAILURE)', async () => {
    const f = await seeded();
    const proposal = { graph: graph('codex-coding', workInput('gpt-exact-1', { maxTurns: 5 }, []), 3) } as unknown as Parameters<typeof classifyConfiguredRunSpending>[1];
    await expect(classifyConfiguredRunSpending(f.project, proposal, f.options)).rejects.toMatchObject({ code: 'WORK_INPUT_TURN_LIMIT_UNSUPPORTED' });
  });

  it.each(['codex', 'cursor'] as const)('admits %s through the real catalog with exact argv and refuses undeclared effort before Run effects', async provider => {
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
    const before = runRefusalEvidence(f.path);
    await expect(createRun(f.project, run('refused', 'feature', { ...input, effort: 'max' }), f.options)).rejects.toMatchObject({ code: 'WORKER_EFFORT_UNSUPPORTED' });
    expectOnlyUnappliedRunDecisions(f.path, before, [run('refused', 'feature', { ...input, effort: 'max' })]); expect(f.runs()).toBe(1);
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
    expect(expectEmptyCostObservation(inspected)).toEqual(created.admission.run);
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
    expect(worker).toMatchObject({ terminal: { exitCode: 0 }, diagnostics: ['info:ledger-only', 'output-denied'], model: { reasoningEffort: selected } });
    if (evaluated) {
      const { reasoningEffort, ...model } = worker.model!;
      expect(reasoningEffort).toEqual(selected); expect(model).toEqual({ ...evaluated, evidence: 'none' });
      expect(evaluated).not.toHaveProperty('reasoningEffort');
    } else expect(worker.model).toMatchObject({ verdict: 'pending', init: null, usage: null, evidence: 'none' });
    const inspected = await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: request.runId }, f.options);
    expect(inspected.run.tasks[0]!.reasoningEffort).toEqual(selected);
    expect(inspected.run.tasks[0]!.taskBrief).toMatchObject({ task: TASK, acceptance: ACCEPTANCE,
      scopePaths: PATHS, model: input.model, effort: choice === 'explicit' ? 'ultra' : null });
    // No read-output grant: the whole result brief is withheld, not only its report (alpha.30 security narrowing).
    expect(inspected.run.tasks[0]).not.toHaveProperty('resultBrief');
    expectEmptyCostObservation(inspected.run, 1);
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

describe.skipIf(process.platform === 'win32')('R3 silence policy through the real admission composition', () => {
  it('R3: admission freezes the silence policy for a native worker only when it stops before the profile deadline', async () => {
    const short = await seeded(registry, undefined, { runRuntime: { stallRecovery: { schemaVersion: 1, warnAfterMs: 1000, stopAfterMs: 5000, maxRetries: 2 } } });
    await createRun(short.project, run('watched', 'coding', workInput()), short.options);
    expect((short.snapshotProfile('watched').tasks[0] as { stall?: unknown }).stall).toEqual({ warnAfterMs: 1000, stopAfterMs: 5000, maxRetries: 2 });
    // The installation default (stop 3600000) cannot stop before this profile's 20000 ms deadline: it is not frozen, the deadline alone bounds the task.
    const f = await seeded();
    await createRun(f.project, run('deadline-only', 'coding', workInput()), f.options);
    expect((f.snapshotProfile('deadline-only').tasks[0] as { stall?: unknown }).stall).toBeUndefined();
  });
});

/** DECKENT-MD-WORKERS (owner Q3 2026-10-23): the project's worker instruction snapshot enters the compiled prompt at admission. */
describe.skipIf(process.platform === 'win32')('worker instruction snapshot through the real admission composition', () => {
  const execution = (workerInstructions?: object) => ({ execution: { docker: { executable: '/usr/bin/docker', imageId: docker.imageId },
    git: { gitExecutable: '/usr/bin/git' }, ...(workerInstructions ? { workerInstructions } : {}) } });
  const contextIds = (f: Awaited<ReturnType<typeof seeded>>, runId: string) => ((f.snapshotProfile(runId).tasks[0]!.profile.parameters['nativeSubscription'] as
    { promptDelivery: { segments: { kind: string; id: string }[] } }).promptDelivery.segments).filter(s => s.kind === 'context').map(s => s.id);
  const promptTask = (f: Awaited<ReturnType<typeof seeded>>, runId: string) => (f.snapshotProfile(runId).tasks[0]!.profile.parameters['nativeSubscription'] as { promptDelivery: { task: string } }).promptDelivery.task;
  // Persisted consent lives in the owner-private user state directory outside the project, as on a real host (inside it the reader refuses it).
  const home = async () => { const path = await mkdtemp(join(tmpdir(), 'dn-worker-home-')); roots.push(path); await chmod(path, 0o700); return path; };
  const trust = async (f: Awaited<ReturnType<typeof seeded>>, file?: string) => {
    const reader = await openHostProjectInstructionReader(f.project, f.options.env, undefined, [file ?? '.deckent/worker-instructions.md']), view = await reader.inspect();
    if (view.status !== 'trust-required') throw new Error(view.status);
    await reader.trust(view.source.digest); return view.source.digest;
  };
  const reconfigure = async (f: Awaited<ReturnType<typeof seeded>>, workerInstructions: object) => {
    const path = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...config, execution: { ...config.execution, workerInstructions } })); clearConfigCache();
  };

  it('includes only a trusted, digest-bound snapshot; replays stay exact; a changed file is left out with a visible reason', async () => {
    const f = await seeded(registry, undefined, execution(), await home());
    expect((await createRun(f.project, run('absent', 'coding', workInput()), f.options)).warnings).toEqual([]); // default, no worker file: silent no-op
    expect(contextIds(f, 'absent')).toEqual(['repo-tooling']);
    await writeFile(join(f.project, '.deckent/worker-instructions.md'), 'Run npm test before reporting.');
    const untrusted = await createRun(f.project, run('untrusted', 'coding', workInput()), f.options);
    expect(untrusted.warnings).toEqual([expect.objectContaining({ code: 'WORKER_INSTRUCTIONS_WITHHELD', source: 'worker-md', reason: 'untrusted', digest: expect.stringMatching(/^[a-f0-9]{64}$/u) })]);
    expect(contextIds(f, 'untrusted')).toEqual(['repo-tooling']);
    const digest = await trust(f);
    expect((await createRun(f.project, run('trusted', 'coding', workInput()), f.options)).warnings).toEqual([]);
    expect(contextIds(f, 'trusted')).toEqual(['repo-tooling', `worker-md-${digest.slice(0, 16)}`]);
    expect(promptTask(f, 'trusted')).toContain(`sha256 ${digest}`); expect(promptTask(f, 'trusted')).toContain('Run npm test before reporting.');
    const frozen = JSON.stringify(f.snapshotProfile('trusted'));
    await writeFile(join(f.project, '.deckent/worker-instructions.md'), 'Changed after admission.');
    const replay = await createRun(f.project, run('trusted', 'coding', workInput()), f.options); // same command: answered from the receipt
    expect(replay.admission.run.runId).toBe('trusted'); expect(replay.warnings).toEqual([]); expect(JSON.stringify(f.snapshotProfile('trusted'))).toBe(frozen);
    const changed = await createRun(f.project, run('changed', 'coding', workInput()), f.options);
    expect(changed.warnings).toEqual([expect.objectContaining({ reason: 'untrusted' })]); expect(promptTask(f, 'changed')).not.toContain('Changed after admission.');
    // A Run without a compiled worker prompt says nothing about instructions.
    expect((await createRun(f.project, run('prepared', 'hand', undefined, 2), f.options)).warnings).toEqual([]);
    // The human `run create` line names the reason in both languages.
    const graphPath = join(f.project, 'card.json'); await writeFile(graphPath, JSON.stringify(graph('coding', workInput())));
    for (const [lang, text] of [['en', 'not trusted on this host'], ['tr', 'güvenilir olarak işaretlenmedi']] as const) {
      let out = '';
      await runCommand(['run', 'create', '--scope', 's', '--id', `cli-${lang}`, '--command-id', `create-cli-${lang}`, '--graph', graphPath, '--lang', lang],
        { createRun, root: f.project, env: f.options.env, stdout: { write: (chunk: string) => { out += chunk; return true; } } } as never);
      expect(out).toContain(text); expect(out).toContain('worker-md');
    }
  });

  /** alpha.53 F1: the CLI trust path grants what admission consumes — same folder, same digest, a sealed decision first, never for an AI or MCP caller. */
  it('the governed trust path makes admission include the snapshot; refusals, a changed digest and revoke leave workers without it', async () => {
    const f = await seeded(registry, undefined, execution(), await home()), file = join(f.project, '.deckent/worker-instructions.md');
    const witness = { attest: async () => true }, status = async () => (await inspectConfiguredWorkerInstructions(f.project, f.options)).targets[0]!;
    type Binding = Parameters<typeof changeConfiguredWorkerInstructionTrust>[1]['binding'];
    const change = (action: 'trust' | 'revoke', binding: Binding, attest = witness) => changeConfiguredWorkerInstructionTrust(f.project, { scopeId: 's', action, binding }, f.options, attest);
    const decisions = () => { const db = new DatabaseSync(f.path, { readOnly: true }); try {
      return (db.prepare("SELECT record FROM audit_events WHERE kind = 'authority-decision' ORDER BY sequence").all() as { record: string }[])
        .map(row => (JSON.parse(row.record) as { event: { subject: { action: string; resource: object; basisDigest: string; verdict: { decision: string } } } }).event.subject)
        .filter(subject => subject.action.startsWith('worker-instructions-')); } finally { db.close(); } };
    expect(await status()).toMatchObject({ target: null, source: 'worker-md', state: 'absent', off: null });
    const forged = { target: null, root: f.project, rootDev: 0, rootIno: 0, source: 'worker-md', file: '.deckent/worker-instructions.md', ref: null, path: file, commit: null, blobOid: null,
      fileDev: 0, fileIno: 0, digest: 'ab'.repeat(32) };
    await expect(change('trust', forged)).rejects.toMatchObject({ code: 'WORKER_INSTRUCTIONS_UNAVAILABLE', params: { reason: 'absent' } });
    await writeFile(file, 'Run npm test before reporting.\nKeep changes small.');
    const shown = await status();
    expect(shown).toMatchObject({ state: 'untrusted', bytes: 50, preview: ['Run npm test before reporting.', 'Keep changes small.'] });
    const digest = shown.digest!, card = shown.binding!;
    // No terminal witness (an AI tool's shell, MCP, a peer): refused before anything is read or sealed.
    await expect(change('trust', card, { attest: async () => false })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    // The person lacks `config`/`write` on execution.workerInstructions: the refusal is sealed, nothing is trusted.
    await expect(change('trust', card)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(decisions()).toEqual([expect.objectContaining({ action: 'worker-instructions-trust', basisDigest: digest, verdict: expect.objectContaining({ decision: 'deny' }),
      resource: { kind: 'config', id: 'project:execution.workerInstructions' } })]);
    expect((await status()).state).toBe('untrusted');
    const policy = join(f.project, 'd', 'policy.json'), document = JSON.parse(await readFile(policy, 'utf8'));
    await writeFile(policy, JSON.stringify({ ...document, grants: [...document.grants, { id: 'config', effect: 'allow', actions: ['write'], scopes: ['s'],
      principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'config', ids: 'all' } }] }), { mode: 0o600 });
    await expect(change('trust', { ...card, digest: 'cd'.repeat(32) })).rejects.toMatchObject({ code: 'WORKER_INSTRUCTIONS_CHANGED' }); // not the content the card showed
    // A card for another work target than the one workers use here is not this place (REVISE 2734 R1; the CLI refuses an unknown --target itself).
    await expect(change('trust', { ...card, target: 'n1' })).rejects.toMatchObject({ code: 'WORKER_INSTRUCTIONS_CHANGED', params: { reason: 'place' } });
    const granted = await change('trust', card);
    expect(granted).toMatchObject({ action: 'trust', target: null, digest, trusted: true, changed: true, decisionEventId: expect.stringMatching(/^decision:/u) });
    expect(decisions().at(-1)).toMatchObject({ action: 'worker-instructions-trust', verdict: { decision: 'allow' } });
    expect((await status()).state).toBe('trusted');
    expect(await change('trust', card)).toMatchObject({ changed: false, decisionEventId: null }); // nothing to change, nothing sealed
    expect(decisions()).toHaveLength(2);
    // Admission (C3) now includes exactly that snapshot.
    expect((await createRun(f.project, run('after-trust', 'coding', workInput()), f.options)).warnings).toEqual([]);
    expect(contextIds(f, 'after-trust')).toEqual(['repo-tooling', `worker-md-${digest.slice(0, 16)}`]);
    // A changed file is untrusted again (digest-bound); the original content is still the trusted one.
    await writeFile(file, 'Changed instructions.');
    expect((await status()).state).toBe('untrusted');
    expect((await createRun(f.project, run('changed-file', 'coding', workInput()), f.options)).warnings).toEqual([expect.objectContaining({ reason: 'untrusted' })]);
    await writeFile(file, 'Run npm test before reporting.\nKeep changes small.');
    expect((await status()).state).toBe('trusted');
    expect(await change('revoke', card)).toMatchObject({ action: 'revoke', trusted: false, changed: true });
    expect(decisions().at(-1)).toMatchObject({ action: 'worker-instructions-revoke', verdict: { decision: 'allow' } });
    expect((await status()).state).toBe('untrusted');
    expect((await createRun(f.project, run('after-revoke', 'coding', workInput()), f.options)).warnings).toEqual([expect.objectContaining({ reason: 'untrusted', digest })]);
    expect(contextIds(f, 'after-revoke')).toEqual(['repo-tooling']);
    // Off for this project: status says so and there is nothing to trust.
    await reconfigure(f, { schemaVersion: 1, source: 'none' });
    expect(await status()).toMatchObject({ state: 'off', off: 'source-none', file: null, digest: null });
    await expect(change('trust', card)).rejects.toMatchObject({ code: 'WORKER_INSTRUCTIONS_UNAVAILABLE', params: { reason: 'source-none' } });
  });

  it('honours the per-project source (agents-md, none, explicit absent), is a no-op without Git execution and refuses an overflow at planning and creation', async () => {
    const plain = await seeded(registry, undefined, {}, await home()); // no `execution`: non-Git installation, explicit no-op even with a trusted file
    await writeFile(join(plain.project, '.deckent/worker-instructions.md'), 'Conventions.'); await trust(plain);
    expect((await createRun(plain.project, run('no-git', 'coding', workInput()), plain.options)).warnings).toEqual([]);
    expect(contextIds(plain, 'no-git')).toEqual(['repo-tooling']);
    const f = await seeded(registry, undefined, execution({ schemaVersion: 1, source: 'agents-md' }), await home());
    await writeFile(join(f.project, '.deckent/worker-instructions.md'), 'deckent text'); await writeFile(join(f.project, 'AGENTS.md'), 'agents text'); await trust(f, 'AGENTS.md');
    await createRun(f.project, run('agents', 'coding', workInput()), f.options);
    expect(promptTask(f, 'agents')).toContain('agents text'); expect(promptTask(f, 'agents')).not.toContain('deckent text');
    await reconfigure(f, { schemaVersion: 1, source: 'none' });
    expect((await createRun(f.project, run('none', 'coding', workInput()), f.options)).warnings).toEqual([]); expect(contextIds(f, 'none')).toEqual(['repo-tooling']);
    await reconfigure(f, { schemaVersion: 1, source: 'worker-md' }); await rm(join(f.project, '.deckent/worker-instructions.md'));
    expect((await createRun(f.project, run('explicit-absent', 'coding', workInput()), f.options)).warnings).toEqual([{ code: 'WORKER_INSTRUCTIONS_WITHHELD', source: 'worker-md', reason: 'absent', digest: null }]);
    const before = f.runs();
    await writeFile(join(f.project, '.deckent/worker-instructions.md'), 'x'.repeat(17_000)); await trust(f);
    await expect(createRun(f.project, run('overflow', 'coding', workInput()), f.options)).rejects.toMatchObject({ code: 'WORKER_INSTRUCTIONS_TOO_LARGE' });
    await expect(classifyConfiguredRunSpending(f.project, { graph: graph('coding', workInput()) } as never, f.options)).rejects.toMatchObject({ code: 'WORKER_INSTRUCTIONS_TOO_LARGE' });
    await writeFile(join(f.project, '.deckent/worker-instructions.md'), 'x'.repeat(40_000)); // above the reader bound: the same refusal, never a silent omission
    await expect(createRun(f.project, run('oversize', 'coding', workInput()), f.options)).rejects.toMatchObject({ code: 'WORKER_INSTRUCTIONS_TOO_LARGE' });
    expect(f.runs()).toBe(before);
  });
});

/** REVISE 2734 R1: the writer acts only on the exact place the card showed (canonical root + identity, source, file, digest);
 * any other place is a typed refusal before a decision is sealed or a trust record changes. alpha.54 R1 (owner Q5): with a work target the
 * file is the one committed on its base ref (`<ref>:<file>`; commit shown and sealed, not compared); the working tree is never read. */
describe.skipIf(process.platform === 'win32')('R1: the trust card binds the exact folder and file it showed', () => {
  const execution = () => ({ execution: { docker: { executable: '/usr/bin/docker', imageId: docker.imageId }, git: { gitExecutable: '/usr/bin/git' } } });
  const home = async () => { const path = await mkdtemp(join(tmpdir(), 'dn-worker-home-')); roots.push(path); await chmod(path, 0o700); return path; };
  const name = '.deckent/worker-instructions.md', TEXT = 'Run npm test before reporting.', REF = 'refs/heads/main', exec = promisify(execFile);
  const git = async (root: string, ...args: string[]) => (await exec('/usr/bin/git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args])).stdout.trim();
  const commit = async (root: string) => { await git(root, 'add', '-A'); await git(root, 'commit', '-q', '--allow-empty', '-m', 'next'); return git(root, 'rev-parse', REF); };
  async function bound() {
    const f = await seeded(registry, undefined, execution(), await home());
    const policy = join(f.project, 'd', 'policy.json'), document = JSON.parse(await readFile(policy, 'utf8'));
    await writeFile(policy, JSON.stringify({ ...document, grants: [...document.grants, { id: 'config', effect: 'allow', actions: ['write'], scopes: ['s'],
      principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'config', ids: 'all' } }] }), { mode: 0o600 });
    // A work target is a Git repository with the file committed on its base ref.
    const folder = async (label: string) => { const root = join(f.project, label); await mkdir(join(root, '.deckent'), { recursive: true }); await writeFile(join(root, name), TEXT);
      await git(root, 'init', '-q', '-b', 'main'); await commit(root); return root; };
    const setTarget = async (path: string | null, workerInstructions?: object, baseRef = REF) => {
      const configPath = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
      const { workTargets: _targets, workerInstructions: _instructions, ...rest } = config.execution; void _targets; void _instructions;
      await writeFile(configPath, JSON.stringify({ ...config, execution: { ...rest, ...(workerInstructions ? { workerInstructions } : {}),
        ...(path === null ? {} : { workTargets: { schemaVersion: 1, targets: [{ id: 'n1', kind: 'git', path, baseRef }] } }) } })); clearConfigCache();
    };
    const status = async () => (await inspectConfiguredWorkerInstructions(f.project, f.options)).targets[0]!;
    // What the CLI sends from the card it showed: the row's host-made binding.
    const change = (action: 'trust' | 'revoke', row: Awaited<ReturnType<typeof status>>) => changeConfiguredWorkerInstructionTrust(f.project,
      { scopeId: 's', action, binding: row.binding! }, f.options, { attest: async () => true });
    // What a fresh process sees at that folder: the file at `ref` (null: the working tree without a target). REVISE 2738 R1: a trust given at a
    // ref is keyed by folder, ref and content, so the working tree and another ref of the same folder do not see it.
    const stateAt = async (root: string, file = name, ref: string | null = REF) => (await (await openHostProjectInstructionReader(root, f.options.env, undefined, [file],
      ref === null ? undefined : gitRefFileSource({ gitExecutable: '/usr/bin/git', timeoutMs: 10_000, outputBytes: 65_536 }, root, ref, () => git(root, 'rev-parse', '--verify', `${ref}^{commit}`)))).inspect()).status;
    const sealed = () => { const db = new DatabaseSync(f.path, { readOnly: true }); try {
      return (db.prepare("SELECT record FROM audit_events WHERE kind = 'authority-decision'").all() as { record: string }[]).filter(row => row.record.includes('worker-instructions-')).length;
    } finally { db.close(); } };
    return { f, folder, setTarget, status, change, stateAt, sealed, A: await folder('a'), B: await folder('b') };
  }
  const refused = { code: 'WORKER_INSTRUCTIONS_CHANGED', params: { reason: 'place' } };

  it('same target id, path moved to a folder with byte-identical content: the moved-to folder is not trusted', async () => {
    const { setTarget, status, change, stateAt, sealed, A, B } = await bound();
    await setTarget(A); const card = await status();
    await setTarget(B); expect((await status()).digest).toBe(card.digest);
    await expect(change('trust', card)).rejects.toMatchObject(refused);
    expect([await stateAt(A), await stateAt(B), sealed()]).toEqual(['trust-required', 'trust-required', 0]);
  });
  it('the card showed the project root (no work target); a target appearing before the write is refused', async () => {
    const { f, setTarget, status, change, stateAt, sealed, B } = await bound();
    await writeFile(join(f.project, name), TEXT); const card = await status(); expect(card.target).toBeNull();
    await setTarget(B);
    await expect(change('trust', card)).rejects.toMatchObject(refused);
    expect([await stateAt(f.project, name, null), await stateAt(B), sealed()]).toEqual(['trust-required', 'trust-required', 0]);
  });
  it('the project switches the worker source to a byte-identical AGENTS.md: refused', async () => {
    const { setTarget, status, change, stateAt, sealed, A } = await bound();
    await writeFile(join(A, 'AGENTS.md'), TEXT); await commit(A); await setTarget(A); const card = await status();
    await setTarget(A, { schemaVersion: 1, source: 'agents-md' }); expect((await status()).digest).toBe(card.digest);
    await expect(change('trust', card)).rejects.toMatchObject(refused);
    expect([await stateAt(A, 'AGENTS.md'), sealed()]).toEqual(['trust-required', 0]);
  });
  it('without a work target the file is replaced by another file with identical bytes (new inode): refused', async () => {
    const { f, status, change, stateAt, sealed } = await bound();
    await writeFile(join(f.project, name), TEXT); const card = await status(); expect(card).toMatchObject({ target: null, ref: null, commit: null });
    await writeFile(join(f.project, '.deckent/replacement.md'), TEXT); await rename(join(f.project, '.deckent/replacement.md'), join(f.project, name));
    expect((await status()).digest).toBe(card.digest);
    await expect(change('trust', card)).rejects.toMatchObject(refused);
    expect([await stateAt(f.project, name, null), sealed()]).toEqual(['trust-required', 0]);
  });
  it('a dirty working-tree edit is never what workers get; the ref advancing with the same bytes keeps the card; other committed bytes are refused', async () => {
    const { setTarget, status, change, stateAt, sealed, A } = await bound();
    await setTarget(A); const card = await status(), first = await git(A, 'rev-parse', REF);
    await writeFile(join(A, name), 'Uncommitted edit.');
    expect(await status()).toMatchObject({ state: 'untrusted', digest: card.digest, commit: first, preview: [TEXT] });
    await writeFile(join(A, name), TEXT); await writeFile(join(A, 'other.txt'), 'unrelated'); const advanced = await commit(A);
    expect(await status()).toMatchObject({ digest: card.digest, commit: advanced });
    expect(await change('trust', card)).toMatchObject({ trusted: true, changed: true }); expect(sealed()).toBe(1);
    await writeFile(join(A, name), 'Other committed instructions.'); await commit(A);
    expect((await status()).state).toBe('untrusted');
    const error = await change('revoke', card).catch((caught: unknown) => caught as { code: string; params?: { reason?: string } });
    expect(error).toMatchObject({ code: 'WORKER_INSTRUCTIONS_CHANGED' }); expect(error.params?.reason).toBeUndefined(); // content, not place
    expect([await stateAt(A), sealed()]).toEqual(['trust-required', 1]);
  });
  it('admission snapshots the committed content and names ref@commit; an uncommitted edit never reaches the worker prompt', async () => {
    const { f, setTarget, status, change, A } = await bound();
    const policy = join(f.project, 'd', 'policy.json'), document = JSON.parse(await readFile(policy, 'utf8'));
    await writeFile(policy, JSON.stringify({ ...document, grants: [...document.grants, { id: 'target', effect: 'allow', actions: ['use'], scopes: ['s'],
      principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'work-target', ids: 'all' } }] }), { mode: 0o600 });
    await setTarget(A); const card = await status(); await change('trust', card);
    await writeFile(join(A, name), 'Uncommitted edit.');
    expect((await createRun(f.project, run('at-ref', 'coding', workInput()), f.options)).warnings).toEqual([]);
    const task = (f.snapshotProfile('at-ref').tasks[0]!.profile.parameters['nativeSubscription'] as { promptDelivery: { task: string } }).promptDelivery.task;
    expect(task).toContain(`Project instructions from ${REF}:${name} at commit ${card.commit} (sha256 ${card.digest})`);
    expect(task).toContain(TEXT); expect(task).not.toContain('Uncommitted edit.');
  });
  it('another base ref of the same target with byte-identical content is another place', async () => {
    const { setTarget, status, change, sealed, A } = await bound();
    await git(A, 'branch', 'other'); await setTarget(A); const card = await status();
    await setTarget(A, undefined, 'refs/heads/other'); expect(await status()).toMatchObject({ digest: card.digest, ref: 'refs/heads/other', path: `refs/heads/other:${name}` });
    await expect(change('trust', card)).rejects.toMatchObject(refused);
    expect(sealed()).toBe(0);
  });
  it('revoke has the same binding: a revoke card for folder A never removes the trust of folder B', async () => {
    const { setTarget, status, change, stateAt, sealed, A, B } = await bound();
    await setTarget(A);
    expect(await change('trust', await status())).toMatchObject({ trusted: true, changed: true }); expect(sealed()).toBe(1); // a fresh card is honoured
    const card = await status(); expect(card.state).toBe('trusted');
    await setTarget(B); expect(await change('trust', await status())).toMatchObject({ trusted: true, changed: true }); expect(sealed()).toBe(2);
    await expect(change('revoke', card)).rejects.toMatchObject(refused);
    expect([await stateAt(A), await stateAt(B), sealed()]).toEqual(['ready', 'ready', 2]);
  });
  it('REVISE 2738 R1 (owner Q5): after a trust at ref A, ref B of the same folder with identical bytes is untrusted and withheld; B needs its own card; revokes stay per ref', async () => {
    const { f, setTarget, status, change, stateAt, sealed, A } = await bound(), OTHER = 'refs/heads/other';
    const policy = join(f.project, 'd', 'policy.json'), document = JSON.parse(await readFile(policy, 'utf8'));
    await writeFile(policy, JSON.stringify({ ...document, grants: [...document.grants, { id: 'target', effect: 'allow', actions: ['use'], scopes: ['s'],
      principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'work-target', ids: 'all' } }] }), { mode: 0o600 });
    const contexts = (runId: string) => ((f.snapshotProfile(runId).tasks[0]!.profile.parameters['nativeSubscription'] as
      { promptDelivery: { segments: { kind: string; id: string }[] } }).promptDelivery.segments).filter(s => s.kind === 'context').map(s => s.id);
    await git(A, 'branch', 'other'); await setTarget(A); const cardA = await status();
    expect(await change('trust', cardA)).toMatchObject({ trusted: true, changed: true }); expect(sealed()).toBe(1);
    await setTarget(A, undefined, OTHER); const cardB = await status();
    expect(cardB).toMatchObject({ state: 'untrusted', ref: OTHER, digest: cardA.digest });
    expect((await createRun(f.project, run('other-ref', 'coding', workInput()), f.options)).warnings)
      .toEqual([expect.objectContaining({ code: 'WORKER_INSTRUCTIONS_WITHHELD', reason: 'untrusted', digest: cardA.digest })]);
    expect(contexts('other-ref')).toEqual(['repo-tooling']);
    expect(await stateAt(A, name, null)).toBe('trust-required'); // nor does the folder's working tree with the same bytes inherit it
    expect(await change('trust', cardB)).toMatchObject({ trusted: true, changed: true, decisionEventId: expect.stringMatching(/^decision:/u) }); expect(sealed()).toBe(2);
    expect((await createRun(f.project, run('other-ref-trusted', 'coding', workInput()), f.options)).warnings).toEqual([]);
    expect(contexts('other-ref-trusted')).toEqual(['repo-tooling', `worker-md-${cardB.digest!.slice(0, 16)}`]);
    await setTarget(A); expect(await change('revoke', await status())).toMatchObject({ trusted: false, changed: true });
    expect([await stateAt(A), await stateAt(A, name, OTHER)]).toEqual(['trust-required', 'ready']);
    await setTarget(A, undefined, OTHER); expect(await change('revoke', await status())).toMatchObject({ trusted: false, changed: true });
    expect([await stateAt(A), await stateAt(A, name, OTHER), sealed()]).toEqual(['trust-required', 'trust-required', 4]);
  });
  it('the card carries the host-made canonical place: target, real root and its identity, source, file, ref, path, commit and blob, digest', async () => {
    const { status, setTarget, A } = await bound();
    await setTarget(A); const card = await status();
    expect(card.binding).toEqual({ target: 'n1', root: A, rootDev: expect.any(Number), rootIno: expect.any(Number), source: 'worker-md', file: name,
      ref: REF, path: `${REF}:${name}`, commit: await git(A, 'rev-parse', REF), blobOid: await git(A, 'rev-parse', `${REF}:${name}`), fileDev: null, fileIno: null, digest: card.digest });
    expect(card).toMatchObject({ ref: REF, commit: card.binding!.commit, path: `${REF}:${name}` });
  });
});
