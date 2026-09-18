import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createRun, executeTask, inspectRun, reserveRunTasks } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache } from '#platform/index.js';
import { identifyDockerRequest } from '#adapters/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const exec = promisify(execFile);
type Child = ChildProcess & { stdout: NonNullable<ChildProcess['stdout']>; stderr: NonNullable<ChildProcess['stderr']> };
function closed(child: Child): Promise<number | null> {
  return new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
}
async function bounded<T>(promise: Promise<T>, child: Child, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(label)); }, 15_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function poll<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const value = await read(); if (value !== undefined) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  throw new Error(label);
}

it.skipIf(!imageId || process.platform !== 'linux')('manually reconciles an uncancelled offline exit in a fresh process without relaunch or output invention', async () => {
  const sdk = resolve('dist/index.js');
  await access(sdk).catch(() => { throw new Error('BUILD_REQUIRED: run npm run build before this process proof'); });
  const root = await mkdtemp(join(tmpdir(), 'dk-uncancel-'));
  const project = join(root, 'p'), data = join(root, 'd'), configPath = join(project, '.deckent/config.json');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', project, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(project, 'input'), 'base\n'); await git('add', 'input'); await git('commit', '-m', 'base');
  const registry = fixtureDockerRegistry(['offline-exit']);
  registry.profiles[0]!.parameters = { ...registry.profiles[0]!.parameters, imageId,
    argv: ['node', '-e', "const f=require('node:fs');f.appendFileSync('/workspace/starts','1');f.writeFileSync('/workspace/ready','yes');const t=setInterval(()=>{if(f.existsSync('/workspace/release')){clearInterval(t);process.exit(7)}},10)"] };
  const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000,
    outputBytes: 65536 };
  const configuration = { layout: { root: data }, artifacts: { maxBytes: 65536 }, admission: { poolId: 'p',
    executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry }, execution: { docker,
    git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } };
  await writeFile(configPath, JSON.stringify(configuration));
  const env = { ...process.env, HOME: join(root, 'h') }; const options = { env };
  const opened = await openConfiguredAttemptStore(project, options);
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  opened.store.close();
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals,
      resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: ['execute', 'reconcile'], scopes: ['s'], principals,
      resource: { kind: 'attempt', ids: 'all' } },
  ] }), { mode: 0o600 });
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'offline-exit', dependencies: [],
    acceptanceCriteria: ['exit'] }], criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept seven',
      evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [7] } }] };
  await createRun(project, { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r', graph }, options);
  const identity = (await reserveRunTasks(project, { schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r',
    expectedRevision: 0 }, options)).reservation.identities[0]!;
  const executeProgram = `const [sdk,project,identity]=process.argv.slice(1);const {executeTask}=await import(sdk);await executeTask(project,JSON.parse(identity),{env:{...process.env,HOME:process.env.HOME}});`;
  const controller = spawn(process.execPath, ['--input-type=module', '-e', executeProgram, sdk, project, JSON.stringify(identity)],
    { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] }) as Child;
  const controllerClosed = closed(controller); let handle: string | undefined; let endpoint: string | undefined;
  try {
    const record = await poll(async () => {
      const store = await openConfiguredAttemptStore(project, options);
      try {
        const current = await store.store.loadBoundDispatch(identity);
        if (current?.launch !== 'granted') return undefined;
        try { return await readFile(join(current.request.workspace, 'ready'), 'utf8') === 'yes' ? current : undefined; }
        catch { return undefined; }
      } finally { store.store.close(); }
    }, 'WORKER_READY_TIMEOUT');
    endpoint = (record.profile.parameters as { endpoint: string }).endpoint;
    handle = identifyDockerRequest(record.request, { ...docker, workspaceRoot: resolve(data, 'workspaces'),
      uid: userInfo().uid, gid: userInfo().gid }).handle;
    controller.kill('SIGKILL'); await bounded(controllerClosed, controller, 'CONTROLLER_CLOSE_TIMEOUT');
    expect(controller.signalCode).toBe('SIGKILL');
    await writeFile(join(record.request.workspace, 'release'), 'exit');
    await poll(async () => (await exec('/usr/bin/docker', ['--host', endpoint!, 'inspect', '--format', '{{.State.Running}}', handle!]))
      .stdout.trim() === 'false' ? true : undefined, 'WORKER_EXIT_TIMEOUT');
    const before = await inspectRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, options);
    expect(before.run?.tasks[0]).toMatchObject({ phase: 'active', unresolvedEffects: false });
    const changed = structuredClone(configuration) as Record<string, unknown>; delete changed.execution;
    await writeFile(configPath, JSON.stringify(changed)); clearConfigCache();
    expect(await executeTask(project, identity, options)).toMatchObject({ execution: { status: 'unresolved',
      terminal: null, outputRecorded: false } });
    expect(await readFile(join(record.request.workspace, 'starts'), 'utf8')).toBe('1');

    const reconcileProgram = `const [sdk,project,identity]=process.argv.slice(1);const {reconcileAttempt}=await import(sdk);const value=await reconcileAttempt(project,JSON.parse(identity),{env:{...process.env,HOME:process.env.HOME}});process.stdout.write(JSON.stringify(value));`;
    const recovery = spawn(process.execPath, ['--input-type=module', '-e', reconcileProgram, sdk, project, JSON.stringify(identity)],
      { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] }) as Child;
    let stdout = '', stderr = ''; recovery.stdout.on('data', chunk => { stdout += String(chunk); });
    recovery.stderr.on('data', chunk => { stderr += String(chunk); });
    expect(await bounded(closed(recovery), recovery, 'RECONCILE_CLOSE_TIMEOUT')).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({ reconciliation: { identity, status: 'terminal',
      terminal: { exitCode: 7 }, outputRecorded: false } });
    const after = await inspectRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, options);
    expect(after.run?.tasks[0]).toMatchObject({ phase: 'evaluating', unresolvedEffects: false });
    const proof = await openConfiguredAttemptStore(project, options);
    try {
      const settled = await proof.store.loadBoundDispatch(identity);
      expect(settled).toMatchObject({ launch: 'granted', terminal: { exitCode: 7 } });
      expect(settled?.output).toBeUndefined();
    } finally { proof.store.close(); }
  } finally {
    if (controller.exitCode === null && controller.signalCode === null) { controller.kill('SIGKILL'); await controllerClosed.catch(() => null); }
    if (handle && endpoint) await exec('/usr/bin/docker', ['--host', endpoint, 'rm', '-f', handle]).catch(() => undefined);
    clearConfigCache(); await rm(root, { recursive: true, force: true });
  }
}, 40_000);
