import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateTask, prepareConfiguredWorkspacePatch } from '../../../src/index.js';
import { configuredTargetQueueTerminal, startConfiguredRuntimeService } from '../../../src/composition/core/runtime-service/index.js';
import { executeConfiguredTask } from '../../../src/composition/core/execution/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '../../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { DockerSupervisor } from '#adapters/index.js';
import { queueCommandIds, type TargetQueueView } from '#engine/index.js';
import type { AttemptIdentity } from '#domain/index.js';
import { clearConfigCache } from '#platform/index.js';
import { git, TARGET, SCOPE, graph, cliInPty, queueProject } from '../support/delivery-queue-fixture.js';

// TESLIM-KUYRUGU R6: the queue's verification Runs progress unattended. The runtime service starts with automatic Run progression on, as a
// production installation does (runRuntime is a bound restart field, default poll 1 s). Two coding Runs on H0 with disjoint paths are fixture
// input (made and accepted before the service starts). After enqueue the test only observes: the service re-prepares each candidate, admits
// a `verify` Run on it, and its own Run progression (run-progression, wired in runtime-service server.ts) reserves, executes in Docker and
// evaluates that Run; the queue sees the accepted verification and moves the ticket to awaiting-confirmation. Nothing here calls execute,
// evaluate or reserve for a verification Run. The batch is then confirmed on the shipped CLI's own PTY.
const roots: string[] = [], cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const WORKERS: Readonly<Record<string, string>> = {
  'write-a': "require('node:fs').writeFileSync('a.txt','first\\n')",
  'write-b': "require('node:fs').writeFileSync('b.txt','second\\n')",
  // The installation's adoption bar: exits 0 only on a candidate that carries the first delivery's file.
  verify: "require('node:fs').accessSync('a.txt')",
};

async function fixture() {
  const { project, target, base, options } = await queueProject({ roots, prefix: 'dn-queue-autorun-', workers: WORKERS, revision: 'queue-autorun',
    // Production shape: runRuntime is present (the shipped default polls every second); targetQueue keeps its shipped verification timeout and
    // TTL. Only the collection window is widened so both enqueues form one FIFO prefix, and the toolchain refresh is off (no network here).
    config: { runRuntime: { pollIntervalMs: 250, failureBackoffMs: 1000 }, toolchains: { update: { atStartup: false, intervalMs: 0 } } },
  });
  const loadRun = async (runId: string) => {
    const store = await openConfiguredAttemptStore(project, options);
    try { return await store.store.loadRun(SCOPE, runId); } finally { store.store.close(); }
  };
  /** Stop and remove the Docker container of every Attempt a Run bound (a no-op when its supervisor already released it). */
  const release = async (runId: string) => {
    const store = await openConfiguredAttemptStore(project, options);
    try {
      for (const binding of (await store.store.loadRun(SCOPE, runId))?.bindings ?? []) {
        const record = await store.store.loadBoundDispatch(binding.identity);
        if (record) { const supervisor = await DockerSupervisor.restoreProfile(record.profile); await supervisor.cancel(record.request); await supervisor.release(record.request); }
      }
    } finally { store.store.close(); }
  };
  /** Fixture input only, before the service starts: a coding Run on H0 executed, its patch prepared, and accepted. */
  const coding = async (runId: string, kind: string): Promise<AttemptIdentity> => {
    await createConfiguredRun(project, { schemaVersion: 1, scopeId: SCOPE, runId, commandId: `create-${runId}`, graph: graph(kind) }, options);
    const identity = (await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: SCOPE, runId, commandId: `reserve-${runId}`, expectedRevision: 0 }, options)).reservation.identities[0]!;
    cleanup.push(() => release(runId));
    expect((await executeConfiguredTask(project, identity, options)).execution.terminal?.exitCode).toBe(0);
    await prepareConfiguredWorkspacePatch(project, identity, options);
    const evaluated = await evaluateTask(project, { schemaVersion: 1, commandId: `evaluation-${runId}`, identity, expectedRevision: (await loadRun(runId))!.revision }, options);
    expect(evaluated.evaluation.run.tasks[0]!.phase).toBe('accepted');
    return identity;
  };
  return { project, target, base, options, coding, loadRun, release };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, notes: () => unknown, timeoutMs = 240_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)}; service notes ${JSON.stringify(notes())}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

describe.skipIf(process.platform !== 'linux' || !process.env['DECKENT_TEST_DOCKER_IMAGE'])('delivery queue verification runs unattended: the service progresses its own verification Runs', () => {
  it('two disjoint deliveries reach awaiting-confirmation through the service\'s automatic Run progression alone, then one terminal confirmation adopts both', { timeout: 900_000 }, async () => {
    const f = await fixture();
    const attempts = [await f.coding('r1', 'write-a'), await f.coding('r2', 'write-b')];
    expect(await git(f.target, 'rev-parse', TARGET)).toBe(f.base);
    // Every coding Run is terminal before the service starts: automatic progression has nothing to take but what the queue admits.
    for (const runId of ['r1', 'r2']) expect((await f.loadRun(runId))?.state.kind).toBe('terminal');

    const tickets = ['q1', 'q2'], verificationRuns = tickets.map(ticket => queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: ticket } } as never).verificationRun);
    for (const runId of verificationRuns) cleanup.push(() => f.release(runId));
    const progressed: string[] = [], notes: { source: string; code: string; runId?: string }[] = [];
    const service = await startConfiguredRuntimeService(f.project, { onPage() {}, onError() {},
      onRunProgression(query) { progressed.push(query.runId); },
      onRunProgressionError(query, error) { notes.push({ source: 'run-progression', code: error.code, ...(query ? { runId: query.runId } : {}) }); },
      onQueryFailure(event) { notes.push({ source: 'query', code: event.code }); },
    }, { env: f.options.env });
    cleanup.push(async () => { await service.stop(); await service.done; });
    const client = configuredTargetQueueTerminal(f.project, f.options).deliveryQueue;
    const view = async (commandId: string) => (await client.inspectTargetQueue({ schemaVersion: 1, scopeId: SCOPE, commandId })).record;
    for (const [index, ticket] of tickets.entries())
      expect(await client.enqueueTargetQueue({ schemaVersion: 1, commandId: ticket, identity: attempts[index]!, target: { kind: 'git-ref', id: TARGET } })).toMatchObject({ commandId: ticket, state: 'queued' });

    // Observation only: no execute, evaluate or reserve call for a verification Run exists in this test.
    const waiting = await Promise.all(tickets.map(ticket => until(() => view(ticket), record => record?.state === 'awaiting-confirmation' || record?.state === 'settled' || record?.state === 'parked',
      `${ticket} leaves verification`, () => ({ notes, progressed }))));
    expect(waiting.map(record => [record?.state, record?.verification?.phase])).toEqual([['awaiting-confirmation', 'accepted'], ['awaiting-confirmation', 'accepted']]);
    for (const runId of verificationRuns) {
      const run = await f.loadRun(runId);
      // A normal `verify` Run on the exact candidate, reserved, executed and accepted by the service's own progression turn.
      expect(run?.graph.tasks.map(task => task.kind)).toEqual(['verify']);
      expect(run?.progress.map(row => row.phase)).toEqual(['accepted']);
      expect(run?.bindings).toHaveLength(1);
      expect(progressed).toContain(runId);
    }
    expect(progressed.filter(runId => !verificationRuns.includes(runId))).toEqual([]);
    expect(notes).toEqual([]);
    expect(await git(f.target, 'rev-parse', TARGET)).toBe(f.base);

    // The human act stays on the terminal: one publication card and one adoption card for the two-item batch.
    const confirmed = await cliInPty(f.project, f.options.env, ['task', 'integration-queue-confirm', '--scope', SCOPE, '--command-id', 'q1'],
      [['y/N: ', 'y\r'], ['Adopt the verified prefix', 'y\r', 'fresh'], ['Queue result', '']]);
    expect(confirmed.status).toBe(0);
    expect(confirmed.output.match(/Items: 2/gu)).toHaveLength(2);
    expect(confirmed.output).toContain('"settledPrefix":2');
    const settled = await Promise.all(tickets.map(view)) as TargetQueueView[];
    expect(settled.map(record => [record.state, record.outcome])).toEqual([['settled', 'adopted'], ['settled', 're-prepared+adopted']]);
    const c2 = await git(f.target, 'rev-parse', TARGET), c1 = await git(f.target, 'rev-parse', `${c2}^`);
    expect(await git(f.target, 'rev-parse', `${c1}^`)).toBe(f.base);
    expect((await git(f.target, 'ls-tree', '--name-only', c2)).split('\n').sort()).toEqual(['a.txt', 'b.txt', 'note.txt']);
    expect(notes).toEqual([]);
  });
});
