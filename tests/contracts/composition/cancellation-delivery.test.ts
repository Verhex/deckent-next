import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { deliverRunCancellation } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache, prepareProductDirectory, productResourcePath } from '#platform/index.js';
import { DockerSupervisor, FileArtifactStore, type SqliteAttemptStore } from '#adapters/index.js';
import { DispatchApplication } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';
const exec = promisify(execFile); const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1,
  logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
async function fixture(configured: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-delivery-')); roots.push(root);
  const project = join(root, 'project'); const data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, ...(configured ? {
    cancellation: { maxConcurrentDeliveries: 2 }, execution: { docker, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } },
  } : {}) }));
  const options = { env: { HOME: join(root, 'home') } }; const { store, layout } = await openConfiguredAttemptStore(project, options); stores.push(store);
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: randomUUID(), generation: 1, layoutRevision: layout.revision };
  await admitRunAttempts(store, [identity]);
  async function policy(run: boolean, attempt: boolean) {
    const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
      ...(run ? [{ id: 'run', effect: 'allow', actions: ['cancel'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } }] : []),
      ...(attempt ? [{ id: 'attempt', effect: 'allow', actions: ['cancel'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: [identity.attemptId] } }] : []),
    ] }), { mode: 0o600 });
  }
  return { project, options, store, layout, identity, policy, command: { schemaVersion: 1 as const, commandId: 'cancel', action: 'cancel' as const, scopeId: 's', runId: 'r', expectedRevision: 1 } };
}
it.skipIf(!imageId || process.platform !== 'linux').each(['sdk', 'mcp'])('delivers via %s to a real worker only after Run and Attempt cancellation authority, preserving terminal custody', async mode => {
  const f = await fixture(true); const workspaceRoot = await prepareProductDirectory(f.layout, 'workspaces'); const artifactRoot = await prepareProductDirectory(f.layout, 'artifacts');
  const transport = mode === 'mcp' ? new StdioClientTransport({ command: process.execPath, args: [resolve('dist/composition/core/mcp/internal/entry.js'), '--project', f.project], env: f.options.env, stderr: 'pipe' }) : null;
  const client = transport ? new Client({ name: 'delivery-proof', version: '1' }) : null;
  const deliver = async () => {
    if (!client) return deliverRunCancellation(f.project, f.command, f.options);
    const result = await client.callTool({ name: 'deliver_run_cancellation', arguments: f.command });
    if (result.isError) {
      const text = (result.content as { type: string; text?: string }[]).find(value => value.type === 'text')!.text!;
      const code = JSON.parse(text).code; throw Object.assign(new Error(code), { code });
    }
    return result.structuredContent as Awaited<ReturnType<typeof deliverRunCancellation>>;
  };
  const workspace = join(workspaceRoot, 'worker'); await mkdir(workspace, { mode: 0o700 }); const os = userInfo();
  const supervisor = new DockerSupervisor({ ...docker, workspaceRoot, uid: os.uid, gid: os.gid });
  const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: 1048576 });
  const request = { protocolVersion: 1 as const, identity: f.identity, workspace, argv: ['node', '-e', "require('node:fs').writeFileSync('/workspace/ready','yes');setInterval(()=>{},1000)"] };
  const app = new DispatchApplication(f.store, supervisor, { async verify() { return { id: 'fixture', issuer: 'test', subject: 'service', assurance: 'os-user', scopeIds: ['s'] }; } }, { async authorize() {} }, 'fixture', artifacts);
  let executionFailure: unknown;
  const pending = app.execute(request); const outcome = pending.then(value => ({ value, error: null }), error => { executionFailure = error; return { value: null, error }; });
  try {
    if (client && transport) {
      await client.connect(transport);
      const tool = (await client.listTools()).tools.find(value => value.name === 'deliver_run_cancellation')!;
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    }
    let ready = false;
    for (let i = 0; i < 500; i++) { if (executionFailure) throw executionFailure; try { ready = await readFile(join(workspace, 'ready'), 'utf8') === 'yes'; } catch { /* Worker startup. */ } if (ready) break; await sleep(10); }
    expect(ready).toBe(true); const observation = await supervisor.observe(request);
    const running = async () => (await exec('/usr/bin/docker', ['inspect', '--format', '{{.State.Running}}', observation.handle])).stdout.trim();
    await f.policy(false, true);
    await expect(deliver()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect((await f.store.loadRun('s', 'r'))!.cancelRequested).toBe(false); expect(await running()).toBe('true');
    await f.policy(true, false); const denied = await deliver();
    expect(denied.delivery.outcomes).toEqual([{ attemptId: f.identity.attemptId, taskId: 't', status: 'denied' }]);
    expect((await f.store.loadRun('s', 'r'))!.cancelRequested).toBe(true); expect(await running()).toBe('true');
    await f.policy(true, true); const delivered = await deliver();
    expect(delivered.delivery.outcomes).toEqual([{ attemptId: f.identity.attemptId, taskId: 't', status: 'terminal' }]);
    expect((await outcome).error).toBe(null); expect(await running()).toBe('false');
    const record = (await f.store.readDispatch(request))!; expect(record.terminal!.exitCode).not.toBe(0); expect(record.output).toBeDefined();
    expect((await f.store.load('s', f.identity.attemptId))!.lastObservation!.result.kind).toBe('exited');
  } finally { await supervisor.cancel(request).catch(() => {}); await outcome; await supervisor.release(request).catch(() => {}); await client?.close(); await transport?.close(); }
}, 30000);
it.skipIf(process.platform === 'win32')('requires an explicit cancellation profile before recording intent or creating runtime directories', async () => {
  const f = await fixture(false); await f.policy(true, false);
  await expect(deliverRunCancellation(f.project, f.command, f.options)).rejects.toMatchObject({ code: 'CANCELLATION_NOT_CONFIGURED' });
  expect((await f.store.loadRun('s', 'r'))!.cancelRequested).toBe(false);
  await expect(lstat(productResourcePath(f.layout, 'workspaces'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(productResourcePath(f.layout, 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('records cancellation for an undispatched attempt without runtime directories or Docker access', async () => {
  const f = await fixture(false); await f.policy(true, false);
  const bootstrap = join(f.project, '.deckent/config.json');
  const config = JSON.parse(await readFile(bootstrap, 'utf8'));
  config.cancellation = { maxConcurrentDeliveries: 2 };
  config.execution = { docker: { ...docker, executable: '/unavailable/docker', imageId: 'sha256:' + 'a'.repeat(64) },
    git: { gitExecutable: '/unavailable/git', timeoutMs: 10000, outputBytes: 65536 } };
  await writeFile(bootstrap, JSON.stringify(config)); clearConfigCache();
  const result = await deliverRunCancellation(f.project, f.command, f.options);
  expect(result.delivery.outcomes).toEqual([{ attemptId: f.identity.attemptId, taskId: 't', status: 'not-dispatched' }]);
  expect((await f.store.loadRun('s', 'r'))!.cancelRequested).toBe(true);
  expect((await deliverRunCancellation(f.project, f.command, f.options)).delivery).toEqual(result.delivery);
  await expect(lstat(productResourcePath(f.layout, 'workspaces'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(productResourcePath(f.layout, 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });
});
