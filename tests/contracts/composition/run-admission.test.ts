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
  const options = { env: { HOME: join(root, 'home') } };
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
  it('persists a pending Run with configured limits and real layout, and makes it visible through shared inspection', async () => {
    const f = await fixture(); await f.policy(true, true);
    const result = await createRun(f.project, command, f.options);
    expect(result.admission.run).toMatchObject({ runId: 'r', layoutRevision: f.layout.revision, revision: 0 });
    expect(result.admission.run.tasks[0]!.phase).toBe('pending');
    expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run).toEqual(result.admission.run);
    const { store } = await openConfiguredAttemptStore(f.project, f.options);
    try { expect((await store.loadRun('s', 'r'))!.progress[0]!.eligibility).toEqual({ kind: 'immediate' }); } finally { store.close(); }
    expect(await createRun(f.project, command, f.options)).toEqual(result);
  });
  it('requires both Run creation and pool-use policy, without creating a Run on denial', async () => {
    const f = await fixture(); const before = await readFile(f.path);
    await f.policy(true, false); await expect(createRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await readFile(f.path)).toEqual(before);
    await f.policy(false, true); await expect(createRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await readFile(f.path)).toEqual(before);
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
    db.exec('DROP TABLE execution_pools; PRAGMA user_version=3'); db.close(); const before = await readFile(f.path);
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
