import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo, hostname } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createRun, inspectRun, requestRunCancellation } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const command = { schemaVersion: 1 as const, commandId: 'cancel', action: 'cancel' as const, scopeId: 's', runId: 'r', expectedRevision: 0 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-sdk-cancel-')); roots.push(root);
  const project = join(root, 'project'); const data = join(root, 'relocated'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: 1,
    inFlightSlots: 1, ordering: 'input-order', registry: fixtureDockerRegistry(['purchase']) } }));
  const options = { env: { HOME: join(root, 'home') } };
  const { store, path } = await openConfiguredAttemptStore(project, options);
  try { await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); } finally { store.close(); }
  async function policy(cancel: boolean) {
    const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
      { id: 'run', effect: 'allow', actions: ['create', 'inspect', ...(cancel ? ['cancel'] : [])], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
      { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    ] }), { mode: 0o600 });
  }
  await policy(true);
  await createRun(project, { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r', graph: { schemaVersion: 2, revision: 1,
    tasks: [{ id: 't', kind: 'purchase', dependencies: [], acceptanceCriteria: ['verified'] }],
    criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify purchase', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] } }, options);
  return { project, options, path, policy };
}
describe.skipIf(process.platform === 'win32')('configured SDK cancellation intent', () => {
  it('persists intent at relocated data root, replays exactly and shares the inspection view without claiming termination', async () => {
    const f = await fixture(); const result = await requestRunCancellation(f.project, command, f.options);
    expect(result.cancellation.run).toMatchObject({ cancellationRequested: true, revision: 1 });
    expect(result.cancellation.run.tasks[0]!.phase).toBe('pending');
    expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run).toEqual(result.cancellation.run);
    expect(await requestRunCancellation(f.project, command, f.options)).toEqual(result);
    await expect(requestRunCancellation(f.project, { ...command, commandId: 'stale' }, f.options)).rejects.toMatchObject({ code: 'RUN_STORE_CONFLICT' });
  });
  it('checks current cancel authority even on replay and denies foreign scope without modifying ledger bytes', async () => {
    const f = await fixture(); await requestRunCancellation(f.project, command, f.options); await f.policy(false); const before = await readFile(f.path);
    await expect(requestRunCancellation(f.project, command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(requestRunCancellation(f.project, { ...command, scopeId: 'foreign' }, f.options)).rejects.toThrow();
    expect(await readFile(f.path)).toEqual(before);
  });
  it('never upgrades an older ledger during cancellation', async () => {
    const f = await fixture(); const db = new DatabaseSync(f.path); db.exec('DROP TABLE model_invocation_spend_reservations; DROP TABLE provider_spend_accounts; DROP TABLE execution_pools; DROP TABLE IF EXISTS workspace_integrations; PRAGMA user_version=3'); db.close();
    const before = await readFile(f.path);
    await expect(requestRunCancellation(f.project, command, f.options)).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
    expect(await readFile(f.path)).toEqual(before);
  });
});
