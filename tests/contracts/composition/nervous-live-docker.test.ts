import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { DockerSupervisor, openSqliteAttemptStore, validateDockerSupervisorProfile } from '#adapters/index.js';
import { DispatchPreparationGuard } from '#engine/index.js';
import { prepareConfiguredReconciliationRuntime } from '../../../src/composition/core/runtime/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache, jsonRecordDirectory, prepareProductDirectory } from '#platform/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyPrincipal } from '../support/custody.js';

// S6R-3 live against the real Docker daemon: the same two lost workers as the shadow proof, now under `live`, a measured registry (this file
// promotes the provisional seed rules the way a measured registry would) and the owner's standing grant. The orphan is fenced, really killed and
// released on Docker's exit proof; the worker that never got a container is fenced and goes to a person (Nervous hold). No new Attempt.
vi.mock('#engine/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#engine/index.js')>(), seed = actual.NERVOUS_RULES_SEED as { rules: object[] };
  return { ...actual, NERVOUS_RULES_SEED: { ...seed, rules: seed.rules.map(rule => ({ ...rule, status: 'live' })) } };
});
const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const pause = (milliseconds: number) => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

it.skipIf(!imageId || process.platform !== 'linux')('live on real Docker: stops and releases the orphan with proof, holds the identity-less gone worker for a person', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-nervous-docker-'));
  const project = join(root, 'project'), data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2,
    tmpBytes: 16777216, deadlineMs: 30000, controlTimeoutMs: 10000, outputBytes: 65536 };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, inspection: { maxPageSize: 4, policyMaxBytes: 65536 },
    reconciliationRuntime: { scopeIds: ['s'], pageSize: 4, maxConcurrentReconciliations: 1, pollIntervalMs: 20, failureBackoffMs: 40 },
    runRuntime: { nervous: { mode: 'live' } }, execution: { docker, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  const options = { env: { HOME: join(root, 'home') } };
  const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
  const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 },
    'allow', { validate: validateDockerSupervisorProfile });
  const workspaceRoot = await prepareProductDirectory(opened.layout, 'workspaces'), crashes = await prepareProductDirectory(opened.layout, 'crashes');
  await prepareProductDirectory(opened.layout, 'artifacts');
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
      { id: 'reconcile', effect: 'allow', actions: ['reconcile', 'recover-output', 'cancel'], scopes: ['s'], principals: principal, resource: { kind: 'attempt', ids: 'all' } },
      { id: 'run', effect: 'allow', actions: ['inspect', 'cancel'], scopes: ['s'], principals: principal, resource: { kind: 'run', ids: 'all' } },
      { id: 'nervous-standing', effect: 'allow', actions: ['apply'], scopes: ['s'], principals: principal, resource: { kind: 'recovery-action', ids: ['fence-attempt', 'stop-orphan'] } },
    ] }), { mode: 0o600 });
    clearConfigCache();
    const errors: string[] = [];
    const runtime = await prepareConfiguredReconciliationRuntime(project, { onPage() {}, onError(_command, error) { errors.push(error.code); } }, options);
    running = runtime.run(controller.signal);
    const detections = () => { const db = new DatabaseSync(opened.path, { readOnly: true }); try {
      return (db.prepare("SELECT record FROM audit_events WHERE kind='recovery-detection' ORDER BY sequence").all() as { record: string }[]).map(row => JSON.parse(row.record).event.subject);
    } finally { db.close(); } };
    const custody = async () => ((await store.loadRun('s', 'r'))!.progress as { taskId: string; phase: string; unresolvedEffects: boolean; workerCustody?: { state: string } }[]);
    for (let attempt = 0; attempt < 750 && !((await custody()).find(task => task.taskId === 'orphan')?.workerCustody?.state === 'released'
      && (await store.loadRun('s', 'r'))!.state.kind === 'parked'); attempt++) await pause(20);
    await pause(200); controller.abort(); await running; running = undefined;
    expect(detections().map(subject => [subject.target.attemptId, subject.rule.id, subject.action, subject.disposition, subject.standingRef]).sort()).toEqual([
      ['a-gone', 'launcher-dead-gone', 'fence-attempt', 'execute', 'nervous-standing'],
      ['b-orphan', 'launcher-dead-orphan', 'stop-orphan', 'execute', 'nervous-standing']]);
    expect(errors).toEqual([]);
    // The orphan's real container was stopped by the authorized cancel (fence first: its exit is not a clean result) and its slot released on
    // Docker's exit proof of the exact retained incarnation; the task stays reconciling with its effects unresolved (continuation is S6R-4/5).
    expect((await supervisor.inspectActivity(requests[1])).state).toBe('exited');
    const tasks = await custody(), run = (await store.loadRun('s', 'r'))!;
    expect(tasks.find(task => task.taskId === 'orphan')).toMatchObject({ phase: 'reconciling', unresolvedEffects: true, workerCustody: { state: 'released' } });
    expect(await store.loadBoundDispatch(identities[1])).toMatchObject({ terminal: null, cancellation: expect.any(Object), worker: { kind: 'container' } });
    // The gone worker had no retained identity: fenced, never released, its Run held by Nervous for a person.
    expect(tasks.find(task => task.taskId === 'gone')).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
    expect(tasks.find(task => task.taskId === 'gone')?.workerCustody).toBeUndefined();
    expect(run.state).toMatchObject({ kind: 'parked', reason: 'operator-hold', holdSource: 'nervous' });
    expect(run.bindings).toHaveLength(2);
    const db = new DatabaseSync(opened.path, { readOnly: true });
    try { expect((db.prepare('SELECT count(*) AS n FROM attempts').get() as { n: number }).n).toBe(2); } finally { db.close(); }
  } finally {
    controller.abort(); await running?.catch(() => undefined);
    await supervisor.cancel(requests[1]).catch(() => undefined); await worker;
    await supervisor.release(requests[1]).catch(() => undefined);
    store.close(); await rm(root, { recursive: true, force: true });
  }
}, 60000);
