import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateTask, prepareConfiguredWorkspacePatch } from '../../../src/index.js';
import { configuredTargetQueueTerminal, startConfiguredRuntimeService } from '../../../src/composition/core/runtime-service/index.js';
import { executeConfiguredTask } from '../../../src/composition/core/execution/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '../../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { DockerSupervisor } from '#adapters/index.js';
import { queueCommandIds, reattemptCommandIds } from '#engine/index.js';
import type { AttemptIdentity } from '#domain/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
import { cliInPty } from '../support/delivery-queue-fixture.js';

// alpha.47 S5b (owner D1a/D2b, 2026-10-18), real boundary: two independent coding Runs on H0 append to the SAME file. The human enqueues both
// with the per-Run delivery intent. The second is refused in the batch (its base advanced past H0 under the first candidate) and settles
// conflict-needs-reattempt. While the first waits for the owner's cards the live base has not moved, so the service only waits. After the
// owner adopts the first, the service re-runs the second's frozen Task once as a new Run on the adopted base (its own Run progression
// executes it in Docker), enqueues the accepted Attempt as the owner's service principal, verifies it, and the owner's two cards adopt it.
// Both land; nothing reaches the target without the cards. Earlier context of this fixture (TESLIM-KUYRUGU R6):
// the queue's verification Runs progress unattended. The runtime service starts with automatic Run progression on, as a
// production installation does (runRuntime is a bound restart field, default poll 1 s). Two coding Runs on H0 with disjoint paths are fixture
// input (made and accepted before the service starts). After enqueue the test only observes: the service re-prepares each candidate, admits
// a `verify` Run on it, and its own Run progression (run-progression, wired in runtime-service server.ts) reserves, executes in Docker and
// evaluates that Run; the queue sees the accepted verification and moves the ticket to awaiting-confirmation. Nothing here calls execute,
// evaluate or reserve for a verification Run. The batch is then confirmed on the shipped CLI's own PTY.
const exec = promisify(execFile);
const roots: string[] = [], cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const git = async (cwd: string, ...args: string[]) => (await exec('/usr/bin/git', ['-C', cwd, ...args])).stdout.trim();
const TARGET = 'refs/heads/dogfood/adopted', SCOPE = 's';
const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
const attemptActions = ['execute', 'read-output', 'recover-output', 'prepare-integration', 'deliver-integration', 'evaluate', 'adopt-integration', 'rollback-integration'];
const criterion = { id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } };
const graph = (kind: string) => ({ schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind, dependencies: [], acceptanceCriteria: ['exit'] }], criterionDefinitions: [criterion] });
/** Both coding kinds append to the base file `shared.txt`: same path, independent work. */
const WORKERS: Readonly<Record<string, string>> = {
  'append-first': "require('node:fs').appendFileSync('shared.txt','first\\n')",
  'append-second': "require('node:fs').appendFileSync('shared.txt','second\\n')",
  verify: "require('node:fs').accessSync('shared.txt')",
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dn-queue-reattempt-')); roots.push(root);
  const project = join(root, 'project'), target = join(root, 'target'), data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await git(project, 'init', '-q'); await git(project, 'config', 'user.email', 'live@example.invalid'); await git(project, 'config', 'user.name', 'Live');
  await writeFile(join(project, 'shared.txt'), 'base\n'); await git(project, 'add', 'shared.txt'); await git(project, 'commit', '-q', '-m', 'base');
  const base = await git(project, 'rev-parse', 'HEAD');
  await exec('/usr/bin/git', ['clone', '-q', project, target]);
  await git(target, 'config', 'user.email', 'target@example.invalid'); await git(target, 'config', 'user.name', 'Target');
  await git(target, 'branch', 'dogfood/adopted', base); await git(target, 'checkout', '-q', '--detach', base);
  const template = fixtureDockerRegistry(['x']).profiles[0]!;
  const parameters = { ...template.parameters, imageId: process.env.DECKENT_TEST_DOCKER_IMAGE! };
  const profiles = Object.entries(WORKERS).map(([kind, script]) => ({ ...template, id: `fixture-${kind}`, parameters: { ...parameters, argv: ['node', '-e', script] } }));
  const registry = { ...fixtureDockerRegistry([]), profiles, kinds: Object.keys(WORKERS).map(kind => ({ kind, profile: { id: `fixture-${kind}`, version: 1 } })) };
  const { argv: _argv, ...bounds } = parameters; void _argv;
  const options = { env: { HOME: join(root, 'home') } };
  // Production shape: runRuntime is present (the shipped default polls every second); targetQueue keeps its shipped verification timeout and
  // TTL. Only the collection window is widened so both enqueues form one FIFO prefix, and the toolchain refresh is off (no network here).
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, artifacts: { maxBytes: 16_777_216 },
    admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry },
    execution: { docker: { executable: '/usr/bin/docker', ...bounds }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 },
      adoption: { targets: [TARGET], verification: { kind: 'verify', required: true, criteria: [{ evaluator: criterion.evaluator, parameters: criterion.parameters }] } },
      workTargets: { schemaVersion: 1, targets: [{ id: 'n1', kind: 'git', path: target, baseRef: TARGET }] } },
    runRuntime: { pollIntervalMs: 250, failureBackoffMs: 1000 },
    // Both enqueues share one window; the lease (the re-attempt scan's backoff cap) is shortened so a waiting scan re-checks within seconds.
    targetQueue: { batchWindowMs: 4000, leaseMs: 15000 },
    toolchains: { update: { atStartup: false, intervalMs: 0 } },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
    cancellationRuntime: { scopeIds: [SCOPE], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 65536, responseMaxBytes: 1_048_576, maxConnections: 8, maxConcurrentRequests: 4, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 } }));
  const opened = await openConfiguredAttemptStore(project, options);
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); opened.store.close();
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'queue-reattempt', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: [SCOPE], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: [SCOPE], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: attemptActions, scopes: [SCOPE], principals, resource: { kind: 'attempt', ids: 'all' } },
    { id: 'target', effect: 'allow', actions: ['use', 'adopt'], scopes: [SCOPE], principals, resource: { kind: 'work-target', ids: ['n1'] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: [SCOPE], principals, resource: { kind: 'scope', ids: [SCOPE] } },
  ] }), { mode: 0o600 });
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

describe.skipIf(process.platform !== 'linux' || !process.env['DECKENT_TEST_DOCKER_IMAGE'])('delivery re-attempt after the target base advanced (alpha.47 S5b)', () => {
  it('two independent tasks edit the same file: the second is re-attempted once on the adopted base by the service and both land through the owner\'s cards', { timeout: 900_000 }, async () => {
    const f = await fixture();
    const attempts = [await f.coding('r1', 'append-first'), await f.coding('r2', 'append-second')];
    const reattempt = reattemptCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: 'q2' } } as never);
    const verificationRuns = ['q1', reattempt.ticket].map(ticket => queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: ticket } } as never).verificationRun);
    for (const runId of [...verificationRuns, reattempt.run]) cleanup.push(() => f.release(runId));
    const progressed: string[] = [], notes: { source: string; code: string; runId?: string }[] = [];
    const service = await startConfiguredRuntimeService(f.project, { onPage() {}, onError() {},
      onRunProgression(query) { progressed.push(query.runId); },
      onRunProgressionError(query, error) { notes.push({ source: 'run-progression', code: error.code, ...(query ? { runId: query.runId } : {}) }); },
      onQueryFailure(event) { notes.push({ source: 'query', code: event.code }); },
    }, { env: f.options.env });
    cleanup.push(async () => { await service.stop(); await service.done; });
    const client = configuredTargetQueueTerminal(f.project, f.options).deliveryQueue;
    const view = async (commandId: string) => (await client.inspectTargetQueue({ schemaVersion: 1, scopeId: SCOPE, commandId })).record;
    for (const [index, ticket] of ['q1', 'q2'].entries())
      expect(await client.enqueueTargetQueue({ schemaVersion: 1, commandId: ticket, identity: attempts[index]!, target: { kind: 'git-ref', id: TARGET }, deliveryIntent: 'service-reattempt' }))
        .toMatchObject({ commandId: ticket, state: 'queued' });

    // The batch: q1 is verified and waits for the owner; q2 met q1's candidate on its path and is refused with nothing written.
    const first = await until(() => view('q1'), record => record?.state === 'awaiting-confirmation' || record?.state === 'settled' || record?.state === 'parked', 'q1 waits for cards', () => ({ notes, progressed }));
    expect(first).toMatchObject({ state: 'awaiting-confirmation', verification: { phase: 'accepted' } });
    // q2 is revalidated in the same service turn right after q1 reaches the cards; read it once that turn settled it.
    expect(await until(() => view('q2'), record => record?.state === 'settled', 'q2 settles', () => ({ notes, progressed }))).toMatchObject({ state: 'settled', outcome: 'conflict-needs-reattempt', reason: 'PATCH_BASE_ADVANCED',
      nextAction: 'wait-service', responsibility: 'service', reattempt: { state: 'waiting-base', count: 1, bound: 1, cause: 'PATCH_BASE_ADVANCED' } });
    // The live base has not moved (the owner has not adopted q1), so no re-attempt Run exists yet.
    await new Promise(resolve => setTimeout(resolve, 6000));
    expect(await f.loadRun(reattempt.run)).toBeNull();
    expect(await git(f.target, 'rev-parse', TARGET)).toBe(f.base);

    const adoptFirst = await cliInPty(f.project, f.options.env, ['task', 'integration-queue-confirm', '--scope', SCOPE, '--command-id', 'q1'],
      [['y/N: ', 'y\r'], ['Adopt the verified prefix', 'y\r', 'fresh'], ['Confirmed batch', '']]);
    expect(adoptFirst.status).toBe(0); expect(adoptFirst.output).toContain('Confirmed batch: 1 of');
    const h1 = await git(f.target, 'rev-parse', TARGET);
    expect(await git(f.target, 'show', `${h1}:shared.txt`)).toBe('base\nfirst');

    // The service re-runs q2's frozen Task once on the adopted base and enqueues it as the owner's service principal for the same cards.
    let probe: unknown = null;
    const second = await until(async () => { const rerun = await f.loadRun(reattempt.run), q2 = await view('q2');
      probe = { rerun: rerun && { state: rerun.state, progress: rerun.progress, bindings: rerun.bindings.map(row => row.observedKind) }, q2: q2?.reattempt };
      return view(reattempt.ticket); }, record => record?.state === 'awaiting-confirmation' || record?.state === 'settled' || record?.state === 'parked',
      're-attempt waits for cards', () => ({ notes, progressed, probe }), 600_000);
    expect(second).toMatchObject({ state: 'awaiting-confirmation', verification: { phase: 'accepted' }, nextAction: 'confirm-batch', responsibility: 'human' });
    const rerun = await f.loadRun(reattempt.run);
    expect(rerun?.graph.tasks).toEqual([{ id: 't', kind: 'append-second', dependencies: [], acceptanceCriteria: ['exit'] }]);
    expect(rerun?.progress.map(row => row.phase)).toEqual(['accepted']); expect(progressed).toContain(reattempt.run);
    expect(await view('q2')).toMatchObject({ reattempt: { state: 'enqueued', commandId: reattempt.ticket, runId: reattempt.run } });
    expect(second?.identity.runId).toBe(reattempt.run);
    expect(await git(f.target, 'rev-parse', TARGET)).toBe(h1); // nothing is written before the owner's cards

    const adoptSecond = await cliInPty(f.project, f.options.env, ['task', 'integration-queue-confirm', '--scope', SCOPE, '--command-id', reattempt.ticket],
      [['y/N: ', 'y\r'], ['Adopt the verified prefix', 'y\r', 'fresh'], ['Confirmed batch', '']]);
    expect(adoptSecond.status).toBe(0); expect(adoptSecond.output).toContain('Confirmed batch: 1 of');
    expect(await view(reattempt.ticket)).toMatchObject({ state: 'settled', outcome: 'adopted' });
    const h2 = await git(f.target, 'rev-parse', TARGET);
    expect(await git(f.target, 'rev-parse', `${h2}^`)).toBe(h1);
    expect(await git(f.target, 'show', `${h2}:shared.txt`)).toBe('base\nfirst\nsecond');
    expect(notes).toEqual([]);
  });
});
