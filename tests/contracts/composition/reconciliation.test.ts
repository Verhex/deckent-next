import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { reconcileAttempt } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache, prepareProductDirectory } from '#platform/index.js';
import { DockerSupervisor, openSqliteAttemptStore, runNodeDockerCommand, validateDockerSupervisorProfile } from '#adapters/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyPrincipal } from '../support/custody.js';
import { startTestRuntimeService, stopTestRuntimeService } from '../support/runtime-service.js';
const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
it.skipIf(!imageId || process.platform !== 'linux').each(['sdk', 'mcp'])('reconciles via %s real recorded work without relaunch, termination, output fabrication or business acceptance', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-reconcile-')); const project = join(root, 'project'); const data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, execution: { docker,
    git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  const options = { env: { HOME: join(root, 'home') } }; const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
  const { layout } = opened; const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, 'allow', { validate: validateDockerSupervisorProfile });
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: randomUUID(), generation: 1, layoutRevision: layout.revision };
  const workspaceRoot = await prepareProductDirectory(layout, 'workspaces'); await prepareProductDirectory(layout, 'artifacts');
  const workspace = join(workspaceRoot, 'worker'); await mkdir(workspace, { mode: 0o700 }); const os = userInfo();
  const supervisor = new DockerSupervisor({ ...docker, workspaceRoot, uid: os.uid, gid: os.gid });
  const request = { protocolVersion: 1 as const, identity, workspace, argv: ['node', '-e', "require('node:fs').writeFileSync('/workspace/ready','yes');setInterval(()=>{},1000)"] };
  const policy = async (allow: boolean) => writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'member', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(os.uid) }], resource: { kind: 'run', ids: ['r'] } },
    ...(allow ? [{ id: 'reconcile', effect: 'allow', actions: ['reconcile'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(os.uid) }], resource: { kind: 'attempt', ids: [identity.attemptId] } }] : []),
  ] }), { mode: 0o600 });
  const runtime = await startTestRuntimeService(project, options.env);
  const transport = mode === 'mcp' ? new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/composition/core/mcp/internal/entry.js'), '--project', project], env: options.env, stderr: 'pipe' }) : null;
  const client = transport ? new Client({ name: 'reconcile-proof', version: '1' }) : null;
  const reconcile = async (input: typeof identity) => {
    if (!client) return reconcileAttempt(project, input, options);
    const result = await client.callTool({ name: 'reconcile_attempt', arguments: input });
    if (result.isError) { const text = (result.content as { type: string; text?: string }[]).find(item => item.type === 'text')!.text!;
      const code = JSON.parse(text).code; throw Object.assign(new Error(code), { code }); }
    return result.structuredContent as Awaited<ReturnType<typeof reconcileAttempt>>;
  };
  let pending: Promise<unknown> | undefined;
  try {
    const claim = { owner: 'original-controller', request };
    await admitRunAttempts(store, [identity]); await store.claimDispatch({ ...claim, profile: await supervisor.captureProfile() });
    const changedExecution = mode === 'sdk' ? {} : { execution: { docker: { ...docker, executable: '/unavailable/docker', imageId: 'sha256:' + 'a'.repeat(64) },
      git: { gitExecutable: '/unavailable/git', timeoutMs: 10000, outputBytes: 65536 } } };
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, ...changedExecution })); clearConfigCache();
    if (client && transport) {
      await client.connect(transport);
      expect((await client.listTools()).tools.find(tool => tool.name === 'reconcile_attempt')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    }
    await policy(false); await expect(reconcile(identity)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await policy(true);
    await expect(reconcile({ ...identity, workspace: '/caller/path' } as typeof identity)).rejects.toMatchObject({ code: mode === 'mcp' ? 'MCP_INPUT_INVALID' : 'INVENTORY_QUERY_INVALID' });
    await expect(reconcile({ ...identity, generation: 2 })).rejects.toMatchObject({ code: 'RUN_STORE_CONFLICT' });
    const absent = await reconcile(identity); expect(absent.reconciliation).toMatchObject({ status: 'unresolved', terminal: null, outputRecorded: false });
    expect((await store.readDispatch(request))!.terminal).toBeNull();
    await store.grantLaunch({ claim, principal: custodyPrincipal, now: 1 });
    pending = supervisor.execute(request); let ready = false;
    for (let i = 0; i < 500; i++) { try { ready = await readFile(join(workspace, 'ready'), 'utf8') === 'yes'; } catch { /* Owned worker startup. */ } if (ready) break; await sleep(10); }
    expect(ready).toBe(true);
    expect((await reconcile(identity)).reconciliation.status).toBe('unresolved');
    expect((await supervisor.observe(request)).result.kind).toBe('unknown');
    await supervisor.cancel(request); await pending;
    // Simulates an exited worker whose original controller did not commit terminal evidence.
    expect((await store.readDispatch(request))!.terminal).toBeNull();
    const result = await reconcile(identity);
    expect(result.reconciliation).toMatchObject({ identity, status: 'terminal', outputRecorded: false, terminal: { interrupted: null } });
    expect(result.reconciliation.terminal!.exitCode).not.toBe(0);
    expect((await store.loadRun('s', 'r'))!.progress[0]!.phase).toBe('evaluating');
    expect(JSON.stringify(result)).not.toContain('original-controller'); expect(JSON.stringify(result)).not.toContain('setInterval');
    expect(await reconcile(identity)).toEqual(result);
    await policy(false); await expect(reconcile(identity)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  } finally {
    await supervisor.cancel(request).catch(() => {}); await pending?.catch(() => {});
    // Test fixture owns the process; product reconcile never releases it or manufactures an artifact receipt.
    await supervisor.release(request).catch(() => {}); await client?.close(); await transport?.close(); await stopTestRuntimeService(runtime); store.close(); clearConfigCache(); await rm(root, { recursive: true, force: true });
  }
}, 30000);

it.skipIf(!imageId || process.platform !== 'linux').each(['sdk', 'mcp'])('rejects a simulated recorded daemon mismatch via %s without mutation or effects', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-reconcile-origin-')); const project = join(root, 'project'); const data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, execution: { docker,
    git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  const options = { env: { HOME: join(root, 'home') } }; const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
  const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, 'allow', { validate: validateDockerSupervisorProfile });
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: randomUUID(), generation: 1, layoutRevision: opened.layout.revision };
  const workspaceRoot = await prepareProductDirectory(opened.layout, 'workspaces'); await prepareProductDirectory(opened.layout, 'artifacts');
  const workspace = join(workspaceRoot, 'worker'); await mkdir(workspace, { mode: 0o700 }); const effect = join(workspace, 'effect'); const os = userInfo();
  const supervisor = new DockerSupervisor({ ...docker, workspaceRoot, uid: os.uid, gid: os.gid });
  const request = { protocolVersion: 1 as const, identity, workspace, argv: ['node', '-e', "require('node:fs').writeFileSync('/workspace/effect','unexpected')"] };
  const canonicalIdentity = { runId: identity.runId, taskId: identity.taskId, attemptId: identity.attemptId,
    scopeId: identity.scopeId, layoutRevision: identity.layoutRevision, generation: identity.generation };
  const handle = 'deckent-' + createHash('sha256').update(JSON.stringify(canonicalIdentity)).digest('hex');
  const captured = await supervisor.captureProfile();
  const parameters = captured.parameters as { endpoint: string; origin: Record<string, unknown> };
  const foreignDaemonId = `foreign-${randomUUID()}`;
  const profile = { ...captured, parameters: { ...parameters, origin: { ...parameters.origin, daemonId: foreignDaemonId } } };
  const principal = { issuer: hostname(), subject: String(os.uid) };
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'reconcile', effect: 'allow', actions: ['reconcile'], scopes: ['s'], principals: [principal], resource: { kind: 'attempt', ids: [identity.attemptId] } },
  ] }), { mode: 0o600 });
  const listContainers = async () => (await runNodeDockerCommand({ executable: docker.executable,
    args: ['--host', parameters.endpoint, 'ps', '-aq', '--filter', `name=^/${handle}$`], timeoutMs: docker.controlTimeoutMs, outputBytes: docker.outputBytes })).stdout.trim().split('\n').filter(Boolean).sort();
  const runtime = await startTestRuntimeService(project, options.env);
  const transport = mode === 'mcp' ? new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/composition/core/mcp/internal/entry.js'), '--project', project], env: options.env, stderr: 'pipe' }) : null;
  const client = transport ? new Client({ name: 'reconcile-origin-proof', version: '1' }) : null;
  const reconcile = async () => {
    if (!client) return reconcileAttempt(project, identity, options);
    const result = await client.callTool({ name: 'reconcile_attempt', arguments: identity });
    if (result.isError) {
      const text = (result.content as { type: string; text?: string }[]).find(item => item.type === 'text')!.text!;
      const code = JSON.parse(text).code; throw Object.assign(new Error(code), { code, text });
    }
    return result.structuredContent;
  };
  try {
    const claim = { owner: 'original-controller', request };
    await admitRunAttempts(store, [identity]); await store.claimDispatch({ ...claim, profile });
    await store.grantLaunch({ claim, principal: custodyPrincipal, now: 1 });
    const before = { dispatch: await store.readDispatch(request), attempt: await store.load('s', identity.attemptId), run: await store.loadRun('s', 'r') };
    const containers = await listContainers();
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data } })); clearConfigCache();
    if (client && transport) await client.connect(transport);
    const failure = await reconcile().then(() => null, error => error as { code?: string; text?: string; message?: string });
    expect(failure).toMatchObject({ code: 'INVENTORY_UNAVAILABLE' });
    expect(JSON.stringify(failure)).not.toContain('SUPERVISOR_PROFILE_ORIGIN_MISMATCH');
    expect(JSON.stringify(failure)).not.toContain(foreignDaemonId);
    expect(JSON.stringify(failure)).not.toContain('writeFileSync');
    expect({ dispatch: await store.readDispatch(request), attempt: await store.load('s', identity.attemptId), run: await store.loadRun('s', 'r') }).toEqual(before);
    expect(await listContainers()).toEqual(containers);
    await expect(readFile(effect, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await runNodeDockerCommand({ executable: docker.executable, args: ['--host', parameters.endpoint, 'rm', '-f', handle],
      timeoutMs: docker.controlTimeoutMs, outputBytes: docker.outputBytes }).catch(() => {});
    await client?.close(); await transport?.close(); await stopTestRuntimeService(runtime); store.close(); clearConfigCache(); await rm(root, { recursive: true, force: true });
  }
}, 30000);
