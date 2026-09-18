import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { reconcileAttempt } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache, prepareProductDirectory } from '#platform/index.js';
import { DockerSupervisor } from '#adapters/index.js';
import { admitRunAttempts } from '../support/admission.js';
const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
it.skipIf(!imageId || process.platform !== 'linux')('reconciles real recorded work without relaunch, termination, output fabrication or business acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-reconcile-')); const project = join(root, 'project'); const data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, execution: { docker,
    git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  const options = { env: { HOME: join(root, 'home') } }; const { store, layout } = await openConfiguredAttemptStore(project, options);
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: randomUUID(), generation: 1, layoutRevision: layout.revision };
  const workspaceRoot = await prepareProductDirectory(layout, 'workspaces'); await prepareProductDirectory(layout, 'artifacts');
  const workspace = join(workspaceRoot, 'worker'); await mkdir(workspace, { mode: 0o700 }); const os = userInfo();
  const supervisor = new DockerSupervisor({ ...docker, workspaceRoot, uid: os.uid, gid: os.gid });
  const request = { protocolVersion: 1 as const, identity, workspace, argv: ['node', '-e', "require('node:fs').writeFileSync('/workspace/ready','yes');setInterval(()=>{},1000)"] };
  const policy = async (allow: boolean) => writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'member', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(os.uid) }], resource: { kind: 'run', ids: ['r'] } },
    ...(allow ? [{ id: 'reconcile', effect: 'allow', actions: ['reconcile'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(os.uid) }], resource: { kind: 'attempt', ids: [identity.attemptId] } }] : []),
  ] }), { mode: 0o600 });
  let pending: Promise<unknown> | undefined;
  try {
    await admitRunAttempts(store, [identity]); await store.claimDispatch({ owner: 'original-controller', request });
    await policy(false); await expect(reconcileAttempt(project, identity, options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await policy(true);
    await expect(reconcileAttempt(project, { ...identity, workspace: '/caller/path' } as typeof identity, options)).rejects.toMatchObject({ code: 'INVENTORY_QUERY_INVALID' });
    await expect(reconcileAttempt(project, { ...identity, generation: 2 }, options)).rejects.toMatchObject({ code: 'RUN_STORE_CONFLICT' });
    const absent = await reconcileAttempt(project, identity, options); expect(absent.reconciliation).toMatchObject({ status: 'unresolved', terminal: null, outputRecorded: false });
    expect((await store.readDispatch(request))!.terminal).toBeNull();
    pending = supervisor.execute(request); let ready = false;
    for (let i = 0; i < 500; i++) { try { ready = await readFile(join(workspace, 'ready'), 'utf8') === 'yes'; } catch { /* Owned worker startup. */ } if (ready) break; await sleep(10); }
    expect(ready).toBe(true);
    expect((await reconcileAttempt(project, identity, options)).reconciliation.status).toBe('unresolved');
    expect((await supervisor.observe(request)).result.kind).toBe('unknown');
    await supervisor.cancel(request); await pending;
    // Simulates an exited worker whose original controller did not commit terminal evidence.
    expect((await store.readDispatch(request))!.terminal).toBeNull();
    const result = await reconcileAttempt(project, identity, options);
    expect(result.reconciliation).toMatchObject({ identity, status: 'terminal', outputRecorded: false, terminal: { interrupted: null } });
    expect(result.reconciliation.terminal!.exitCode).not.toBe(0);
    expect((await store.loadRun('s', 'r'))!.progress[0]!.phase).toBe('evaluating');
    expect(JSON.stringify(result)).not.toContain('original-controller'); expect(JSON.stringify(result)).not.toContain('setInterval');
    expect(await reconcileAttempt(project, identity, options)).toEqual(result);
    await policy(false); await expect(reconcileAttempt(project, identity, options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  } finally {
    await supervisor.cancel(request).catch(() => {}); await pending?.catch(() => {});
    // Test fixture owns the process; product reconcile never releases it or manufactures an artifact receipt.
    await supervisor.release(request).catch(() => {}); store.close(); clearConfigCache(); await rm(root, { recursive: true, force: true });
  }
}, 30000);
