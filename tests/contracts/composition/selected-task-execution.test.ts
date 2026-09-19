import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { createRun, executeTask, evaluateTask, inspectRun, reserveRunTasks } from '../../../src/index.js';
import { openConfiguredExecution } from '../../../src/composition/core/execution/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { DockerSupervisor } from '#adapters/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
import { startTestRuntimeService } from '../support/runtime-service.js';

const exec = promisify(execFile); const roots: string[] = [];
const dockerEnabled = process.platform === 'linux' && !!process.env.DECKENT_TEST_DOCKER_IMAGE;
const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE!;

afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(execute = true, twoTasks = false) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-selected-task-')); roots.push(root);
  const project = join(root, 'project'); const data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', project, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(project, 'input'), 'base\n'); await git('add', 'input'); await git('commit', '-m', 'base');
  await writeFile(join(project, 'input'), 'owner-wip\n');
  const registry = fixtureDockerRegistry(['selected']); registry.profiles[0]!.parameters = { ...registry.profiles[0]!.parameters,
    imageId, argv: ['node', '-e', "process.stdout.write(require('node:fs').readFileSync('/workspace/input','utf8'))"] };
  const configPath = join(project, '.deckent/config.json'); const options = { env: { HOME: join(root, 'home') } };
  await writeFile(configPath, JSON.stringify({ layout: { root: data }, artifacts: { maxBytes: 65536 }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry },
    execution: { docker: { executable: '/usr/bin/docker', imageId, memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 },
      git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  const opened = await openConfiguredAttemptStore(project, options); await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); opened.store.close();
  const os = userInfo(); const principals = [{ issuer: hostname(), subject: String(os.uid) }];
  const policy = async (allowExecute: boolean) => writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: allowExecute ? 'allow' : 'deny', restrictions: [], grants: [
    { id: 'create', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    ...(allowExecute ? [{ id: 'execute', effect: 'allow', actions: ['execute', 'evaluate'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } }] : []),
  ] }), { mode: 0o600 });
  await policy(execute);
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'selected', dependencies: [], acceptanceCriteria: ['exit'] },
    ...(twoTasks ? [{ id: 't2', kind: 'selected', dependencies: ['t'], acceptanceCriteria: ['exit'] }] : [])],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  const graphPath = join(root, 'graph.json'); await writeFile(graphPath, JSON.stringify(graph));
  await startTestRuntimeService(project, options.env);
  return { root, project, data, configPath, options, graph, graphPath, layout: opened.layout, policy };
}

type Identity = { scopeId: string; runId: string; taskId: string; attemptId: string; generation: number; layoutRevision: string };
type PublicMode = 'sdk' | 'mcp' | 'cli';
type PublicResult = Awaited<ReturnType<typeof reserveRunTasks>>;
async function cliCall<T>(f: Awaited<ReturnType<typeof fixture>>, args: readonly string[]) {
  try {
    const result = await exec(process.execPath, [resolve('dist/composition/core/cli/internal/entry.js'), ...args],
      { cwd: f.project, env: { ...process.env, ...f.options.env }, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    const failure = error as { code?: number; stderr?: string; stdout?: string };
    expect(failure.code).toBe(1); expect(failure.stdout).toBe('');
    const result = JSON.parse(failure.stderr!);
    throw Object.assign(new Error(result.code), { code: result.code });
  }
}

async function reserveThroughPublicSurface(mode: PublicMode, f: Awaited<ReturnType<typeof fixture>>) {
  const transport = mode === 'mcp' ? new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/composition/core/mcp/internal/entry.js'), '--project', f.project], env: f.options.env, stderr: 'pipe' }) : null;
  const client = transport ? new Client({ name: 'selected-task-execution', version: '1' }) : null;
  try {
    if (client) await client.connect(transport!);
    const create = { schemaVersion: 1 as const, commandId: 'create', scopeId: 's', runId: 'r', graph: f.graph };
    const reserve = { schemaVersion: 1 as const, commandId: 'reserve', scopeId: 's', runId: 'r', expectedRevision: 0 };
    const call = async <T>(name: string, args: object): Promise<T> => {
      const result = await client!.callTool({ name, arguments: args });
      if (result.isError) throw new Error(JSON.stringify(result));
      return result.structuredContent as T;
    };
    if (client) await call('create_run', create);
    else if (mode === 'cli') await cliCall(f, ['run', 'create', '--scope', 's', '--id', 'r', '--command-id', 'create', '--graph', f.graphPath, '--json']);
    else await createRun(f.project, create, f.options);
    const observedBeforeMs = Date.now();
    const first = await (async () => client ? (await call<PublicResult>('reserve_run_tasks', reserve)).reservation
      : mode === 'cli' ? (await cliCall<PublicResult>(f, ['run', 'reserve', '--scope', 's', '--id', 'r', '--command-id', 'reserve', '--expected-revision', '0', '--json'])).reservation
      : (await reserveRunTasks(f.project, reserve, f.options)).reservation)().catch(async (error: unknown) => {
        const observedAfterMs = Date.now();
        const failure = error as { code?: string; params?: Record<string, unknown> };
        const diagnostic = Object.fromEntries(['site', 'reason', 'now', 'eligibilityGapMs', 'readyCount', 'delayedCount']
          .flatMap(key => { const value = failure.params?.[key]; return typeof value === 'string' || typeof value === 'number' ? [[key, value]] : []; }));
        let evidence: unknown;
        try {
          const runtime = await openConfiguredAttemptStore(f.project, f.options);
          try {
            const snapshot = await runtime.store.loadRun('s', 'r');
            const receipt = await runtime.store.loadRunReceipt('s', 'create');
            evidence = { before: receipt && { revision: receipt.snapshot.revision, progress: receipt.snapshot.progress },
              after: snapshot && { revision: snapshot.revision, progress: snapshot.progress } };
          } finally { runtime.store.close(); }
        } catch { evidence = { captureFailed: true }; }
        throw new Error(`FIRST_RESERVATION_FIXTURE_EVIDENCE ${JSON.stringify({ observedBeforeMs, observedAfterMs, code: failure.code, diagnostic, evidence })}`, { cause: error });
      });
    const replay = client ? (await call<PublicResult>('reserve_run_tasks', reserve)).reservation
      : mode === 'cli' ? (await cliCall<PublicResult>(f, ['run', 'reserve', '--scope', 's', '--id', 'r', '--command-id', 'reserve', '--expected-revision', '0', '--json'])).reservation
      : (await reserveRunTasks(f.project, reserve, f.options)).reservation;
    expect(replay.identities).toEqual(first.identities);
    expect(first.identities).toHaveLength(1);
    return { client, transport, mode, identity: first.identities[0] as Identity };
  } catch (error) {
    try { await client?.close(); } finally { await transport?.close(); }
    throw error;
  }
}

describe.skipIf(!dockerEnabled)('selected task execution', () => {
  it.each(['sdk', 'mcp', 'cli'] as const)('executes the pinned profile in a detached Git base through %s, evaluates it, and replays without current execution settings', async mode => {
    const f = await fixture(); const publicSurface = await reserveThroughPublicSurface(mode, f); const identity = publicSurface.identity;
    const runtime = await openConfiguredExecution(f.project, f.project, f.options); let record: Awaited<ReturnType<typeof runtime.store.loadBoundDispatch>> = null;
    let lease: Awaited<ReturnType<typeof runtime.workspaces.openRecorded>> = null;
    const { transport, client } = publicSurface;
    const execute = async () => {
      if (!client && mode === 'cli') return cliCall<Awaited<ReturnType<typeof executeTask>>>(f, ['task', 'execute', '--scope', identity.scopeId, '--run', identity.runId,
        '--task', identity.taskId, '--attempt', identity.attemptId, '--generation', String(identity.generation), '--layout-revision', identity.layoutRevision, '--json']);
      if (!client) return executeTask(f.project, identity, f.options);
      const result = await client.callTool({ name: 'execute_task', arguments: identity });
      if (result.isError) {
        const text = (result.content as { type: string; text?: string }[]).find(value => value.type === 'text')!.text!;
        const code = JSON.parse(text).code; throw Object.assign(new Error(code), { code });
      }
      return result.structuredContent as Awaited<ReturnType<typeof executeTask>>;
    };
    const evaluate = async (command: { schemaVersion: 1; commandId: string; identity: typeof identity; expectedRevision: number }) => {
      if (!client && mode === 'cli') return cliCall<Awaited<ReturnType<typeof evaluateTask>>>(f, ['task', 'evaluate', '--scope', identity.scopeId, '--run', identity.runId,
        '--task', identity.taskId, '--attempt', identity.attemptId, '--generation', String(identity.generation), '--layout-revision', identity.layoutRevision,
        '--command-id', command.commandId, '--expected-revision', String(command.expectedRevision), '--json']);
      if (!client) return evaluateTask(f.project, command, f.options);
      const result = await client.callTool({ name: 'evaluate_task', arguments: command });
      if (result.isError) {
        const text = (result.content as { type: string; text?: string }[]).find(value => value.type === 'text')!.text!;
        const code = JSON.parse(text).code; throw Object.assign(new Error(code), { code });
      }
      return result.structuredContent as Awaited<ReturnType<typeof evaluateTask>>;
    };
    try {
      if (client) {
        expect(JSON.stringify(await client.callTool({ name: 'execute_task', arguments: Object.assign({}, identity, { argv: ['caller'] }) }))).toContain('MCP_INPUT_INVALID');
        expect(JSON.stringify(await client.callTool({ name: 'evaluate_task', arguments: { schemaVersion: 1, commandId: 'evaluate', identity, expectedRevision: 2, verdict: 'accepted' } }))).toContain('MCP_INPUT_INVALID');
      }
      const changed = JSON.parse(await readFile(f.configPath, 'utf8'));
      changed.admission.registry.profiles[0].parameters.argv = ['node', '-e', "process.stdout.write('current-config')"];
      changed.admission.registry.profiles[0].parameters.imageId = 'sha256:' + 'b'.repeat(64);
      changed.execution.docker = { ...changed.execution.docker, imageId: 'sha256:' + 'c'.repeat(64), memoryBytes: 536870912 };
      await writeFile(f.configPath, JSON.stringify(changed)); clearConfigCache();
      const first = await execute();
      expect(first.execution).toMatchObject({ status: 'terminal', terminal: { exitCode: 0 }, outputRecorded: true });
      expect(await executeTask(f.project, identity, f.options)).toEqual(first);
      const command = { schemaVersion: 1 as const, commandId: 'evaluate', identity, expectedRevision: 2 };
      const evaluated = await evaluate(command);
      expect(evaluated.evaluation.run.tasks[0]!.phase).toBe('accepted');
      expect(await evaluateTask(f.project, command, f.options)).toEqual(evaluated);
      expect(JSON.stringify({ first, evaluated })).not.toContain('argv');
      expect(JSON.stringify({ first, evaluated })).not.toContain('/workspace');
      expect(JSON.stringify({ first, evaluated })).not.toContain('base\\n');
      const store = await openConfiguredAttemptStore(f.project, f.options);
      try { record = (await store.store.loadBoundDispatch(identity))!; } finally { store.store.close(); }
      const output = JSON.parse(new TextDecoder().decode(await runtime.artifacts.read('s', record.output!)));
      expect(output.stdout).toBe('base\n'); expect(output.stdout).not.toContain('owner-wip');
      lease = await runtime.workspaces.openRecorded(identity);
      const replayConfig = JSON.parse(await readFile(f.configPath, 'utf8')); delete replayConfig.execution; await writeFile(f.configPath, JSON.stringify(replayConfig)); clearConfigCache();
      expect(await execute()).toEqual(first);
      await f.policy(false);
      await expect(execute()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    } finally {
      try {
        record ??= await runtime.store.loadBoundDispatch(identity);
        if (record) {
          const supervisor = await DockerSupervisor.restoreProfile(record.profile);
          await supervisor.release(record.request);
        }
      } finally {
        try {
          lease ??= await runtime.workspaces.openRecorded(identity);
          if (lease) await runtime.workspaces.release({ schemaVersion: 1, identity: lease.identity, baseCommit: lease.baseCommit });
        } finally {
          runtime.store.close();
          await client?.close(); await transport?.close();
        }
      }
    }
  }, 30000);
});

describe.skipIf(!dockerEnabled)('selected task cross-surface and custody', () => {
  it('shares one accepted Run across compiled CLI and real stdio MCP with exact artifact and receipt identity', async () => {
    const f = await fixture();
    const publicSurface = await reserveThroughPublicSurface('cli', f); const identity = publicSurface.identity;
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [resolve('dist/composition/core/mcp/internal/entry.js'), '--project', f.project], env: f.options.env, stderr: 'pipe' });
    const client = new Client({ name: 'same-run-cross-surface', version: '1' });
    const runtime = await openConfiguredExecution(f.project, f.project, f.options);
    let record: Awaited<ReturnType<typeof runtime.store.loadBoundDispatch>> = null;
    let lease: Awaited<ReturnType<typeof runtime.workspaces.openRecorded>> = null;
    try {
      await client.connect(transport);
      const executeResult = await client.callTool({ name: 'execute_task', arguments: identity });
      expect(executeResult.isError).not.toBe(true);
      expect(executeResult.structuredContent).toMatchObject({ execution: { identity, status: 'terminal',
        terminal: { exitCode: 0 }, outputRecorded: true } });
      const command = { schemaVersion: 1, commandId: 'cross-evaluate', identity, expectedRevision: 2 };
      const evaluationResult = await client.callTool({ name: 'evaluate_task', arguments: command });
      expect(evaluationResult.isError).not.toBe(true);
      expect(evaluationResult.structuredContent).toMatchObject({ evaluation: { commandId: 'cross-evaluate',
        run: { scopeId: 's', runId: 'r', tasks: [{ id: 't', phase: 'accepted' }] } } });

      const inspected = await cliCall<Awaited<ReturnType<typeof inspectRun>>>(f,
        ['run', 'inspect', '--scope', 's', '--id', 'r', '--json']);
      expect(inspected.run).toEqual((evaluationResult.structuredContent as { evaluation: { run: unknown } }).evaluation.run);
      record = await runtime.store.loadBoundDispatch(identity);
      const output = JSON.parse(new TextDecoder().decode(await runtime.artifacts.read('s', record!.output!)));
      expect(output).toMatchObject({ schemaVersion: 1, identity, completeness: 'complete', stdout: 'base\n' });
      const receipt = await runtime.store.loadRunReceipt('s', 'cross-evaluate');
      expect(receipt?.snapshot.identity).toMatchObject({ scopeId: 's', runId: 'r' });
      expect(JSON.parse(receipt!.command)).toMatchObject({ action: 'apply-task-evaluation', commandId: 'cross-evaluate',
        evaluation: { identity }, dispatch: { request: { identity } } });
      lease = await runtime.workspaces.openRecorded(identity);
    } finally {
      try {
        record ??= await runtime.store.loadBoundDispatch(identity);
        if (record) await (await DockerSupervisor.restoreProfile(record.profile)).release(record.request);
      } finally {
        lease ??= await runtime.workspaces.openRecorded(identity);
        if (lease) await runtime.workspaces.release({ schemaVersion: 1, identity: lease.identity, baseCommit: lease.baseCommit });
        runtime.store.close(); await client.close().catch(() => undefined); await transport.close().catch(() => undefined);
      }
    }
  }, 30000);

  it('keeps a Run Git base fixed across sequential SDK reservations after source HEAD advances', async () => {
    const f = await fixture(true, true); const publicSurface = await reserveThroughPublicSurface('sdk', f); const firstIdentity = publicSurface.identity;
    const runtime = await openConfiguredExecution(f.project, f.project, f.options);
    let firstRecord: Awaited<ReturnType<typeof runtime.store.loadBoundDispatch>> = null;
    let secondRecord: Awaited<ReturnType<typeof runtime.store.loadBoundDispatch>> = null;
    let secondIdentity: Identity | null = null;
    const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', f.project, ...args])).stdout.trim();
    try {
      const first = await executeTask(f.project, firstIdentity, f.options);
      expect(first.execution).toMatchObject({ status: 'terminal', terminal: { exitCode: 0 }, outputRecorded: true });
      const firstEvaluation = await evaluateTask(f.project, { schemaVersion: 1, commandId: 'evaluate-first', identity: firstIdentity, expectedRevision: 2 }, f.options);
      expect(firstEvaluation.evaluation.run.tasks.find(task => task.id === 't')?.phase).toBe('accepted');
      const firstLease = await runtime.workspaces.openRecorded(firstIdentity);
      const firstBase = firstLease!.baseCommit;
      await git('add', 'input'); await git('commit', '-m', 'owner source update');
      const sourceHead = await git('rev-parse', 'HEAD'); expect(sourceHead).not.toBe(firstBase);
      const beforeReservation = await runtime.store.loadRun('s', 'r');
      const evaluationReceipt = await runtime.store.loadRunReceipt('s', 'evaluate-first');
      expect(beforeReservation?.revision).toBe(firstEvaluation.evaluation.run.revision);
      expect(beforeReservation?.progress).toEqual(evaluationReceipt?.snapshot.progress);
      expect(beforeReservation?.progress.find(task => task.taskId === 't')?.phase).toBe('accepted');
      const observedBeforeMs = Date.now();
      const next = await reserveRunTasks(f.project, { schemaVersion: 1, commandId: 'reserve-second', scopeId: 's', runId: 'r', expectedRevision: firstEvaluation.evaluation.run.revision }, f.options)
        .catch(async (error: unknown) => {
          // Fixture-only evidence. Do not mask the original failure with retry or infer a cause from a later snapshot.
          const afterReservation = await runtime.store.loadRun('s', 'r');
          const policy = await runtime.store.loadRunExecutionPolicy('s', 'r');
          throw new Error(`RESERVATION_FIXTURE_EVIDENCE ${JSON.stringify({ observedBeforeMs, observedAfterMs: Date.now(),
            expectedRevision: firstEvaluation.evaluation.run.revision,
            before: beforeReservation && { revision: beforeReservation.revision, progress: beforeReservation.progress },
            after: afterReservation && { revision: afterReservation.revision, progress: afterReservation.progress }, policy })}`, { cause: error });
        });
      secondIdentity = next.reservation.identities[0]!; expect(secondIdentity.taskId).toBe('t2');
      const second = await executeTask(f.project, secondIdentity, f.options);
      expect(second.execution).toMatchObject({ status: 'terminal', terminal: { exitCode: 0 }, outputRecorded: true });
      const secondEvaluation = await evaluateTask(f.project, { schemaVersion: 1, commandId: 'evaluate-second', identity: secondIdentity, expectedRevision: next.reservation.run.revision + 1 }, f.options);
      expect(secondEvaluation.evaluation.run.tasks.find(task => task.id === 't2')?.phase).toBe('accepted');
      const secondLease = await runtime.workspaces.openRecorded(secondIdentity);
      expect(secondLease!.baseCommit).toBe(firstBase);
      const store = await openConfiguredAttemptStore(f.project, f.options);
      try {
        firstRecord = await store.store.loadBoundDispatch(firstIdentity); secondRecord = await store.store.loadBoundDispatch(secondIdentity);
        expect((await store.store.loadRunWorkspaceCustody('s', 'r'))!.baseRevision).toBe(firstBase);
      } finally { store.store.close(); }
      const firstOutput = JSON.parse(new TextDecoder().decode(await runtime.artifacts.read('s', firstRecord!.output!)));
      const secondOutput = JSON.parse(new TextDecoder().decode(await runtime.artifacts.read('s', secondRecord!.output!)));
      expect(firstOutput.stdout).toBe('base\n'); expect(secondOutput.stdout).toBe('base\n');
      expect(secondOutput.stdout).not.toContain('owner-wip');
    } finally {
      for (const [record, identity] of [[firstRecord, firstIdentity], [secondRecord, secondIdentity]] as const) {
        if (record) { const supervisor = await DockerSupervisor.restoreProfile(record.profile); await supervisor.release(record.request); }
        const lease = identity ? await runtime.workspaces.openRecorded(identity) : null;
        if (lease) await runtime.workspaces.release({ schemaVersion: 1, identity: lease.identity, baseCommit: lease.baseCommit });
      }
      runtime.store.close(); await publicSurface.client?.close(); await publicSurface.transport?.close();
    }
  }, 30000);

  it('checks execute policy before allocating a workspace or dispatching', async () => {
    const f = await fixture(false); const publicSurface = await reserveThroughPublicSurface('sdk', f); const identity = publicSurface.identity;
    await expect(executeTask(f.project, identity, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(stat(productResourcePath(f.layout, 'workspaces'))).rejects.toMatchObject({ code: 'ENOENT' });
    const store = await openConfiguredAttemptStore(f.project, f.options);
    try { expect(await store.store.loadBoundDispatch(identity)).toBeNull(); } finally { store.store.close(); }
    await expect(executeTask(f.project, Object.assign({}, identity, { argv: ['caller'] }))).rejects.toThrow();
    await publicSurface.client?.close(); await publicSurface.transport?.close();
  });
});
