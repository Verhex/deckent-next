import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRun, reserveRunTasks } from '../../../src/index.js';
import { recoverConfiguredAttemptOutput } from '../../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { DockerSupervisor } from '#adapters/index.js';
import { clearConfigCache, prepareProductDirectory } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
import { custodyPrincipal } from '../support/custody.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const roots: string[] = [];
afterEach(async () => {
  clearConfigCache();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!imageId || process.platform !== 'linux')('configured output recovery', () => {
  it('authorizes before recovery, restores recorded custody without execution config, and replays partial evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-output-recovery-')); roots.push(root);
    const project = join(root, 'p'), data = join(root, 'd'), configPath = join(project, '.deckent/config.json');
    await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
    const registry = fixtureDockerRegistry(['output-recovery']);
    const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1,
      logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000,
      outputBytes: 65536, workspaceRoot: resolve(data, 'workspaces'), uid: userInfo().uid, gid: userInfo().gid };
    const configuration = { layout: { root: data }, artifacts: { maxBytes: 65536 }, admission: { poolId: 'p',
      executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry }, execution: { docker: {
        executable: docker.executable, imageId: docker.imageId, memoryBytes: docker.memoryBytes, pids: docker.pids,
        cpus: docker.cpus, logMaxSizeKiB: docker.logMaxSizeKiB, logMaxFiles: docker.logMaxFiles, tmpBytes: docker.tmpBytes,
        deadlineMs: docker.deadlineMs, controlTimeoutMs: docker.controlTimeoutMs, outputBytes: docker.outputBytes },
      git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } };
    await writeFile(configPath, JSON.stringify(configuration));
    const options = { env: { HOME: join(root, 'h') } }; const opened = await openConfiguredAttemptStore(project, options);
    await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
    opened.store.close();
    const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
    const policy = async (allow: boolean) => writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1,
      revision: allow ? 'allow' : 'deny', restrictions: [], grants: [
        { id: 'run', effect: 'allow', actions: ['create', 'reserve'], scopes: ['s'], principals,
          resource: { kind: 'run', ids: ['r'] } },
        { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
        ...(allow ? [{ id: 'recover', effect: 'allow', actions: ['recover-output'], scopes: ['s'], principals,
          resource: { kind: 'attempt', ids: 'all' } }] : []),
      ] }), { mode: 0o600 });
    await policy(true);
    const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'output-recovery', dependencies: [],
      acceptanceCriteria: ['exit'] }], criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept zero',
      evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
    await createRun(project, { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r', graph }, options);
    const identity = (await reserveRunTasks(project, { schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r',
      expectedRevision: 0 }, options)).reservation.identities[0]!;
    const workspace = join(docker.workspaceRoot, identity.attemptId); await mkdir(workspace, { recursive: true, mode: 0o700 });
    const request = { protocolVersion: 1 as const, identity, workspace, argv: ['node', '-e',
      "process.stdout.write('recovered-out');process.stderr.write('recovered-err')"] };
    const claim = { owner: 'fixture-worker', request }; const supervisor = new DockerSupervisor(docker);
    const store = await openConfiguredAttemptStore(project, options);
    const profile = await supervisor.captureProfile();
    await store.store.claimDispatch({ ...claim, profile });
    await store.store.grantLaunch({ claim, principal: custodyPrincipal, now: 1 });
    const result = await supervisor.execute(request);
    await store.store.finishDispatch(claim, { handle: result.handle, exitCode: 0, interrupted: false });
    store.store.close(); await prepareProductDirectory(opened.layout, 'artifacts');
    try {
      await policy(false); clearConfigCache();
      await expect(recoverConfiguredAttemptOutput(project, identity, options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      const denied = await openConfiguredAttemptStore(project, options);
      try { expect((await denied.store.loadBoundDispatch(identity))?.output).toBeUndefined(); } finally { denied.store.close(); }

      await policy(true); const changed = JSON.parse(await readFile(configPath, 'utf8')); delete changed.execution;
      await writeFile(configPath, JSON.stringify(changed)); clearConfigCache();
      const first = await recoverConfiguredAttemptOutput(project, identity, options);
      expect(first.recovery).toEqual({ identity, outputRecorded: true, completeness: 'partial' });
      expect(await recoverConfiguredAttemptOutput(project, identity, options)).toEqual(first);
      const proof = await openConfiguredAttemptStore(project, options);
      try {
        const record = await proof.store.loadBoundDispatch(identity); expect(record?.output).toBeDefined();
        expect(record?.terminal).toMatchObject({ exitCode: 0 });
      } finally { proof.store.close(); }
    } finally { await supervisor.release(request).catch(() => undefined); }
  }, 30000);
});
