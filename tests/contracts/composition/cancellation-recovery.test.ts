import { hostname, userInfo } from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { recoverConfiguredCancellations } from '../../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache, prepareProductDirectory } from '#platform/index.js';
import { requestRunCancellation } from '../../../src/index.js';
import { DockerSupervisor, FileArtifactStore } from '#adapters/index.js';
import { DispatchApplication } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';

const roots: string[] = [];
const exec = promisify(execFile); const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(cancellation = true) {
  const project = await mkdtemp(join(tmpdir(), 'deckent-cancellation-recovery-composition-')); roots.push(project);
  const data = join(project, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const env = { HOME: join(project, 'home') };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, ...(cancellation ? { cancellation: {
    maxConcurrentDeliveries: 2, maxAttempts: 3, retryDelayMs: 10, claimTtlMs: 100, recoveryPageSize: 2,
  } } : {}) }));
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [{ id: 'discover', effect: 'allow',
    actions: ['inspect'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'scope', ids: ['s'] } }] }), { mode: 0o600 });
  return { project, env };
}

it('manually drains one bounded empty page without installing a runtime loop', async () => {
  const f = await fixture();
  const result = await recoverConfiguredCancellations(f.project, { schemaVersion: 1, scopeId: 's', afterAttemptId: null }, { env: f.env });
  expect(result.recovery).toEqual({ schemaVersion: 1, scopeId: 's', nextAfterAttemptId: null, outcomes: [] });
});

it('requires explicit cancellation configuration after current scope authorization', async () => {
  const f = await fixture(false);
  await expect(recoverConfiguredCancellations(f.project, { schemaVersion: 1, scopeId: 's', afterAttemptId: null }, { env: f.env }))
    .rejects.toMatchObject({ code: 'CANCELLATION_NOT_CONFIGURED' });
});

it.skipIf(!imageId || process.platform !== 'linux')('recovers durable cancellation after controller restart from recorded Docker custody and fresh policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-cancellation-recovery-docker-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const env = { HOME: join(root, 'home') }; const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456,
    pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
  const configPath = join(project, '.deckent/config.json');
  await writeFile(configPath, JSON.stringify({ layout: { root: data }, cancellation: { maxConcurrentDeliveries: 2, maxAttempts: 3,
    retryDelayMs: 10, claimTtlMs: 100, recoveryPageSize: 2 }, execution: { docker,
    git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  const opened = await openConfiguredAttemptStore(project, { env }); const identity = { scopeId: 's', runId: 'r', taskId: 't',
    attemptId: randomUUID(), generation: 1, layoutRevision: opened.layout.revision };
  await admitRunAttempts(opened.store, [identity]);
  const workspaceRoot = await prepareProductDirectory(opened.layout, 'workspaces'); const artifactRoot = await prepareProductDirectory(opened.layout, 'artifacts');
  const workspace = join(workspaceRoot, 'worker'); await mkdir(workspace, { mode: 0o700 }); const os = userInfo();
  const supervisor = new DockerSupervisor({ ...docker, workspaceRoot, uid: os.uid, gid: os.gid });
  const request = { protocolVersion: 1 as const, identity, workspace, argv: ['node', '-e', "require('node:fs').writeFileSync('/workspace/ready','yes');setInterval(()=>{},1000)"] };
  const application = new DispatchApplication(opened.store, supervisor, { async verify() { return { id: 'fixture', issuer: 'test', subject: 'service', assurance: 'os-user' as const, scopeIds: ['s'] }; } },
    { async authorize() {} }, 'fixture', new FileArtifactStore({ root: artifactRoot, maxBytes: 1048576 }));
  let executionFailure: unknown; const pending = application.execute(request); const outcome = pending.catch(error => { executionFailure = error; return null; });
  const principals = [{ issuer: hostname(), subject: String(os.uid) }];
  const policy = async (attempt: boolean) => writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: randomUUID(), restrictions: [], grants: [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'run', effect: 'allow', actions: ['cancel'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    ...(attempt ? [{ id: 'attempt', effect: 'allow', actions: ['cancel'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: [identity.attemptId] } }] : []),
  ] }), { mode: 0o600 });
  try {
    let ready = false;
    for (let i = 0; i < 500; i++) { if (executionFailure) throw executionFailure; try { ready = await readFile(join(workspace, 'ready'), 'utf8') === 'yes'; } catch { /* starting */ } if (ready) break; await sleep(10); }
    expect(ready).toBe(true); const observation = await supervisor.observe(request);
    await policy(false);
    await requestRunCancellation(project, { schemaVersion: 1, commandId: 'cancel', action: 'cancel', scopeId: 's', runId: 'r', expectedRevision: 1 }, { env });
    opened.store.close();
    const config = JSON.parse(await readFile(configPath, 'utf8')); delete config.execution; await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
    const running = async () => (await exec('/usr/bin/docker', ['inspect', '--format', '{{.State.Running}}', observation.handle])).stdout.trim();
    const denied = await recoverConfiguredCancellations(project, { schemaVersion: 1, scopeId: 's', afterAttemptId: null }, { env });
    expect(denied.recovery.outcomes).toMatchObject([{ identity, outcome: { status: 'denied' } }]); expect(await running()).toBe('true');
    const deniedProof = new DatabaseSync(opened.path, { readOnly: true });
    try { expect(deniedProof.prepare('SELECT record FROM cancellation_deliveries WHERE scope_id=? AND attempt_id=?').get('s', identity.attemptId)).toBeUndefined(); }
    finally { deniedProof.close(); }
    await policy(true); const recovered = await recoverConfiguredCancellations(project, { schemaVersion: 1, scopeId: 's', afterAttemptId: null }, { env });
    expect(recovered.recovery.outcomes).toMatchObject([{ identity, outcome: { status: 'terminal', delivery: { state: 'terminal', attempts: 1 } } }]);
    expect(await running()).toBe('false');
    const replay = await recoverConfiguredCancellations(project, { schemaVersion: 1, scopeId: 's', afterAttemptId: null }, { env });
    expect(replay.recovery.outcomes).toEqual([]);
    const proof = await openConfiguredAttemptStore(project, { env });
    try {
      expect(await proof.store.load('s', identity.attemptId)).toMatchObject({ cancelRequested: true, lastObservation: { result: { kind: 'exited' } } });
      const db = new DatabaseSync(opened.path, { readOnly: true });
      try {
        const row = db.prepare('SELECT record FROM cancellation_deliveries WHERE scope_id=? AND attempt_id=?').get('s', identity.attemptId)!;
        expect(JSON.parse(String(row.record))).toMatchObject({ identity, state: 'terminal', attempts: 1 });
      } finally { db.close(); }
    }
    finally { proof.store.close(); }
  } finally {
    await supervisor.cancel(request).catch(() => {}); await outcome; await supervisor.release(request).catch(() => {});
  }
}, 30000);
