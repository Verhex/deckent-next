import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, expect, it } from 'vitest';
import { applyInstallation, createConfiguredRuntimeClient, inspectInstallation } from '../../../src/index.js';
import { hashInstallationProfilePayload } from '#engine/index.js';
import { DockerSupervisor } from '#adapters/index.js';
import { clearConfigCache } from '#platform/index.js';
import { openConfiguredExecution } from '../../../src/composition/core/execution/index.js';
import { installationProfile } from '../support/installation-profile.js';

const exec = promisify(execFile), cli = resolve('dist/composition/core/cli/internal/entry.js'), mcp = resolve('dist/composition/core/mcp/internal/entry.js');
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function bounded<T>(promise: Promise<T>, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function closed(child: ChildProcessWithoutNullStreams) { return new Promise<number | null>(resolve => child.once('close', resolve)); }
async function ready(child: ChildProcessWithoutNullStreams, stderr: () => string) {
  let buffered = '';
  try {
    await bounded(new Promise<void>((resolveReady, reject) => {
      child.stdout.on('data', chunk => { buffered += String(chunk); for (const line of buffered.split('\n')) {
        try { if (JSON.parse(line).event === 'ready') { resolveReady(); return; } } catch { /* incomplete line */ }
      } });
      child.once('exit', code => reject(new Error(`SERVICE_EXIT_${code}: ${stderr().slice(-4096)}`)));
    }));
  } catch (error) { throw new Error(`SERVICE_READY_FAILED: ${stderr().slice(-4096)}`, { cause: error }); }
}
function rehash<T extends ReturnType<typeof installationProfile>>(profile: T): T {
  profile.profile.digest = hashInstallationProfilePayload({ ...profile, profile: { id: profile.profile.id, version: profile.profile.version } }); return profile;
}

it.skipIf(process.platform !== 'linux').each(['plain', 'conditional', 'approval'])('runs installed mode=%s across SDK, CLI and MCP through the configured service', async mode => {
  const conditional = mode === 'conditional', approvals = mode === 'approval';
  const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
  if (!imageId) throw new Error('DECKENT_TEST_DOCKER_IMAGE is required');
  const root = await mkdtemp(join(tmpdir(), 'deckent-installed-service-')); roots.push(root); await chmod(root, 0o700);
  const project = join(root, 'project'), data = join(root, 'data'), profilePath = join(root, 'profile.json'); await mkdir(project, { mode: 0o700 });
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', project, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(project, 'input'), 'base\n'); await git('add', 'input'); await git('commit', '-m', 'base');
  await writeFile(join(project, 'input'), 'owner-wip\n');

  const profile = installationProfile({ root: data, shutdown: true, images: [imageId] });
  const principal = { issuer: hostname(), subject: String(userInfo().uid) }, principals = [principal];
  const docker = profile.configuration.execution.docker;
  Object.assign(docker, { executable: '/usr/bin/docker', imageId, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 });
  profile.configuration.execution.git.gitExecutable = '/usr/bin/git';
  const configured = profile.configuration as typeof profile.configuration & {
    cancellation: { maxConcurrentDeliveries: number; maxAttempts: number; retryDelayMs: number; claimTtlMs: number; recoveryPageSize: number };
    cancellationRuntime: { scopeIds: string[]; pollIntervalMs: number; failureBackoffMs: number };
    service: { identity: { scopeId: string; serviceId: string }; inputMaxBytes: number; responseMaxBytes: number; maxConnections: number;
      maxConcurrentRequests: number; maxConcurrentExecutions: number; headerTimeoutMs: number; shutdownGraceMs: number };
  };
  configured.cancellation = { maxConcurrentDeliveries: 1, maxAttempts: 3, retryDelayMs: 10, claimTtlMs: 100, recoveryPageSize: 2 };
  configured.cancellationRuntime = { scopeIds: ['scope-1'], pollIntervalMs: 50, failureBackoffMs: 50 };
  configured.service = { identity: { scopeId: 'scope-1', serviceId: 'service-1' }, inputMaxBytes: 65536, responseMaxBytes: 65536,
    maxConnections: 4, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 };
  const selected = profile.configuration.admission.registry.profiles[0]!;
  const { executable: hostExecutable, ...dockerTask } = docker; void hostExecutable;
  selected.parameters = { ...selected.parameters, ...dockerTask,
    argv: ['node', '-e', "process.stdout.write(require('node:fs').readFileSync('/workspace/input','utf8'))"] };
  profile.policy.grants = [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope-1'], principals, resource: { kind: 'scope', ids: ['scope-1'] } },
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect', 'cancel'], scopes: ['scope-1'], principals, resource: { kind: 'run', ids: ['run-1'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['scope-1'], principals, resource: { kind: 'pool', ids: ['pool-1'] } },
    { id: 'attempt', effect: 'allow', actions: ['execute', 'evaluate', 'cancel', 'reconcile', 'recover-output'], scopes: ['scope-1'], principals, resource: { kind: 'attempt', ids: 'all' } },
    { id: 'shutdown', effect: 'allow', actions: ['shutdown'], scopes: ['scope-1'], principals, resource: { kind: 'service', ids: ['service-1'] } },
  ];
  if (approvals) profile.policy.grants.push(
    { id: 'approve-task', effect: 'require-approval', actions: ['execute'], scopes: ['scope-1'], principals, resource: { kind: 'task', ids: ['held'] } },
    { id: 'approval', effect: 'allow', actions: ['inspect', 'decide', 'renew'], scopes: ['scope-1'], principals, resource: { kind: 'approval', ids: 'all' } },
  );
  await writeFile(profilePath, JSON.stringify(rehash(profile)), { mode: 0o600 });
  const env = { HOME: join(root, 'home'), PATH: process.env.PATH ?? '/usr/bin:/bin' }, options = { env };
  const evidence = await inspectInstallation(project, profile, { allowShutdown: true, dockerExecutable: '/usr/bin/docker' });
  const installed = await applyInstallation(project, profile, { allowShutdown: true, dockerExecutable: '/usr/bin/docker', proposalDigest: evidence.proposalDigest, acceptCustom: true });
  expect(installed).toMatchObject({ status: 'installed', trust: { mode: 'operator-custom', publisherVerification: 'unverified' } });

  let service: ChildProcessWithoutNullStreams | undefined, serviceClosed: Promise<number | null> | undefined, serviceErr = '';
  let runtime: Awaited<ReturnType<typeof openConfiguredExecution>> | undefined;
  let record: Awaited<ReturnType<Awaited<ReturnType<typeof openConfiguredExecution>>['store']['loadBoundDispatch']>> = null;
  let lease: Awaited<ReturnType<Awaited<ReturnType<typeof openConfiguredExecution>>['workspaces']['openRecorded']>> = null;
  let identity: { scopeId: string; runId: string; taskId: string; attemptId: string; generation: number; layoutRevision: string } | undefined;
  let runtimeClient: ReturnType<typeof createConfiguredRuntimeClient> | undefined;
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--project', project], env, stderr: 'pipe' });
  const client = new Client({ name: 'installed-runtime-service', version: '1' });
  try {
    service = spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
    service.stderr.on('data', chunk => { serviceErr += String(chunk); }); serviceClosed = closed(service);
    await ready(service, () => serviceErr);
    runtime = await openConfiguredExecution(project, project, options);
    runtimeClient = createConfiguredRuntimeClient(project, options);
    const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 'task-1', kind: 'kind-1', dependencies: [], acceptanceCriteria: ['exit'] }],
      criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept zero', evaluator: { id: 'custom-exit', version: 7 }, parameters: { acceptedExitCodes: [0] } }] };
    if (approvals) graph.tasks.unshift({ ...graph.tasks[0]!, id: 'held' });
    if (conditional) graph.tasks.push({ ...graph.tasks[0]!, id: 'not-selected' }, { ...graph.tasks[0]!, id: 'join', dependencies: ['task-1', 'not-selected'] });
    const branch = { schemaVersion: 1 as const, input: { id: 'fact', revision: 'fact-1', value: true }, whenTrue: 'task-1', whenFalse: 'not-selected', join: 'join' };
    const created = await runtimeClient.createRun({ schemaVersion: 1, commandId: 'create', scopeId: 'scope-1', runId: 'run-1', graph, ...(conditional ? { branch } : {}) });
    if (conditional) expect(created.admission.run.branch?.notSelectedTaskId).toBe('not-selected');
    const reservation = JSON.parse((await exec(process.execPath, [cli, 'run', 'reserve', '--scope', 'scope-1', '--id', 'run-1', '--command-id', 'reserve', '--expected-revision', '0', '--json'], { cwd: project, env })).stdout);
    identity = reservation.reservation.identities[0];
    await client.connect(transport);
    const execution = await client.callTool({ name: 'execute_task', arguments: identity }); expect(execution.isError).not.toBe(true);
    const evaluation = await client.callTool({ name: 'evaluate_task', arguments: { schemaVersion: 1, commandId: 'evaluate', identity, expectedRevision: 2 } });
    expect(evaluation.isError).not.toBe(true);
    expect((evaluation.structuredContent as { evaluation: { run: { tasks: { id: string; phase: string }[] } } }).evaluation.run.tasks.find(task => 'id' in task && task.id === 'task-1')!.phase).toBe('accepted');
    expect((await runtimeClient.inspectRun({ schemaVersion: 1, scopeId: 'scope-1', runId: 'run-1' })).run?.tasks.find(task => task.id === 'task-1')?.phase).toBe('accepted');
    record = await runtime.store.loadBoundDispatch(identity); lease = await runtime.workspaces.openRecorded(identity);
    const output = JSON.parse(new TextDecoder().decode(await runtime.artifacts.read('scope-1', record!.output!)));
    expect(output.stdout).toBe('base\n'); expect(output.stdout).not.toContain('owner-wip');
    if (conditional) {
      const next = await runtimeClient.reserveRunTasks({ schemaVersion: 1, commandId: 'reserve-join', scopeId: 'scope-1', runId: 'run-1', expectedRevision: 3 });
      expect(next.reservation.identities.map(item => item.taskId)).toEqual(['join']);
      const inspected = await runtimeClient.inspectRun({ schemaVersion: 1, scopeId: 'scope-1', runId: 'run-1' });
      expect(inspected.run?.tasks.some(task => task.id === 'not-selected')).toBe(false);
    }
    if (approvals) {
      const query = { schemaVersion: 1, scopeId: 'scope-1', afterId: null, limit: 10 };
      const pending = await runtimeClient.listApprovals(query) as { request: { approvalId: string; taskId: string }; status: string }[];
      expect(pending).toHaveLength(1); expect(pending[0]).toMatchObject({ status: 'pending', request: { taskId: 'held' } });
      const command = { schemaVersion: 1, scopeId: 'scope-1', approvalId: pending[0]!.request.approvalId,
        commandId: 'allow-held', expectedRevision: 0, decision: 'allow', reason: 'Approve exact held task' };
      const commandPath = join(root, 'approval.json'); await writeFile(commandPath, JSON.stringify(command));
      const [cliDecision, mcpDecision] = await Promise.all([
        exec(process.execPath, [cli, 'approval', 'decide', '--input', commandPath, '--json'], { cwd: project, env }),
        client.callTool({ name: 'decide_approval', arguments: command }),
      ]);
      expect(mcpDecision.isError).not.toBe(true);
      expect(JSON.parse(cliDecision.stdout)).toEqual(mcpDecision.structuredContent);
      const replay = await runtimeClient.reserveRunTasks({ schemaVersion: 1, scopeId: 'scope-1', runId: 'run-1', commandId: 'reserve', expectedRevision: 0 });
      expect(replay.reservation.identities.map(value => value.taskId)).toEqual(['task-1']);
      const fresh = await runtimeClient.reserveRunTasks({ schemaVersion: 1, scopeId: 'scope-1', runId: 'run-1', commandId: 'reserve-approved', expectedRevision: 3 });
      expect(fresh.reservation.identities.map(value => value.taskId)).toEqual(['held']);
      const approvedIdentity = fresh.reservation.identities[0]!;
      try {
        expect((await client.callTool({ name: 'execute_task', arguments: approvedIdentity })).isError).not.toBe(true);
        expect((await client.callTool({ name: 'evaluate_task', arguments: { schemaVersion: 1, commandId: 'evaluate-held', identity: approvedIdentity, expectedRevision: 5 } })).isError).not.toBe(true);
        expect((await runtimeClient.inspectRun({ schemaVersion: 1, scopeId: 'scope-1', runId: 'run-1' })).run?.tasks.every(task => task.phase === 'accepted')).toBe(true);
        expect(await git('diff', '--', 'input')).toContain('+owner-wip');
      } finally {
        const approvedRecord = await runtime.store.loadBoundDispatch(approvedIdentity);
        if (approvedRecord) await (await DockerSupervisor.restoreProfile(approvedRecord.profile)).release(approvedRecord.request);
        const approvedLease = await runtime.workspaces.openRecorded(approvedIdentity);
        if (approvedLease) await runtime.workspaces.release({ schemaVersion: 1, identity: approvedLease.identity, baseCommit: approvedLease.baseCommit });
      }
    }
    const descriptor = await runtimeClient.describeService();
    await runtimeClient.shutdownService({ schemaVersion: 1, commandId: 'shutdown', serviceId: 'service-1', instanceId: descriptor.instanceId, reason: 'test complete' });
    expect(await bounded(serviceClosed)).toBe(0);
  } finally {
    await client.close().catch(() => undefined); await transport.close().catch(() => undefined);
    if (runtime && identity) try { record ??= await runtime.store.loadBoundDispatch(identity); } catch { /* no admitted worker */ }
    if (record) await (await DockerSupervisor.restoreProfile(record.profile)).release(record.request).catch(() => undefined);
    if (runtime && identity && !lease) try { lease = await runtime.workspaces.openRecorded(identity); } catch { /* no recorded workspace */ }
    if (runtime && lease) await runtime.workspaces.release({ schemaVersion: 1, identity: lease.identity, baseCommit: lease.baseCommit }).catch(() => undefined);
    runtime?.store.close();
    if (service && service.exitCode === null && service.signalCode === null) { service.kill('SIGKILL'); await serviceClosed?.catch(() => null); }
    await rm(profilePath, { force: true });
  }
}, 60_000);
