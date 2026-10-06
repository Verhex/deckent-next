import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo, hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRun, inspectRun, reserveRunTasks } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const command = { schemaVersion: 1 as const, commandId: 'create', scopeId: 's', runId: 'r', graph: { schemaVersion: 2 as const, revision: 1,
  tasks: [{ id: 't', kind: 'purchase', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify purchase', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-configured-admission-')); roots.push(root);
  const project = join(root, 'project'); const data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const configPath = join(project, '.deckent/config.json');
  await writeFile(configPath, JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 2,
    ordering: 'input-order', registry: fixtureDockerRegistry(['purchase']) } }));
  const options = { env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') } };
  const { store, path, layout } = await openConfiguredAttemptStore(project, options);
  try { await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 } }); } finally { store.close(); }
  async function policy(run: boolean, pool: boolean) {
    const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
    const grants = [
      ...(run ? [{ id: 'run', effect: 'allow', actions: ['create', 'inspect', 'reserve'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r', 'r2'] } }] : []),
      ...(pool ? [{ id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } }] : []),
    ];
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants }), { mode: 0o600 });
  }
  return { project, data, path, layout, configPath, options, policy };
}
describe.skipIf(process.platform === 'win32')('configured SDK Run admission', () => {
  it.each([1, 2, 'auto'] as const)('max_workers=%s limits both admitted capacities without enlarging the pool profile', async maxWorkers => {
    const f = await fixture(); await f.policy(true, true);
    const config = JSON.parse(await readFile(f.configPath, 'utf8')); config.max_workers = maxWorkers;
    await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    await createRun(f.project, command, f.options);
    const { store } = await openConfiguredAttemptStore(f.project, f.options);
    try { expect((await store.loadRunExecutionPolicy('s', 'r')).capacity).toEqual({ executionSlots: 1, inFlightSlots: maxWorkers === 1 ? 1 : 2 }); }
    finally { store.close(); }
  });
  it('enforces the current installation ceiling across Runs and rejects fresh reservations when already occupied', async () => {
    const f = await fixture(); await f.policy(true, true);
    await createRun(f.project, command, f.options);
    await createRun(f.project, { ...command, commandId: 'create-r2', runId: 'r2' }, f.options);
    // Lower after admission: a historical Run policy must not bypass the installation ceiling.
    const config = JSON.parse(await readFile(f.configPath, 'utf8')); config.max_workers = 1;
    await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    const reserve = { schemaVersion: 1 as const, commandId: 'reserve-r', scopeId: 's', runId: 'r', expectedRevision: 0 };
    await reserveRunTasks(f.project, reserve, f.options);
    const before = await readFile(f.path);
    await expect(reserveRunTasks(f.project, { ...reserve, commandId: 'reserve-r2', runId: 'r2' }, f.options)).rejects.toMatchObject({ code: 'RUN_POOL_FULL' });
    expect(await readFile(f.path)).toEqual(before);
    expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r2' }, f.options)).run!.tasks[0]!.phase).toBe('pending');
    expect(await reserveRunTasks(f.project, reserve, f.options)).toMatchObject({ reservation: { identities: [{ runId: 'r' }] } });
  });
  it.each(['memoryBytes', 'cpus', 'pids'] as const)('refuses %s above the installation ceiling before writing Run evidence and never clamps', async resource => {
    const f = await fixture(); await f.policy(true, true);
    const config = JSON.parse(await readFile(f.configPath, 'utf8'));
    const parameters = config.admission.registry.profiles[0].parameters;
    config.execution = { docker: { ...parameters, executable: '/usr/bin/docker' }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000 } };
    delete config.execution.docker.argv;
    const ceiling = parameters[resource]; parameters[resource] = ceiling * 2;
    await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    await expect(createRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'EXECUTION_RESOURCE_CEILING', params: { resource, requested: ceiling * 2, ceiling } });
    const db = new DatabaseSync(f.path, { readOnly: true });
    try { for (const table of ['runs', 'run_receipts', 'run_execution_intents', 'attempts']) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0); }
    finally { db.close(); } parameters[resource] = ceiling;
    await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    await createRun(f.project, command, f.options);
    const { store } = await openConfiguredAttemptStore(f.project, f.options);
    try { expect((await store.loadRun('s', 'r'))!.execution.tasks[0]!.profile.parameters[resource]).toBe(ceiling); }
    finally { store.close(); }
  });
  it('persists a pending Run with configured limits and real layout, and makes it visible through shared inspection', async () => {
    const f = await fixture(); await f.policy(true, true);
    const result = await createRun(f.project, command, f.options);
    expect(result.admission.run).toMatchObject({ runId: 'r', layoutRevision: f.layout.revision, revision: 0 });
    expect(result.admission.run.tasks[0]!.phase).toBe('pending');
    const { pool, ...inspected } = (await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run; expect(inspected).toEqual(result.admission.run);
    expect(pool).toEqual({ poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 }, effectiveCapacity: { executionSlots: 2, inFlightSlots: 2 }, occupancy: { execution: 0, inFlight: 0 }, drift: [], waiting: [] });
    const { store } = await openConfiguredAttemptStore(f.project, f.options);
    try { expect((await store.loadRun('s', 'r'))!.progress[0]!.eligibility).toEqual({ kind: 'immediate' }); } finally { store.close(); }
    expect(await createRun(f.project, command, f.options)).toEqual(result);
  });
  it('requires both Run creation and pool-use policy, without creating a Run on denial', async () => {
    const f = await fixture();
    // The first write admission of the declared scope pins it to the configured company (H34 S1, Astra 2122); nothing else is written.
    const state = () => { const db = new DatabaseSync(f.path, { readOnly: true });
      try { return { runs: db.prepare('SELECT count(*) AS n FROM runs').get()!.n, receipts: db.prepare('SELECT count(*) AS n FROM run_receipts').get()!.n,
        pins: db.prepare('SELECT scope_id,company_id,origin FROM scope_registry').all() }; } finally { db.close(); } };
    const pinned = { runs: 0, receipts: 0, pins: [{ scope_id: 's', company_id: 'default', origin: 'admission' }] };
    await f.policy(true, false); await expect(createRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(state()).toEqual(pinned); const before = await readFile(f.path);
    await f.policy(false, true); await expect(createRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await readFile(f.path)).toEqual(before); expect(state()).toEqual(pinned);
  });
  it('returns a typed refusal, not denial, when Run or pool authority is require-approval (C12 Q8: SDK surface, no catalog broker here yet)', async () => {
    const f = await fixture();
    const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
    const requireApprovalGrants = (kind: 'run' | 'pool') => [
      { id: 'run', effect: kind === 'run' ? 'require-approval' : 'allow', actions: ['create', 'inspect', 'reserve'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r', 'r2'] } },
      { id: 'pool', effect: kind === 'pool' ? 'require-approval' : 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    ];
    await writeFile(join(f.data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: requireApprovalGrants('run') }), { mode: 0o600 });
    await expect(createRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'POLICY_APPROVAL_UNSUPPORTED' });
    await writeFile(join(f.data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: requireApprovalGrants('pool') }), { mode: 0o600 });
    await expect(createRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'POLICY_APPROVAL_UNSUPPORTED' });
    const db = new DatabaseSync(f.path, { readOnly: true });
    try { expect(db.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(0); } finally { db.close(); }
  });
  it('keeps historical admission replay separate from new pool authority and reports missing configuration explicitly', async () => {
    const f = await fixture(); await f.policy(true, true); const first = await createRun(f.project, command, f.options);
    await f.policy(true, false); expect(await createRun(f.project, command, f.options)).toEqual(first);
    await expect(createRun(f.project, { ...command, commandId: 'second', runId: 'r2' }, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const config = JSON.parse(await readFile(f.configPath, 'utf8')); config.admission = null; await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    await expect(createRun(f.project, { ...command, commandId: 'second', runId: 'r2' }, f.options)).rejects.toMatchObject({ code: 'RUN_ADMISSION_NOT_CONFIGURED' });
  });
  it('rejects zero-capacity profiles instead of creating permanently pending work', async () => {
    const f = await fixture(); await f.policy(true, true);
    const config = JSON.parse(await readFile(f.configPath, 'utf8')); config.admission.executionSlots = 0;
    await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    await expect(createRun(f.project, command, f.options)).rejects.toThrow();
    const db = new DatabaseSync(f.path, { readOnly: true });
    try { expect(db.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(0); } finally { db.close(); }
  });
  it('refuses schema upgrade during SDK admission and leaves the older ledger unchanged', async () => {
    const f = await fixture(); await f.policy(true, true); const db = new DatabaseSync(f.path);
    db.exec('DROP TABLE model_invocation_spend_reservations; DROP TABLE provider_spend_accounts; DROP TABLE execution_pools; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS workspace_adoptions; DROP TABLE IF EXISTS effect_intents; DROP TABLE IF EXISTS agent_turn_tool_calls; DROP TABLE IF EXISTS agent_turns; DROP TABLE IF EXISTS worker_event_logs; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=3'); db.close(); const before = await readFile(f.path);
    await expect(createRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
    expect(await readFile(f.path)).toEqual(before);
    const reader = new DatabaseSync(f.path, { readOnly: true });
    try { expect(reader.prepare('PRAGMA user_version').get()!.user_version).toBe(3); expect(reader.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(0); } finally { reader.close(); }
  });

  it('pins selected profile parameters and evaluator identity across config changes and admission replay', async () => {
    const f = await fixture(); await f.policy(true, true); const first = await createRun(f.project, command, f.options);
    const initial = await openConfiguredAttemptStore(f.project, f.options);
    const snapshot = await initial.store.loadRun('s', 'r'); initial.store.close();
    const config = JSON.parse(await readFile(f.configPath, 'utf8'));
    config.admission.registry.revision = 'changed-registry';
    config.admission.registry.profiles[0].parameters.argv = ['different-command'];
    await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    expect(await createRun(f.project, command, f.options)).toEqual(first);
    const reopened = await openConfiguredAttemptStore(f.project, f.options);
    try { expect(await reopened.store.loadRun('s', 'r')).toEqual(snapshot); } finally { reopened.store.close(); }
    expect(JSON.stringify(first)).not.toContain('parameters');
    expect(first.admission.run.criteria[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('reserves persisted admitted policy after admission config is removed, with a system UUID and exact replay', async () => {
    const f = await fixture(); await f.policy(true, true); await createRun(f.project, command, f.options);
    const config = JSON.parse(await readFile(f.configPath, 'utf8')); config.admission = null; await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    const reservation = { schemaVersion: 1 as const, commandId: 'reserve', scopeId: 's', runId: 'r', expectedRevision: 0 };
    const first = await reserveRunTasks(f.project, reservation, f.options);
    expect(first.reservation.identities).toHaveLength(1); expect(first.reservation.identities[0]!.attemptId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(first.reservation.run.tasks[0]!.phase).toBe('active'); expect(await reserveRunTasks(f.project, reservation, f.options)).toEqual(first);
  });
  it('requires current pool authority for a fresh reservation without changing the ledger', async () => {
    const f = await fixture(); await f.policy(true, true); await createRun(f.project, command, f.options); const before = await readFile(f.path);
    await f.policy(true, false);
    await expect(reserveRunTasks(f.project, { schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r', expectedRevision: 0 }, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await readFile(f.path)).toEqual(before);
  });
  it('requires fresh Run reserve authority before returning a historical reservation replay', async () => {
    const f = await fixture(); await f.policy(true, true); await createRun(f.project, command, f.options);
    const reservation = { schemaVersion: 1 as const, commandId: 'reserve', scopeId: 's', runId: 'r', expectedRevision: 0 };
    await reserveRunTasks(f.project, reservation, f.options); const before = await readFile(f.path);
    await f.policy(false, true);
    await expect(reserveRunTasks(f.project, reservation, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await readFile(f.path)).toEqual(before);
  });
  it.each(['kind', 'profile', 'evaluator'])('rejects unsupported %s before writing a Run', async invalid => {
    const f = await fixture(); await f.policy(true, true);
    const config = JSON.parse(await readFile(f.configPath, 'utf8'));
    if (invalid === 'kind') config.admission.registry.kinds[0].kind = 'unknown-kind';
    if (invalid === 'profile') config.admission.registry.profiles[0].parameters.argv = [];
    if (invalid === 'evaluator') config.admission.registry.evaluators[0].implementation.id = 'uninstalled';
    await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    await expect(createRun(f.project, command, f.options)).rejects.toMatchObject({ code:
      invalid === 'kind' ? 'TASK_KIND_NOT_REGISTERED' : invalid === 'profile' ? 'EXECUTION_PROFILE_INVALID' : 'TASK_EVALUATOR_INVALID' });
    const db = new DatabaseSync(f.path, { readOnly: true });
    try { expect(db.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(0); } finally { db.close(); }
  });

});
describe.skipIf(process.platform === 'win32')('configured SDK Run graph limits (PARALLEL-S3)', () => {
  it.each([['tasks', { maxTasks: 3 }, 4, 3], ['edges', { maxEdges: 2 }, 3, 2], ['depth', { maxDepth: 3 }, 4, 3]] as const)(
    'PARALLEL-S3: refuses a graph above admission.graph %s with typed TASK_GRAPH_LIMIT, writes nothing, and admits once config is raised', async (detail, limits, observed, limit) => {
      const f = await fixture(); await f.policy(true, true);
      const chain = { ...command, graph: { ...command.graph, tasks: ['a', 'b', 'c', 'd'].map((id, index, ids) => ({ id, kind: 'purchase',
        dependencies: index ? [ids[index - 1]!] : [], acceptanceCriteria: ['verified'] })) } };
      const config = JSON.parse(await readFile(f.configPath, 'utf8')); config.admission.graph = limits;
      await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
      const field = `admission.graph.max${detail[0]!.toUpperCase()}${detail.slice(1)}`;
      const refusal = await createRun(f.project, chain, f.options).then(() => null, (error: unknown) => error);
      expect(refusal).toMatchObject({ code: 'TASK_GRAPH_LIMIT', params: { detail, observed, limit, field } });
      expect((refusal as Error).message).toContain(field);
      const db = new DatabaseSync(f.path, { readOnly: true });
      try { for (const table of ['runs', 'run_receipts', 'run_execution_intents', 'attempts']) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0); }
      finally { db.close(); }
      delete config.admission.graph; // defaults (256 tasks, 1024 edges, depth 32) admit the same graph
      await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
      await createRun(f.project, chain, f.options);
      const graph = (await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run!.graphSummary;
      expect(graph).toEqual({ schemaVersion: 1, shape: { tasks: 4, edges: 3, depth: 4 }, criticalPath: ['a', 'b', 'c', 'd'],
        counts: { pending: 4, running: 0, attention: 0, accepted: 0, failed: 0, stopped: 0, total: 4 } });
    });
});

it.skipIf(process.platform === 'win32')('requires POSIX managed storage: SDK admits a conditional graph, retains the decision after config removal and reserves only its selected branch', async () => {
  const f = await fixture(); await f.policy(true, true);
  const graph = { ...command.graph, tasks: ['yes', 'no', 'join'].map(id => ({ ...command.graph.tasks[0]!, id, dependencies: id === 'join' ? ['yes', 'no'] : [] })) };
  const branch = { schemaVersion: 1 as const, input: { id: 'condition', revision: 'fact-1', value: true }, whenTrue: 'yes', whenFalse: 'no', join: 'join' };
  const first = await createRun(f.project, { ...command, graph, branch }, f.options);
  expect(first.admission.run.branch?.selectedTaskId).toBe('yes');
  expect(first.admission.run.tasks.map(t => t.id)).toEqual(['yes', 'join']);
  expect(JSON.stringify(first)).not.toContain('parameters');
  const config = JSON.parse(await readFile(f.configPath, 'utf8')); config.admission = null;
  await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
  expect(await createRun(f.project, { ...command, graph, branch }, f.options)).toEqual(first);
  expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run?.branch).toEqual(first.admission.run.branch);
  const next = await reserveRunTasks(f.project, { schemaVersion: 1, commandId: 'reserve-branch', scopeId: 's', runId: 'r', expectedRevision: 0 }, f.options);
  expect(next.reservation.identities.map(i => i.taskId)).toEqual(['yes']);
});
