import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyModelCatalog, createRun, inspectRun } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { runViewSchema } from '#engine/index.js';
import { clearConfigCache } from '#platform/index.js';
import { seedCatalog } from '../support/model-catalog.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const channelId = 'codex-effort-fixture', modelId = 'exact-effort-fixture';
const model = { channelId, modelId, auxiliaryModelIds: [] };
const command = (runId: string, kind: string, effort?: string) => ({ schemaVersion: 1 as const, commandId: `create-${runId}`, scopeId: 's', runId,
  graph: { schemaVersion: 4, revision: 1, tasks: [{ id: 't', kind, dependencies: [], acceptanceCriteria: ['exit'], workInput: {
    schemaVersion: 1, task: 'Review note.txt', scope: { paths: ['note.txt'] }, acceptance: 'Report findings', model, ...(effort ? { effort } : {}),
  } }], criterionDefinitions: [{ id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] } });

/** Real catalog/policy/ledger admission; inspect the persisted profile without starting a worker or service. */
async function fixture(efforts = ['ultra'], ultraTarget = false) {
  const project = await mkdtemp(join(tmpdir(), 'dn-run-inspect-freeze-')); roots.push(project);
  const data = join(project, 'd'), configPath = join(project, '.deckent/config.json'), options = { env: { HOME: join(project, 'h') } };
  await mkdir(join(project, '.deckent'), { recursive: true });
  const registry = { schemaVersion: 1, revision: 'effort-r', profiles: [{ id: 'native', version: 1, adapter: { id: 'native-coding-template', version: 1 }, parameters: {
    schemaVersion: 1, docker: { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64,
      logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 },
    invocation: { provider: 'codex', cliVersion: 'codex-cli 0.159.2', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended' },
  } }], kinds: ['small', 'design'].map(kind => ({ kind, profile: { id: 'native', version: 1 } })),
  evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }], ...(ultraTarget ? {
    workClasses: { schemaVersion: 1, revision: 'deliberate-ultra', classes: [{ id: 'opt-in', defaultEffort: 'ultra' }], bindings: [{ kind: 'design', classId: 'opt-in' }] },
  } : {}) };
  await writeFile(configPath, JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1,
    ordering: 'input-order', registry } }));
  const { store, path } = await openConfiguredAttemptStore(project, options);
  try { await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); } finally { store.close(); }
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'catalog', effect: 'allow', actions: ['activate'], scopes: 'all', principals, resource: { kind: 'model-activation', ids: 'all' } },
  ] }), { mode: 0o600 });
  const seed = await seedCatalog(), provider = seed.providers[0];
  const catalog = { schemaVersion: 3, revision: 'effort-r-fixture', providers: [{ ...provider, id: channelId, channel: { ...provider.channel, cli: 'codex', client: 'codex',
    protocolFamily: 'fixture', aliases: [], aliasesRefused: [] }, models: [{ ...provider.models[0], id: modelId, nativeId: modelId, channelModelId: modelId,
    canonicalModelId: modelId, aliases: [], efforts, reasoning: { supportedEfforts: efforts, defaultEffort: efforts[0] }, minCliVersion: null, minClientVersion: null,
    lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null },
    protocols: [{ family: 'fixture', version: 'v1', capabilities: [] }] }] }] };
  await applyModelCatalog(project, { schemaVersion: 1, commandId: 'catalog-register', scopeId: 's', action: 'register', catalog }, options);
  for (const id of [null, modelId]) await applyModelCatalog(project, { schemaVersion: 1, commandId: `activate-${id}`, scopeId: 's',
    action: 'activate', channelId, modelId: id, expectedRevision: 0 }, options);
  const profile = (runId: string) => { const db = new DatabaseSync(path, { readOnly: true });
    try { const row = db.prepare('SELECT snapshot FROM runs WHERE run_id = ?').get(runId) as { snapshot: string };
      return JSON.parse(row.snapshot).execution.tasks[0].profile; } finally { db.close(); } };
  return { project, options, path, configPath, profile };
}

describe.skipIf(process.platform === 'win32')('configured inspect RunView readonly contract', () => {
  it.each(['tasks-array', 'task-wrapper'] as const)('rejects JavaScript mutation of the actual %s after brief enrichment', async target => {
    const f = await fixture(['medium']), request = command('frozen', 'small', 'medium');
    const admitted = await createRun(f.project, request, f.options), before = await readFile(f.path);
    const inspected = await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: request.runId }, f.options);
    const view = inspected.run!, task = view.tasks[0]!, valueBefore = JSON.stringify(view);
    expect(task).toEqual(admitted.admission.run.tasks[0]);
    expect(view).toMatchObject({ scopeId: 's', runId: request.runId, layoutRevision: admitted.layout.revision,
      registryRevision: admitted.admission.run.registryRevision, revision: 0, state: { kind: 'running' } });
    expect(inspected.layout).toEqual(admitted.layout);
    expect(task.taskBrief!.model).toEqual(model); expect(task.taskBrief!.effort).toBe('medium');
    expect(task.reasoningEffort).toEqual({ schemaVersion: 1, level: 'medium', source: 'explicit', status: 'selected' });
    expect(task.resultBrief).toMatchObject({ schemaVersion: 1, attemptId: null, report: null, evaluation: { verdict: null } });
    for (const nested of [view.state, view.criteria, task.dependencies, task.acceptanceCriteria, task.profile,
      task.taskBrief, task.taskBrief!.model, task.resultBrief, task.resultBrief!.evaluation, task.reasoningEffort]) {
      expect(Object.isFrozen(nested)).toBe(true);
    }
    // Reflect invokes ordinary JavaScript mutation semantics without TypeScript readonly casts.
    if (target === 'tasks-array') {
      expect(Reflect.deleteProperty(view.tasks, '0')).toBe(false);
      expect(Reflect.set(view.tasks, 'length', 0)).toBe(false);
      expect(() => Array.prototype.push.call(view.tasks, task)).toThrow(TypeError);
    } else {
      expect(Reflect.set(task, 'phase', 'accepted')).toBe(false);
      expect(Reflect.deleteProperty(task, 'reasoningEffort')).toBe(false);
      expect(Reflect.defineProperty(task, 'resultBrief', { value: null })).toBe(false);
    }
    expect(Object.isFrozen(view)).toBe(true); expect(Object.isFrozen(view.tasks)).toBe(true); expect(Object.isFrozen(task)).toBe(true);
    expect(Reflect.set(view, 'revision', 99)).toBe(false);
    expect(JSON.stringify(view)).toBe(valueBefore);
    expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: request.runId }, f.options)).run).toEqual(view);
    expect(await readFile(f.path)).toEqual(before);
  });

  it('keeps historical optional view fields absent when the public parser receives an older view', async () => {
    const f = await fixture(['medium']), request = command('historical', 'small');
    await createRun(f.project, request, f.options);
    const view = (await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: request.runId }, f.options)).run!;
    const tasks = view.tasks.map(({ taskBrief, resultBrief, reasoningEffort, ...task }) => {
      void taskBrief; void resultBrief; void reasoningEffort; return task;
    });
    const legacy = runViewSchema.parse({ ...view, tasks });
    for (const field of ['taskBrief', 'resultBrief', 'reasoningEffort']) expect(legacy.tasks[0]).not.toHaveProperty(field);
    expect(Object.isFrozen(legacy.tasks[0])).toBe(true); expect(Object.isFrozen(legacy.tasks)).toBe(true);
  });

  it('preserves unsupported-effort refusal, absent Run and current Run policy revocation', async () => {
    const f = await fixture(['medium']), request = command('accepted', 'small', 'medium');
    await createRun(f.project, request, f.options); const before = await readFile(f.path);
    await expect(createRun(f.project, command('refused', 'small', 'ultra'), f.options)).rejects.toMatchObject({ code: 'WORKER_EFFORT_UNSUPPORTED' });
    expect(await readFile(f.path)).toEqual(before);
    const missing = await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'missing' }, f.options);
    expect(missing.run).toBeNull(); expect(Object.isFrozen(missing)).toBe(true);
    const policyPath = join(f.project, 'd', 'policy.json'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
    policy.grants = policy.grants.filter((grant: { resource: { kind: string } }) => grant.resource.kind !== 'run');
    await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
    await expect(inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: request.runId }, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await readFile(f.path)).toEqual(before);
  });
});
