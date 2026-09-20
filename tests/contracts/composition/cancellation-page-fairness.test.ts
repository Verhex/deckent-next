import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { DockerSupervisor, FileArtifactStore, identifyDockerRequest } from '#adapters/index.js';
import { DispatchApplication, type ExecutionSupervisor, type SupervisorProfileSource } from '#engine/index.js';
import { clearConfigCache, prepareProductDirectory } from '#platform/index.js';
import { prepareConfiguredCancellationRuntime } from '../../../src/composition/core/runtime/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { requestRunCancellation } from '../../../src/index.js';
import { admitRunAttempts } from '../support/admission.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const exec = promisify(execFile);
const pause = (milliseconds: number) => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
type CapturedOutcome = Readonly<{ status: 'pending' | 'fulfilled' | 'rejected'; code?: string; message?: string }>;
const bounded = (value: string, maximum = 1024) => value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
function capturedError(error: unknown): Readonly<{ code?: string; message: string }> {
  const record = error instanceof Error ? error as Error & { code?: unknown } : null;
  return Object.freeze({ ...(typeof record?.code === 'string' ? { code: record.code } : {}), message: bounded(record?.message ?? String(error)) });
}

it.skipIf(!imageId || process.platform !== 'linux')('continues to a later cancellation page when the first recorded Docker endpoint is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-cancellation-fairness-'));
  const project = join(root, 'project'), data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 1000,
    outputBytes: 65536 };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, artifacts: { maxBytes: 65536 },
    inspection: { maxPageSize: 1, policyMaxBytes: 65536 }, cancellation: {
      maxConcurrentDeliveries: 1, maxAttempts: 2, retryDelayMs: 60000, claimTtlMs: 100, recoveryPageSize: 1,
    }, cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 10, failureBackoffMs: 20 }, execution: { docker,
      git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  const options = { env: { HOME: join(root, 'home') } };
  const opened = await openConfiguredAttemptStore(project, options);
  const workspaceRoot = await prepareProductDirectory(opened.layout, 'workspaces');
  const artifactRoot = await prepareProductDirectory(opened.layout, 'artifacts');
  const identities = [
    { scopeId: 's', runId: 'r', taskId: 'first', attemptId: 'a-unavailable-endpoint', generation: 1, layoutRevision: opened.layout.revision },
    { scopeId: 's', runId: 'r', taskId: 'second', attemptId: 'z-valid-endpoint', generation: 1, layoutRevision: opened.layout.revision },
  ] as const;
  const requests = identities.map(identity => ({ protocolVersion: 1 as const, identity, workspace: join(workspaceRoot, identity.attemptId),
    argv: ['node', '-e', "require('node:fs').writeFileSync('/workspace/ready','yes');setInterval(()=>{},1000)"] }));
  const supervisor = new DockerSupervisor({ ...docker, workspaceRoot, uid: userInfo().uid, gid: userInfo().gid });
  const controller = new AbortController(); let running: Promise<void> | undefined;
  const executions: Promise<void>[] = [], executionOutcomes: CapturedOutcome[] = requests.map(() => ({ status: 'pending' }));
  try {
    for (const request of requests) await mkdir(request.workspace, { recursive: true, mode: 0o700 });
    await admitRunAttempts(opened.store, identities);
    const validProfile = await supervisor.captureProfile();
    const unavailableProfile = structuredClone(validProfile);
    // Fault injection: persist a schema-valid Unix endpoint that has no daemon. Execution still uses the real
    // supervisor, so both ledger bindings and workers are genuine; only restart custody for page one is unavailable.
    (unavailableProfile.parameters as { endpoint: string }).endpoint = `unix://${join(root, 'missing-docker.sock')}`;
    const firstSupervisor: ExecutionSupervisor & SupervisorProfileSource = {
      async captureProfile() { return unavailableProfile; },
      execute: supervisor.execute.bind(supervisor), cancel: supervisor.cancel.bind(supervisor),
      observe: supervisor.observe.bind(supervisor), recoverOutput: supervisor.recoverOutput.bind(supervisor),
      release: supervisor.release.bind(supervisor),
    };
    const verifier = { async verify() { return { id: 'fixture', issuer: 'test', subject: 'service', assurance: 'os-user' as const, scopeIds: ['s'] }; } };
    const authorization = { async authorize() {} };
    const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: 65536 });
    const applications = [new DispatchApplication(opened.store, firstSupervisor, verifier, authorization, 'fixture', artifacts),
      new DispatchApplication(opened.store, supervisor, verifier, authorization, 'fixture', artifacts)];
    requests.forEach((request, index) => executions.push(applications[index]!.execute(request).then(
      () => { executionOutcomes[index] = { status: 'fulfilled' }; },
      error => { executionOutcomes[index] = { status: 'rejected', ...capturedError(error) }; },
    )));
    const snapshot = async () => Promise.all(identities.map(async identity => {
      try {
        const record = await opened.store.load(identity.scopeId, identity.attemptId);
        return { attemptId: identity.attemptId, record: record == null ? null : bounded(JSON.stringify(record), 2048) };
      } catch (error) { return { attemptId: identity.attemptId, storeError: capturedError(error) }; }
    }));
    const workspaceFiles = async (index: number) => {
      try { return (await readdir(requests[index]!.workspace)).slice(0, 32).map(name => bounded(name, 128)); }
      catch (error) { return { workspaceError: capturedError(error) }; }
    };
    const dockerState = async (index: number) => {
      const handle = identifyDockerRequest(requests[index]!, { ...docker, workspaceRoot, uid: userInfo().uid, gid: userInfo().gid }).handle;
      try {
        const output = await exec('/usr/bin/docker', ['inspect', '--format', '{{json .State}}', handle], { timeout: docker.controlTimeoutMs, maxBuffer: 4096 });
        const state = JSON.parse(output.stdout) as { Status?: unknown; Running?: unknown; Error?: unknown; ExitCode?: unknown; OOMKilled?: unknown; Dead?: unknown };
        let stderr = '';
        try {
          const logs = await exec('/usr/bin/docker', ['logs', '--tail', '20', handle], { timeout: docker.controlTimeoutMs, maxBuffer: docker.outputBytes });
          stderr = bounded(`${logs.stdout}${logs.stderr}`, docker.outputBytes);
        } catch (error) { stderr = `docker logs unavailable: ${capturedError(error).message}`; }
        return { handle, status: state.Status, running: state.Running, error: state.Error, exitCode: state.ExitCode, oomKilled: state.OOMKilled, dead: state.Dead, stderr };
      } catch (error) { return { handle, inspectError: capturedError(error) }; }
    };
    for (const [index, request] of requests.entries()) {
      let ready = false;
      for (let attempt = 0; attempt < 500; attempt++) {
        try { ready = await readFile(join(request.workspace, 'ready'), 'utf8') === 'yes'; } catch { /* starting */ }
        if (ready) break;
        await pause(10);
      }
      if (!ready) console.error('cancellation-page-fairness worker-ready diagnostic', JSON.stringify({ index, identity: request.identity,
        execution: executionOutcomes[index], workspaceFiles: await workspaceFiles(index), store: await snapshot(), docker: await dockerState(index) }));
      expect(ready).toBe(true);
    }
    const principal = [{ issuer: hostname(), subject: String(userInfo().uid) }];
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: randomUUID(), restrictions: [], grants: [
      { id: 'inspect', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: principal, resource: { kind: 'scope', ids: ['s'] } },
      { id: 'run', effect: 'allow', actions: ['cancel'], scopes: ['s'], principals: principal, resource: { kind: 'run', ids: ['r'] } },
      { id: 'attempt', effect: 'allow', actions: ['cancel'], scopes: ['s'], principals: principal, resource: { kind: 'attempt', ids: 'all' } },
    ] }), { mode: 0o600 });
    await requestRunCancellation(project, { schemaVersion: 1, commandId: 'cancel', action: 'cancel', scopeId: 's', runId: 'r', expectedRevision: 1 }, options);
    clearConfigCache();
    const pages: Array<{ after: string | null; statuses: readonly string[] }> = [], runtimeErrors: Array<{ after: string | null; code?: string; message: string }> = [];
    const runtime = await prepareConfiguredCancellationRuntime(project, {
      onPage(command, result) { pages.push({ after: command.afterAttemptId, statuses: result.outcomes?.map(value => value.outcome.status) ?? [] }); },
      onError(command, error) { runtimeErrors.push({ after: command.afterAttemptId, ...capturedError(error) }); },
    }, options);
    running = runtime.run(controller.signal);
    let secondStopped = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      const current = await opened.store.load('s', identities[1].attemptId);
      if (current?.lastObservation?.result.kind === 'exited') { secondStopped = true; break; }
      await pause(20);
    }
    controller.abort(); await running; running = undefined;
    if (!secondStopped) console.error('cancellation-page-fairness second-stopped diagnostic', JSON.stringify({ pages, runtimeErrors,
      executions: executionOutcomes, store: await snapshot() }));
    expect(secondStopped).toBe(true);
    expect(pages).toEqual(expect.arrayContaining([
      { after: null, statuses: ['unavailable'] },
      { after: identities[0].attemptId, statuses: ['terminal'] },
    ]));
    const db = new DatabaseSync(opened.path, { readOnly: true });
    try {
      const first = db.prepare('SELECT record FROM cancellation_deliveries WHERE scope_id=? AND attempt_id=?').get('s', identities[0].attemptId) as { record: string };
      const second = db.prepare('SELECT record FROM cancellation_deliveries WHERE scope_id=? AND attempt_id=?').get('s', identities[1].attemptId) as { record: string };
      expect(JSON.parse(first.record)).toMatchObject({ state: 'queued', attempts: 1, lastOutcome: 'unavailable' });
      expect(JSON.parse(second.record)).toMatchObject({ state: 'terminal', attempts: 1, lastOutcome: 'terminal' });
    } finally { db.close(); }
    expect((await opened.store.load('s', identities[0].attemptId))?.lastObservation).toBeNull();
    const firstHandle = identifyDockerRequest(requests[0], { ...docker, workspaceRoot, uid: userInfo().uid, gid: userInfo().gid }).handle;
    expect((await exec('/usr/bin/docker', ['inspect', '--format', '{{.State.Running}}', firstHandle])).stdout.trim()).toBe('true');
  } finally {
    controller.abort(); await running?.catch(() => undefined);
    for (const request of requests) await supervisor.cancel(request).catch(() => undefined);
    await Promise.all(executions);
    for (const request of requests) await supervisor.release(request).catch(() => undefined);
    opened.store.close(); clearConfigCache(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
