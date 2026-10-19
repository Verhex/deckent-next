import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerCommandFailure, DockerSupervisor, FileArtifactStore, openSqliteAttemptStore, runNodeDockerCommand, type DockerCommandRunner, type SqliteAttemptStore } from '#adapters/index.js';
import { DispatchApplication, TaskEvaluationApplication } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyOrDockerProfiles } from '../support/custody.js';

/** Astra 2642 F1: the interrupt cause is the FIRST stop, fixed where the supervisor decides it, through the real producer path. */
const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const node = process.execPath;

describe.skipIf(process.platform === 'win32')('the command boundary fixes which bound stopped the process first', () => {
  it('deadline only: stop = deadline', async () => {
    const error = await runNodeDockerCommand({ executable: node, args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 150, outputBytes: 4096 }, new AbortController().signal).catch(value => value);
    expect(error).toBeInstanceOf(DockerCommandFailure); expect(error).toMatchObject({ killed: true, stop: 'deadline' });
  });
  it('signal first: stop = signal with its reason; the later deadline cannot replace it', async () => {
    const controller = new AbortController(); setTimeout(() => controller.abort('inactivity'), 50);
    const error = await runNodeDockerCommand({ executable: node, args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 400, outputBytes: 4096 }, controller.signal).catch(value => value);
    await sleep(500);
    expect(error).toMatchObject({ killed: true, stop: 'signal', stopReason: 'inactivity' });
  });
  it('a natural non-zero exit is no stop, even when the signal aborts right after', async () => {
    const controller = new AbortController();
    const error = await runNodeDockerCommand({ executable: node, args: ['-e', 'process.exit(3)'], timeoutMs: 5000, outputBytes: 4096 }, controller.signal).catch(value => value);
    controller.abort('inactivity');
    expect(error).toMatchObject({ code: 3, killed: false, stop: null });
  });
});

describe.skipIf(process.platform === 'win32' || !imageId)('real Docker producer path: a later watchdog abort never relabels a deadline stop', () => {
  const roots: string[] = [], stores: SqliteAttemptStore[] = [];
  afterEach(async () => { vi.restoreAllMocks(); stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  const principal = { id: 'user', issuer: 'test', subject: 'user', assurance: 'os-user' as const, scopeIds: ['s'] };
  const verifier = { async verify() { return principal; } }, authorization = { async authorize() {} };
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
    criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify fixture task', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
  async function produce(order: 'deadline-then-abort-in-cleanup' | 'deadline-then-abort-in-retention' | 'inactivity-first') {
    const root = await mkdtemp(join(tmpdir(), 'deckent-stall-cause-')); roots.push(root);
    await mkdir(join(root, 'workspace')); await mkdir(join(root, 'artifacts'), { mode: 0o700 });
    const store = await openSqliteAttemptStore(join(root, 'ledger.db'), { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyOrDockerProfiles); stores.push(store);
    const identity = { runId: 'r', taskId: 't', attemptId: randomUUID(), scopeId: 's', generation: 1, layoutRevision: 'l' };
    const base = fixtureExecution(graph), actor = { id: 'user', issuer: 'test', subject: 'user' };
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
    await store.createRun({ commandId: 'create', actor, identity: { runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, now: 0, policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] },
      execution: { ...base, tasks: base.tasks.map(task => ({ ...task, stall: { warnAfterMs: 1000, stopAfterMs: 2000, maxRetries: 1 } })) } });
    await store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 's', runId: 'r', expectedRevision: 0, now: 0, identities: [identity] });
    const controller = new AbortController(), commands: string[] = [];
    // Cleanup delay: the watchdog fires while the supervisor kills/inspects the container after its own deadline.
    const runner: DockerCommandRunner = async (command, signal) => {
      commands.push(command.args.find(arg => ['start', 'kill'].includes(arg)) ?? '');
      if (order === 'deadline-then-abort-in-cleanup' && command.args.includes('kill')) { controller.abort('inactivity'); await sleep(300); }
      return runNodeDockerCommand(command, signal);
    };
    const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
      logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: order === 'inactivity-first' ? 30000 : 2500, controlTimeoutMs: 10000, outputBytes: 65536 }, runner);
    const artifacts = new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 1048576 });
    if (order === 'deadline-then-abort-in-retention') {
      // Retention delay: the watchdog fires while the dispatch retains the (partial) output of a deadline stop.
      const put = artifacts.put.bind(artifacts);
      vi.spyOn(artifacts, 'put').mockImplementation(async (...args: Parameters<typeof put>) => { controller.abort('inactivity'); await sleep(300); return put(...args); });
    }
    if (order === 'inactivity-first') setTimeout(() => controller.abort('inactivity'), 2000);
    const request = { protocolVersion: 1 as const, identity, workspace: join(root, 'workspace'), argv: ['node', '-e', 'setTimeout(() => {}, 60000)'] };
    const app = new DispatchApplication(store, supervisor, verifier, authorization, 'p', artifacts);
    try {
      const outcome = await app.execute(request, undefined, controller.signal);
      expect(controller.signal.aborted).toBe(true);
      const evaluation = new TaskEvaluationApplication(store, verifier, authorization, { evaluate: vi.fn(async () => 'pass' as const) }, artifacts, { maxEvidenceItems: 1, maxTotalBytes: 1048576 },
        { now: Date.now, timeoutMs: 86400000 }, undefined, undefined, undefined, { backoffMs: 0, effects: () => 'workspace-only' });
      const receipt = await evaluation.execute({ schemaVersion: 1, identity, commandId: 'evaluate', expectedRevision: (await store.loadRun('s', 'r'))!.revision });
      return { outcome, run: receipt.snapshot, commands };
    } finally { await supervisor.release(request).catch(() => undefined); }
  }
  it.each(['deadline-then-abort-in-cleanup', 'deadline-then-abort-in-retention'] as const)('%s: the record stays deadline and no new Attempt is created', async order => {
    const { outcome, run, commands } = await produce(order);
    expect(outcome.record.terminal).toMatchObject({ interrupted: true, interruptCause: 'deadline' });
    if (order === 'deadline-then-abort-in-cleanup') expect(commands).toContain('kill');
    expect(run.progress[0]).toMatchObject({ phase: 'awaiting-decision', decision: { reason: 'evaluation-not-ready' } });
    expect(run.previousBindings ?? []).toEqual([]); expect(run.bindings).toHaveLength(1);
  }, 60000);
  it('inactivity first: the bounded inactivity retry is preserved', async () => {
    const { outcome, run } = await produce('inactivity-first');
    expect(outcome.record.terminal).toMatchObject({ interrupted: true, interruptCause: 'inactivity' });
    expect(run.progress[0]).toMatchObject({ phase: 'pending' });
    expect(run.previousBindings?.[0]).toMatchObject({ observedKind: 'stalled', stallCause: 'inactivity' }); expect(run.bindings).toEqual([]);
  }, 60000);
});
