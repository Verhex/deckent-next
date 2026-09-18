import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openConfiguredExecution, executeConfiguredTask } from '../../../src/composition/core/execution/index.js';
import { createConfiguredRun, evaluateConfiguredTask } from '../../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { DockerSupervisor } from '#adapters/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

const exec = promisify(execFile); const roots: string[] = [];
const dockerEnabled = process.platform === 'linux' && !!process.env.DECKENT_TEST_DOCKER_IMAGE;
const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE!;

afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(execute = true) {
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
    { id: 'create', effect: 'allow', actions: ['create'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    ...(allowExecute ? [{ id: 'execute', effect: 'allow', actions: ['execute', 'evaluate'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: ['a'] } }] : []),
  ] }), { mode: 0o600 });
  await policy(execute);
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'selected', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  await createConfiguredRun(project, { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r', graph }, options);
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: opened.layout.revision };
  const store = await openConfiguredAttemptStore(project, options); const eligibleAt = (await store.store.loadRun('s', 'r'))!.progress[0]!.eligibleAt;
  await store.store.reserveRunTasks({ commandId: 'reserve', actor: { id: 'fixture', issuer: 'test', subject: 'service' }, scopeId: 's', runId: 'r', expectedRevision: 0, now: eligibleAt, identities: [identity] }); store.store.close();
  return { root, project, data, configPath, options, identity, layout: opened.layout, policy };
}

describe.skipIf(!dockerEnabled)('selected task execution', () => {
  it('executes the pinned profile in a detached Git base, evaluates it, and replays without current execution settings', async () => {
    const f = await fixture(); const runtime = await openConfiguredExecution(f.project, f.project, f.options); let record: Awaited<ReturnType<typeof runtime.store.loadBoundDispatch>> = null;
    let lease: Awaited<ReturnType<typeof runtime.workspaces.openRecorded>> = null;
    try {
      const changed = JSON.parse(await readFile(f.configPath, 'utf8'));
      changed.admission.registry.profiles[0].parameters.argv = ['node', '-e', "process.stdout.write('current-config')"];
      changed.admission.registry.profiles[0].parameters.imageId = 'sha256:' + 'b'.repeat(64);
      changed.execution.docker = { ...changed.execution.docker, imageId: 'sha256:' + 'c'.repeat(64), memoryBytes: 536870912 };
      await writeFile(f.configPath, JSON.stringify(changed)); clearConfigCache();
      const first = await executeConfiguredTask(f.project, f.identity, f.options);
      expect(first.execution).toMatchObject({ status: 'terminal', terminal: { exitCode: 0 }, outputRecorded: true });
      const evaluated = await evaluateConfiguredTask(f.project, { schemaVersion: 1, commandId: 'evaluate', identity: f.identity, expectedRevision: 2 }, f.options);
      expect(evaluated.evaluation.run.tasks[0]!.phase).toBe('accepted');
      const store = await openConfiguredAttemptStore(f.project, f.options);
      try { record = (await store.store.loadBoundDispatch(f.identity))!; } finally { store.store.close(); }
      const output = JSON.parse(new TextDecoder().decode(await runtime.artifacts.read('s', record.output!)));
      expect(output.stdout).toBe('base\n'); expect(output.stdout).not.toContain('owner-wip');
      lease = await runtime.workspaces.openRecorded(f.identity);
      const replayConfig = JSON.parse(await readFile(f.configPath, 'utf8')); delete replayConfig.execution; await writeFile(f.configPath, JSON.stringify(replayConfig)); clearConfigCache();
      expect(await executeConfiguredTask(f.project, f.identity, f.options)).toEqual(first);
    } finally {
      try {
        if (record) {
          const supervisor = await DockerSupervisor.restoreProfile(record.profile);
          await supervisor.release(record.request);
        }
      } finally {
        try {
          if (lease) await runtime.workspaces.release({ schemaVersion: 1, identity: lease.identity, baseCommit: lease.baseCommit });
        } finally { runtime.store.close(); }
      }
    }
  }, 30000);

  it('checks execute policy before allocating a workspace or dispatching', async () => {
    const f = await fixture(false);
    await expect(executeConfiguredTask(f.project, f.identity, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(stat(productResourcePath(f.layout, 'workspaces'))).rejects.toMatchObject({ code: 'ENOENT' });
    const store = await openConfiguredAttemptStore(f.project, f.options);
    try { expect(await store.store.loadBoundDispatch(f.identity)).toBeNull(); } finally { store.store.close(); }
    await expect(executeConfiguredTask(f.project, { ...f.identity, argv: ['caller'] })).rejects.toThrow();
  });
});
