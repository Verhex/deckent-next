import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DockerSupervisor, openSqliteAttemptStore, validateDockerSupervisorProfile } from '#adapters/index.js';
import { prepareConfiguredReconciliationRuntime } from '../../../src/composition/core/runtime/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache, prepareProductDirectory } from '#platform/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyPrincipal } from '../support/custody.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const pause = (milliseconds: number) => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

it.skipIf(!imageId || process.platform !== 'linux')('continues to a later inventory page when missing retained output makes the first recovery fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-reconciliation-fairness-'));
  const project = join(root, 'project'), data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000,
    outputBytes: 65536 };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, artifacts: { maxBytes: 65536 },
    inspection: { maxPageSize: 1, policyMaxBytes: 65536 },
    reconciliationRuntime: { scopeIds: ['s'], pageSize: 1, maxConcurrentReconciliations: 1, pollIntervalMs: 10, failureBackoffMs: 20 },
    execution: { docker, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  const options = { env: { HOME: join(root, 'home') } };
  const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
  const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' },
    'allow', { validate: validateDockerSupervisorProfile });
  const workspaceRoot = await prepareProductDirectory(opened.layout, 'workspaces');
  await prepareProductDirectory(opened.layout, 'artifacts');
  const identities = [
    { scopeId: 's', runId: 'r', taskId: 'first', attemptId: 'a-missing-container', generation: 1, layoutRevision: opened.layout.revision },
    { scopeId: 's', runId: 'r', taskId: 'second', attemptId: 'z-retained-container', generation: 1, layoutRevision: opened.layout.revision },
  ] as const;
  const requests = identities.map((identity, index) => ({ protocolVersion: 1 as const, identity,
    workspace: join(workspaceRoot, identity.attemptId), argv: ['node', '-e', `process.stdout.write('page-${index + 1}')`] }));
  const supervisor = new DockerSupervisor({ ...docker, workspaceRoot, uid: userInfo().uid, gid: userInfo().gid });
  const controller = new AbortController(); let running: Promise<void> | undefined;
  try {
    for (const request of requests) await mkdir(request.workspace, { recursive: true, mode: 0o700 });
    await admitRunAttempts(store, identities);
    const profile = await supervisor.captureProfile();
    for (const request of requests) {
      const claim = { owner: 'fairness-fixture', request };
      await store.claimDispatch({ ...claim, profile });
      await store.grantLaunch({ claim, principal: custodyPrincipal, now: 1 });
      const result = await supervisor.execute(request);
      await store.finishDispatch(claim, { handle: result.handle, exitCode: 0, interrupted: false });
    }
    // The first page is terminal but its exact owned container no longer has retained logs.
    await supervisor.release(requests[0]);
    const principal = [{ issuer: hostname(), subject: String(userInfo().uid) }];
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [
      { id: 'inspect', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: principal, resource: { kind: 'scope', ids: ['s'] } },
      { id: 'recover', effect: 'allow', actions: ['recover-output'], scopes: ['s'], principals: principal, resource: { kind: 'attempt', ids: 'all' } },
    ] }), { mode: 0o600 });
    clearConfigCache();
    const pages: Array<{ after: string | null; statuses: readonly string[] }> = [];
    const runtime = await prepareConfiguredReconciliationRuntime(project, {
      onPage(command, result) { pages.push({ after: command.after, statuses: result.outcomes.map(outcome => outcome.status) }); },
      onError() {},
    }, options);
    running = runtime.run(controller.signal);
    let recovered = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      const current = await store.loadBoundDispatch(identities[1]);
      if (current?.output) { recovered = true; break; }
      await pause(20);
    }
    controller.abort(); await running; running = undefined;
    expect(recovered).toBe(true);
    expect((await store.loadBoundDispatch(identities[0]))?.output).toBeUndefined();
    expect((await store.loadBoundDispatch(identities[1]))?.output).toBeDefined();
    expect(pages).toEqual(expect.arrayContaining([
      { after: null, statuses: ['failed'] },
      { after: 'a-missing-container', statuses: ['output-recovered'] },
    ]));
  } finally {
    controller.abort(); await running?.catch(() => undefined);
    for (const request of requests) await supervisor.release(request).catch(() => undefined);
    store.close(); clearConfigCache(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
