import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { DockerSupervisor, openSqliteAttemptStore, validateDockerSupervisorProfile } from '#adapters/index.js';
import { DispatchPreparationGuard } from '#engine/index.js';
import { prepareConfiguredReconciliationRuntime } from '../../../src/composition/core/runtime/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache, jsonRecordDirectory, prepareProductDirectory } from '#platform/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyPrincipal } from '../support/custody.js';

// S6R-2 shadow mode against the real Docker daemon: a granted dispatch whose container never came up and one whose real container is still
// running, both left by a launcher process that died. Nervous seals one proposal each and touches neither (the running container stays up).
const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const pause = (milliseconds: number) => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

it.skipIf(!imageId || process.platform !== 'linux')('seals launcher-dead-gone and launcher-dead-orphan on real Docker and leaves the live container running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-nervous-docker-'));
  const project = join(root, 'project'), data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2,
    tmpBytes: 16777216, deadlineMs: 30000, controlTimeoutMs: 10000, outputBytes: 65536 };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, inspection: { maxPageSize: 4, policyMaxBytes: 65536 },
    reconciliationRuntime: { scopeIds: ['s'], pageSize: 4, maxConcurrentReconciliations: 1, pollIntervalMs: 20, failureBackoffMs: 40 },
    runRuntime: { nervous: { mode: 'shadow' } }, execution: { docker, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  const options = { env: { HOME: join(root, 'home') } };
  const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
  const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 },
    'allow', { validate: validateDockerSupervisorProfile });
  const workspaceRoot = await prepareProductDirectory(opened.layout, 'workspaces'), crashes = await prepareProductDirectory(opened.layout, 'crashes');
  const identities = [
    { scopeId: 's', runId: 'r', taskId: 'gone', attemptId: 'a-gone', generation: 1, layoutRevision: opened.layout.revision },
    { scopeId: 's', runId: 'r', taskId: 'orphan', attemptId: 'b-orphan', generation: 1, layoutRevision: opened.layout.revision },
  ] as const;
  const requests = identities.map(identity => ({ protocolVersion: 1 as const, identity, workspace: join(workspaceRoot, identity.attemptId), argv: ['node', '-e', 'setTimeout(() => {}, 25000)'] }));
  const supervisor = new DockerSupervisor({ ...docker, workspaceRoot, uid: userInfo().uid, gid: userInfo().gid });
  const controller = new AbortController(); let running: Promise<void> | undefined, worker: Promise<unknown> | undefined;
  try {
    for (const request of requests) await mkdir(request.workspace, { recursive: true, mode: 0o700 });
    await admitRunAttempts(store, identities);
    const profile = await supervisor.captureProfile(), dead = spawnSync(process.execPath, ['-e', '']).pid!;
    for (const [index, request] of requests.entries()) {
      const claim = { owner: 'nervous-fixture', request };
      await store.claimDispatch({ ...claim, profile });
      await store.grantLaunch({ claim, principal: custodyPrincipal, now: 1 });
      const guard = new DispatchPreparationGuard(jsonRecordDirectory(join(crashes, 'dispatch-preparation')), { identity: request.identity, principal: { issuer: 'host', subject: '1' },
        policyRevision: 'p', bound: 2, now: Date.now, instance: { id: `00000000-0000-4000-8000-00000000000${index + 1}`, pid: dead, startedAt: 1 },
        launchers: jsonRecordDirectory(join(crashes, 'dispatch-launcher')), record: async () => undefined, parked: async () => false, loadRun: async () => null, park: async () => undefined });
      await guard.begin((await store.loadRun('s', 'r'))!); await guard.enter('dispatch');
    }
    // The orphan's real container runs (its launcher "died"); the gone one never got a container.
    worker = supervisor.execute(requests[1]).catch(() => undefined);
    for (let attempt = 0; attempt < 500 && (await supervisor.inspectActivity(requests[1])).state !== 'running'; attempt++) await pause(20);
    expect((await supervisor.inspectActivity(requests[1])).state).toBe('running');
    const principal = [{ issuer: hostname(), subject: String(userInfo().uid) }];
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [
      { id: 'inspect', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: principal, resource: { kind: 'scope', ids: ['s'] } },
      { id: 'reconcile', effect: 'allow', actions: ['reconcile', 'recover-output'], scopes: ['s'], principals: principal, resource: { kind: 'attempt', ids: 'all' } },
    ] }), { mode: 0o600 });
    clearConfigCache();
    const errors: string[] = [];
    const runtime = await prepareConfiguredReconciliationRuntime(project, { onPage() {}, onError(_command, error) { errors.push(error.code); } }, options);
    running = runtime.run(controller.signal);
    const detections = () => { const db = new DatabaseSync(opened.path, { readOnly: true }); try {
      return (db.prepare("SELECT record FROM audit_events WHERE kind='recovery-detection' ORDER BY sequence").all() as { record: string }[]).map(row => JSON.parse(row.record).event.subject);
    } finally { db.close(); } };
    for (let attempt = 0; attempt < 500 && detections().length < 2; attempt++) await pause(20);
    await pause(200); controller.abort(); await running; running = undefined;
    expect(detections().map(subject => [subject.target.attemptId, subject.rule.id, subject.action, subject.disposition, subject.evidence.activity, subject.evidence.launcher]).sort()).toEqual([
      ['a-gone', 'launcher-dead-gone', 'fence-attempt', 'shadow-only', 'missing', 'dead'],
      ['b-orphan', 'launcher-dead-orphan', 'stop-orphan', 'shadow-only', 'running', 'dead']]);
    expect(errors).toEqual([]);
    // Shadow touched nothing: the orphan still runs, no dispatch was fenced, settled or cancelled.
    expect((await supervisor.inspectActivity(requests[1])).state).toBe('running');
    for (const identity of identities) expect(await store.loadBoundDispatch(identity)).toMatchObject({ launch: 'granted', terminal: null });
    for (const identity of identities) expect((await store.loadBoundDispatch(identity))?.cancellation).toBeUndefined();
  } finally {
    controller.abort(); await running?.catch(() => undefined);
    await supervisor.cancel(requests[1]).catch(() => undefined); await worker;
    await supervisor.release(requests[1]).catch(() => undefined);
    store.close(); await rm(root, { recursive: true, force: true });
  }
}, 60000);
