import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createRun, requestRunCancellation, reserveRunTasks } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache } from '#platform/index.js';
import { identifyDockerRequest } from '#adapters/index.js';
import { childEnv } from '../support/child-env.js';
import { owned } from '../support/owned.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
import { storeStep } from '../support/store-failure.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;

it.skipIf(!imageId || process.platform !== 'linux')('recovers request-only cancellation in a fresh process after the execution controller is killed', async () => {
  const sdk = resolve('dist/index.js');
  await access(sdk).catch(() => { throw new Error('Compiled SDK is required for this process test; run npm run build first.'); });
  const root = await owned().root('deckent-cancel-recovery-process-'); const project = join(root, 'project'), data = join(root, 'data');
  const env = childEnv({ HOME: join(root, 'home') });
  const configPath = join(project, '.deckent/config.json'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const git = async (...args: string[]) => (await owned().exec('/usr/bin/git', ['-C', project, ...args], { env, deadlineMs: 10_000, label: `git ${args[0]}` })).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(project, 'input'), 'base\n'); await git('add', 'input'); await git('commit', '-m', 'base');
  const readyName = `ready-${randomUUID()}`; const registry = fixtureDockerRegistry(['recovery']);
  registry.profiles[0]!.parameters = { ...registry.profiles[0]!.parameters, imageId,
    argv: ['node', '-e', `require('node:fs').writeFileSync('/workspace/${readyName}','yes');setInterval(()=>{},1000)`] };
  const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
  await writeFile(configPath, JSON.stringify({ layout: { root: data }, artifacts: { maxBytes: 16_777_216 }, admission: {
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
  const executeProgram = `
    const [sdk,project,identityText]=process.argv.slice(1); const {executeTask}=await import(sdk);
    await executeTask(project,JSON.parse(identityText),{env:{...process.env,HOME:process.env.HOME}});`;
  const { child: execution, exit: executionExit } = owned().spawn(process.execPath, ['--input-type=module', '-e', executeProgram, sdk, project, JSON.stringify(identity)],
    { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'], deadlineMs: 35_000, label: 'execute controller' });
  let executionErr = ''; execution.stderr!.on('data', chunk => { executionErr += String(chunk); });
  try {
    let record;
    for (let i = 0; i < 500; i++) {
      record = await storeStep(`POLL_LAUNCH_${i}`, async () => { const store = await openConfiguredAttemptStore(project, options);
        try { return await store.store.loadBoundDispatch(identity); } finally { store.store.close(); } });
      if (record?.launch === 'granted') { try { if (await readFile(join(record.request.workspace, readyName), 'utf8') === 'yes') break; } catch { /* starting */ } }
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    expect(record?.launch).toBe('granted'); expect(await readFile(join(record!.request.workspace, readyName), 'utf8')).toBe('yes');
    const endpoint = (record!.profile.parameters as { endpoint: string }).endpoint;
    const handle = owned().container(identifyDockerRequest(record!.request, { ...docker, workspaceRoot: resolve(data, 'workspaces'), uid: userInfo().uid, gid: userInfo().gid }).handle, ['--host', endpoint]);
    await storeStep('REQUEST_CANCELLATION', () => requestRunCancellation(project, { schemaVersion: 1, commandId: 'cancel', action: 'cancel', scopeId: 's', runId: 'r', expectedRevision: 1 }, options));
    const db = new DatabaseSync(opened.path);
    try { expect(db.prepare('SELECT record FROM cancellation_deliveries WHERE scope_id=? AND attempt_id=?').get('s', identity.attemptId)).toBeUndefined(); }
    finally { db.close(); }
    execution.kill('SIGKILL'); expect(await executionExit).toEqual({ code: null, signal: 'SIGKILL' });
    const config = JSON.parse(await readFile(configPath, 'utf8')); delete config.execution; await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
    const recoverProgram = `const [sdk,project]=process.argv.slice(1);const {recoverCancellations}=await import(sdk);const result=await recoverCancellations(project,{schemaVersion:1,scopeId:'s',afterAttemptId:null},{env:{...process.env,HOME:process.env.HOME}});process.stdout.write(JSON.stringify(result));`;
    const { code, stdout, stderr } = await owned().run(process.execPath, ['--input-type=module', '-e', recoverProgram, sdk, project], { cwd: process.cwd(), env, deadlineMs: 15_000, label: 'recover cancellations' });
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout).recovery.outcomes).toMatchObject([{ identity, outcome: { status: 'terminal', delivery: { state: 'terminal', attempts: 1 } } }]);
    expect((await owned().exec('/usr/bin/docker', ['--host', endpoint, 'inspect', '--format', '{{.State.Running}}', handle], { env, deadlineMs: 10_000, label: 'docker inspect' })).stdout.trim()).toBe('false');
    const proof = await storeStep('PROOF_OPEN', () => openConfiguredAttemptStore(project, options));
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
    clearConfigCache();
    expect(executionErr).not.toContain('private');
  }
}, 40000);
