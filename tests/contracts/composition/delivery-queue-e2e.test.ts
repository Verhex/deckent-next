import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateTask, prepareConfiguredWorkspacePatch } from '../../../src/index.js';
import { configuredTargetQueueTerminal } from '../../../src/composition/core/runtime-service/index.js';
import { executeConfiguredTask } from '../../../src/composition/core/execution/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '../../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { DockerSupervisor } from '#adapters/index.js';
import { queueCommandIds, type TargetQueueView } from '#engine/index.js';
import type { AttemptIdentity } from '#domain/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
import { DRIVER, type Step } from '../support/pty-steps.js';
import { startTestRuntimeService, stopTestRuntimeService } from '../support/runtime-service.js';

// TESLIM-KUYRUGU phase 2 proof at the real boundary: a live project repository runs the installation; its registered work target is an
// independent clone whose base branch is the (unprotected) queue target. Four coding Runs execute in Docker from the same base H0 and each
// leaves an accepted Attempt with a stored patch. Three with disjoint paths are queued through the real runtime service; the service prepares
// C1 = H0 + P1, C2 = C1 + P2, C3 = C2 + P3 and admits a normal verification Run on each exact candidate, which this test executes and
// evaluates through the ordinary Run applications. The batch is then confirmed by the shipped CLI on its own controlling PTY (the product's
// terminal confirmation port: one publication card and one adoption card for the whole batch), after a first answer of n that writes
// nothing. A fourth Attempt whose path overlaps the adopted prefix ends as conflict-needs-reattempt with nothing written to the target.
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
/** Each coding kind writes one file; `overlap` writes a.txt again, the path the first delivery added. `verify` reads every queued path it can. */
const WORKERS: Readonly<Record<string, string>> = {
  'write-a': "require('node:fs').writeFileSync('a.txt','first\\n')",
  'write-b': "require('node:fs').writeFileSync('b.txt','second\\n')",
  'write-c': "require('node:fs').writeFileSync('c.txt','third\\n')",
  overlap: "require('node:fs').writeFileSync('a.txt','overlapping\\n')",
  verify: "require('node:fs').accessSync('a.txt')",
};

/** Every reference, HEAD, index and config of a repository: equal digests mean nothing Deckent writes reached it. */
async function repositoryDigest(repository: string) {
  const refs = await git(repository, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)');
  const head = await git(repository, 'rev-parse', 'HEAD'), worktrees = await git(repository, 'worktree', 'list', '--porcelain');
  const files = await Promise.all(['index', 'config'].map(name => readFile(join(repository, '.git', name))));
  return createHash('sha256').update(JSON.stringify({ refs, head, worktrees })).update(files[0]!).update(files[1]!).digest('hex');
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dn-queue-e2e-')); roots.push(root);
  const project = join(root, 'project'), target = join(root, 'target'), data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await git(project, 'init', '-q'); await git(project, 'config', 'user.email', 'live@example.invalid'); await git(project, 'config', 'user.name', 'Live');
  await writeFile(join(project, 'note.txt'), 'before\n'); await git(project, 'add', 'note.txt'); await git(project, 'commit', '-q', '-m', 'base');
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
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, artifacts: { maxBytes: 16_777_216 },
    admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry },
    execution: { docker: { executable: '/usr/bin/docker', ...bounds }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 },
      // The installation's adoption bar (a `verify` Run on the exact candidate) is added to each Task's own criterion.
      adoption: { targets: [TARGET], verification: { kind: 'verify', required: true, criteria: [{ evaluator: criterion.evaluator, parameters: criterion.parameters }] } },
      workTargets: { schemaVersion: 1, targets: [{ id: 'n1', kind: 'git', path: target, baseRef: TARGET }] } },
    // Three enqueues land inside one collection window, so they form one FIFO prefix of one epoch.
    targetQueue: { batchWindowMs: 4000 },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
    cancellationRuntime: { scopeIds: [SCOPE], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 65536, responseMaxBytes: 1_048_576, maxConnections: 8, maxConcurrentRequests: 4, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 } }));
  const opened = await openConfiguredAttemptStore(project, options);
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); opened.store.close();
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'queue-e2e', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: [SCOPE], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: [SCOPE], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: attemptActions, scopes: [SCOPE], principals, resource: { kind: 'attempt', ids: 'all' } },
    { id: 'target', effect: 'allow', actions: ['use', 'adopt'], scopes: [SCOPE], principals, resource: { kind: 'work-target', ids: ['n1'] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: [SCOPE], principals, resource: { kind: 'scope', ids: [SCOPE] } },
  ] }), { mode: 0o600 });
  const runRevision = async (runId: string) => {
    const store = await openConfiguredAttemptStore(project, options);
    try { return (await store.store.loadRun(SCOPE, runId))?.revision ?? null; } finally { store.store.close(); }
  };
  /** The normal Run path: reserve, execute in Docker, evaluate. Returns the accepted Attempt identity. */
  const execute = async (runId: string) => {
    const identity = (await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: SCOPE, runId, commandId: `reserve-${runId}`, expectedRevision: 0 }, options)).reservation.identities[0]!;
    cleanup.push(async () => {
      const store = await openConfiguredAttemptStore(project, options);
      try { const record = await store.store.loadBoundDispatch(identity);
        if (record) { const supervisor = await DockerSupervisor.restoreProfile(record.profile); await supervisor.cancel(record.request); await supervisor.release(record.request); } }
      finally { store.store.close(); }
    });
    expect((await executeConfiguredTask(project, identity, options)).execution.terminal?.exitCode).toBe(0);
    return identity;
  };
  const evaluate = async (runId: string, identity: AttemptIdentity) => {
    const evaluated = await evaluateTask(project, { schemaVersion: 1, commandId: `evaluation-${runId}`, identity, expectedRevision: (await runRevision(runId))! }, options);
    expect(evaluated.evaluation.run.tasks[0]!.phase).toBe('accepted');
  };
  /** A coding Run on H0 whose accepted Attempt carries a prepared patch (the queue's admission input). */
  const coding = async (runId: string, kind: string) => {
    await createConfiguredRun(project, { schemaVersion: 1, scopeId: SCOPE, runId, commandId: `create-${runId}`, graph: graph(kind) }, options);
    const identity = await execute(runId);
    await prepareConfiguredWorkspacePatch(project, identity, options);
    await evaluate(runId, identity);
    return identity;
  };
  return { root, project, target, data, base, options, coding, execute, evaluate, runRevision };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/** The shared PTY driver, except that a step whose text arrived together with the program's exit is met (the CLI prints its result and ends). */
const CLI_DRIVER = DRIVER.replace('if time.time() > deadline or not read_for(0.1):', 'if time.time() > deadline or (not read_for(0.1) and wait.encode() not in out[since:]):');
/** The shipped CLI on its own controlling PTY (python `pty`), typing each step's keys once its text is shown. */
async function cliInPty(project: string, env: NodeJS.ProcessEnv, args: readonly string[], steps: readonly Step[]) {
  const argv = [process.execPath, resolve('dist/composition/core/cli/internal/entry.js'), ...args];
  const { stdout } = await exec('python3', ['-c', CLI_DRIVER, JSON.stringify(argv), JSON.stringify(steps), 'tty'],
    { cwd: project, env: { ...process.env, ...env }, timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  const result = JSON.parse(stdout) as { status?: number | string; timeout?: string; output: string };
  if (result.timeout) throw new Error(`waited for ${JSON.stringify(result.timeout)}\n${result.output.slice(-6000)}`);
  expect(CLI_DRIVER).not.toBe(DRIVER);
  return { ...result, output: stripVTControlCharacters(result.output) };
}

describe.skipIf(process.platform !== 'linux' || !process.env['DECKENT_TEST_DOCKER_IMAGE'])('delivery queue end to end: real Git, Docker Runs, runtime service and terminal', () => {
  it('three disjoint deliveries are re-prepared on the advancing head and adopted after one publication and one adoption card; an overlapping fourth is conflict-needs-reattempt with nothing written', { timeout: 900_000 }, async () => {
    const f = await fixture();
    const liveBefore = await repositoryDigest(f.project), targetHead = await git(f.target, 'rev-parse', 'HEAD');
    // Four accepted Attempts, all made on H0 (the base branch tip before anything is adopted).
    const attempts = [await f.coding('r1', 'write-a'), await f.coding('r2', 'write-b'), await f.coding('r3', 'write-c'), await f.coding('r4', 'overlap')];
    expect(await git(f.target, 'rev-parse', TARGET)).toBe(f.base);

    const service = await startTestRuntimeService(f.project, f.options.env);
    cleanup.push(() => stopTestRuntimeService(service));
    const client = configuredTargetQueueTerminal(f.project, f.options).deliveryQueue;
    const view = async (commandId: string) => (await client.inspectTargetQueue({ schemaVersion: 1, scopeId: SCOPE, commandId })).record;
    const enqueue = (commandId: string, identity: AttemptIdentity) => client.enqueueTargetQueue({ schemaVersion: 1, commandId, identity, target: { kind: 'git-ref', id: TARGET } });
    // Every reference (branches, deliveries, the queue generation fence), the object store, HEAD and the checkout.
    const written = async () => ({ refs: await git(f.target, 'for-each-ref', '--format=%(refname) %(objectname)'), objects: await git(f.target, 'count-objects', '-v'),
      head: await git(f.target, 'rev-parse', 'HEAD'), status: await git(f.target, 'status', '--porcelain') });
    const quiet = await written(); // first activation: no queue generation exists yet
    const tickets = ['q1', 'q2', 'q3'];
    for (const [index, ticket] of tickets.entries()) expect(await enqueue(ticket, attempts[index]!)).toMatchObject({ commandId: ticket, state: 'queued' });

    // Each candidate gets its own normal verification Run on the exact candidate commit; it is executed and evaluated like any Run.
    for (const ticket of tickets) {
      const runId = queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: ticket } } as never).verificationRun;
      await until(() => f.runRevision(runId), revision => revision !== null, `${ticket} verification Run admitted`);
      expect((await view(ticket))?.state).toBe('verifying');
      await f.evaluate(runId, await f.execute(runId));
      await until(() => view(ticket), record => record?.state === 'awaiting-confirmation', `${ticket} awaiting confirmation`);
    }
    // Admission, real re-preparation and the verification Runs wrote nothing to the target before the human answered (Astra 2607 F2).
    expect(await git(f.target, 'rev-parse', TARGET)).toBe(f.base); expect(await written()).toEqual(quiet);

    // The human declines the publication card on the real terminal: no consent, no write, the tickets keep waiting for a fresh card.
    const declined = await cliInPty(f.project, f.options.env, ['task', 'integration-queue-confirm', '--scope', SCOPE, '--command-id', 'q1'],
      [['y/N: ', 'n\r'], ['No valid consent covers this exact batch', '']]);
    expect(declined.status).not.toBe(0);
    expect(await written()).toEqual(quiet);
    for (const ticket of tickets) expect((await view(ticket))?.state).toBe('awaiting-confirmation');

    // The shipped CLI on a real controlling terminal: one exact publication card, then one exact adoption card, for the whole batch.
    const confirmed = await cliInPty(f.project, f.options.env, ['task', 'integration-queue-confirm', '--scope', SCOPE, '--command-id', 'q1'],
      [['y/N: ', 'y\r'], ['Adopt the verified prefix', 'y\r', 'fresh'], ['Queue result', '']]);
    expect(confirmed.status).toBe(0);
    expect(confirmed.output).toContain('Publish delivery references');
    expect(confirmed.output.match(/Exact batch: [a-f0-9]{64}/gu)).toHaveLength(2);
    expect(confirmed.output.match(/Items: 3/gu)).toHaveLength(2);
    for (const ticket of tickets) expect(confirmed.output).toContain(`Ticket ${ticket}`);
    expect(confirmed.output).toContain('"settledPrefix":3');

    // Outcomes: the first candidate sat on H0; the second and third were prepared on the head the prefix advanced to.
    const settled = await Promise.all(tickets.map(view)) as TargetQueueView[];
    expect(settled.map(record => [record.state, record.outcome])).toEqual([['settled', 'adopted'], ['settled', 're-prepared+adopted'], ['settled', 're-prepared+adopted']]);
    const c3 = await git(f.target, 'rev-parse', TARGET), c2 = await git(f.target, 'rev-parse', `${c3}^`), c1 = await git(f.target, 'rev-parse', `${c2}^`);
    expect(await git(f.target, 'rev-parse', `${c1}^`)).toBe(f.base);
    expect(await git(f.target, 'rev-list', '--count', `${f.base}..${c3}`)).toBe('3');
    for (const [commit, files] of [[c1, ['a.txt', 'note.txt']], [c2, ['a.txt', 'b.txt', 'note.txt']], [c3, ['a.txt', 'b.txt', 'c.txt', 'note.txt']]] as const)
      expect((await git(f.target, 'ls-tree', '--name-only', commit)).split('\n').sort()).toEqual(files);
    // Each adopted commit was published first at its own create-only delivery reference.
    const deliveries = (await git(f.target, 'for-each-ref', '--format=%(objectname)', 'refs/deckent/deliveries/')).split('\n').filter(Boolean).sort();
    expect(deliveries).toEqual([c1, c2, c3].sort());
    // The live project and the target checkout are untouched; only the registered base branch moved.
    expect(await repositoryDigest(f.project)).toBe(liveBefore);
    expect(await git(f.target, 'rev-parse', 'HEAD')).toBe(targetHead);

    // The fourth Attempt (made on H0) writes a.txt, which the adopted prefix added: no automatic merge, a typed reattempt outcome.
    const before = await written();
    expect(await enqueue('q4', attempts[3]!)).toMatchObject({ commandId: 'q4', state: 'queued' });
    const fourth = await until(() => view('q4'), record => record?.state === 'settled', 'q4 settled');
    expect(fourth?.outcome).toBe('conflict-needs-reattempt');
    const q4Ids = queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: 'q4' } } as never);
    expect(await f.runRevision(q4Ids.verificationRun)).toBeNull();
    expect(fourth?.nextAction).toBe('new-attempt');
    expect(await written()).toEqual(before); expect(await git(f.target, 'rev-parse', TARGET)).toBe(c3);
    expect(await repositoryDigest(f.project)).toBe(liveBefore);
  });
});
