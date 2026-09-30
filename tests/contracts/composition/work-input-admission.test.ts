import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyModelCatalog, createConfiguredRuntimeClient, createRun, inspectRun, prepareNativeCodingProfile, reserveRunTasks, startConfiguredRuntimeService } from '../../../src/index.js';
import { runCommand } from '../../../src/surfaces/core/cli/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { admittedToolchains } from '../../../src/engine/core/toolchain-currency/index.js';
import { assertNativeWorkerBinding, nativeCodingTemplateBase } from '#adapters/index.js';
import { encodeExecutionProfileDefinition, validateTaskGraph, TASK_GRAPH_SCHEMA_VERSION } from '#domain/index.js';
import { clearConfigCache } from '#platform/index.js';
import { seedCatalog, SEED_CHANNEL } from '../support/model-catalog.js';

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
const handPrepared = (id: string, maxTurns = 40) => ({ ...prepareNativeCodingProfile({ schemaVersion: 1,
  template: { id: 'coding', version: 1, adapter: { id: 'docker', version: 2 }, parameters: { argv: ['unused'], ...docker } },
  invocation: { schemaVersion: 4, ...claudeInvocation, maxTurns, model: { channelId: SEED_CHANNEL, modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [HAIKU] },
    composition: { schemaVersion: 1, ...parts, task: TASK, scope: 'note.txt\nsrc/notes/**', acceptance: ACCEPTANCE } } }).profile, id });
const profiles = [template('coding', claudeInvocation), template('codex-coding', codexInvocation), handPrepared('hand')];
const registry = { schemaVersion: 1 as const, revision: 'k3', profiles, kinds: [{ kind: 'coding', profile: { id: 'coding', version: 1 } },
  { kind: 'codex-coding', profile: { id: 'codex-coding', version: 1 } }, { kind: 'hand', profile: { id: 'hand', version: 1 } }],
evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] };
const criteria = [{ id: 'exit', version: 1, description: 'Accept zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }];
const graph = (kind: string, input?: object, schemaVersion = 3) => ({ schemaVersion, revision: 1,
  tasks: [{ id: 't', kind, dependencies: [], acceptanceCriteria: ['exit'], ...(input ? { workInput: input } : {}) }], criterionDefinitions: criteria });
const run = (runId: string, kind: string, input?: object, schemaVersion = 3) => ({ schemaVersion: 1 as const, commandId: `create-${runId}`, scopeId: 's', runId,
  graph: graph(kind, input, schemaVersion) });

async function seeded() {
  const project = await mkdtemp(join(tmpdir(), 'dn-work-input-')); roots.push(project); const data = join(project, 'd');
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
    { id: 'catalog', effect: 'allow', actions: ['activate', 'deactivate'], scopes: 'all', principals, resource: { kind: 'model-activation', ids: 'all' } },
  ] }), { mode: 0o600 });
  let sequence = 0;
  const catalog = (command: Record<string, unknown>) => applyModelCatalog(project, { schemaVersion: 1, commandId: `catalog-${++sequence}`, scopeId: 's', ...command }, options);
  const activation = (modelId: string | null, action = 'activate', expectedRevision = 0) => catalog({ action, channelId: SEED_CHANNEL, modelId, expectedRevision });
  await catalog({ action: 'register', catalog: await seedCatalog() });
  // Opus stays inactive on purpose: a work input naming it is refused as not active.
  await activation(null); await activation('claude-sonnet-5-5'); await activation(HAIKU);
  const read = <T>(sql: string, ...args: string[]) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all(...args) as T[]; } finally { db.close(); } };
  const runs = () => read<{ n: number }>('SELECT count(*) AS n FROM runs')[0]!.n;
  const snapshotProfile = (runId: string) => (JSON.parse(read<{ snapshot: string }>('SELECT snapshot FROM runs WHERE run_id = ?', runId)[0]!.snapshot) as
    { execution: { schemaVersion: number; tasks: { profile: { id: string; parameters: Record<string, unknown> } }[] } }).execution;
  return { project, options, path, activation, runs, snapshotProfile };
}

describe('task graph v3 work input (domain)', () => {
  it('accepts v2 unchanged and v3 with or without a work input; a v2 graph never carries one; inputs are bounded and exact', () => {
    expect(TASK_GRAPH_SCHEMA_VERSION).toBe(3);
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
  it('compiles template + work input into exactly the profile a hand-prepared v2 registry entry produced, pinned and bound', async () => {
    const f = await seeded();
    await createRun(f.project, run('v3', 'coding', workInput()), f.options);
    await createRun(f.project, run('v2', 'hand', undefined, 2), f.options); // the pre-K3 path, unchanged
    const compiled = f.snapshotProfile('v3'), prepared = f.snapshotProfile('v2');
    expect(compiled.schemaVersion).toBe(1); // Run execution snapshot unchanged
    const v3 = compiled.tasks[0]!.profile, v2 = prepared.tasks[0]!.profile;
    expect(v3.id).toBe('coding'); // provenance: the template's registry identity
    expect(JSON.stringify({ ...v2, id: 'coding' })).toBe(JSON.stringify(v3));
    expect(encodeExecutionProfileDefinition(v3)).toBe(encodeExecutionProfileDefinition(handPrepared('coding')));
    expect(() => assertNativeWorkerBinding(v3 as never)).not.toThrow(); // WC-R2
    const argv = v3.parameters['argv'] as string[];
    expect(argv.slice(-4)).toEqual(['--model', 'claude-sonnet-5-5', '--', '__DECKENT_TASK_PROMPT__']);
    expect(argv).toContain('--max-turns');
    expect((v3.parameters['nativeSubscription'] as { model: unknown }).model).toEqual({ channelId: SEED_CHANNEL, modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [HAIKU] });
    // The work input's turn limit overrides the template's; the template itself holds no task text.
    await createRun(f.project, run('turns', 'coding', workInput('claude-sonnet-5-5', { maxTurns: 7 })), f.options);
    expect(encodeExecutionProfileDefinition(f.snapshotProfile('turns').tasks[0]!.profile)).toBe(encodeExecutionProfileDefinition(handPrepared('coding', 7)));
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
      ['on-prepared', workInput(), 'hand', 'WORK_INPUT_TEMPLATE_REQUIRED'],
    ] as const) {
      await expect(createRun(f.project, run(label, kind, input), f.options), label).rejects.toMatchObject({ code });
    }
    await expect(createRun(f.project, run('no-input', 'coding', undefined, 2), f.options)).rejects.toMatchObject({ code: 'WORK_INPUT_REQUIRED' });
    await expect(createRun(f.project, run('no-input-v3', 'coding'), f.options)).rejects.toMatchObject({ code: 'WORK_INPUT_REQUIRED' });
    expect(f.runs()).toBe(0); expect(await readFile(f.path)).toEqual(before);
    // A declared effort is admitted and recorded in the Run graph (not passed to the CLI: no adapter maps effort yet).
    const created = await createRun(f.project, run('effort-ok', 'coding', workInput('claude-sonnet-5-5', { effort: 'high' })), f.options);
    expect(created.admission.run.runId).toBe('effort-ok');
    expect(JSON.stringify(f.snapshotProfile('effort-ok'))).not.toContain('--effort');
  });

  it('replays idempotently from the frozen snapshot after the model is deactivated; a changed work input under the same command conflicts', async () => {
    const f = await seeded();
    const created = await createRun(f.project, run('r', 'coding', workInput()), f.options);
    const frozen = f.snapshotProfile('r');
    await f.activation('claude-sonnet-5-5', 'deactivate', 1);
    expect(await createRun(f.project, run('r', 'coding', workInput()), f.options)).toEqual(created);
    expect(f.snapshotProfile('r')).toEqual(frozen);
    expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run).toEqual(created.admission.run);
    expect((await reserveRunTasks(f.project, { schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r', expectedRevision: 0 }, f.options)).reservation.identities).toHaveLength(1);
    await expect(createRun(f.project, run('r', 'coding', { ...workInput(), task: 'Something else.' }), f.options)).rejects.toMatchObject({ code: 'RUN_COMMAND_CONFLICT' });
    await expect(createRun(f.project, run('new', 'coding', workInput()), f.options)).rejects.toMatchObject({ code: 'WORKER_MODEL_NOT_ACTIVE' });
  });

  it('admits and refuses through the runtime service and the CLI `run create --graph` with the same contract', async () => {
    const f = await seeded(); const observer = { async onPage() {}, async onError() {} };
    const service = await startConfiguredRuntimeService(f.project, observer, f.options); const client = createConfiguredRuntimeClient(f.project, f.options);
    try {
      await expect(client.createRun(run('svc-alias', 'coding', workInput('opus')))).rejects.toMatchObject({ code: 'WORKER_MODEL_ALIAS_REFUSED' });
      await expect(client.createRun(run('svc-unpaired', 'coding', undefined, 2))).rejects.toMatchObject({ code: 'WORK_INPUT_REQUIRED' });
      expect(f.runs()).toBe(0);
      expect((await client.createRun(run('svc-ok', 'coding', workInput()))).admission.run.runId).toBe('svc-ok');
      expect(f.runs()).toBe(1);
    } finally { await service.stop(); await service.done; }
    expect(encodeExecutionProfileDefinition(f.snapshotProfile('svc-ok').tasks[0]!.profile)).toBe(encodeExecutionProfileDefinition(handPrepared('coding')));
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
