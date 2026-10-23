import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyModelCatalog, createRun } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { classifyConfiguredRunSpending } from '../../../src/composition/core/runs/index.js';
import { openSqliteModelCatalogReader } from '#adapters/index.js';
import { readWorkerModelPin } from '#domain/index.js';
import { clearConfigCache } from '#platform/index.js';
import { seedCatalog, SEED_CHANNEL } from '../support/model-catalog.js';

// ATAMA-1 end to end on the product admission path: the configured registry, the ledger catalog and the scope's activation rows decide the
// worker of a work input v2 task; the Run freezes the seal; a refusal creates no Run; a replay is the same Run.
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const docker = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
  deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const claude = { provider: 'claude', cliVersion: '2.1.293 (Claude Code)', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended' };
const registry = { schemaVersion: 1, revision: 'atama-1', profiles: [{ id: 'coding', version: 1, adapter: { id: 'native-coding-template', version: 1 },
  parameters: { schemaVersion: 1, docker, invocation: claude } }], kinds: [{ kind: 'coding', profile: { id: 'coding', version: 1 } }],
  evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] };
const input = { schemaVersion: 2, task: 'Append the line "done" to note.txt.', scope: { paths: ['note.txt'] }, acceptance: 'note.txt ends with "done".' };
const run = (runId: string, workClass?: string) => ({ schemaVersion: 1 as const, commandId: `create-${runId}`, scopeId: 's', runId, graph: { schemaVersion: 4, revision: 1,
  tasks: [{ id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'], ...(workClass ? { workClass } : {}), workInput: input }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] } });

async function seeded() {
  const project = await mkdtemp(join(tmpdir(), 'dn-assignment-')); roots.push(project); const data = join(project, 'd');
  await mkdir(join(project, '.deckent'), { recursive: true }); const options = { env: { HOME: join(project, 'h') } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1,
    ordering: 'input-order', registry }, cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 } }));
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
  const activate = (modelId: string | null) => catalog({ action: 'activate', channelId: SEED_CHANNEL, modelId, expectedRevision: 0 });
  await catalog({ action: 'register', catalog: await seedCatalog() });
  await activate(null); await activate('claude-sonnet-5-5');
  const read = <T>(sql: string, ...args: string[]) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all(...args) as T[]; } finally { db.close(); } };
  const runs = () => read<{ n: number }>('SELECT count(*) AS n FROM runs')[0]!.n;
  const execution = (runId: string) => (JSON.parse(read<{ snapshot: string }>('SELECT snapshot FROM runs WHERE run_id = ?', runId)[0]!.snapshot) as
    { execution: { tasks: { profile: { parameters: Record<string, unknown> }; assignment?: Record<string, unknown> }[] } }).execution.tasks[0]!;
  return { project, options, path, activate, runs, execution };
}

it('feature work with no listed model active in the scope is refused naming every candidate; no Run is created', async () => {
  const f = await seeded();
  // feature → standard: Opus is registered but not active here; the Codex and Cursor channels are not in this ledger at all.
  await expect(createRun(f.project, run('feature-none'), f.options)).rejects.toMatchObject({ code: 'WORKER_ASSIGNMENT_NONE', params: expect.objectContaining({ taskId: 't',
    workClass: 'feature', skipped: 'claude-cli-subscription/claude-opus-5-5: WORKER_MODEL_NOT_ACTIVE; codex-cli-subscription/gpt-6.1-sol: WORKER_CHANNEL_NOT_ACTIVE; '
      + 'cursor-cli-subscription/claude-opus-5-thinking-high: WORKER_CHANNEL_NOT_ACTIVE' }) });
  expect(f.runs()).toBe(0);
});

it('small work takes the active listed model; the Run freezes the pin and its seal, and a replay is the same Run', async () => {
  const f = await seeded();
  const created = await createRun(f.project, run('small', 'small'), f.options);
  const task = f.execution('small');
  expect(readWorkerModelPin(task.profile.parameters)!.pin).toEqual({ channelId: SEED_CHANNEL, modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [] });
  expect(task.assignment).toMatchObject({ workClass: 'small', workClassRevision: 'atama-1-2026-10-23', candidatePolicy: { id: 'light', version: 1 }, candidateIndex: 0,
    modelId: 'claude-sonnet-5-5', effort: { level: null, source: 'cli-default' }, skipped: [] });
  const replay = await createRun(f.project, run('small', 'small'), f.options);
  expect(replay.admission).toEqual(created.admission); expect(f.runs()).toBe(1);
  // Activating Opus later does not move an admitted Run: its frozen choice stays.
  await f.activate('claude-opus-5-5');
  await createRun(f.project, run('small', 'small'), f.options);
  expect(f.execution('small').assignment).toEqual(task.assignment);
});

it('once the scope activates Opus, feature work is assigned to it; spending classification sees the same subscription worker', async () => {
  const f = await seeded(); await f.activate('claude-opus-5-5');
  await createRun(f.project, run('feature'), f.options);
  expect(f.execution('feature').assignment).toMatchObject({ workClass: 'feature', candidateIndex: 0, modelId: 'claude-opus-5-5' });
  const { graph } = run('feature-proposal');
  const proposal = { schemaVersion: 1 as const, commandId: 'p', proposalId: 'p', scopeId: 's', runId: 'feature-proposal', proposer: { id: 'o', issuer: 'test', subject: 'o' },
    source: { kind: 'human' as const }, budgetCeiling: { currency: 'USD', limitMinorUnits: 0 }, requiredPermissions: [], graph };
  const basis = await classifyConfiguredRunSpending(f.project, proposal as never, f.options, async () => openSqliteModelCatalogReader(f.path, { busyTimeoutMs: 1000 }));
  expect(basis.semantics).toBe('not-metered');
  // Without a catalog reader the unassigned input is the typed refusal, never a guessed worker.
  await expect(classifyConfiguredRunSpending(f.project, proposal as never, f.options)).rejects.toMatchObject({ code: 'WORKER_MODEL_UNASSIGNED' });
});
