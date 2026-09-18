import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo, hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRun, inspectRun } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache } from '#platform/index.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const command = { schemaVersion: 1 as const, commandId: 'create', scopeId: 's', runId: 'r', graph: { schemaVersion: 1 as const, revision: 1,
  tasks: [{ id: 't', kind: 'purchase', dependencies: [], acceptanceCriteria: ['verified'] }] } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-configured-admission-')); roots.push(root);
  const project = join(root, 'project'); const data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const configPath = join(project, '.deckent/config.json');
  await writeFile(configPath, JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 2, ordering: 'input-order' } }));
  const options = { env: { HOME: join(root, 'home') } };
  const { store, path, layout } = await openConfiguredAttemptStore(project, options);
  try { await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 } }); } finally { store.close(); }
  async function policy(run: boolean, pool: boolean) {
    const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
    const grants = [
      ...(run ? [{ id: 'run', effect: 'allow', actions: ['create', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r', 'r2'] } }] : []),
      ...(pool ? [{ id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } }] : []),
    ];
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants }), { mode: 0o600 });
  }
  return { project, data, path, layout, configPath, options, policy };
}
describe.skipIf(process.platform === 'win32')('configured SDK Run admission', () => {
  it('persists a pending Run with configured limits and real layout, and makes it visible through shared inspection', async () => {
    const f = await fixture(); await f.policy(true, true); const before = Date.now();
    const result = await createRun(f.project, command, f.options);
    expect(result.admission.run).toMatchObject({ runId: 'r', layoutRevision: f.layout.revision, revision: 0 });
    expect(result.admission.run.tasks[0]!.phase).toBe('pending');
    expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run).toEqual(result.admission.run);
    const { store } = await openConfiguredAttemptStore(f.project, f.options);
    try { expect((await store.loadRun('s', 'r'))!.progress[0]!.eligibleAt).toBeGreaterThanOrEqual(before); } finally { store.close(); }
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
});
