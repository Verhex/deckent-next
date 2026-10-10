import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { clearConfigCache, prepareProductDirectory } from '#platform/index.js';
import { DockerSupervisor, identifyDockerRequest, runNodeDockerCommand } from '#adapters/index.js';
import { startConfiguredRuntimeService } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyPrincipal } from '../support/custody.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
async function poll<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = performance.now() + 10000;
  do { const value = await read(); if (value !== undefined) return value; await wait(20); } while (performance.now() < deadline);
  throw new Error(label);
}

it.skipIf(!imageId || process.platform !== 'linux')('kills an attempt worker container, restarts the real service, and reconciles within ten seconds without explicit reconciliationRuntime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dk-restart-docker-')), project = join(root, 'p'), data = join(root, 'd');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data },
    runRuntime: { pageSize: 1, pollIntervalMs: 20, failureBackoffMs: 40 },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 20, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['unused'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    toolchains: { update: { atStartup: false, intervalMs: 0 } } }));
  const options = { env: { HOME: join(root, 'h'), USERPROFILE: join(root, 'h') } };
  const opened = await openConfiguredAttemptStore(project, options), os = userInfo();
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: opened.layout.revision };
  const workspaceRoot = await prepareProductDirectory(opened.layout, 'workspaces'), workspace = join(workspaceRoot, 'worker');
  await mkdir(workspace, { mode: 0o700 }); await prepareProductDirectory(opened.layout, 'artifacts');
  const docker = { executable: '/usr/bin/docker', workspaceRoot, imageId: imageId!, uid: os.uid, gid: os.gid,
    memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
    deadlineMs: 30000, controlTimeoutMs: 2000, outputBytes: 65536 };
  const supervisor = new DockerSupervisor(docker), request = { protocolVersion: 1 as const, identity, workspace,
    argv: ['node', '-e', "const f=require('node:fs');f.appendFileSync('/workspace/starts','1');f.writeFileSync('/workspace/ready','yes');process.on('SIGINT',()=>process.exit(130));setInterval(()=>{},1000)"] };
  const principals = [{ issuer: hostname(), subject: String(os.uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'fixture', restrictions: [], grants: [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'attempt', effect: 'allow', actions: ['reconcile', 'recover-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: ['a'] } },
  ] }), { mode: 0o600 });
  let service: Awaited<ReturnType<typeof startConfiguredRuntimeService>> | undefined, worker: Promise<unknown> | undefined;
  const observer = { onPage() {}, onError() {} };
  try {
    const profile = await supervisor.captureProfile();
    await admitRunAttempts(opened.store, [identity]);
    const claim = { request, owner: 'stopped-controller' };
    await opened.store.claimDispatch({ ...claim, profile }); await opened.store.grantLaunch({ claim, principal: custodyPrincipal, now: 1 });
    worker = supervisor.execute(request);
    await poll(async () => { try { return await readFile(join(workspace, 'ready'), 'utf8') === 'yes' ? true : undefined; } catch { return undefined; } }, 'WORKER_READY_TIMEOUT');
    service = await startConfiguredRuntimeService(project, observer, options);
    await service.stop(); await service.done; service = undefined;
    const { handle } = identifyDockerRequest(request, docker), endpoint = (profile.parameters as { endpoint: string }).endpoint;
    await runNodeDockerCommand({ executable: docker.executable, args: ['--host', endpoint, 'kill', '--signal', 'SIGINT', handle], timeoutMs: 2000, outputBytes: 65536 });
    await worker; // Lost controller: its returned process evidence deliberately was not written to the ledger.
    expect((await opened.store.readDispatch(request))?.terminal).toBeNull();
    service = await startConfiguredRuntimeService(project, observer, options);
    const record = await poll(async () => {
      const current = await opened.store.readDispatch(request); return current?.terminal && current.output ? current : undefined;
    }, 'SERVICE_RESTART_RECONCILIATION_TIMEOUT');
    expect(record).toMatchObject({ owner: 'stopped-controller', launch: 'granted', terminal: { exitCode: 130, interrupted: null } });
    expect((await opened.store.loadRun('s', 'r'))?.progress[0]).toMatchObject({ phase: 'evaluating', unresolvedEffects: false });
    expect(await readFile(join(workspace, 'starts'), 'utf8')).toBe('1');
    expect((await supervisor.observe(request)).result).toEqual({ kind: 'exited', exitCode: 130 });
  } finally {
    if (service) { await service.stop(); await service.done; }
    await supervisor.cancel(request).catch(() => undefined); await worker?.catch(() => undefined);
    await supervisor.release(request).catch(() => undefined); opened.store.close(); clearConfigCache();
    await rm(root, { recursive: true, force: true });
  }
}, 40000);
