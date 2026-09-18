import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createRun, requestRunCancellation, reserveRunTasks } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache } from '#platform/index.js';
import { identifyDockerRequest } from '#adapters/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE; const exec = promisify(execFile);
type Child = ReturnType<typeof spawn>;
function closed(child: Child) { return new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); }); }
async function bounded<T>(promise: Promise<T>, child: Child, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(label)); }, 15000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

it.skipIf(!imageId || process.platform !== 'linux')('recovers request-only cancellation in a fresh process after the execution controller is killed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-cancel-recovery-process-')); const project = join(root, 'project'), data = join(root, 'data');
  const configPath = join(project, '.deckent/config.json'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', project, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(project, 'input'), 'base\n'); await git('add', 'input'); await git('commit', '-m', 'base');
  const readyName = `ready-${randomUUID()}`; const registry = fixtureDockerRegistry(['recovery']);
  registry.profiles[0]!.parameters = { ...registry.profiles[0]!.parameters, imageId,
    argv: ['node', '-e', `require('node:fs').writeFileSync('/workspace/${readyName}','yes');setInterval(()=>{},1000)`] };
  const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
  const env = { ...process.env, HOME: join(root, 'home') };
  await writeFile(configPath, JSON.stringify({ layout: { root: data }, artifacts: { maxBytes: 65536 }, admission: {
    poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry }, cancellation: {
    maxConcurrentDeliveries: 1, maxAttempts: 3, retryDelayMs: 10, claimTtlMs: 100, recoveryPageSize: 2 },
  execution: { docker, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  const options = { env }; const opened = await openConfiguredAttemptStore(project, options);
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); opened.store.close();
  const principal = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: principal, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'cancel'], scopes: ['s'], principals: principal, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals: principal, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: ['execute', 'cancel'], scopes: ['s'], principals: principal, resource: { kind: 'attempt', ids: 'all' } },
  ] }), { mode: 0o600 });
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'recovery', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  await createRun(project, { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r', graph }, options);
  const identity = (await reserveRunTasks(project, { schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r', expectedRevision: 0 }, options)).reservation.identities[0]!;
  const sdk = resolve('dist/index.js'); const executeProgram = `
    const [sdk,project,identityText]=process.argv.slice(1); const {executeTask}=await import(sdk);
    await executeTask(project,JSON.parse(identityText),{env:{...process.env,HOME:process.env.HOME}});`;
  const execution = spawn(process.execPath, ['--input-type=module', '-e', executeProgram, sdk, project, JSON.stringify(identity)], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const executionClosed = closed(execution); let executionErr = ''; execution.stderr.on('data', chunk => { executionErr += String(chunk); });
  let handle: string | undefined; let endpoint: string | undefined;
  try {
    let record;
    for (let i = 0; i < 500; i++) {
      const store = await openConfiguredAttemptStore(project, options);
      try { record = await store.store.loadBoundDispatch(identity); } finally { store.store.close(); }
      if (record?.launch === 'granted') { try { if (await readFile(join(record.request.workspace, readyName), 'utf8') === 'yes') break; } catch { /* starting */ } }
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    expect(record?.launch).toBe('granted'); expect(await readFile(join(record!.request.workspace, readyName), 'utf8')).toBe('yes');
    const parameters = record!.profile.parameters as { endpoint: string }; endpoint = parameters.endpoint;
    handle = identifyDockerRequest(record!.request, { ...docker, workspaceRoot: resolve(data, 'workspaces'), uid: userInfo().uid, gid: userInfo().gid }).handle;
    await requestRunCancellation(project, { schemaVersion: 1, commandId: 'cancel', action: 'cancel', scopeId: 's', runId: 'r', expectedRevision: 1 }, options);
    const db = new DatabaseSync(opened.path);
    try { expect(db.prepare('SELECT record FROM cancellation_deliveries WHERE scope_id=? AND attempt_id=?').get('s', identity.attemptId)).toBeUndefined(); }
    finally { db.close(); }
    execution.kill('SIGKILL'); await bounded(executionClosed, execution, 'EXECUTION_CHILD_CLOSE_TIMEOUT'); expect(execution.signalCode).toBe('SIGKILL');
    const config = JSON.parse(await readFile(configPath, 'utf8')); delete config.execution; await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
    const recoverProgram = `const [sdk,project]=process.argv.slice(1);const {recoverCancellations}=await import(sdk);const result=await recoverCancellations(project,{schemaVersion:1,scopeId:'s',afterAttemptId:null},{env:{...process.env,HOME:process.env.HOME}});process.stdout.write(JSON.stringify(result));`;
    const recovery = spawn(process.execPath, ['--input-type=module', '-e', recoverProgram, sdk, project], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; recovery.stdout.on('data', chunk => { stdout += String(chunk); }); recovery.stderr.on('data', chunk => { stderr += String(chunk); });
    const code = await bounded(closed(recovery), recovery, 'RECOVERY_CHILD_TIMEOUT'); expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout).recovery.outcomes).toMatchObject([{ identity, outcome: { status: 'terminal', delivery: { state: 'terminal', attempts: 1 } } }]);
    expect((await exec('/usr/bin/docker', ['--host', endpoint, 'inspect', '--format', '{{.State.Running}}', handle])).stdout.trim()).toBe('false');
    const proof = await openConfiguredAttemptStore(project, options);
    try {
      expect(await proof.store.load('s', identity.attemptId)).toMatchObject({ cancelRequested: true, lastObservation: { result: { kind: 'exited' } } });
      const journal = new DatabaseSync(opened.path, { readOnly: true });
      try {
        const row = journal.prepare('SELECT record FROM cancellation_deliveries WHERE scope_id=? AND attempt_id=?').get('s', identity.attemptId)!;
        expect(JSON.parse(String(row.record))).toMatchObject({ identity, state: 'terminal', attempts: 1 });
      } finally { journal.close(); }
    }
    finally { proof.store.close(); }
  } finally {
    if (execution.exitCode === null && execution.signalCode === null) { execution.kill('SIGKILL'); await executionClosed.catch(() => null); }
    if (handle && endpoint) await exec('/usr/bin/docker', ['--host', endpoint, 'rm', '-f', handle]).catch(() => undefined);
    clearConfigCache(); await rm(root, { recursive: true, force: true });
    expect(executionErr).not.toContain('private');
  }
}, 40000);
